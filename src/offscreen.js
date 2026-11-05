import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { extractFeatures, slouchDeviation, deviationToScore, medianFeatures } from "./posture.js";

const video = document.getElementById("camera");
let stream = null;
let landmarker = null;
let frameCallback = 0;
let fallbackTimer = null;
let baseline = null;
let calibration = null; // { frames, startedAt } while the baseline is being sampled
let smoothedScore = 0;
let unscorableSince = 0;
let headTurnSuppressed = false;
let headRollSuppressed = false;
let torsoTurnSuppressed = false;
let lastVideoTime = -1;
let lastPreviewTime = 0;
let previewInFlight = false;
let previewGeneration = 0;
let lastLandmarkerTimestamp = 0;
let lastScorePublishTime = 0;
let lastInferenceTime = 0;
let silhouetteOnlyPreview = false;
const previewTheme = window.matchMedia("(prefers-color-scheme: dark)");
let panelDarkMode = null;
chrome.runtime.sendMessage({ type: "POSTUREFLOW_PREVIEW_THEME_GET" }).then(theme => {
  if (panelDarkMode === null && typeof theme?.darkMode === "boolean") panelDarkMode = theme.darkMode;
}).catch(() => {});
const previewCanvas = document.createElement("canvas");
previewCanvas.width = 320;
previewCanvas.height = 240;
const previewContext = previewCanvas.getContext("2d");
const silhouetteCanvas = document.createElement("canvas");
const silhouetteContext = silhouetteCanvas.getContext("2d");
let silhouetteImageData = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// Score 2 = deviation 0.25, 6 = 0.35 (see DEVIATION_* in posture.js); a clear turtle neck reads ~10.
const BLUR_START_SCORE = 2;
const BLUR_PEAK_SCORE = 6;
const CALIBRATION_FRAMES = 10;
const CALIBRATION_TIMEOUT_MS = 3000;
// Allow a little landmark jitter, but pause posture scoring when head orientation changes.
const HEAD_TURN_SUPPRESS_ON = 0.10;
const HEAD_TURN_SUPPRESS_OFF = 0.07;
const HEAD_ROLL_SUPPRESS_ON = 10 * Math.PI / 180;
const HEAD_ROLL_SUPPRESS_OFF = 7 * Math.PI / 180;

function measureOrientation(features, reference) {
  const headTurnDeviation = Math.abs(features.headTurn - reference.headTurn);
  const rollDeviation = Math.abs(features.headRoll - reference.headRoll);
  headTurnSuppressed = headTurnSuppressed
    ? headTurnDeviation > HEAD_TURN_SUPPRESS_OFF
    : headTurnDeviation > HEAD_TURN_SUPPRESS_ON;
  headRollSuppressed = headRollSuppressed
    ? rollDeviation > HEAD_ROLL_SUPPRESS_OFF
    : rollDeviation > HEAD_ROLL_SUPPRESS_ON;
  torsoTurnSuppressed = torsoTurnSuppressed ? features.torsoTurn > 0.35 : features.torsoTurn > 0.45;

  const headTurnWeight = clamp((0.18 - headTurnDeviation) / 0.08, 0, 1);
  const headRollWeight = clamp((0.38 - rollDeviation) / 0.20, 0, 1);
  const torsoTurnWeight = clamp((0.62 - features.torsoTurn) / 0.25, 0, 1);
  return {
    suppressed: headTurnSuppressed || headRollSuppressed || torsoTurnSuppressed,
    weight: headTurnWeight * headRollWeight * torsoTurnWeight,
    reason: headTurnSuppressed ? "정면을 바라보면 측정을 재개합니다."
      : headRollSuppressed ? "고개를 좌우로 기울이지 않으면 측정을 재개합니다."
        : "몸을 정면으로 두면 측정을 재개합니다."
  };
}

function drawPreview(result) {
  if (!previewContext) return;
  const width = previewCanvas.width, height = previewCanvas.height;
  if (silhouetteOnlyPreview) {
    previewContext.fillStyle = (panelDarkMode ?? previewTheme.matches) ? "#202124" : "#e5e7eb";
    previewContext.fillRect(0, 0, width, height);
  } else {
    previewContext.drawImage(video, 0, 0, width, height);
  }
  const segmentationMask = result?.segmentationMasks?.[0];
  if (segmentationMask && silhouetteContext) {
    const maskWidth = segmentationMask.width, maskHeight = segmentationMask.height;
    const maskValues = segmentationMask.getAsFloat32Array();
    const colorStops = smoothedScore < BLUR_START_SCORE
      ? { from: [56, 189, 248], to: [249, 115, 22], progress: clamp(smoothedScore / BLUR_START_SCORE, 0, 1) }
      : { from: [249, 115, 22], to: [239, 68, 68], progress: clamp((smoothedScore - BLUR_START_SCORE) / (BLUR_PEAK_SCORE - BLUR_START_SCORE), 0, 1) };
    const silhouetteColor = colorStops.from.map((channel, index) =>
      Math.round(channel + (colorStops.to[index] - channel) * colorStops.progress)
    );
    if (!silhouetteImageData || silhouetteCanvas.width !== maskWidth || silhouetteCanvas.height !== maskHeight) {
      silhouetteCanvas.width = maskWidth;
      silhouetteCanvas.height = maskHeight;
      silhouetteImageData = silhouetteContext.createImageData(maskWidth, maskHeight);
    }
    const pixels = silhouetteImageData.data;
    for (let index = 0; index < maskValues.length; index++) {
      const coverage = clamp((maskValues[index] - 0.18) / 0.55, 0, 1);
      const offset = index * 4;
      pixels[offset] = silhouetteColor[0];
      pixels[offset + 1] = silhouetteColor[1];
      pixels[offset + 2] = silhouetteColor[2];
      pixels[offset + 3] = Math.round(coverage * 105);
    }
    silhouetteContext.putImageData(silhouetteImageData, 0, 0);
    previewContext.drawImage(silhouetteCanvas, 0, 0, width, height);
  }
}

function sendPreview(result, features) {
  if (performance.now() - lastPreviewTime < 250 || !previewContext || previewInFlight) return;
  lastPreviewTime = performance.now();
  drawPreview(result);
  previewInFlight = true;
  const generation = previewGeneration;
  previewCanvas.toBlob(blob => {
    if (generation !== previewGeneration) return;
    if (!blob || !stream) {
      previewInFlight = false;
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      if (generation !== previewGeneration) return;
      previewInFlight = false;
      if (stream && typeof reader.result === "string") {
        chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_PREVIEW", data: reader.result }).catch(() => {});
      }
    };
    reader.onerror = () => {
      if (generation === previewGeneration) previewInFlight = false;
    };
    reader.readAsDataURL(blob);
  }, "image/jpeg", 0.5);
}

function detectCurrentVideoFrame() {
  const timestamp = Math.max(performance.now(), lastLandmarkerTimestamp + 1);
  lastLandmarkerTimestamp = timestamp;
  return landmarker.detectForVideo(video, timestamp);
}

async function createLandmarker() {
  if (landmarker) return landmarker;
  const vision = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("assets/wasm"));
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: chrome.runtime.getURL("models/pose_landmarker_lite.task"), delegate: "CPU" },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
    outputSegmentationMasks: true
  });
  return landmarker;
}

async function reportStatus(active, title, detail) {
  await chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_STATUS", active, title, detail }).catch(() => {});
}

function stopTracks() {
  previewGeneration++;
  previewInFlight = false;
  lastPreviewTime = 0;
  if (frameCallback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  frameCallback = 0;
  fallbackTimer = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_PREVIEW", data: "" }).catch(() => {});
  baseline = null;
  calibration = null;
  smoothedScore = 0;
  unscorableSince = 0;
  headTurnSuppressed = false;
  headRollSuppressed = false;
  torsoTurnSuppressed = false;
  lastVideoTime = -1;
  lastInferenceTime = 0;
}

async function stopDetection(reason = "자세 감지를 중지했습니다.") {
  stopTracks();
  await reportStatus(false, "카메라 꺼짐", reason);
}

async function startDetection(cameraId, silhouetteOnly = false) {
  stopTracks();
  silhouetteOnlyPreview = !!silhouetteOnly;
  await reportStatus(true, "카메라 연결 중…", "카메라를 여는 중입니다.");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    await createLandmarker();
    await reportStatus(true, "자세 감지 중", "기준 자세를 설정해 주세요.");
    scheduleFrame();
  } catch (error) {
    stopTracks();
    const names = {
      NotAllowedError: "카메라 권한이 거부되었습니다.",
      NotFoundError: "선택한 카메라를 찾지 못했습니다.",
      NotReadableError: "선택한 카메라를 열 수 없습니다.",
      OverconstrainedError: "선택한 카메라를 사용할 수 없습니다. 카메라 목록에서 다시 선택해 주세요."
    };
    await reportStatus(false, "카메라 시작 실패", `${names[error?.name] || "카메라 또는 모델을 확인해 주세요."} [${error?.name || "UnknownError"}: ${error?.message || "-"}]`);
  }
}

function scheduleFrame() {
  if (!stream) return;
  let handled = false;
  const run = (timestamp) => {
    if (handled) return;
    handled = true;
    if (frameCallback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    frameCallback = 0;
    fallbackTimer = null;
    try {
      processFrame();
    } catch (error) {
      chrome.runtime.sendMessage({
        type: "POSTUREFLOW_UI_HINT",
        hint: `프레임 분석 오류: ${error?.message || "알 수 없는 오류"}`
      }).catch(() => {});
    } finally {
      scheduleFrame();
    }
  };
  if (video.requestVideoFrameCallback) {
    frameCallback = video.requestVideoFrameCallback(run);
  }
  // Offscreen documents can pause animation callbacks; the timer keeps scoring and preview alive.
  fallbackTimer = setTimeout(() => run(performance.now()), 80);
}

function aspectRatio() {
  return video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
}

function collectCalibration(features) {
  if (features?.valid) calibration.frames.push(features);
  if (calibration.frames.length < CALIBRATION_FRAMES) {
    if (performance.now() - calibration.startedAt > CALIBRATION_TIMEOUT_MS) {
      calibration = null;
      chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_HINT", hint: "얼굴과 어깨가 잘 보이는 상태로 기준 자세를 설정해 주세요." }).catch(() => {});
    }
    return;
  }
  const candidate = medianFeatures(calibration.frames);
  calibration = null;
  if (Math.abs(candidate.headTurn) > 0.42 || Math.abs(candidate.headRoll) > 0.28 || candidate.torsoTurn > 0.45) {
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_HINT", hint: "정면을 보고 고개를 기울이지 않은 자세로 기준을 설정해 주세요." }).catch(() => {});
    return;
  }
  baseline = candidate;
  smoothedScore = 0;
  unscorableSince = 0;
  headTurnSuppressed = false;
  headRollSuppressed = false;
  torsoTurnSuppressed = false;
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_CALIBRATED" }).catch(() => {});
}

function processFrame() {
  if (!stream) return;
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    if (now - lastInferenceTime < 80) return;
    lastInferenceTime = now;
    const result = detectCurrentVideoFrame();
    const features = result.landmarks?.[0]
      ? extractFeatures(result.landmarks[0], result.worldLandmarks?.[0], aspectRatio())
      : null;
    if (calibration) collectCalibration(features);
    const orientation = features?.valid && baseline ? measureOrientation(features, baseline) : null;
    if (features?.valid && baseline && !orientation.suppressed) {
      unscorableSince = 0;
      const rawScore = deviationToScore(slouchDeviation(features.pose, baseline.pose) * orientation.weight);
      smoothedScore = smoothedScore * 0.65 + rawScore * 0.35;
      const progress = clamp((smoothedScore - BLUR_START_SCORE) / (BLUR_PEAK_SCORE - BLUR_START_SCORE), 0, 1);
      const intensity = progress * progress * (3 - 2 * progress);
      if (performance.now() - lastScorePublishTime >= 80) {
        lastScorePublishTime = performance.now();
        chrome.runtime.sendMessage({
          type: "POSTUREFLOW_OFFSCREEN_SCORE",
          score: intensity,
          displayScore: smoothedScore,
          hint: smoothedScore > 7 ? "자세가 기준에서 많이 벗어났습니다. 자세를 곧게 펴주세요!" : smoothedScore > 3 ? "자세 변화를 감지했습니다." : "좋습니다. 편안한 중립 자세를 유지하고 있어요."
        }).catch(() => {});
      }
    } else if (baseline && ((features && !features.valid && !features.missing) || orientation?.suppressed)) {
      if (!unscorableSince) unscorableSince = performance.now();
      const invalidFor = performance.now() - unscorableSince;
      if ((orientation?.suppressed || invalidFor >= 400) && smoothedScore > 0) {
        smoothedScore = 0;
        lastScorePublishTime = performance.now();
        chrome.runtime.sendMessage({
          type: "POSTUREFLOW_OFFSCREEN_SCORE",
          score: 0,
          displayScore: 0,
          hint: orientation?.reason || "얼굴과 어깨가 잘 보이면 측정을 재개합니다."
        }).catch(() => {});
      }
    } else if ((!features || features.missing) && baseline) {
      unscorableSince = 0;
      smoothedScore = 0;
      if (performance.now() - lastScorePublishTime >= 200) {
        lastScorePublishTime = performance.now();
        chrome.runtime.sendMessage({
          type: "POSTUREFLOW_OFFSCREEN_SCORE",
          score: 0,
          displayScore: 0,
          hint: "사람을 찾을 수 없어 자세 점수를 초기화했습니다. 카메라 안으로 돌아와 주세요."
        }).catch(() => {});
      }
    }
    sendPreview(result, features);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "POSTUREFLOW_OFFSCREEN_THEME") panelDarkMode = !!message.darkMode;
  if (message?.type === "POSTUREFLOW_OFFSCREEN_START") startDetection(message.cameraId, message.silhouetteOnlyPreview);
  if (message?.type === "POSTUREFLOW_OFFSCREEN_STOP") stopDetection(message.reason);
  if (message?.type === "POSTUREFLOW_OFFSCREEN_PREVIEW_MODE") silhouetteOnlyPreview = !!message.silhouetteOnly;
  if (message?.type === "POSTUREFLOW_OFFSCREEN_CALIBRATE") {
    if (!stream || !landmarker) return;
    calibration = { frames: [], startedAt: performance.now() };
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_HINT", hint: "기준 자세를 재는 중이에요. 1초만 그대로 있어 주세요." }).catch(() => {});
  }
});

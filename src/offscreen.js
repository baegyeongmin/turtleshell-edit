import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const video = document.getElementById("camera");
let stream = null;
let landmarker = null;
let frameCallback = 0;
let fallbackTimer = null;
let baseline = null;
let smoothedScore = 0;
let unscorableSince = 0;
let lastVideoTime = -1;
let lastPreviewTime = 0;
let previewInFlight = false;
let previewGeneration = 0;
let lastLandmarkerTimestamp = 0;
let lastScorePublishTime = 0;
let lastInferenceTime = 0;
const previewCanvas = document.createElement("canvas");
previewCanvas.width = 320;
previewCanvas.height = 240;
const previewContext = previewCanvas.getContext("2d");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function extractFeatures(landmarks, worldLandmarks) {
  const nose = landmarks[0];
  const leftEar = landmarks[7], rightEar = landmarks[8];
  const leftShoulder = landmarks[11], rightShoulder = landmarks[12];
  const leftWrist = landmarks[15], rightWrist = landmarks[16];
  if (![nose, leftEar, rightEar, leftShoulder, rightShoulder].every(point => point && point.visibility > 0.35)) {
    return { valid: false, missing: true, reason: "얼굴 또는 어깨 랜드마크가 보이지 않음" };
  }

  const earMidX = (leftEar.x + rightEar.x) / 2;
  const earWidth = Math.max(0.02, Math.abs(leftEar.x - rightEar.x));
  const shoulderWidth2d = Math.max(0.05, Math.abs(leftShoulder.x - rightShoulder.x));

  // Turning the head or torso makes the apparent head/shoulder geometry unreliable.
  const headTurn = Math.abs(nose.x - earMidX) / earWidth;
  const world = worldLandmarks;
  const worldPoints = [world?.[7], world?.[8], world?.[11], world?.[12]];
  if (!worldPoints.every(point =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
  )) return { valid: false, reason: "깊이 좌표 없음", headTurn };

  const [leftEar3d, rightEar3d, leftShoulder3d, rightShoulder3d] = worldPoints;
  const shoulderDx = leftShoulder3d.x - rightShoulder3d.x;
  const shoulderDy = leftShoulder3d.y - rightShoulder3d.y;
  const shoulderDz = leftShoulder3d.z - rightShoulder3d.z;
  const shoulderWidth3d = Math.max(0.15, Math.hypot(shoulderDx, shoulderDy, shoulderDz));
  const earMidZ = (leftEar3d.z + rightEar3d.z) / 2;
  const shoulderMidZ = (leftShoulder3d.z + rightShoulder3d.z) / 2;
  const depthDifference = shoulderMidZ - earMidZ;
  const forwardHead = depthDifference / shoulderWidth3d;
  const measurements = { forwardHead, depthDifference, shoulderWidth3d };
  if (headTurn > 0.35) return { valid: false, reason: "고개 회전으로 측정 보류", headTurn, ...measurements };

  const torsoTurn = Math.abs(shoulderDz) / shoulderWidth3d;
  if (torsoTurn > 0.45) return { valid: false, reason: "몸 회전으로 측정 보류", headTurn, torsoTurn, ...measurements };

  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
  const armRaised = [landmarks[13], landmarks[14], leftWrist, rightWrist].some(point =>
    point?.visibility > 0.35 && point.y < shoulderMidY - 0.03
  );
  if (armRaised) return { valid: false, reason: "팔을 든 상태로 측정 보류", headTurn, torsoTurn, ...measurements };

  const faceX = (nose.x + leftEar.x + rightEar.x) / 3;
  const faceY = (nose.y + leftEar.y + rightEar.y) / 3;
  const handNearFace = [leftWrist, rightWrist].some(wrist =>
    wrist?.visibility > 0.35 && Math.hypot(wrist.x - faceX, wrist.y - faceY) < shoulderWidth2d * 0.4
  );
  if (handNearFace) return { valid: false, reason: "손이 얼굴 가까이에 있어 측정 보류", headTurn, torsoTurn, ...measurements };

  return { valid: true, reason: "측정 중", headTurn, torsoTurn, ...measurements };
}

function drawPreview(result, features) {
  if (!previewContext) return;
  const width = previewCanvas.width, height = previewCanvas.height;
  previewContext.drawImage(video, 0, 0, width, height);
  const landmarks = result?.landmarks?.[0];
  const drawSegment = (firstIndex, secondIndex, color, lineWidth = 2) => {
    const first = landmarks?.[firstIndex], second = landmarks?.[secondIndex];
    if (!first || !second || first.visibility <= 0.2 || second.visibility <= 0.2) return;
    previewContext.beginPath();
    previewContext.moveTo(first.x * width, first.y * height);
    previewContext.lineTo(second.x * width, second.y * height);
    previewContext.strokeStyle = color;
    previewContext.lineWidth = lineWidth;
    previewContext.stroke();
  };
  const drawPoint = (index, color) => {
    const point = landmarks?.[index];
    if (!point || point.visibility <= 0.2) return;
    previewContext.beginPath();
    previewContext.arc(point.x * width, point.y * height, 4, 0, Math.PI * 2);
    previewContext.fillStyle = color;
    previewContext.fill();
    previewContext.strokeStyle = "#fff";
    previewContext.lineWidth = 1.5;
    previewContext.stroke();
  };
  drawSegment(7, 8, "#38bdf8");
  drawSegment(11, 12, "#fbbf24");
  drawSegment(7, 11, "rgba(251,113,133,0.85)", 1.5);
  drawSegment(8, 12, "rgba(251,113,133,0.85)", 1.5);
  [7, 8].forEach(index => drawPoint(index, "#38bdf8"));
  [11, 12].forEach(index => drawPoint(index, "#fbbf24"));
  const markMidpoint = (leftIndex, rightIndex, color, label) => {
    const left = landmarks?.[leftIndex], right = landmarks?.[rightIndex];
    if (!left || !right || left.visibility <= 0.2 || right.visibility <= 0.2) return;
    const x = (left.x + right.x) * width / 2;
    const y = (left.y + right.y) * height / 2;
    previewContext.beginPath();
    previewContext.arc(x, y, 6, 0, Math.PI * 2);
    previewContext.strokeStyle = color;
    previewContext.lineWidth = 2;
    previewContext.stroke();
    previewContext.beginPath();
    previewContext.arc(x, y, 2, 0, Math.PI * 2);
    previewContext.fillStyle = color;
    previewContext.fill();

    previewContext.save();
    previewContext.translate(x, y);
    previewContext.scale(-1, 1);
    previewContext.font = "11px sans-serif";
    previewContext.textBaseline = "middle";
    const labelWidth = previewContext.measureText(label).width;
    previewContext.fillStyle = "rgba(15, 23, 42, 0.8)";
    previewContext.fillRect(9, -8, labelWidth + 8, 16);
    previewContext.fillStyle = color;
    previewContext.fillText(label, 13, 0);
    previewContext.restore();
  };
  markMidpoint(7, 8, "#38bdf8", "귀 기준");
  markMidpoint(11, 12, "#fbbf24", "어깨 기준");

  const forwardDeviation = features && baseline
    ? Math.max(0, features.forwardHead - baseline.forwardHead)
    : null;
  const measurementLines = features?.forwardHead != null
    ? [
        `귀-어깨 깊이차/어깨폭: ${features.forwardHead.toFixed(3)}`,
        `기준 대비 변화: ${forwardDeviation == null ? "—" : forwardDeviation.toFixed(3)}`,
        `어깨 폭: ${features.shoulderWidth3d?.toFixed(3) ?? "—"} (모델 단위)`
      ]
    : ["귀·어깨 깊이 측정 대기 중"];
  const boxWidth = 300, boxX = (width - boxWidth) / 2, boxY = 8, lineHeight = 14;
  previewContext.fillStyle = "rgba(15, 23, 42, 0.78)";
  previewContext.fillRect(boxX, boxY, boxWidth, 10 + measurementLines.length * lineHeight);
  previewContext.font = "10px sans-serif";
  previewContext.textBaseline = "top";
  previewContext.textAlign = "center";
  measurementLines.forEach((line, index) => {
    previewContext.save();
    previewContext.translate(width / 2, boxY + 5 + index * lineHeight);
    previewContext.scale(-1, 1);
    previewContext.fillStyle = index === 0 ? "#fda4af" : "#fff";
    previewContext.fillText(line, 0, 0, boxWidth - 12);
    previewContext.restore();
  });

  const barProgress = clamp(smoothedScore / 10, 0, 1);
  const barX = 12, barY = height - 22, barWidth = width - 24, barHeight = 8;

  // The preview image is mirrored by the side panel; counter-flip the gauge so
  // progress still grows from left to right on screen.
  previewContext.save();
  previewContext.translate(width, 0);
  previewContext.scale(-1, 1);
  previewContext.fillStyle = "rgba(255,255,255,0.38)";
  previewContext.fillRect(barX, barY, barWidth, barHeight);
  previewContext.fillStyle = "#fb7185";
  previewContext.fillRect(barX, barY, barWidth * barProgress, barHeight);
  previewContext.fillStyle = "#fff";
  previewContext.fillRect(barX + barWidth * (3 / 10) - 1, barY - 2, 2, barHeight + 4);
  previewContext.font = "11px sans-serif";
  previewContext.textAlign = "right";
  previewContext.textBaseline = "bottom";
  previewContext.fillStyle = "#fff";
  previewContext.fillText(smoothedScore.toFixed(1), width - 12, barY - 3);
  previewContext.restore();
}

function sendPreview(result, features) {
  if (performance.now() - lastPreviewTime < 250 || !previewContext || previewInFlight) return;
  lastPreviewTime = performance.now();
  drawPreview(result, features);
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
    minTrackingConfidence: 0.55
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
  smoothedScore = 0;
  unscorableSince = 0;
  lastVideoTime = -1;
  lastInferenceTime = 0;
}

async function stopDetection(reason = "자세 감지를 중지했습니다.") {
  stopTracks();
  await reportStatus(false, "카메라 꺼짐", reason);
}

async function startDetection(cameraId) {
  stopTracks();
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

function processFrame() {
  if (!stream) return;
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    if (now - lastInferenceTime < 80) return;
    lastInferenceTime = now;
    const result = detectCurrentVideoFrame();
    const features = result.landmarks?.[0]
      ? extractFeatures(result.landmarks[0], result.worldLandmarks?.[0])
      : null;
    if (features?.valid && baseline) {
      unscorableSince = 0;
      const forwardDeviation = Math.max(0, features.forwardHead - baseline.forwardHead);
      const rawScore = clamp(((forwardDeviation - 0.025) / 0.10) * 10, 0, 10);
      smoothedScore = smoothedScore * 0.65 + rawScore * 0.35;
      const progress = clamp((smoothedScore - 0.6) / 1.4, 0, 1);
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
    } else if (features && !features.valid && !features.missing && baseline) {
      if (!unscorableSince) unscorableSince = performance.now();
      const invalidFor = performance.now() - unscorableSince;
      if (invalidFor >= 400 && smoothedScore > 0) {
        smoothedScore = 0;
        lastScorePublishTime = performance.now();
        chrome.runtime.sendMessage({
          type: "POSTUREFLOW_OFFSCREEN_SCORE",
          score: 0,
          displayScore: 0,
          hint: "정면을 바라보고 양팔을 내리면 자세 분석을 재개합니다."
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
  if (message?.type === "POSTUREFLOW_OFFSCREEN_START") startDetection(message.cameraId);
  if (message?.type === "POSTUREFLOW_OFFSCREEN_STOP") stopDetection(message.reason);
  if (message?.type === "POSTUREFLOW_OFFSCREEN_CALIBRATE") {
    if (!stream || !landmarker) return;
    const result = detectCurrentVideoFrame();
    const features = result.landmarks?.[0]
      ? extractFeatures(result.landmarks[0], result.worldLandmarks?.[0])
      : null;
    if (!features?.valid) {
      chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_HINT", hint: "정면을 바라보고 양팔을 내린 상태로 기준 자세를 설정해 주세요." }).catch(() => {});
      return;
    }
    baseline = features;
    smoothedScore = 0;
    unscorableSince = 0;
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_CALIBRATED" }).catch(() => {});
  }
});

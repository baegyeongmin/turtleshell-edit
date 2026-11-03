import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const $ = (id) => document.getElementById(id);
const video = $("camera");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const calibrateBtn = $("calibrateBtn");
const statusText = $("statusText");
const statusDetail = $("statusDetail");
const statusDot = $("statusDot");
const scoreBar = $("scoreBar");
const scoreText = $("scoreText");
const hint = $("hint");
const effectsToggle = $("effectsToggle");
const meetingToggle = $("meetingToggle");
const cameraSelect = $("cameraSelect");

// Labels are only exposed once camera permission exists, so this is refilled after a stream starts.
async function fillCameras() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  const { cameraId } = await chrome.storage.local.get("cameraId");
  cameraSelect.replaceChildren(...cams.map((c, i) =>
    new Option(c.label || `카메라 ${i + 1}`, c.deviceId, false, c.deviceId === (current || cameraId))));
}

cameraSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ cameraId: cameraSelect.value });
  if (stream) { await stopDetection("카메라를 바꾸는 중입니다."); startDetection(); }
});
fillCameras();

let stream = null;
let landmarker = null;
let raf = 0;
let baseline = null;
let smoothedScore = 0;
let lastVideoTime = -1;
let suspended = false;
let settings = { effects: true, meetingSuspend: true };

const MEETING_HOSTS = [
  "meet.google.com", "app.zoom.us", "zoom.us",
  "teams.microsoft.com", "teams.live.com"
];

function isMeetingHost(host) {
  return MEETING_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function sendToActiveTab(message) {
  const tab = await activeTab();
  if (tab?.id == null) return;
  try { await chrome.tabs.sendMessage(tab.id, message); } catch { /* restricted page */ }
}

// 💡 열려 있는 모든 탭에 메시지를 일괄 브로드캐스트하는 함수
async function broadcastToAllTabs(messageData) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab?.id == null) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, messageData);
    } catch {
      // restricted page나 아직 준비되지 않은 탭은 무시
    }
  }
}

function setStatus(active, title, detail) {
  statusDot.classList.toggle("active", active);
  statusText.textContent = title;
  statusDetail.textContent = detail;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

async function createLandmarker() {
  if (landmarker) return landmarker;
  const vision = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL("assets/wasm")
  );
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL("models/pose_landmarker_lite.task"),
      delegate: "CPU"
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55
  });
  return landmarker;
}

function extractFeatures(landmarks) {
  const nose = landmarks[0];
  const leftEar = landmarks[7], rightEar = landmarks[8];
  const leftShoulder = landmarks[11], rightShoulder = landmarks[12];
  if (![nose, leftEar, rightEar, leftShoulder, rightShoulder].every(p => p && p.visibility > 0.35)) return null;

  const earMidX = (leftEar.x + rightEar.x) / 2;
  const earMidY = (leftEar.y + rightEar.y) / 2;
  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
  const shoulderWidth = Math.max(0.08, Math.abs(leftShoulder.x - rightShoulder.x));
  const noseOffset = Math.abs(nose.x - earMidX) / shoulderWidth;
  const headDrop = (nose.y - earMidY) / shoulderWidth;
  const headToShoulder = (earMidY - shoulderMidY) / shoulderWidth;
  return { noseOffset, headDrop, headToShoulder };
}

function distance(a, b) {
  return Math.sqrt(
    (a.noseOffset - b.noseOffset) ** 2 +
    (a.headDrop - b.headDrop) ** 2 +
    (a.headToShoulder - b.headToShoulder) ** 2
  );
}

async function checkTabSuspension() {
  const tab = await activeTab();
  if (!tab?.url) return;
  let host = "";
  try { host = new URL(tab.url).hostname; } catch {}
  const knownMeeting = settings.meetingSuspend && isMeetingHost(host);
  suspended = knownMeeting;
  if (knownMeeting) {
    await stopDetection("회의/화상통화 사이트에서는 자동으로 중지했습니다.");
  } else if (stream && !suspended) {
    setStatus(true, "자세 감지 중", "현재 탭에서 자세를 분석하고 있습니다.");
  }
}

function openPermissionPopup(reason) {
  // Side panels can't show the camera prompt (getUserMedia hangs or fails); a popup window can.
  setStatus(false, "카메라 권한 필요", `작은 창에서 '허용'을 누르면 자동으로 시작합니다. [${reason}]`);
  chrome.windows.create({ url: chrome.runtime.getURL("permission.html"), type: "popup", width: 460, height: 320 });
}

async function startDetection(afterGrant = false) {
  try {
    // Only ask from the panel once permission exists; skip the check right after the popup granted it.
    const perm = afterGrant ? null : await navigator.permissions.query({ name: "camera" }).catch(() => null);
    if (perm && perm.state !== "granted") return openPermissionPopup(`권한 상태: ${perm.state}`);
    setStatus(false, "카메라 연결 중…", "카메라를 여는 중입니다.");
    const { cameraId } = await chrome.storage.local.get("cameraId");
    const cameraRequest = navigator.mediaDevices.getUserMedia({
      // ideal, not exact: falls back to the default camera if the saved one is unplugged.
      video: { deviceId: cameraId ? { ideal: cameraId } : undefined, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });

    await checkTabSuspension();
    if (suspended) {
      const pendingStream = await cameraRequest.catch(() => null);
      pendingStream?.getTracks().forEach(track => track.stop());
      return;
    }

    stream = await cameraRequest;
    video.srcObject = stream;
    video.style.display = "block";
    await video.play();
    await createLandmarker();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    calibrateBtn.disabled = false;
    setStatus(true, "자세 감지 중", `편안하게 똑바로 앉은 상태에서 기준 자세를 설정해 주세요. [카메라: ${stream.getVideoTracks()[0]?.label || "?"}]`);
    fillCameras();
    loop();
  } catch (error) {
    const name = error?.name || "UnknownError";
    const messages = {
      NotAllowedError: "카메라 권한이 거부되었거나 권한 요청 창이 닫혔습니다.",
      PermissionDeniedError: "카메라 권한이 거부되었습니다.",
      NotFoundError: "사용 가능한 카메라를 찾지 못했습니다.",
      NotReadableError: "카메라를 열 수 없습니다.",
      OverconstrainedError: "요청한 카메라 설정을 지원하지 않습니다.",
      SecurityError: "보안 정책 때문에 카메라에 접근할 수 없습니다."
    };
    const detail = `${messages[name] || "카메라 또는 모델을 확인해 주세요."} [${name}: ${error?.message || "-"}]`;
    setStatus(false, "카메라 시작 실패", detail);
    stopTracks();
    if (name === "NotAllowedError" && !afterGrant) openPermissionPopup(error?.message || name);
  }
}

function stopTracks() {
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  video.style.display = "none";
}

async function stopDetection(reason = "자세 감지를 중지했습니다.") {
  cancelAnimationFrame(raf);
  stopTracks();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  calibrateBtn.disabled = true;
  smoothedScore = 0;
  scoreBar.style.width = "0%";
  scoreText.textContent = "—";
  await sendToActiveTab({ type: "POSTUREFLOW_STATE", active: false, reason });
  setStatus(false, suspended ? "자동 중지됨" : "카메라 꺼짐", reason);
}

function loop() {
  if (!stream || suspended) return;
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, performance.now());
    const features = result.landmarks?.[0] ? extractFeatures(result.landmarks[0]) : null;
    if (features && baseline) {
      const rawDist = distance(features, baseline);
      
      const scaleTo50 = clamp(((rawDist - 0.035) / 0.20) * 50, 0, 50);
      
      smoothedScore = smoothedScore * 0.82 + scaleTo50 * 0.18;
      const currentDeviationValue = smoothedScore;

      let effectIntensity = 0;
      if (currentDeviationValue <= 8) {
        effectIntensity = 0;
      } else if (currentDeviationValue <= 12) {
        effectIntensity = (currentDeviationValue - 8) / (12 - 8);
      } else {
        effectIntensity = 1.0;
      }
      
      const displayScorePercent = Math.round((currentDeviationValue / 50) * 100);
      scoreBar.style.width = `${displayScorePercent}%`;
      scoreText.textContent = `${currentDeviationValue.toFixed(1)} / 50`;
      
      hint.textContent = currentDeviationValue > 35 ? "자세가 기준에서 많이 벗어났습니다. 자세를 곧게 펴주세요!" :
        currentDeviationValue > 15 ? "자세 변화를 감지했습니다." : "좋습니다. 편안한 중립 자세를 유지하고 있어요.";
      
      sendToActiveTab({
        type: "POSTUREFLOW_SCORE",
        score: settings.effects ? effectIntensity : 0,
        active: true
      });
    }
  }
  raf = requestAnimationFrame(loop);
}

calibrateBtn.addEventListener("click", () => {
  if (!landmarker || !stream) return;
  const result = landmarker.detectForVideo(video, performance.now());
  const features = result.landmarks?.[0] ? extractFeatures(result.landmarks[0]) : null;
  if (!features) {
    hint.textContent = "얼굴과 양쪽 어깨가 화면에 보이도록 카메라 위치를 조정해 주세요.";
    return;
  }
  baseline = features;
  smoothedScore = 0;
  hint.textContent = "기준 자세를 저장했습니다. 이제 자세 변화를 감지합니다.";
});

startBtn.addEventListener("click", () => startDetection());
stopBtn.addEventListener("click", () => stopDetection());
effectsToggle.addEventListener("change", () => {
  settings.effects = effectsToggle.checked;
  sendToActiveTab({ type: "POSTUREFLOW_EFFECTS", enabled: settings.effects });
});
meetingToggle.addEventListener("change", async () => {
  settings.meetingSuspend = meetingToggle.checked;
  await checkTabSuspension();
});

document.addEventListener("DOMContentLoaded", () => {
  const saveMsgBtn = $("save-message-btn");
  const msgInput = $("posture-message-input");

  if (saveMsgBtn && msgInput) {
    chrome.storage.sync.get(["postureMessage"], (data) => {
      if (data.postureMessage) {
        msgInput.value = data.postureMessage;
        sendToActiveTab({ type: "POSTUREFLOW_UPDATE_TEXT", text: data.postureMessage });
      }
    });

    saveMsgBtn.addEventListener("click", () => {
      const text = msgInput.value.trim() || "자세를 고치자";
      chrome.storage.sync.set({ postureMessage: text });
      sendToActiveTab({ type: "POSTUREFLOW_UPDATE_TEXT", text });
    });
  }
});

chrome.tabs.onActivated.addListener(checkTabSuspension);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) checkTabSuspension();
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CAMERA_GRANTED" && !stream) startDetection(true);
  if (message?.type === "PAGE_CAMERA_STATE" && message.active && settings.meetingSuspend) {
    stopDetection("페이지에서 카메라 사용을 감지해 자세 감지를 중지했습니다.");
  }
  if (message?.type === "POSTUREFLOW_CHECK_STATUS") {
    sendResponse({ isBreakTime: isBreakTime });
    return true; 
  }
});

setStatus(false, "카메라 꺼짐", "시작을 누르면 이 확장 프로그램 안에서 자세 분석을 시작합니다.");

let timerInterval = null;
let isBreakTime = false;

const timerToggleBtn = $("timerToggleBtn");
const workTimeInput = $("workTimeInput");
const breakTimeInput = $("breakTimeInput");
const timerStatus = $("timerStatus");

if (timerToggleBtn) {
  timerToggleBtn.addEventListener("click", () => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
      timerToggleBtn.textContent = "타이머 시작";
      timerStatus.textContent = "타이머가 중지되었습니다.";
      isBreakTime = false;
      broadcastToAllTabs({ type: "POSTUREFLOW_TRAPEZOID_MODE", active: false });
    } else {
      let workMinutes = parseInt(workTimeInput.value) || 50;
      let breakMinutes = parseInt(breakTimeInput.value) || 10;
      
      let totalSeconds = workMinutes * 60;
      let currentSeconds = totalSeconds;
      isBreakTime = false;

      timerToggleBtn.textContent = "타이머 중지";
      
      timerInterval = setInterval(() => {
        currentSeconds--;
        
        let m = Math.floor(currentSeconds / 60);
        let s = currentSeconds % 60;
        
        if (currentSeconds > 0) {
          timerStatus.textContent = isBreakTime 
            ? `[휴식 중] 남은 휴식 시간: ${m}분 ${s}초` 
            : `[집중 중] 남은 시간: ${m}분 ${s}초`;
        } else {
          isBreakTime = !isBreakTime;
          if (isBreakTime) {
            currentSeconds = breakMinutes * 60;
            timerStatus.textContent = "휴식 시간 시작! 화면이 사다리꼴로 줄어듭니다.";
            broadcastToAllTabs({ type: "POSTUREFLOW_TRAPEZOID_MODE", active: true });
          } else {
            currentSeconds = workMinutes * 60;
            timerStatus.textContent = "집중 시간 시작! 화면이 원래대로 돌아옵니다.";
            broadcastToAllTabs({ type: "POSTUREFLOW_TRAPEZOID_MODE", active: false });
          }
        }
      }, 1000);
    }
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && isBreakTime) {
    try {
      await chrome.tabs.sendMessage(tabId, { 
        type: "POSTUREFLOW_TRAPEZOID_MODE", 
        active: true 
      });
    } catch {
      // 무시
    }
  }
});


const tiltRange = $("tiltIntensityRange");
const tiltValueLabel = $("tiltValue");

if (tiltRange) {
  chrome.storage.sync.get(["tiltIntensity"], (data) => {
    const val = data.tiltIntensity || 3;
    tiltRange.value = val;
    if (tiltValueLabel) tiltValueLabel.textContent = val;
  });

  tiltRange.addEventListener("input", () => {
    const val = tiltRange.value;
    if (tiltValueLabel) tiltValueLabel.textContent = val;
    chrome.storage.sync.set({ tiltIntensity: Number(val) });

    broadcastToAllTabs({ type: "POSTUREFLOW_UPDATE_TILT_CONFIG", intensity: Number(val) });
  });
}
(() => {
  if (window.__postureFlowContentLoaded) return;
  window.__postureFlowContentLoaded = true;

  let overlay = null;
  let textEl = null; 
  let closeButton = null;
  let blocker = null;        // transparent layer that eats clicks while posture is bad
  let blocked = false;
  let lastScoreAt = 0;
  let watchdog = null;
  const BLOCK_ON = 0.6;      // effect intensity (0..1) at which clicks are blocked
  const BLOCK_OFF = 0.4;     // lower release point so it doesn't flicker around the threshold
  const STALE_MS = 3000;     // no score for this long (detection died, extension reloaded) -> clear everything
  let score = 0;
  let active = false;
  let effectsEnabled = true;
  let userMessage = "자세를 고치자"; 
  let isBreakTime = false; 
  let currentTiltAngle = 3;   // 기본 틸트 각도

  function ensureOverlay() {
    const container = document.documentElement || document.body;
    if (!container) return null;

    if (!overlay) {
      overlay = document.getElementById("postureflow-overlay") || document.createElement("canvas");
      overlay.id = "postureflow-overlay";
      Object.assign(overlay.style, {
        position: "fixed", inset: "0", width: "100vw", height: "100vh",
        zIndex: "2147483646", pointerEvents: "none", display: "none"
      });
    }
    if (!overlay.isConnected) container.appendChild(overlay);

    if (!textEl) {
      textEl = document.getElementById("postureflow-message") || document.createElement("div");
      textEl.id = "postureflow-message";
      textEl.textContent = userMessage;
      Object.assign(textEl.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: "2147483647",
      pointerEvents: "none",
      padding: "24px 48px",
      borderRadius: "28px",
      backdropFilter: "blur(25px) saturate(180%)",
      webkitBackdropFilter: "blur(25px) saturate(180%)",
      background: "rgba(255, 255, 255, 0.12)",
      border: "1px solid rgba(255, 255, 255, 0.25)",
      boxShadow: "0 15px 35px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.4)",
      color: "#ffffff",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      fontSize: "36px",
      fontWeight: "700",
      letterSpacing: "-0.5px",
      whiteSpace: "nowrap",
      textAlign: "center",
      textShadow: "0 2px 8px rgba(0, 0, 0, 0.2)",
      opacity: "0",
      transition: "opacity 0.3s ease",
      display: "none"
      });
    }
    if (!textEl.isConnected) container.appendChild(textEl);

    if (!closeButton) {
      closeButton = document.getElementById("postureflow-close") || document.createElement("button");
      closeButton.id = "postureflow-close";
      closeButton.type = "button";
      closeButton.setAttribute("aria-label", "자세 감지 및 화면 효과 종료");
      const closeGlyph = document.createElement("span");
      closeGlyph.textContent = "×";
      Object.assign(closeGlyph.style, {
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        color: "#fff",
        fontFamily: "Arial, sans-serif",
        fontSize: "144px",
        fontWeight: "300",
        lineHeight: "1",
        pointerEvents: "none",
        userSelect: "none"
      });
      closeButton.replaceChildren(closeGlyph);
      Object.assign(closeButton.style, {
        all: "initial",
        position: "fixed",
        top: "60px",
        right: "60px",
        zIndex: "2147483647",
        width: "48px",
        height: "48px",
        display: "none",
        opacity: "0",
        padding: "0",
        border: "0",
        background: "transparent",
        overflow: "visible",
        cursor: "pointer",
        pointerEvents: "auto",
        transition: "opacity 0.3s ease"
      });
      closeButton.addEventListener("click", () => {
        active = false;
        score = 0;
        if (overlay) overlay.style.display = "none";
        publish();
        chrome.runtime.sendMessage({ type: "POSTUREFLOW_STOP_DETECTION", reason: "화면의 종료 버튼을 눌렀습니다." }).catch(() => {});
      });
    }
    if (!blocker) {
      blocker = document.getElementById("postureflow-blocker") || document.createElement("div");
      blocker.id = "postureflow-blocker";
      Object.assign(blocker.style, {
        position: "fixed", inset: "0", zIndex: "2147483646",
        display: "none", pointerEvents: "none", cursor: "not-allowed", background: "transparent"
      });
      // Swallow clicks so nothing behind reacts; the close button sits above this layer.
      for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu", "auxclick"]) {
        blocker.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); }, true);
      }
    }
    if (!blocker.isConnected) container.appendChild(blocker);
    if (!closeButton.isConnected || closeButton.nextSibling !== null) container.appendChild(closeButton); // keep it above the blocker

    if (!window.__postureFlowOverlayScriptInjected) {
      window.__postureFlowOverlayScriptInjected = true;
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("overlay.js");
      script.onload = () => script.remove();
      (document.head || container).appendChild(script);
    }
    
    return overlay;
  }

  function publish() {
    if (!overlay?.isConnected) return;
    
    const targetIntensity = (effectsEnabled && active && !isBreakTime) ? score : 0;
    setBlocked(targetIntensity >= (blocked ? BLOCK_OFF : BLOCK_ON));
    // Failsafe: while any effect is on, drop it if score updates stop arriving.
    if (targetIntensity > 0 && !watchdog) {
      watchdog = setInterval(() => {
        if (Date.now() - lastScoreAt < STALE_MS) return;
        score = 0;
        active = false;
        if (overlay) overlay.style.display = "none";
        publish();
      }, 1000);
    } else if (targetIntensity === 0 && watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    
    if (textEl) {
      if (active && effectsEnabled && !isBreakTime && targetIntensity > 0.02) {
        textEl.style.display = "block";
        textEl.style.opacity = targetIntensity;
      } else {
        textEl.style.opacity = "0";
        setTimeout(() => {
          if (Number(textEl.style.opacity) === 0) textEl.style.display = "none";
        }, 200);
      }
    }
    if (closeButton) {
      if (active && effectsEnabled && !isBreakTime && targetIntensity > 0.02) {
        closeButton.style.display = "block";
        closeButton.style.opacity = targetIntensity;
      } else {
        closeButton.style.opacity = "0";
        setTimeout(() => {
          if (Number(closeButton.style.opacity) === 0) closeButton.style.display = "none";
        }, 200);
      }
    }

    window.postMessage({
      source: "POSTUREFLOW_CONTENT",
      type: "RENDER",
      score: targetIntensity,
      active: active && effectsEnabled && !isBreakTime
    }, "*");
  }

  function setBlocked(next) {
    blocked = next;
    if (!blocker) return;
    blocker.style.display = next ? "block" : "none";
    blocker.style.pointerEvents = next ? "auto" : "none";
  }

  // Break-time tilt (ported from PR #2, which edited the unused root content.js):
  // tilt <body> instead of <html> so our overlay, message and close button stay upright.
  let tiltCleanupTimer = null;
  function applyTrapezoidMode(enabled, immediate = false) {
    const root = document.body;
    if (!root) { // runs at document_start; wait for <body>
      document.addEventListener("DOMContentLoaded", () => applyTrapezoidMode(enabled, true), { once: true });
      return;
    }
    const nextBreakTime = !!enabled;
    if (nextBreakTime === isBreakTime) return;
    isBreakTime = nextBreakTime;
    const skipAnimation = immediate || document.visibilityState !== "visible";
    clearTimeout(tiltCleanupTimer);

    if (isBreakTime) {
      root.style.transition = skipAnimation ? "none" : "transform 6s cubic-bezier(0.25, 1, 0.5, 1)";
      root.style.transformOrigin = "bottom center";
      root.style.transformStyle = "preserve-3d";
      root.style.willChange = "transform";
      chrome.storage.sync.get(["tiltIntensity"], data => {
        if (!isBreakTime) return;
        const angle = data.tiltIntensity || currentTiltAngle;
        root.style.transform = `perspective(1200px) rotateX(${angle}deg) scale(0.95)`;
      });
      if (overlay) overlay.style.display = "none";
      if (textEl) textEl.style.opacity = "0";
      publish();
      return;
    }

    root.style.transition = skipAnimation ? "none" : "transform 0.8s ease";
    root.style.transform = "perspective(1200px) rotateX(0deg) scale(1)";
    // A leftover transform on <body> breaks position:fixed headers on the page, so remove it once settled.
    tiltCleanupTimer = setTimeout(() => {
      if (isBreakTime) return;
      for (const prop of ["transform", "transition", "transformOrigin", "transformStyle", "willChange"]) root.style[prop] = "";
    }, skipAnimation ? 0 : 900);
    publish();
  }

  function refreshTrapezoidMode() {
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_TIMER_GET" }, timer => {
      if (chrome.runtime.lastError) return;
      applyTrapezoidMode(!!timer?.active && !!timer.isBreakTime, true);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "POSTUREFLOW_SCORE") {
      lastScoreAt = Date.now();
      active = !!message.active;
      score = Number(message.score) || 0; 
      const canvas = ensureOverlay();
      if (canvas) canvas.style.display = (active && effectsEnabled && !isBreakTime) ? "block" : "none";
      publish();
    }
    if (message?.type === "POSTUREFLOW_STATE") {
      active = false;
      score = 0;
      if (overlay) overlay.style.display = "none";
      publish();
    }
    if (message?.type === "POSTUREFLOW_EFFECTS") {
      effectsEnabled = !!message.enabled;
      if (overlay) overlay.style.display = (active && effectsEnabled && !isBreakTime) ? "block" : "none";
      publish();
    }
    if (message?.type === "POSTUREFLOW_UPDATE_TEXT") {
      userMessage = message.text || "자세를 고치자";
      ensureOverlay();
      if (textEl) textEl.textContent = userMessage;
    }

    // 💡 사이드패널에서 틸트 강도 실시간 조절값 수신
    if (message?.type === "POSTUREFLOW_UPDATE_TILT_CONFIG") {
      currentTiltAngle = message.intensity;
      if (isBreakTime) {
        const root = document.body;
        root.style.transition = "transform 0.5s ease";
        root.style.transform = `perspective(1200px) rotateX(${currentTiltAngle}deg) scale(0.95)`;
      }
    }

    if (message?.type === "POSTUREFLOW_TRAPEZOID_MODE") {
      applyTrapezoidMode(message.active);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.standingTimer) return;
    const timer = changes.standingTimer.newValue;
    applyTrapezoidMode(!!timer?.active && !!timer.isBreakTime);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshTrapezoidMode();
  });
  window.addEventListener("pageshow", refreshTrapezoidMode);

  refreshTrapezoidMode();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "POSTUREFLOW_CAMERA_OBSERVER") return;
    if (event.data.active) {
      chrome.runtime.sendMessage({ type: "PAGE_CAMERA_STATE", active: true }).catch(() => {});
    }
  });

  window.addEventListener("resize", publish);
})();

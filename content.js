(() => {
  if (window.__postureFlowContentLoaded) return;
  window.__postureFlowContentLoaded = true;

  let overlay = null;
  let textEl = null; 
  let score = 0;
  let active = false;
  let effectsEnabled = true;
  let userMessage = "자세를 고치자"; 
  let isBreakTime = false; 
  let displayedIntensity = 0; // 비대칭 가속도를 위한 상태 변수
  let currentTiltAngle = 3;   // 기본 틸트 각도

  function ensureOverlay() {
    if (overlay?.isConnected) return overlay;
    
    overlay = document.createElement("canvas");
    overlay.id = "postureflow-overlay";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", width: "100vw", height: "100vh",
      zIndex: "2147483646", pointerEvents: "none", display: "none"
    });
    (document.documentElement || document.body).appendChild(overlay);
    
    textEl = document.createElement("div");
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
    (document.documentElement || document.body).appendChild(textEl);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("overlay.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
    
    return overlay;
  }

  function publish() {
    if (!overlay?.isConnected) return;
    
    const targetIntensity = (effectsEnabled && active && !isBreakTime) ? score : 0;
    
    // 비대칭 가속도 적용: 틀어질 때는 완만하게, 자세를 펴서 좋아질 때는 즉각적으로 빠르게 해제
    if (targetIntensity > displayedIntensity) {
      displayedIntensity = displayedIntensity * 0.8 + targetIntensity * 0.2;
    } else {
      displayedIntensity = displayedIntensity * 0.3 + targetIntensity * 0.7;
    }

    const MAX_BLUR_PX = 6;
    const currentBlur = displayedIntensity * MAX_BLUR_PX;

    overlay.style.backdropFilter = `blur(${currentBlur.toFixed(2)}px)`;
    overlay.style.webkitBackdropFilter = overlay.style.backdropFilter;

    if (textEl) {
      if (active && effectsEnabled && !isBreakTime && displayedIntensity > 0.02) {
        textEl.style.display = "block";
        textEl.style.opacity = displayedIntensity; 
      } else {
        textEl.style.opacity = "0";
        setTimeout(() => {
          if (Number(textEl.style.opacity) === 0) textEl.style.display = "none";
        }, 200);
      }
    }

    window.postMessage({
      source: "POSTUREFLOW_CONTENT",
      type: "RENDER",
      score: displayedIntensity,
      active: active && effectsEnabled && !isBreakTime
    }, "*");
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "POSTUREFLOW_SCORE") {
      active = !!message.active;
      score = Number(message.score) || 0; 
      ensureOverlay().style.display = (active && effectsEnabled && !isBreakTime) ? "block" : "none";
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
        const root = document.documentElement;
        root.style.transition = "transform 0.5s ease";
        root.style.transform = `perspective(1200px) rotateX(${currentTiltAngle}deg) scale(0.95)`;
      }
    }

    if (message?.type === "POSTUREFLOW_TRAPEZOID_MODE") {
      isBreakTime = message.active; 
      const root = document.documentElement;

      root.style.transition = "transform 6s cubic-bezier(0.25, 1, 0.5, 1)";
      root.style.transformOrigin = "bottom center";
      root.style.transformStyle = "preserve-3d";
      root.style.willChange = "transform";

      if (isBreakTime) {
        // 스토리지에 저장된 각도가 있다면 불러와서 적용, 없으면 기본값 사용
        chrome.storage.sync.get(["tiltIntensity"], (data) => {
          const angle = data.tiltIntensity || currentTiltAngle;
          root.style.transform = `perspective(1200px) rotateX(${angle}deg) scale(0.95)`;
        });
        root.style.pointerEvents = ""; 

        if (overlay) overlay.style.display = "none";
        if (textEl) textEl.style.opacity = "0";
      } else {
        root.style.transform = "perspective(1200px) rotateX(0deg) scale(1)";
        root.style.pointerEvents = "";
      }
    }
  });

  // 스크립트 로드 즉시 현재 휴식 상태인지 체크하여 새로 연 탭에도 즉시 틸트 적용
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_CHECK_STATUS" }, (response) => {
    if (response && response.isBreakTime) {
      isBreakTime = true;
      const root = document.documentElement;
      root.style.transition = "none";
      root.style.transformOrigin = "bottom center";
      root.style.transformStyle = "preserve-3d";
      
      chrome.storage.sync.get(["tiltIntensity"], (data) => {
        const angle = data.tiltIntensity || 5;
        root.style.transform = `perspective(1200px) rotateX(${angle}deg) scale(0.95)`;
      });

      if (overlay) overlay.style.display = "none";
      if (textEl) textEl.style.opacity = "0";
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "POSTUREFLOW_CAMERA_OBSERVER") return;
    if (event.data.active) {
      chrome.runtime.sendMessage({ type: "PAGE_CAMERA_STATE", active: true }).catch(() => {});
    }
  });

  window.addEventListener("resize", publish);
})();
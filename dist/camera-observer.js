// MAIN world: observe camera streams created by this page. Best-effort only.
(() => {
  if (window.__postureFlowCameraObserver) return;
  window.__postureFlowCameraObserver = true;
  const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!original) return;

  const announce = (active) => window.postMessage({
    source: "POSTUREFLOW_CAMERA_OBSERVER", active
  }, "*");

  try {
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const usesVideo = !!constraints?.video;
      if (usesVideo) announce(true);
      let stream;
      try {
        stream = await original(constraints);
      } catch (error) {
        if (usesVideo) announce(false);
        throw error;
      }
      if (usesVideo) {
        const videoTracks = stream.getVideoTracks();
        if (videoTracks.some(track => track.readyState === "live")) announce(true);
        for (const track of videoTracks) {
          track.addEventListener("ended", () => {
            // A false signal is informational; the panel does not auto-resume.
            if (videoTracks.every(t => t.readyState !== "live")) announce(false);
          }, { once: true });
        }
      }
      return stream;
    };
  } catch {
    // Some pages freeze or replace mediaDevices methods.
  }
})();

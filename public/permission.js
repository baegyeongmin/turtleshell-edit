// Side panels can't show the camera prompt; this popup can. The grant is per extension origin.
const msg = document.getElementById("msg");
navigator.mediaDevices.getUserMedia({ video: true }).then(async (stream) => {
  stream.getTracks().forEach((t) => t.stop());
  await chrome.runtime.sendMessage({ type: "CAMERA_GRANTED" }).catch(() => {});
  const win = await chrome.windows.getCurrent();
  chrome.windows.remove(win.id);
}).catch(async (e) => {
  const { state } = await navigator.permissions.query({ name: "camera" }).catch(() => ({ state: "?" }));
  const settingsUrl = `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;
  msg.innerHTML = state === "denied"
    ? `크롬에서 이 확장 프로그램의 카메라가 <b>차단</b>돼 있습니다.<br>
       <button id="open">설정 열기</button> → 카메라를 '허용'으로 바꾼 뒤 사이드패널에서 다시 시작하세요.<br>
       <small>버튼이 안 되면 주소창에 붙여넣기: <code>${settingsUrl}</code></small>`
    : `카메라를 열지 못했습니다. Windows 설정 &gt; 개인 정보 보호 및 보안 &gt; 카메라에서
       '데스크톱 앱이 카메라에 액세스하도록 허용'을 켜고, 다른 앱이 카메라를 쓰고 있지 않은지 확인하세요.`;
  msg.insertAdjacentHTML("beforeend", `<p><small>[${e.name}: ${e.message} / 권한 상태: ${state}]</small></p>`);
  document.getElementById("open")?.addEventListener("click", () => chrome.tabs.create({ url: settingsUrl }));
});

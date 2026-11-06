// Tests only: a content script in the tests' copy of the extension that tries the sidebar's port
// when its page posts "kai-sidebar-probe", and writes what it got into the page's
// <html data-kai-sidebar-probe> once the port is closed.
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data !== "kai-sidebar-probe") return;
  const result = { messages: [], disconnected: false, postError: null };
  const p = browser.runtime.connect({ name: "kai-sidebar" });
  p.onMessage.addListener((m) => result.messages.push(m));
  p.onDisconnect.addListener(() => {
    result.disconnected = true;
    document.documentElement.dataset.kaiSidebarProbe = JSON.stringify(result);
  });
  try {
    p.postMessage({ t: "req", id: 1, method: "GET", path: "/v1/models" });
  } catch (err) {
    result.postError = String(err);
  }
});

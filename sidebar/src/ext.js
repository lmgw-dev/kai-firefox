// The extension's APIs the sidebar page needs, for its wasm (src/ext.rs). wasm-bindgen emits this
// module as a file under snippets/, so the page stays under `script-src 'self'` (design §8.2 item
// 5). Messages cross as JSON text: the wasm reads and writes serde_json.

// The background's port (`name`); `onMessage(text)` for each message, `onDisconnect(why)` once.
export function connect(name, onMessage, onDisconnect) {
  const port = browser.runtime.connect({ name });
  port.onMessage.addListener((m) => onMessage(JSON.stringify(m)));
  port.onDisconnect.addListener((p) => onDisconnect(String(p?.error?.message ?? browser.runtime.lastError?.message ?? "")));
  return port;
}

// Posts `text` (JSON) on `port`; false when the port is gone.
export function post(port, text) {
  try {
    port.postMessage(JSON.parse(text));
    return true;
  } catch {
    return false;
  }
}

// The sidebar window's active tab ({id, url, title, status, window}), now and at every change
// (another tab activated, its URL, title or loading state changed), as JSON text to `onTab`.
export function watchTab(onTab) {
  let windowId = null;
  let tabId = null;
  const say = (t) => {
    if (!t) return;
    tabId = t.id;
    onTab(JSON.stringify({ id: t.id, url: t.url ?? "", title: t.title ?? "", status: t.status ?? "", window: t.windowId }));
  };
  const now = () =>
    browser.tabs
      .query({ active: true, windowId })
      .then((ts) => say(ts[0]))
      .catch(() => {});
  browser.windows.getCurrent().then((w) => {
    windowId = w.id;
    now();
  });
  browser.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) browser.tabs.get(info.tabId).then(say, () => {});
  });
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (id === tabId && ("url" in change || "title" in change || "status" in change)) say(tab);
  });
  browser.tabs.onRemoved.addListener((id) => {
    if (id === tabId) now();
  });
  browser.windows.onFocusChanged.addListener(() => now());
}

// Hands the Chat a text file as if it had been dropped on its conversation: lmgw-chat-ui has no
// seam for a host's composer action yet, and its drop path is the attachment path a user's file
// takes (an upload to the open thread, a chip in the composer). "" when the Chat took it, else
// why not: its drop handler cancels a drop it takes, so dispatchEvent answering true means
// nothing took this one.
export function dropFile(name, type, text) {
  const target = document.querySelector(".chat-main");
  if (!target) return "the Chat shows no conversation to attach to";
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type }));
  const untaken = target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  return untaken ? "the Chat did not take the file: nothing on its conversation handled the drop" : "";
}

// The extension's options page (the link's status).
export function openOptions() {
  browser.runtime.openOptionsPage().catch(() => {});
}

// A web page in a new tab beside the sidebar's window's active one (a link the Chat shows).
export function openTab(url) {
  browser.tabs.create({ url, active: true }).catch(() => {});
}

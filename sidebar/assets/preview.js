// The sidebar's preview page (preview.html): the Chat posts {type: "lmgw-preview", code, lang}
// once the page loaded, and again when the open preview's code changes (lmgw's chat-plane design
// §8.5, D25). Only the page that framed this one may hand it code (`ev.source === parent`): the
// previewed page, which this page frames itself, may post to it too, and is ignored. The code is
// shown in a srcdoc frame with the dashboard's sandbox flags; under this page's policy its inline
// scripts run, remote ones do not.
window.addEventListener("message", (ev) => {
  if (ev.source !== window.parent || window.parent === window) return;
  const m = ev.data;
  if (!m || m.type !== "lmgw-preview" || typeof m.code !== "string") return;
  let frame = document.querySelector("iframe");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock");
    document.body.appendChild(frame);
  }
  frame.srcdoc = m.code;
  document.body.dataset.lang = m.lang || "";
  document.body.dataset.received = String(Number(document.body.dataset.received || 0) + 1);
});

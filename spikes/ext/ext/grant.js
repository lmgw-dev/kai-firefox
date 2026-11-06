// The options-page button of design §5.8: permissions.request for userScripts on a click.
window.__grant = [];
document.getElementById("grant").addEventListener("click", (ev) => {
  const entry = { t: Date.now(), isTrusted: ev.isTrusted, userActivation: navigator.userActivation?.isActive };
  window.__grant.push(entry);
  browser.permissions.request({ permissions: ["userScripts"] }).then(
    (ok) => { entry.result = ok; entry.done = Date.now(); },
    (e) => { entry.error = String(e.message || e); entry.done = Date.now(); },
  );
});

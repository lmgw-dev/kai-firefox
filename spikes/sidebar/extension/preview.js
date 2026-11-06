// An extension page loaded in an iframe of the sidebar: it gets the model's HTML by postMessage and
// renders it in a nested srcdoc frame, which inherits this page's CSP. preview.html is listed in the
// manifest's `sandbox.pages` (and so gets `content_security_policy.sandbox`); plain.html is the same
// script on a page that is not. The variant name comes from the URL fragment (#v2, #v2b, #v3).
// External file: this page needs no inline script itself.
const id = location.hash.slice(1);
const report = (o) => parent.postMessage(o, "*");
let evalWorks = false;
try { evalWorks = (0, eval)("1+1") === 2; } catch (e) { evalWorks = false; }
let inlineWorks = false;
try {
  window.__inline = false;
  const sc = document.createElement("script");
  sc.textContent = "window.__inline = true";
  document.head.appendChild(sc);
  inlineWorks = window.__inline === true;
} catch (e) { inlineWorks = false; }
let parentAccess = false;
try { parentAccess = typeof parent.document.title === "string"; } catch (e) { parentAccess = false; }
report({
  kind: id + "-page", origin: String(location.origin), windowOrigin: String(window.origin), evalWorks, inlineWorks, parentAccess,
  hasBrowserApi: typeof browser !== "undefined" || typeof chrome !== "undefined",
  sandboxed: (() => { try { return document.cookie === undefined ? "?" : "cookie readable"; } catch (e) { return "cookie: " + e.name; } })(),
});
addEventListener("message", (ev) => {
  if (ev.source !== parent) {
    // The nested frame's own report: pass it up.
    if (ev.data && ev.data.kind) report(ev.data);
    return;
  }
  if (!ev.data || typeof ev.data.html !== "string") return;
  const f = document.createElement("iframe");
  f.id = "nested";
  f.setAttribute("sandbox", "allow-scripts");
  f.style.cssText = "border:0;width:100%;height:100vh;display:block";
  f.srcdoc = ev.data.html;
  document.body.appendChild(f);
});

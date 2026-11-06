// Measurement hooks. A classic script, first in <head>: the page allows only 'self' scripts, so
// this is a file and not an inline block. It logs CSP violations, marks the stages of the load
// (the Leptos app's first DOM, its first painted frame) and collects postMessage reports from
// the preview frames. The harness reads window.__probe over WebDriver BiDi.
(function () {
  const p = (window.__probe = { csp: [], messages: [], marks: {}, errors: [] });
  const t = () => Math.round(performance.now() * 10) / 10;
  document.addEventListener("securitypolicyviolation", (e) => {
    p.csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile || "", line: e.lineNumber || 0, sample: (e.sample || "").slice(0, 60), at: t() });
  });
  window.addEventListener("error", (e) => p.errors.push(String(e.message)));
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.kind) p.messages.push({ ...d, at: t() });
  });
  p.marks.probe = t();
  window.addEventListener("TrunkApplicationStarted", () => {
    p.marks.wasmStarted = t();
    performance.mark("kai:wasm-started");
  });
  const mo = new MutationObserver(() => {
    if (document.querySelector(".thread")) {
      mo.disconnect();
      p.marks.firstDom = t();
      performance.mark("kai:first-dom");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        p.marks.firstFrame = t();
        performance.mark("kai:first-frame");
      }));
    }
  });
  mo.observe(document, { childList: true, subtree: true });
  // A negative control the harness calls once, after it has read the violations of a normal load:
  // an inline script and eval() must both be refused by the page's CSP.
  const control = function () {
    const r = { inline: "ran" };
    window.__inlineRan = false;
    const s = document.createElement("script");
    s.textContent = "window.__inlineRan = true";
    document.head.appendChild(s);
    r.inline = window.__inlineRan ? "ran" : "blocked";
    const tries = {
      eval: () => (0, eval)("1"),
      newFunction: () => new Function("return 1")(),
      wasm: () => typeof WebAssembly.compile,
    };
    for (const [k, f] of Object.entries(tries)) {
      try { r[k] = "ran:" + String(f()); } catch (e) { r[k] = "blocked:" + e.name + ": " + String(e.message).slice(0, 80); }
    }
    return r;
  };
  // The control runs from a timer, not inside the harness's evaluate call: eval() reached from
  // WebDriver's evaluate frame was not refused in a first run, page-originated eval was.
  p.runControl = function () {
    setTimeout(() => { p.controlResult = control(); }, 0);
    return true;
  };
  // Everything a measurement needs, as one JSON string.
  p.snapshot = function () {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    const res = performance.getEntriesByType("resource").map((e) => ({
      name: e.name.replace(/^.*\//, ""), start: Math.round(e.startTime * 10) / 10,
      end: Math.round(e.responseEnd * 10) / 10, size: e.decodedBodySize,
    }));
    const paint = {};
    for (const e of performance.getEntriesByType("paint")) paint[e.name] = Math.round(e.startTime * 10) / 10;
    return JSON.stringify({
      marks: p.marks, csp: p.csp, errors: p.errors, messages: p.messages, paint, resources: res,
      nav: { responseEnd: nav.responseEnd, domInteractive: nav.domInteractive, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd },
      origin: location.origin, href: location.href,
    });
  };
})();

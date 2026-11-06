#!/usr/bin/env node
// WP0 (c) measurements. Loads dist/ as a temporary add-on in headless Firefox over WebDriver BiDi and
// measures the sidebar in two places:
//   sidebar  the real sidebar panel (chrome: SidebarController.show), driven through a frame script
//            (BiDi has no handle on the panel's <browser>); cold load first, then reloads
//   tab      the same page in a tab, which BiDi can drive, and whose child frames it can inspect
// For each: CSP violations of a normal load and a negative control (inline script, eval), the load
// stages (probe.js marks), the kit styles, the preview frames. Screenshots come from the sidebar.
// BiDi will not navigate a content tab to a moz-extension: URL, so the tab is opened from the chrome
// window (MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 gives BiDi that scope), as an earlier end-to-end script did.
//
//   node harness/run.mjs [--dist dist] [--runs 5] [--out run-results.json] [--no-shots]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchFirefox } from "./bidi.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_ID = "kai-firefox-spike-sidebar@rootshell.dev";
const SIDEBAR_ID = "kai-firefox-spike-sidebar_rootshell_dev-sidebar-action";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const dist = resolve(ROOT, arg("--dist", "dist"));
const runs = Number(arg("--runs", "5"));
const outFile = resolve(ROOT, arg("--out", "run-results.json"));
const noShots = argv.includes("--no-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

let phase = "load";
const logEntries = [];
const ff = await launchFirefox({
  root: join(ROOT, "target", "ff"),
  width: 1280,
  height: 900,
  prefs: { "devtools.console.stdout.content": true },
});
ff.on("log.entryAdded", (e) => logEntries.push({ phase, level: e.level, text: String(e.text).slice(0, 400) }));
let exitCode = 0;
const result = { firefox: null, dist: relative(resolve(ROOT, "..", ".."), dist), targets: {} };
let checks = [];
const check = (ok, what, extra) => {
  checks.push({ ok, what, ...(extra === undefined ? {} : { extra }) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${extra === undefined ? "" : "  " + JSON.stringify(extra)}`);
  if (!ok) exitCode = 1;
};

const chrome = (await ff.send("browsingContext.getTree", { "moz:scope": "chrome" })).contexts[0].context;
async function chromeEval(expr) {
  const r = await ff.send("script.evaluate", { expression: expr, target: { context: chrome }, awaitPromise: true });
  if (r.type !== "success") throw new Error("chrome evaluate failed: " + JSON.stringify(r.exceptionDetails || r).slice(0, 600));
  return r.result.value;
}
async function bidiEval(context, expression) {
  const r = await ff.send("script.evaluate", { expression: "JSON.stringify((" + expression + "))", target: { context }, awaitPromise: true });
  if (r.type !== "success") throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails || r).slice(0, 600));
  const v = r.result && r.result.value;
  return v == null ? undefined : JSON.parse(v);
}
async function pngFromBrowser(browserExpr, scale, file) {
  const data = await chromeEval(`(async () => {
    const b = ${browserExpr};
    const r = b.getBoundingClientRect();
    const bmp = await b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, r.width, r.height), ${scale}, "rgb(255,0,255)");
    const c = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    return c.toDataURL("image/png").slice(22);
  })()`);
  const buf = Buffer.from(data, "base64");
  await writeFile(file, buf);
  return buf.length;
}

const result0 = {};
try {
  result.firefox = await chromeEval("Services.appinfo.version + ' ' + Services.appinfo.appBuildID");
  console.log("Firefox", result.firefox);

  // Frame-script bridge for the sidebar panel: evaluates an expression in the page's own compartment
  // (not subject to its CSP, like BiDi's evaluate) and returns JSON.
  await chromeEval(`(() => {
    globalThis.__h = { n: 0 };
    globalThis.panelBrowser = () => SidebarController.browser.contentDocument.getElementById("webext-panels-browser");
    globalThis.evalIn = (browser, expr) => new Promise((resolve) => {
      const id = ++__h.n;
      const mm = browser.messageManager;
      const listener = (msg) => { if (msg.data.id === id) { mm.removeMessageListener("kai:reply", listener); resolve(msg.data.value); } };
      mm.addMessageListener("kai:reply", listener);
      const code = "(function(){ let value; try { const sb = new Cu.Sandbox(content, { sandboxPrototype: content, wantXrays: false }); value = Cu.evalInSandbox('JSON.stringify(' + " + "EXPR" + " + ')', sb); } catch (e) { value = JSON.stringify({ __error: String(e) }); } sendAsyncMessage('kai:reply', { id: " + "ID" + ", value }); })()";
      mm.loadFrameScript("data:application/javascript," + encodeURIComponent(code.replace("EXPR", JSON.stringify(expr)).replace("ID", id)), false);
    });
    return 1;
  })()`);

  const t0 = Date.now();
  const inst = await ff.send("webExtension.install", { extensionData: { type: "path", path: dist } });
  result.installMs = Date.now() - t0;
  console.log("install");
  check(inst.extension === EXT_ID, "installed as a temporary add-on with the gecko id", { id: inst.extension, ms: result.installMs });
  result.manifest = JSON.parse(await chromeEval(`(() => { const p = WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)}); const m = p.extension.manifest; return JSON.stringify({ mv: p.manifestVersion, csp: m.content_security_policy, panel: m.sidebar_action && m.sidebar_action.default_panel, sandboxPages: m.sandbox && m.sandbox.pages, warnings: p.extension.warnings }); })()`));
  check(result.manifest.mv === 3, "manifest_version 3 accepted");
  check(result.manifest.warnings.length === 0, "no manifest warnings", result.manifest.warnings);
  // The packaged pages carry no inline script, no event-handler attribute and no javascript: URL.
  const htmlFiles = (await readdir(dist)).filter((f) => f.endsWith(".html"));
  const inlineFound = [];
  for (const f of htmlFiles) {
    const html = await readFile(join(dist, f), "utf8");
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) inlineFound.push(f + ": inline <script>");
    if (/\son[a-z]+\s*=/i.test(html)) inlineFound.push(f + ": event-handler attribute");
    if (/javascript:/i.test(html)) inlineFound.push(f + ": javascript: URL");
  }
  check(inlineFound.length === 0, `no inline script in the packaged pages (${htmlFiles.join(", ")})`, inlineFound);
  const pageUrl = await chromeEval(`WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)}).getURL("index.html")`);

  // ---- the two targets ----
  const targets = {
    sidebar: {
      async open() {
        // The panel document may not have defined loadPanel yet right after the install: retry.
        for (let i = 0; ; i++) {
          try {
            await chromeEval(`SidebarController.show(${JSON.stringify(SIDEBAR_ID)}).then(() => "ok")`);
            break;
          } catch (e) {
            if (i >= 40) throw e;
            await sleep(250);
          }
        }
        for (let i = 0; i < 150; i++) {
          await sleep(100);
          const u = await chromeEval(`(() => { try { return panelBrowser().currentURI.spec; } catch (e) { return ""; } })()`);
          if (u.startsWith("moz-extension://")) return;
        }
        throw new Error("the sidebar panel did not load the page");
      },
      async eval(expr) {
        const v = JSON.parse(await chromeEval(`evalIn(panelBrowser(), ${JSON.stringify(expr)})`));
        if (v && v.__error) throw new Error(v.__error);
        return v;
      },
      reload: () => chromeEval(`(panelBrowser().reload(), "ok")`),
      async setWidth(px) {
        await chromeEval(`(() => { const sb = document.getElementById("sidebar-box"); sb.style.width = "${px + 2}px"; sb.style.minWidth = "${px + 2}px"; sb.style.maxWidth = "${px + 2}px"; return 1; })()`);
        await sleep(500);
      },
      shot: (file, scale) => (noShots ? 0 : pngFromBrowser("panelBrowser()", scale, file)),
    },
    tab: {
      ctx: null,
      async open() {
        await chromeEval(`(gBrowser.selectedTab = gBrowser.addTab(${JSON.stringify(pageUrl)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }), "ok")`);
        for (let i = 0; i < 150 && !this.ctx; i++) {
          await sleep(100);
          const c = (await ff.send("browsingContext.getTree", {})).contexts.find((x) => x.url === pageUrl);
          if (c) this.ctx = c.context;
        }
        if (!this.ctx) throw new Error("the page did not open in a tab");
      },
      eval(expr) {
        return bidiEval(this.ctx, expr);
      },
      reload() {
        return ff.send("browsingContext.reload", { context: this.ctx, wait: "complete" });
      },
      // BiDi's setViewport refuses a moz-extension: tab ("privileged scope"): size the <browser> from chrome.
      async setWidth(px) {
        await chromeEval(`(() => { const b = gBrowser.selectedBrowser; b.style.width = "${px}px"; b.style.maxWidth = "${px}px"; b.style.flex = "none"; b.style.height = "720px"; b.style.maxHeight = "720px"; return 1; })()`);
        await sleep(400);
      },
      shot: (file, scale) => (noShots ? 0 : pngFromBrowser("gBrowser.selectedBrowser", scale, file)),
    },
  };

  async function waitFor(t, expression, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await t.eval(expression)) return true;
      } catch {
        /* page not ready */
      }
      await sleep(40);
    }
    return false;
  }

  async function measure(name) {
    checks = [];
    const t = targets[name];
    console.log(`\n== ${name} ==`);
    phase = name + ":load";
    await t.open();
    if (name === "sidebar") {
      await waitFor(t, "window.__probe && window.__probe.marks.firstFrame !== undefined");
      result.targets[name] = { defaultInnerWidth: await t.eval("innerWidth") };
    } else result.targets[name] = {};
    const R = result.targets[name];
    await t.setWidth(320);

    const stage = async () => {
      if (!(await waitFor(t, "window.__probe && window.__probe.marks.firstFrame !== undefined", 20000))) throw new Error("the app never reached its first frame");
      return JSON.parse(await t.eval("window.__probe.snapshot()"));
    };
    const loads = [];
    loads.push({ kind: "cold", ...(await stage()) });
    for (let i = 0; i < runs; i++) {
      await t.eval("(window.__marker = 1, true)");
      await t.reload();
      if (!(await waitFor(t, "window.__marker === undefined && window.__probe", 20000))) throw new Error("reload did not complete");
      loads.push({ kind: "reload", ...(await stage()) });
    }
    const row = (l) => ({ kind: l.kind, wasmStarted: l.marks.wasmStarted, firstDom: l.marks.firstDom, firstFrame: l.marks.firstFrame, fcp: l.paint["first-contentful-paint"], loadEvent: l.nav.load });
    R.loads = loads.map(row);
    console.log("  load stages, ms since navigation start:");
    console.table(R.loads);
    const re = R.loads.filter((l) => l.kind === "reload");
    R.summary = {
      cold: R.loads[0],
      reloadMedian: { wasmStarted: median(re.map((l) => l.wasmStarted)), firstDom: median(re.map((l) => l.firstDom)), firstFrame: median(re.map((l) => l.firstFrame)), fcp: median(re.map((l) => l.fcp)) },
    };
    const last = loads[loads.length - 1];
    R.resources = last.resources;

    // CSP: a normal load has no violation; the control proves the policy is enforced.
    check(last.csp.length === 0, "no CSP violation on a normal load (page's securitypolicyviolation events)", last.csp);
    check(last.errors.length === 0, "no script error on a normal load", last.errors);
    check(last.origin.startsWith("moz-extension://"), "page origin is the extension's");
    check(logEntries.filter((e) => e.phase === name + ":load" && /Content-Security-Policy|CSP/i.test(e.text)).length === 0, "no CSP message in Firefox's console during the loads (log.entryAdded)");
    phase = name + ":control";
    await t.eval("window.__probe.runControl()");
    await waitFor(t, "!!window.__probe.controlResult", 5000);
    R.control = await t.eval("window.__probe.controlResult");
    check(R.control.inline === "blocked" && /blocked/.test(R.control.eval) && /blocked/.test(R.control.newFunction), "negative control: an inline script, eval() and new Function() are refused", R.control);
    check(R.control.wasm.startsWith("ran"), "WebAssembly is available ('wasm-unsafe-eval')");
    R.controlViolations = JSON.parse(await t.eval("window.__probe.snapshot()")).csp.map((v) => v.directive + ":" + v.blocked);

    // The app: kit styles applied, markdown rendered, the kit widgets present.
    R.dom = await t.eval(`({
      threads: document.querySelectorAll('.thread').length,
      messages: document.querySelectorAll('.msg-user, .msg-assistant').length,
      table: !!document.querySelector('.msg-assistant table'),
      codeBlock: !!document.querySelector('.msg-assistant pre code'),
      rawScriptAsText: document.querySelector('.msg-assistant').textContent.includes('<script>alert(1)</script>'),
      scriptElementsInMessage: document.querySelectorAll('.msg-assistant script').length,
      section: !!document.querySelector('section.sec .sec-head'),
      dialog: !!document.querySelector('dialog.modal'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      width: innerWidth, height: innerHeight,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    })`);
    const d = R.dom;
    check(d.threads === 5 && d.messages === 4 && d.table && d.codeBlock, "thread list and four messages rendered, markdown with table and code block", d);
    check(d.rawScriptAsText && d.scriptElementsInMessage === 0, "raw HTML in a message is text, not an element");
    check(d.section && d.dialog, "kit Section and Modal are in the DOM");
    check(d.bodyBg === "rgb(22, 25, 28)" && d.accent === "#3DAEE9", "kit.css tokens applied (--bg0, --accent)", { bg: d.bodyBg, accent: d.accent });
    check(d.width === 320 && !d.overflowX, "320 px wide, no horizontal overflow", { width: d.width });

    // Preview: open the kit Modal, which mounts the five frames.
    phase = name + ":preview";
    if (name === "sidebar") {
      R.shotBytes = {};
      R.shotBytes.shot = await t.shot(join(ROOT, "shot.png"), 2);
      await t.setWidth(280);
      R.dom280 = await t.eval("({ width: innerWidth, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth })");
      R.shotBytes.shot280 = await t.shot(join(ROOT, "shot-280.png"), 2);
      await t.setWidth(320);
      check(!R.dom280.overflowX, "280 px wide: no horizontal overflow", R.dom280);
    }
    await t.eval("(document.getElementById('open-preview').click(), true)");
    check(await waitFor(t, "!!document.querySelector('dialog.modal[open]')", 5000), "kit Modal opens (<dialog> showModal) in the extension page");
    await waitFor(t, "window.__probe.messages.filter(m => /-nested$/.test(m.kind)).length >= 3", 8000);
    await sleep(800);
    const msgs = await t.eval("window.__probe.messages");
    R.frameMessages = msgs;
    const byKind = Object.fromEntries(msgs.map((m) => [m.kind, m]));
    check(!byKind["v1"], "V1 srcdoc frame in the sidebar page: its inline <script> is refused (the frame inherits the page's CSP)");
    for (const id of ["v2", "v2b"]) {
      const page = byKind[id + "-page"];
      check(!!page && page.windowOrigin === "null" && !page.parentAccess && !page.hasBrowserApi, `${id}: the page in sandbox.pages runs with an opaque origin, no access to the sidebar and no browser API`, page);
      check(!!byKind[id + "-nested"] && byKind[id + "-nested"].scriptRan, `${id}: the HTML in its nested srcdoc frame ran its inline <script>`, byKind[id + "-nested"]);
    }
    // The manifest's sandbox CSP ('unsafe-inline', no 'unsafe-eval') applies to V2, whose iframe has no
    // sandbox attribute; with the attribute (V2b) the page ran with no CSP at all (eval worked).
    check(byKind["v2-page"].inlineWorks === true && byKind["v2-page"].evalWorks === false, "v2: the manifest's sandbox CSP is the page's policy (inline allowed, eval refused)", { inline: byKind["v2-page"].inlineWorks, eval: byKind["v2-page"].evalWorks });
    check(byKind["v2b-page"].evalWorks === true, "v2b (observed, Firefox 159): with the iframe's sandbox attribute the page's CSP is not applied (eval runs although the sandbox CSP refuses it)", { eval: byKind["v2b-page"].evalWorks });
    const v3b = byKind["v3b-page"];
    check(!!v3b && v3b.windowOrigin === "null" && !v3b.hasBrowserApi && v3b.inlineWorks && v3b.evalWorks && !!byKind["v3b-nested"], "v3b (observed, Firefox 159): an ordinary extension page (not in sandbox.pages) in an iframe with the sandbox attribute is opaque, has no browser API and no CSP", v3b);
    const v3 = byKind["v3-page"];
    check(!!v3 && v3.windowOrigin.startsWith("moz-extension://") && v3.parentAccess && v3.hasBrowserApi && !v3.evalWorks, "v3 (control, not in sandbox.pages): an ordinary extension page: own origin, the sidebar within reach, browser API, eval refused", v3);
    check(!byKind["v3-nested"], "v3: the inline <script> of its nested srcdoc is refused");
    if (name === "sidebar") R.shotBytes.shotPreview = await t.shot(join(ROOT, "shot-preview.png"), 2);

    if (name === "tab") {
      // BiDi sees the child frames of a tab: read what they rendered.
      const walk = (n, depth = 0, out = []) => {
        out.push({ depth, context: n.context, url: n.url });
        for (const c of n.children || []) walk(c, depth + 1, out);
        return out;
      };
      const tree = (await ff.send("browsingContext.getTree", { root: t.ctx })).contexts;
      R.frames = [];
      for (const f of walk(tree[0]).filter((x) => x.depth > 0)) {
        let info;
        try {
          info = await bidiEval(f.context, `({ origin: location.origin, out: (document.getElementById('out') || {}).textContent, boxBg: document.getElementById('box') ? getComputedStyle(document.getElementById('box')).backgroundColor : null })`);
        } catch (e) {
          info = { error: String(e.message).slice(0, 160) };
        }
        R.frames.push({ depth: f.depth, url: f.url.replace(/moz-extension:\/\/[^/]+/, "moz-extension://UUID"), ...info });
      }
      console.log("  frames as BiDi sees them:");
      console.table(R.frames);
      const srcdocs = R.frames.filter((f) => f.url === "about:srcdoc");
      check(srcdocs.length === 5 && srcdocs.every((f) => f.boxBg === "rgb(200, 30, 30)"), "all five srcdoc frames render the HTML and its inline <style>", srcdocs.map((f) => f.out));
    }
    R.checks = checks;
    R.cspLog = logEntries.filter((e) => e.phase.startsWith(name) && /Content-Security-Policy|CSP/i.test(e.text)).map((e) => e.phase + ": " + e.text.slice(0, 160));
  }

  await measure("sidebar");
  await measure("tab");
} catch (e) {
  console.error("harness error:", e.stack || e);
  exitCode = 1;
} finally {
  await ff.close();
}
await writeFile(outFile, JSON.stringify(result, null, 2) + "\n");
console.log(exitCode === 0 ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(exitCode);

// The sidebar relay's test rig (tests/e2e/sidebar.test.mjs): a copy of the extension under
// target/ with the relay's test page as its sidebar (sidebar/sidebar.html, which the shipped
// extension does not have until WP8b) and a probe content script, and the real sidebar panel
// opened and read in headless Firefox through a frame-script bridge (BiDi cannot reach the panel;
// WP0 (c)'s spikes/sidebar/harness/run.mjs).
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, EXT_DIR, EXT_ID } from "./env.mjs";
import { sleep } from "./util.mjs";

const COPY = join(ROOT, "target", "ext-sidebar");
const PAGES = join(ROOT, "tests", "sidebar-relay");
// Firefox's id for an extension's sidebar: its id with every character but [a-z0-9_-] as _.
export const SIDEBAR_ID = `${EXT_ID.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-sidebar-action`;

// The extension's copy with the test page as its sidebar and the probe as a content script; its
// folder.
export async function sidebarExtension() {
  await rm(COPY, { recursive: true, force: true });
  await mkdir(join(COPY, "sidebar"), { recursive: true });
  await cp(EXT_DIR, COPY, { recursive: true });
  for (const f of ["sidebar.html", "relay-test.js"]) await cp(join(PAGES, f), join(COPY, "sidebar", f));
  await mkdir(join(COPY, "test"), { recursive: true });
  await cp(join(PAGES, "probe.js"), join(COPY, "test", "probe.js"));
  const manifest = JSON.parse(await readFile(join(EXT_DIR, "manifest.json"), "utf8"));
  manifest.sidebar_action = { default_panel: "sidebar/sidebar.html", default_title: "Kai (relay test)" };
  manifest.content_scripts.push({ matches: ["<all_urls>"], js: ["test/probe.js"], run_at: "document_start" });
  await writeFile(join(COPY, "manifest.json"), JSON.stringify(manifest, null, 2));
  return COPY;
}

// Installs the bridge in the chrome window: evalIn(browser, expr) evaluates `expr` in the page of
// a <browser> (in its own compartment, which its CSP does not govern) and answers its JSON.
async function bridge(ff) {
  await ff.chromeEval(`(() => {
    if (globalThis.__kaiPanel) return 1;
    globalThis.__kaiPanel = { n: 0 };
    globalThis.kaiPanelBrowser = () => SidebarController.browser.contentDocument.getElementById("webext-panels-browser");
    globalThis.kaiPanelChrome = (browser, expr) => new Promise((resolve) => {
      const id = ++__kaiPanel.n;
      const mm = browser.messageManager;
      const timer = setTimeout(() => { mm.removeMessageListener("kai:reply", listener); resolve(JSON.stringify({ __error: "the sidebar's page did not answer within 5 s" })); }, 5000);
      const listener = (msg) => { if (msg.data.id === id) { clearTimeout(timer); mm.removeMessageListener("kai:reply", listener); resolve(msg.data.value); } };
      mm.addMessageListener("kai:reply", listener);
      const code = "(function(){ let value; try { value = JSON.stringify((function(){ return (" + expr + "); })()); } catch (e) { value = JSON.stringify({ __error: String(e) }); } sendAsyncMessage('kai:reply', { id: " + id + ", value }); })()";
      mm.loadFrameScript("data:application/javascript," + encodeURIComponent(code), false);
    });
    globalThis.kaiPanelEval = (browser, expr) => new Promise((resolve) => {
      const id = ++__kaiPanel.n;
      const mm = browser.messageManager;
      // A panel that went (closed, reloading) never answers: said after 5 s instead of waiting.
      const timer = setTimeout(() => { mm.removeMessageListener("kai:reply", listener); resolve(JSON.stringify({ __error: "the sidebar's page did not answer within 5 s" })); }, 5000);
      const listener = (msg) => { if (msg.data.id === id) { clearTimeout(timer); mm.removeMessageListener("kai:reply", listener); resolve(msg.data.value); } };
      mm.addMessageListener("kai:reply", listener);
      // The id goes in before the expression, which may hold any text (WP0's bridge put it after,
      // and an expression with "ID" in it took the id's place).
      const code = "(function(){ let value; try { const sb = new Cu.Sandbox(content, { sandboxPrototype: content, wantXrays: false }); value = Cu.evalInSandbox('JSON.stringify(' + __KAI_EXPR__ + ')', sb); } catch (e) { value = JSON.stringify({ __error: String(e) }); } sendAsyncMessage('kai:reply', { id: __KAI_ID__, value }); })()"
        .replace("__KAI_ID__", () => String(id))
        .replace("__KAI_EXPR__", () => JSON.stringify(expr));
      mm.loadFrameScript("data:application/javascript," + encodeURIComponent(code), false);
    });
    return 1;
  })()`);
}

// Opens the real sidebar panel and waits until `ready` (an expression in its page) holds: by default
// the relay's test page's script.
export async function openSidebar(ff, { ready = `typeof relayTest === "object"`, what = "the test page" } = {}) {
  await bridge(ff);
  for (let i = 0; ; i++) {
    try {
      await ff.chromeEval(`SidebarController.show(${JSON.stringify(SIDEBAR_ID)}).then(() => "ok")`);
      break;
    } catch (e) {
      // The panel's document may not have defined its loader yet right after the install.
      if (i >= 40) throw e;
      await sleep(250);
    }
  }
  for (let i = 0; i < 150; i++) {
    const ok = await inSidebar(ff, ready).catch(() => false);
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`the sidebar panel did not load ${what}`);
}

// The panel's page now: its URL, and the id of its browsing context (null without one).
const panelNow = (ff) =>
  ff.chromeEval(`(() => {
    try {
      const b = kaiPanelBrowser();
      return { url: b?.currentURI?.spec ?? "", bc: b?.browsingContext?.id ?? null };
    } catch (e) {
      return { url: "", bc: null };
    }
  })()`);

// Closes the sidebar panel and waits until its page is gone (and with it its port), so the next
// openSidebar() cannot read the page that is going.
export async function closeSidebar(ff) {
  await ff.chromeEval(`(SidebarController.hide(), "ok")`);
  for (let i = 0; i < 100; i++) {
    if (!(await panelNow(ff)).url.startsWith("moz-extension://")) return;
    await sleep(50);
  }
  throw new Error("the sidebar's page did not go within 5 s of closing the sidebar");
}

// Evaluates a synchronous expression in the frame script's own scope, with chrome's rights over
// the sidebar's page (`content`): what the page itself cannot reach, such as the documents of its
// sandboxed preview frames. Its value (through JSON).
export async function inSidebarChrome(ff, expr) {
  const text = await ff.chromeEval(`kaiPanelChrome(kaiPanelBrowser(), ${JSON.stringify(expr)})`);
  const v = text === undefined ? undefined : JSON.parse(text);
  if (v && v.__error) throw new Error(v.__error);
  return v;
}

// An image of the sidebar panel as it is drawn (its <browser> in the chrome window), as PNG bytes.
export async function sidebarShot(ff) {
  const b64 = await ff.chromeEval(`(async () => {
    const b = kaiPanelBrowser();
    const r = b.getBoundingClientRect();
    const scale = window.devicePixelRatio;
    const bitmap = await b.browsingContext.currentWindowGlobal.drawSnapshot(null, scale, "rgb(255,255,255)");
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d").drawImage(bitmap, 0, 0);
    return c.toDataURL("image/png").split(",")[1];
  })()`);
  return Buffer.from(b64, "base64");
}

// Sets the sidebar's page to `px` CSS pixels wide: Firefox has no API for the width, so its box is
// sized from chrome, and again by what the page then measures (the box's border and splitter).
export async function sidebarWidth(ff, px) {
  let box = px;
  for (let i = 0; i < 4; i++) {
    await ff.chromeEval(`(() => {
      const box = document.getElementById("sidebar-box");
      for (const k of ["width", "minWidth", "maxWidth"]) box.style[k] = ${JSON.stringify(box + "px")};
      return "ok";
    })()`);
    await sleep(150);
    const inner = await inSidebar(ff, "innerWidth");
    if (inner === px) return;
    box += px - inner;
  }
}

// Evaluates a synchronous expression in the sidebar's page; its value (through JSON).
export async function inSidebar(ff, expr) {
  const text = await ff.chromeEval(`kaiPanelEval(kaiPanelBrowser(), ${JSON.stringify(expr)})`);
  const v = text === undefined ? undefined : JSON.parse(text);
  if (v && v.__error) throw new Error(v.__error);
  return v;
}

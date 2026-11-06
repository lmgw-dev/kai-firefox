#!/usr/bin/env node
// WP0 (f): element naming cost with dom-accessibility-api on a large page, frames included.
//
//   npm run build && node run-f.mjs [--controls 5000] [--repeat 3]
//
// Generates the test page (page/gen-page.mjs) into the run folder, serves it on 127.0.0.1 (the
// cross-origin frame comes from localhost, same server), opens it in headless Firefox at
// 1280x900 with the spike extension, whose content script (ext/naming.bundle.js) runs in every
// frame. The harness page then asks each frame (tabs.sendMessage with frameId, frames from
// webNavigation.getAllFrames) to walk all controls, and only those in view, and reports times,
// name mismatches against data-expect, getHTML with closed shadow roots, the iframes' rects and
// runtime.getFrameId from the parent, and the content processes' memory. Every walk runs with
// dom-accessibility-api's default and with computedStyleSupportsPseudoElements (::before content).
import { join } from "node:path";
import { makeRun, launchFirefox, prepareExt, sleep, EXT_ID, rssKb, pssKb } from "./lib/firefox.mjs";
import { serve } from "./page/server.mjs";
import { generate } from "./page/gen-page.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes("--" + n) ? argv[argv.indexOf("--" + n) + 1] : d);
const controls = Number(opt("controls", "5000"));
const repeat = Number(opt("repeat", "3"));
const keep = argv.includes("--keep");

const run = await makeRun("f");
const site = join(run.dir, "site");
const counts = await generate(site, controls);
const srv = await serve(site);
const url = `http://127.0.0.1:${srv.port}/index.html`;
const ext = await prepareExt(run, { connectNative: false });
const ff = await launchFirefox({ run, width: 1280, height: 900 });
const out = { generated: counts };
try {
  const inst = await ff.installExtension(ext);
  if (inst.extension !== EXT_ID) throw new Error(JSON.stringify(inst));
  // The content processes of the test tab (top document and the cross-origin frame).
  const procs = () => ff.chromeEval(`(() => {
    const bc = gBrowser.tabs[0].linkedBrowser.browsingContext;
    const walk = (b) => [{ url: b.currentWindowGlobal?.documentURI?.spec, pid: b.currentWindowGlobal?.osPid }, ...b.children.flatMap(walk)];
    return walk(bc);
  })()`);
  const mem = (pids) => Object.fromEntries([...new Set(pids)].map((p) => [p, { rss_mb: +(rssKb(p) / 1024).toFixed(1), pss_mb: +(pssKb(p) / 1024).toFixed(1) }]));

  const tl0 = Date.now();
  await ff.navigate(ff.context, url);
  out.load_ms = Date.now() - tl0;
  await sleep(1500);
  const p0 = await procs();
  out.processes = p0.map((p) => ({ url: p.url?.replace(/:\d+\//, ":PORT/"), pid: p.pid }));
  out.memory_before_walk = mem(p0.map((p) => p.pid));

  const page = await ff.openExtPage("harness.html");
  const tabId = await ff.evalIn(page, `browser.tabs.query({ url: "http://127.0.0.1/*" }).then((t) => t[0].id)`);
  const frames = await ff.evalIn(page, `browser.webNavigation.getAllFrames({ tabId: ${tabId} })`);
  out.getAllFrames = frames.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url.replace(/:\d+\//, ":PORT/"), documentId: f.documentId ?? "(no documentId)" }));

  const send = (frameId, msg) => ff.evalIn(page, `browser.tabs.sendMessage(${tabId}, ${JSON.stringify(msg)}, { frameId: ${frameId} }).then((r) => r, (e) => ({ error: e.message }))`);
  out.whoami = {};
  for (const f of frames) out.whoami[f.frameId] = await send(f.frameId, { op: "whoami" });

  // Each frame alone, all controls then in view, repeated (the first call is cold).
  out.walks = {};
  for (const f of frames) {
    const key = `${f.frameId} ${f.url.replace(/^.*\//, "")}`;
    out.walks[key] = { all: [], in_view: [], all_pseudo: [], in_view_pseudo: [] };
    for (let i = 0; i < repeat; i++) out.walks[key].all.push(await send(f.frameId, { op: "walk", onlyInView: false }));
    for (let i = 0; i < repeat; i++) out.walks[key].in_view.push(await send(f.frameId, { op: "walk", onlyInView: true }));
    for (let i = 0; i < repeat; i++) out.walks[key].all_pseudo.push(await send(f.frameId, { op: "walk", onlyInView: false, pseudo: true }));
    for (let i = 0; i < repeat; i++) out.walks[key].in_view_pseudo.push(await send(f.frameId, { op: "walk", onlyInView: true, pseudo: true }));
  }
  // All frames at once, as the background would merge them: wall time from the extension page.
  out.merged = {};
  for (const [onlyInView, pseudo] of [[false, false], [true, false], [false, true], [true, true]]) {
    out.merged[(onlyInView ? "in_view" : "all") + (pseudo ? "_pseudo" : "")] = await ff.evalIn(page, `(async () => {
      const t0 = performance.now();
      const frames = await browser.webNavigation.getAllFrames({ tabId: ${tabId} });
      const rs = await Promise.all(frames.map((f) => browser.tabs.sendMessage(${tabId}, { op: "walk", onlyInView: ${onlyInView}, pseudo: ${pseudo}, samples: 0 }, { frameId: f.frameId }).catch((e) => ({ error: e.message }))));
      return { wall_ms: +(performance.now() - t0).toFixed(1), frames: rs.length, described: rs.reduce((a, r) => a + (r.described || 0), 0), per_frame_ms: rs.map((r) => r.ms && r.ms.total) };
    })()`);
  }
  out.memory_after_walks = mem(p0.map((p) => p.pid));
  out.gethtml = await send(0, { op: "gethtml" });
  out.iframes_from_parent = await send(0, { op: "frames" });
  out.resolve_ref_1 = await send(0, { op: "resolve", id: 1 });
} finally {
  await ff.close({ keep });
  await srv.close();
}
console.log(JSON.stringify(out, null, 1));

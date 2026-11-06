// Screenshots (design §5.3): page.see's image of the view with its size and its scale to CSS
// pixels, measured from the image (also at 150 % zoom, at a device pixel ratio of 2 and while
// pinch-zoomed); the child frames' parts of the image, a nested one and one cut by the view;
// Kai's hint labels and ring hidden for the capture and back after it, also for captures at the
// same time; element.see cropped to an element, one below the fold scrolled into view, one in a
// cross-origin frame; a hidden element, a tab Firefox unloaded, and a page whose address changed;
// a frame that goes to another site during the capture, named by both.
import assert from "node:assert/strict";
import { call, fails, inPage, waitFor, sleep, siteOrigin } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const YELLOW = [255, 255, 0, 255];
const WHITE = [255, 255, 255, 255];
const MAGENTA = [255, 0, 255, 255];

const open = async (env) => {
  await call(env, "tabs.go@1", { url: env.site.url("see.html") });
  await inPage(env, "(scrollTo(0, 0), 1)");
  await waitFor(async () => (await call(env, "page.text_all@1")).frames.read === 3, { what: "the pane and its inner pane" });
};
// A frames tree without the frame ids, which differ from run to run (each checked to be one).
const tree = (frames) =>
  frames.map(({ frame, frames: kids, ...rest }) => {
    assert.ok(Number.isSafeInteger(frame) && frame > 0, `frame ${frame}`);
    return kids ? { ...rest, frames: tree(kids) } : rest;
  });
// see.html's frames: the cross-origin pane holding the inner pane, with their boxes.
const panes = (env, pane, inner) => [
  { origin: `http://localhost:${env.site.port}`, url: env.site.url("see-frame.html", "localhost"), box: pane, frames: [{ origin: `http://127.0.0.1:${env.site.port}`, url: env.site.url("see-inner.html"), box: inner }] },
];
// Two images of the same view are alike: their size, and their colours at the points.
const alike = async (env, a, b, points) => assert.deepEqual([a.width, a.height, await pixels(env, a.png, points)], [b.width, b.height, await pixels(env, b.png, points)]);
// A touchpad pinch to `to` times the scale it starts at, around a point of the user's tab.
const pinch = (env, to) =>
  env.ff.chromeEval(`(async () => {
    const r = gBrowser.selectedBrowser.getBoundingClientRect();
    const x = (mozInnerScreenX + r.left + 300) * devicePixelRatio;
    const y = (mozInnerScreenY + r.top + 300) * devicePixelRatio;
    windowUtils.sendNativeTouchpadPinch(0, 1, x, y, 0);
    for (let i = 1; i <= 10; i++) {
      await new Promise((r) => setTimeout(r, 30));
      windowUtils.sendNativeTouchpadPinch(1, 1 + (${to} - 1) * i / 10, x, y, 0);
    }
    windowUtils.sendNativeTouchpadPinch(2, ${to}, x, y, 0);
    return 1;
  })()`);
// The colours of a PNG (base64) at [x, y] points, decoded in the extension's page.
const pixels = (env, png, points) =>
  env.ext(`(async () => {
    const bin = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
    g.drawImage(bmp, 0, 0);
    return ${JSON.stringify(points)}.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data]);
  })()`);
const find = async (env, text) => (await call(env, "page.find@1", { text })).matches[0];
const overlay = (env, tab) => env.ext(`browser.tabs.sendMessage(${tab}, { kai: "overlay_state" }, { frameId: 0 })`);

export default [
  {
    name: "page.see: the view as a PNG, its size and its scale to CSS pixels; the frame's content in it",
    async fn(env) {
      const user = await home(env);
      await open(env);
      const s = await call(env, "page.see@1");
      assert.deepEqual(s.tab, { id: user, title: "See: Northwind Gear", url: env.site.url("see.html") });
      const vp = await inPage(env, "[innerWidth, innerHeight]");
      assert.deepEqual([s.width, s.height, s.view], [vp[0], vp[1], { width: vp[0], height: vp[1] }]);
      assert.deepEqual(s.scale, { x: 1, y: 1 });
      assert.ok(!("not_hidden" in s));
      const points = [[150, 150], [50, 50], [480, 155], [770, 155], [710, 110], [900, 240]];
      assert.deepEqual(await pixels(env, s.png, points), [RED, WHITE, GREEN, YELLOW, WHITE, MAGENTA]);
      // Each child frame's part of the image, the inner pane inside the cross-origin pane.
      assert.deepEqual(tree(s.frames), panes(env, { x: 700, y: 100, width: 300, height: 200 }, { x: 860, y: 210, width: 100, height: 60 }));
      await alike(env, await call(env, "page.see@1", { tab: user }), s, points);
      // Scrolled: the pane cut by the top of the view, the inner pane with it.
      await inPage(env, "(scrollTo(0, 150), 1)");
      const cut = await call(env, "page.see@1");
      assert.deepEqual(tree(cut.frames), panes(env, { x: 700, y: 0, width: 300, height: 150 }, { x: 860, y: 60, width: 100, height: 60 }));
      await inPage(env, "(scrollTo(0, 400), 1)");
      assert.deepEqual(tree((await call(env, "page.see@1")).frames), panes(env, null, null), "no frame in view");
    },
  },
  {
    name: "page.see: Kai's hint labels, pointing ring and find highlights are hidden for the capture and shown again after it",
    async fn(env) {
      const user = await home(env);
      await open(env);
      await call(env, "hints.show@1");
      try {
        const red = await find(env, "Red box");
        await call(env, "element.point@1", { ref: red.element.ref, ms: 60000 });
        const before = await overlay(env, user);
        const label = before.hints.find((l) => l.shown);
        assert.ok(label && before.ring, JSON.stringify(before));
        // Inside the label, over the green button; inside the ring's left edge, over the page.
        const lx = Math.round(label.x + label.w / 2);
        const ly = Math.round(label.y + label.h / 2);
        assert.ok(lx >= 400 && ly >= 120, `the label at ${lx},${ly} is over the button`);
        const rx = Math.round(before.ring.x + 1);
        const s = await call(env, "page.see@1");
        // page.find's highlight of "Red box" (at the box's top left) is hidden too.
        assert.deepEqual(await pixels(env, s.png, [[lx, ly], [rx, 150], [105, 105]]), [GREEN, WHITE, RED]);
        const after = await overlay(env, user);
        assert.equal(after.host.display, "block");
        assert.deepEqual(after.hints.filter((l) => l.shown).map((l) => l.ref), before.hints.filter((l) => l.shown).map((l) => l.ref));
        assert.ok(after.ring, "the ring is back");
        // A capture of the same view with the overlay shown differs where the label is.
        const raw = await env.ext(`browser.tabs.captureTab(${user}, { format: "png" }).then((u) => u.slice(u.indexOf(",") + 1))`);
        assert.notDeepEqual((await pixels(env, raw, [[lx, ly]]))[0], GREEN, "without the hiding the label is in the image");
        await waitFor(
          async () => {
            const now = await env.ext(`browser.tabs.captureTab(${user}, { format: "png" }).then((u) => u.slice(u.indexOf(",") + 1))`);
            return JSON.stringify((await pixels(env, now, [[105, 105]]))[0]) !== JSON.stringify(RED);
          },
          { what: "the find highlight drawn again" },
        );
      } finally {
        await call(env, "hints.hide@1");
      }
    },
  },
  {
    name: "element.see: an element cropped from the view, one below the fold scrolled into view, one in a cross-origin frame",
    async fn(env) {
      const user = await home(env);
      await open(env);
      const red = (await find(env, "Red box")).element;
      const e = await call(env, "element.see@1", { ref: red.ref });
      assert.deepEqual([e.ref, e.role, e.name, e.tab.id], [red.ref, "paragraph", "", user]);
      assert.deepEqual([e.width, e.height, e.box, e.scrolled, e.scale, tree(e.frames)], [200, 100, { x: 100, y: 100, width: 200, height: 100 }, false, { x: 1, y: 1 }, panes(env, null, null)]);
      assert.ok(!("clipped" in e) && !("frame" in e));
      assert.deepEqual(await pixels(env, e.png, [[0, 0], [199, 99], [100, 50]]), [RED, RED, RED]);
      const blue = (await find(env, "Blue box")).element;
      await inPage(env, "(scrollTo(0, 0), 1)");
      const b = await call(env, "element.see@1", { ref: blue.ref });
      assert.deepEqual([b.width, b.height, b.scrolled, b.box.width, b.box.height], [120, 80, true, 120, 80]);
      assert.ok((await inPage(env, "scrollY")) > 1000, "the page was scrolled to it");
      assert.deepEqual(await pixels(env, b.png, [[0, 0], [119, 79]]), [BLUE, BLUE]);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const yellow = await find(env, "Yellow box");
      const y = await call(env, "element.see@1", { ref: yellow.element.ref });
      assert.deepEqual([y.frame, y.origin], [yellow.frame, `http://localhost:${env.site.port}`]);
      assert.deepEqual([y.width, y.height, y.box], [100, 50, { x: 720, y: 130, width: 100, height: 50 }]);
      assert.deepEqual(await pixels(env, y.png, [[0, 0], [99, 49]]), [YELLOW, YELLOW]);
      // The crop lies in the pane: the pane is all of it.
      assert.deepEqual(tree(y.frames), panes(env, { x: 0, y: 0, width: 100, height: 50 }, null));
      // Partly cut off by the view: the part in view, said so.
      await inPage(env, "(scrollTo(0, 150), 1)");
      const cut = await call(env, "element.see@1", { ref: red.ref });
      assert.deepEqual([cut.width, cut.height, cut.clipped, cut.scrolled, cut.box], [200, 50, true, false, { x: 100, y: 0, width: 200, height: 50 }]);
      await inPage(env, `(document.getElementById("red").style.display = "none", 1)`);
      assert.equal((await fails(env, "element.see@1", { ref: red.ref }, "not_shown")).tab, user);
    },
  },
  {
    name: "page.see and element.see at 150 % zoom: the scale is measured from the image",
    async fn(env) {
      const user = await home(env);
      await open(env);
      try {
        await call(env, "page.zoom@1", { percent: 150, origin: siteOrigin(env) });
        const vp = await inPage(env, "[innerWidth, innerHeight]");
        const s = await call(env, "page.see@1");
        assert.deepEqual(s.view, { width: vp[0], height: vp[1] });
        assert.ok(Math.abs(s.scale.x - 1.5) < 0.01 && Math.abs(s.scale.y - 1.5) < 0.01, JSON.stringify(s.scale));
        assert.ok(Math.abs(s.width - vp[0] * 1.5) <= 2 && Math.abs(s.height - vp[1] * 1.5) <= 2, `${s.width}x${s.height} for ${vp}`);
        assert.deepEqual(await pixels(env, s.png, [[225, 225], [460, 310]]), [RED, WHITE]);
        const red = (await find(env, "Red box")).element;
        const e = await call(env, "element.see@1", { ref: red.ref });
        assert.ok(Math.abs(e.width - 300) <= 2 && Math.abs(e.height - 150) <= 2, `${e.width}x${e.height}`);
        assert.deepEqual(e.box, { x: 100, y: 100, width: 200, height: 100 });
        assert.deepEqual(await pixels(env, e.png, [[2, 2], [e.width - 3, e.height - 3]]), [RED, RED]);
      } finally {
        await call(env, "page.zoom@1", { percent: 100, origin: siteOrigin(env), tab: user });
      }
    },
  },
  {
    name: "page.see: a background tab is captured; one Firefox unloaded is not_rendered",
    async fn(env) {
      const user = await home(env);
      const t = (await call(env, "tabs.open@1", { url: env.site.url("see.html"), active: false })).tab.id;
      try {
        const s = await call(env, "page.see@1", { tab: t });
        assert.deepEqual([s.tab.id, s.width > 0, s.scale], [t, true, { x: 1, y: 1 }]);
        assert.deepEqual(await pixels(env, s.png, [[150, 150]]), [RED]);
        await env.ext(`browser.tabs.discard(${t})`);
        await waitFor(async () => (await call(env, "tabs.list@1")).tabs.find((x) => x.id === t)?.discarded, { what: "the tab unloaded" });
        const e = await fails(env, "page.see@1", { tab: t }, "not_rendered");
        assert.equal(e.message, `Firefox has not rendered tab ${t}: it unloaded the tab (a discarded background tab), so there is nothing to see until it is shown again (tabs.switch)`);
        assert.deepEqual([e.tab, e.url], [t, env.site.url("see.html")]);
      } finally {
        await call(env, "tabs.close@1", { tab: t });
        await call(env, "tabs.switch@1", { tab: user });
      }
    },
  },
  {
    name: "page.see: captures at the same time each keep Kai's labels hidden, which come back after the last",
    async fn(env) {
      const user = await home(env);
      await open(env);
      await call(env, "hints.show@1");
      try {
        const before = await overlay(env, user);
        // The label over the green button.
        const label = before.hints.find((l) => l.shown && l.x + l.w / 2 >= 400 && l.y + l.h / 2 >= 120);
        assert.ok(label, JSON.stringify(before));
        const at = [Math.round(label.x + label.w / 2), Math.round(label.y + label.h / 2)];
        const shots = await Promise.all([0, 1, 2, 3].map(async (i) => (await sleep(i * 7), call(env, "page.see@1"))));
        for (const s of shots) assert.deepEqual(await pixels(env, s.png, [at]), [GREEN]);
        assert.equal((await overlay(env, user)).host.display, "block");
        // The page's side: one capture's end shows the labels only once no other capture hides them.
        const shot = (kai, token) => env.ext(`browser.tabs.sendMessage(${user}, { kai: "${kai}", ms: 60000, token: ${token} }, { frameId: 0 })`);
        await shot("shot_hide", 1e9 + 1);
        await shot("shot_hide", 1e9 + 2);
        await shot("shot_show", 1e9 + 1);
        assert.equal((await overlay(env, user)).host.display, "none", "the other capture is still under way");
        await shot("shot_show", 1e9 + 2);
        assert.equal((await overlay(env, user)).host.display, "block");
      } finally {
        await call(env, "hints.hide@1");
      }
    },
  },
  {
    name: "page.see and element.see on a page whose address changes during the capture: page_changed, no image under the old address",
    async fn(env) {
      const user = await home(env);
      await call(env, "tabs.go@1", { url: env.site.url("ticker.html") });
      const e = await fails(env, "page.see@1", {}, "page_changed");
      assert.equal(e.message, `tab ${user} showed another page or address when the screenshot was taken than when Kai asked, so no image is sent`);
      assert.equal(e.tab, user);
      assert.match(e.url, /\/ticker\.html\?tick=\d+$/);
      const h = (await call(env, "page.outline@1")).items.find((i) => i.role === "heading");
      await fails(env, "element.see@1", { ref: h.ref }, "page_changed");
    },
  },
  {
    name: "page.see and element.see at a device pixel ratio of 2: the image, its scale, the crop and the frames in image pixels",
    async fn(env) {
      await home(env);
      await env.ff.chromeEval(`(Services.prefs.setCharPref("layout.css.devPixelsPerPx", "2"), 1)`);
      try {
        await open(env);
        await waitFor(async () => (await inPage(env, "devicePixelRatio")) === 2, { what: "the device pixel ratio 2" });
        const vp = await inPage(env, "[innerWidth, innerHeight]");
        const s = await call(env, "page.see@1");
        assert.deepEqual([s.width, s.height, s.view, s.scale], [vp[0] * 2, vp[1] * 2, { width: vp[0], height: vp[1] }, { x: 2, y: 2 }]);
        assert.deepEqual(await pixels(env, s.png, [[300, 300], [100, 100], [1540, 310], [1800, 480]]), [RED, WHITE, YELLOW, MAGENTA]);
        assert.deepEqual(tree(s.frames), panes(env, { x: 1400, y: 200, width: 600, height: 400 }, { x: 1720, y: 420, width: 200, height: 120 }));
        const red = (await find(env, "Red box")).element;
        const e = await call(env, "element.see@1", { ref: red.ref });
        assert.deepEqual([e.width, e.height, e.box, e.scale], [400, 200, { x: 100, y: 100, width: 200, height: 100 }, { x: 2, y: 2 }]);
        assert.deepEqual(await pixels(env, e.png, [[0, 0], [399, 199]]), [RED, RED]);
        const yellow = await find(env, "Yellow box");
        const y = await call(env, "element.see@1", { ref: yellow.element.ref });
        assert.deepEqual([y.width, y.height, tree(y.frames)], [200, 100, panes(env, { x: 0, y: 0, width: 200, height: 100 }, null)]);
      } finally {
        await env.ff.chromeEval(`(Services.prefs.clearUserPref("layout.css.devPixelsPerPx"), 1)`);
        await waitFor(async () => (await inPage(env, "devicePixelRatio")) === 1, { what: "the device pixel ratio 1 again" });
      }
    },
  },
  {
    name: "page.see and element.see while the user has pinch-zoomed: Firefox captures the layout viewport at the page's zoom, so the boxes and crops hold",
    async fn(env) {
      await home(env);
      await open(env);
      try {
        await pinch(env, 2);
        await waitFor(async () => (await inPage(env, "visualViewport.scale")) > 1.5, { what: "the pinch zoom" });
        const vp = await inPage(env, "[innerWidth, innerHeight]");
        const s = await call(env, "page.see@1");
        assert.deepEqual([s.width, s.height, s.view, s.scale], [vp[0], vp[1], { width: vp[0], height: vp[1] }, { x: 1, y: 1 }]);
        assert.deepEqual(await pixels(env, s.png, [[150, 150], [50, 50], [770, 155]]), [RED, WHITE, YELLOW]);
        assert.deepEqual(tree(s.frames), panes(env, { x: 700, y: 100, width: 300, height: 200 }, { x: 860, y: 210, width: 100, height: 60 }));
        const red = (await find(env, "Red box")).element;
        const e = await call(env, "element.see@1", { ref: red.ref });
        assert.deepEqual([e.width, e.height, e.box], [200, 100, { x: 100, y: 100, width: 200, height: 100 }]);
        assert.deepEqual(await pixels(env, e.png, [[0, 0], [199, 99]]), [RED, RED]);
      } finally {
        await pinch(env, 0.25);
        await waitFor(async () => (await inPage(env, "visualViewport.scale")) === 1, { what: "the pinch zoom undone" });
      }
    },
  },
  {
    name: "page.see: a frame that goes to another site during the capture is named by the site it shows after it, with the one before (origin_before)",
    async fn(env) {
      await home(env);
      await call(env, "tabs.go@1", { url: env.site.url("see-hop.html") });
      await waitFor(async () => (await call(env, "page.text_all@1")).frames.read === 2, { what: "the pane" });
      // Kai's labels in the pane: hiding them for the capture is the pane's sign to go.
      await call(env, "hints.show@1");
      try {
        const s = await call(env, "page.see@1");
        assert.deepEqual(tree(s.frames), [
          {
            origin: `http://127.0.0.2:${env.site.port}`,
            origin_before: `http://localhost:${env.site.port}`,
            url: env.site.url("help.html", "127.0.0.2"),
            box: { x: 300, y: 40, width: 300, height: 200 },
          },
        ]);
      } finally {
        await call(env, "hints.hide@1");
      }
      // A capture with nothing changing names each frame once.
      const again = await call(env, "page.see@1");
      assert.ok(!("origin_before" in again.frames[0]), JSON.stringify(again.frames));
    },
  },
];

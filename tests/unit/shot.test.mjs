// Where child frames are in a screenshot (extension/background/shot.js), in Node: nested frames,
// clipping by the view and by a parent, a frame no parent measured, two placings joined, image
// pixels at a scale other than 1 and a crop; which site names each frame when one navigated during
// the capture.
import assert from "node:assert/strict";
import { placeFrames, unionPlaces, toImage, cropFrames, frameTree, frameSites } from "../../extension/background/shot.js";

const view = { width: 1280, height: 900 };
const f = (frameId, parentFrameId, url) => ({ frameId, parentFrameId, url });
const at = (x, y, w, h) => ({ x, y, w, h });
// A parent's frame_boxes answer.
const boxes = (entries) => new Map(entries.map(([parent, kids]) => [parent, kids && new Map(kids.map((k) => [k.frame, k]))]));

export default [
  {
    name: "shot frames: a nested frame offset by its parents and clipped by what of each is in view",
    fn() {
      const list = [f(0, -1, "http://127.0.0.1/"), f(7, 0, "http://localhost/pane"), f(9, 7, "http://127.0.0.1/inner")];
      const b = boxes([
        [0, [{ frame: 7, box: at(700, 100, 300, 200), vis: at(700, 100, 300, 200) }]],
        [7, [{ frame: 9, box: at(160, 110, 100, 60), vis: at(160, 110, 100, 60) }]],
      ]);
      const p = placeFrames(list, b, view);
      assert.deepEqual(p.get(7), { rect: at(700, 100, 300, 200), measured: true });
      assert.deepEqual(p.get(9), { rect: at(860, 210, 100, 60), measured: true });
      // The pane scrolled half out of the top: the inner frame's part above it is cut away.
      const s = boxes([
        [0, [{ frame: 7, box: at(700, -100, 300, 200), vis: at(700, 0, 300, 100) }]],
        [7, [{ frame: 9, box: at(160, 80, 100, 60), vis: at(160, 80, 100, 60) }]],
      ]);
      const q = placeFrames(list, s, view);
      assert.deepEqual(q.get(7).rect, at(700, 0, 300, 100));
      assert.deepEqual(q.get(9).rect, at(860, 0, 100, 40));
      // A frame element that is not rendered, and one wholly out of view, show nothing; so do
      // their children.
      const h = placeFrames(list, boxes([[0, [{ frame: 7, box: null, vis: null }]], [7, []]]), view);
      assert.deepEqual([h.get(7).rect, h.get(9).rect], [null, null]);
      const o = placeFrames(list, boxes([[0, [{ frame: 7, box: at(700, 2000, 300, 200), vis: null }]], [7, [{ frame: 9, box: at(0, 0, 10, 10), vis: at(0, 0, 10, 10) }]]]), view);
      assert.deepEqual([o.get(7).rect, o.get(9).rect], [null, null]);
    },
  },
  {
    name: "shot frames: a frame whose parent did not answer gets the part of the nearest measured frame around it, marked unmeasured",
    fn() {
      const list = [f(0, -1, "http://127.0.0.1/"), f(7, 0, "http://127.0.0.2/"), f(9, 7, "http://none.example/"), f(11, 9, "http://none.example/deeper")];
      const p = placeFrames(list, boxes([[0, [{ frame: 7, box: at(10, 20, 300, 200), vis: at(10, 20, 300, 200) }]], [7, null]]), view);
      assert.deepEqual(p.get(7), { rect: at(10, 20, 300, 200), measured: true });
      assert.deepEqual(p.get(9), { rect: at(10, 20, 300, 200), measured: false });
      assert.deepEqual(p.get(11), { rect: at(10, 20, 300, 200), measured: false });
      // The top document did not answer: every frame may be anywhere in the view.
      const t = placeFrames(list, boxes([[0, null]]), view);
      assert.deepEqual(t.get(7), { rect: at(0, 0, 1280, 900), measured: false });
      // A parent that answered without the frame (it is somewhere the walk does not see).
      const m = placeFrames(list, boxes([[0, []]]), view);
      assert.deepEqual(m.get(7), { rect: at(0, 0, 1280, 900), measured: false });
    },
  },
  {
    name: "shot frames: two placings joined over both places; image pixels widened at a scale; a crop's share",
    fn() {
      const a = new Map([[7, { rect: at(700, 100, 300, 200), measured: true }], [9, { rect: null, measured: true }]]);
      const b = new Map([[7, { rect: at(690, 120, 300, 200), measured: true }], [9, { rect: at(5, 5, 10, 10), measured: false }], [11, { rect: at(1, 2, 3, 4), measured: true }]]);
      const u = unionPlaces(a, b);
      assert.deepEqual(u.get(7), { rect: at(690, 100, 310, 220), measured: true });
      assert.deepEqual(u.get(9), { rect: at(5, 5, 10, 10), measured: false });
      assert.deepEqual(u.get(11), { rect: at(1, 2, 3, 4), measured: true });
      assert.deepEqual(toImage(at(700.5, 100.25, 300, 200), { x: 2, y: 2 }, { width: 2560, height: 1800 }), { x: 1401, y: 200, width: 600, height: 401 });
      assert.equal(toImage(at(1200, 850, 200, 200), { x: 1.5018, y: 1.5 }, { width: 1281, height: 900 }), null, "outside the image");
      assert.deepEqual(toImage(at(800, 500, 200, 200), { x: 1.5, y: 1.5 }, { width: 1281, height: 900 }), { x: 1200, y: 750, width: 81, height: 150 });
      assert.equal(toImage(null, { x: 1, y: 1 }, view), null);
      const frames = [
        { frame: 7, origin: "http://localhost", url: "http://localhost/pane", box: { x: 700, y: 100, width: 300, height: 200 } },
        { frame: 9, origin: null, url: "about:blank", box: { x: 0, y: 0, width: 10, height: 10 } },
      ];
      assert.deepEqual(cropFrames(frames, { x0: 720, y0: 130, x1: 820, y1: 180 }), [{ ...frames[0], box: { x: 0, y: 0, width: 100, height: 50 } }, { ...frames[1], box: null }]);
      assert.deepEqual(cropFrames(frames, { x0: 600, y0: 50, x1: 750, y1: 150 })[0].box, { x: 100, y: 50, width: 50, height: 50 });
      assert.deepEqual(cropFrames([{ ...frames[0], box: null }], { x0: 0, y0: 0, x1: 10, y1: 10 }), [{ ...frames[0], box: null }]);
    },
  },
  {
    name: "shot frames: flat entries nested as Firefox's frames are, children under `frames` only where there are some",
    fn() {
      const e = (frame) => ({ frame, origin: null, url: "about:blank", box: null });
      const parents = new Map([[7, 0], [9, 7], [11, 9], [13, 0], [15, 99]]);
      assert.deepEqual(frameTree([e(7), e(9), e(11), e(13), e(15)], parents), [
        { ...e(7), frames: [{ ...e(9), frames: [e(11)] }] },
        e(13),
        e(15),
      ]);
      assert.deepEqual(frameTree([], parents), []);
    },
  },
  {
    name: "shot sites: a frame is named by its document after the capture; one that went to another site meanwhile carries the site before too",
    fn() {
      const nav = (frameId, url, documentId) => ({ frameId, parentFrameId: 0, url, documentId });
      const start = [nav(0, "http://127.0.0.1/", "d0"), nav(7, "http://localhost/pane", "d7"), nav(9, "about:srcdoc", "d9"), nav(11, "http://ads.example/slot", "d11"), nav(13, "http://gone.example/", "d13")];
      const hidden = new Map([
        [0, { origin: "http://127.0.0.1", url: "http://127.0.0.1/", document: "d0" }],
        [7, { origin: "http://localhost", url: "http://localhost/pane", document: "d7" }],
        [9, { origin: "http://127.0.0.1", url: "about:srcdoc", document: "d9" }],
        [11, { origin: "http://ads.example", url: "http://ads.example/slot", document: "d11" }],
      ]);
      const after = [
        nav(0, "http://127.0.0.1/", "d0"),
        nav(7, "http://localhost/pane#moved", "d7"),
        nav(9, "about:srcdoc", "d9"),
        nav(11, "https://none.example/x", "d11b"),
        nav(15, "http://new.example/", "d15"),
      ];
      const s = frameSites(hidden, start, after);
      assert.deepEqual([...s.keys()].sort((a, b) => a - b), [7, 9, 11, 13, 15]);
      // The same document: its content script's origin (a srcdoc frame's is its parent's), the URL after.
      assert.deepEqual(s.get(7), { origin: "http://localhost", url: "http://localhost/pane#moved" });
      assert.deepEqual(s.get(9), { origin: "http://127.0.0.1", url: "about:srcdoc" });
      // Another document of another site: both sites.
      assert.deepEqual(s.get(11), { origin: "https://none.example", url: "https://none.example/x", origin_before: "http://ads.example" });
      // Gone after the capture: as it was; new after it: as it is (no content script: by its URL).
      assert.deepEqual(s.get(13), { origin: "http://gone.example", url: "http://gone.example/" });
      assert.deepEqual(s.get(15), { origin: "http://new.example", url: "http://new.example/" });
      // Another document of the same site: one origin. To about:blank: no origin now (the strictest rule), the one before.
      const again = frameSites(new Map([[7, { origin: "http://localhost", url: "http://localhost/pane", document: "d7" }]]), start, [nav(7, "http://localhost/other", "d7b")]);
      assert.deepEqual(again.get(7), { origin: "http://localhost", url: "http://localhost/other" });
      const blank = frameSites(new Map(), start, [nav(7, "about:blank", "d7c")]);
      assert.deepEqual(blank.get(7), { origin: null, url: "about:blank", origin_before: "http://localhost" });
      // Without document ids, a frame is the same document while its URL's origin is.
      const bare = (frameId, url) => ({ frameId, parentFrameId: 0, url });
      const n = frameSites(new Map(), [bare(7, "http://localhost/a")], [bare(7, "http://127.0.0.3/b")]);
      assert.deepEqual(n.get(7), { origin: "http://127.0.0.3", url: "http://127.0.0.3/b", origin_before: "http://localhost" });
      assert.deepEqual(frameSites(new Map(), [bare(7, "http://localhost/a")], [bare(7, "http://localhost/b")]).get(7), { origin: "http://localhost", url: "http://localhost/b" });
    },
  },
];

// Where a tab's child frames are in a screenshot (see.js). Each parent document reports its child
// frames' content boxes and the part of each in view, in its own viewport (frame_boxes); a frame's
// part of the top document's viewport is its box offset by its parents' and clipped by what of
// each parent is in view. A frame whose parent did not report it (the parent could not be read)
// is given the part of the nearest frame around it that was measured, which holds it. No browser
// API here, so Node's tests import this file as it is.

import { originOf } from "./url.js";

// Rects here are { x, y, w, h } in CSS pixels of the top document's viewport.
function cut(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

// `list`: webNavigation.getAllFrames' entries; `boxes`: Map(parent frame id -> Map(child frame id
// -> { box, vis }) | null when the parent did not answer); `view`: the top viewport's size.
// Map(frame id -> { rect: its part of the view or null (none in view), measured }) for every
// child frame.
export function placeFrames(list, boxes, view) {
  const byId = new Map(list.map((f) => [f.frameId, f]));
  const whole = { x: 0, y: 0, w: view.width, h: view.height };
  const top = { off: { x: 0, y: 0 }, clip: whole, measured: true };
  const memo = new Map();
  const place = (id, seen) => {
    if (id === 0) return top;
    if (memo.has(id)) return memo.get(id);
    const f = byId.get(id);
    let out;
    if (!f || seen.has(id)) out = { off: null, clip: whole, measured: false };
    else {
      seen.add(id);
      const parent = place(f.parentFrameId, seen);
      const b = boxes.get(f.parentFrameId)?.get(id);
      if (!parent.clip) out = { off: null, clip: null, measured: parent.measured };
      else if (!parent.off || !b) out = { off: null, clip: parent.clip, measured: false };
      else if (!b.box) out = { off: null, clip: null, measured: true };
      else {
        const off = { x: parent.off.x + b.box.x, y: parent.off.y + b.box.y };
        const vis = b.vis && cut({ x: parent.off.x + b.vis.x, y: parent.off.y + b.vis.y, w: b.vis.w, h: b.vis.h }, parent.clip);
        out = { off, clip: vis || null, measured: true };
      }
    }
    memo.set(id, out);
    return out;
  };
  const res = new Map();
  for (const f of list) {
    if (f.frameId === 0) continue;
    const p = place(f.frameId, new Set());
    res.set(f.frameId, { rect: p.clip, measured: p.measured });
  }
  return res;
}

// Two placings (before and after the capture) as one: each frame's rect over both places.
export function unionPlaces(a, b) {
  const out = new Map();
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const pa = a.get(id);
    const pb = b.get(id);
    const ra = pa?.rect ?? null;
    const rb = pb?.rect ?? null;
    let rect = ra ?? rb;
    if (ra && rb) {
      const x = Math.min(ra.x, rb.x);
      const y = Math.min(ra.y, rb.y);
      rect = { x, y, w: Math.max(ra.x + ra.w, rb.x + rb.w) - x, h: Math.max(ra.y + ra.h, rb.y + rb.h) - y };
    }
    out.set(id, { rect, measured: (pa?.measured ?? true) && (pb?.measured ?? true) });
  }
  return out;
}

// A rect in image pixels: times the scale, widened to whole pixels, inside the image
// ({ width, height }); null when nothing of it is in the image.
export function toImage(rect, scale, size) {
  if (!rect) return null;
  const x0 = Math.max(0, Math.floor(rect.x * scale.x));
  const y0 = Math.max(0, Math.floor(rect.y * scale.y));
  const x1 = Math.min(size.width, Math.ceil((rect.x + rect.w) * scale.x));
  const y1 = Math.min(size.height, Math.ceil((rect.y + rect.h) * scale.y));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

// The frames of a whole image ({ box } in its pixels, or null) as parts of the crop { x0, y0, x1,
// y1 }: boxes in the crop's pixels, null for a frame with no part in it.
export function cropFrames(frames, c) {
  return frames.map((f) => {
    if (!f.box) return f;
    const x0 = Math.max(f.box.x, c.x0);
    const y0 = Math.max(f.box.y, c.y0);
    const x1 = Math.min(f.box.x + f.box.width, c.x1);
    const y1 = Math.min(f.box.y + f.box.height, c.y1);
    return { ...f, box: x1 > x0 && y1 > y0 ? { x: x0 - c.x0, y: y0 - c.y0, width: x1 - x0, height: y1 - y0 } : null };
  });
}

// Flat frame entries ({ frame, ... }, in Firefox's frame order) as a tree: each frame's child
// frames in its `frames`, only when it has some; a frame whose parent is the top document or not
// among them at the top.
export function frameTree(entries, parentOf) {
  const nodes = new Map(entries.map((e) => [e.frame, { ...e }]));
  const top = [];
  for (const e of entries) {
    const node = nodes.get(e.frame);
    const parent = nodes.get(parentOf.get(e.frame));
    if (parent && parent !== node) (parent.frames ??= []).push(node);
    else top.push(node);
  }
  return top;
}

// Which site each frame showed (frameSites): `hidden`, Map(frame id -> { origin, url, document })
// from the content scripts' answers to the hiding before the capture; `start`, `after`:
// webNavigation.getAllFrames' entries before the hiding and right after the capture. Each frame is
// named by its document after the capture: Map(frame id -> { origin, url, origin_before? }). A
// frame whose document changed meanwhile and whose origin with it carries the origin it had at the
// hiding too (`origin_before`), so Kai applies the stricter rule: the image shows one of the two.
// The same document keeps the origin its content script said (an about:blank or srcdoc frame's is
// its parent's, which its URL does not say). A frame gone by then is named as it was.
export function frameSites(hidden, start, after) {
  const fromList = (f) => f && { origin: originOf(f.url), url: f.url ?? null, document: f.documentId };
  const startById = new Map(start.map((f) => [f.frameId, f]));
  const afterById = new Map(after.map((f) => [f.frameId, f]));
  const out = new Map();
  for (const id of new Set([...startById.keys(), ...hidden.keys(), ...afterById.keys()])) {
    if (id === 0) continue;
    const was = hidden.get(id) ?? fromList(startById.get(id));
    const now = fromList(afterById.get(id));
    if (!now) {
      out.set(id, { origin: was.origin, url: was.url });
      continue;
    }
    if (!was) {
      out.set(id, { origin: now.origin, url: now.url });
      continue;
    }
    const same = was.document && now.document ? was.document === now.document : originOf(was.url) === now.origin;
    if (same) {
      out.set(id, { origin: was.origin, url: now.url });
      continue;
    }
    const site = { origin: now.origin, url: now.url };
    if (now.origin !== was.origin) site.origin_before = was.origin;
    out.set(id, site);
  }
  return out;
}

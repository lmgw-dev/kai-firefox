// Eyes (design §5.3): page.see, a screenshot of what a tab shows (tabs.captureTab, PNG), and
// element.see, the same cropped to one element. What Kai draws (hint labels, the pointing ring,
// page.find's highlights) is hidden for the capture. The image's scale to the page's CSS pixels is
// measured from the decoded image against the viewport the capture covers (the window's inner
// size), never taken from the device pixel ratio; the crop is computed with it. A pinch zoom does
// not change the image: Firefox 159 captures the layout viewport at the page's zoom (measured).
//
// Screenshots are not masked: a frame of a site Kai does not reach is in the image like the rest,
// so every answer lists the child frames, nested as they are, with their part of the image
// (shot.js), and Kai blanks those of `none` sites before the image leaves it. A frame is named by
// the document it shows after the capture; one that went to another site during it carries the
// site before too (origin_before). A tab that shows another page or address after the capture than
// when the operation began is page_changed, never an image under the wrong name.

import { define, OpError, about } from "./ops.js";
import { tabArg } from "./tabs.js";
import { frameCall, urlAccess, resolveRef, askElement, inTime } from "./pages.js";
import { tabRef } from "./compose.js";
import { settings } from "./settings.js";
import { findHighlights } from "./read.js";
import { originOf } from "./url.js";
import { placeFrames, unionPlaces, toImage, cropFrames, frameTree, frameSites } from "./shot.js";

const notRendered = (tab) =>
  new OpError("not_rendered", `Firefox has not rendered tab ${tab.id}: it unloaded the tab (a discarded background tab), so there is nothing to see until it is shown again (tabs.switch)`, about(tab));
const pageChanged = (tab, now) =>
  new OpError("page_changed", `tab ${tab.id} showed another page or address when the screenshot was taken than when Kai asked, so no image is sent`, about(now ?? tab));

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Where each child frame is: the frames Firefox lists, and each parent's frame_boxes answer
// (null when the parent could not answer).
async function measure(tab) {
  const list = (await browser.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) || [];
  const parents = [...new Set(list.filter((f) => f.frameId !== 0).map((f) => f.parentFrameId))].filter((p) => p >= 0);
  const boxes = new Map();
  await Promise.all(
    parents.map((p) =>
      frameCall(tab, p, { kai: "frame_boxes" }).then(
        (r) => boxes.set(p, new Map(r.frames.map((b) => [b.frame, b]))),
        () => boxes.set(p, null),
      ),
    ),
  );
  return { list, boxes };
}

let nextShot = 1;

// A capture of `tab` with Kai's drawings hidden: { url (a PNG data URL), bitmap, view: the CSS
// viewport it covers, scale, tab: as it is after the capture, frames: every child frame with its
// part of the image (flat, in frame order), parentOf: Map(frame -> parent), not_hidden: frames that
// did not answer the hiding }. `start`: the URL and top document the operation began with; a
// capture of another is page_changed.
async function capture(tab, start) {
  if (tab.discarded) throw notRendered(tab);
  // The overlay of each frame is hidden while any capture holds a token there.
  const token = nextShot++;
  const frames = (await browser.webNavigation.getAllFrames({ tabId: tab.id })) || [];
  // Hidden at the latest until twice content_ms has passed, should the showing never come.
  const ms = settings.content_ms * 2;
  // A frame without Kai's content script has none of Kai's drawings; one that does not answer in
  // time may, and is named. Those that answer say their origin, URL and document.
  const who = new Map();
  const hide = (f) =>
    inTime(browser.tabs.sendMessage(tab.id, { kai: "shot_hide", ms, token }, { frameId: f.frameId }), `frame ${f.frameId} of tab ${tab.id}`, tab).then(
      (r) => {
        if (r?.url) who.set(f.frameId, { origin: r.origin ?? null, url: r.url, document: r.document ?? null });
        return null;
      },
      (e) => (e instanceof OpError ? { frame: f.frameId, code: e.code } : null),
    );
  const hid = await Promise.all(frames.map(hide));
  // page.find's highlights are Kai's too: taken away for the capture, drawn again after it.
  const found = findHighlights.get(tab.id);
  if (found !== undefined) await inTime(browser.find.removeHighlighting(tab.id), `tab ${tab.id}`, tab).catch(() => {});
  let url;
  let view;
  let before;
  let after;
  let now;
  try {
    // Where the frames are right before and right after the capture: a frame that moved between
    // is given a box over both places.
    let vp;
    [vp, before] = await Promise.all([frameCall(tab, 0, { kai: "viewport_size" }), measure(tab)]);
    view = { width: vp.w, height: vp.h };
    url = await browser.tabs.captureTab(tab.id, { format: "png" });
    [after, now] = await Promise.all([measure(tab), browser.tabs.get(tab.id).catch(() => null)]);
  } catch (e) {
    if (e instanceof OpError) throw e;
    if (/invisible tab/i.test(e.message)) throw notRendered(tab);
    throw new OpError("no_content", `Firefox did not capture tab ${tab.id}: ${e.message}`, about(tab));
  } finally {
    for (const f of frames) browser.tabs.sendMessage(tab.id, { kai: "shot_show", token }, { frameId: f.frameId }).catch(() => {});
    // Drawn again before the answer, so a page.find that follows does not meet this search.
    if (found !== undefined && findHighlights.get(tab.id) === found) {
      const again = browser.find.find(found, { tabId: tab.id }).then((r) => (r.count > 0 ? browser.find.highlightResults({ tabId: tab.id, noScroll: true }) : findHighlights.delete(tab.id)));
      await inTime(again, `tab ${tab.id}`, tab).catch((e) => console.warn(`Kai for Firefox: the find highlights in tab ${tab.id} were not drawn again: ${e.message}`));
    }
  }
  const topNow = after.list.find((f) => f.frameId === 0);
  if (!now || now.url !== start.url || !start.document || topNow?.documentId !== start.document) throw pageChanged(tab, now);
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const scale = { x: bitmap.width / view.width, y: bitmap.height / view.height };
  const places = unionPlaces(placeFrames(before.list, before.boxes, view), placeFrames(after.list, after.boxes, view));
  const listed = new Map([...before.list, ...after.list].map((f) => [f.frameId, f]));
  const sites = frameSites(who, frames, after.list);
  const entries = [];
  for (const [frame, place] of places) {
    const f = listed.get(frame);
    const site = sites.get(frame) ?? { origin: originOf(f?.url), url: f?.url ?? null };
    const entry = { frame, origin: site.origin };
    if (site.origin_before !== undefined) entry.origin_before = site.origin_before;
    Object.assign(entry, { url: site.url, box: toImage(place.rect, scale, bitmap) });
    if (!place.measured) entry.unmeasured = true;
    entries.push(entry);
  }
  const parentOf = new Map([...listed.values()].map((f) => [f.frameId, f.parentFrameId]));
  return { url, bitmap, view, scale, tab: now, frames: entries, parentOf, not_hidden: hid.filter(Boolean) };
}

define("page.see@1", {
  args: { tab: { type: "integer" } },
  async run({ tab: id }) {
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    if (tab.discarded) throw notRendered(tab);
    const top = await frameCall(tab, 0, { kai: "whoami" });
    const shot = await capture(tab, { url: tab.url, document: top.document });
    const out = {
      tab: tabRef(shot.tab),
      png: shot.url.slice(shot.url.indexOf(",") + 1),
      width: shot.bitmap.width,
      height: shot.bitmap.height,
      view: shot.view,
      scale: shot.scale,
      frames: frameTree(shot.frames, shot.parentOf),
    };
    if (shot.not_hidden.length) out.not_hidden = shot.not_hidden;
    shot.bitmap.close();
    return out;
  },
});

const intersect = (a, b) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};

define("element.see@1", {
  args: { ref: { type: "ref", required: true } },
  async run({ ref }) {
    const { tab, entry } = await resolveRef(ref);
    if (tab.discarded) throw notRendered(tab);
    const top = (await browser.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null))?.documentId;
    const { r } = await askElement(ref, tab, entry, { kai: "see_box" });
    const el = { role: r.el.role, name: r.el.name };
    if (r.el.level !== undefined) el.level = r.el.level;
    if (entry.frame !== 0) Object.assign(el, { frame: entry.frame, origin: r.origin ?? null });
    if (!r.shown) throw new OpError("not_shown", `ref ${ref} is not shown (display: none, visibility: hidden), so there is nothing to see`, about(tab));
    // The part in view, through the frames up to the top document's viewport.
    let box = r.vis;
    let clipped = !box || box.w < r.rect.w - 0.5 || box.h < r.rect.h - 0.5;
    for (let frame = entry.frame; box && frame !== 0; ) {
      const f = await browser.webNavigation.getFrame({ tabId: tab.id, frameId: frame });
      const p = f ? await frameCall(tab, f.parentFrameId, { kai: "frame_box", frame }) : null;
      if (!p?.box || !p.vis) {
        box = null;
        break;
      }
      const moved = { x: box.x + p.box.x, y: box.y + p.box.y, w: box.w, h: box.h };
      box = intersect(moved, p.vis);
      if (box && (box.w < moved.w - 0.5 || box.h < moved.h - 0.5)) clipped = true;
      frame = f.parentFrameId;
    }
    if (!box) throw new OpError("not_in_view", `no part of ref ${ref} can be brought into view (it is clipped away, or has no size), so there is nothing to see`, about(tab));
    const shot = await capture(tab, { url: tab.url, document: top });
    try {
      const s = shot.scale;
      const x0 = Math.max(0, Math.floor(box.x * s.x));
      const y0 = Math.max(0, Math.floor(box.y * s.y));
      const x1 = Math.min(shot.bitmap.width, Math.ceil((box.x + box.w) * s.x));
      const y1 = Math.min(shot.bitmap.height, Math.ceil((box.y + box.h) * s.y));
      if (x1 <= x0 || y1 <= y0) throw new OpError("not_in_view", `ref ${ref} is outside what tab ${tab.id} shows`, about(tab));
      const canvas = new OffscreenCanvas(x1 - x0, y1 - y0);
      canvas.getContext("2d").drawImage(shot.bitmap, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
      const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      const out = {
        ref,
        tab: tabRef(shot.tab),
        ...el,
        png: bytesToBase64(png),
        width: x1 - x0,
        height: y1 - y0,
        box: { x: box.x, y: box.y, width: box.w, height: box.h },
        view: shot.view,
        scale: s,
        scrolled: r.scrolled,
        frames: frameTree(cropFrames(shot.frames, { x0, y0, x1, y1 }), shot.parentOf),
      };
      if (clipped) out.clipped = true;
      if (shot.not_hidden.length) out.not_hidden = shot.not_hidden;
      return out;
    } finally {
      shot.bitmap.close();
    }
  },
});

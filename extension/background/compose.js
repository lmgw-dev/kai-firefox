// Reading a whole tab (design §5.3, "Frames"): every frame's content script answers for its own
// document; a parent reports each child frame as a placeholder { frame, box } where its <iframe>
// is, `box` being the child's content box in the parent's viewport. Merging walks from the top
// document down: a child's coordinates are offset by its box, clipped to what of the frame is in
// view, and its items take the placeholder's place, so the order is reading order across frames.

import { OpError, about } from "./ops.js";
import { allFrames, frameCall, urlAccess, frameRefusal } from "./pages.js";
import { refsFor } from "./refs.js";
import { originOf } from "./url.js";

const isPlaceholder = (item) => "frame" in item && "box" in item;

// The frames of allFrames' answers for `tab`, as results report them: { unread: Map(frameId ->
// OpError), frames: { read, unread, unread_frames: [{ frame, origin, code, title }] } }. An
// unread frame's <iframe> title comes from its parent document, asked once per parent; null when
// the parent could not be read either.
export async function frameReport(tab, answers) {
  const unread = new Map();
  for (const a of answers) if (a.error && a.frameId !== 0) unread.set(a.frameId, await frameRefusal(a.url, a.error));
  const parents = new Set(answers.filter((a) => unread.has(a.frameId)).map((a) => a.parentFrameId));
  const titles = new Map();
  await Promise.all(
    [...parents].map((p) =>
      frameCall(tab, p, { kai: "frame_titles" }).then(
        (r) => r.titles.forEach(([id, t]) => titles.set(id, t)),
        () => {},
      ),
    ),
  );
  const list = answers
    .filter((a) => unread.has(a.frameId))
    .map((a) => ({ frame: a.frameId, origin: originOf(a.url), code: unread.get(a.frameId).code, title: titles.get(a.frameId) ?? null }));
  return { unread, frames: { read: answers.filter((a) => a.result).length, unread: list.length, unread_frames: list } };
}

// Every frame of `tab` asked `msg`: { read: Map(frameId -> answer), unread: Map(frameId ->
// OpError), frames } (frameReport's). Throws why the page itself cannot be read. `top` (a
// documentId) pins the top frame's call to that document (allFrames').
export async function readFrames(tab, msg, { top: pinned = null } = {}) {
  const refused = await urlAccess(tab);
  if (refused) throw refused;
  const answers = await allFrames(tab, msg, { top: pinned });
  const top = answers.find((a) => a.frameId === 0);
  if (!top || top.error) throw top?.error ?? new OpError("no_content", `tab ${tab.id} has no top document to read`, about(tab));
  const read = new Map(answers.filter((a) => a.result).map((a) => [a.frameId, a.result]));
  const { unread, frames } = await frameReport(tab, answers);
  return { read, unread, frames };
}

const meets = (r, c) => !!c && (r.w > 0 || r.h > 0) && r.x + r.w > c.x && r.y + r.h > c.y && r.x < c.x + c.w && r.y < c.y + c.h;
function intersect(a, b) {
  if (!a) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

// The items of list `key` of every frame, merged in reading order: [{ item, frameId, page,
// rect (in the top viewport), visible (in view after the frames' clipping), inert (the frame's
// <iframe> is outside an open modal) }]. An item's `vis`, where the frame gives one, is the part
// of it in view in its frame (null: none, inside a scroll container's hidden part for one), and
// decides instead of its `rect`; a placeholder's `vis` clips its frame. `onlyVisible` drops what
// is not visible, also whole frames out of view; `unread(placeholder, error)` gives an entry for
// a frame that could not be read, else it is left out.
export function merge(pages, key, { onlyVisible = false, unread = null } = {}) {
  const out = [];
  const top = pages.read.get(0);
  const seen = new Set();
  const walk = (frameId, off, clip, inert) => {
    if (seen.has(frameId)) return;
    seen.add(frameId);
    const page = pages.read.get(frameId);
    const at = (r) => r && { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h };
    for (const item of page[key] ?? []) {
      if (isPlaceholder(item)) {
        const box = at(item.box);
        const vis = "vis" in item ? at(item.vis) : box;
        const sub = vis ? intersect(clip, vis) : null;
        if (onlyVisible && !sub) continue;
        if (pages.read.has(item.frame)) walk(item.frame, box, sub, inert || !!item.inert);
        else if (unread && pages.unread.has(item.frame)) out.push(unread(item, pages.unread.get(item.frame)));
        continue;
      }
      const rect = at(item.rect);
      const vis = "vis" in item ? at(item.vis) : rect;
      const visible = vis ? meets(vis, clip) : !("vis" in item) && !!clip;
      if (onlyVisible && !visible) continue;
      out.push({ item, frameId, page, rect, visible, inert });
    }
  };
  walk(0, { x: 0, y: 0 }, { x: 0, y: 0, w: top.viewport.w, h: top.viewport.h }, false);
  return out;
}

// Gives each entry that names an element (`item.local`) its ref, frame by frame in one go.
export async function giveRefs(tabId, entries) {
  const byFrame = new Map();
  for (const e of entries) {
    if (e.item.local === undefined) continue;
    if (!byFrame.has(e.frameId)) byFrame.set(e.frameId, []);
    byFrame.get(e.frameId).push(e);
  }
  for (const [frameId, list] of byFrame) {
    const refs = await refsFor(tabId, frameId, list[0].page.document, list.map((e) => e.item.local));
    list.forEach((e, i) => (e.ref = refs[i]));
  }
  return entries;
}

// An element as operations report it: its ref first, without the content script's local id,
// rect and part in view; from a child frame with its frame id and the frame's origin.
export function reported(e, extra = {}) {
  const { local, rect, vis, ...rest } = e.item;
  void local;
  void rect;
  void vis;
  const out = { ref: e.ref, ...rest };
  if (e.frameId !== 0) {
    out.frame = e.frameId;
    out.origin = e.page.origin ?? null;
  }
  return Object.assign(out, extra);
}

// The ref of one element a frame described ({ local, role, name }).
export async function refOf(tabId, frameId, page, el) {
  if (!el) return null;
  const { local, ...rest } = el;
  const [ref] = await refsFor(tabId, frameId, page.document, [local]);
  return { ref, ...rest };
}

// The open modal dialog, as an element with `frame`, the frame whose document it makes inert
// outside it (and that frame's `origin` for a child frame): the top document's, else the first
// frame's that has one.
export async function modalOf(tabId, pages) {
  for (const [frameId, page] of pages.read) {
    if (!page.modal) continue;
    const m = { ...(await refOf(tabId, frameId, page, page.modal)), frame: frameId };
    if (frameId !== 0) m.origin = page.origin ?? null;
    return m;
  }
  return null;
}

export const tabRef = (tab) => ({ id: tab.id, title: tab.title ?? "", url: tab.url ?? "" });

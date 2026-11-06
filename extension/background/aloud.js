// Reading aloud, the page side (design §7.3): Kai holds the playback and the speech, the
// extension the read position. read.open lists the page's paragraphs (page.text_all's blocks, in
// reading order across frames) and where to start; read.paragraph gives one, as text and cleaned
// for speech (speech.js, as page text); read.mark draws the reading mark around one and scrolls
// it into view; read.close ends the session.
//
// - The paragraphs are the page's text when read.open ran; each frame keeps the nodes of its own
//   (aloud.js), so the mark follows the page as it moves.
// - A session ends when its tab shows another page (a navigation, Back and Forward included, or
//   a same-document navigation to another path), when its tab closes or Firefox discards it, when
//   the tab's page is not the one it read, when read.open opens another in the tab, and with
//   read.close; its calls then answer session_ended with why. The sessions belong to the link: a
//   new link starts without any.
// - Kai learns of an end it did not make itself when it happens: a read_ended event (events.js),
//   whether or not events are on, for every end but read.open's replacing and read.close.
// - Session ids rise across restarts of the extension (clock-based, as hints' generations), so an
//   id from before a restart is unknown_session, never another session.

import { define, OpError, about } from "./ops.js";
import * as link from "./link.js";
import { tabArg, takeKaiClose } from "./tabs.js";
import { onTopNavigation, readEnded } from "./events.js";
import { resolveRef, askElement, frameCall, documentCall } from "./pages.js";
import { readFrames, merge, tabRef } from "./compose.js";
import { refsFor } from "./refs.js";
import { cleanForSpeech, rulesProblem } from "./speech.js";

const sessions = new Map(); // id -> { id, tab, top, url, paragraphs, marked }
const ended = new Map(); // id -> { why, tab }
let lastId = 0;
const nextId = () => (lastId = Math.max(lastId + 1, Date.now()));

const pathOf = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
};

// The ends Kai made itself (read.open in the tab, read.close) and the link's: Kai needs no event.
const OWN = new Set(["replaced", "closed", "link"]);

// Ends a session: its mark and its nodes go from the frames that still show its page. `byKai`:
// Kai's own navigation or closing of the tab ended it; any other end Kai did not make is a
// read_ended event.
function end(s, why, { tidy = false, byKai = false } = {}) {
  if (!sessions.delete(s.id)) return;
  ended.set(s.id, { why, tab: s.tab });
  if (!OWN.has(why)) readEnded(s.id, s.tab, why, byKai);
  if (!tidy) return;
  const docs = new Set(s.paragraphs.map((p) => p.document));
  for (const doc of docs) browser.tabs.sendMessage(s.tab, { kai: "read_drop", session: s.id }, { documentId: doc }).catch(() => {});
}
const sessionsOf = (tabId) => [...sessions.values()].filter((s) => s.tab === tabId);

// The top frame's navigations, once events.js knows whether Kai began them.
onTopNavigation((d, same, byKai) => {
  for (const s of sessionsOf(d.tabId)) {
    if (!same) end(s, "navigated", { byKai });
    else if (pathOf(d.url) !== pathOf(s.url)) end(s, "navigated", { tidy: true, byKai });
    else s.url = d.url;
  }
});
browser.tabs.onRemoved.addListener((tabId) => {
  const byKai = takeKaiClose(tabId);
  for (const s of sessionsOf(tabId)) end(s, "tab_closed", { byKai });
});
browser.tabs.onUpdated.addListener(
  (tabId, change) => {
    if (change.discarded === true) for (const s of sessionsOf(tabId)) end(s, "discarded");
  },
  { properties: ["discarded"] },
);
link.onLost(() => {
  for (const s of [...sessions.values()]) end(s, "link", { tidy: true });
  ended.clear();
});

// The session `id` and its tab while it lives and the tab still shows its page; the errors
// otherwise.
async function live(id) {
  const s = sessions.get(id);
  if (!s) {
    if (ended.has(id)) throw sessionEnded(id, ended.get(id));
    throw new OpError("unknown_session", `there is no reading session ${id}: it was never opened, or it is from before Kai for Firefox restarted or the link to Kai began again`);
  }
  // The listeners above end a session as its tab changes; this is for what they did not see.
  const tab = await browser.tabs.get(s.tab).catch(() => null);
  const top = tab && !tab.discarded && (await browser.webNavigation.getFrame({ tabId: s.tab, frameId: 0 }).catch(() => null));
  if (!tab || tab.discarded || !top || top.documentId !== s.top) {
    end(s, !tab ? "tab_closed" : tab.discarded ? "discarded" : "page_changed");
    throw sessionEnded(id, ended.get(id));
  }
  return { s, tab };
}
const WHY = {
  navigated: "its tab went to another page",
  tab_closed: "its tab closed",
  discarded: "Firefox discarded its tab (unloaded it to free memory)",
  page_changed: "its tab shows another page than the one it read",
  replaced: "read.open began another session in its tab",
  closed: "read.close ended it",
};
const sessionEnded = (id, { why, tab }) => new OpError("session_ended", `reading session ${id} in tab ${tab} has ended: ${WHY[why] ?? why}`, { tab, why });

const indexIn = (s, index, name) => {
  if (index >= s.paragraphs.length) throw new OpError("bad_args", `${name}'s 'index' must be a paragraph of session ${s.id}: from 0 to ${s.paragraphs.length - 1}${s.paragraphs.length ? "" : " (it has none)"}`);
  return s.paragraphs[index];
};

define("read.open@1", {
  args: { tab: { type: "integer" }, ref: { type: "ref" } },
  async run({ tab: tabId, ref }) {
    if (tabId !== undefined && ref !== undefined) throw new OpError("bad_args", "read.open takes 'tab' or 'ref', not both: a ref names its tab");
    let tab;
    let at = null;
    if (ref !== undefined) {
      const r = await resolveRef(ref);
      // The ref's element must still be in its page.
      await askElement(ref, r.tab, r.entry, { kai: "describe" });
      tab = r.tab;
      at = { frame: r.entry.frame, document: r.entry.document, local: r.entry.local };
    } else tab = await tabArg(tabId);
    const id = nextId();
    const pages = await readFrames(tab, { kai: "read_open", session: id, at });
    const top = pages.read.get(0);
    if (at) {
      const holder = [...pages.read.values()].find((p) => p.document === at.document);
      if (holder?.gone) throw new OpError("stale_element", `ref ${ref}'s element is no longer in the page of tab ${tab.id}${holder.gone === "removed" ? " (the page removed it)" : ""}`, about(tab));
    }
    const entries = merge(pages, "blocks");
    const paragraphs = entries.map((e) => {
      const p = { frame: e.frameId, document: e.page.document, origin: e.page.origin ?? null, bi: e.item.bi, el: e.item.el_local, text: e.item.text, lang: e.item.lang ?? null, visible: e.visible, y: e.rect?.y ?? null };
      if (e.item.heading !== undefined) p.heading = e.item.heading;
      if (e.item.item) p.item = true;
      return p;
    });
    // Where to start: the ref's paragraph, else the focused element's, else the first in view.
    const firstFrom = (frameId, bi) => {
      const i = paragraphs.findIndex((p) => p.frame === frameId && p.bi >= bi);
      return i >= 0 ? i : null;
    };
    let start = null;
    let from = null;
    if (at) {
      const holder = [...pages.read.values()].find((p) => p.document === at.document);
      start = holder && holder.at !== null ? firstFrom(holder.frame, holder.at) : null;
      if (start !== null) from = "ref";
    } else {
      for (let f = top, seen = new Set(); f && f.focus && !seen.has(f.frame); f = pages.read.get(f.focus.frame)) {
        seen.add(f.frame);
        if (f.focus.at !== undefined) {
          if (f.focus.at !== null) start = firstFrom(f.frame, f.focus.at);
          break;
        }
      }
      if (start !== null) from = "focus";
    }
    if (start === null && paragraphs.length) {
      const inView = paragraphs.findIndex((p) => p.visible);
      const below = inView >= 0 ? inView : paragraphs.findIndex((p) => p.y !== null && p.y >= 0);
      start = below >= 0 ? below : 0;
      from = inView >= 0 ? "view" : below >= 0 ? "below_view" : "top";
    }
    for (const s of sessionsOf(tab.id)) end(s, "replaced", { tidy: true });
    sessions.set(id, { id, tab: tab.id, top: top.document, url: tab.url ?? "", paragraphs: paragraphs.map(({ visible, y, ...p }) => (void visible, void y, p)), marked: null });
    return { session: id, tab: tabRef(tab), paragraphs: paragraphs.length, start, from, frames: pages.frames };
  },
});

define("read.paragraph@1", {
  args: {
    session: { type: "integer", required: true, min: 1 },
    index: { type: "integer", required: true, min: 0 },
    rules: { type: "value", check: rulesProblem },
  },
  async run({ session, index, rules }) {
    const { s, tab } = await live(session);
    const p = indexIn(s, index, "read.paragraph");
    let ref = null;
    if (p.el !== undefined) [ref] = await refsFor(s.tab, p.frame, p.document, [p.el]);
    const out = { session, index, tab: tabRef(tab), text: p.text, spoken: cleanForSpeech(p.text, rules ?? {}, { page: true }), lang: p.lang, ref };
    if (p.heading !== undefined) out.heading = p.heading;
    if (p.item) out.item = true;
    return Object.assign(out, { frame: p.frame, origin: p.origin });
  },
});

// Brings a child frame's paragraph (its box `rect` in that frame's viewport) into the view of
// every document around it, up to the top; whether anything scrolled.
async function revealUp(tab, frameId, rect) {
  let scrolled = false;
  const frames = (await browser.webNavigation.getAllFrames({ tabId: tab.id })) ?? [];
  const parent = new Map(frames.map((f) => [f.frameId, f.parentFrameId]));
  for (let child = frameId; child !== 0 && rect; ) {
    const up = parent.get(child);
    if (up === undefined || up < 0) break;
    const r = await frameCall(tab, up, { kai: "frame_reveal", frame: child, rect }).catch(() => null);
    if (!r?.found) break;
    scrolled ||= r.scrolled;
    rect = r.rect;
    child = up;
  }
  return scrolled;
}

define("read.mark@1", {
  args: { session: { type: "integer", required: true, min: 1 }, index: { type: "integer", min: 0 } },
  async run({ session, index }) {
    const { s, tab } = await live(session);
    const clear = async () => {
      if (!s.marked) return;
      const was = s.marked;
      s.marked = null;
      await documentCall(tab, was.document, { kai: "read_unmark", session }).catch(() => {});
    };
    if (index === undefined) {
      await clear();
      return { session, index: null, marked: false, scrolled: false };
    }
    const p = indexIn(s, index, "read.mark");
    if (s.marked && s.marked.document !== p.document) await clear();
    let r;
    try {
      r = await documentCall(tab, p.document, { kai: "read_mark", session, bi: p.bi }, `the page of paragraph ${index} in tab ${tab.id}`);
    } catch (e) {
      if (e.code !== "stale_document") throw e;
      // The frame of the paragraph went to another page, or is gone: it cannot be marked.
      s.marked = null;
      return { session, index, marked: false, scrolled: false, why: "frame_left" };
    }
    s.marked = r.marked ? { document: p.document, index } : null;
    if (!r.marked) return { session, index, marked: false, scrolled: false, why: r.why };
    let scrolled = r.scrolled;
    if (p.frame !== 0) scrolled = (await revealUp(tab, p.frame, r.rect)) || scrolled;
    return { session, index, marked: true, scrolled };
  },
});

define("read.close@1", {
  args: { session: { type: "integer", required: true, min: 1 } },
  async run({ session }) {
    const s = sessions.get(session);
    if (!s) {
      if (ended.has(session)) return { session, closed: false, why: ended.get(session).why };
      throw new OpError("unknown_session", `there is no reading session ${session}: it was never opened, or it is from before Kai for Firefox restarted or the link to Kai began again`);
    }
    end(s, "closed", { tidy: true });
    return { session, closed: true };
  },
});

// The reading operations (design §5.3): the page's structure, its controls, links and fields,
// its text (the article, all of it, the part in view), an element's text, tables, the selection,
// find, and a PDF's bytes. Each answers structured JSON; Kai writes the lines (D2).

import { define, OpError, cancellable, about } from "./ops.js";
import { tabArg } from "./tabs.js";
import { frameCall, frameFile, elementCall, urlAccess, inTime, frameRefusal } from "./pages.js";
import { readFrames, merge, giveRefs, reported, refOf, modalOf, tabRef } from "./compose.js";
import { originOf } from "./url.js";
import { refsFor } from "./refs.js";

const TAB = { tab: { type: "integer" } };

define("page.outline@1", {
  args: TAB,
  async run({ tab: id }) {
    const tab = await tabArg(id);
    const pages = await readFrames(tab, { kai: "outline" });
    const entries = await giveRefs(tab.id, merge(pages, "items"));
    // The heading the user is reading: the first in view, else the last above the view.
    const headings = entries.filter((e) => e.item.role === "heading");
    const here = headings.find((e) => e.visible) ?? headings.filter((e) => e.rect && e.rect.y < 0).at(-1);
    return {
      tab: tabRef(tab),
      modal: await modalOf(tab.id, pages),
      items: entries.map((e) => reported(e, e === here ? { here: true } : {})),
      frames: pages.frames,
    };
  },
});

// The controls in view across frames, the open modal's only (design §5.3, page_controls); with
// each frame's entries, for hints. `top` (a documentId) pins the top frame's read to that
// document (readFrames').
export async function controlsIn(tab, { top = null } = {}) {
  const pages = await readFrames(tab, { kai: "controls", view: true }, { top });
  const modal = await modalOf(tab.id, pages);
  // A document with an open modal answered only the modal's controls, and only the frames inside
  // it.
  const entries = await giveRefs(tab.id, merge(pages, "items", { onlyVisible: true }));
  return { pages, entries, result: { tab: tabRef(tab), modal, controls: entries.map((e) => reported(e)), frames: pages.frames } };
}

define("page.controls@1", {
  args: TAB,
  async run({ tab: id }) {
    return (await controlsIn(await tabArg(id))).result;
  },
});

// Every link or field of the page, with whether it is in view.
function wholeList(kind) {
  return async ({ tab: id }) => {
    const tab = await tabArg(id);
    const pages = await readFrames(tab, { kai: kind });
    const entries = await giveRefs(tab.id, merge(pages, "items"));
    const list = entries.map((e) => {
      const extra = { in_view: e.visible };
      if (e.inert) extra.inert = true;
      return reported(e, extra);
    });
    return { tab: tabRef(tab), modal: await modalOf(tab.id, pages), [kind]: list, frames: pages.frames };
  };
}
define("page.links@1", { args: TAB, run: wholeList("links") });
define("page.fields@1", { args: TAB, run: wholeList("fields") });

// Text blocks as operations report them: { text, heading?, ref?, item?, frame?, origin? }, and a
// frame that could not be read where its <iframe> is: { frame, origin, unread: <code>, title }.
function block(e) {
  const { text, heading, item } = e.item;
  const b = { text };
  if (heading !== undefined) {
    b.heading = heading;
    b.ref = e.ref;
  }
  if (item) b.item = true;
  if (e.frameId !== 0) {
    b.frame = e.frameId;
    b.origin = e.page.origin ?? null;
  }
  return b;
}
const unreadFrame = (frame, origin, code, title) => ({ unread: true, item: { frame, origin, unread: code, title } });

// The tab's text blocks across frames, and the top document they were read from (readTop).
async function textRead(tab, view, { top = null } = {}) {
  const pages = await readFrames(tab, { kai: "text", view }, { top });
  const origins = new Map(pages.frames.unread_frames.map((u) => [u.frame, u.origin]));
  const entries = await giveRefs(tab.id, merge(pages, "blocks", { onlyVisible: view, unread: (p, err) => unreadFrame(p.frame, origins.get(p.frame) ?? null, err.code, p.title) }));
  return { result: { tab: tabRef(tab), blocks: entries.map((e) => (e.unread ? e.item : block(e))), frames: pages.frames }, top: readTop(pages.read.get(0)) };
}
const textOf = async (tab, view) => (await textRead(tab, view)).result;

// The top document an answer of its content script came from, as that script says: its
// documentId, its URL and its title when it answered.
const readTop = (a) => ({ document: a?.document ?? null, url: a?.url ?? null, title: a?.page_title ?? "" });

define("page.text_all@1", {
  args: TAB,
  async run({ tab: id }) {
    return textOf(await tabArg(id), false);
  },
});

define("page.text_visible@1", {
  args: TAB,
  async run({ tab: id }) {
    return textOf(await tabArg(id), true);
  },
});

define("page.text@1", {
  args: TAB,
  async run({ tab: id }) {
    return (await readText(await tabArg(id))).result;
  },
});

// page.text@1's reading of `tab` (the article, else all its text): { result, top }, `top` being
// the top document it read ({ document, url, title }, as its content script answered). With
// `document` (a documentId; the sidebar's Attach this page, design §8.1) every call to the top
// frame goes to that document alone, so a page that was left before or while it was read fails
// the read with page_changed instead of having the page after it read.
export async function readText(tab, { document = null } = {}) {
  const refused = await urlAccess(tab);
  if (refused) throw refused;
  const pin = { document };
  let a = await frameCall(tab, 0, { kai: "article" }, pin);
  if (a.error) {
    await frameFile(tab, 0, "vendor/readability.js", pin);
    a = await frameCall(tab, 0, { kai: "article" }, pin);
    if (a.error) throw new OpError("internal", `Readability did not load in tab ${tab.id}: ${a.error}`, about(tab));
  }
  if (!a.article) {
    const t = await textRead(tab, false, { top: document });
    return { result: { ...t.result, article: false, why: a.why }, top: t.top };
  }
  const page = { document: a.document };
  const entries = await giveRefs(
    tab.id,
    a.blocks.map((item) => ({ item, frameId: 0, page })),
  );
  const result = {
    tab: tabRef(tab),
    article: true,
    title: a.title,
    byline: a.byline,
    lang: a.lang,
    blocks: entries.map((e) => {
      const b = { text: e.item.text };
      if (e.item.heading !== undefined) {
        b.heading = e.item.heading;
        if (e.ref !== undefined) b.ref = e.ref;
      }
      if (e.item.item) b.item = true;
      return b;
    }),
    left_out: a.left_out,
  };
  return { result, top: readTop(a) };
}

// The child frames inside an element's text, read and put in place (their placeholders carry
// the frame id), recursively.
async function withFrames(tab, blocks, entry, seen = new Set()) {
  const out = [];
  for (const b of blocks) {
    if (!("frame" in b && "box" in b)) {
      out.push({ item: b, frameId: entry.frameId, page: entry.page });
      continue;
    }
    if (seen.has(b.frame)) continue;
    seen.add(b.frame);
    let page;
    try {
      page = await frameCall(tab, b.frame, { kai: "text" });
    } catch (e) {
      const url = (await browser.webNavigation.getFrame({ tabId: tab.id, frameId: b.frame }).catch(() => null))?.url;
      const why = await frameRefusal(url, e);
      out.push(unreadFrame(b.frame, originOf(url), why.code ?? "no_content", b.title));
      continue;
    }
    out.push(...(await withFrames(tab, page.blocks, { frameId: b.frame, page }, seen)));
  }
  return out;
}

define("element.text@1", {
  args: { ref: { type: "ref", required: true } },
  async run({ ref }) {
    const { tab, entry, r } = await elementCall(ref, { kai: "element_text" });
    const page = { document: entry.document, origin: r.origin };
    const entries = await giveRefs(tab.id, await withFrames(tab, r.blocks, { frameId: entry.frame, page }));
    const out = { ref, tab: tabRef(tab), role: r.el.role, name: r.el.name };
    if (r.el.level !== undefined) out.level = r.el.level;
    Object.assign(out, { section: r.section, blocks: entries.map((e) => (e.unread ? e.item : block(e))) });
    if (!r.shown) out.hidden = true;
    return out;
  },
});

define("table.read@1", {
  args: { ref: { type: "ref", required: true } },
  async run({ ref }) {
    const { tab, entry, r } = await elementCall(ref, { kai: "table" });
    if (!r.table) throw new OpError("not_a_table", `ref ${ref} (${r.el.role}${r.el.name ? ` '${r.el.name}'` : ""}) is no table and is in none`);
    const { local, ...t } = r.table;
    const [tableRef] = await refsFor(tab.id, entry.frame, entry.document, [local]);
    return { ref: tableRef, tab: tabRef(tab), ...t };
  },
});

define("page.selection@1", {
  args: TAB,
  async run({ tab: id }) {
    const tab = await tabArg(id);
    const pages = await readFrames(tab, { kai: "selection" });
    // The focused frame's selection first (down the focus from the top), else the first frame's.
    let focused = null;
    for (let f = pages.read.get(0), seen = new Set(); f && !seen.has(f.frame); f = pages.read.get(f.focus_frame)) {
      seen.add(f.frame);
      focused = f;
      if (f.focus_frame === null) break;
    }
    const page = [focused, ...pages.read.values()].find((p) => p?.selection);
    if (!page) return { tab: tabRef(tab), selection: null, frames: pages.frames };
    const { field, ...sel } = page.selection;
    const selection = { ...sel, field: await refOf(tab.id, page.frame, page, field) };
    if (page.frame !== 0) {
      selection.frame = page.frame;
      selection.origin = page.origin ?? null;
    }
    return { tab: tabRef(tab), selection, frames: pages.frames };
  },
});

// The text whose matches page.find left highlighted, by tab: a screenshot hides them and draws
// them again (see.js). Firefox drops them with the next find or a navigation.
export const findHighlights = new Map();
browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) findHighlights.delete(d.tabId);
});
browser.tabs.onRemoved.addListener((tabId) => findHighlights.delete(tabId));

define("page.find@1", {
  args: { text: { type: "string", required: true, nonEmpty: true }, ...TAB },
  async run({ text, tab: id }) {
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    await frameCall(tab, 0, { kai: "whoami" });
    const what = `tab ${tab.id}`;
    let found;
    try {
      found = await inTime(browser.find.find(text, { tabId: tab.id, includeRangeData: true }), what, tab);
    } catch (e) {
      if (e instanceof OpError) throw e;
      throw new OpError("no_content", `Firefox cannot search ${what}: ${e.message}`, about(tab));
    }
    const ranges = found.rangeData ?? [];
    // Firefox numbers the documents with matches in its frame order (framePos); which frame each
    // is, the frames tell by recognising the text nodes the ranges name.
    const groups = [];
    for (const r of ranges) (groups[r.framePos] ??= []).push(r);
    for (let i = 0; i < groups.length; i++) groups[i] ??= [];
    const frames = ((await browser.webNavigation.getAllFrames({ tabId: tab.id })) || []).map((f) => f.frameId);
    const tries = groups.length
      ? await Promise.all(
          frames.map((frameId) =>
            frameCall(tab, frameId, { kai: "find_resolve", groups, text }).then(
              (a) => ({ frameId, a }),
              () => null,
            ),
          ),
        )
      : [];
    // Matches in sensitive fields (and in Kai's own labels) are neither reported nor counted: a
    // placed one says so; for the ones that could not be placed, each frame counts the query in
    // its sensitive values, and as many unplaced matches go.
    const taken = new Set();
    const best = groups.map((g, gi) => {
      let pick = null;
      for (const t of tries) {
        if (!t || taken.has(t.frameId)) continue;
        const a = t.a.groups[gi];
        const score = a.verified * 2 + a.matches.filter((m) => m && !m.masked).length;
        if (!pick || score > pick.score) pick = { score, frameId: t.frameId, page: t.a, a };
      }
      if (pick) taken.add(pick.frameId);
      return pick;
    });
    let spare = tries.reduce((n, t) => n + (t && !taken.has(t.frameId) ? t.a.excluded : 0), 0);
    let dropped = 0;
    const matches = [];
    for (const [gi, g] of groups.entries()) {
      const pick = best[gi];
      const out = []; // [match, placed]
      let masked = 0;
      for (const [i, r] of g.entries()) {
        const m = pick?.a.matches[i];
        if (m?.masked) {
          masked++;
          continue;
        }
        const match = { text: r.text, element: null, sentence: null };
        if (m) {
          match.element = m.el ? await refOf(tab.id, pick.frameId, pick.page, m.el) : null;
          match.sentence = m.sentence;
          if (pick.frameId !== 0) {
            match.frame = pick.frameId;
            match.origin = pick.page.origin ?? null;
          }
        }
        out.push([match, !!m]);
      }
      let excess = pick ? Math.max(0, pick.page.excluded - masked) : spare;
      for (let i = out.length - 1; i >= 0 && excess > 0; i--) {
        if (out[i][1]) continue;
        out.splice(i, 1);
        excess--;
        dropped++;
        if (!pick) spare--;
      }
      dropped += masked;
      matches.push(...out.map(([match]) => match));
    }
    const count = Math.max(0, found.count - dropped);
    if (count > 0) {
      await inTime(browser.find.highlightResults({ tabId: tab.id, noScroll: true }), what, tab);
      findHighlights.set(tab.id, text);
    } else findHighlights.delete(tab.id);
    return { tab: tabRef(tab), text, count, highlighted: count > 0, matches };
  },
});

// Firefox's PDF viewer is no page an extension can read; the background fetches the PDF's URL
// again itself, with its host permission and the user's cookies, and Kai extracts the text. The
// request is a new one: the extension's requests do not share the tab's cache entry. A cancel
// ends the fetch. `url` is where the bytes came from, after redirects.
define("pdf.bytes@1", {
  args: TAB,
  async run({ tab: id }, { signal }) {
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    let readable = false;
    try {
      await frameCall(tab, 0, { kai: "whoami" });
      readable = true;
    } catch (e) {
      if (e.code !== "pdf_viewer" && e.code !== "no_content") throw e;
    }
    if (readable) throw new OpError("not_pdf", `tab ${tab.id} shows a page, not a PDF in Firefox's viewer`, about(tab));
    let res;
    let bytes;
    try {
      res = await cancellable(signal, fetch(tab.url, { credentials: "include", signal }));
      if (!res.ok) throw new OpError("fetch_failed", `the PDF of tab ${tab.id} answered HTTP ${res.status} ${res.statusText}`.trim(), { ...about(tab), response_url: res.url });
      bytes = new Uint8Array(await cancellable(signal, res.arrayBuffer()));
    } catch (e) {
      if (e instanceof OpError) throw e;
      throw new OpError("fetch_failed", `Kai for Firefox could not fetch the PDF of tab ${tab.id}: ${e.message}`, about(tab));
    }
    const type = res.headers.get("content-type") || "";
    const magic = bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
    if (!magic && !/pdf/i.test(type)) {
      throw new OpError("not_pdf", `the PDF's URL now answers ${type ? `'${type}'` : "without a content type"} and no PDF; tab ${tab.id} shows the PDF of an earlier answer`, { ...about(tab), response_url: res.url });
    }
    return { tab: tabRef(tab), url: res.url, content_type: type || null, bytes: bytes.length, base64: base64(bytes) };
  },
});

function base64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

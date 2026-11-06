// Styles (design §5.7): page.css adds a style sheet to a page at the user origin, page.css_remove
// takes it out again by its id. Sheets last until the page is left.
//
// A user-origin sheet beats the page's own rules only with !important, so every declaration is
// made !important: the text is parsed with a CSSStyleSheet (this background page has a DOM), each
// declaration of its style rules marked, and the sheet's own serialization inserted. replaceSync
// drops what it does not understand without an error, so each rule and declaration of the text is
// also parsed on its own (csssplit.js), and what the parser dropped is listed.
//
// A user !important rule would also beat the inline !important of Kai's overlay host, so every
// selector's subject excludes the host's marker attribute (K.marker, random per document). Not
// @scope: a scoped rule's plain selectors no longer reach the root element (html, :root), measured
// in Firefox 159. url( ) in a sheet is a GET to its site: what the text to insert fetches is read
// from it parsed again (cssfetch.js), and a sheet is added only when every origin it fetches from
// is in fetch_origins, the origins Kai's owner approved (page.css_check lists them before Kai
// asks); one with a var( ) where a file is named is refused (css_var_url). The sheet goes into the
// document Kai approved, by its id, so a page left meanwhile gets none (page_changed).
//
// scripting.removeCSS needs the exact text, so the background keeps it per id, and Firefox keeps
// one sheet per text in a document (two equal inserts, one remove: none left). A page that Back or
// Forward restores from the back-forward cache still carries the sheets it had when it was left;
// they ended with the leaving, so every text ever inserted into that tab's frame is removed again
// then (a lesson from an earlier extension). The records and the texts ever inserted are kept in storage.session:
// a suspended background keeps them; a restarted extension starts without them, as Firefox takes
// an extension's sheets out of the pages when it unloads it. Ids come from a counter in
// storage.local that starts again at 1 only when Firefox starts, so an id is never reused within a
// Firefox run.

import { define, OpError, about } from "./ops.js";
import { tabArg } from "./tabs.js";
import { urlAccess, approvedTop, pageLeft } from "./pages.js";
import { tabRef } from "./compose.js";
import { split, clean, GROUPS, guardSelector, selectorList } from "./csssplit.js";
import { cssFetches, blockOf } from "./cssfetch.js";

const SHEET = "css:"; // + id -> { tab, frame, document, css, ended }
const EVER = "css_ever:"; // + tab:frame -> [texts]
const sheets = new Map();
const ever = new Map();
let nextId = 1;
let fresh = false;

const ready = Promise.all([
  browser.storage.session.get(null).then((all) => {
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(SHEET)) sheets.set(Number(k.slice(SHEET.length)), v);
      else if (k.startsWith(EVER)) ever.set(k.slice(EVER.length), new Set(v));
    }
  }),
  browser.storage.local.get("css_next").then(({ css_next }) => {
    if (!fresh && Number.isSafeInteger(css_next) && css_next > nextId) nextId = css_next;
  }),
]).catch((e) => console.warn(`Kai for Firefox: the inserted style sheets were not read: ${e.message}`));
const keep = (patch) => browser.storage.session.set(patch).catch((e) => console.warn(`Kai for Firefox: the style sheets were not kept: ${e.message}`));
const forget = (keys) => browser.storage.session.remove(keys).catch(() => {});

// One tab's insertions and removals run in order: a restore's clean-up before a later insert.
const queues = new Map();
function serial(tabId, fn) {
  const next = (queues.get(tabId) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(tabId, tail);
  tail.then(() => {
    if (queues.get(tabId) === tail) queues.delete(tabId);
  });
  return next;
}

const parser = new CSSStyleSheet();
const parsed = (text) => {
  try {
    parser.replaceSync(text);
    return parser.cssRules;
  } catch {
    return [];
  }
};
// Whether the parser keeps a declaration, or a rule nested in a style rule.
const declKept = (text) => parsed(`.kai{${text}}`)[0]?.style.length > 0;
const nestedKept = (text) => parsed(`.kai{${text}}`)[0]?.cssRules?.length > 0;

// What the parser drops of `items` (csssplit.js), as the texts page.css names.
function dropped(list, inStyle = false) {
  const out = [];
  for (const it of list) {
    if (it.kind === "decl") {
      if (inStyle ? !declKept(it.text) : !parsed(it.text).length) out.push(clean(it.text));
      continue;
    }
    const kept = inStyle ? nestedKept(it.text) : parsed(it.text).length > 0;
    if (!kept) out.push(`${it.prelude} { … }`);
    else if (!it.prelude.startsWith("@")) out.push(...dropped(it.body, true));
    else if (GROUPS.test(it.prelude)) out.push(...dropped(it.body, inStyle));
  }
  return out;
}

// Marks every declaration of the style rules (nested ones too) !important; keyframes, @font-face
// and the other descriptor blocks stay as they are. The number of rules marked.
function markAll(rules) {
  let n = 0;
  for (const r of rules) {
    if (r instanceof CSSKeyframesRule) continue;
    if (r instanceof CSSStyleRule || r instanceof CSSPageRule || r.constructor.name === "CSSNestedDeclarations") {
      // Through the declarations' text, so a shorthand with var() (whose longhands read empty)
      // keeps its value.
      r.style.cssText = split(r.style.cssText)
        .map((d) => (/!\s*important\s*$/i.test(d.text) ? d.text : `${d.text} !important`))
        .join("; ");
      n++;
    }
    if (r.cssRules) n += markAll(r.cssRules);
  }
  return n;
}

// Keeps every style rule (nested ones too) off elements that carry `marker`; a rule whose
// selector Firefox would not take with the guard is taken out and named in `out`.
function guardAll(list, marker, out) {
  for (let i = list.cssRules.length - 1; i >= 0; i--) {
    const r = list.cssRules[i];
    if (r instanceof CSSStyleRule) {
      const was = r.selectorText;
      r.selectorText = guardSelector(was, marker);
      if (!selectorList(r.selectorText).every((one) => one.includes(`[${marker}]`))) {
        list.deleteRule(i);
        out.push(`${was} { … } (it could not be kept off Kai's own labels)`);
        continue;
      }
    }
    if (r.cssRules && !(r instanceof CSSKeyframesRule)) guardAll(r, marker, out);
  }
}

// The text of every declaration block of `rules`, nested ones too: a rule's style, or the block
// of a rule with neither style nor rules (@property, @counter-style); never a selector or prelude.
function declarations(rules, out = []) {
  for (const r of rules) {
    if (r.style) out.push(r.style.cssText);
    if (r.cssRules) declarations(r.cssRules, out);
    else if (!r.style) out.push(blockOf(r.cssText));
  }
  return out;
}

// The text to insert for `css`, kept off elements carrying `marker`: { text, rules, dropped,
// fetches, var_urls }. What it fetches is read from that text parsed again: what Firefox inserts.
function prepare(css, marker) {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch (e) {
    return { text: "", rules: 0, dropped: [`the whole text (${e.message})`], fetches: [], var_urls: [] };
  }
  const unguarded = [];
  guardAll(sheet, marker, unguarded);
  const rules = markAll(sheet.cssRules);
  const text = [...sheet.cssRules].map((r) => r.cssText).join("\n");
  const inserted = new CSSStyleSheet();
  inserted.replaceSync(text);
  const all = [...inserted.cssRules];
  const { fetches, vars } = cssFetches(
    declarations(all),
    all.filter((r) => !(r instanceof CSSNamespaceRule)).map((r) => r.cssText),
  );
  return { text, rules, dropped: [...dropped(split(css)), ...unguarded], fetches, var_urls: vars };
}

const everKey = (tab, frame) => `${tab}:${frame}`;

// A new top-level document in a tab ends the sheets of every other document there; a page
// restored by Back or Forward is cleared of every text ever inserted into its frames.
browser.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await ready;
  const ended = {};
  for (const [id, s] of sheets) {
    if (s.tab === d.tabId && s.document !== d.documentId && !s.ended) {
      s.ended = true;
      ended[SHEET + id] = s;
    }
  }
  const back = (d.transitionQualifiers ?? []).includes("forward_back");
  if (back) {
    for (const [id, s] of sheets) {
      if (s.tab === d.tabId && s.document === d.documentId && !s.ended) {
        s.ended = true;
        ended[SHEET + id] = s;
      }
    }
  }
  if (Object.keys(ended).length) keep(ended);
  if (!back) return;
  serial(d.tabId, async () => {
    const frames = (await browser.webNavigation.getAllFrames({ tabId: d.tabId }).catch(() => [])) ?? [];
    for (const f of frames) {
      for (const css of ever.get(everKey(d.tabId, f.frameId)) ?? []) {
        await browser.scripting.removeCSS({ target: { tabId: d.tabId, frameIds: [f.frameId] }, css, origin: "USER" }).catch(() => {});
      }
    }
  });
});
browser.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const keys = [];
  for (const [id, s] of sheets) {
    if (s.tab !== tabId) continue;
    sheets.delete(id);
    keys.push(SHEET + id);
  }
  for (const k of ever.keys()) {
    if (!k.startsWith(`${tabId}:`)) continue;
    ever.delete(k);
    keys.push(EVER + k);
  }
  if (keys.length) forget(keys);
});

const originList = (v) => (Array.isArray(v) && v.every((o) => typeof o === "string" && o.trim()) ? null : "a list of origins (strings)");
// page.css's and page.css_check's refusals of a prepared sheet, in this order: nothing understood,
// then a var( ) where a file is named.
function refuse(p, extra = {}) {
  const forTab = extra.tab ? ` for tab ${extra.tab}` : "";
  if (!p.rules && !p.text) throw new OpError("bad_css", `nothing in the style sheet${forTab} was understood`, { ...extra, dropped: p.dropped });
  if (p.var_urls.length) {
    throw new OpError(
      "css_var_url",
      `the style sheet${forTab} uses var( ) inside url( ), image-set( ) or another function that loads a file (listed in uses), so what it would load is known only once the page is styled; write the URL itself`,
      { ...extra, uses: p.var_urls },
    );
  }
}

// What page.css would add, without a tab: what the parser drops and what the sheet fetches, for
// Kai to name in its confirmation.
define("page.css_check@1", {
  args: { css: { type: "string", required: true, nonEmpty: true } },
  async run({ css }) {
    const p = prepare(css, "data-kai-check");
    refuse(p);
    return { rules: p.rules, dropped: p.dropped, fetches: p.fetches };
  },
});

define("page.css@1", {
  args: {
    css: { type: "string", required: true, nonEmpty: true },
    origin: { type: "string", required: true, nonEmpty: true },
    fetch_origins: { type: "value", check: originList },
    tab: { type: "integer" },
  },
  async run({ css, origin, fetch_origins: fetchOrigins, tab: id }) {
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    const top = await approvedTop(tab, origin, "no style sheet was added");
    const p = prepare(css, top.marker);
    refuse(p, about(tab));
    const approved = new Set(fetchOrigins ?? []);
    const unapproved = p.fetches.filter((f) => !approved.has(f.origin));
    if (unapproved.length) {
      throw new OpError("fetch_not_approved", `the style sheet for tab ${tab.id} loads files from origins not in fetch_origins, so it was not added`, { ...about(tab), fetches: unapproved });
    }
    await ready;
    return serial(tab.id, async () => {
      try {
        await browser.scripting.insertCSS({ target: { tabId: tab.id, documentIds: [top.document] }, css: p.text, origin: "USER" });
      } catch (e) {
        if (pageLeft(e)) throw new OpError("page_changed", `the page Kai approved in tab ${tab.id} was left before the style sheet was added, so it was not added`, about(await browser.tabs.get(tab.id).catch(() => tab)));
        throw new OpError("no_content", `Firefox did not add the style sheet to tab ${tab.id}: ${e.message}`, about(tab));
      }
      const sheetId = nextId++;
      const rec = { tab: tab.id, frame: 0, document: top.document, css: p.text, ended: false };
      sheets.set(sheetId, rec);
      const k = everKey(tab.id, 0);
      if (!ever.has(k)) ever.set(k, new Set());
      ever.get(k).add(p.text);
      browser.storage.local.set({ css_next: nextId }).catch((e) => console.warn(`Kai for Firefox: the style sheet counter was not kept: ${e.message}`));
      keep({ [SHEET + sheetId]: rec, [EVER + k]: [...ever.get(k)] });
      return { id: sheetId, tab: tabRef(tab), rules: p.rules, important: true, dropped: p.dropped, fetches: p.fetches };
    });
  },
});

define("page.css_remove@1", {
  args: { id: { type: "integer", required: true, min: 1 } },
  async run({ id }) {
    await ready;
    const s = sheets.get(id);
    if (!s) throw new OpError("unknown_css", `Kai for Firefox has no style sheet ${id}: it was never added, was removed already, its tab closed, or it is from before the extension restarted (which took its sheets out of the pages)`);
    sheets.delete(id);
    forget([SHEET + id]);
    const tab = await browser.tabs.get(s.tab).catch(() => null);
    if (!tab) return { id, tab: { id: s.tab, title: "", url: "" }, removed: false, why: "tab_closed" };
    return serial(tab.id, async () => {
      const now = await browser.webNavigation.getFrame({ tabId: tab.id, frameId: s.frame }).catch(() => null);
      if (s.ended || now?.documentId !== s.document) return { id, tab: tabRef(tab), removed: false, why: "page_left" };
      // Another sheet of the same text in that document keeps it.
      const shared = [...sheets.values()].some((o) => o.tab === s.tab && o.frame === s.frame && o.document === s.document && !o.ended && o.css === s.css);
      if (!shared) {
        try {
          await browser.scripting.removeCSS({ target: { tabId: tab.id, frameIds: [s.frame] }, css: s.css, origin: "USER" });
        } catch (e) {
          throw new OpError("no_content", `Firefox did not remove style sheet ${id} from tab ${tab.id}: ${e.message}`, about(tab));
        }
      }
      return { id, tab: tabRef(tab), removed: true };
    });
  },
});

// runtime.onStartup: Firefox started, and sheet ids begin again at 1.
export function browserStarted() {
  fresh = true;
  nextId = 1;
  return browser.storage.local.set({ css_next: 1 });
}

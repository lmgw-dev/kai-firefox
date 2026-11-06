// Hands (design §5.4): the acting operations, the commit guard's page side, the focus check of
// the trusted path and Kai's input spans (§6.3, §6.4). The content script (content/act.js) acts
// with synthetic events; the background routes by ref, runs the network gate (gate.js) around the
// action and reads the element again after the gate's window.
//
// Every acting operation takes `guard`, Kai's commit guard for this call: "off", or the word
// list, the network window and how long a held request waits for Kai's answer. `confirmed` (the
// verdicts Kai asked the user about, as the guard answered them) lets a press or a key through
// the page side when every verdict that applies then is among them; the network gate asks all the
// same.

import { define, OpError, about, cancellable } from "./ops.js";
import { tabArg } from "./tabs.js";
import { resolveRef, askElement, frameCall, documentCall, urlAccess } from "./pages.js";
import { tabRef } from "./compose.js";
import { refsFor } from "./refs.js";
import * as gate from "./gate.js";
import * as user from "./user.js";
import * as link from "./link.js";
import { parseKeys } from "./keys.js";
import { settings } from "./settings.js";
import { kaiActs } from "./events.js";

const MAX_MS = 2 ** 31 - 1;
const GUARD_IS = `"off", or {"words": [strings], "window_ms": a whole number from 0 to ${MAX_MS}, "answer_ms": a whole number from 1 to ${MAX_MS}}`;
function checkGuard(v) {
  if (v === "off") return null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return GUARD_IS;
  for (const k of Object.keys(v)) if (!["words", "window_ms", "answer_ms"].includes(k)) return `${GUARD_IS}; it has no '${k}'`;
  if (!Array.isArray(v.words) || v.words.some((w) => typeof w !== "string")) return `${GUARD_IS}; words is a list of strings`;
  if (!Number.isSafeInteger(v.window_ms) || v.window_ms < 0 || v.window_ms > MAX_MS) return `${GUARD_IS}; window_ms is out of range`;
  if (!Number.isSafeInteger(v.answer_ms) || v.answer_ms < 1 || v.answer_ms > MAX_MS) return `${GUARD_IS}; answer_ms is out of range`;
  return null;
}
const GUARD = { type: "value", required: true, check: checkGuard };
const VERDICT_KEYS = ["reason", "word", "where", "text", "action", "origin", "method"];
const CONFIRMED_IS = `a list of the guard's verdicts Kai asked the user about, each as the guard answered it: {"reason": …} with ${VERDICT_KEYS.slice(1).join(", ")} as strings (origin may be null)`;
function checkConfirmed(v) {
  if (!Array.isArray(v)) return CONFIRMED_IS;
  for (const c of v) {
    if (typeof c !== "object" || c === null || Array.isArray(c) || typeof c.reason !== "string") return CONFIRMED_IS;
    for (const [k, x] of Object.entries(c)) {
      if (!VERDICT_KEYS.includes(k)) return `${CONFIRMED_IS}; a verdict has no '${k}'`;
      if (typeof x !== "string" && !(k === "origin" && x === null)) return `${CONFIRMED_IS}; its '${k}' is no string`;
    }
  }
  return null;
}
const CONFIRMED = { type: "value", check: checkConfirmed };
const REF = { type: "ref", required: true };
const TAB = { type: "integer" };

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function checkFiles(v) {
  const is = `a non-empty list of {"name": a non-empty string, "type": a string, "base64": the file's bytes in base64}`;
  if (!Array.isArray(v) || !v.length) return is;
  for (const f of v) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) return is;
    for (const k of Object.keys(f)) if (!["name", "type", "base64"].includes(k)) return `${is}; a file has no '${k}'`;
    if (typeof f.name !== "string" || !f.name.trim()) return `${is}; a file's name is missing`;
    if (f.type !== undefined && f.type !== null && typeof f.type !== "string") return `${is}; '${f.name}' has a type that is no string`;
    if (typeof f.base64 !== "string" || f.base64.length % 4 !== 0 || !B64.test(f.base64)) return `${is}; the base64 of '${f.name}' is not base64`;
  }
  return null;
}

// What the content script gets of the guard: the words, or null when the guard is off.
const pageGuard = (guard) => (guard === "off" ? null : { words: guard.words });
const withoutLocal = (d) => {
  const out = { ...d };
  delete out.local;
  return out;
};

// An element the content script described ({ local, ...}) of the document `entry` names, with its
// ref (and frame and origin from a child frame).
async function withRef(tab, frame, document, origin, d) {
  if (!d) return null;
  const [ref] = await refsFor(tab.id, frame, document, [d.local]);
  const out = { ref, ...withoutLocal(d) };
  if (frame !== 0) Object.assign(out, { frame, origin: origin ?? null });
  return out;
}

// A refusal of the content script's ({ code, message, ...more }) as the operation's error.
const failed = (r, tab) => {
  const { code, message, ...more } = r.error;
  return new OpError(code, message, { ...about(tab), ...more });
};
// An error after the gate held requests: they go with it, each with its decision.
const withRequests = (e, requests) => {
  if (requests?.length && e instanceof OpError) e.extra = { ...e.extra, requests };
  return e;
};
const tabNow = async (tab) => tabRef(await browser.tabs.get(tab.id).catch(() => tab));

// The element after the window: its Control, or why it cannot be read ("page_left": its page was
// left, a navigation for one; "removed": the page removed it; else the error's code).
async function after(ref, tab) {
  try {
    const { entry } = await resolveRef(ref);
    return { el: (await askElement(ref, tab, entry, { kai: "act_state" })).r.el };
  } catch (e) {
    return { gone: e.code === "stale_document" || e.code === "stale_tab" ? "page_left" : e.code === "stale_element" ? "removed" : (e.code ?? "internal") };
  }
}

// The gate's requests once its window has closed (window_ms after the action when it ran, at once
// when it did not) and each is decided; undefined without a gate.
async function settled(g, ran, signal) {
  if (!g) return undefined;
  if (ran) gate.arm(g);
  else gate.close(g);
  return gate.settle(g, signal);
}

// An acting operation on a ref's element: the network gate watches the element's document from
// before the action until window_ms after it, then every request it held is decided, then the
// element is read again. `msg` is the content script's act message.
async function act(ref, msg, guard, ctx, opts = {}) {
  const { tab, entry } = await resolveRef(ref);
  // Events of the tab while it runs, its guard window included, are Kai's (by_kai).
  const done = await kaiActs(tab.id);
  try {
    return await actOn(ref, tab, entry, msg, guard, ctx, opts);
  } finally {
    done();
  }
}
async function actOn(ref, tab, entry, msg, guard, { signal, id }, { confirmed = [], view = false, keys = false }) {
  const g = view || guard === "off" ? null : await gate.open({ tab: tab.id, document: entry.document, frame: entry.frame, guard, op: id });
  let r;
  try {
    ({ r } = await askElement(ref, tab, entry, { kai: "act", ...msg, ref, guard: view ? null : pageGuard(guard), confirmed }, { keys }));
  } catch (e) {
    throw withRequests(e, await settled(g, false, signal));
  }
  if (r.error) throw withRequests(failed(r, tab), await settled(g, false, signal));
  const extra = {};
  for (const [k, v] of Object.entries(r.result ?? {})) {
    // Elements the action names (the drag's target) get their refs.
    extra[k] = v && typeof v === "object" && "local" in v ? await withRef(tab, entry.frame, entry.document, r.origin, v) : v;
  }
  const { local, ...firstEl } = r.el;
  // The element acted on: the ref's own, or one it stands for (a label's file input, the scroll
  // container around it).
  const [actedRef] = local === undefined ? [ref] : await refsFor(tab.id, entry.frame, entry.document, [local]);
  const requests = await settled(g, !!r.acted, signal);
  const out = { ref: actedRef, tab: r.acted ? await tabNow(tab) : tabRef(tab) };
  if (entry.frame !== 0) Object.assign(out, { frame: entry.frame, origin: r.origin ?? null });
  const now = r.acted ? await after(actedRef, tab) : { el: r.el };
  if (now.el) Object.assign(out, withoutLocal(now.el));
  else Object.assign(out, firstEl, { after: now.gone });
  Object.assign(out, extra);
  if (r.guard) out.guard = r.guard;
  if (requests && (r.acted || requests.length)) out.requests = requests;
  return out;
}

define("element.press@1", {
  args: { ref: REF, activate: { type: "boolean" }, guard: GUARD, confirmed: CONFIRMED },
  run: ({ ref, activate = true, guard, confirmed = [] }, ctx) => act(ref, { kind: "press", activate }, guard, ctx, { confirmed }),
});

define("element.fill@1", {
  args: { ref: REF, text: { type: "string", required: true }, guard: GUARD },
  run: ({ ref, text, guard }, ctx) => act(ref, { kind: "fill", text, until: Date.now() + settings.keys_ms, keys_ms: settings.keys_ms }, guard, ctx, { keys: true }),
});

define("element.choose@1", {
  args: { ref: REF, option: { type: "string", required: true, nonEmpty: true }, guard: GUARD },
  run: ({ ref, option, guard }, ctx) => act(ref, { kind: "choose", option }, guard, ctx),
});

define("element.check@1", {
  args: { ref: REF, on: { type: "boolean", required: true }, guard: GUARD },
  run: ({ ref, on, guard }, ctx) => act(ref, { kind: "check", on }, guard, ctx),
});

define("element.file@1", {
  args: { ref: REF, files: { type: "value", required: true, check: checkFiles }, guard: GUARD },
  run: ({ ref, files, guard }, ctx) => act(ref, { kind: "file", files: files.map((f) => ({ name: f.name, type: f.type ?? "", base64: f.base64 })) }, guard, ctx),
});

define("element.focus@1", {
  args: { ref: REF, guard: GUARD },
  run: ({ ref, guard }, ctx) => act(ref, { kind: "focus" }, guard, ctx),
});

define("element.hover@1", {
  args: { ref: REF, guard: GUARD },
  run: ({ ref, guard }, ctx) => act(ref, { kind: "hover" }, guard, ctx),
});

define("element.drag@1", {
  args: { ref: REF, to: REF, guard: GUARD },
  async run({ ref, to, guard }, ctx) {
    const [a, b] = await Promise.all([resolveRef(ref), resolveRef(to)]);
    if (a.entry.document !== b.entry.document) {
      throw new OpError("other_document", `ref ${ref} and ref ${to} are in different pages or frames; a drag moves within one document`, about(a.tab));
    }
    return act(ref, { kind: "drag", to_local: b.entry.local, to_ref: to }, guard, ctx);
  },
});

define("element.show@1", {
  args: { ref: REF },
  run: ({ ref }, ctx) => act(ref, { kind: "show" }, "off", ctx, { view: true }),
});

const TO = { type: "string", required: true, values: ["down", "up", "top", "bottom"] };

define("element.scroll@1", {
  args: { ref: REF, to: TO, guard: GUARD },
  run: ({ ref, to, guard }, ctx) => act(ref, { kind: "scroll", to }, guard, ctx),
});

// The frame whose document has the keyboard focus, from the top document down: its answer to
// focus_where ({ frame, document, origin, has_focus, focus }) and its frame id.
async function focusedFrame(tab) {
  let frameId = 0;
  const seen = new Set();
  for (;;) {
    const w = await frameCall(tab, frameId, { kai: "focus_where" });
    seen.add(frameId);
    if (w.focus?.frame && !seen.has(w.focus.frame)) {
      frameId = w.focus.frame;
      continue;
    }
    return { frameId, where: w };
  }
}

// An operation on a whole page (page.scroll, page.key): the gate on the document `where` names.
async function pageAct(tab, frameId, where, msg, guard, { signal, id }) {
  const done = await kaiActs(tab.id);
  try {
    const g = guard === "off" ? null : await gate.open({ tab: tab.id, document: where.document, frame: frameId, guard, op: id });
    let r;
    try {
      r = await documentCall(tab, where.document, msg);
    } catch (e) {
      throw withRequests(e, await settled(g, false, signal));
    }
    if (r.error) throw withRequests(failed(r, tab), await settled(g, false, signal));
    const requests = await settled(g, !!r.acted, signal);
    return { r, requests: requests && (r.acted || requests.length) ? requests : undefined };
  } finally {
    done();
  }
}

define("page.scroll@1", {
  args: { tab: TAB, to: TO, guard: GUARD },
  async run({ tab: id, to, guard }, ctx) {
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    const top = await frameCall(tab, 0, { kai: "whoami" });
    const { r, requests } = await pageAct(tab, 0, top, { kai: "act_page_scroll", to }, guard, ctx);
    const out = { tab: await tabNow(tab), container: await withRef(tab, 0, top.document, top.origin, r.container), ...r.result };
    if (requests) out.requests = requests;
    return out;
  },
});

define("page.key@1", {
  args: { tab: TAB, keys: { type: "value", required: true, check: (v) => (typeof v === "string" && v.length ? null : `a key such as "Enter", "Escape" or "ctrl+k"`) }, guard: GUARD, confirmed: CONFIRMED },
  async run({ tab: id, keys, guard, confirmed = [] }, ctx) {
    const key = parseKeys(keys);
    if (key.error) throw new OpError("bad_args", `page.key@1's 'keys': ${key.error}`);
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    const { frameId, where } = await focusedFrame(tab);
    const { r, requests } = await pageAct(tab, frameId, where, { kai: "act_key", key, guard: pageGuard(guard), confirmed }, guard, ctx);
    const out = { tab: await tabNow(tab), keys: key.text, target: await withRef(tab, frameId, where.document, where.origin, r.target) };
    if (r.result) Object.assign(out, r.result);
    if (r.guard) out.guard = r.guard;
    if (requests) out.requests = requests;
    return out;
  },
});

// focus.check (design §6.3): before Kai's trusted key, whether the ref's element has the keyboard
// focus: its tab shown, its window focused, the page (not Firefox's own UI) holding the focus,
// and the element the active element of its document, through frames. With `guard` and the
// focus there, it opens the network gate gate.result reads, which also notes the trusted key the
// element's document gets.
define("focus.check@1", {
  args: { ref: REF, guard: { type: "value", check: checkGuard } },
  async run({ ref, guard }, { id }) {
    const { tab, entry } = await resolveRef(ref);
    const out = { ref, tab: tabRef(tab), focused: false };
    if (!tab.active) return { ...out, focus: "other_tab" };
    const win = await browser.windows.get(tab.windowId);
    if (!win.focused) {
      const top = await browser.windows.getLastFocused().catch(() => null);
      return { ...out, focus: top?.focused && top.id !== win.id && !top.incognito ? "other_window" : "outside" };
    }
    const top = await frameCall(tab, 0, { kai: "focus_where" });
    if (!top.has_focus) return { ...out, focus: "firefox" };
    const { frameId, where } = await focusedFrame(tab);
    const el = where.focus?.el;
    if (!el) return { ...out, focus: "nothing" };
    if (where.document === entry.document && el.local === entry.local) {
      out.focused = true;
      if (guard && guard !== "off") out.gate = (await gate.open({ tab: tab.id, document: entry.document, frame: entry.frame, guard, op: id, kept: true, aim: entry.local })).id;
      return out;
    }
    return { ...out, focus: "element", element: await withRef(tab, frameId, where.document, where.origin, el) };
  },
});

// gate.open (design §6.3, WP12): a kept gate on the ref's document, or on the top document of a
// tab, without focus.check's question of where the keyboard focus is: Kai's press through
// accessibility needs no focus. Read by gate.result like focus.check's, which also says the
// trusted click the document got (click_seen). A tab whose page extensions cannot reach (one of
// Firefox's own pages) gets no gate: `gate` is null and `why` its error's code.
define("gate.open@1", {
  args: { ref: { type: "ref" }, tab: TAB, guard: GUARD },
  async run({ ref, tab: tabId, guard }, { id }) {
    if ((ref === undefined) === (tabId === undefined)) throw new OpError("bad_args", "gate.open@1 takes either 'ref' or 'tab'");
    if (guard === "off") throw new OpError("bad_args", "gate.open@1 opens a gate, which needs a guard: its window_ms and answer_ms");
    if (ref !== undefined) {
      const { tab, entry } = await resolveRef(ref);
      const g = await gate.open({ tab: tab.id, document: entry.document, frame: entry.frame, guard, op: id, kept: true, aim: entry.local });
      return { ref, tab: tabRef(tab), gate: g.id };
    }
    const tab = await tabArg(tabId);
    const refused = await urlAccess(tab);
    if (refused) return { tab: tabRef(tab), gate: null, why: refused.code };
    const top = await frameCall(tab, 0, { kai: "whoami" });
    const g = await gate.open({ tab: tab.id, document: top.document, frame: 0, guard, op: id, kept: true });
    return { tab: tabRef(tab), gate: g.id };
  },
});

define("gate.result@1", {
  args: { gate: { type: "integer", required: true, min: 1 } },
  async run({ gate: id }, { signal }) {
    const r = await gate.result(id, signal);
    const out = { gate: id, requests: r.requests, key_seen: null, click_seen: null };
    const { tab, frame, document, origin } = r.at;
    if (r.key_seen) out.key_seen = { key: r.key_seen.key, element: await withRef({ id: tab }, frame, document, origin, r.key_seen.el) };
    if (r.click_seen) out.click_seen = { element: await withRef({ id: tab }, frame, document, origin, r.click_seen.el) };
    if (r.expired_at !== null) Object.assign(out, { expired: true, expired_at: r.expired_at });
    return out;
  },
});

// The trusted keydowns and clicks the documents that kept gates watch report (kai.js; user.js
// reads the same user_input messages for the tab facts).
browser.runtime.onMessage.addListener((m, sender) => {
  if (sender.id !== browser.runtime.id || !sender.tab || !sender.documentId) return undefined;
  if (m?.kai === "user_input" && m.key) gate.keySeen(sender.documentId, m.key.gates, { key: m.key.key, el: m.key.el });
  if (m?.kai === "click_seen" && Array.isArray(m.seen)) gate.clickSeen(sender.documentId, m.seen);
  return undefined;
});

// element.mark and element.unmark (design §6.3, WP12): Kai's press through accessibility finds
// the ref's element on the accessibility bus by a mark it carries for that moment, an aria-
// attribute Firefox gives the bus as the object attribute `kai-mark` (aria- dropped). The value is
// new for each mark (128 random bits), so no other element carries it unless the page copied it;
// element.unmark takes it away again from every element of the document, and so does a link that
// drops, and the content script itself MARK_TTL_MS after setting it (a constant of the contract).
// The answer names the element's role and name and its frames' addresses, top page first, which
// Kai compares with the element it finds on the bus. A ref in a tab Kai cannot reach is the ref's
// error, as for any element operation.
const MARK_ATTRIBUTE = "aria-kai-mark";
// How long a mark lives at most: the content script takes it away by itself after this (the
// contract's MARK_TTL_MS, docs/protocol/operations.md).
const MARK_TTL_MS = 5000;
const marks = new Map(); // value -> { tab, document }
const markValue = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
// The addresses of the frames from the top page down to `frame` (its own `url` last), as
// webNavigation has them; null when a frame between is not listed.
async function frameChain(tab, frame, url) {
  if (frame === 0) return [url];
  const all = (await browser.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) ?? [];
  const byId = new Map(all.map((f) => [f.frameId, f]));
  const chain = [url];
  for (let id = byId.get(frame)?.parentFrameId; id !== undefined && id >= 0; id = byId.get(id)?.parentFrameId) {
    const f = byId.get(id);
    if (!f) return null;
    chain.unshift(f.url);
  }
  return chain;
}
define("element.mark@1", {
  args: { ref: REF },
  async run({ ref }) {
    const { tab, entry } = await resolveRef(ref);
    const value = markValue();
    const { r } = await askElement(ref, tab, entry, { kai: "mark", value, ttl_ms: MARK_TTL_MS });
    marks.set(value, { tab: tab.id, document: entry.document });
    const frames = await frameChain(tab, entry.frame, r.url);
    const out = { ref, tab: tabRef(tab), role: r.el.role, name: r.el.name, attribute: MARK_ATTRIBUTE, object_attribute: "kai-mark", value, url: r.url, frames };
    if (entry.frame !== 0) Object.assign(out, { frame: entry.frame, origin: r.origin ?? null });
    return out;
  },
});
const unmark = async (value) => {
  const m = marks.get(value);
  if (!m) return null;
  marks.delete(value);
  try {
    const tab = await browser.tabs.get(m.tab);
    return (await documentCall(tab, m.document, { kai: "unmark", value })).removed;
  } catch {
    return 0; // the tab or the page is gone, and the mark with it
  }
};
define("element.unmark@1", {
  args: { value: { type: "string", required: true, nonEmpty: true } },
  async run({ value }) {
    const removed = await unmark(value);
    if (removed === null) throw new OpError("unknown_mark", "no mark of that value is set: element.mark set none with it, or element.unmark took it away already, or the link dropped since");
    return { value, removed };
  },
});
link.onLost(() => {
  for (const value of [...marks.keys()]) unmark(value);
});

// Kai's input spans (design §6.3): Kai's trusted input through the desktop goes between
// input.begin and input.end, so that it is not taken for the user's (user.js).
// span id -> the end of its by_kai mark (events.js)
const spanActs = new Map();
define("input.begin@1", {
  args: {},
  async run() {
    const span = user.beginSpan();
    spanActs.set(span, await kaiActs(null));
    return { span };
  },
});
const endSpanAct = (span) => {
  spanActs.get(span)?.();
  spanActs.delete(span);
};

define("input.end@1", {
  args: { span: { type: "integer", required: true, min: 1 }, settle_ms: { type: "integer", required: true, min: 0, max: MAX_MS } },
  async run({ span, settle_ms }, { signal }) {
    if (!user.closeSpan(span)) throw new OpError("unknown_span", `no input span ${span} is open: input.begin opened none with this id, input.end ended it already, or the extension restarted or the link dropped since`);
    let tabs;
    try {
      await cancellable(signal, new Promise((resolve) => setTimeout(resolve, settle_ms)));
    } finally {
      // Ended also when Kai cancels the wait.
      tabs = user.endSpan(span);
      endSpanAct(span);
    }
    return { span, tabs: tabs ?? [] };
  },
});
link.onLost(() => {
  user.endAllSpans();
  for (const span of [...spanActs.keys()]) endSpanAct(span);
});

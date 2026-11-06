// The commit guard's network gate (design §6.4): while a gate is open, every POST, PUT, PATCH
// and DELETE that the gate's document sends, and every GET navigation of it to another origin the
// user has never visited (history.js), is held (webRequest.onBeforeRequest, blocking) and Kai is
// asked about it with an `ask` frame: method, URL and the decoded body, the values of the page's
// sensitive fields masked. Kai's `answer` lets it go or cancels it (the page sees a network
// error); a request without an answer within the guard's answer_ms, or whose operation Kai
// cancels, is cancelled.
//
// A gate opens before an acting operation runs and stays open until window_ms after the action
// (`arm`); the operation answers once the window has closed and every request it held is decided.
// A gate that focus.check or gate.open opens for Kai's trusted key or its press through
// accessibility (design §6.3) is kept until gate.result reads it: its window runs until window_ms
// after gate.result arrives, or ends answer_ms after it opened (it expired: gate.result says so).
// An expired gate nobody reads is dropped answer_ms after it expired. Such a gate also notes the
// first trusted keydown and the first trusted click its document gets (key_seen, click_seen).
//
// Not held, as a trade-off against noise (design §6.4, item 31): requests of type `beacon`
// (navigator.sendBeacon) and `ping` (a link's ping attribute). WP10 found them nearly all of the
// gate's questions on real sites, the pages' telemetry. The cost: a write a page makes by beacon
// because of Kai's action (a "Cancel order" link whose handler sends one) goes unasked; the page
// side's words still ask before such a press where the extension can see that the link acts by
// script (content/act.js, plainLink). A fetch with `keepalive` is held like any fetch: webRequest
// reports it as `xmlhttprequest` and does not say whether it carries credentials before it is sent.
//
// Which requests are the document's: those whose documentId is the gate's (fetch, XHR,
// subresources). A navigation carries no documentId: it is the document's when it replaces it
// (same frame, which still shows the document), loads into a frame the document holds
// (parentDocumentId), or was started by a document at the document's URL (originUrl: a form or
// link that targets _top, _parent or another frame). With several gates open on one document, a
// request goes to the oldest.
//
// The blocking listener is added while a gate is open or a question is waiting, so pages are not
// slowed otherwise. Registering a listener reaches Firefox's parent process asynchronously; a
// listener added at the top level makes Firefox load its webRequest module when the background
// starts, so a later registration is handled before the next call, and open() makes one call.

import * as link from "./link.js";
import { documentCall } from "./pages.js";
import { OpError } from "./ops.js";
import { decodeBody, maskText } from "./body.js";
import { originOf } from "./url.js";
import { seenByUser } from "./history.js";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const NAVIGATIONS = new Set(["main_frame", "sub_frame"]);
// Never held (above): mostly the page's telemetry.
export const TELEMETRY = new Set(["beacon", "ping"]);
const gates = new Map(); // id -> gate (open, deciding, or kept until gate.result), oldest first
const asks = new Map(); // ask id -> { gate, decide(decision) }
let nextGate = 1;
let nextAsk = 1;
let listening = false;

// Loads Firefox's webRequest module at the background's start (see above); it matches nothing.
browser.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["http://kai-firefox.invalid/*"] });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// Whether a gate is open on a tab now: what commits there is Kai's doing (history.js).
export const openOn = (tabId) => [...gates.values()].some((g) => g.open && g.tab === tabId);

// A gate on `document` (a documentId) of tab `tab`, frame `frame`, for operation `op`; `guard` is
// the operation's { window_ms, answer_ms }. `kept`: focus.check's or gate.open's, read by
// gate.result; `aim`: the local id of the element it was opened for (click_seen).
export async function open({ tab, document, frame, guard, op, kept = false, aim = null }) {
  const g = {
    id: nextGate++,
    tab,
    document,
    frame,
    op,
    window_ms: guard.window_ms,
    answer_ms: guard.answer_ms,
    kept,
    open: true,
    until: null,
    timer: 0,
    requests: [],
    pending: 0,
    inflight: 0,
    done: deferred(),
    finished: false,
    aborted: null,
    values: [],
    origin: null,
    key_seen: null,
    click_seen: null,
    expired_at: null,
  };
  gates.set(g.id, g);
  if (!listening) {
    browser.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"] }, ["blocking", "requestBody"]);
    listening = true;
  }
  // A call Firefox's parent process handles after the listener's registration; then the
  // document's own start: its sensitive values and origin, and for focus.check's gate the
  // trusted keydown it will report (content/act.js).
  const t = await browser.tabs.get(tab).catch(() => null);
  if (t) {
    try {
      const r = await documentCall(t, document, { kai: "gate_open", gate: g.id, keys: kept, aim });
      g.values = r.values ?? [];
      g.origin = r.origin ?? null;
    } catch {
      /* the document cannot answer: the operation finds out */
    }
  }
  if (kept) g.timer = setTimeout(() => expire(g), g.answer_ms);
  return g;
}

// The action ran: the window closes window_ms from now.
export function arm(g) {
  if (!g.open) return;
  clearTimeout(g.timer);
  g.until = Date.now() + g.window_ms;
  if (g.window_ms === 0) closeWindow(g);
  else g.timer = setTimeout(() => closeWindow(g), g.window_ms);
}

// The action did not run (it failed, the guard stopped it, it only focused): no window. Requests
// already held, or being matched, are still decided.
export const close = (g) => closeWindow(g);

function closeWindow(g) {
  clearTimeout(g.timer);
  g.open = false;
  if (g.until === null) g.until = Date.now();
  finishCheck(g);
}

// A kept gate whose gate.result did not come within answer_ms: its window ends, and writes after
// it are not held. gate.result still reads it, answer_ms more.
function expire(g) {
  g.expired_at = Date.now();
  closeWindow(g);
  g.dropTimer = setTimeout(() => {
    if (gates.get(g.id) === g) gates.delete(g.id);
  }, g.answer_ms);
}

function finishCheck(g) {
  if (g.open || g.pending > 0 || g.inflight > 0 || g.finished) return;
  g.finished = true;
  g.done.resolve();
  if (!g.kept) gates.delete(g.id);
  browser.tabs
    .get(g.tab)
    .then((t) => documentCall(t, g.document, { kai: "gate_end", gate: g.id }))
    .catch(() => {});
  stopListening();
}

function stopListening() {
  if (!listening || asks.size || [...gates.values()].some((g) => g.open || g.inflight > 0)) return;
  browser.webRequest.onBeforeRequest.removeListener(onRequest);
  listening = false;
}

// Kai stopped waiting (cancel), the link dropped or the tab closed: the window closes, and the
// requests still waiting, and any held from now on, are decided `decision` (cancelled).
export function abort(g, decision = "cancelled") {
  g.aborted ??= decision;
  closeWindow(g);
  for (const a of [...asks.values()]) if (a.gate === g) a.decide(decision);
}

// The requests the gate held, each with Kai's decision, once its window has closed and every one
// is decided. A `signal` that aborts (Kai's cancel, or the link closing) aborts the gate and
// rejects with its reason.
export async function settle(g, signal) {
  const onAbort = () => abort(g, signal.reason?.code === "closed" ? "no_link" : "cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await g.done.promise;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  signal?.throwIfAborted();
  return g.requests.map((r) => ({ ...r }));
}

// gate.result: Kai has sent its trusted key; the window runs window_ms from now. Its requests,
// the trusted key the document got (`key_seen`, the element as the content script described it),
// and when it expired.
export async function result(id, signal) {
  const g = gates.get(id);
  if (!g || !g.kept) {
    throw new OpError("unknown_gate", `no gate ${id} is waiting to be read: focus.check opened none with this id, gate.result read it already, it expired and was not read within its answer_ms, or the extension restarted or the link dropped since`);
  }
  clearTimeout(g.dropTimer);
  if (g.open) arm(g);
  try {
    const requests = await settle(g, signal);
    return { requests, key_seen: g.key_seen, click_seen: g.click_seen, expired_at: g.expired_at, at: { tab: g.tab, frame: g.frame, document: g.document, origin: g.origin } };
  } finally {
    gates.delete(id);
  }
}

// A trusted keydown a document reported while kept gates on it watched (kai.js): the first one
// each gate saw while its window was open.
export function keySeen(documentId, gateIds, key) {
  for (const id of gateIds) {
    const g = gates.get(id);
    if (g && g.document === documentId && g.open && !g.key_seen) g.key_seen = key;
  }
}

// A trusted click a document reported while kept gates on it watched (kai.js): the first one each
// gate saw while its window was open; `seen` is [{ gate, el }], each gate's element as the content
// script described it for that gate (its own element when the click was on it or inside it, else
// the nearest control), so two kept gates in one document each get their own.
export function clickSeen(documentId, seen) {
  for (const s of seen) {
    const g = gates.get(s?.gate);
    if (g && g.document === documentId && g.open && !g.click_seen) g.click_seen = { el: s.el ?? null };
  }
}

link.onAnswer((id, allow) => {
  const a = asks.get(id);
  return a ? a.decide(allow ? "allowed" : "declined") : false;
});
link.onLost(() => {
  for (const g of [...gates.values()]) {
    abort(g, "no_link");
    if (g.kept) gates.delete(g.id);
  }
  for (const a of [...asks.values()]) a.decide("no_link");
});
browser.tabs.onRemoved.addListener((tabId) => {
  for (const g of [...gates.values()]) if (g.tab === tabId) abort(g, "tab_closed");
});

// Blocking listener: undefined (no change, no wait) for what no open gate may hold. The open
// gates of the tab count the request as in flight until it is matched and decided, so a window
// that ends meanwhile still waits for it.
function onRequest(d) {
  if (TELEMETRY.has(d.type)) return undefined;
  const write = WRITES.has(d.method);
  if (!write && !(d.method === "GET" && NAVIGATIONS.has(d.type))) return undefined;
  const candidates = [...gates.values()].filter((g) => g.open && g.tab === d.tabId);
  if (!candidates.length) return undefined;
  for (const g of candidates) g.inflight++;
  return hold(d, candidates, Date.now(), write);
}

async function gateOf(d, candidates) {
  for (const g of candidates) {
    if (d.documentId) {
      if (d.documentId === g.document) return g;
      continue;
    }
    if (!NAVIGATIONS.has(d.type)) continue;
    if (d.type === "sub_frame" && d.parentDocumentId === g.document) return g;
    const f = await browser.webNavigation.getFrame({ tabId: d.tabId, frameId: g.frame }).catch(() => null);
    if (f?.documentId !== g.document) continue;
    if (d.frameId === g.frame) return g;
    if (d.originUrl && d.originUrl === f.url) return g;
  }
  return null;
}

async function hold(d, candidates, at, write) {
  const release = (except = null) => {
    for (const c of candidates) {
      c.inflight--;
      if (c !== except) finishCheck(c);
    }
    stopListening();
  };
  let g = null;
  let shown = null;
  let reason = "write";
  try {
    g = await gateOf(d, candidates);
    if (g && g.until !== null && at > g.until) g = null;
    if (g && !write) {
      // A GET navigation: held only to another origin than the document's that the user never
      // visited (history.js), since its URL can carry data out.
      const target = originOf(d.url);
      const from = g.origin ?? originOf(d.originUrl);
      if (!target || target === from || (await seenByUser(target))) g = null;
      else reason = "unseen_origin";
    }
    if (g) shown = await masked(g, d);
  } catch (e) {
    console.warn(`Kai for Firefox: the network gate could not look at ${d.method} ${d.url}: ${e.message}`);
    g = null;
  }
  if (!g) {
    release();
    return {};
  }
  const rec = { method: d.method, url: shown.url, type: d.type, reason, decision: "pending" };
  if (d.frameId !== g.frame) rec.frame = d.frameId;
  g.requests.push(rec);
  g.pending++;
  release(g);
  const id = nextAsk++;
  const decided = new Promise((resolve) => {
    const timer = setTimeout(() => decide("timeout"), g.answer_ms);
    function decide(decision) {
      if (!asks.has(id)) return false;
      asks.delete(id);
      clearTimeout(timer);
      rec.decision = decision;
      g.pending--;
      resolve(decision === "allowed");
      finishCheck(g);
      stopListening();
      return true;
    }
    asks.set(id, { gate: g, decide });
  });
  if (g.aborted) asks.get(id).decide(g.aborted);
  else {
    const frame = { id, op: g.op, gate: g.id, tab: g.tab, frame: d.frameId, origin: shown.origin, method: d.method, url: shown.url, type: d.type, reason, body: shown.body };
    if (!link.ask(frame)) asks.get(id)?.decide("no_link");
  }
  finishCheck(g);
  const allow = await decided;
  if (!allow) console.info(`Kai for Firefox: ${d.method} ${shown.url} from tab ${g.tab} cancelled (${rec.decision})`);
  return allow ? {} : { cancel: true };
}

// The body and URL as Kai is shown them: decoded, then masked by the document's content script,
// which knows the sensitive fields' values now and those they had while the gate was open. When it
// cannot answer, the body is withheld rather than shown unmasked, and the URL is masked with the
// values the fields had when the gate opened.
async function masked(g, d) {
  const body = decodeBody(d.requestBody);
  try {
    const tab = await browser.tabs.get(g.tab);
    const r = await documentCall(tab, g.document, { kai: "mask", gate: g.id, body, url: d.url }, `the page of tab ${g.tab}`);
    return { body: r.body, url: r.url, origin: r.origin };
  } catch (e) {
    return {
      body: body === null ? null : { kind: "withheld", why: `the page could not mask its sensitive fields in it: ${e.message}` },
      url: maskText(d.url, g.values),
      origin: g.origin ?? originOf(d.originUrl ?? d.documentUrl ?? ""),
    };
  }
}

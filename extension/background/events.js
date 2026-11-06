// Events (design §7.1): what changed in the user's tab, sent to Kai as `event` frames while Kai
// has them on (events.config@1). Kai speaks them as announcements and lists them in
// browser_context (§5.1, §7.2); the extension only reports.
//
// - Off until Kai turns them on; a new link starts with them off. While off nothing is watched
//   and nothing is sent.
// - Only the user's tab (D9) is watched: its frames' content scripts (listen.js) report live
//   regions, field errors, dialogs and the focus, in batches; the background reports its loads,
//   navigations and the tabs its pages open. When the user's tab changes, the old one stops and
//   the new one starts. A download that finished is reported whatever tab started it; the watched
//   tab's own downloads are attributed to it when Firefox's responses say so (webRequest).
// - Every event of a tab carries the frame and its document's origin, so Kai drops what comes
//   from a site whose rule is `none` (§6.4).
// - Order: each event is stamped (`at`) when the background learns of it and goes through one
//   chain, so the frames reach Kai in that order; link.js numbers them (`seq`).
// - read_ended (design §7.3) is the one event that is not about the user's tab: the end of a
//   reading session in any tab, which aloud.js reports through readEnded(). It goes whether or not
//   events are on, since reading aloud is its own feature and Kai needs the end either way.
// - `by_kai`: Kai caused it, as far as the extension can tell: it came while an acting operation
//   of Kai ran in the tab or an input span was open (the frames of the watched tab are told when
//   that begins and ends), or from a navigation Kai began.

import { define, OpError } from "./ops.js";
import * as link from "./link.js";
import { userTab } from "./tabs.js";
import { frameCall } from "./pages.js";
import { refsFor, forget } from "./refs.js";
import { originOf } from "./url.js";
import { onKaiNavigation } from "./history.js";
import { settings } from "./settings.js";

const NONE = browser.windows.WINDOW_ID_NONE;
const config = { on: false, quiet_ms: null };
// The tab whose frames watch, and the quiet_ms they were told.
let watched = null;
let toldQuiet = null;
// The URL the last `navigated` of the watched tab said, or the tab's when watching began.
let watchedUrl = null;
// Rewatches in order: each one's tab is looked up after the previous one's.
let gen = 0;
// A window of this Firefox has the desktop's keyboard focus.
let focused = false;
browser.windows.getLastFocused().then(
  (w) => (focused = !!w.focused),
  () => {},
);
browser.windows.onFocusChanged.addListener((id) => {
  focused = id !== NONE;
  rewatch();
});

// ---- Kai acting ----
// How many acting operations of Kai run in each tab, and how many input spans are open.
const actingIn = new Map();
let spans = 0;
let toldActing = false;
const actsOn = (tabId) => spans > 0 || (actingIn.get(tabId) ?? 0) > 0;

// Kai begins to act in tab `tabId` (null: an input span, which counts for every tab). Resolves,
// once the watched tab's frames know, to the function that ends it.
export async function kaiActs(tabId) {
  if (tabId === null) spans++;
  else actingIn.set(tabId, (actingIn.get(tabId) ?? 0) + 1);
  await tellActing();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (tabId === null) spans--;
    else {
      const n = actingIn.get(tabId) - 1;
      if (n > 0) actingIn.set(tabId, n);
      else actingIn.delete(tabId);
    }
    tellActing();
  };
}
async function tellActing() {
  if (!config.on || watched === null) return;
  const now = actsOn(watched);
  if (now === toldActing) return;
  toldActing = now;
  const tabId = watched;
  const frames = (await browser.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [];
  await Promise.all(frames.map((f) => browser.tabs.sendMessage(tabId, { kai: "events_acting", acting: now }, { frameId: f.frameId }).catch(() => {})));
}

// Navigations Kai began (tabs.open, tabs.go, Back, Forward, Reload, Reader view), or that began
// while Kai acted in the tab, by tab, until they commit (or nav_load_ms passes); and whether the
// tab's last committed page was one.
const kaiNavs = new Map(); // tabId -> timer
const pageByKai = new Map(); // tabId -> boolean
function markKaiNav(tabId) {
  clearTimeout(kaiNavs.get(tabId));
  kaiNavs.set(
    tabId,
    setTimeout(() => kaiNavs.delete(tabId), settings.nav_load_ms),
  );
}
function takeKaiNav(tabId) {
  if (!kaiNavs.has(tabId)) return false;
  clearTimeout(kaiNavs.get(tabId));
  kaiNavs.delete(tabId);
  return true;
}
onKaiNavigation(markKaiNav);
browser.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0 && actsOn(d.tabId)) markKaiNav(d.tabId);
});

// ---- watching ----
const watchMsg = (on, tabId) => ({ kai: "events_watch", on, quiet_ms: config.quiet_ms, acting: on && actsOn(tabId) });

// Tells every frame of a tab to watch or to stop. Watching injects the content script into a page
// that loaded before the extension started; stopping only reaches frames that have one.
async function tell(tabId, on) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const frames = (await browser.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [];
  await Promise.all(frames.map((f) => (on ? frameCall(tab, f.frameId, watchMsg(true, tabId)) : browser.tabs.sendMessage(tabId, watchMsg(false, tabId), { frameId: f.frameId })).catch(() => {})));
}

// Moves the watching to the user's tab now (none while events are off or the user is in a
// private window).
async function rewatch() {
  const mine = ++gen;
  let tab = null;
  if (config.on) {
    try {
      tab = await userTab();
    } catch {
      tab = null;
    }
  }
  if (mine !== gen) return;
  const id = tab?.id ?? null;
  const old = watched;
  const quiet = config.quiet_ms;
  if (old === id && (id === null || toldQuiet === quiet)) return;
  watched = id;
  toldQuiet = quiet;
  if (old !== id) watchedUrl = tab?.url ?? null;
  toldActing = id !== null && actsOn(id);
  if (old !== null && old !== id) await tell(old, false);
  if (id !== null) await tell(id, true);
}

for (const ev of [browser.tabs.onActivated, browser.tabs.onAttached, browser.tabs.onDetached, browser.windows.onRemoved]) ev.addListener(() => rewatch());
browser.tabs.onRemoved.addListener((tabId) => {
  for (const [url, r] of requests) if (r.tab === tabId) requests.delete(url);
  actingIn.delete(tabId);
  pageByKai.delete(tabId);
  clearTimeout(kaiNavs.get(tabId));
  kaiNavs.delete(tabId);
  if (tabId === watched) {
    watched = null;
    rewatch();
  }
});
// A document of the watched tab parsed: its frame starts watching (its content script waits for
// the parse itself, so an earlier word would come too soon for a new page).
browser.webNavigation.onDOMContentLoaded.addListener(async (d) => {
  if (!config.on || d.tabId !== watched) return;
  const tab = await browser.tabs.get(d.tabId).catch(() => null);
  if (tab) frameCall(tab, d.frameId, watchMsg(true, d.tabId)).catch(() => {});
});

// A new link starts with events off: Kai turns them on after each welcome.
link.onLost(() => {
  if (!config.on) return;
  config.on = false;
  config.quiet_ms = null;
  listenRequests(false);
  rewatch();
});

// ---- sending ----
// The events go out one after another in the order the background learned of them.
let chain = Promise.resolve();
const inOrder = (what, fn) => {
  const p = chain.then(fn).catch((e) => console.warn(`Kai for Firefox: ${what} was not sent: ${e.message}`));
  chain = p;
  return p;
};

// Sends one event of `kind` with its fields, stamped `at`; a tab's events carry the tab's id,
// title and URL (as the errors about a tab do), the frame and its origin.
function emit(kind, at, fields, tab = null, frame = null, origin = null) {
  const e = { kind, at, focused };
  if (tab) Object.assign(e, { tab: tab.id, title: tab.title ?? "", url: tab.url ?? "", frame, origin });
  link.event(Object.assign(e, fields));
}

// The origin of a frame as webNavigation shows it: its URL's, else (about:blank, about:srcdoc)
// its parent's, which it inherited.
async function frameOrigin(tabId, frameId) {
  const seen = new Set();
  for (let id = frameId; id !== -1 && !seen.has(id); ) {
    seen.add(id);
    const f = await browser.webNavigation.getFrame({ tabId, frameId: id }).catch(() => null);
    if (!f) return null;
    if (!/^about:(blank|srcdoc)$/.test(f.url)) return originOf(f.url);
    id = f.parentFrameId;
  }
  return null;
}

// The background's events: the top document's navigations and loads, tabs a page opened.
function topEvent(d, kind, fields) {
  if (!config.on || d.tabId !== watched || d.frameId !== 0) return;
  const at = Date.now();
  inOrder(`a ${kind} event of tab ${d.tabId}`, async () => {
    if (!config.on || d.tabId !== watched) return;
    const tab = await browser.tabs.get(d.tabId).catch(() => null);
    if (!tab || tab.incognito) return;
    emit(kind, at, fields, tab, 0, originOf(d.url));
  });
}
// What follows the top frame's navigations once their by_kai is known: (details, same_document,
// by_kai), for every one, whichever tab and whether events are on (aloud.js ends its sessions
// with them, after `navigated` was queued).
const navigationHooks = [];
export const onTopNavigation = (fn) => navigationHooks.push(fn);
function navigated(d, same) {
  if (d.frameId !== 0) return;
  const byKai = takeKaiNav(d.tabId) || actsOn(d.tabId);
  if (!same) pageByKai.set(d.tabId, byKai);
  // A history call that keeps the URL (replaceState of the same URL, the same fragment again)
  // says nothing new.
  if (config.on && d.tabId === watched && !(same && d.url === watchedUrl)) {
    watchedUrl = d.url;
    topEvent(d, "navigated", { by_kai: byKai, same_document: same });
  }
  for (const fn of navigationHooks) fn(d, same, byKai);
}
browser.webNavigation.onCommitted.addListener((d) => navigated(d, false));
browser.webNavigation.onHistoryStateUpdated.addListener((d) => navigated(d, true));
browser.webNavigation.onReferenceFragmentUpdated.addListener((d) => navigated(d, true));
browser.webNavigation.onCompleted.addListener((d) => topEvent(d, "loaded", { by_kai: pageByKai.get(d.tabId) ?? false }));
browser.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  if (!config.on || d.sourceTabId !== watched) return;
  const at = Date.now();
  const byKai = actsOn(d.sourceTabId);
  inOrder(`a tab_opened event of tab ${d.sourceTabId}`, async () => {
    const [tab, opened] = await Promise.all([browser.tabs.get(d.sourceTabId).catch(() => null), browser.tabs.get(d.tabId).catch(() => null)]);
    if (!tab || tab.incognito) return;
    const origin = await frameOrigin(d.sourceTabId, d.sourceFrameId);
    const win = opened?.windowId ?? d.windowId ?? null;
    emit("tab_opened", at, { by_kai: byKai, opened_tab: d.tabId, opened_url: d.url, opened_window: win, new_window: win !== tab.windowId }, tab, d.sourceFrameId, origin);
  });
});

// A reading session ended without Kai's read.open or read.close (aloud.js): `read_ended`, with
// `why` (see the contract). It carries the tab's id and nothing of its page (the tab may show
// another site now, or be gone), and goes whether or not events are on. Kai's site rules do not
// apply to it: it says nothing of any page. Never kept for a later link.
export function readEnded(session, tab, why, byKai) {
  const at = Date.now();
  inOrder(`a read_ended event of session ${session}`, async () => {
    emit("read_ended", at, { by_kai: byKai, session, tab, why });
  });
}

// ---- downloads ----
// The navigations the watched tab's documents began that have not committed (a navigation that
// becomes a download never does), by URL, each redirect's URL included; a download whose URL is
// one of them came from that tab. The listener is blocking (it changes nothing, so a navigation
// waits one round trip to the background): a non-blocking one hears of a request after Firefox
// has created the download it became, even after a small one finished (measured with Firefox
// 159, for onBeforeRequest and onHeadersReceived alike). It is there for every tab's navigations
// while events are on, so it is registered before the user's tab can start a download.
const requests = new Map(); // url -> { tab, frame, origin, by_kai }
const attributions = new Map(); // download id -> { source, by_kai }
const onRequest = (d) => {
  if (d.tabId !== watched || d.incognito) return;
  requests.set(d.url, { tab: d.tabId, frame: d.frameId, origin: originOf(d.originUrl ?? ""), by_kai: actsOn(d.tabId) });
};
function listenRequests(listen) {
  const has = browser.webRequest.onBeforeRequest.hasListener(onRequest);
  if (listen && !has) browser.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] }, ["blocking"]);
  if (!listen && has) browser.webRequest.onBeforeRequest.removeListener(onRequest);
  if (!listen) {
    requests.clear();
    attributions.clear();
  }
}
browser.webNavigation.onCommitted.addListener((d) => {
  for (const [url, r] of requests) if (r.tab === d.tabId && r.frame === d.frameId) requests.delete(url);
});
// The navigation a download came from, taken from the waiting ones.
function takeRequest(item) {
  const key = [item.finalUrl, item.url].find((u) => u && requests.has(u));
  if (!key) return null;
  const r = requests.get(key);
  requests.delete(key);
  return r;
}
browser.downloads.onCreated.addListener((item) => {
  if (!config.on || item.incognito) return;
  const source = takeRequest(item);
  attributions.set(item.id, { source, by_kai: !!source?.by_kai || spans > 0 });
});
browser.downloads.onErased.addListener((id) => attributions.delete(id));
browser.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (!state || state === "in_progress") return;
  const attributed = attributions.get(delta.id) ?? null;
  attributions.delete(delta.id);
  if (!config.on || state !== "complete") return;
  const at = Date.now();
  inOrder(`a download_done event of download ${delta.id}`, async () => {
    const [d] = await browser.downloads.search({ id: delta.id }).catch(() => []);
    if (!d || d.incognito) return;
    let source = null;
    // A download created before its request was seen is matched now.
    const s = attributed?.source ?? takeRequest(d);
    if (s) {
      const tab = await browser.tabs.get(s.tab).catch(() => null);
      source = { tab: s.tab, title: tab?.title ?? null, url: tab?.url ?? null, frame: s.frame, origin: s.origin };
    }
    emit("download_done", at, {
      by_kai: !!(attributed?.by_kai || s?.by_kai),
      file: (d.filename || "").split("/").pop(),
      path: d.filename || "",
      size: Number.isSafeInteger(d.fileSize) && d.fileSize >= 0 ? d.fileSize : null,
      url: d.url,
      final_url: d.finalUrl || d.url,
      referrer: d.referrer || null,
      source,
    });
  });
});

// ---- the content scripts' events ----
// listen.js's batches, from the frames of the watched tab only; an element they name
// ({ local, role, name }) gets its ref. The answer comes once the batch is sent, so a frame has
// one batch on its way at a time.
const ELEMENT_KEYS = ["region", "field", "dialog", "element"];
browser.runtime.onMessage.addListener((m, sender) => {
  if (m?.kai === "events_ask") {
    if (sender.id !== browser.runtime.id || !sender.tab) return undefined;
    const on = config.on && sender.tab.id === watched;
    return Promise.resolve({ on, quiet_ms: on ? config.quiet_ms : null, acting: on && actsOn(watched) });
  }
  if (m?.kai !== "events" || sender.id !== browser.runtime.id || !sender.tab || sender.tab.incognito || !Array.isArray(m.events)) return undefined;
  if (!config.on || sender.tab.id !== watched) {
    // A frame that missed the word to stop.
    browser.tabs.sendMessage(sender.tab.id, watchMsg(false, sender.tab.id), { frameId: sender.frameId }).catch(() => {});
    return Promise.resolve();
  }
  const at = Date.now();
  return inOrder(`a batch of events of tab ${sender.tab.id}`, () => forward(m, sender, at));
});
async function forward(m, sender, at) {
  const tabId = sender.tab.id;
  // A batch from a document its frame no longer shows (it was left meanwhile) is dropped.
  const frame = await browser.webNavigation.getFrame({ tabId, frameId: sender.frameId }).catch(() => null);
  if (!frame || frame.documentId !== m.document) return;
  const named = [];
  for (const e of m.events) {
    for (const k of ELEMENT_KEYS) if (e[k]?.local !== undefined) named.push(e[k]);
    if (Array.isArray(e.regions)) named.push(...e.regions);
  }
  const refs = named.length ? await refsFor(tabId, sender.frameId, m.document, named.map((x) => x.local)) : [];
  named.forEach((x, i) => {
    x.ref = refs[i];
    delete x.local;
  });
  if (Array.isArray(m.forget) && m.forget.length) forget(m.document, m.forget);
  if (!config.on || tabId !== watched) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  for (const { kind, ...fields } of m.events) emit(kind, at, withRefFirst(fields), tab, sender.frameId, m.origin ?? null);
}
// An Element's keys as the contract lists them: ref first.
function withRefFirst(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (ELEMENT_KEYS.includes(k) && v) out[k] = { ref: v.ref, ...v };
    else if (k === "regions" && Array.isArray(v)) out[k] = v.map((r) => ({ ref: r.ref, ...r }));
    else out[k] = v;
  }
  return out;
}

// quiet_ms up to the longest timer a browser keeps (2^31 - 1 ms, about 24.8 days).
define("events.config@1", {
  args: { on: { type: "boolean", required: true }, quiet_ms: { type: "integer", min: 0, max: 2 ** 31 - 1 } },
  async run({ on, quiet_ms }) {
    if (on && quiet_ms === undefined) throw new OpError("bad_args", "events.config needs 'quiet_ms' when 'on' is true");
    config.on = on;
    config.quiet_ms = on ? quiet_ms : null;
    listenRequests(on);
    await rewatch();
    return { on: config.on, quiet_ms: config.quiet_ms, tab: watched };
  },
});

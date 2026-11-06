// What the user did, as the extension sees it, for Kai's focus rule (design §6.4): who last
// activated each tab (the user, or the extension through tabs.switch, tabs.open or tabs.close),
// when the user last acted in a tab and on which origin, and when each window last had the
// focus. Kept in storage.session, so a background Firefox suspended and started again keeps it;
// a Firefox restart or a reload of the extension begins it again.
//
// The user acts in a tab with trusted pointer or key input in its top document or its frames
// (the content scripts report it, kai.js), by activating it, or by loading a page in it from
// Firefox's own UI (the address bar, a bookmark: webNavigation's typed, auto_bookmark, keyword
// and generated transitions, or the from_address_bar qualifier).
//
// Trusted input Kai sends through the desktop (design §6.3) is trusted input too. Kai brackets it
// with an input span (input.begin, input.end): while one is open, trusted input in any tab is
// Kai's (`kai_input_at`, never `user_at`; the user's own input meanwhile counts as Kai's too), an
// activation the extension did not cause is the extension's, and a page that begins to load from
// Firefox's UI is not the user's.
//
// Its only import has no browser API, so Node's tests load this module with a stand-in `browser`.

import { originOf } from "./url.js";

const NONE = browser.windows.WINDOW_ID_NONE;
const facts = new Map(); // tabId -> { activated_by, activated_at, user_origin, user_at, kai_input_at }
const windowFocus = new Map(); // windowId -> ms since the epoch
const blank = () => ({ activated_by: null, activated_at: null, user_origin: null, user_at: null, kai_input_at: null });

// Activations the extension causes. By tab: the next activation of that tab. By window: how many
// activations of a tab it does not know yet are under way there (tabs it creates, the tab Firefox
// shows in place of one it closes); any activation in that window meanwhile is the extension's,
// and the tabs it was seen for are noted, so that the call's end knows whether the named tab's
// event has come yet. `Next`: the same for windows being opened, whose ids are not known yet.
const byTab = new Set();
const pendingIn = new Map(); // windowId -> count
const seenIn = new Map(); // windowId -> Set of tabIds activated there while pending
let pendingNext = 0;
const seenNext = new Set();

// One write at a time; changes while one is under way go out together in the next (typing reports
// every key).
let writing = Promise.resolve();
let due = false;
function save() {
  if (due) return;
  due = true;
  writing = writing
    .then(() => {
      due = false;
      return browser.storage.session.set({ user_facts: { tabs: [...facts], windows: [...windowFocus] } });
    })
    .catch((e) => console.warn(`Kai for Firefox: the tab facts were not kept: ${e.message}`));
}

export async function load() {
  const { user_facts } = await browser.storage.session.get("user_facts");
  for (const [k, v] of user_facts?.tabs ?? []) if (!facts.has(k)) facts.set(k, { ...blank(), ...v });
  for (const [k, v] of user_facts?.windows ?? []) if (!windowFocus.has(k)) windowFocus.set(k, v);
  try {
    const w = await browser.windows.getLastFocused();
    if (w.focused && !windowFocus.has(w.id)) windowFocus.set(w.id, Date.now());
  } catch {
    /* no window the extension may see */
  }
}

const entry = (tabId) => {
  if (!facts.has(tabId)) facts.set(tabId, blank());
  return facts.get(tabId);
};

// The facts Tab reports for a tab.
export function factsOf(tabId) {
  const f = facts.get(tabId);
  return f ? { ...f } : blank();
}

export const focusedAt = (windowId) => windowFocus.get(windowId) ?? null;

// The extension is about to activate tab `tabId` (it is not active now).
export const willActivate = (tabId) => byTab.add(tabId);
// The extension is about to activate a tab of window `windowId` whose id it does not know yet;
// after the call, activatedIn(windowId, tabId) names the tab now active there (undefined: none).
export const willActivateIn = (windowId) => pendingIn.set(windowId, (pendingIn.get(windowId) ?? 0) + 1);
export function activatedIn(windowId, tabId) {
  const seen = seenIn.get(windowId);
  // Its activation's event has not come yet: it will be for that tab.
  if (tabId !== undefined && !seen?.has(tabId)) byTab.add(tabId);
  seen?.delete(tabId);
  const n = (pendingIn.get(windowId) ?? 1) - 1;
  if (n > 0) pendingIn.set(windowId, n);
  else {
    pendingIn.delete(windowId);
    seenIn.delete(windowId);
  }
}
// The extension is about to open a window; its first tab's activation is the extension's. After
// the call, nextDone(tabId) names that tab (undefined: the window did not open).
export const willActivateNext = () => pendingNext++;
export function nextDone(tabId) {
  if (tabId !== undefined && !seenNext.has(tabId)) byTab.add(tabId);
  seenNext.delete(tabId);
  pendingNext = Math.max(0, pendingNext - 1);
  if (!pendingNext) seenNext.clear();
}

// Kai's input spans: id -> { tabs that got trusted input while it was open, closing: input.end
// came and the span ends after its settle time }.
const spans = new Map();
let nextSpan = 1;
export const spanOpen = () => spans.size > 0;
export function beginSpan() {
  const id = nextSpan++;
  spans.set(id, { tabs: new Set(), closing: false });
  return id;
}
// input.end for span `id`: false when no such span is open or one came already.
export function closeSpan(id) {
  const s = spans.get(id);
  if (!s || s.closing) return false;
  s.closing = true;
  return true;
}
// The tabs that got trusted input during span `id`, which ends; null when no such span is open.
export function endSpan(id) {
  const s = spans.get(id);
  if (!s) return null;
  spans.delete(id);
  return [...s.tabs];
}
export const endAllSpans = () => spans.clear();

function userActed(tabId, url) {
  const f = entry(tabId);
  f.user_at = Date.now();
  f.user_origin = originOf(url);
  save();
}
function kaiInput(tabId) {
  entry(tabId).kai_input_at = Date.now();
  for (const s of spans.values()) s.tabs.add(tabId);
  save();
}

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  let by = "user";
  if (byTab.delete(tabId)) by = "extension";
  else if (pendingIn.get(windowId) > 0) {
    by = "extension";
    if (!seenIn.has(windowId)) seenIn.set(windowId, new Set());
    seenIn.get(windowId).add(tabId);
  } else if (pendingNext > 0) {
    by = "extension";
    seenNext.add(tabId);
  } else if (spanOpen()) by = "extension";
  const f = entry(tabId);
  f.activated_by = by;
  f.activated_at = Date.now();
  if (by === "user") {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab) userActed(tabId, tab.url);
  }
  save();
});

browser.tabs.onRemoved.addListener((tabId) => {
  byTab.delete(tabId);
  if (facts.delete(tabId)) save();
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === NONE) return;
  windowFocus.set(windowId, Date.now());
  save();
});
browser.windows.onRemoved.addListener((windowId) => {
  pendingIn.delete(windowId);
  seenIn.delete(windowId);
  if (windowFocus.delete(windowId)) save();
});

// Tabs where a page began to load while an input span was open: Kai may have typed it.
const kaiTyped = new Set();
const FROM_UI = new Set(["typed", "auto_bookmark", "keyword", "generated"]);
browser.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0 && spanOpen()) kaiTyped.add(d.tabId);
});
browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  if (kaiTyped.delete(d.tabId)) return;
  if (FROM_UI.has(d.transitionType) || d.transitionQualifiers?.includes("from_address_bar")) userActed(d.tabId, d.url);
});

// The content scripts' reports of trusted input (kai.js).
browser.runtime.onMessage.addListener((m, sender) => {
  if (m?.kai !== "user_input" || sender.id !== browser.runtime.id || !sender.tab || sender.tab.incognito) return undefined;
  if (spanOpen()) kaiInput(sender.tab.id);
  else userActed(sender.tab.id, sender.tab.url);
  return undefined;
});

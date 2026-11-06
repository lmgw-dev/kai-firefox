// Tabs: the user's tab (D9), the tab an operation names, and the tabs.* operations (§5.2).
// Tabs of private windows are never listed or touched (§3), also when the user lets the
// extension run in private windows.

import { define, OpError, cancellable, about } from "./ops.js";
import { settings } from "./settings.js";
import { topFrame, navPending, navEnded } from "./pages.js";
import * as user from "./user.js";
import { kaiNavigation } from "./history.js";
import { siteOf } from "./url.js";

const NONE = browser.windows.WINDOW_ID_NONE;
const privateError = (what, extra) => new OpError("private_window", `${what} is in a private window; Kai has no access to private windows`, extra);

// Normal, non-private windows by when they last had the focus, the most recent last. Kept from
// windows events; windows.getLastFocused tells which window is on top now.
const focusOrder = [];
const bump = (id) => {
  const i = focusOrder.indexOf(id);
  if (i >= 0) focusOrder.splice(i, 1);
  focusOrder.push(id);
};
browser.windows.onFocusChanged.addListener(async (id) => {
  if (id === NONE) return;
  try {
    const w = await browser.windows.get(id);
    if (w.type === "normal" && !w.incognito) bump(id);
  } catch {
    /* closed meanwhile */
  }
});
browser.windows.onRemoved.addListener((id) => {
  const i = focusOrder.indexOf(id);
  if (i >= 0) focusOrder.splice(i, 1);
});
browser.windows.getLastFocused().then(
  (w) => {
    if (w.type === "normal" && !w.incognito && !focusOrder.includes(w.id)) focusOrder.unshift(w.id);
  },
  () => {},
);

// The most recently focused normal window that is not private, or null.
async function recentWindow() {
  for (let i = focusOrder.length - 1; i >= 0; i--) {
    try {
      const w = await browser.windows.get(focusOrder[i]);
      if (w.type === "normal" && !w.incognito) return w.id;
    } catch {
      /* closed */
    }
  }
  const normal = (await browser.windows.getAll({ windowTypes: ["normal"] })).filter((w) => !w.incognito);
  return normal.length ? normal[0].id : null;
}

// The user's window (D9): the most recently focused normal window. A private window on top is the
// user's, and Kai has no access to it.
export async function userWindow() {
  let top;
  try {
    top = await browser.windows.getLastFocused();
  } catch {
    // The extension cannot see the window on top: a private window it may not run in.
    throw privateError("The user's tab");
  }
  if (top.incognito) throw privateError("The user's tab");
  if (top.type === "normal") {
    bump(top.id);
    return top.id;
  }
  const w = await recentWindow();
  if (w === null) throw new OpError("no_window", "Firefox has no normal window open");
  return w;
}

// The user's tab (D9): the active tab of the user's window.
export async function userTab() {
  const windowId = await userWindow();
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (!tab) throw new OpError("no_window", `window ${windowId} has no active tab`);
  return tab;
}

// The tab `id` names, or the user's tab when it is not given.
export async function tabArg(id) {
  if (id === undefined || id === null) return userTab();
  let tab;
  try {
    tab = await browser.tabs.get(id);
  } catch {
    throw new OpError("no_tab", `Firefox has no tab ${id} that Kai may use (closed, or in a private window)`, { tab: id });
  }
  if (tab.incognito) throw privateError(`Tab ${id}`, { tab: id });
  return tab;
}

// The containers' names by cookie store id (contextualIdentities), kept from its events.
const containers = new Map();
const nameContainer = (c) => containers.set(c.contextualIdentity.cookieStoreId, c.contextualIdentity.name);
browser.contextualIdentities.onCreated.addListener(nameContainer);
browser.contextualIdentities.onUpdated.addListener(nameContainer);
browser.contextualIdentities.onRemoved.addListener((c) => containers.delete(c.contextualIdentity.cookieStoreId));
export async function loadContainers() {
  try {
    for (const c of await browser.contextualIdentities.query({})) containers.set(c.cookieStoreId, c.name);
  } catch {
    /* Firefox's containers are off: no tab is in one */
  }
}

// What an operation says about a tab.
export function tabInfo(tab, userTabId = null) {
  const store = tab.cookieStoreId && tab.cookieStoreId !== "firefox-default" ? tab.cookieStoreId : null;
  return {
    id: tab.id,
    window: tab.windowId,
    index: tab.index,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: tab.active,
    user: tab.id === userTabId,
    pinned: tab.pinned,
    loading: tab.status === "loading",
    discarded: !!tab.discarded,
    audible: !!tab.audible,
    muted: !!tab.mutedInfo?.muted,
    container: store,
    container_name: store ? (containers.get(store) ?? null) : null,
    ...user.factsOf(tab.id),
  };
}

// The windows tabs.list reports: normal and popup windows that are not private, with whether
// each has the focus now and when the extension last saw it get the focus.
export async function windowsInfo() {
  const all = await browser.windows.getAll({ windowTypes: ["normal", "popup"] });
  return all
    .filter((w) => !w.incognito)
    .sort((a, b) => a.id - b.id)
    .map((w) => ({ id: w.id, type: w.type, focused: !!w.focused, focused_at: user.focusedAt(w.id) }));
}

async function userTabIdOrNull() {
  try {
    return (await userTab()).id;
  } catch {
    return null;
  }
}

// Firefox's network error codes as names, for load_error.
const NET_ERRORS = {
  2152398861: "NS_ERROR_CONNECTION_REFUSED",
  2152398878: "NS_ERROR_UNKNOWN_HOST",
  2152398862: "NS_ERROR_NET_TIMEOUT",
  2152398850: "NS_BINDING_ABORTED",
  2152398864: "NS_ERROR_OFFLINE",
  2152398868: "NS_ERROR_NET_RESET",
  2152398919: "NS_ERROR_NET_INTERRUPT",
  2153390067: "SSL_ERROR_BAD_CERT_DOMAIN",
};
const netError = (e) => {
  const m = /(\d{6,})/.exec(String(e));
  return m && NET_ERRORS[m[1]] ? NET_ERRORS[m[1]] : String(e);
};

// Schemes that load a page in a tab, or that Firefox itself refuses to extensions (with its own
// reason). Any other scheme (mailto:, tel:, magnet:, web+…) loads no page: Firefox hands the URL
// to another application or shows that it knows none.
const PAGE_SCHEMES = new Set(["http", "https", "file", "about", "data", "blob", "javascript", "view-source", "moz-extension", "chrome", "resource", "jar", "moz-src"]);

function parseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new OpError("bad_url", `'${url}' is not an absolute URL (it needs a scheme such as https:); give it as search to search for it`);
  }
  const scheme = u.protocol.slice(0, -1);
  if (!PAGE_SCHEMES.has(scheme)) {
    throw new OpError("url_refused", `Kai for Firefox does not open ${scheme}: URLs: no page loads for them in a tab (Firefox hands them to another application, or says it knows none)`);
  }
  return u.href;
}

// Firefox refuses some URLs to extensions (about:config, chrome:, file: in tabs.create, data:).
// `url` is the one Kai asked for.
const refused = (url, e, tab = null) => new OpError("url_refused", `Firefox does not let an extension open ${url}: ${e.message}`, tab ? about(tab) : undefined);

// Watches the top-level navigation of a tab, set up before the navigation is asked for; the tab
// may be named later (tabs.create), and events are buffered until then. `dropBlank`: the tab is
// new and goes elsewhere, so its about:blank events are its first document's, not the navigation.
export function watchNav({ dropBlank = false } = {}) {
  let tabId = null;
  const events = [];
  const waiters = [];
  const flush = () => {
    if (tabId === null) return;
    for (const w of [...waiters]) {
      const i = events.findIndex((e, j) => j >= w.from && e.tabId === tabId && w.pred(e));
      if (i >= 0) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve({ ...events[i], index: i });
      }
    }
  };
  const push = (ev) => {
    events.push(ev);
    flush();
  };
  const top = (kind) => (d) => {
    if (d.frameId !== 0 || (dropBlank && d.url === "about:blank")) return;
    const k = kind === "error" && /\b2152398850\b|NS_BINDING_ABORTED/.test(String(d.error)) ? "aborted" : kind;
    push({ kind: k, tabId: d.tabId, url: d.url, error: d.error });
  };
  const L = {
    before: top("begin"),
    committed: top("commit"),
    same: top("same"),
    completed: top("load"),
    error: top("error"),
    updated: (id, change) => {
      if (change.status === "loading") push({ kind: "start", tabId: id, url: change.url });
      if (change.status === "complete") push({ kind: "complete", tabId: id });
    },
    removed: (id) => push({ kind: "removed", tabId: id }),
  };
  const nav = browser.webNavigation;
  nav.onBeforeNavigate.addListener(L.before);
  nav.onCommitted.addListener(L.committed);
  nav.onHistoryStateUpdated.addListener(L.same);
  nav.onReferenceFragmentUpdated.addListener(L.same);
  nav.onCompleted.addListener(L.completed);
  nav.onErrorOccurred.addListener(L.error);
  browser.tabs.onUpdated.addListener(L.updated);
  browser.tabs.onRemoved.addListener(L.removed);
  return {
    setTab(id) {
      tabId = id;
      flush();
    },
    // The URL the tab's navigation began with: its first begin, commit or change inside the page
    // (the history entry back and forward go to, the engine's URL a search loads); null before.
    began: () => events.find((e) => e.tabId === tabId && ["begin", "commit", "same"].includes(e.kind) && e.url)?.url ?? null,
    // The first event `pred` takes at or after index `from` (0: since the watch began).
    wait: (pred, from = 0) =>
      new Promise((resolve) => {
        waiters.push({ pred, from, resolve });
        flush();
      }),
    stop() {
      nav.onBeforeNavigate.removeListener(L.before);
      nav.onCommitted.removeListener(L.committed);
      nav.onHistoryStateUpdated.removeListener(L.same);
      nav.onReferenceFragmentUpdated.removeListener(L.same);
      nav.onCompleted.removeListener(L.completed);
      nav.onErrorOccurred.removeListener(L.error);
      browser.tabs.onUpdated.removeListener(L.updated);
      browser.tabs.onRemoved.removeListener(L.removed);
    },
  };
}

const LATE = Symbol("late");
const closed = (tabId) => new OpError("tab_closed", `tab ${tabId} was closed while it loaded`, { tab: tabId });

// Waits as `mode` says ("load", "commit" or "none") and answers the tab as it is then.
// - The navigation starts with the first begin (or commit) that `begin` takes: for a URL, the one
//   for that URL, so an earlier navigation still running in the tab cannot answer for this one. A
//   change inside the page (a fragment, pushState) is the navigation only when `same` takes it and
//   nothing began before it; one while the page loads (an SPA's replaceState) is not its end.
// - All of it ends within nav_load_ms of `since` (when Firefox was asked), else nav_timeout.
// Firefox 159's events, as seen:
// - a load that changes process aborts and begins again before its commit (NS_BINDING_ABORTED);
// - a stopped or replaced load aborts after its commit, or before it and then the tab completes;
// - a download begins and completes without a commit;
// - an error page (connection refused, a blocked port) commits and the tab completes without the
//   navigation's onCompleted;
// - Back to a page in the back-forward cache begins, commits (its old documentId) and completes.
export async function settle(watch, tabId, mode, signal, { begin = () => true, same = () => true, what, since = Date.now() }) {
  const out = { loaded: false };
  if (mode !== "none") {
    const ms = settings.nav_load_ms;
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(LATE), Math.max(0, since + ms - Date.now()))));
    const next = (pred, from) => cancellable(signal, Promise.race([watch.wait(pred, from), late]));
    try {
      let ev = await next((e) => e.kind === "removed" || ((e.kind === "begin" || e.kind === "commit") && begin(e)) || (e.kind === "same" && same(e)));
      if (ev === LATE) throw await timedOut(tabId, ms, `Firefox did not start ${what}`);
      if (ev.kind === "same") out.loaded = true;
      else {
        // The URLs this navigation went by: an abort for another is an earlier navigation's.
        const urls = new Set();
        let committed = false;
        let aborted = null;
        for (;;) {
          if (ev === LATE) throw await timedOut(tabId, ms, committed ? "the page has not finished loading" : "the site has not answered");
          if (ev.kind === "removed") throw closed(tabId);
          if (ev.kind === "begin") {
            urls.add(ev.url);
            aborted = null;
          }
          if (ev.kind === "commit") {
            urls.add(ev.url);
            committed = true;
            aborted = null;
            if (mode === "commit") break;
          }
          if (ev.kind === "load") {
            if (committed) out.loaded = true;
            else out.load_error = "NO_PAGE";
            break;
          }
          if (ev.kind === "error") {
            out.load_error = netError(ev.error);
            break;
          }
          if (ev.kind === "aborted" && urls.has(ev.url)) {
            if (committed) {
              out.load_error = "NS_BINDING_ABORTED";
              break;
            }
            aborted = ev;
          }
          if (ev.kind === "complete" && (aborted || committed)) {
            out.load_error = aborted ? "NS_BINDING_ABORTED" : "ERROR_PAGE";
            break;
          }
          ev = await next((e) => KINDS.includes(e.kind), ev.index + 1);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const tab = await browser.tabs.get(tabId).catch(() => {
    throw closed(tabId);
  });
  return { tab: tabInfo(tab, await userTabIdOrNull()), ...out };
}
const KINDS = ["begin", "commit", "load", "error", "aborted", "complete", "removed"];

async function timedOut(tabId, ms, state) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  return new OpError("nav_timeout", `${state} in tab ${tabId} within ${ms} ms (Kai for Firefox's setting nav_load_ms); the tab goes on loading`, tab ? about(tab) : { tab: tabId });
}

// Which events are the navigation tabs.open or tabs.go asked for: a URL's begins with it (or, for
// a fragment, changes the page to it); a search's is the first that begins.
const target = (href, search) =>
  href !== null
    ? { begin: (e) => e.url === href, same: (e) => e.url === href, what: "loading the URL" }
    : { same: () => false, what: "the search" };

const WAIT = { type: "string", values: ["load", "commit", "none"] };

// Where a navigation Kai asked for was meant to go (the contract's `goes`), for the focus rule's
// owner's moves (design §6.4): `by` "url" (the URL Kai gave), "search" (the engine's URL the
// search began with) or "history" (the entry back or forward went to), and that URL's site's
// origin (Reader view's and view-source:'s the page's inside them; null when it has none or the
// navigation named no URL). Kai counts the navigation as the owner's only where the tab landed on it.
function goes(by, watch, href = null) {
  const url = href ?? watch.began();
  return { by, origin: url === null ? null : siteOf(url) };
}

define("tabs.list@1", {
  args: {},
  async run() {
    const userTabId = await userTabIdOrNull();
    const tabs = (await browser.tabs.query({})).filter((t) => !t.incognito);
    tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    return { tabs: tabs.map((t) => tabInfo(t, userTabId)), user_tab: userTabId, windows: await windowsInfo() };
  },
});

define("tabs.open@1", {
  args: { url: { type: "string", nonEmpty: true }, search: { type: "string", nonEmpty: true }, active: { type: "boolean" }, sandbox: { type: "boolean" }, wait: WAIT },
  oneOf: ["url", "search"],
  async run({ url, search, active = true, sandbox = false, wait = "load" }, { signal }) {
    const href = url !== undefined ? parseUrl(url) : null;
    // The user's window; while the user is in a private window, the last normal one.
    const windowId = await userWindow().catch((e) => {
      if (e.code === "private_window") return recentWindow();
      if (e.code === "no_window") return null;
      throw e;
    });
    const store = sandbox ? (await kaiContainer()).cookieStoreId : undefined;
    const watch = watchNav({ dropBlank: href !== "about:blank" });
    const since = Date.now();
    try {
      let tab;
      if (windowId === null) {
        // No normal window Kai may use: a new one.
        user.willActivateNext();
        let w;
        try {
          w = await browser.windows.create({ url: href ?? "about:blank", cookieStoreId: store }).catch((e) => {
            throw refused(href, e);
          });
        } finally {
          user.nextDone(w?.tabs?.[0]?.id);
        }
        tab = w.tabs[0];
      } else {
        if (active) user.willActivateIn(windowId);
        tab = await browser.tabs.create({ url: href ?? "about:blank", active, windowId, cookieStoreId: store }).catch((e) => {
          user.activatedIn(windowId);
          throw refused(href, e);
        });
        if (active) user.activatedIn(windowId, tab.id);
      }
      watch.setTab(tab.id);
      kaiNavigation(tab.id, href);
      if (href !== "about:blank") navPending(tab.id);
      if (search !== undefined) await browser.search.query({ text: search, tabId: tab.id });
      const out = await settle(watch, tab.id, wait, signal, { ...target(href, search), since });
      return { ...out, goes: href !== null ? goes("url", watch, href) : goes("search", watch) };
    } finally {
      watch.stop();
    }
  },
});

define("tabs.go@1", {
  args: { tab: { type: "integer" }, url: { type: "string", nonEmpty: true }, search: { type: "string", nonEmpty: true }, wait: WAIT },
  oneOf: ["url", "search"],
  async run({ tab: id, url, search, wait = "load" }, { signal }) {
    const tab = await tabArg(id);
    const href = url !== undefined ? parseUrl(url) : null;
    const watch = watchNav();
    const since = Date.now();
    try {
      watch.setTab(tab.id);
      kaiNavigation(tab.id, href);
      if (href !== "about:blank") navPending(tab.id);
      if (href !== null) {
        await browser.tabs.update(tab.id, { url: href }).catch((e) => {
          navEnded(tab.id);
          throw refused(href, e, tab);
        });
      } else await browser.search.query({ text: search, tabId: tab.id });
      const out = await settle(watch, tab.id, wait, signal, { ...target(href, search), since });
      return { ...out, goes: href !== null ? goes("url", watch, href) : goes("search", watch) };
    } finally {
      watch.stop();
    }
  },
});

define("tabs.switch@1", {
  args: { tab: { type: "integer", required: true } },
  async run({ tab: id }) {
    const tab = await tabArg(id);
    if (!tab.active) user.willActivate(tab.id);
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    const now = await browser.tabs.get(tab.id);
    return { tab: tabInfo(now, await userTabIdOrNull()) };
  },
});

// The tabs tabs.close is closing, until Firefox says they are gone: their closing is Kai's (the
// by_kai of a read_ended, aloud.js). takeKaiClose answers whether it was, once.
const kaiCloses = new Set();
export const takeKaiClose = (tabId) => kaiCloses.delete(tabId);

define("tabs.close@1", {
  args: { tab: { type: "integer" } },
  async run({ tab: id }) {
    const tab = await tabArg(id);
    // Firefox shows another tab of the window in place of an active one: the extension's doing.
    if (tab.active) user.willActivateIn(tab.windowId);
    kaiCloses.add(tab.id);
    try {
      await browser.tabs.remove(tab.id);
    } catch (e) {
      kaiCloses.delete(tab.id);
      throw e;
    } finally {
      if (tab.active) {
        const [now] = await browser.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
        user.activatedIn(tab.windowId, now?.id);
      }
    }
    return { closed: tabInfo(tab) };
  },
});

// Back and forward: Firefox does nothing, silently, when there is no such page, so a history of
// one page is an error at once, and otherwise the navigation must start within nav_start_ms.
function history(dir) {
  return async ({ tab: id, wait = "load" }, { signal }) => {
    const tab = await tabArg(id);
    const top = await topFrame(tab).catch(() => null);
    if (top && top.history_length <= 1) throw new OpError("no_history", `tab ${tab.id} has no ${dir === "back" ? "earlier" : "later"} page`, about(tab));
    const watch = watchNav();
    const since = Date.now();
    try {
      watch.setTab(tab.id);
      kaiNavigation(tab.id);
      await (dir === "back" ? browser.tabs.goBack(tab.id) : browser.tabs.goForward(tab.id));
      const started = watch.wait((e) => ["start", "begin", "commit", "same", "removed"].includes(e.kind));
      let timer;
      const ms = settings.nav_start_ms;
      const late = new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)));
      const ev = await cancellable(signal, Promise.race([started, late]));
      clearTimeout(timer);
      if (!ev) {
        throw new OpError(
          "no_navigation",
          `Firefox did not start going ${dir} in tab ${tab.id} within ${ms} ms (Kai for Firefox's setting nav_start_ms): the tab has no ${dir === "back" ? "earlier" : "later"} page, or the page asks before it is left`,
          about(tab),
        );
      }
      const out = await settle(watch, tab.id, wait, signal, { what: `going ${dir}`, since });
      return { ...out, goes: goes("history", watch) };
    } finally {
      watch.stop();
    }
  };
}

define("tabs.back@1", { args: { tab: { type: "integer" }, wait: WAIT }, run: history("back") });
define("tabs.forward@1", { args: { tab: { type: "integer" }, wait: WAIT }, run: history("forward") });

define("tabs.reload@1", {
  args: { tab: { type: "integer" }, bypass_cache: { type: "boolean" }, wait: WAIT },
  async run({ tab: id, bypass_cache = false, wait = "load" }, { signal }) {
    const tab = await tabArg(id);
    const watch = watchNav();
    const since = Date.now();
    try {
      watch.setTab(tab.id);
      kaiNavigation(tab.id);
      await browser.tabs.reload(tab.id, { bypassCache: bypass_cache });
      return await settle(watch, tab.id, wait, signal, { same: () => false, what: "reloading", since });
    } finally {
      watch.stop();
    }
  },
});

define("tabs.mute@1", {
  args: { tab: { type: "integer" }, on: { type: "boolean", required: true } },
  async run({ tab: id, on }) {
    const tab = await tabArg(id);
    const now = await browser.tabs.update(tab.id, { muted: on });
    return { tab: tabInfo(now, await userTabIdOrNull()) };
  },
});

// The "Kai" container (design §6.4) for tabs.open's sandbox: the one this extension made, kept by
// its cookie store id; else a new one, which switches Firefox's containers on. A container the
// user made, also one named "Kai", is never taken: its cookies are the user's. It separates
// cookies and storage only: history is shared, and Firefox's password manager still offers the
// user's logins in it.
async function kaiContainer() {
  const { kai_container } = await browser.storage.local.get("kai_container");
  try {
    if (kai_container) {
      const c = await browser.contextualIdentities.get(kai_container).catch(() => null);
      if (c) return c;
    }
    const c = await browser.contextualIdentities.create({ name: "Kai", color: "blue", icon: "fingerprint" });
    containers.set(c.cookieStoreId, c.name);
    await browser.storage.local.set({ kai_container: c.cookieStoreId });
    return c;
  } catch (e) {
    throw new OpError("no_container", `Firefox did not give Kai its container: ${e.message}`);
  }
}

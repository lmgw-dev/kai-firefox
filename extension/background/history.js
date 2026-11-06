// history.seen: whether the user's history has visited a URL's origin, for the commit guard's
// question before a navigation Kai's model asked for (design §6.4: a URL the model wrote can carry
// data out as a GET), and for the network gate's hold on GET navigations to an origin the user
// never visited (gate.js).
//
// A visit Kai caused is not the user's: once Kai has been to an origin, the history alone would
// say "seen" for the next navigation the model writes there. So the extension keeps, per origin,
// when Kai first caused a page of it to load and when it last saw one load that Kai did not cause
// (storage.local `kai_visits`). Kai's doing: the navigations of tabs.open, tabs.go, tabs.back,
// tabs.forward and tabs.reload (their target and every URL a redirect went by), anything that
// begins to load in a tab while a network gate is open there or an input span is (user.js), a
// tab a page opens meanwhile, and every page of the sandbox container. The user has seen an
// origin when the history has a visit to it from before Kai first went there, or the extension
// saw a page of it load since that Kai did not cause.
//
// Firefox's history search matches words of titles and URLs, so it is asked for the host, for
// every page it has of it, and each answer's origin compared; the visits are each page's.

import { define, OpError } from "./ops.js";
import { originOf } from "./url.js";
import { settings } from "./settings.js";
import { openOn } from "./gate.js";
import { spanOpen } from "./user.js";

// history.search's maxResults: every page it has (the attribute is an unsigned 32-bit number).
const ALL = 2 ** 31 - 1;

// origin -> [kai, user]: when Kai first caused a page of it to load, when the extension last saw
// one load that Kai did not cause (null: not since); milliseconds since the epoch.
const visits = new Map();
const ready = browser.storage.local
  .get("kai_visits")
  .then(({ kai_visits }) => {
    for (const [o, v] of Object.entries(kai_visits ?? {})) if (!visits.has(o)) visits.set(o, v);
  })
  .catch((e) => console.warn(`Kai for Firefox: Kai's visits were not read: ${e.message}`));

// One write at a time; changes while one is under way go out together in the next.
let writing = Promise.resolve();
let due = false;
function save() {
  if (due) return;
  due = true;
  writing = writing
    .then(async () => {
      await ready;
      due = false;
      return browser.storage.local.set({ kai_visits: Object.fromEntries(visits) });
    })
    .catch((e) => console.warn(`Kai for Firefox: Kai's visits were not kept: ${e.message}`));
}

function kaiVisit(url, at) {
  const o = originOf(url);
  if (!o) return;
  const v = visits.get(o);
  if (v && v[0] <= at) return;
  visits.set(o, [at, v?.[1] ?? null]);
  save();
}
function userVisit(url, at) {
  const v = visits.get(originOf(url));
  if (!v || at <= v[0]) return;
  v[1] = at;
  save();
}

// Navigations Kai causes, by tab and frame, from when they begin until they commit (or
// nav_load_ms passes): { since, timer }.
const marks = new Map();
const markKey = (tab, frame) => `${tab}:${frame}`;
function mark(tab, frame, since) {
  const k = markKey(tab, frame);
  clearTimeout(marks.get(k)?.timer);
  marks.set(k, { since: Math.min(since, marks.get(k)?.since ?? since), timer: setTimeout(() => marks.delete(k), settings.nav_load_ms) });
}

// tabs.open, tabs.go, Back, Forward and Reload: Kai navigates the tab's top frame now. Others
// learn of it through onKaiNavigation (events.js: `by_kai`).
const kaiNavHooks = [];
export const onKaiNavigation = (fn) => kaiNavHooks.push(fn);
export function kaiNavigation(tabId, url = null) {
  const now = Date.now();
  if (url) kaiVisit(url, now);
  mark(tabId, 0, now);
  for (const fn of kaiNavHooks) fn(tabId);
}

// The sandbox container's cookie store id (tabs.js keeps it in storage.local).
let sandbox = null;
browser.storage.local.get("kai_container").then(({ kai_container }) => (sandbox ??= kai_container ?? null), () => {});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.kai_container) sandbox = changes.kai_container.newValue ?? null;
});
const inSandbox = async (tabId) => sandbox !== null && (await browser.tabs.get(tabId).catch(() => null))?.cookieStoreId === sandbox;

browser.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (openOn(d.tabId) || spanOpen() || (await inSandbox(d.tabId))) mark(d.tabId, d.frameId, d.timeStamp);
});
browser.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  if (openOn(d.sourceTabId) || spanOpen()) {
    mark(d.tabId, 0, d.timeStamp);
    kaiVisit(d.url, d.timeStamp);
  }
});
browser.webRequest.onBeforeRedirect.addListener(
  (d) => {
    const m = marks.get(markKey(d.tabId, d.frameId));
    if (!m) return;
    kaiVisit(d.url, m.since);
    kaiVisit(d.redirectUrl, m.since);
  },
  { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
);
browser.webNavigation.onCommitted.addListener(async (d) => {
  const k = markKey(d.tabId, d.frameId);
  const m = marks.get(k);
  if (m) {
    clearTimeout(m.timer);
    marks.delete(k);
    kaiVisit(d.url, m.since);
  } else if (openOn(d.tabId) || (await inSandbox(d.tabId))) kaiVisit(d.url, d.timeStamp);
  else if (d.frameId === 0) userVisit(d.url, d.timeStamp);
});

// Every visit to `origin` the history has (milliseconds since the epoch), through the whole
// history: the pages a search for its host finds whose origin it is, and each one's visits.
async function visitTimes(origin, host) {
  const pages = (await browser.history.search({ text: host, startTime: 0, maxResults: ALL })).filter((it) => originOf(it.url) === origin);
  const all = await Promise.all(pages.map((p) => browser.history.getVisits({ url: p.url })));
  return all.flat().map((v) => v.visitTime).filter((t) => typeof t === "number");
}

// What history.seen answers for an origin.
async function seenOf(origin) {
  await ready;
  const times = await visitTimes(origin, new URL(origin).hostname);
  const kai = visits.get(origin);
  const first = times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
  const last = times.length ? times.reduce((a, b) => Math.max(a, b)) : null;
  const byUser = times.length > 0 && (!kai || kai[1] !== null || first < kai[0]);
  return { seen: times.length > 0, seen_by_user: byUser, first_visit: first, last_visit: last };
}

// Whether the user has visited `origin` (above).
export const seenByUser = async (origin) => (await seenOf(origin)).seen_by_user;

define("history.seen@1", {
  args: { url: { type: "string", required: true, nonEmpty: true } },
  async run({ url }) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new OpError("bad_url", `'${url}' is not an absolute URL`);
    }
    if (u.origin === "null" || !u.host) throw new OpError("bad_url", `${url} has no origin a history could have seen (it needs a scheme and a host, such as https://shop.example/)`);
    return { url: u.href, origin: u.origin, ...(await seenOf(u.origin)) };
  },
});

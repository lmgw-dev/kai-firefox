// Firefox's own features (design §5.5): a tab's zoom, Reader view, and the profile's bookmarks,
// history and downloads. Opening a finished download is Kai's (its path): downloads.open needs a
// user action in the extension.
//
// The zoom and Reader view act on the page of the origin Kai approved. Firefox's tabs.setZoom and
// tabs.toggleReaderMode take a tab, not a document, so the check cannot hold the document as
// page.css's does: the tab's origin (siteOf, Reader view's page inside it) is checked right
// before and again right after, and either finding another one is page_changed.

import { define, OpError, about } from "./ops.js";
import { tabArg, tabInfo, userTab, watchNav, settle } from "./tabs.js";
import { tabRef } from "./compose.js";
import { kaiNavigation } from "./history.js";
import { siteOf } from "./url.js";

// history.search's maxResults: every page it has (the attribute is an unsigned 32-bit number).
const ALL = 2 ** 31 - 1;
const percentOf = (factor) => Math.round(factor * 100);

async function userTabIdOrNull() {
  try {
    return (await userTab()).id;
  } catch {
    return null;
  }
}

// page_changed unless `tab` shows a page of `origin`; `what` says what was not done.
function approvedSite(tab, origin, what) {
  const site = siteOf(tab.url);
  if (site !== null && site === origin) return;
  throw new OpError("page_changed", `tab ${tab.id} shows a page of ${site === null ? "no origin Kai can approve (an opaque one)" : "another origin than the one Kai approved"}, so ${what}`, about(tab));
}
// The tab after the act, page_changed when it shows a page of another origin than `origin`;
// `during` says when that was found.
async function stillApproved(tab, origin, during) {
  const now = await browser.tabs.get(tab.id).catch(() => tab);
  if (siteOf(now.url) !== origin) throw new OpError("page_changed", `tab ${tab.id} showed a page of another origin than the one Kai approved ${during}`, about(now));
  return now;
}

// Sets a tab's zoom; reading it is context.get's (tab.zoom_percent).
define("page.zoom@1", {
  args: { percent: { type: "integer", min: 1, required: true }, origin: { type: "string", required: true, nonEmpty: true }, tab: { type: "integer" } },
  async run({ percent, origin, tab: id }) {
    const tab = await tabArg(id);
    approvedSite(tab, origin, "its zoom was not changed");
    const was = await browser.tabs.getZoom(tab.id);
    try {
      await browser.tabs.setZoom(tab.id, percent / 100);
    } catch (e) {
      throw new OpError("bad_value", `Firefox does not zoom tab ${tab.id} to ${percent} %: ${e.message}`, about(tab));
    }
    const after = await stillApproved(tab, origin, "when its zoom was set, so the zoom may have reached that page");
    const now = await browser.tabs.getZoom(tab.id);
    const settings = await browser.tabs.getZoomSettings(tab.id);
    return {
      tab: tabRef(after),
      percent: percentOf(now),
      was: percentOf(was),
      default_percent: percentOf(settings.defaultZoomFactor ?? 1),
      scope: settings.scope,
    };
  },
});

define("reader.view@1", {
  args: { on: { type: "boolean", required: true }, origin: { type: "string", required: true, nonEmpty: true }, tab: { type: "integer" } },
  async run({ on, origin, tab: id }, { signal }) {
    const tab = await tabArg(id);
    approvedSite(tab, origin, `Reader view was not turned ${on ? "on" : "off"}`);
    if (!!tab.isInReaderMode === on) return { tab: tabInfo(tab, await userTabIdOrNull()), on, changed: false, loaded: tab.status === "complete" };
    const noArticle = () =>
      new OpError(
        "no_article",
        `Firefox finds no article in tab ${tab.id}, so Reader view cannot show it${tab.status === "loading" ? " (Firefox looks for one once the page has loaded)" : ""}`,
        about(tab),
      );
    if (on && !tab.isArticle) throw noArticle();
    const watch = watchNav();
    const since = Date.now();
    try {
      watch.setTab(tab.id);
      kaiNavigation(tab.id);
      try {
        await browser.tabs.toggleReaderMode(tab.id);
      } catch (e) {
        if (on && /cannot be placed into reader mode/i.test(e.message)) throw noArticle();
        throw new OpError("internal", `Firefox did not toggle Reader view in tab ${tab.id}: ${e.message}`, about(tab));
      }
      const isReader = (e) => (e.url || "").startsWith("about:reader");
      const nav = await settle(watch, tab.id, "load", signal, { begin: (e) => isReader(e) === on, same: () => false, what: on ? "Reader view" : "leaving Reader view", since });
      const now = await stillApproved(tab, origin, `once Reader view was turned ${on ? "on" : "off"}`);
      return { ...nav, on: !!now.isInReaderMode, changed: true };
    } finally {
      watch.stop();
    }
  },
});

// A bookmark's folders from the root, by title ("Bookmarks Toolbar", "Recipes"), kept per call.
function folderPath(cache) {
  const of = async (id) => {
    if (!id) return [];
    if (!cache.has(id)) {
      cache.set(
        id,
        (async () => {
          const [node] = await browser.bookmarks.get(id).catch(() => []);
          if (!node || !node.parentId) return [];
          return [...(await of(node.parentId)), node.title ?? ""];
        })(),
      );
    }
    return cache.get(id);
  };
  return of;
}

define("bookmarks.find@1", {
  args: { query: { type: "string", required: true, nonEmpty: true } },
  async run({ query }) {
    const nodes = await browser.bookmarks.search(query);
    const path = folderPath(new Map());
    const bookmarks = await Promise.all(
      nodes
        .filter((n) => n.type === "bookmark" || (n.type === undefined && n.url))
        .sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0))
        .map(async (n) => ({ title: n.title ?? "", url: n.url, added: n.dateAdded ?? null, folder: await path(n.parentId) })),
    );
    return { query, bookmarks };
  },
});

define("history.find@1", {
  args: { query: { type: "string", required: true, nonEmpty: true } },
  async run({ query }) {
    const items = await browser.history.search({ text: query, startTime: 0, maxResults: ALL });
    const pages = items
      .map((h) => ({ title: h.title ?? "", url: h.url, last_visit: h.lastVisitTime ?? null, visits: h.visitCount ?? 0 }))
      .sort((a, b) => (b.last_visit ?? 0) - (a.last_visit ?? 0));
    return { query, pages };
  },
});

const time = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const known = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);

define("downloads.list@1", {
  args: {},
  async run() {
    const items = (await browser.downloads.search({})).filter((d) => !d.incognito);
    const downloads = items
      .map((d) => {
        const out = {
          file: (d.filename || "").split("/").pop(),
          path: d.filename || "",
          url: d.url,
          final_url: d.finalUrl || d.url,
          referrer: d.referrer || null,
          state: d.state,
          size: known(d.fileSize) ?? known(d.totalBytes),
          received: known(d.bytesReceived) ?? 0,
          started: time(d.startTime),
          exists: !!d.exists,
          mime: d.mime || null,
        };
        if (d.error) out.error = d.error;
        if (d.paused) out.paused = true;
        if (d.danger && d.danger !== "safe" && d.danger !== "accepted") out.danger = d.danger;
        return out;
      })
      .sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
    return { downloads };
  },
});

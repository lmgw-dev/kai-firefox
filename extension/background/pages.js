// Talking to the content scripts of a tab's frames, resolving refs (D4), and the places Kai
// cannot read (§3), each an explicit error that says why. Every call to a content script is
// bounded by the setting content_ms: a page whose own script keeps its thread busy cannot answer.

import { OpError, about } from "./ops.js";
import { lookup } from "./refs.js";
import { settings } from "./settings.js";

const CONTENT = ["vendor/dom-accessibility-api.js", "content/kai.js", "content/walk.js", "content/read.js", "content/overlay.js", "content/act.js", "content/page.js", "content/listen.js", "content/aloud.js"];
const NO_RECEIVER = "Receiving end does not exist";
// The icons Firefox gives a tab that shows its PDF viewer or one of its error pages, both
// documents no extension can read.
const PDF_ICON = "chrome://global/skin/icons/pdf.svg";
const ERROR_ICONS = new Set(["chrome://global/skin/icons/info.svg", "chrome://global/skin/icons/warning.svg", "chrome://global/skin/icons/blocked.svg"]);
const PRIVILEGED = new Set(["about", "view-source", "chrome", "resource", "jar", "moz-extension", "moz-src"]);

const scheme = (url) => (/^([a-z][a-z0-9+.-]*):/i.exec(url || "")?.[1] ?? "").toLowerCase();

// Tabs Kai asked to navigate (tabs.open, tabs.go) whose new page has not committed yet. Right
// after tabs.create Firefox reports the new tab as a finished about:blank for a moment; while
// the navigation is pending that blank is the tab loading, not a page. Ends with the commit, an
// error, the tab closing, or after nav_load_ms.
const pendingNav = new Map(); // tabId -> timer
export function navPending(tabId) {
  clearTimeout(pendingNav.get(tabId));
  pendingNav.set(
    tabId,
    setTimeout(() => pendingNav.delete(tabId), settings.nav_load_ms),
  );
}
export const navEnded = (tabId) => {
  clearTimeout(pendingNav.get(tabId));
  pendingNav.delete(tabId);
};
const topEnd = (d) => {
  if (d.frameId === 0 && d.url !== "about:blank") navEnded(d.tabId);
};
for (const ev of ["onCommitted", "onCompleted", "onReferenceFragmentUpdated", "onHistoryStateUpdated"]) browser.webNavigation[ev].addListener(topEnd);
browser.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId === 0) navEnded(d.tabId);
});
browser.tabs.onRemoved.addListener(navEnded);

const loadingNow = (tab) => (tab.url || "") === "about:blank" && (tab.status === "loading" || pendingNav.has(tab.id));

// A tab between two pages: Firefox shows its first about:blank, or no document yet, while the next
// page loads; nothing in it can be read until that page commits.
const between = (tab) => new OpError("loading", `tab ${tab.id} is loading and shows no page yet; it can be read once the page has arrived`, about(tab));

// `promise` (a content script's answer, or Firefox's search in a tab), or content_timeout after
// content_ms; `what` names it, `tab` is the tab it concerns. `keys`: the answer may take keys_ms
// longer (element.fill pressing keys).
export function inTime(promise, what, tab, { keys = false } = {}) {
  const ms = settings.content_ms + (keys ? settings.keys_ms : 0);
  const says = keys ? `${settings.keys_ms} ms of keys and ${settings.content_ms} ms (Kai for Firefox's settings keys_ms and content_ms)` : `${ms} ms (Kai for Firefox's setting content_ms)`;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OpError("content_timeout", `${what} did not answer within ${says}: its page is busy, or its script is stuck`, about(tab))), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
const frameName = (tab, frameId) => (frameId === 0 ? `tab ${tab.id}` : `frame ${frameId} of tab ${tab.id}`);

// Why Kai cannot read the page `tab` shows, judged by its URL and status alone; null when that
// says nothing.
export async function urlAccess(tab) {
  const url = tab.url || "";
  if (loadingNow(tab)) return between(tab);
  if (url.startsWith("about:reader")) {
    let page = url;
    try {
      page = new URL(url).searchParams.get("url") || url;
    } catch {
      /* the URL as it is */
    }
    return new OpError("reader_view", `Kai cannot read Reader view yet; tab ${tab.id} shows the Reader view of a page`, { ...about(tab), page });
  }
  const s = scheme(url);
  if (PRIVILEGED.has(s)) return new OpError("firefox_page", `Kai cannot read Firefox's own pages; tab ${tab.id} shows one`, about(tab));
  if (s === "file" && !(await browser.extension.isAllowedFileSchemeAccess())) {
    return new OpError("file_access", `Kai for Firefox may not read local files; tab ${tab.id} shows one. Allow "Access local files on your computer" in about:addons, Kai for Firefox, Permissions`, about(tab));
  }
  return null;
}

// Why the content script of the top document of `tab` cannot run, after an injection failed. A
// tab that is loading has no document to inject into until the next page commits, whatever its
// URL says.
async function topRefusal(tab, error) {
  const now = await browser.tabs.get(tab.id).catch(() => tab);
  if (now.status === "loading" || loadingNow(now)) return between(now);
  const byUrl = await urlAccess(tab);
  if (byUrl) return byUrl;
  if (tab.favIconUrl === PDF_ICON) return new OpError("pdf_viewer", `tab ${tab.id} shows a PDF in Firefox's viewer, which extensions cannot read`, about(tab));
  if (ERROR_ICONS.has(tab.favIconUrl)) return new OpError("error_page", `tab ${tab.id} shows one of Firefox's error pages`, about(tab));
  const s = scheme(tab.url);
  if (s === "http" || s === "https") {
    const origin = new URL(tab.url).origin;
    if (!(await browser.permissions.contains({ origins: [`${origin}/*`] }))) {
      return new OpError("site_permission", `Kai for Firefox may not read the site tab ${tab.id} shows; allow it in about:addons, Kai for Firefox, Permissions`, about(tab));
    }
    if (/host permission/i.test(error.message)) {
      return new OpError(
        "restricted_domain",
        `Firefox keeps extensions out of the site tab ${tab.id} shows: it is on Firefox's restricted domains (the pref extensions.webextensions.restrictedDomains) or quarantined domains`,
        about(tab),
      );
    }
  }
  return new OpError("no_content", `Kai cannot read tab ${tab.id}: ${error.message}`, about(tab));
}

// Why a child frame could not be read, from its URL and how its content script failed: an
// OpError with a code that says so. Firefox's own page in a frame, a local file without the
// permission, a site the user withdrew access from, a site on Firefox's restricted domains; else
// the failure itself (content_timeout, no_content). (Firefox runs content scripts in sandboxed
// frames, also without allow-scripts: they are read.)
export async function frameRefusal(url, error) {
  if (!(error instanceof OpError) || error.code !== "no_content") return error;
  const s = scheme(url);
  let code = "no_content";
  if (PRIVILEGED.has(s) && !/^about:(blank|srcdoc)$/.test(url || "")) code = "firefox_page";
  else if (s === "file" && !(await browser.extension.isAllowedFileSchemeAccess())) code = "file_access";
  else if (s === "http" || s === "https") {
    if (!(await browser.permissions.contains({ origins: [`${new URL(url).origin}/*`] }))) code = "site_permission";
    else if (/host permission/i.test(error.message)) code = "restricted_domain";
  }
  return code === "no_content" ? error : new OpError(code, error.message, error.extra);
}

// Calls the content script of one frame; injects it once when the frame has none yet (a page
// loaded before the extension started). Rejects with an OpError saying why the frame cannot be
// read. `document` (a documentId) pins the call to that document of the frame: the message and
// an injection go to it alone, and one that is no longer the frame's (a navigation committed, a
// meta refresh, a redirect, a script's `location =`) fails with page_changed instead of reaching
// the page after it.
export async function frameCall(tab, frameId, msg, { document = null } = {}) {
  const what = frameName(tab, frameId);
  const to = document ? { documentId: document } : { frameId };
  const left = () => (document ? documentLeft(tab, frameId, document) : null);
  try {
    return await inTime(browser.tabs.sendMessage(tab.id, msg, to), what, tab);
  } catch (e) {
    if (e instanceof OpError) throw e;
    const gone = await left();
    if (gone) throw gone;
    if (!e.message.includes(NO_RECEIVER)) throw new OpError("no_content", `${what} did not answer: ${e.message}`, about(tab));
  }
  if (frameId === 0) {
    const byUrl = await urlAccess(tab);
    if (byUrl) throw byUrl;
  }
  try {
    await inTime(browser.scripting.executeScript({ target: injectTarget(tab, frameId, document), files: CONTENT, injectImmediately: true }), what, tab);
  } catch (e) {
    if (e instanceof OpError) throw e;
    const gone = await left();
    if (gone) throw gone;
    if (frameId === 0) throw await topRefusal(tab, e);
    throw new OpError("no_content", `${what} cannot be read: ${e.message}`, about(tab));
  }
  try {
    return await inTime(browser.tabs.sendMessage(tab.id, msg, to), what, tab);
  } catch (e) {
    if (e instanceof OpError) throw e;
    const gone = await left();
    if (gone) throw gone;
    throw new OpError("no_content", `${what} did not answer: ${e.message}`, about(tab));
  }
}

const injectTarget = (tab, frameId, document) => (document ? { tabId: tab.id, documentIds: [document] } : { tabId: tab.id, frameIds: [frameId] });

// page_changed when the frame no longer shows `document` (a documentId), else null.
async function documentLeft(tab, frameId, document) {
  const now = await browser.webNavigation.getFrame({ tabId: tab.id, frameId }).catch(() => null);
  if (now?.documentId === document) return null;
  return new OpError("page_changed", `${frameName(tab, frameId)} left the page while Kai for Firefox read it, so nothing of it was read`, about(await browser.tabs.get(tab.id).catch(() => tab)));
}

// Runs a file (a vendored library) in one frame's content-script world, within content_ms;
// `document` pins it as frameCall's does.
export async function frameFile(tab, frameId, file, { document = null } = {}) {
  try {
    await inTime(browser.scripting.executeScript({ target: injectTarget(tab, frameId, document), files: [file], injectImmediately: true }), frameName(tab, frameId), tab);
  } catch (e) {
    if (e instanceof OpError) throw e;
    const gone = document ? await documentLeft(tab, frameId, document) : null;
    if (gone) throw gone;
    throw new OpError("no_content", `${frameName(tab, frameId)} cannot run ${file}: ${e.message}`, about(tab));
  }
}

export const topFrame = (tab) => frameCall(tab, 0, { kai: "whoami" });

// Every frame of the tab, asked `msg` at once: [{ frameId, parentFrameId, url, result | error }],
// the top frame first. `top` (a documentId) pins the top frame's call to that document
// (frameCall's `document`).
export async function allFrames(tab, msg, { top = null } = {}) {
  const frames = (await browser.webNavigation.getAllFrames({ tabId: tab.id })) || [];
  frames.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0));
  return Promise.all(
    frames.map((f) => {
      const at = { frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url };
      return frameCall(tab, f.frameId, msg, f.frameId === 0 && top ? { document: top } : {}).then(
        (result) => ({ ...at, result }),
        (error) => ({ ...at, error }),
      );
    }),
  );
}

// A ref's tab, frame and document, checked to be alive; the explicit stale errors otherwise.
export async function resolveRef(ref) {
  const e = await lookup(ref);
  if (!e) throw new OpError("unknown_ref", `ref ${ref} was never given out in this Firefox run`);
  if (e.earlier) {
    throw new OpError("unknown_ref", `ref ${ref} is from before Kai for Firefox restarted (reloaded, updated, enabled again, or its background suspended); the extension no longer knows its element`);
  }
  let tab;
  try {
    tab = await browser.tabs.get(e.tab);
  } catch {
    throw new OpError("stale_tab", `ref ${ref} was in tab ${e.tab}, which is closed`, { tab: e.tab });
  }
  const frames = (await browser.webNavigation.getAllFrames({ tabId: e.tab })) || [];
  // A gone record's document may be shown again (Back from the back-forward cache): its refs
  // stay stale, and its elements get new ones.
  if (e.gone || !frames.some((f) => f.documentId === e.document)) {
    if (e.frame === 0) throw new OpError("stale_document", `ref ${ref} is from the page before the last navigation in tab ${tab.id}`, about(tab));
    const frameNow = frames.find((f) => f.frameId === e.frame);
    throw new OpError("stale_document", frameNow ? `ref ${ref} is from the page before the last navigation of a frame in tab ${tab.id}` : `ref ${ref} was in a frame that is gone from tab ${tab.id}`, about(tab));
  }
  return { tab, entry: e };
}

// Asks the content script that holds a ref's element; `gone` answers become stale_element.
export async function elementCall(ref, msg) {
  const { tab, entry } = await resolveRef(ref);
  return askElement(ref, tab, entry, msg);
}

// elementCall for a ref already resolved; `opts` as inTime's.
export async function askElement(ref, tab, entry, msg, opts) {
  let r;
  try {
    r = await inTime(browser.tabs.sendMessage(tab.id, { ...msg, local: entry.local }, { documentId: entry.document }), `ref ${ref}'s page in tab ${tab.id}`, tab, opts);
  } catch (e) {
    if (e instanceof OpError) throw e;
    // Gone meanwhile (the precise error), or going: a navigation away from it has begun.
    await resolveRef(ref);
    throw new OpError("stale_document", `ref ${ref}'s page in tab ${tab.id} no longer answers; it is being left (${e.message})`, about(tab));
  }
  if (r?.gone) throw new OpError("stale_element", `ref ${ref}'s element is no longer in the page of tab ${tab.id}${r.gone === "removed" ? " (the page removed it)" : ""}`, about(tab));
  return { tab, entry, r };
}

// Asks the content script of one document of a tab (by its documentId), within content_ms; a
// document that is gone or being left is stale_document.
export async function documentCall(tab, documentId, msg, what = `the page of tab ${tab.id}`) {
  try {
    return await inTime(browser.tabs.sendMessage(tab.id, msg, { documentId }), what, tab);
  } catch (e) {
    if (e instanceof OpError) throw e;
    throw new OpError("stale_document", `${what} no longer answers; it was left (${e.message})`, about(tab));
  }
}

// The top document of `tab` when its origin is `origin`, the one Kai approved (page.css,
// page.script): { document, origin, marker, ... } of whoami. Another origin, or an opaque one, is
// page_changed. The caller then targets that document by its id, so a page that is left before
// Firefox injects fails too (pageLeft).
export async function approvedTop(tab, origin, what) {
  const top = await frameCall(tab, 0, { kai: "whoami" });
  if (top.origin === null || top.origin !== origin) {
    throw new OpError("page_changed", `tab ${tab.id} shows a page of ${top.origin === null ? "no origin Kai can approve (an opaque one)" : "another origin than the one Kai approved"}, so ${what}`, about(tab));
  }
  return top;
}
// Firefox's refusal of a documentId that no longer names a document: the page was left.
export const pageLeft = (e) => /Invalid documentId/i.test(e?.message ?? "");

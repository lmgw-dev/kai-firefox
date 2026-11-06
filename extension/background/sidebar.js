// The sidebar's requests (design §8.2, §4.4; docs/protocol/operations.md, "The sidebar's
// requests"): the sidebar page is lmgw's Chat, and every request it makes comes here over a
// runtime.Port and goes on to Kai as a `req` frame; Kai sends it to lmgw with its own device
// certificate and answers with `res`, `chunk` and `end` frames, which go back to the page.
//
// - Only the extension's own sidebar page may open the port: its URL is SIDEBAR_PAGE's and no tab
//   is attached (an extension page in a tab, another extension page and a content script are
//   refused with a `refused` message and disconnected). Kai's reach on lmgw is the sidebar's, so
//   nothing a web page runs may reach it.
// - Ids: the page numbers its requests; the relay gives each a number of its own for the link
//   (a counter that is never reused while the extension runs), so the pages of several windows
//   never share one, and maps Kai's frames back.
// - Flow control: the page acknowledges each chunk as it takes it from its port (`ack`,
//   cumulative), for a whole answer as for a stream, and the relay passes the acks on. It
//   acknowledges nothing itself: neither native messaging nor a runtime port has backpressure, so
//   only the page's acks keep Kai from sending more than the page has taken (Kai's window,
//   `browser.sidebar_ahead_mb`). A page that acked a whole answer only once it was complete would
//   wait forever for one larger than the window.
// - A port that disconnects (the sidebar closed, its page reloaded) aborts its open requests at
//   Kai; the link to Kai going ends them all with `end` and `error.code` `no_link`, and a request
//   while there is no link ends so at once. Kai's `error` frame about a request ends it at its page
//   as an `end` with that error. The page hears the link come and go (`link`).
// - Nothing here reads a request's body or an answer: the relay renumbers and passes on.
//
// The page also asks the background three things of its own (`site`, `page_text`, `hints`, each
// answered by an `answer` frame with `ok` or `error`), for the strip above the Chat (design §8.1):
// - `site {url}`: the site and its rule (`act`, `read`, `none`) as Kai's site rules give it; Kai
//   holds the rules (`[browser.sites]`), so the background asks Kai with a `site` frame. A Kai
//   whose welcome does not list `site` among the frames it takes is older than the question: the
//   answer is the error kai_too_old at once.
// - `page_text {tab}`: the tab's readable text, as page.text@1 reads it, for "Attach this page":
//   only a web page or a local file (never Firefox's own pages or an extension's, `moz-extension:`
//   included), never a `none` site, and the blocks of frames of `none` sites left out (Kai says
//   each frame's rule by its origin, an opaque one getting the strictest). The read is pinned to
//   the top document whose rule was asked (its documentId): a page left before or while it is read
//   fails it (page_changed), and the rule that counts is the one of the URL the read document had.
// - `hints {tab, on}`: the hint labels on or off in the tab (hints.show@1, hints.hide@1), on only
//   where the rule is not `none`, pinned to the document as the read is. The labels a page turned
//   on go when its port does, also those it turned on while its port went, or that it turned off
//   while they were drawn.
// - Rules: `act` and `read` are the words that let anything through; every other word (`none`, a
//   word this version does not know, none at all) is `none`.

import * as link from "./link.js";
import * as ops from "./ops.js";
import { OpError, errorOf, about } from "./ops.js";
import { pageTextLines } from "./pagetext.js";
import { readText } from "./read.js";
import { showHints } from "./hints.js";

// The sidebar's page (WP8b). The tests install a copy of the extension with a page there.
export const SIDEBAR_PAGE = "sidebar/sidebar.html";
// The port's name the page connects with.
export const PORT = "kai-sidebar";

let nextId = 0;
// link id -> { port, id: the page's id }
const open = new Map();
// port -> Map(page id -> link id), for the ports open now
const ports = new Map();
// Kai's answers to the background's `site` questions: link id -> { resolve, reject }
const asks = new Map();
// port -> Map(tab -> the call that turned its hints on last), the tabs whose hints the page wants
const hinted = new Map();

// A rule as the background applies it: `act` and `read` as they are, anything else `none` (the
// strictest): a word this version does not know, or none, lets nothing through.
export const ruleWord = (rule) => (rule === "act" || rule === "read" ? rule : "none");

// Whether `sender` is the extension's own sidebar page: its URL (query and fragment aside) is
// SIDEBAR_PAGE's, and no tab is attached.
export function isSidebarPage(sender) {
  if (!sender || sender.id !== browser.runtime.id || sender.tab || typeof sender.url !== "string") return false;
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  url.search = "";
  url.hash = "";
  return url.href === browser.runtime.getURL(SIDEBAR_PAGE);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT) return;
  if (!isSidebarPage(port.sender)) {
    const s = port.sender ?? {};
    const where = s.tab ? `a page in tab ${s.tab.id}` : String(s.url ?? "an unknown sender");
    console.warn(`Kai for Firefox: the sidebar's port refused to ${where}: only the extension's own sidebar page may send requests to Kai`);
    try {
      port.postMessage({ t: "refused", reason: "only Kai for Firefox's sidebar page may send requests to Kai" });
    } catch {
      /* gone already */
    }
    port.disconnect();
    return;
  }
  const mine = new Map();
  ports.set(port, mine);
  port.onMessage.addListener((m) => fromPage(port, mine, m));
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    for (const lid of mine.values()) {
      open.delete(lid);
      link.toKai({ t: "abort", id: lid });
    }
    mine.clear();
    for (const tab of hinted.get(port)?.keys() ?? []) hideHints(tab);
    hinted.delete(port);
  });
  post(port, { t: "link", up: link.linked() });
});

function post(port, m) {
  try {
    port.postMessage(m);
    return true;
  } catch {
    return false;
  }
}

const isId = (v) => Number.isSafeInteger(v) && v >= 0;

function fromPage(port, mine, m) {
  if (!m || typeof m !== "object") return;
  switch (m.t) {
    case "req": {
      if (!isId(m.id) || mine.has(m.id)) {
        post(port, { t: "error", code: "bad_req", id: m.id ?? null, message: "a request needs a whole-number id that is not open on this port" });
        return;
      }
      if (!link.linked()) {
        post(port, { t: "end", id: m.id, error: { code: "no_link", message: "Kai is not linked" } });
        return;
      }
      const lid = ++nextId;
      mine.set(m.id, lid);
      open.set(lid, { port, id: m.id });
      link.toKai({ t: "req", id: lid, method: m.method, path: m.path, headers: m.headers ?? {}, body: m.body ?? null, read: m.read ?? "whole" });
      return;
    }
    case "ack": {
      const lid = mine.get(m.id);
      if (lid !== undefined && isId(m.seq)) link.toKai({ t: "ack", id: lid, seq: m.seq });
      return;
    }
    case "abort": {
      const lid = mine.get(m.id);
      if (lid === undefined) return;
      mine.delete(m.id);
      open.delete(lid);
      link.toKai({ t: "abort", id: lid });
      return;
    }
    case "site":
    case "page_text":
    case "hints": {
      if (!isId(m.id)) {
        post(port, { t: "error", code: "bad_req", id: m.id ?? null, message: `a ${m.t} call needs a whole-number id` });
        return;
      }
      const run = m.t === "site" ? siteOf(m.url) : m.t === "page_text" ? pageText(m.tab) : hints(port, m.tab, m.on === true);
      run.then(
        (ok) => post(port, { t: "answer", id: m.id, ok }),
        (e) => post(port, { t: "answer", id: m.id, error: errorOf(e) }),
      );
      return;
    }
    default:
      console.debug(`Kai for Firefox: a ${m.t} message from the sidebar page, which the relay does not take; ignored`);
  }
}

// Kai's rules for `urls` (a page's URL, or a frame's origin; "" for an opaque one, which gets the
// strictest rule): [{ site, rule }] in their order.
function kaiRules(urls) {
  if (!link.linked()) return Promise.reject(new OpError("no_link", "Kai is not linked"));
  if (!link.kaiTakes("site")) {
    const v = link.kaiVersion();
    return Promise.reject(new OpError("kai_too_old", `Kai${v ? ` ${v}` : ""} does not answer the sidebar's question about a site's rule yet: update Kai`));
  }
  const lid = ++nextId;
  return new Promise((resolve, reject) => {
    asks.set(lid, { resolve, reject });
    if (!link.toKai({ t: "site", id: lid, urls })) {
      asks.delete(lid);
      reject(new OpError("no_link", "Kai is not linked"));
    }
  }).then((rules) => {
    if (!Array.isArray(rules) || rules.length !== urls.length) throw new OpError("bad_answer", `Kai answered ${Array.isArray(rules) ? rules.length : "no"} rules for ${urls.length} addresses`);
    return rules;
  });
}

// Web pages and local files: what Kai for Firefox reads (design §3, §14 item 38). Firefox's own
// pages, an extension's (moz-extension:, its own included) and data: or blob: pages are not.
const readable = (url) => /^(https?|file):/i.test(url ?? "");

async function siteOf(url) {
  if (typeof url !== "string" || !url) throw new OpError("bad_args", "site needs the page's url");
  const [r] = await kaiRules([url]);
  return { site: String(r?.site ?? ""), rule: ruleWord(r?.rule) };
}

async function tabOf(id) {
  if (!Number.isSafeInteger(id)) throw new OpError("bad_args", "the call needs the tab's id");
  try {
    return await browser.tabs.get(id);
  } catch {
    throw new OpError("no_tab", `there is no tab ${id}`);
  }
}

const siteNone = (r, what) => new OpError("site_none", `${r?.site || what} has the rule none in Kai's site rules: Kai reads nothing of it`);

// The tab's page when Kai for Firefox may read it, pinned: its top document now (frame 0's
// documentId, which the read then targets alone), that document's URL, a web page or a local
// file, and its rule, which is not `none`.
async function readableTab(id) {
  const tab = await tabOf(id);
  const top = await browser.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null);
  const url = top?.url ?? tab.url;
  if (!readable(url)) throw new OpError("not_a_site", `tab ${tab.id} shows no web page or local file; Kai for Firefox reads only those`);
  if (!top?.documentId) throw new OpError("loading", `tab ${tab.id} shows no page yet; it can be read once the page has arrived`, about(tab));
  const [r] = await kaiRules([url]);
  if (ruleWord(r?.rule) === "none") throw siteNone(r, "this site");
  return { tab, document: top.documentId, url };
}

async function pageText(id) {
  const pin = await readableTab(id);
  const { result: r, top } = await readText(pin.tab, { document: pin.document });
  // What was read is the pinned document (every call went to it alone, and its answers say which
  // document they came from); its rule is the one of the URL it had when it was read, which a
  // script may have moved within the document (history.pushState).
  if (top.document !== pin.document || !top.url) throw new OpError("page_changed", `tab ${pin.tab.id} left the page while Kai for Firefox read it, so nothing of it was attached`, about(pin.tab));
  if (top.url !== pin.url) {
    if (!readable(top.url)) throw new OpError("page_changed", `tab ${pin.tab.id} left the page while Kai for Firefox read it, so nothing of it was attached`, about(pin.tab));
    const [now] = await kaiRules([top.url]);
    if (ruleWord(now?.rule) === "none") throw siteNone(now, "the page");
  }
  const blocks = Array.isArray(r.blocks) ? r.blocks : [];
  const origins = [...new Set(blocks.filter((b) => b.frame !== undefined && b.frame !== null).map((b) => b.origin ?? ""))];
  const rules = origins.length ? await kaiRules(origins) : [];
  const none = new Set(origins.filter((o, i) => ruleWord(rules[i]?.rule) === "none"));
  const text = pageTextLines(blocks, (o) => none.has(o)).join("\n");
  return { title: top.title || top.url, url: top.url, text, article: r.article === true };
}

function hideHints(tab) {
  ops.run("hints.hide@1", { tab }, { signal: new AbortController().signal }).catch(() => {});
}

async function hints(port, id, on) {
  const mine = hinted.get(port) ?? new Map();
  hinted.set(port, mine);
  if (!on) {
    // A show still being drawn for this tab sees it is no longer wanted.
    mine.delete(id);
    const tab = await tabOf(id);
    const r = await ops.run("hints.hide@1", { tab: tab.id }, { signal: new AbortController().signal });
    return { shown: false, removed: r.removed ?? 0 };
  }
  const call = {};
  mine.set(id, call);
  let r;
  try {
    const pin = await readableTab(id);
    r = await showHints(pin.tab, { document: pin.document });
  } catch (e) {
    if (mine.get(id) === call) mine.delete(id);
    throw e;
  }
  // The page's port went, or the page turned them off, while they were drawn: they go again.
  if (!ports.has(port) || mine.get(id) !== call) {
    hideHints(id);
    throw new OpError("hints_off", `the hints of tab ${id} were turned off while they were drawn`);
  }
  return { shown: true, labels: Array.isArray(r.controls) ? r.controls.length : 0 };
}

// Kai's answer frames: to the page that asked, under its own id. A frame for a request the page
// dropped (an abort on its way) is dropped. Kai's `error` frame about a request (`duplicate_req`:
// it holds another request under that id, and sent this one nowhere) ends the page's request with
// that error, and the request Kai holds under the id is aborted, so neither side keeps it.
link.onBody((m) => {
  // Kai's answer to a site question, or its `error` about one (`bad_site`).
  if (asks.has(m.id) && (m.t === "site" || m.t === "error")) {
    const a = asks.get(m.id);
    asks.delete(m.id);
    if (m.t === "site") a.resolve(m.rules);
    else a.reject(new OpError(String(m.code ?? "error"), String(m.message ?? "")));
    return;
  }
  const r = open.get(m.id);
  if (!r) return;
  if (m.t === "error") {
    open.delete(m.id);
    ports.get(r.port)?.delete(r.id);
    link.toKai({ t: "abort", id: m.id });
    post(r.port, { t: "end", id: r.id, error: { code: String(m.code ?? "error"), message: String(m.message ?? "") } });
    return;
  }
  if (m.t === "end") {
    open.delete(m.id);
    ports.get(r.port)?.delete(r.id);
  }
  post(r.port, { ...m, id: r.id });
});

// The link went: every open request ends, and so does every question to Kai.
link.onLost((why) => {
  for (const [lid, a] of asks) {
    asks.delete(lid);
    a.reject(new OpError("no_link", `the link to Kai closed (${why})`));
  }
  for (const [lid, r] of open) {
    open.delete(lid);
    ports.get(r.port)?.delete(r.id);
    post(r.port, { t: "end", id: r.id, error: { code: "no_link", message: `the link to Kai closed (${why})` } });
  }
});

link.onLink((up) => {
  for (const port of ports.keys()) post(port, { t: "link", up });
});

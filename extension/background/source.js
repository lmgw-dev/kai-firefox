// Source and DOM (design §5.6): the HTML the server sent for a page, fetched again; the live
// document as HTML, frames included; one element's HTML.
//
// page.source needs to know how each top-level document was requested: a GET can be fetched
// again, a POST cannot without sending its form again. The background records every main_frame
// request (webRequest.onBeforeRequest, each redirect's hop) and every top-level commit
// (webNavigation.onCommitted), and gives a document its request when page.source asks
// (docrequests.js says which). A request's event can come after its document has loaded, so
// page.source waits for it, within content_ms, for a document that began loading after the
// extension started and is no page restored from the back-forward cache. A document Back or
// Forward restores keeps its record. Records are kept in storage.session, one key each, so a
// suspended background keeps them, until their tab closes. The answer lists the frame addresses
// in the text as written (htmlframes.js), so Kai can take out those of sites it does not reach.

import { define, OpError, about, cancellable } from "./ops.js";
import { settings } from "./settings.js";
import { tabArg } from "./tabs.js";
import { frameCall, allFrames, urlAccess, elementCall, frameRefusal } from "./pages.js";
import { frameReport, tabRef } from "./compose.js";
import { originOf } from "./url.js";
import { DocRequests } from "./docrequests.js";
import { frameAddresses } from "./htmlframes.js";

const DOC = "doc:";
const REQ = "req:";
const LAST = "last:";
const LOADED = "loaded:"; // + tab:time
const known = new DocRequests();
// When this run of the extension began (a suspended background keeps it): a document that began
// loading earlier was requested unseen.
let startedAt = Date.now();
// page.source's waits for a request event: functions called after each main_frame event.
const waiting = new Set();

const ready = browser.storage.session
  .get(null)
  .then((all) => {
    if (Number.isFinite(all.source_started)) startedAt = all.source_started;
    else browser.storage.session.set({ source_started: startedAt }).catch(() => {});
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(DOC) && !known.docs.has(k.slice(DOC.length))) known.docs.set(k.slice(DOC.length), v);
      else if (k.startsWith(REQ) && !known.reqs.has(k.slice(REQ.length))) {
        known.reqs.set(k.slice(REQ.length), v);
        known.n = Math.max(known.n, v.n);
      } else if (k.startsWith(LOADED)) {
        if (!known.loads.some((l) => l.tab === v.tab && l.ts === v.ts)) known.loads.push(v);
      } else if (k.startsWith(LAST)) {
        const tab = Number(k.slice(LAST.length));
        known.last.set(tab, Math.max(known.last.get(tab) ?? v, v));
      }
    }
  })
  .catch((e) => console.warn(`Kai for Firefox: the pages' requests were not read: ${e.message}`));
const keep = (patch) => browser.storage.session.set(patch).catch((e) => console.warn(`Kai for Firefox: a page's request was not kept: ${e.message}`));

// Events wait for the kept records (a background Firefox started again for them), in the order
// they came.
browser.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || d.frameId !== 0) return;
    ready.then(() => {
      keep({ [REQ + d.requestId]: known.request(d) });
      for (const w of waiting) w();
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);
browser.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (d.tabId < 0 || d.frameId !== 0) return;
    ready.then(() => {
      const rec = known.failed(d);
      if (rec) keep({ [REQ + d.requestId]: rec });
      for (const w of waiting) w();
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);
browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || !d.documentId) return;
  ready.then(() => {
    const { doc, last } = known.commit(d);
    keep(doc ? { [DOC + d.documentId]: doc, [LAST + d.tabId]: last } : { [LAST + d.tabId]: last });
  });
});
browser.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId !== 0 || !d.documentId) return;
  ready.then(() => {
    const rec = known.loaded(d);
    keep({ [`${LOADED}${rec.tab}:${rec.ts}`]: rec });
  });
});
browser.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const loads = known.loads.filter((l) => l.tab === tabId).map((l) => `${LOADED}${l.tab}:${l.ts}`);
  const { docs, reqs } = known.forgetTab(tabId);
  browser.storage.session.remove([...docs.map((d) => DOC + d), ...reqs.map((r) => REQ + r), ...loads, LAST + tabId]).catch(() => {});
});

let nextToken = 1;

// An attribute value's character references resolved by Firefox's HTML parser, inside the quote
// it was written in.
const parser = new DOMParser();
const decodeAttr = (value, quote) => parser.parseFromString(`<i v=${quote}${value}${quote}>`, "text/html").body.firstElementChild?.getAttribute("v") ?? value;

// The request of a document whose request event is still to come (DocRequests.awaits), once it
// has come; null when it does not come within content_ms.
function requestOf(document, timeOrigin, signal) {
  return cancellable(
    signal,
    new Promise((resolve) => {
      let timer;
      const check = () => {
        if (known.awaits(document, timeOrigin, startedAt)) return;
        waiting.delete(check);
        clearTimeout(timer);
        resolve(known.of(document));
      };
      timer = setTimeout(() => {
        waiting.delete(check);
        resolve(null);
      }, settings.content_ms);
      waiting.add(check);
      check();
    }),
  );
}

define("page.source@1", {
  args: { tab: { type: "integer" } },
  async run({ tab: id }, { signal }) {
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    const top = await frameCall(tab, 0, { kai: "whoami" });
    await ready;
    let rec = known.of(top.document);
    const late = !rec && known.awaits(top.document, top.time_origin, startedAt);
    if (late) rec = await requestOf(top.document, top.time_origin, signal);
    if (!rec) {
      throw new OpError(
        "source_unknown",
        late
          ? `Firefox did not report how the page in tab ${tab.id} was requested within ${settings.content_ms} ms (Kai for Firefox's setting content_ms); page.dom reads the live document`
          : `Kai for Firefox does not know how the page in tab ${tab.id} was requested: it loaded before the extension started, or did not come from a request (about:blank, data:, a page a script wrote); page.dom reads the live document`,
        about(tab),
      );
    }
    if (rec.method !== "GET") {
      throw new OpError("not_get", `the page in tab ${tab.id} is the answer to a ${rec.method}; fetching it again would send that request again, so page.dom reads the live document instead`, { ...about(tab), method: rec.method });
    }
    // From the cache alone first; from the server only when the cache has none (`cache`).
    const token = nextToken++;
    let r;
    try {
      r = await cancellable(signal, browser.tabs.sendMessage(tab.id, { kai: "source", url: rec.url, token }, { documentId: top.document }));
    } catch (e) {
      if (e.code === "cancelled") browser.tabs.sendMessage(tab.id, { kai: "source_abort", token }, { documentId: top.document }).catch(() => {});
      if (e instanceof OpError) throw e;
      throw new OpError("stale_document", `the page of tab ${tab.id} was left while its source was fetched (${e.message})`, about(tab));
    }
    if (!r.ok) throw new OpError("fetch_failed", `Kai for Firefox could not fetch the source of tab ${tab.id} again: ${r.error}`, about(tab));
    const out = { tab: tabRef(tab), url: rec.url, method: "GET", cache: r.cached, status: r.status, content_type: r.content_type, charset: r.charset, bytes: r.bytes };
    if (r.response_url && r.response_url !== rec.url) out.response_url = r.response_url;
    out.frames = frameAddresses(r.text, r.response_url || rec.url, decodeAttr);
    out.text = r.text;
    return out;
  },
});

// An unread frame where its document would be: its id, URL, origin, why, its <iframe>'s title and
// URL attribute (`src`, only when it has one; the parent's HTML has only its origin).
const unread = (frame, url, code, p) => {
  const out = { frame, url: url ?? null, origin: originOf(url), unread: code, title: p.title ?? "" };
  if (p.src !== undefined) out.src = p.src;
  return out;
};
const read = (p, d, html) => {
  const out = { frame: p.frame, url: d.url, origin: d.origin ?? null };
  if (p.src !== undefined) out.src = p.src;
  out.html = html;
  return out;
};

define("page.dom@1", {
  args: { tab: { type: "integer" } },
  async run({ tab: id }) {
    const tab = await tabArg(id);
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    const answers = await allFrames(tab, { kai: "dom" });
    const top = answers.find((a) => a.frameId === 0);
    if (!top || top.error) throw top?.error ?? new OpError("no_content", `tab ${tab.id} has no top document to read`, about(tab));
    const { unread: why, frames } = await frameReport(tab, answers);
    const byId = new Map(answers.map((a) => [a.frameId, a]));
    const seen = new Set();
    const fill = (parts) =>
      parts.map((p) => {
        if (typeof p === "string") return p;
        const a = byId.get(p.frame);
        if (!a?.result || seen.has(p.frame)) return unread(p.frame, a?.url, why.get(p.frame)?.code ?? "no_content", p);
        seen.add(p.frame);
        return read(p, a.result, fill(a.result.html));
      });
    seen.add(0);
    return { tab: tabRef(tab), url: top.result.url, html: fill(top.result.html), frames };
  },
});

// The frames inside an element's HTML, each asked for its document, recursively.
async function withFrames(tab, parts, seen = new Set()) {
  const out = [];
  for (const p of parts) {
    if (typeof p === "string") {
      out.push(p);
      continue;
    }
    const url = (await browser.webNavigation.getFrame({ tabId: tab.id, frameId: p.frame }).catch(() => null))?.url;
    if (seen.has(p.frame)) {
      out.push(unread(p.frame, url, "no_content", p));
      continue;
    }
    seen.add(p.frame);
    try {
      const d = await frameCall(tab, p.frame, { kai: "dom" });
      out.push(read(p, d, await withFrames(tab, d.html, seen)));
    } catch (e) {
      const w = await frameRefusal(url, e);
      out.push(unread(p.frame, url, w.code ?? "no_content", p));
    }
  }
  return out;
}

define("element.dom@1", {
  args: { ref: { type: "ref", required: true } },
  async run({ ref }) {
    const { tab, entry, r } = await elementCall(ref, { kai: "element_dom" });
    const out = { ref, tab: tabRef(tab), role: r.el.role, name: r.el.name };
    if (r.el.level !== undefined) out.level = r.el.level;
    if (entry.frame !== 0) Object.assign(out, { frame: entry.frame, origin: r.origin ?? null });
    out.html = await withFrames(tab, r.html);
    return out;
  },
});

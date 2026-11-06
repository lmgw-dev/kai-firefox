// Which request each top-level document of a tab answered (page.source, source.js), from
// webRequest's main_frame requests and webNavigation's commits and loads. The two APIs' events
// arrive in either order, a request's often after its document has committed and loaded (Firefox
// 159, measured), but their time stamps are both taken when the event happens. So a document is
// given, when it is asked about, the newest request of its tab that began after the tab's commit
// before it and before its own commit, when its URL (the last of its redirects) is the
// document's and it did not end without a document: it failed (webRequest's error), or the tab
// finished loading a document committed before the request began (a download). Anything else is
// unknown: a request is never given to a document that committed before it began. A document
// Back or Forward restores from the back-forward cache commits again with its id and keeps what
// it had. No browser API here, so Node's tests import this file as it is.

const noFragment = (url) => String(url).replace(/#.*$/s, "");

export class DocRequests {
  docs = new Map(); // documentId -> { tab, url, ts, prev }
  reqs = new Map(); // requestId -> { tab, method, url, began, failed, n }
  last = new Map(); // tabId -> the time of its newest top-level commit
  loads = []; // { tab, ts, doc }: the tabs' top-level loads that finished
  n = 0;

  // webRequest.onBeforeRequest of a main_frame request, also each redirect's; the record to keep.
  request(d) {
    const was = this.reqs.get(d.requestId);
    const rec = { tab: d.tabId, method: d.method, url: noFragment(d.url), began: d.timeStamp, failed: was?.failed ?? false, n: ++this.n };
    this.reqs.set(d.requestId, rec);
    return rec;
  }

  // webRequest.onErrorOccurred of a main_frame request: it brought no document.
  failed(d) {
    const rec = this.reqs.get(d.requestId);
    if (!rec) return null;
    rec.failed = true;
    return rec;
  }

  // webNavigation.onCommitted of a top-level document: its record to keep (null for a document
  // seen before), and the tab's newest commit time.
  commit(d) {
    const last = this.last.get(d.tabId) ?? null;
    this.last.set(d.tabId, last === null ? d.timeStamp : Math.max(last, d.timeStamp));
    if (this.docs.has(d.documentId)) return { doc: null, last: this.last.get(d.tabId) };
    const doc = { tab: d.tabId, url: noFragment(d.url), ts: d.timeStamp, prev: last };
    this.docs.set(d.documentId, doc);
    return { doc, last: this.last.get(d.tabId) };
  }

  // webNavigation.onCompleted of a top-level document: the record to keep.
  loaded(d) {
    const rec = { tab: d.tabId, ts: d.timeStamp, doc: d.documentId };
    this.loads.push(rec);
    return rec;
  }

  // The request a document answered: { method, url }, or null when it is not known.
  of(documentId) {
    const doc = this.docs.get(documentId);
    if (!doc) return null;
    let newest = null;
    for (const r of this.reqs.values()) {
      if (r.tab !== doc.tab || !(r.began < doc.ts) || (doc.prev !== null && !(r.began > doc.prev))) continue;
      if (!newest || r.began > newest.began || (r.began === newest.began && r.n > newest.n)) newest = r;
    }
    if (!newest || newest.failed || newest.url !== doc.url) return null;
    const ended = this.loads.some((l) => l.tab === doc.tab && l.ts > newest.began && l.ts < doc.ts && l.doc !== documentId && !((this.docs.get(l.doc)?.ts ?? -Infinity) >= newest.began));
    return ended ? null : { method: newest.method, url: newest.url };
  }

  // Whether a document's request may still be on its way: the document committed as a new one
  // (its navigation began, `timeOrigin`, after the extension started, `startedAt`, and after the
  // tab's commit before it, so it is no page restored from the back-forward cache) over HTTP, and
  // no request of its tab that began with its navigation and before its commit has come yet.
  awaits(documentId, timeOrigin, startedAt) {
    const doc = this.docs.get(documentId);
    if (!doc || !/^https?:/i.test(doc.url)) return false;
    if (!(timeOrigin >= startedAt) || (doc.prev !== null && !(timeOrigin >= doc.prev))) return false;
    // Time stamps are whole milliseconds, timeOrigin is not.
    for (const r of this.reqs.values()) if (r.tab === doc.tab && r.began < doc.ts && r.began >= timeOrigin - 1) return false;
    return true;
  }

  // A tab closed: its records go; the ids of those removed.
  forgetTab(tab) {
    const docs = [...this.docs].filter(([, d]) => d.tab === tab).map(([id]) => id);
    const reqs = [...this.reqs].filter(([, r]) => r.tab === tab).map(([id]) => id);
    for (const id of docs) this.docs.delete(id);
    for (const id of reqs) this.reqs.delete(id);
    this.last.delete(tab);
    this.loads = this.loads.filter((l) => l.tab !== tab);
    return { docs, reqs };
  }
}

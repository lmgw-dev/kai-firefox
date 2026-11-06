// Which request each top-level document answered (extension/background/docrequests.js), in Node,
// with event sequences as Firefox 159 sends them (time stamps and arrival order as measured: a
// request often arrives after its document committed and loaded).
import assert from "node:assert/strict";
import { DocRequests } from "../../extension/background/docrequests.js";

const U = "http://127.0.0.1:8000/";
const req = (k, requestId, method, path, timeStamp, tabId = 1) => k.request({ requestId, tabId, method, url: U + path, timeStamp });
const commit = (k, documentId, path, timeStamp, tabId = 1) => k.commit({ documentId, tabId, url: U + path, timeStamp });

export default [
  {
    name: "doc requests: a document gets its request in either arrival order, the last hop of a redirect, and keeps it when Back restores it",
    fn() {
      const k = new DocRequests();
      commit(k, "a", "cached-a.html", 35);
      assert.equal(k.of("a"), null, "its request has not arrived yet");
      req(k, "44", "GET", "cached-a.html", 12);
      assert.deepEqual(k.of("a"), { method: "GET", url: U + "cached-a.html" });
      req(k, "70", "GET", "r307?to=/cached-b.html", 657);
      req(k, "70", "GET", "cached-b.html#top", 662);
      commit(k, "b", "cached-b.html", 668);
      assert.deepEqual(k.of("b"), { method: "GET", url: U + "cached-b.html" });
      // Back to a from the back-forward cache: the same document commits again, with no request.
      commit(k, "a", "cached-a.html", 1288);
      assert.deepEqual(k.of("a"), { method: "GET", url: U + "cached-a.html" });
      // A POST whose load began again in another process (two begins, one request).
      req(k, "76", "POST", "posted", 3150);
      commit(k, "p", "posted", 3171);
      assert.deepEqual(k.of("p"), { method: "POST", url: U + "posted" });
      assert.equal(k.of("nope"), null);
    },
  },
  {
    name: "doc requests: a page restored from the back-forward cache without a record never takes the reload's request, and the reload's page does",
    fn() {
      const k = new DocRequests();
      req(k, "1", "GET", "help.html", 100);
      commit(k, "h", "help.html", 110);
      // The extension restarted: cached-a's document is not known; Back restores it.
      commit(k, "a", "cached-a.html", 1288);
      assert.equal(k.of("a"), null);
      // Reload: a new request, a new document. The request began after a committed.
      req(k, "73", "GET", "cached-a.html", 1909);
      assert.equal(k.of("a"), null, "a committed before the reload's request began");
      commit(k, "a2", "cached-a.html", 1912);
      assert.deepEqual(k.of("a2"), { method: "GET", url: U + "cached-a.html" });
      assert.equal(k.of("a"), null);
    },
  },
  {
    name: "doc requests: a request that brought no document (a download, a failed load) is not given to a later one",
    fn() {
      const k = new DocRequests();
      req(k, "1", "GET", "shop.html", 10);
      commit(k, "s", "shop.html", 20);
      k.loaded({ tabId: 1, documentId: "s", timeStamp: 30 });
      // A download: a request, no commit; the tab finishes loading with the page it showed.
      req(k, "2", "GET", "download", 2526);
      k.loaded({ tabId: 1, documentId: "s", timeStamp: 2534 });
      // A POST to the same URL whose commit arrives before its request event.
      commit(k, "d", "download", 4259);
      assert.equal(k.of("d"), null, "until the POST's own request is seen, the download's GET is not taken for it");
      // Without that load the download's GET would be the newest request with the URL.
      const without = new DocRequests();
      req(without, "2", "GET", "download", 2526);
      commit(without, "d", "download", 4259);
      assert.equal(without.of("d").method, "GET");
      req(k, "3", "POST", "download", 4253);
      assert.deepEqual(k.of("d"), { method: "POST", url: U + "download" });
      // A failed load, then its error page committed without a request of its own.
      req(k, "4", "GET", "gone.html", 5000);
      k.failed({ requestId: "4" });
      commit(k, "e", "gone.html", 5010);
      assert.equal(k.of("e"), null);
      // The newest request decides: an older one with the URL does not stand in for it.
      req(k, "5", "GET", "x.html", 6000);
      req(k, "6", "GET", "y.html", 6005);
      commit(k, "x", "x.html", 6010);
      assert.equal(k.of("x"), null);
    },
  },
  {
    name: "doc requests: tabs are apart, and a closed tab's records go",
    fn() {
      const k = new DocRequests();
      req(k, "1", "POST", "posted", 10, 1);
      req(k, "2", "GET", "posted", 11, 2);
      commit(k, "one", "posted", 20, 1);
      commit(k, "two", "posted", 21, 2);
      assert.deepEqual([k.of("one").method, k.of("two").method], ["POST", "GET"]);
      assert.deepEqual(k.forgetTab(1), { docs: ["one"], reqs: ["1"] });
      assert.equal(k.of("one"), null);
      assert.equal(k.of("two").method, "GET");
      assert.equal(k.last.has(1), false);
    },
  },
];

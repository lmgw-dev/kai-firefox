// The ref tables of extension/background/refs.js (D4) in Node, against a stand-in for the few
// browser APIs they use: the counter kept in storage.local across restarts of the extension and
// begun again at Firefox's start, and the records of documents that were replaced or closed.
// Each import with another query is a new instance of the background.
import assert from "node:assert/strict";

let instances = 0;

// A stand-in browser over `store` (storage.local), then a new instance of refs.js on it.
async function instance(store, { slowGet = null } = {}) {
  const on = { committed: [], removed: [] };
  const frames = new Map(); // tabId -> documentIds shown
  globalThis.browser = {
    storage: {
      local: {
        get: async (key) => {
          if (slowGet) await slowGet;
          return { [key]: store[key] };
        },
        set: async (o) => void Object.assign(store, o),
      },
    },
    webNavigation: {
      onCommitted: { addListener: (f) => on.committed.push(f) },
      getAllFrames: async ({ tabId }) => (frames.get(tabId) ?? []).map((documentId, frameId) => ({ frameId, documentId })),
    },
    tabs: { onRemoved: { addListener: (f) => on.removed.push(f) } },
  };
  const refs = await import(`../../extension/background/refs.js?instance=${++instances}`);
  return {
    refs,
    frames,
    commit: (tabId, frameId = 0) => Promise.all(on.committed.map((f) => f({ tabId, frameId }))),
    closeTab: (tabId) => on.removed.forEach((f) => f(tabId)),
  };
}

export default [
  {
    name: "refs: numbers go on across restarts of the extension, an earlier instance's refs say so, and Firefox's start begins at 1",
    async fn() {
      const store = {};
      const a = await instance(store);
      assert.equal(await a.refs.refFor(1, 0, "d1", 1), 1);
      assert.equal(await a.refs.refFor(1, 0, "d1", 2), 2);
      assert.equal(await a.refs.refFor(1, 0, "d1", 1), 1, "an element keeps its ref");
      assert.equal(store.ref_next, 3, "the counter is stored before the ref is answered");
      const b = await instance(store);
      assert.equal(await b.refs.refFor(1, 0, "d2", 1), 3, "a new instance goes on from the stored counter");
      assert.deepEqual(await b.refs.lookup(1), { earlier: true });
      assert.deepEqual(await b.refs.lookup(3), { tab: 1, frame: 0, document: "d2", local: 1 });
      assert.equal(await b.refs.lookup(4), null);
      await b.refs.browserStarted();
      assert.equal(store.ref_next, 1);
      assert.equal(await b.refs.refFor(1, 0, "d3", 1), 1, "Firefox's start begins a new run at 1");
      // The stored value read after the start was seen does not win over it.
      let release;
      const c = await instance({ ref_next: 500 }, { slowGet: new Promise((r) => (release = r)) });
      const started = c.refs.browserStarted();
      release();
      await started;
      assert.equal(await c.refs.refFor(1, 0, "d4", 1), 1);
    },
  },
  {
    name: "refs: interleaved documents keep each ref's own; a replaced document's and a closed tab's refs keep their tab and frame",
    async fn() {
      const store = {};
      const { refs, frames, commit, closeTab } = await instance(store);
      const r = [];
      for (const [tab, frame, doc, local] of [
        [1, 0, "top", 1],
        [1, 17179869185, "sub", 1],
        [1, 0, "top", 2],
        [2, 0, "other", 1],
        [1, 17179869185, "sub", 2],
      ]) {
        r.push(await refs.refFor(tab, frame, doc, local));
      }
      assert.deepEqual(r, [1, 2, 3, 4, 5]);
      assert.deepEqual(await refs.lookup(3), { tab: 1, frame: 0, document: "top", local: 2 });
      assert.deepEqual(await refs.lookup(5), { tab: 1, frame: 17179869185, document: "sub", local: 2 });
      // Tab 1 shows a new page: both its documents are replaced; tab 2's stays.
      frames.set(1, ["next"]);
      frames.set(2, ["other"]);
      await commit(1);
      assert.deepEqual(await refs.lookup(1), { tab: 1, frame: 0, document: "top", gone: true });
      assert.deepEqual(await refs.lookup(2), { tab: 1, frame: 17179869185, document: "sub", gone: true });
      assert.deepEqual(await refs.lookup(3), { tab: 1, frame: 0, document: "top", gone: true });
      assert.deepEqual(await refs.lookup(5), { tab: 1, frame: 17179869185, document: "sub", gone: true });
      assert.deepEqual(await refs.lookup(4), { tab: 2, frame: 0, document: "other", local: 1 });
      // A commit in a tab keeps the documents it still shows.
      await commit(2);
      assert.deepEqual(await refs.lookup(4), { tab: 2, frame: 0, document: "other", local: 1 });
      closeTab(2);
      assert.deepEqual(await refs.lookup(4), { tab: 2, frame: 0, document: "other", gone: true });
      // A replaced document shown again (Back from the back-forward cache): new refs, the old
      // ones stay stale.
      assert.equal(await refs.refFor(1, 0, "top", 1), 6);
      assert.deepEqual(await refs.lookup(1), { tab: 1, frame: 0, document: "top", gone: true });
      assert.deepEqual(await refs.lookup(6), { tab: 1, frame: 0, document: "top", local: 1 });
      assert.equal(store.ref_next, 7);
    },
  },
  {
    name: "refs: elements the garbage collector took leave their document's record; their refs stay given out with no local id, the others keep theirs",
    async fn() {
      const { refs } = await instance({});
      assert.deepEqual(await refs.refsFor(1, 0, "page", [1, 2, 3]), [1, 2, 3]);
      refs.forget("page", [2, 9]);
      refs.forget("never-seen", [1]);
      assert.deepEqual(await refs.lookup(2), { tab: 1, frame: 0, document: "page", local: null });
      assert.deepEqual(await refs.lookup(3), { tab: 1, frame: 0, document: "page", local: 3 });
      assert.deepEqual(await refs.refsFor(1, 0, "page", [3, 4]), [3, 4], "the others keep theirs; a new element gets the next number");
    },
  },
];

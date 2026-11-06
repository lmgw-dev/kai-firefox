// The tab facts' attribution (extension/background/user.js) in Node, with a stand-in `browser`
// whose events the tests fire in the orders Firefox may: an activation's event before or after
// the call that caused it returns, two calls at once, the user's activation in between, and
// Kai's input spans.
import assert from "node:assert/strict";

const event = () => {
  const listeners = [];
  return { addListener: (f) => listeners.push(f), fire: (...a) => Promise.all(listeners.map((f) => f(...a))) };
};

// A fresh instance of user.js on a fresh stand-in browser.
let instance = 0;
async function load() {
  const b = {
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event(), onRemoved: event(), getLastFocused: async () => ({ id: 1, focused: true }) },
    tabs: { onActivated: event(), onRemoved: event(), get: async (id) => ({ id, url: `https://tab${id}.example/` }) },
    storage: { session: { set: async () => {}, get: async () => ({}) } },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event() },
    runtime: { onMessage: event(), id: "kai-firefox@rootshell.dev" },
  };
  globalThis.browser = b;
  const user = await import(`../../extension/background/user.js?instance=${++instance}`);
  const activate = (tabId, windowId = 1) => b.tabs.onActivated.fire({ tabId, windowId });
  const input = (tabId) => b.runtime.onMessage.fire({ kai: "user_input" }, { id: b.runtime.id, tab: { id: tabId, url: `https://tab${tabId}.example/`, incognito: false } });
  return { user, b, activate, input, by: (id) => user.factsOf(id).activated_by };
}

export default [
  {
    name: "user facts: two tabs opened at once in one window, their activations before and after the calls return",
    async fn() {
      const { user, activate, by } = await load();
      user.willActivateIn(1);
      user.willActivateIn(1);
      await activate(10); // tab 10's event before its call returns
      user.activatedIn(1, 10);
      user.activatedIn(1, 11); // tab 11's call returns before its event
      await activate(11);
      assert.deepEqual([by(10), by(11)], ["extension", "extension"]);
      await activate(12);
      assert.equal(by(12), "user", "nothing is pending any more");
    },
  },
  {
    name: "user facts: the user's activation while a tab opens counts as the extension's, and the new tab's late event too",
    async fn() {
      const { user, activate, by } = await load();
      user.willActivateIn(1);
      await activate(20); // the user's, or the new tab's: it cannot be told
      user.activatedIn(1, 21);
      await activate(21);
      assert.deepEqual([by(20), by(21)], ["extension", "extension"]);
    },
  },
  {
    name: "user facts: a window opened by tabs.open, its first tab's activation before and after windows.create returns",
    async fn() {
      const { user, activate, by } = await load();
      user.willActivateNext();
      await activate(30, 3);
      user.nextDone(30);
      user.willActivateNext();
      user.nextDone(31);
      await activate(31, 4);
      assert.deepEqual([by(30), by(31)], ["extension", "extension"]);
      await activate(32, 4);
      assert.equal(by(32), "user");
      // A window that did not open leaves nothing pending.
      user.willActivateNext();
      user.nextDone(undefined);
      await activate(33, 4);
      assert.equal(by(33), "user");
    },
  },
  {
    name: "user facts: trusted input inside Kai's input span is Kai's, outside it the user's; an activation in a span is the extension's",
    async fn() {
      const { user, b, activate, input, by } = await load();
      const span = user.beginSpan();
      await input(40);
      await activate(41);
      assert.equal(user.factsOf(40).user_at, null);
      assert.ok(user.factsOf(40).kai_input_at > 0);
      assert.equal(by(41), "extension");
      // A page Kai typed into the address bar during the span commits after it: not the user's.
      await b.webNavigation.onBeforeNavigate.fire({ tabId: 40, frameId: 0 });
      assert.equal(user.closeSpan(span), true);
      assert.equal(user.closeSpan(span), false, "input.end once");
      assert.deepEqual(user.endSpan(span), [40]);
      await b.webNavigation.onCommitted.fire({ tabId: 40, frameId: 0, url: "https://typed.example/", transitionType: "typed", transitionQualifiers: [] });
      assert.equal(user.factsOf(40).user_origin, null);
      await input(40);
      assert.deepEqual([user.factsOf(40).user_origin, user.factsOf(40).user_at > 0], ["https://tab40.example", true]);
      await b.webNavigation.onCommitted.fire({ tabId: 40, frameId: 0, url: "https://typed.example/", transitionType: "typed", transitionQualifiers: [] });
      assert.equal(user.factsOf(40).user_origin, "https://typed.example");
    },
  },
];

// What Kai's focus rule needs from the extension (design §6.4): who activated each tab, where
// the user last acted (trusted input, activating a tab, an address typed), which window has the
// focus; the sandbox container of tabs.open (cookies its own); and history.seen for the guard on
// navigations.
import assert from "node:assert/strict";
import { call, fails, inPage, waitFor } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

const tabOf = async (env, id) => (await call(env, "tabs.list@1")).tabs.find((t) => t.id === id);
// The BiDi context of the top document of the tab showing `url`.
async function contextOf(env, url) {
  const tree = await env.ff.send("browsingContext.getTree", { maxDepth: 0 });
  const c = tree.contexts.find((x) => x.url === url);
  assert.ok(c, `no tab shows ${url}`);
  return c.context;
}
// A trusted click at the middle of the viewport of context `ctx`.
const click = (env, ctx) =>
  env.ff.send("input.performActions", {
    context: ctx,
    actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: 20, y: 20 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
  });

export default [
  {
    name: "tab facts: activated_by after tabs.open and tabs.switch, and after the user's own activation; user_origin follows the user",
    async fn(env) {
      const user = await home(env);
      const origin = `http://127.0.0.1:${env.site.port}`;
      const other = `http://localhost:${env.site.port}`;
      const opened = await call(env, "tabs.open@1", { url: `${other}/help.html` });
      try {
        const o = opened.tab;
        assert.deepEqual([o.activated_by, o.user_origin, o.user_at], ["extension", null, null]);
        assert.ok(o.activated_at > 0);
        // The user comes back to the first tab (WebDriver activates it, as a click on it would).
        const t0 = Date.now();
        await env.ff.send("browsingContext.activate", { context: env.ff.context });
        const back = await waitFor(async () => {
          const t = await tabOf(env, user);
          return t.activated_by === "user" && t.activated_at >= t0 && t;
        }, { what: "the user's activation seen" });
        assert.equal(back.user_origin, origin);
        assert.ok(back.user_at >= back.activated_at);
        // Kai switches to the other tab: the extension's; the user clicks into it: theirs to act in.
        const s = await call(env, "tabs.switch@1", { tab: o.id });
        assert.equal(s.tab.activated_by, "extension");
        assert.equal(s.tab.user_origin, null);
        await click(env, await contextOf(env, `${other}/help.html`));
        const clicked = await waitFor(async () => {
          const t = await tabOf(env, o.id);
          return t.user_origin === other && t;
        }, { what: "the trusted click seen" });
        assert.equal(clicked.activated_by, "extension", "a click is no activation");
        assert.ok(clicked.user_at > clicked.activated_at);
        // An address the user types moves user_origin with the page.
        await env.ff.chromeEval(`(gURLBar.value = ${JSON.stringify(`${origin}/article.html`)}, gURLBar.handleCommand(), 1)`);
        await waitFor(async () => (await tabOf(env, o.id)).user_origin === origin, { what: "the typed address seen" });
        // Kai's navigation does not.
        await call(env, "tabs.go@1", { tab: o.id, url: `${other}/help.html` });
        assert.equal((await tabOf(env, o.id)).user_origin, origin);
        // Closing the tab Kai switched to: the tab Firefox shows in its place is the extension's doing.
        await call(env, "tabs.close@1", { tab: o.id });
        const after = await call(env, "tabs.list@1");
        const shown = after.tabs.find((t) => t.active && t.window === o.window);
        assert.equal(shown.activated_by, "extension");
      } finally {
        await call(env, "tabs.close@1", { tab: opened.tab.id }).catch(() => {});
        await call(env, "tabs.switch@1", { tab: user });
      }
    },
  },
  {
    name: "tab facts: two tabs.open at once are both the extension's activations",
    async fn(env) {
      const user = await home(env);
      const [a, b] = await Promise.all([call(env, "tabs.open@1", { url: env.site.url("help.html") }), call(env, "tabs.open@1", { url: env.site.url("article.html") })]);
      try {
        const list = await call(env, "tabs.list@1");
        for (const t of [a.tab, b.tab]) assert.equal(list.tabs.find((x) => x.id === t.id).activated_by, "extension", JSON.stringify(list.tabs.find((x) => x.id === t.id)));
      } finally {
        await call(env, "tabs.close@1", { tab: a.tab.id }).catch(() => {});
        await call(env, "tabs.close@1", { tab: b.tab.id }).catch(() => {});
        await call(env, "tabs.switch@1", { tab: user });
      }
    },
  },
  {
    name: "tab facts: windows say which has the focus and when each last had it; context.get names the user's window",
    async fn(env) {
      await home(env);
      const before = await call(env, "tabs.list@1");
      assert.equal(before.windows.filter((w) => w.focused).length, 1);
      const main = before.windows.find((w) => w.focused);
      assert.equal(main.type, "normal");
      const w = await env.ext(`browser.windows.create({ url: "about:blank" }).then((w) => w.id)`);
      try {
        const mid = await waitFor(async () => {
          const l = await call(env, "tabs.list@1");
          const x = l.windows.find((y) => y.id === w);
          return x?.focused && l;
        }, { what: "the new window focused" });
        const nw = mid.windows.find((x) => x.id === w);
        assert.ok(nw.focused_at > 0);
        assert.equal(mid.windows.find((x) => x.id === main.id).focused, false);
      } finally {
        await env.ext(`browser.windows.remove(${w}).then(() => 1)`);
      }
      const c = await waitFor(async () => {
        const x = await call(env, "context.get@1");
        return x.window.focused && x;
      }, { what: "the first window focused again" });
      assert.equal(c.window.id, main.id);
      assert.ok(c.window.focused_at >= (await call(env, "tabs.list@1")).windows.find((x) => x.id === main.id).focused_at - 1);
      assert.deepEqual(Object.keys(c.window).sort(), ["focused", "focused_at", "id"]);
    },
  },
  {
    name: "tabs.open sandbox: a tab in the Kai container, its cookies apart from the user's",
    async fn(env) {
      const user = await home(env);
      await inPage(env, `(document.cookie = "who=user; path=/", 1)`);
      const s = await call(env, "tabs.open@1", { url: env.site.url("help.html"), sandbox: true });
      try {
        assert.match(s.tab.container, /^firefox-container-\d+$/);
        assert.equal(s.tab.container_name, "Kai");
        const ctx = await contextOf(env, env.site.url("help.html"));
        assert.equal(await env.ff.evalIn(ctx, "document.cookie"), "", "the user's cookie is not there");
        await env.ff.evalIn(ctx, `(document.cookie = "who=kai; path=/", 1)`);
        assert.equal(await inPage(env, "document.cookie"), "who=user", "nor Kai's in the user's tab");
        const again = await call(env, "tabs.open@1", { url: env.site.url("article.html"), sandbox: true, wait: "commit" });
        assert.equal(again.tab.container, s.tab.container, "one Kai container");
        await call(env, "tabs.close@1", { tab: again.tab.id });
        const listed = (await call(env, "tabs.list@1")).tabs.find((t) => t.id === s.tab.id);
        assert.deepEqual([listed.container, listed.container_name], [s.tab.container, "Kai"]);
        assert.deepEqual([(await tabOf(env, user)).container, (await tabOf(env, user)).container_name], [null, null]);
        // Every page of the sandbox is Kai's visit, also one its own page goes to.
        const third = `http://127.0.0.3:${env.site.port}`;
        await call(env, "tabs.go@1", { tab: s.tab.id, url: `${third}/help.html` });
        await env.ff.evalIn(await contextOf(env, `${third}/help.html`), `(location.href = "/article.html?from=sandbox", 1)`);
        await waitFor(async () => (await tabOf(env, s.tab.id)).url === `${third}/article.html?from=sandbox`, { what: "the sandbox page's own navigation" });
        const h = await waitFor(async () => {
          const x = await call(env, "history.seen@1", { url: third });
          return x.seen && x;
        }, { what: "the sandbox's visits in the history" });
        assert.equal(h.seen_by_user, false);
      } finally {
        await call(env, "tabs.close@1", { tab: s.tab.id });
        await inPage(env, `(document.cookie = "who=; path=/; max-age=0", 1)`);
      }
    },
  },
  {
    name: "history.seen: an origin the history has, one it has not, one only named in another page's address",
    async fn(env) {
      const user = await home(env);
      // The fixture's search page names 192.0.2.44 in its own address.
      await call(env, "tabs.go@1", { tab: user, url: env.site.url("search?q=192.0.2.44") });
      await call(env, "tabs.go@1", { tab: user, url: env.site.url("shop.html") });
      const seen = await waitFor(async () => {
        const r = await call(env, "history.seen@1", { url: env.site.url("help.html?x=1") });
        return r.seen && r;
      }, { what: "the site in the history" });
      assert.deepEqual([seen.origin, seen.url], [`http://127.0.0.1:${env.site.port}`, env.site.url("help.html?x=1")]);
      assert.ok(seen.last_visit > 0 && seen.first_visit > 0 && seen.first_visit <= seen.last_visit, JSON.stringify(seen));
      await waitFor(async () => (await env.ext(`browser.history.search({ text: "192.0.2.44", startTime: 0 }).then((r) => r.length)`)) > 0, { what: "the search page in the history" });
      assert.deepEqual(await call(env, "history.seen@1", { url: "http://192.0.2.44/upload" }), { url: "http://192.0.2.44/upload", origin: "http://192.0.2.44", seen: false, seen_by_user: false, first_visit: null, last_visit: null });
      assert.equal((await call(env, "history.seen@1", { url: "https://shop.example/cart" })).seen, false);
      // A visit Kai caused is not the user's; an address the user types is.
      const third = `http://127.0.0.3:${env.site.port}`;
      await call(env, "tabs.go@1", { tab: user, url: `${third}/article.html` });
      const k = await waitFor(async () => {
        const r = await call(env, "history.seen@1", { url: third });
        return r.seen && r;
      }, { what: "Kai's visit in the history" });
      assert.deepEqual([k.seen_by_user, k.first_visit <= k.last_visit], [false, true]);
      await env.ff.chromeEval(`(gURLBar.value = ${JSON.stringify(`${third}/help.html`)}, gURLBar.handleCommand(), 1)`);
      await waitFor(async () => (await call(env, "history.seen@1", { url: third })).seen_by_user, { what: "the typed visit counted as the user's" });
      // Another port is another origin.
      assert.equal((await call(env, "history.seen@1", { url: "http://127.0.0.1:9/" })).seen, false);
      await fails(env, "history.seen@1", { url: "shop.example" }, "bad_url");
      await fails(env, "history.seen@1", { url: "about:blank" }, "bad_url");
    },
  },
];

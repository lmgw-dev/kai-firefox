// tabs.* (design §5.2): listing, opening by URL and by search, navigating, switching, closing,
// history (the back-forward cache included), reload, mute, what a load that fails or shows no page
// reports, and when a navigation counts as done.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { call, fails, waitFor, inPage, sleep } from "../lib/util.mjs";

// The user's tab (the first tab) back on the shop.
export async function home(env) {
  const list = await call(env, "tabs.list@1");
  const first = list.tabs.find((t) => t.index === 0 && t.window === list.tabs[0].window);
  await call(env, "tabs.switch@1", { tab: first.id });
  await call(env, "tabs.go@1", { tab: first.id, url: env.site.url("shop.html") });
  return first.id;
}

// A port nothing listens on.
const closedPort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

export default [
  {
    name: "tabs.list lists every tab, the user's marked",
    async fn(env) {
      const user = await home(env);
      const list = await call(env, "tabs.list@1");
      assert.equal(list.user_tab, user);
      const t = list.tabs.find((x) => x.id === user);
      assert.deepEqual(Object.keys(t).sort(), ["activated_at", "activated_by", "active", "audible", "container", "container_name", "discarded", "id", "index", "kai_input_at", "loading", "muted", "pinned", "title", "url", "user", "user_at", "user_origin", "window"]);
      assert.equal(t.title, "Northwind Gear: lamps and tents");
      assert.equal(t.url, env.site.url("shop.html"));
      assert.equal(t.active, true);
      assert.equal(t.user, true);
      assert.equal(t.container, null);
      assert.equal(list.tabs.filter((x) => x.user).length, 1);
      assert.ok(list.tabs.some((x) => x.url.startsWith("moz-extension:")), "the options page's tab is listed too");
    },
  },
  {
    name: "tabs.open opens a URL and waits for its load; active: false leaves the user's tab",
    async fn(env) {
      const user = await home(env);
      const a = await call(env, "tabs.open@1", { url: env.site.url("help.html") });
      assert.equal(a.loaded, true);
      assert.equal(a.tab.title, "Help: Northwind Gear");
      // Where it was meant to go, for the focus rule's owner's moves (design §6.4).
      assert.deepEqual(a.goes, { by: "url", origin: `http://127.0.0.1:${env.site.port}` });
      assert.equal(a.tab.active, true);
      assert.equal(a.tab.user, true);
      const b = await call(env, "tabs.open@1", { url: env.site.url("article.html"), active: false });
      assert.equal(b.tab.active, false);
      assert.equal(b.tab.user, false);
      assert.equal((await call(env, "tabs.list@1")).user_tab, a.tab.id);
      await call(env, "tabs.close@1", { tab: a.tab.id });
      await call(env, "tabs.close@1", { tab: b.tab.id });
      await call(env, "tabs.switch@1", { tab: user });
    },
  },
  {
    name: "tabs.open and tabs.go search with the default engine",
    async fn(env) {
      const user = await home(env);
      const r = await call(env, "tabs.open@1", { search: "ridge tent" });
      assert.equal(r.loaded, true, JSON.stringify(r));
      assert.equal(r.tab.url, env.site.url("search?q=ridge+tent"));
      assert.equal(r.tab.title, "Results for ridge tent");
      // A search goes where the engine's URL began.
      assert.deepEqual(r.goes, { by: "search", origin: new URL(env.site.url("search")).origin });
      const g = await call(env, "tabs.go@1", { tab: r.tab.id, search: "trail lamp" });
      assert.equal(g.tab.title, "Results for trail lamp");
      assert.deepEqual(g.goes, r.goes);
      await call(env, "tabs.close@1", { tab: r.tab.id });
      await call(env, "tabs.switch@1", { tab: user });
    },
  },
  {
    name: "tabs.open and tabs.go refuse what is no URL, what Firefox does not open, and wrong arguments",
    async fn(env) {
      const e = await fails(env, "tabs.open@1", { url: "shop.example" }, "bad_url");
      assert.equal(e.message, "'shop.example' is not an absolute URL (it needs a scheme such as https:); give it as search to search for it");
      const r = await fails(env, "tabs.open@1", { url: "about:config" }, "url_refused");
      assert.match(r.message, /^Firefox does not let an extension open about:config: /);
      await fails(env, "tabs.go@1", { url: "chrome://browser/content/browser.xhtml" }, "url_refused");
      assert.equal((await fails(env, "tabs.open@1", { url: "https://shop.example/", search: "x" }, "bad_args")).message, "tabs.open@1 needs exactly one of 'url' and 'search' (both were given)");
      assert.equal((await fails(env, "tabs.open@1", {}, "bad_args")).message, "tabs.open@1 needs exactly one of 'url' and 'search'");
      assert.equal((await fails(env, "tabs.open@1", { search: " " }, "bad_args")).message, "tabs.open@1's 'search' must be a non-empty string, not an empty string");
      assert.equal((await fails(env, "tabs.go@1", { tab: "1", url: "https://shop.example/" }, "bad_args")).message, "tabs.go@1's 'tab' must be a whole number, not a string");
      assert.equal((await fails(env, "tabs.open@1", { url: "https://shop.example/", wait: "soon" }, "bad_args")).message, 'tabs.open@1\'s \'wait\' must be one of "load", "commit", "none", not a string');
      // Names every object has are no arguments either.
      for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const e = await fails(env, "tabs.list@1", JSON.parse(`{${JSON.stringify(k)}: 1}`), "bad_args");
        assert.equal(e.message, `tabs.list@1 has no argument '${k}' (it takes none)`);
      }
      // Schemes no page loads for are refused before Firefox is asked.
      const mail = await fails(env, "tabs.go@1", { url: "mailto:help@shop.example" }, "url_refused");
      assert.equal(mail.message, "Kai for Firefox does not open mailto: URLs: no page loads for them in a tab (Firefox hands them to another application, or says it knows none)");
      assert.match((await fails(env, "tabs.open@1", { url: "tel:+15555550100" }, "url_refused")).message, /^Kai for Firefox does not open tel: URLs/);
    },
  },
  {
    name: "tabs.go and tabs.open load about:blank",
    async fn(env) {
      const user = await home(env);
      const g = await call(env, "tabs.go@1", { url: "about:blank" });
      assert.equal(g.loaded, true);
      assert.equal(g.tab.url, "about:blank");
      assert.equal(g.tab.loading, false);
      const o = await call(env, "tabs.open@1", { url: "about:blank", active: false });
      assert.equal(o.loaded, true);
      assert.equal(o.tab.url, "about:blank");
      await call(env, "tabs.close@1", { tab: o.tab.id });
      assert.equal(await home(env), user);
    },
  },
  {
    name: "tabs.go answers once the page has loaded, also when its script changes the URL and the fragment while it loads",
    async fn(env) {
      const user = await home(env);
      const { result } = env.conn().op("tabs.go@1", { url: env.site.url("spa") });
      let answered = false;
      result.then(() => (answered = true));
      await waitFor(async () => (await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).url.endsWith("?view=list#top"), { what: "the page changing its URL" });
      await sleep(300);
      assert.equal(answered, false, "no answer while the page loads");
      env.site.release();
      const r = await result;
      assert.equal(r.ok.loaded, true);
      assert.equal(r.ok.tab.loading, false);
      assert.equal(r.ok.tab.url, env.site.url("spa?view=list#top"));
    },
  },
  {
    name: "tabs.go: what the page was doing before (changing its URL, a load still running) does not answer for the navigation",
    async fn(env) {
      await home(env);
      await call(env, "tabs.go@1", { url: env.site.url("ticker.html") });
      const t = await call(env, "tabs.go@1", { url: env.site.url("help.html") });
      assert.equal(t.loaded, true);
      assert.equal(t.tab.title, "Help: Northwind Gear");
      await call(env, "tabs.go@1", { url: env.site.url("slow"), wait: "commit" });
      const a = await call(env, "tabs.go@1", { url: env.site.url("help.html") });
      assert.equal(a.loaded, true);
      assert.equal(a.tab.title, "Help: Northwind Gear");
      env.site.release();
      await call(env, "tabs.go@1", { url: env.site.url("hang"), wait: "none" });
      await waitFor(() => env.site.hungOpen() === 1, { what: "the request that gets no answer" });
      const b = await call(env, "tabs.go@1", { url: env.site.url("article.html") });
      assert.equal(b.loaded, true);
      assert.equal(b.tab.title, "Journal: a night on the ridge");
      env.site.release();
    },
  },
  {
    name: "tabs: a navigation that does not end within nav_load_ms fails with nav_timeout, saying how far it got",
    async fn(env) {
      const user = await home(env);
      await env.ext(`browser.storage.local.set({ nav_load_ms: 700 })`);
      try {
        await sleep(300);
        const hung = await fails(env, "tabs.go@1", { url: env.site.url("hang") }, "nav_timeout");
        assert.equal(hung.message, `the site has not answered in tab ${user} within 700 ms (Kai for Firefox's setting nav_load_ms); the tab goes on loading`);
        // The tab as it is: still showing the page before.
        assert.deepEqual([hung.tab, hung.url], [user, env.site.url("shop.html")]);
        env.site.release();
        const slow = await fails(env, "tabs.go@1", { url: env.site.url("slow") }, "nav_timeout");
        assert.equal(slow.message, `the page has not finished loading in tab ${user} within 700 ms (Kai for Firefox's setting nav_load_ms); the tab goes on loading`);
        assert.deepEqual([slow.tab, slow.title, slow.url], [user, "Slow", env.site.url("slow")]);
        // wait: commit is answered within the time.
        env.site.release();
        const c = await call(env, "tabs.go@1", { url: env.site.url("slow"), wait: "commit" });
        assert.equal(c.tab.loading, true);
      } finally {
        await env.ext(`browser.storage.local.remove("nav_load_ms")`);
        env.site.release();
      }
    },
  },
  {
    name: "tabs.go navigates the user's tab or a named one; wait commit and none return earlier",
    async fn(env) {
      const user = await home(env);
      const g = await call(env, "tabs.go@1", { url: env.site.url("help.html") });
      assert.equal(g.tab.id, user);
      assert.equal(g.loaded, true);
      assert.equal(g.tab.title, "Help: Northwind Gear");
      const none = await call(env, "tabs.go@1", { tab: user, url: env.site.url("article.html"), wait: "none" });
      assert.equal(none.loaded, false);
      await waitFor(async () => (await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).title === "Journal: a night on the ridge", { what: "the article loaded" });
      const committed = await call(env, "tabs.go@1", { tab: user, url: env.site.url("slow"), wait: "commit" });
      assert.equal(committed.loaded, false);
      assert.equal(committed.tab.url, env.site.url("slow"));
      assert.equal(committed.tab.loading, true);
      env.site.release();
      await fails(env, "tabs.go@1", { tab: 987654, url: env.site.url("help.html") }, "no_tab");
    },
  },
  {
    name: "tabs.switch and tabs.close",
    async fn(env) {
      const user = await home(env);
      const a = await call(env, "tabs.open@1", { url: env.site.url("help.html"), active: false });
      const s = await call(env, "tabs.switch@1", { tab: a.tab.id });
      assert.equal(s.tab.active, true);
      assert.equal(s.tab.user, true);
      assert.equal((await call(env, "tabs.list@1")).user_tab, a.tab.id);
      const c = await call(env, "tabs.close@1");
      assert.equal(c.closed.id, a.tab.id, "without a tab, the user's tab is closed");
      assert.equal(c.closed.title, "Help: Northwind Gear");
      assert.ok(!(await call(env, "tabs.list@1")).tabs.some((t) => t.id === a.tab.id));
      await fails(env, "tabs.close@1", { tab: a.tab.id }, "no_tab");
      assert.equal((await fails(env, "tabs.switch@1", {}, "bad_args")).message, "tabs.switch@1 needs 'tab'");
      await call(env, "tabs.switch@1", { tab: user });
    },
  },
  {
    name: "tabs.back and tabs.forward, and what they say at the ends of the history",
    async fn(env) {
      const user = await home(env);
      const t = (await call(env, "tabs.open@1", { url: env.site.url("shop.html") })).tab.id;
      const one = await fails(env, "tabs.back@1", { tab: t }, "no_history");
      assert.deepEqual(one, { code: "no_history", message: `tab ${t} has no earlier page`, tab: t, title: "Northwind Gear: lamps and tents", url: env.site.url("shop.html") });
      const went = await call(env, "tabs.go@1", { tab: t, url: env.site.url("help.html") });
      assert.deepEqual(went.goes, { by: "url", origin: new URL(env.site.url("help.html")).origin });
      const back = await call(env, "tabs.back@1", { tab: t });
      assert.equal(back.loaded, true);
      assert.equal(back.tab.url, env.site.url("shop.html"));
      // The history entry's origin.
      assert.deepEqual(back.goes, { by: "history", origin: new URL(env.site.url("shop.html")).origin });
      // Forward to an entry of the other origin: that origin.
      await call(env, "tabs.go@1", { tab: t, url: env.site.url("help.html", "localhost") });
      await call(env, "tabs.back@1", { tab: t });
      const fwd = await call(env, "tabs.forward@1", { tab: t });
      assert.equal(fwd.loaded, true);
      assert.equal(fwd.tab.url, env.site.url("help.html", "localhost"));
      assert.deepEqual(fwd.goes, { by: "history", origin: `http://localhost:${env.site.port}` });
      const end = await fails(env, "tabs.forward@1", { tab: t }, "no_navigation");
      const { nav_start_ms: ms = 1000 } = await env.ext(`browser.storage.local.get("nav_start_ms")`);
      assert.equal(end.message, `Firefox did not start going forward in tab ${t} within ${ms} ms (Kai for Firefox's setting nav_start_ms): the tab has no later page, or the page asks before it is left`);
      // A same-document entry goes back without a load.
      await call(env, "tabs.go@1", { tab: t, url: env.site.url("help.html#contact", "localhost") });
      const same = await call(env, "tabs.back@1", { tab: t });
      assert.equal(same.loaded, true);
      assert.equal(same.tab.url, env.site.url("help.html", "localhost"));
      assert.deepEqual(same.goes, { by: "history", origin: `http://localhost:${env.site.port}` });
      await call(env, "tabs.close@1", { tab: t });
      await call(env, "tabs.switch@1", { tab: user });
    },
  },
  {
    name: "tabs.back and tabs.forward answer for pages Firefox restores from its back-forward cache; their refs from before stay stale",
    async fn(env) {
      const user = await home(env);
      const a = env.site.url("cached-a.html");
      const b = env.site.url("cached-b.html");
      // Firefox 159 restores a page from its back-forward cache about four times in five here,
      // so each step is repeated until a page is restored (as in the hints test).
      let heading;
      let restored = 0;
      for (let i = 0; i < 8 && !restored; i++) {
        await call(env, "tabs.go@1", { url: a });
        heading = (await call(env, "context.get@1")).view.heading;
        assert.equal(heading.name, "Lamp care");
        await call(env, "tabs.go@1", { url: b });
        const back = await call(env, "tabs.back@1");
        assert.deepEqual([back.loaded, back.tab.url, back.tab.loading, back.tab.title], [true, a, false, "Lamp care: Northwind Gear"]);
        restored = await inPage(env, "window.restored");
      }
      assert.equal(restored, 1, "page A came back from the back-forward cache (8 tries)");
      const stale = await fails(env, "element.describe@1", { ref: heading.ref }, "stale_document");
      assert.equal(stale.message, `ref ${heading.ref} is from the page before the last navigation in tab ${user}`);
      const again = (await call(env, "context.get@1")).view.heading;
      assert.equal(again.name, "Lamp care");
      assert.ok(again.ref > heading.ref, `the restored page's heading got ref ${again.ref}, after ${heading.ref}`);
      restored = 0;
      for (let i = 0; i < 8 && !restored; i++) {
        if (i > 0) await call(env, "tabs.back@1");
        const fwd = await call(env, "tabs.forward@1");
        assert.deepEqual([fwd.loaded, fwd.tab.url, fwd.tab.loading], [true, b, false]);
        restored = await inPage(env, "window.restored");
      }
      assert.equal(restored, 1, "page B came back from the back-forward cache (8 tries)");
    },
  },
  {
    name: "tabs.reload and tabs.mute",
    async fn(env) {
      const user = await home(env);
      const before = env.site.log.length;
      const r = await call(env, "tabs.reload@1", { bypass_cache: true });
      assert.equal(r.loaded, true);
      assert.equal(r.tab.id, user);
      assert.ok(env.site.log.slice(before).some((l) => l.path === "/shop.html"), "the page was fetched again");
      const m = await call(env, "tabs.mute@1", { on: true });
      assert.equal(m.tab.muted, true);
      assert.equal((await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).muted, true);
      assert.equal((await call(env, "tabs.mute@1", { tab: user, on: false })).tab.muted, false);
      assert.equal((await fails(env, "tabs.mute@1", {}, "bad_args")).message, "tabs.mute@1 needs 'on'");
    },
  },
  {
    name: "tabs: a load that fails reports Firefox's error, or its error page; a download reports no page",
    async fn(env) {
      const user = await home(env);
      const port = await closedPort();
      const e = await call(env, "tabs.go@1", { url: `http://127.0.0.1:${port}/` });
      assert.equal(e.loaded, false);
      assert.equal(e.load_error, "NS_ERROR_CONNECTION_REFUSED");
      const ctx = await waitFor(
        async () => {
          const c = await call(env, "context.get@1");
          return c.page_error?.code === "error_page" && c;
        },
        { what: "context.get naming the error page" },
      );
      assert.equal(ctx.page_error.message, `tab ${user} shows one of Firefox's error pages`);
      assert.equal(ctx.tab.url, `http://127.0.0.1:${port}/`);
      // A port Firefox blocks: its error page commits, and no load error is reported for it.
      const blocked = await call(env, "tabs.go@1", { url: "http://127.0.0.1:9/" });
      assert.equal(blocked.loaded, false);
      assert.equal(blocked.load_error, "ERROR_PAGE");
      await home(env);
      const d = await call(env, "tabs.go@1", { url: env.site.url("download") });
      assert.equal(d.loaded, false);
      assert.equal(d.load_error, "NO_PAGE");
      assert.equal(d.tab.url, env.site.url("shop.html"), "the tab still shows the shop");
    },
  },
];

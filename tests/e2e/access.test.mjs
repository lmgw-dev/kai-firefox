// Where Kai cannot reach (design §3): private windows, which are never listed or touched, the
// pages Firefox keeps extensions out of, each named in an explicit error, and a tab between two
// pages.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib/env.mjs";
import { call, fails, waitFor } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

// context.get's page_error once Firefox shows the page (its icon comes a moment after the load).
const pageError = (env, code) =>
  waitFor(
    async () => {
      const c = await call(env, "context.get@1");
      return c.page_error?.code === code && c;
    },
    { what: `context.get's page_error ${code}` },
  );

export default [
  {
    name: "private windows: their tabs are never listed or touched, and the user's tab there is named",
    async fn(env) {
      const user = await home(env);
      const url = env.site.url("help.html?private");
      // A private window on top, from Firefox's own UI code; its tab's id as extensions number tabs.
      const privateTab = await env.ff.chromeEval(`(async () => {
        const w = OpenBrowserWindow({ private: true });
        await new Promise((r) => w.addEventListener("load", r, { once: true }));
        await new Promise((r) => setTimeout(r, 300));
        w.gBrowser.selectedBrowser.fixupAndLoadURIString(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        globalThis.kaiTestPrivate = w;
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        return ExtensionParent.apiManager.global.tabTracker.getId(w.gBrowser.selectedTab);
      })()`);
      try {
        await waitFor(() => env.site.log.some((l) => l.path === "/help.html?private"), { what: "the private tab loading" });
        const e = await fails(env, "context.get@1", {}, "private_window");
        assert.equal(e.message, "The user's tab is in a private window; Kai has no access to private windows");
        const list = await call(env, "tabs.list@1");
        assert.ok(!list.tabs.some((t) => t.id === privateTab || t.url === url), "the private tab is not listed");
        assert.equal(list.user_tab, null);
        for (const [op, args] of [
          ["tabs.close@1", { tab: privateTab }],
          ["tabs.go@1", { tab: privateTab, url: env.site.url("shop.html") }],
          ["tabs.switch@1", { tab: privateTab }],
          ["tabs.mute@1", { tab: privateTab, on: true }],
        ]) {
          const err = await fails(env, op, args, "no_tab");
          assert.equal(err.message, `Firefox has no tab ${privateTab} that Kai may use (closed, or in a private window)`);
        }
        // A tab opened meanwhile goes to the last normal window.
        const opened = await call(env, "tabs.open@1", { url: env.site.url("article.html"), active: false });
        const normal = list.tabs.find((t) => t.id === user).window;
        assert.equal(opened.tab.window, normal);
        await call(env, "tabs.close@1", { tab: opened.tab.id });
        assert.equal(await env.ff.chromeEval(`globalThis.kaiTestPrivate.gBrowser.selectedBrowser.currentURI.spec`), url, "the private tab was not touched");
      } finally {
        await env.ff.chromeEval(`(globalThis.kaiTestPrivate.close(), 1)`);
      }
      const c = await waitFor(() => call(env, "context.get@1").catch(() => null), { what: "context.get once the private window is closed" });
      assert.equal(c.tab.id, user);
    },
  },
  {
    name: "restricted pages: Firefox's own pages, local files, PDFs and restricted domains are named",
    async fn(env) {
      const user = await home(env);
      // Firefox refuses these URLs to extensions; BiDi opens them as the user would.
      const open = (url) => env.ff.send("browsingContext.navigate", { context: env.ff.context, url, wait: "complete" });
      await fails(env, "tabs.go@1", { url: "about:robots" }, "url_refused");
      await open("about:robots");
      let c = await pageError(env, "firefox_page");
      assert.equal(c.page_error.message, `Kai cannot read Firefox's own pages; tab ${user} shows one`);
      assert.equal(c.tab.url, "about:robots");
      assert.equal(c.focus, null);
      const again = await call(env, "tabs.reload@1");
      assert.equal(again.tab.url, "about:robots", "tab operations work on Firefox's own pages");
      const file = pathToFileURL(join(ROOT, "tests", "site", "help.html")).href;
      await open(file);
      c = await pageError(env, "file_access");
      assert.equal(c.page_error.message, `Kai for Firefox may not read local files; tab ${user} shows one. Allow "Access local files on your computer" in about:addons, Kai for Firefox, Permissions`);
      await call(env, "tabs.go@1", { url: env.site.url("prices.pdf") });
      c = await pageError(env, "pdf_viewer");
      assert.equal(c.page_error.message, `tab ${user} shows a PDF in Firefox's viewer, which extensions cannot read`);
      await call(env, "tabs.go@1", { url: env.site.url("help.html", "127.0.0.2") });
      c = await pageError(env, "restricted_domain");
      assert.equal(
        c.page_error.message,
        `Firefox keeps extensions out of the site tab ${user} shows: it is on Firefox's restricted domains (the pref extensions.webextensions.restrictedDomains) or quarantined domains`,
      );
      // Tab operations still work on such a tab.
      const r = await call(env, "tabs.reload@1");
      assert.equal(r.loaded, true);
      assert.equal(r.tab.title, "Help: Northwind Gear");
      await home(env);
    },
  },
  {
    name: "a new tab whose page has not arrived yet is loading, not one of Firefox's pages",
    async fn(env) {
      const user = await home(env);
      const t = (await call(env, "tabs.open@1", { url: env.site.url("hang"), wait: "none" })).tab.id;
      try {
        // Firefox asks the site before it calls the tab loading.
        await waitFor(async () => (await env.ext(`browser.tabs.get(${t})`)).status === "loading", { what: "the tab loading" });
        const c = await call(env, "context.get@1");
        assert.equal(c.tab.id, t);
        assert.equal(c.tab.loading, true);
        assert.deepEqual(c.page_error, { code: "loading", message: `tab ${t} is loading and shows no page yet; it can be read once the page has arrived` });
        await waitFor(() => env.site.hungOpen() === 1, { what: "the request that gets no answer" });
        env.site.release();
        const arrived = await waitFor(
          async () => {
            const a = await call(env, "context.get@1");
            return !a.page_error && a;
          },
          { what: "the page arriving and being read" },
        );
        assert.equal(arrived.tab.title, "Arrived");
      } finally {
        env.site.release();
        await call(env, "tabs.close@1", { tab: t });
        await call(env, "tabs.switch@1", { tab: user });
      }
    },
  },
  {
    name: "right after tabs.open with wait none the new tab is loading, never Firefox's blank page: its navigation is pending",
    async fn(env) {
      const user = await home(env);
      const c = env.conn();
      // Right after tabs.create Firefox reports the new tab as a finished about:blank for a
      // moment; asked at once, again and again (without the pending navigation most of these
      // said firefox_page).
      for (let i = 0; i < 10; i++) {
        const t = (await call(env, "tabs.open@1", { url: env.site.url("hang"), wait: "none" })).tab.id;
        try {
          const g = (await c.op("context.get@1").result).ok;
          assert.equal(g.tab.id, t);
          assert.equal(g.page_error?.code, "loading", JSON.stringify(g.page_error));
          await fails(env, "page.text_all@1", {}, "loading");
        } finally {
          env.site.release();
          await call(env, "tabs.close@1", { tab: t });
        }
      }
      const t = (await call(env, "tabs.open@1", { url: env.site.url("hang"), wait: "none" })).tab.id;
      try {
        await waitFor(() => env.site.hungOpen() === 1, { what: "the request that gets no answer" });
        env.site.release();
        await waitFor(async () => !(await call(env, "context.get@1")).page_error, { what: "the page read" });
      } finally {
        env.site.release();
        await call(env, "tabs.close@1", { tab: t });
        await call(env, "tabs.switch@1", { tab: user });
      }
    },
  },
];

// Firefox's own features (design §5.5): zoom and Reader view on the page of the origin Kai
// approved only, bookmarks, history and downloads (a redirected one, one a page started, and a
// private one left out, also while the extension may run in private windows), each with data the
// test makes itself.
import assert from "node:assert/strict";
import { EXT_ID, openExtPage } from "../lib/env.mjs";
import { call, fails, waitFor, inPage, siteOrigin } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

// Lets the extension run in private windows, or not, and restarts it so Firefox applies that.
async function privateBrowsing(env, allowed) {
  await env.ff.chromeEval(`(async () => {
    const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    await ExtensionPermissions.${allowed ? "add" : "remove"}(${JSON.stringify(EXT_ID)}, { permissions: ["internal:privateBrowsingAllowed"], origins: [] });
    return 1;
  })()`);
  const linked = env.kai.linked();
  await env.ext(`(setTimeout(() => browser.runtime.reload(), 0), 1)`);
  await linked;
  env.page = await openExtPage(env.ff, "options/options.html", { select: false });
  assert.equal(await env.ext("browser.extension.isAllowedIncognitoAccess()"), allowed);
}

const go = (env, path) => call(env, "tabs.go@1", { url: env.site.url(path) });

export default [
  {
    name: "page.zoom: sets a tab's zoom on the page of the origin Kai approved, says what it was and its scope, and refuses what Firefox refuses",
    async fn(env) {
      const user = await home(env);
      const origin = siteOrigin(env);
      try {
        const same = await call(env, "page.zoom@1", { percent: 100, origin });
        assert.deepEqual(same, { tab: { id: user, title: "Northwind Gear: lamps and tents", url: env.site.url("shop.html") }, percent: 100, was: 100, default_percent: 100, scope: "per-origin" });
        const z = await call(env, "page.zoom@1", { percent: 150, origin, tab: user });
        assert.deepEqual([z.percent, z.was], [150, 100]);
        assert.equal((await call(env, "context.get@1")).tab.zoom_percent, 150, "context.get reads it");
        const e = await fails(env, "page.zoom@1", { percent: 9000, origin }, "bad_value");
        assert.match(e.message, /^Firefox does not zoom tab \d+ to 9000 %: Zoom value 90 out of range \(must be between [\d.]+ and \d+\)$/);
        assert.equal(e.tab, user);
        assert.equal((await call(env, "context.get@1")).tab.zoom_percent, 150, "a refused zoom changes nothing");
        // Another origin than the page's: nothing changes.
        const other = await fails(env, "page.zoom@1", { percent: 120, origin: siteOrigin(env, "localhost") }, "page_changed");
        assert.equal(other.message, `tab ${user} shows a page of another origin than the one Kai approved, so its zoom was not changed`);
        assert.deepEqual([other.tab, other.url], [user, env.site.url("shop.html")]);
        assert.equal((await call(env, "context.get@1")).tab.zoom_percent, 150);
        assert.match((await fails(env, "page.zoom@1", { origin }, "bad_args")).message, /needs 'percent'/);
        assert.match((await fails(env, "page.zoom@1", { percent: 100 }, "bad_args")).message, /needs 'origin'/);
        await fails(env, "page.zoom@1", { percent: 0, origin }, "bad_args");
        await fails(env, "page.zoom@1", { percent: 1.5, origin }, "bad_args");
      } finally {
        await call(env, "page.zoom@1", { percent: 100, origin, tab: user });
      }
      // A page without an origin Kai can approve.
      const blank = await env.ext(`browser.tabs.create({ url: "about:blank", active: false }).then((t) => t.id)`);
      try {
        const e = await fails(env, "page.zoom@1", { percent: 120, origin: "null", tab: blank }, "page_changed");
        assert.equal(e.message, `tab ${blank} shows a page of no origin Kai can approve (an opaque one), so its zoom was not changed`);
      } finally {
        await env.ext(`browser.tabs.remove(${blank})`);
      }
    },
  },
  {
    name: "reader.view: on for an article and off again on the page of the origin Kai approved, unchanged when already so, no_article for a page that is none",
    async fn(env) {
      const user = await home(env);
      const origin = siteOrigin(env);
      await go(env, "article.html");
      await waitFor(async () => (await call(env, "context.get@1")).tab.reader.available, { what: "Firefox finding the article" });
      const wrong = await fails(env, "reader.view@1", { on: true, origin: siteOrigin(env, "localhost") }, "page_changed");
      assert.equal(wrong.message, `tab ${user} shows a page of another origin than the one Kai approved, so Reader view was not turned on`);
      assert.equal((await call(env, "context.get@1")).tab.reader.on, false, "nothing changed");
      const on = await call(env, "reader.view@1", { on: true, origin });
      assert.equal(on.on, true);
      assert.equal(on.changed, true);
      assert.equal(on.loaded, true);
      assert.ok(on.tab.url.startsWith("about:reader?url="), on.tab.url);
      assert.equal(on.tab.id, user);
      assert.equal((await fails(env, "page.text_all@1", {}, "reader_view")).page, env.site.url("article.html"));
      // Reader view's page is the article's site: Kai approves that origin for it.
      const again = await call(env, "reader.view@1", { on: true, origin, tab: user });
      assert.deepEqual([again.on, again.changed], [true, false]);
      try {
        assert.equal((await call(env, "page.zoom@1", { percent: 110, origin })).percent, 110);
      } finally {
        await call(env, "page.zoom@1", { percent: 100, origin });
      }
      await fails(env, "reader.view@1", { on: false, origin: siteOrigin(env, "localhost") }, "page_changed");
      const off = await call(env, "reader.view@1", { on: false, origin });
      assert.deepEqual([off.on, off.changed, off.loaded, off.tab.url], [false, true, true, env.site.url("article.html")]);
      assert.equal((await call(env, "page.outline@1")).items.find((i) => i.role === "heading").name, "A night on the ridge");
      await home(env);
      const e = await fails(env, "reader.view@1", { on: true, origin }, "no_article");
      assert.equal(e.message, `Firefox finds no article in tab ${user}, so Reader view cannot show it`);
      assert.deepEqual([e.tab, e.url], [user, env.site.url("shop.html")]);
      const still = await call(env, "reader.view@1", { on: false, origin });
      assert.deepEqual([still.on, still.changed], [false, false]);
      await fails(env, "reader.view@1", { origin }, "bad_args");
      assert.match((await fails(env, "reader.view@1", { on: true }, "bad_args")).message, /needs 'origin'/);
    },
  },
  {
    name: "bookmarks.find: title, URL, when added and the folders, newest first; nothing found is an empty list",
    async fn(env) {
      const lamp = env.site.url("cached-a.html");
      const tent = env.site.url("cached-b.html");
      const folder = await env.ext(`browser.bookmarks.create({ parentId: "toolbar_____", title: "Gear" }).then((f) => f.id)`);
      try {
        const t0 = Date.now();
        await env.ext(`browser.bookmarks.create({ parentId: ${JSON.stringify(folder)}, title: "Lamp care notes", url: ${JSON.stringify(lamp)} })`);
        await env.ext(`browser.bookmarks.create({ parentId: ${JSON.stringify(folder)}, title: "Tent care notes", url: ${JSON.stringify(tent)} })`);
        const f = await call(env, "bookmarks.find@1", { query: "care notes" });
        assert.equal(f.query, "care notes");
        assert.deepEqual(
          f.bookmarks.map((b) => [b.title, b.url, b.folder]),
          [
            ["Tent care notes", tent, ["Bookmarks Toolbar", "Gear"]],
            ["Lamp care notes", lamp, ["Bookmarks Toolbar", "Gear"]],
          ],
        );
        for (const b of f.bookmarks) assert.ok(b.added >= t0 - 1000 && b.added <= Date.now() + 1000, `added ${b.added}`);
        assert.deepEqual((await call(env, "bookmarks.find@1", { query: "lamp" })).bookmarks.map((b) => b.title), ["Lamp care notes"]);
        assert.deepEqual((await call(env, "bookmarks.find@1", { query: "nothing-like-this-anywhere" })).bookmarks, []);
        await fails(env, "bookmarks.find@1", { query: " " }, "bad_args");
      } finally {
        await env.ext(`browser.bookmarks.removeTree(${JSON.stringify(folder)})`);
      }
    },
  },
  {
    name: "history.find: the pages visited whose title or URL has the words, with the last visit and the count",
    async fn(env) {
      await home(env);
      const t0 = Date.now();
      await go(env, "help.html");
      await go(env, "shop.html");
      await go(env, "help.html");
      const h = await waitFor(
        async () => {
          const r = await call(env, "history.find@1", { query: "Help: Northwind" });
          const p = r.pages.find((x) => x.url === env.site.url("help.html"));
          return p && p.last_visit >= t0 ? { r, p } : null;
        },
        { what: "the visit in the history" },
      );
      assert.equal(h.r.query, "Help: Northwind");
      assert.equal(h.p.title, "Help: Northwind Gear");
      assert.ok(h.p.visits >= 2, `visits ${h.p.visits}`);
      const all = (await call(env, "history.find@1", { query: String(env.site.port) })).pages;
      assert.ok(all.length >= 2, `${all.length} pages`);
      for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].last_visit >= all[i].last_visit, "newest first");
      assert.deepEqual((await call(env, "history.find@1", { query: "nothing-like-this-anywhere" })).pages, []);
      await fails(env, "history.find@1", {}, "bad_args");
      await home(env);
    },
  },
  {
    name: "downloads.list: a file the page downloaded, with where it came from, its path, size, state and times",
    async fn(env) {
      await home(env);
      // Asked for at one address, answered at another: Firefox 159 gives a navigation's download
      // the address after the redirect.
      const url = env.site.url("download");
      const t0 = Date.now();
      const r = await call(env, "tabs.go@1", { url: env.site.url("r307?to=/download") });
      assert.equal(r.load_error, "NO_PAGE");
      const done = (u) =>
        waitFor(
          async () => {
            const list = (await call(env, "downloads.list@1")).downloads;
            return list.find((x) => x.url === u && x.started >= t0 - 1000 && x.state === "complete");
          },
          { what: `the download of ${u} completing` },
        );
      const d = await done(url);
      assert.deepEqual([d.url, d.final_url, d.referrer], [url, env.site.url("download"), null]);
      assert.equal(d.file.replace(/\(\d+\)/, ""), "price-list.txt");
      assert.ok(d.path.startsWith(env.ff.paths.home + "/"), `${d.path} is in the test's home`);
      assert.ok(d.path.endsWith(d.file));
      assert.deepEqual([d.size, d.received, d.exists], [14, 14, true]);
      assert.ok(d.started >= t0 - 1000 && d.started <= Date.now(), `started ${d.started}`);
      assert.ok(!("error" in d) && !("danger" in d), JSON.stringify(d));
      // One the page started: its referrer is the page.
      await inPage(env, `(location.href = "/download?from-page", 1)`);
      const p = await done(env.site.url("download?from-page"));
      assert.deepEqual([p.final_url, p.referrer], [env.site.url("download?from-page"), env.site.url("shop.html")]);
      const list = (await call(env, "downloads.list@1")).downloads;
      for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].started >= list[i].started, "newest first");
      await fails(env, "downloads.list@1", { query: "x" }, "bad_args");
      await home(env);
    },
  },
  {
    name: "downloads.list leaves out private downloads, also while the extension may run in private windows and Firefox lists them to it",
    async fn(env) {
      await home(env);
      const url = env.site.url("download?private");
      await privateBrowsing(env, true);
      try {
        const made = await env.ff.chromeEval(`(async () => {
          const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
          const target = PathUtils.join(Services.dirsvc.get("TmpD", Ci.nsIFile).path, "private-price-list.txt");
          const d = await Downloads.createDownload({ source: { url: ${JSON.stringify(url)}, isPrivate: true }, target });
          await (await Downloads.getList(Downloads.PRIVATE)).add(d);
          await d.start();
          return d.succeeded;
        })()`);
        assert.equal(made, true);
        const seen = await waitFor(() => env.ext(`browser.downloads.search({}).then((l) => l.find((d) => d.url === ${JSON.stringify(url)}))`), { what: "Firefox listing the private download to the extension" });
        assert.equal(seen.incognito, true);
        const list = (await call(env, "downloads.list@1")).downloads;
        assert.ok(!list.some((d) => d.url === url || d.final_url === url), "the private download is left out");
      } finally {
        await env.ff.chromeEval(`(async () => {
          const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
          const list = await Downloads.getList(Downloads.PRIVATE);
          for (const d of await list.getAll()) await list.remove(d);
          return 1;
        })()`);
        await privateBrowsing(env, false);
      }
    },
  },
];

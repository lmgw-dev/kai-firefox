// Styles (design §5.7): a sheet at the user origin with every declaration !important beats the
// page's own !important; what the parser dropped is listed; removal by id, a text two ids share,
// a page left, and a page Back restores from the back-forward cache, which comes without Kai's
// sheets. The sheet keeps off Kai's own labels, and what it fetches is listed, another origin's
// only with Kai's approval: an escaped url( ) and a custom property's URL that the page's own rule
// uses too, while a var( ) where a file is named is refused.
import assert from "node:assert/strict";
import { call, fails, inPage, waitFor, siteOrigin } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

const go = (env, path) => call(env, "tabs.go@1", { url: env.site.url(path) });
const color = (env, sel) => inPage(env, `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).color`);
const bg = (env) => inPage(env, `getComputedStyle(document.body).backgroundColor`);
// page.css for the fixture site's page, its origin approved.
const css = (env, text, more = {}) => call(env, "page.css@1", { css: text, origin: siteOrigin(env), ...more });
const overlay = (env, tab) => env.ext(`browser.tabs.sendMessage(${tab}, { kai: "overlay_state" }, { frameId: 0 })`);

export default [
  {
    name: "page.css: every declaration !important beats the page's !important, the dropped ones listed; removed by id",
    async fn(env) {
      const user = await home(env);
      await inPage(env, `(() => { const s = document.createElement("style"); s.textContent = "h1 { color: rgb(9, 9, 9) !important } h2 { color: rgb(8, 8, 8) }"; document.head.append(s); return 1; })()`);
      const css = `h1 { color: rgb(1, 2, 3); colr: red }
p::bogus { color: red }
@import url(more.css);
@media screen { h2 { colr2: blue; color: rgb(4, 5, 6) } }
footer { margin: var(--gap, 2px); & p { color: rgb(7, 7, 7) } }`;
      const r = await call(env, "page.css@1", { css, origin: siteOrigin(env) });
      assert.ok(Number.isSafeInteger(r.id) && r.id >= 1);
      assert.deepEqual(r.tab, { id: user, title: "Northwind Gear: lamps and tents", url: env.site.url("shop.html") });
      assert.equal(r.important, true);
      assert.equal(r.rules, 4);
      assert.deepEqual(r.dropped, ["colr: red", "p::bogus { … }", "@import url(more.css)", "colr2: blue"]);
      assert.deepEqual(r.fetches, []);
      assert.equal(await color(env, "h1"), "rgb(1, 2, 3)", "the user's !important beats the page's");
      assert.equal(await color(env, "h2"), "rgb(4, 5, 6)");
      assert.equal(await color(env, "footer p"), "rgb(7, 7, 7)");
      assert.equal(await inPage(env, `getComputedStyle(document.querySelector("footer")).marginTop`), "2px", "a shorthand with var() keeps its value");
      const gone = await call(env, "page.css_remove@1", { id: r.id });
      assert.deepEqual(gone, { id: r.id, tab: r.tab, removed: true });
      assert.equal(await color(env, "h1"), "rgb(9, 9, 9)");
      assert.equal(await color(env, "h2"), "rgb(8, 8, 8)");
      const e = await fails(env, "page.css_remove@1", { id: r.id }, "unknown_css");
      assert.match(e.message, new RegExp(`^Kai for Firefox has no style sheet ${r.id}: it was never added, was removed already`));
      const bad = await fails(env, "page.css@1", { css: "colr: red; also nothing", origin: siteOrigin(env) }, "bad_css");
      assert.deepEqual(bad.dropped, ["colr: red", "also nothing"]);
      assert.equal(bad.tab, user);
      await fails(env, "page.css@1", { css: "", origin: siteOrigin(env) }, "bad_args");
      assert.match((await fails(env, "page.css@1", { css: "p { color: red }" }, "bad_args")).message, /needs 'origin'/);
      await fails(env, "page.css_remove@1", { id: 0 }, "bad_args");
    },
  },
  {
    name: "page.css: two ids with the same text keep it until both are removed; a page left ends its sheets",
    async fn(env) {
      await home(env);
      const text = "body { background-color: rgb(10, 20, 30) }";
      const a = await css(env, text);
      const b = await css(env, text);
      assert.ok(b.id > a.id);
      assert.equal(await bg(env), "rgb(10, 20, 30)");
      assert.equal((await call(env, "page.css_remove@1", { id: a.id })).removed, true);
      assert.equal(await bg(env), "rgb(10, 20, 30)", "the other id keeps the text");
      assert.equal((await call(env, "page.css_remove@1", { id: b.id })).removed, true);
      assert.equal(await bg(env), "rgba(0, 0, 0, 0)");
      const c = await css(env, text);
      await go(env, "help.html");
      assert.equal(await bg(env), "rgba(0, 0, 0, 0)", "the new page has none");
      const left = await call(env, "page.css_remove@1", { id: c.id });
      assert.deepEqual([left.removed, left.why, left.tab.url], [false, "page_left", env.site.url("help.html")]);
    },
  },
  {
    name: "page.css: a page Back restores from the back-forward cache comes back without Kai's sheets, and their ids say page_left",
    async fn(env) {
      await home(env);
      // Firefox 159 restores a page from its back-forward cache about four times in five here,
      // so the step is repeated until the page is restored (as in the tabs and hints tests).
      let s;
      let restored = 0;
      for (let i = 0; i < 8 && !restored; i++) {
        await go(env, "cached-a.html");
        s = await css(env, "body { background-color: rgb(40, 50, 60) }");
        assert.equal(await bg(env), "rgb(40, 50, 60)");
        await go(env, "cached-b.html");
        await call(env, "tabs.back@1");
        restored = await inPage(env, "window.restored");
        // The restored page's sheets are taken out after its commit, without a sign to wait for.
        await waitFor(async () => (await bg(env)) === "rgba(0, 0, 0, 0)", { what: restored ? "the restored page without Kai's sheet" : "the page loaded again, without a sheet" });
        const r = await call(env, "page.css_remove@1", { id: s.id });
        assert.deepEqual([r.removed, r.why], [false, "page_left"]);
      }
      assert.equal(restored, 1, "the page came back from the back-forward cache (8 tries)");
      // A new sheet on the restored page works as on any page.
      const t = await css(env, "body { background-color: rgb(70, 80, 90) }");
      assert.equal(await bg(env), "rgb(70, 80, 90)");
      assert.equal((await call(env, "page.css_remove@1", { id: t.id })).removed, true);
      assert.equal(await bg(env), "rgba(0, 0, 0, 0)");
    },
  },
  {
    name: "page.css keeps off Kai's labels: `* { display: none }` and a transform aimed at their host leave them as they are, while rules for the root element apply",
    async fn(env) {
      const user = await home(env);
      await call(env, "hints.show@1");
      try {
        const { marker } = await env.ext(`browser.tabs.sendMessage(${user}, { kai: "whoami" }, { frameId: 0 })`);
        assert.match(marker, /^data-kai-[0-9a-f]{16}$/);
        const host = `document.querySelector("[${marker}]")`;
        const labels = (o) => o.hints.map((l) => [l.ref, l.x, l.y, l.shown]);
        const before = await overlay(env, user);
        assert.ok(before.hints.some((l) => l.shown), JSON.stringify(before));
        const hidden = await css(env, "* { display: none }");
        assert.equal(await inPage(env, "getComputedStyle(document.body).display"), "none", "the page's elements take the rule");
        assert.equal((await overlay(env, user)).host.display, "block", "the labels' host does not");
        await call(env, "page.css_remove@1", { id: hidden.id });
        const moved = await css(env, `[popover], html > div:last-child, [${marker}], div:where([${marker}]) { transform: translate(300px, 200px); display: none; opacity: 0 } :root { background-color: rgb(1, 2, 3) }`);
        assert.equal(await inPage(env, `getComputedStyle(${host}).transform`), "none");
        const after = await overlay(env, user);
        assert.deepEqual([after.host.display, after.host.opacity], ["block", "1"]);
        assert.deepEqual(labels(after), labels(before), "the labels stay where they were");
        assert.equal(await inPage(env, "getComputedStyle(document.documentElement).backgroundColor"), "rgb(1, 2, 3)", "a rule for the root element applies");
        await call(env, "page.css_remove@1", { id: moved.id });
      } finally {
        await call(env, "hints.hide@1");
      }
    },
  },
  {
    name: "page.css adds a sheet whose url()s fetch only from origins in fetch_origins, else fetch_not_approved and nothing is added; page.css_check lists them first",
    async fn(env) {
      const user = await home(env);
      const other = env.site.url("css-other.png", "localhost");
      const own = env.site.url("css-own.png");
      const text = `body { background-image: url("${other}") } h1 { background-image: url(${own}) } p { background-image: url(css-relative.png), url("data:image/png;base64,AA") }`;
      const fetches = [
        { origin: siteOrigin(env, "localhost"), url: other },
        { origin: siteOrigin(env), url: own },
      ];
      // Parsed only, for Kai's confirmation.
      assert.deepEqual(await call(env, "page.css_check@1", { css: text }), { rules: 3, dropped: [], fetches });
      const bad = await fails(env, "page.css_check@1", { css: "colr: red" }, "bad_css");
      assert.deepEqual([bad.dropped, "tab" in bad], [["colr: red"], false]);
      assert.equal(env.site.log.some((l) => l.path.startsWith("/css-")), false, "checking fetches nothing");
      const e = await fails(env, "page.css@1", { css: text, origin: siteOrigin(env) }, "fetch_not_approved");
      assert.deepEqual(e.fetches, fetches);
      assert.equal(e.message, `the style sheet for tab ${user} loads files from origins not in fetch_origins, so it was not added`);
      assert.equal(e.tab, user);
      // The page's own origin is approved like any other: only what Kai names.
      const half = await fails(env, "page.css@1", { css: text, origin: siteOrigin(env), fetch_origins: [siteOrigin(env, "localhost")] }, "fetch_not_approved");
      assert.deepEqual(half.fetches, [fetches[1]]);
      assert.equal(await inPage(env, "getComputedStyle(document.body).backgroundImage"), "none", "nothing was added");
      assert.ok(!env.site.log.some((l) => l.path === "/css-other.png"), "nothing was fetched");
      const r = await css(env, text, { fetch_origins: [siteOrigin(env, "localhost"), siteOrigin(env)] });
      assert.deepEqual(r.fetches, fetches);
      await waitFor(() => env.site.log.some((l) => l.host.startsWith("localhost:") && l.path === "/css-other.png"), { what: "the approved file fetched" });
      await waitFor(() => env.site.log.some((l) => l.path === "/css-own.png"), { what: "the page's own file fetched" });
      assert.ok(!env.site.log.some((l) => l.path.endsWith("css-relative.png")), "a relative URL reaches no site");
      await call(env, "page.css_remove@1", { id: r.id });
      // A sheet without absolute URLs needs no approval.
      assert.deepEqual((await css(env, "p { background-image: url(css-relative.png) }")).fetches, []);
      await fails(env, "page.css@1", { css: text, origin: siteOrigin(env), fetch_origins: "http://localhost" }, "bad_args");
    },
  },
  {
    name: "page.css_check and page.css count an escaped url( ) and a custom property's URL as fetches, refuse var( ) where a file is named (css_var_url), and leave relative URLs alone",
    async fn(env) {
      const user = await home(env);
      const other = siteOrigin(env, "localhost");
      const esc = env.site.url("css-esc.png", "localhost");
      const prop = env.site.url("css-prop.png", "localhost");
      // u\72l( is url( with an escape; Firefox keeps a value with var() as written.
      const escaped = String.raw`body { background: u\72l(${esc}) var(--none, rgb(1, 1, 1)) }`;
      assert.deepEqual((await call(env, "page.css_check@1", { css: escaped })).fetches, [{ origin: other, url: esc }]);
      assert.deepEqual((await fails(env, "page.css@1", { css: escaped, origin: siteOrigin(env) }, "fetch_not_approved")).fetches, [{ origin: other, url: esc }]);
      // A string in a custom property is fetched where a rule of the page itself uses it.
      await inPage(env, `(() => { const s = document.createElement("style"); s.textContent = "h1 { background-image: image-set(var(--kai-u) 1x) }"; document.head.append(s); return 1; })()`);
      const custom = `:root { --kai-u: "${prop}" }`;
      assert.deepEqual((await call(env, "page.css_check@1", { css: custom })).fetches, [{ origin: other, url: prop }]);
      await fails(env, "page.css@1", { css: custom, origin: siteOrigin(env) }, "fetch_not_approved");
      assert.equal(await inPage(env, `getComputedStyle(document.querySelector("h1")).backgroundImage`), "none", "nothing was added");
      const added = await css(env, `${escaped} ${custom}`, { fetch_origins: [other] });
      assert.deepEqual(added.fetches, [{ origin: other, url: esc }, { origin: other, url: prop }]);
      await waitFor(() => env.site.log.some((l) => l.path === "/css-esc.png"), { what: "the escaped url( ) fetched" });
      await waitFor(() => env.site.log.some((l) => l.path === "/css-prop.png"), { what: "the custom property's URL fetched through the page's rule" });
      await call(env, "page.css_remove@1", { id: added.id });
      // var( ) where a file is named: what it loads is known only when the page is styled.
      const viaVar = `:root { --u: "${prop}" } p { background-image: image-set(var(--u) 1x), url(css-a.png) } p::after { content: url(v\\61r(--w)); cursor: -webkit-image-set(v\\61r(--w) 1x), auto }`;
      const checked = await fails(env, "page.css_check@1", { css: viaVar }, "css_var_url");
      assert.deepEqual(checked.uses, ["image-set(var(--u) 1x)", "-webkit-image-set(v\\61r(--w) 1x)"]);
      assert.equal("tab" in checked, false);
      assert.match(checked.message, /^the style sheet uses var\( \) inside url\( \), image-set\( \) or another function that loads a file \(listed in uses\)/);
      const refused = await fails(env, "page.css@1", { css: viaVar, origin: siteOrigin(env), fetch_origins: [other] }, "css_var_url");
      assert.deepEqual([refused.tab, refused.uses], [user, checked.uses]);
      assert.equal(await inPage(env, `getComputedStyle(document.querySelector("p")).backgroundImage`), "none", "nothing was added");
      // Relative URLs reach no site from Kai's sheet, also in a string where a file is named.
      const rel = await css(env, `p { background-image: image-set("css-rel-string.png" 1x) } h2 { background-image: url(css-rel-url.png) }`);
      assert.deepEqual(rel.fetches, []);
      await call(env, "page.css_remove@1", { id: rel.id });
      assert.ok(!env.site.log.some((l) => l.path.startsWith("/css-rel-")), "a relative URL reaches no site");
    },
  },
];

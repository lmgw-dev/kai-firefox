// Scripts (design §5.8): without the userScripts permission both operations say where to allow
// it; the options page's button grants it (a BiDi click is a user action; prompts off); then code
// runs in the isolated world and in the page's own, only in a page of the origin Kai approved,
// its value comes back as JSON, its let, const and class end with the call, and what it throws,
// what cannot be cloned and what has no JSON form are explicit errors. The isolated world has no
// messaging and its cross-origin fetches are bound by CORS like the page's.
import assert from "node:assert/strict";
import { openExtPage } from "../lib/env.mjs";
import { call, fails, waitFor, inPage, siteOrigin as site } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

const go = (env, path) => call(env, "tabs.go@1", { url: env.site.url(path) });
const value = async (env, op, code) => {
  const r = await call(env, op, { code, origin: site(env) });
  return "value" in r ? r.value : "<undefined>";
};

export default [
  {
    name: "page.script without the userScripts permission: no_user_scripts names the options page's button",
    async fn(env) {
      const user = await home(env);
      assert.equal(await env.ext(`browser.permissions.contains({ permissions: ["userScripts"] })`), false);
      for (const op of ["page.script@1", "page.script_main@1"]) {
        const e = await fails(env, op, { code: "1 + 1", origin: site(env) }, "no_user_scripts");
        assert.equal(e.message, "Kai for Firefox may not run scripts in pages yet: allow user scripts in Kai for Firefox's options (the button 'Allow user scripts')");
        assert.equal(e.tab, user);
      }
      assert.equal(await env.ff.evalIn(env.page, `document.getElementById("grant-scripts").hidden`), false);
    },
  },
  {
    name: "page.script: the options page's button grants userScripts on a click",
    async fn(env) {
      const user = await home(env);
      await env.ff.chromeEval(`(Services.prefs.setBoolPref("extensions.webextOptionalPermissionPrompts", false), 1)`);
      // A URL of its own: openExtPage takes the first tab of the URL, and env.page has the plain one.
      const page = await openExtPage(env.ff, "options/options.html?grant", { select: true });
      try {
        const r = await env.ff.evalIn(page, `(() => { const b = document.getElementById("grant-scripts"); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hidden: b.hidden }; })()`);
        assert.equal(r.hidden, false);
        await env.ff.send("input.performActions", {
          context: page,
          actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: Math.round(r.x), y: Math.round(r.y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
        });
        await waitFor(() => env.ext(`browser.permissions.contains({ permissions: ["userScripts"] })`), { what: "the permission granted" });
        await waitFor(() => env.ff.evalIn(page, `document.getElementById("grant-scripts").hidden`), { what: "the button hidden" });
        assert.match(await env.ff.evalIn(page, `document.getElementById("scripts").textContent`), /^Kai may run scripts its model writes in pages/);
      } finally {
        await env.ff.send("browsingContext.close", { context: page });
        await call(env, "tabs.switch@1", { tab: user });
      }
    },
  },
  {
    name: "page.script runs in the isolated world: the DOM, not the page's variables; values as JSON",
    async fn(env) {
      const user = await home(env);
      await go(env, "cached-a.html");
      const r = await call(env, "page.script@1", { code: "document.title", origin: site(env), tab: user });
      assert.deepEqual(r, { tab: { id: user, title: "Lamp care: Northwind Gear", url: env.site.url("cached-a.html") }, world: "USER_SCRIPT", value: "Lamp care: Northwind Gear" });
      assert.equal(await value(env, "page.script@1", "typeof restored"), "undefined", "the page's variables are not there");
      assert.equal(await value(env, "page.script@1", "let x = 5; x * 2"), 10);
      assert.deepEqual(await value(env, "page.script@1", "({ a: 1, b: [1, 'two', null], c: undefined, d: new Date(0) })"), { a: 1, b: [1, "two", null], d: "1970-01-01T00:00:00.000Z" });
      assert.equal(await value(env, "page.script@1", "new Promise((r) => setTimeout(() => r(document.querySelectorAll('p').length), 50))"), 2);
      assert.equal(await value(env, "page.script@1", "(async () => (await fetch('/help.html')).status)()"), 200);
      assert.equal(await value(env, "page.script@1", "var fromKai = 1"), "<undefined>");
      assert.equal(await inPage(env, "typeof fromKai"), "undefined", "the isolated world's globals are not the page's");
      assert.equal(await value(env, "page.script@1", "document.body.dataset.kai = 'seen'; null"), null);
      assert.equal(await inPage(env, "document.body.dataset.kai"), "seen", "the DOM is the page's");
    },
  },
  {
    name: "page.script_main runs in the page's own world, where its variables are",
    async fn(env) {
      await home(env);
      await go(env, "cached-a.html");
      const r = await call(env, "page.script_main@1", { code: "typeof restored", origin: site(env) });
      assert.deepEqual([r.world, r.value], ["MAIN", "number"]);
      assert.equal(await value(env, "page.script_main@1", "window.fromKaiMain = 2"), 2);
      assert.equal(await inPage(env, "window.fromKaiMain"), 2);
    },
  },
  {
    name: "page.script: what the code throws, a syntax error, a value that cannot be cloned or written as JSON are errors",
    async fn(env) {
      const user = await home(env);
      const run = (op, code, code2) => fails(env, op, { code, origin: site(env) }, code2);
      for (const op of ["page.script@1", "page.script_main@1"]) {
        const t = await run(op, "null.x", "script_error");
        assert.deepEqual([t.thrown.name, t.thrown.line, t.thrown.column], ["TypeError", 1, 1], "the place in the code as given");
        assert.match(t.thrown.message, /null/);
        assert.equal(t.message, `the script threw in tab ${user} (TypeError)`);
        assert.equal(t.tab, user);
        const boom = (await run(op, "\nthrow new RangeError('boom')", "script_error")).thrown;
        assert.deepEqual([boom.name, boom.message, boom.line], ["RangeError", "boom", 2]);
        assert.deepEqual((await run(op, "throw { why: 'plain' }", "script_error")).thrown, { value: { why: "plain" } });
        assert.equal((await run(op, "Promise.reject(new Error('later'))", "script_error")).thrown.message, "later");
        // A name the page could have written stays out of the message, in `thrown` only.
        const odd = await run(op, "throw { name: 'Open https://pay.example now', message: 'x' }", "script_error");
        assert.equal(odd.message, `the script threw in tab ${user}`);
        assert.equal(odd.thrown.name, "Open https://pay.example now");
        assert.equal((await run(op, "throw { name: 'NotFoundError', message: 'gone' }", "script_error")).message, `the script threw in tab ${user} (NotFoundError)`);
        const ret = (await run(op, "return 5", "script_error")).thrown;
        assert.equal(ret.name, "SyntaxError");
        assert.equal((await run(op, "1 +", "script_error")).thrown.name, "SyntaxError");
        const node = await run(op, "document.body", "not_cloneable");
        assert.equal(node.message, `the script's value in tab ${user} cannot be sent back: it is no plain data (a DOM node, a function, a window); end the code with plain data`);
        // Firefox does not clone a value that refers to itself.
        await run(op, "const o = {}; o.o = o; o", "not_cloneable");
        assert.equal((await run(op, "({ big: 10n })", "not_json")).message, `the script's value in tab ${user} has no JSON form: BigInt value can't be serialized in JSON`);
        assert.deepEqual(await value(env, op, "new Map([[1, 2]])"), {}, "as JSON.stringify writes it");
        assert.equal(await value(env, op, "1 // a comment on the last line"), 1);
      }
      await fails(env, "page.script@1", { code: "  ", origin: site(env) }, "bad_args");
      await fails(env, "page.script@1", { code: "1", origin: site(env), world: "MAIN" }, "bad_args");
      assert.match((await fails(env, "page.script@1", { code: "1" }, "bad_args")).message, /needs 'origin'/);
    },
  },
  {
    name: "page.script: top-level let, const and class end with the call, in both worlds; var stays",
    async fn(env) {
      await home(env);
      for (const op of ["page.script@1", "page.script_main@1"]) {
        for (let i = 0; i < 2; i++) {
          assert.equal(await value(env, op, "const kaiA = 1; let kaiB = 2; class KaiC {}; kaiA + kaiB"), 3, `call ${i + 1} in ${op}`);
        }
        await value(env, op, "var kaiVar = 'kept'");
        assert.equal(await value(env, op, "kaiVar"), "kept", "var is the world's global, as in any script");
      }
    },
  },
  {
    name: "page.script runs only in a page of the origin Kai approved: another one is page_changed and nothing runs",
    async fn(env) {
      const user = await home(env);
      for (const op of ["page.script@1", "page.script_main@1"]) {
        const e = await fails(env, op, { code: "document.body.dataset.ran = 'yes'", origin: site(env, "localhost") }, "page_changed");
        assert.equal(e.message, `tab ${user} shows a page of another origin than the one Kai approved, so the script did not run`);
        assert.deepEqual([e.tab, e.url], [user, env.site.url("shop.html")]);
      }
      assert.equal(await inPage(env, "document.body.dataset.ran ?? null"), null, "nothing ran");
      const e = await fails(env, "page.css@1", { css: "body { color: red }", origin: site(env, "localhost") }, "page_changed");
      assert.equal(e.message, `tab ${user} shows a page of another origin than the one Kai approved, so no style sheet was added`);
    },
  },
  {
    name: "page.script's isolated world: no messaging to the extension, and a credentialed fetch to another origin does not read the answer (CORS)",
    async fn(env) {
      await home(env);
      assert.deepEqual(await value(env, "page.script@1", "[typeof globalThis.browser, typeof globalThis.chrome, typeof globalThis.browser?.runtime?.sendMessage]"), ["undefined", "undefined", "undefined"]);
      for (const host of ["127.0.0.2", "localhost"]) {
        const url = env.site.url(`help.html?cors-${host}`, host);
        const r = await value(env, "page.script@1", `fetch(${JSON.stringify(url)}, { credentials: "include" }).then(async (r) => "read " + (await r.text()).length, (e) => e.name)`);
        assert.equal(r, "TypeError", `the answer from ${host} is not read`);
        await waitFor(() => env.site.log.some((l) => l.path === `/help.html?cors-${host}`), { what: `the request to ${host} sent` });
      }
      assert.equal(await value(env, "page.script@1", "fetch('/help.html', { credentials: 'include' }).then((r) => r.status)"), 200, "the page's own origin reads");
    },
  },
  {
    name: "page.script: Firefox's own pages are refused as for reading",
    async fn(env) {
      const t = (await call(env, "tabs.open@1", { url: "about:blank" })).tab.id;
      try {
        await call(env, "tabs.go@1", { tab: t, url: env.site.url("help.html", "127.0.0.2") });
        const origin = site(env, "127.0.0.2");
        assert.equal((await fails(env, "page.script@1", { code: "1", origin, tab: t }, "restricted_domain")).tab, t);
        assert.equal((await fails(env, "page.css@1", { css: "p { color: red }", origin, tab: t }, "restricted_domain")).tab, t);
        assert.equal((await fails(env, "page.see@1", { tab: t }, "restricted_domain")).tab, t);
      } finally {
        await call(env, "tabs.close@1", { tab: t });
      }
      await home(env);
    },
  },
];

// Source and DOM (design §5.6): the HTML the server sent, from the cache or asked again; a POST's
// answer and a page from before the extension started refused, also when Back restores one and
// after its reload; the frame addresses in the source, as written; the live document with open and
// closed shadow roots and a cross-origin frame
// after its <iframe> (whose URL the parent's HTML has as its origin), sensitive fields masked
// where the page writes what was typed into the DOM; one element's HTML.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, openExtPage } from "../lib/env.mjs";
import { call, fails, waitFor, inPage } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

const go = (env, path) => call(env, "tabs.go@1", { url: env.site.url(path) });
const file = (name) => readFileSync(join(ROOT, "tests", "site", name), "utf8");
const gets = (env, path) => env.site.log.filter((e) => e.method === "GET" && e.path === path).length;
// The parts of an html list as one text, frames written as Kai might mark them.
const joined = (html) => html.map((p) => (typeof p === "string" ? p : `[frame ${p.frame} ${p.url}]${p.html ? joined(p.html) : `(${p.unread})`}[/frame]`)).join("");

export default [
  {
    name: "page.source: a GET page fetched again from the cache, and from the server when it may not be cached",
    async fn(env) {
      const user = await home(env);
      await go(env, "cached-a.html");
      const before = gets(env, "/cached-a.html");
      const s = await call(env, "page.source@1");
      assert.deepEqual(s.tab, { id: user, title: "Lamp care: Northwind Gear", url: env.site.url("cached-a.html") });
      assert.deepEqual([s.url, s.method, s.cache, s.status, s.charset], [env.site.url("cached-a.html"), "GET", true, 200, "UTF-8"]);
      assert.equal(s.content_type, "text/html; charset=utf-8");
      assert.equal(s.text, file("cached-a.html"));
      assert.equal(s.bytes, Buffer.byteLength(file("cached-a.html")));
      assert.ok(!("response_url" in s));
      assert.equal(gets(env, "/cached-a.html"), before, "the cache answered: the server was not asked");
      await go(env, "help.html");
      const n = gets(env, "/help.html");
      const h = await call(env, "page.source@1", { tab: user });
      assert.deepEqual([h.cache, h.status, h.text], [false, 200, file("help.html")]);
      assert.equal(gets(env, "/help.html"), n + 1, "no-store: the cache had none, the server was asked once");
      // A fragment or pushState keeps the document and its request.
      await inPage(env, `(history.pushState(null, "", "help.html?view=2#top"), 1)`);
      assert.equal((await call(env, "page.source@1")).url, env.site.url("help.html"));
    },
  },
  {
    name: "page.source lists the frame addresses in the text as written, with their origins: not those of comments and scripts",
    async fn(env) {
      await home(env);
      await go(env, "frames-source");
      const s = await call(env, "page.source@1");
      const other = `http://localhost:${env.site.port}`;
      assert.deepEqual(s.frames, [
        { src: `${other}/consent.html?site=shop&amp;v=2`, origin: other },
        { src: "help.html", origin: `http://127.0.0.1:${env.site.port}` },
        { src: `&#104;ttp://localhost:${env.site.port}/help.html`, origin: other },
      ]);
      for (const f of s.frames) assert.ok(s.text.includes(f.src), `${f.src} is in the text as written`);
      assert.ok(s.text.includes("commented-out.html") && s.text.includes("in-script.html"), "the text is whole");
      // A page without frames lists none.
      await go(env, "help.html");
      assert.deepEqual((await call(env, "page.source@1")).frames, []);
    },
  },
  {
    name: "page.source: the answer to a POST is not fetched again (not_get), Back to a page from the back-forward cache keeps its record",
    async fn(env) {
      await home(env);
      // Firefox 159 restores a page from its back-forward cache about four times in five here,
      // so the step is repeated until the page is restored (as in the tabs and hints tests).
      let restored = 0;
      for (let i = 0; i < 8 && !restored; i++) {
        await go(env, "cached-a.html");
        await inPage(env, `(() => { const f = document.createElement("form"); f.method = "post"; f.action = "/posted"; f.innerHTML = '<input name="note" value="lamp">'; document.body.append(f); f.submit(); return 1; })()`);
        await waitFor(async () => (await call(env, "tabs.list@1")).tabs.find((t) => t.user)?.title === "Received", { what: "the POST's answer" });
        const posts = env.site.log.filter((e) => e.method === "POST" && e.path === "/posted").length;
        const e = await fails(env, "page.source@1", {}, "not_get");
        assert.equal(e.method, "POST");
        assert.match(e.message, /^the page in tab \d+ is the answer to a POST; fetching it again would send that request again, so page\.dom reads the live document instead$/);
        assert.equal(e.url, env.site.url("posted"));
        assert.equal(env.site.log.filter((x) => x.method === "POST" && x.path === "/posted").length, posts, "nothing was sent again");
        const back = await call(env, "tabs.back@1");
        assert.equal(back.tab.url, env.site.url("cached-a.html"));
        restored = await inPage(env, "window.restored");
        assert.equal((await call(env, "page.source@1")).cache, true);
      }
      assert.equal(restored, 1, "the page came back from the back-forward cache (8 tries)");
    },
  },
  {
    name: "page.source: a page loaded before the extension started is source_unknown until it loads again",
    async fn(env) {
      await home(env);
      await go(env, "help.html");
      const linked = env.kai.linked();
      await env.ext(`(setTimeout(() => browser.runtime.reload(), 0), 1)`);
      await linked;
      env.page = await openExtPage(env.ff, "options/options.html", { select: false });
      const e = await fails(env, "page.source@1", {}, "source_unknown");
      assert.match(e.message, /^Kai for Firefox does not know how the page in tab \d+ was requested: it loaded before the extension started/);
      await call(env, "tabs.reload@1");
      assert.equal((await call(env, "page.source@1")).text, file("help.html"));
    },
  },
  {
    name: "page.source: a page Back restores without a record (from before a restart) is source_unknown, and its reload is known; a download between changes nothing",
    async fn(env) {
      await home(env);
      // Firefox 159 restores a page from its back-forward cache about four times in five here,
      // so the steps are repeated until the page is restored (as in the tabs and hints tests).
      let restored = 0;
      for (let i = 0; i < 8 && !restored; i++) {
        await go(env, "cached-a.html");
        await go(env, "cached-b.html");
        const linked = env.kai.linked();
        await env.ext(`(setTimeout(() => browser.runtime.reload(), 0), 1)`);
        await linked;
        env.page = await openExtPage(env.ff, "options/options.html", { select: false });
        await call(env, "tabs.back@1");
        restored = await inPage(env, "window.restored");
      }
      assert.equal(restored, 1, "the page came back from the back-forward cache (8 tries)");
      await fails(env, "page.source@1", {}, "source_unknown");
      // A download in the tab commits nothing.
      assert.equal((await call(env, "tabs.go@1", { url: env.site.url("download") })).load_error, "NO_PAGE");
      await fails(env, "page.source@1", {}, "source_unknown");
      await call(env, "tabs.reload@1");
      const s = await call(env, "page.source@1");
      assert.deepEqual([s.method, s.url, s.text], ["GET", env.site.url("cached-a.html"), file("cached-a.html")]);
    },
  },
  {
    name: "page.dom: the live document whole, open and closed shadow roots as templates, a cross-origin frame after its <iframe>, Kai's labels left out",
    async fn(env) {
      await home(env);
      await go(env, "dom.html");
      await waitFor(async () => (await call(env, "page.text_all@1")).frames.read === 2, { what: "the frame" });
      await call(env, "hints.show@1");
      try {
        const d = await call(env, "page.dom@1");
        assert.equal(d.url, env.site.url("dom.html"));
        assert.deepEqual(d.frames, { read: 2, unread: 0, unread_frames: [] });
        assert.equal(d.html.length, 3, JSON.stringify(d.html).slice(0, 400));
        const [before, frame, after] = d.html;
        assert.ok(before.startsWith('<!DOCTYPE html><html lang="en"><head>'), before.slice(0, 80));
        // The frame's URL is in its entry; the parent's HTML names only its origin.
        assert.ok(before.endsWith(`<section aria-label="Consent area"><h2>Consent</h2><iframe id="consent" title="Cookie consent" src="http://localhost:${env.site.port}"></iframe>`), before.slice(-200));
        for (const piece of [
          "<!-- a comment stays -->",
          '<p id="quote" data-note="Say &quot;hi&quot; &amp; wave">Fish &amp; chips &lt;3</p>',
          '<div id="open-host"><template shadowrootmode="open"><p>Open part</p></template></div>',
          '<div id="closed-host"><template shadowrootmode="closed"><p>Closed part</p><span id="inner-host"><template shadowrootmode="open"><b>Nested part</b></template></span></template></div>',
        ]) {
          assert.ok(before.includes(piece), `missing ${piece}`);
        }
        assert.equal(frame.frame > 0, true);
        assert.deepEqual([frame.url, frame.origin, frame.src], [env.site.url("consent.html", "localhost"), `http://localhost:${env.site.port}`, env.site.url("consent.html", "localhost")]);
        assert.deepEqual(Object.keys(frame), ["frame", "url", "origin", "src", "html"]);
        assert.equal(frame.html.length, 1);
        assert.ok(frame.html[0].startsWith('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Consent</title></head>'), frame.html[0].slice(0, 120));
        assert.ok(frame.html[0].includes('<button id="accept">Accept all cookies</button>'));
        assert.ok(after.startsWith("</section>"));
        assert.ok(after.includes('<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>'));
        assert.ok(after.includes("if (1 < 2 && 3 > 2)"), "a script's text as it is");
        assert.ok(after.endsWith("</body></html>"), after.slice(-60));
        const all = joined(d.html);
        assert.ok(!all.includes("2147483647") && !all.includes("popover"), "Kai's labels are not the page's");
        assert.equal((await inPage(env, `document.documentElement.lastElementChild.localName`)) !== "body", true, "the labels' host is in the document all the same");
      } finally {
        await call(env, "hints.hide@1");
      }
      // The same document without Kai's labels: the native serialization of everything open.
      const d = await call(env, "page.dom@1");
      const native = (await inPage(env, `"<!DOCTYPE html>" + document.documentElement.outerHTML`)).replace(`src="${env.site.url("consent.html", "localhost")}"`, `src="http://localhost:${env.site.port}"`);
      const strip = (s) => s.replace(/<template shadowrootmode="closed">.*?<\/template><\/span><\/template>/s, "").replace(/<template shadowrootmode="open">.*?<\/template>/gs, "");
      assert.equal(strip(d.html[0] + d.html[2]), native);
    },
  },
  {
    name: "element.dom: one element's HTML with its shadow root, and an element holding a frame with the frame's document",
    async fn(env) {
      await home(env);
      await go(env, "dom.html");
      await waitFor(async () => (await call(env, "page.text_all@1")).frames.read === 2, { what: "the frame" });
      const open = (await call(env, "page.find@1", { text: "Open part" })).matches[0].element;
      const e = await call(env, "element.dom@1", { ref: open.ref });
      assert.deepEqual([e.role, e.name, e.html], ["paragraph", "", ["<p>Open part</p>"]]);
      const region = (await call(env, "page.outline@1")).items.find((i) => i.name === "Consent area");
      const r = await call(env, "element.dom@1", { ref: region.ref });
      assert.deepEqual([r.ref, r.role, r.name], [region.ref, "region", "Consent area"]);
      assert.equal(r.html.length, 3);
      assert.equal(r.html[0], `<section aria-label="Consent area"><h2>Consent</h2><iframe id="consent" title="Cookie consent" src="http://localhost:${env.site.port}"></iframe>`);
      assert.deepEqual([r.html[1].url, r.html[1].src], [env.site.url("consent.html", "localhost"), env.site.url("consent.html", "localhost")]);
      assert.ok(r.html[1].html[0].includes("Accept all cookies"));
      assert.equal(r.html[2], "</section>");
      // An element of the frame names its frame.
      const accept = (await call(env, "page.find@1", { text: "Accept all" })).matches[0];
      const a = await call(env, "element.dom@1", { ref: accept.element.ref });
      assert.deepEqual([a.frame, a.origin, a.html], [accept.frame, `http://localhost:${env.site.port}`, ['<button id="accept">Accept all cookies</button>']]);
      await fails(env, "element.dom@1", { ref: 999999999 }, "unknown_ref");
    },
  },
  {
    name: "page.dom and element.dom: what was typed into a sensitive field and written back into the DOM by the page reads as the mask",
    async fn(env) {
      await home(env);
      await go(env, "dom.html");
      await inPage(env, `(() => {
        const pin = document.getElementById("pin");
        pin.value = "correct-horse-7";
        pin.dispatchEvent(new Event("input"));
        const otp = document.getElementById("otp");
        otp.value = "492817";
        otp.dispatchEvent(new Event("input"));
        return 1;
      })()`);
      assert.equal(await inPage(env, `document.getElementById("pin").getAttribute("value")`), "correct-horse-7", "the page wrote it into the DOM");
      const all = joined((await call(env, "page.dom@1")).html);
      assert.ok(!all.includes("correct-horse-7") && !all.includes("492817"), "no typed secret in page.dom");
      assert.ok(all.includes('<input type="password" id="pin" name="pin" value="password field, filled (15 characters)">'), all.slice(all.indexOf("<form"), all.indexOf("</form>")));
      assert.ok(all.includes('<textarea id="otp" autocomplete="one-time-code">password field, filled (6 characters)</textarea>'));
      const pin = (await call(env, "page.fields@1")).fields.find((i) => i.masked && i.name === "Password");
      const e = await call(env, "element.dom@1", { ref: pin.ref });
      assert.deepEqual(e.html, ['<input type="password" id="pin" name="pin" value="password field, filled (15 characters)">']);
    },
  },
];

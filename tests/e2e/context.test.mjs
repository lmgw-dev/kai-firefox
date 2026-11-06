// context.get (design §5.1) and element.describe with its stale refs (D4), sensitive values kept
// out of what they report (§5), and refs across a restart of the extension.
import assert from "node:assert/strict";
import { call, fails, waitFor, inPage, frameContext, pointTo, press, sleep } from "../lib/util.mjs";
import { openExtPage } from "../lib/env.mjs";
import { home } from "./tabs.test.mjs";

// The centre of an element of the user's tab, scrolled into view.
const centre = (env, sel) =>
  inPage(env, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

// The centre of the consent frame's button, in the top document's viewport.
async function consentButton(env) {
  await centre(env, "#consent");
  const box = await inPage(env, `(() => { const r = document.getElementById("consent").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const ctx = await frameContext(env, "consent.html");
  const b = await env.ff.evalIn(ctx, `(() => { const r = document.getElementById("accept").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  return { x: box.x + b.x + 1, y: box.y + b.y + 1 };
}

const refsIn = (c) => [c.focus, c.pointer, c.dialog, c.view?.heading, c.selection?.field].filter(Boolean).map((e) => e.ref);

export default [
  {
    name: "context.get: the user's tab, the focused field, its selection and the part in view",
    async fn(env) {
      const user = await home(env);
      await inPage(env, `(() => { scrollTo(0, 0); const q = document.getElementById("q"); q.focus(); q.value = "trail lamp"; q.select(); return 1; })()`);
      const c = await call(env, "context.get@1");
      const list = await call(env, "tabs.list@1");
      assert.equal(c.tab.id, user);
      assert.equal(c.tab.title, "Northwind Gear: lamps and tents");
      assert.equal(c.tab.url, env.site.url("shop.html"));
      assert.equal(c.tab.loading, false);
      assert.deepEqual(c.tab.reader, { available: false, on: false });
      assert.equal(c.tab.zoom_percent, 100);
      assert.equal(c.tabs_open, list.tabs.length);
      assert.equal(c.focus.role, "searchbox");
      assert.equal(c.focus.name, "Search the shop");
      assert.ok(Number.isSafeInteger(c.focus.ref) && c.focus.ref > 0);
      assert.deepEqual(c.selection, { length: 10, first_line: "trail lamp", masked: false, field: c.focus });
      assert.deepEqual(c.view, { scrollable: true, percent: 0, heading: { ref: c.view.heading.ref, role: "heading", name: "Lamps and tents", level: 1 } });
      assert.equal(c.dialog, null);
      assert.deepEqual(c.frames, { read: 2, unread: 0, unread_frames: [] });
      assert.equal(c.page_error, null);
      assert.ok(!("announcements" in c), "announcements come with WP9");
    },
  },
  {
    name: "context.get: the element under the pointer, in the page and in a cross-origin frame",
    async fn(env) {
      await home(env);
      const b = await centre(env, "#buy1");
      await pointTo(env, b.x, b.y);
      let c = await call(env, "context.get@1");
      assert.ok(c.pointer, JSON.stringify(c));
      assert.equal(c.pointer.role, "button");
      assert.equal(c.pointer.name, "Add Trail Lamp to cart");
      const p = await centre(env, "#p2 p");
      await pointTo(env, p.x, p.y);
      c = await call(env, "context.get@1");
      assert.equal(c.pointer.role, "paragraph");
      const a = await consentButton(env);
      await pointTo(env, a.x, a.y);
      c = await call(env, "context.get@1");
      assert.equal(c.pointer.role, "button");
      assert.equal(c.pointer.name, "Accept all cookies");
      assert.deepEqual(c.frames, { read: 2, unread: 0, unread_frames: [] });
    },
  },
  {
    name: "context.get: the page's own pointer events do not move the pointer",
    async fn(env) {
      await home(env);
      const b = await centre(env, "#buy1");
      await pointTo(env, b.x, b.y);
      const before = (await call(env, "context.get@1")).pointer;
      assert.equal(before.name, "Add Trail Lamp to cart");
      // Untrusted events at the heading above, then one saying the pointer left the page.
      await inPage(
        env,
        `(() => {
          const h = document.querySelector("#p1 h2");
          const r = h.getBoundingClientRect();
          for (const t of ["pointerover", "mouseover", "pointermove", "pointerdown"]) h.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: r.x + 5, clientY: r.y + 5 }));
          document.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }));
          return 1;
        })()`,
      );
      assert.deepEqual((await call(env, "context.get@1")).pointer, before);
    },
  },
  {
    name: "context.get: the focus inside a cross-origin frame and inside a closed shadow root",
    async fn(env) {
      await home(env);
      // A click does not focus a button in headless Firefox; the frame's script and Tab do.
      await env.ff.evalIn(await frameContext(env, "consent.html"), `(document.getElementById("accept").focus(), 1)`);
      let c = await call(env, "context.get@1");
      assert.equal(c.focus?.role, "button");
      assert.equal(c.focus?.name, "Accept all cookies");
      await inPage(env, `(document.getElementById("buy2").focus(), 1)`);
      await press(env, "\uE004");
      c = await call(env, "context.get@1");
      assert.equal(c.focus?.role, "button");
      assert.equal(c.focus?.name, "Add Camp Stove to cart");
    },
  },
  {
    name: "context.get: the document's selection, its length and first line",
    async fn(env) {
      await home(env);
      const text = await inPage(
        env,
        `(() => { document.activeElement?.blur(); const r = document.createRange(); r.setStartBefore(document.querySelector("#p1 h2")); r.setEndAfter(document.querySelector("#p1 p")); getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString(); })()`,
      );
      const c = await call(env, "context.get@1");
      assert.equal(c.selection.first_line, "Trail Lamp");
      assert.equal(c.selection.length, [...text].length);
      assert.ok(c.selection.length > "Trail Lamp".length);
      assert.equal(c.selection.field, null);
      assert.equal(c.selection.masked, false);
    },
  },
  {
    name: "context.get: the part in view after scrolling, and an open modal dialog",
    async fn(env) {
      await home(env);
      const percent = await inPage(env, `(() => { document.getElementById("p3").scrollIntoView({ block: "start" }); const se = document.scrollingElement; return Math.round(100 * scrollY / (se.scrollHeight - innerHeight)); })()`);
      let c = await call(env, "context.get@1");
      assert.equal(c.view.heading.name, "Camp Stove");
      assert.equal(c.view.heading.level, 2);
      assert.equal(c.view.percent, percent);
      assert.ok(percent > 0);
      await inPage(env, `(document.getElementById("confirm").showModal(), 1)`);
      c = await call(env, "context.get@1");
      assert.equal(c.dialog.role, "dialog");
      assert.equal(c.dialog.name, "Remove the Trail Lamp?");
      await inPage(env, `(document.getElementById("confirm").close(), 1)`);
      assert.equal((await call(env, "context.get@1")).dialog, null);
    },
  },
  {
    name: "context.get: a password field's selection is masked",
    async fn(env) {
      await home(env);
      await call(env, "tabs.go@1", { url: env.site.url("login.html") });
      await inPage(env, `(() => { const p = document.getElementById("pw"); p.focus(); p.select(); return 1; })()`);
      const c = await call(env, "context.get@1");
      assert.equal(c.selection.length, "example-secret-1".length);
      assert.equal(c.selection.first_line, null);
      assert.equal(c.selection.masked, true);
      assert.equal(c.selection.field.name, "Password");
      assert.ok(!JSON.stringify(c).includes("example-secret-1"));
    },
  },
  {
    name: "context.get: card number and one-time code selections are masked, and no name carries a sensitive field's value",
    async fn(env) {
      await home(env);
      await call(env, "tabs.go@1", { url: env.site.url("checkout.html") });
      const said = [];
      const select = async (id) => {
        await inPage(env, `(() => { const f = document.getElementById(${JSON.stringify(id)}); f.focus(); f.select(); return 1; })()`);
        const c = await call(env, "context.get@1");
        said.push(c);
        return c.selection;
      };
      const card = await select("card");
      assert.deepEqual({ ...card, field: card.field.name }, { length: 19, first_line: null, masked: true, field: "Card number" });
      const otp = await select("otp");
      assert.deepEqual({ ...otp, field: otp.field.name }, { length: 6, first_line: null, masked: true, field: "One-time code" });
      // Accname puts an embedded field's value into the name of what contains it or is labelled
      // by it.
      const nameOf = async (id) => {
        await inPage(env, `(document.getElementById(${JSON.stringify(id)}).focus(), 1)`);
        const c = await call(env, "context.get@1");
        said.push(c);
        return c.focus.name;
      };
      assert.equal(await nameOf("card-check"), "Card number password field, filled (19 characters)");
      assert.equal(await nameOf("otp-send"), "Code sent: password field, filled (6 characters)");
      assert.equal(await nameOf("echo"), "password field, filled (16 characters)");
      assert.equal(await nameOf("card-box"), "Pay with password field, filled (19 characters)");
      const all = JSON.stringify(said);
      for (const secret of ["4111", "902614", "example-secret-2", "5500"]) assert.ok(!all.includes(secret), `${secret} was reported`);
      // The page has an <iframe name="kaiFirefoxContent">; the content script loaded all the same.
      assert.equal(said.at(-1).page_error, null);
    },
  },
  {
    name: "context.get: Reader view available, then on (and unreadable), and the zoom",
    async fn(env) {
      const user = await home(env);
      await call(env, "tabs.go@1", { url: env.site.url("article.html") });
      await waitFor(async () => (await call(env, "context.get@1")).tab.reader.available, { what: "Firefox finding the article" });
      await env.ext(`browser.tabs.toggleReaderMode(${user})`);
      const c = await waitFor(
        async () => {
          const c = await call(env, "context.get@1");
          return c.tab.reader.on && c.page_error && c;
        },
        { what: "Reader view on" },
      );
      assert.equal(c.page_error.code, "reader_view");
      assert.equal(c.page_error.message, `Kai cannot read Reader view yet; tab ${user} shows the Reader view of a page`);
      await env.ext(`browser.tabs.toggleReaderMode(${user})`);
      await waitFor(async () => (await call(env, "context.get@1")).tab.url === env.site.url("article.html"), { what: "Reader view off" });
      await env.ext(`browser.tabs.setZoom(${user}, 1.5)`);
      assert.equal((await call(env, "context.get@1")).tab.zoom_percent, 150);
      await env.ext(`browser.tabs.setZoom(${user}, 1)`);
    },
  },
  {
    name: "element.describe: a ref names its element while its document lives; refs are never reused",
    async fn(env) {
      const user = await home(env);
      await inPage(env, `(document.getElementById("q").focus(), 1)`);
      const a = await call(env, "context.get@1");
      const b = await call(env, "context.get@1");
      assert.equal(a.focus.ref, b.focus.ref);
      assert.equal(a.view.heading.ref, b.view.heading.ref);
      const d = await call(env, "element.describe@1", { ref: a.focus.ref });
      assert.deepEqual(d, { ref: a.focus.ref, tab: { id: user, title: "Northwind Gear: lamps and tents", url: env.site.url("shop.html") }, frame: 0, origin: `http://127.0.0.1:${env.site.port}`, role: "searchbox", name: "Search the shop" });
      const before = Math.max(...refsIn(a), ...refsIn(b));
      await call(env, "tabs.reload@1");
      const c = await call(env, "context.get@1");
      assert.equal(c.view.heading.name, "Lamps and tents");
      assert.ok(c.view.heading.ref > before, `the reloaded page's heading got ref ${c.view.heading.ref}, after ${before}`);
    },
  },
  {
    name: "element.describe: a stale ref says why (element removed, page or frame navigated, tab closed, never given out)",
    async fn(env) {
      const user = await home(env);
      const b = await centre(env, "#buy1");
      await pointTo(env, b.x, b.y);
      const c = await call(env, "context.get@1");
      const buy = c.pointer.ref;
      const heading = c.view.heading.ref;
      await inPage(env, `(document.getElementById("buy1").remove(), 1)`);
      assert.deepEqual(await fails(env, "element.describe@1", { ref: buy }, "stale_element"), { code: "stale_element", message: `ref ${buy}'s element is no longer in the page of tab ${user} (the page removed it)`, tab: user, title: "Northwind Gear: lamps and tents", url: env.site.url("shop.html") });
      const a = await consentButton(env);
      await pointTo(env, a.x, a.y);
      const accept = (await call(env, "context.get@1")).pointer.ref;
      const described = await call(env, "element.describe@1", { ref: accept });
      assert.equal(described.name, "Accept all cookies");
      assert.ok(described.frame > 2 ** 32, `the frame id ${described.frame} keeps its 64 bits`);
      await inPage(env, `(document.getElementById("consent").src = ${JSON.stringify(env.site.url("help.html"))}, 1)`);
      const stale = await waitFor(
        async () => {
          try {
            await call(env, "element.describe@1", { ref: accept });
            return null;
          } catch (e) {
            return e.code === "stale_document" && e.error.message.includes("before the last navigation") && e.error;
          }
        },
        { what: "the frame's ref going stale" },
      );
      assert.equal(stale.message, `ref ${accept} is from the page before the last navigation of a frame in tab ${user}`);
      await call(env, "tabs.go@1", { url: env.site.url("help.html") });
      assert.equal((await fails(env, "element.describe@1", { ref: heading }, "stale_document")).message, `ref ${heading} is from the page before the last navigation in tab ${user}`);
      const t = (await call(env, "tabs.open@1", { url: env.site.url("article.html") })).tab.id;
      const h = (await call(env, "context.get@1")).view.heading.ref;
      await call(env, "tabs.close@1", { tab: t });
      assert.equal((await fails(env, "element.describe@1", { ref: h }, "stale_tab")).message, `ref ${h} was in tab ${t}, which is closed`);
      assert.equal((await fails(env, "element.describe@1", { ref: 999999 }, "unknown_ref")).message, "ref 999999 was never given out in this Firefox run");
      await fails(env, "element.describe@1", { ref: 0 }, "bad_args");
      await fails(env, "element.describe@1", {}, "bad_args");
      await call(env, "tabs.switch@1", { tab: user });
    },
  },
  {
    name: "refs: after the extension restarts, its earlier refs say so and new ones go on above them",
    async fn(env) {
      await home(env);
      await inPage(env, `(document.getElementById("q").focus(), 1)`);
      const old = (await call(env, "context.get@1")).focus.ref;
      const { ref_next: stored } = await env.ext(`browser.storage.local.get("ref_next")`);
      assert.ok(stored > old, `the counter (${stored}) is stored past ref ${old}`);
      const linked = env.kai.linked();
      // The options page closes with the extension it belongs to.
      await env.ext(`(setTimeout(() => browser.runtime.reload(), 0), 1)`);
      await linked;
      env.page = await openExtPage(env.ff, "options/options.html", { select: false });
      const e = await fails(env, "element.describe@1", { ref: old }, "unknown_ref");
      assert.equal(e.message, `ref ${old} is from before Kai for Firefox restarted (reloaded, updated, enabled again, or its background suspended); the extension no longer knows its element`);
      const now = (await call(env, "context.get@1")).focus;
      assert.equal(now.name, "Search the shop");
      assert.ok(now.ref >= stored, `the element got ref ${now.ref}, not one from ${stored} on`);
      assert.equal((await call(env, "element.describe@1", { ref: now.ref })).name, "Search the shop");
      assert.equal((await fails(env, "element.describe@1", { ref: now.ref + 1000 }, "unknown_ref")).message, `ref ${now.ref + 1000} was never given out in this Firefox run`);
    },
  },
  {
    name: "content_ms: a page whose script keeps it busy is content_timeout for context.get and element.describe, naming the setting; then it answers again",
    async fn(env) {
      const user = await home(env);
      // On the other site (localhost), so the busy thread is not the shop's.
      const t = (await call(env, "tabs.open@1", { url: env.site.url("busy.html", "localhost") })).tab.id;
      const ctx = (await env.ff.send("browsingContext.getTree", {})).contexts.find((c) => c.url.includes("busy.html")).context;
      const ref = (await call(env, "context.get@1")).view.heading.ref;
      await env.ext(`browser.storage.local.set({ content_ms: 500 })`);
      try {
        await env.ff.evalIn(ctx, `(spin(4000), 1)`);
        await sleep(100);
        const t0 = Date.now();
        const c = await call(env, "context.get@1");
        assert.ok(Date.now() - t0 < 2500, `answered after ${Date.now() - t0} ms`);
        assert.equal(c.tab.id, t);
        assert.deepEqual(c.page_error, { code: "content_timeout", message: `tab ${t} did not answer within 500 ms (Kai for Firefox's setting content_ms): its page is busy, or its script is stuck` });
        const e = await fails(env, "element.describe@1", { ref }, "content_timeout");
        assert.equal(e.message, `ref ${ref}'s page in tab ${t} did not answer within 500 ms (Kai for Firefox's setting content_ms): its page is busy, or its script is stuck`);
      } finally {
        await env.ext(`browser.storage.local.remove("content_ms")`);
      }
      const back = await waitFor(async () => (await call(env, "element.describe@1", { ref }).catch(() => null))?.name, { what: "the busy page answering again" });
      assert.equal(back, "Busy");
      await call(env, "tabs.close@1", { tab: t });
      await call(env, "tabs.switch@1", { tab: user });
    },
  },
];

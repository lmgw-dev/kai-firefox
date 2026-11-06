// The sidebar page (design §8; WP8b): lmgw's Chat in the real sidebar panel of headless Firefox,
// its requests through the background's relay and the real kai-browser-host to the fake Kai, which
// answers them from a scripted lmgw (tests/lib/fake-lmgw.mjs) as Kai's proxy does, its window and
// acks included. These run in an environment of their own, with the extension as it ships
// (extension/, with the page built into extension/sidebar/ by scripts/sidebar.sh).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openSidebar, closeSidebar, inSidebar, inSidebarChrome } from "../lib/sidebar.mjs";
import { EXT_DIR } from "../lib/env.mjs";
import { fakeLmgw, serveSidebar, AHEAD } from "../lib/fake-lmgw.mjs";
import { call, sleep, waitFor } from "../lib/util.mjs";

// Whether the page is built; the tests say how to build it when it is not.
export const built = () => existsSync(join(EXT_DIR, "sidebar", "sidebar.html"));

// The Chat mounted.
const CHAT_READY = `!!document.querySelector(".chat-main")`;

// A fresh lmgw behind the fake Kai, the first tab on a fixture page, and the sidebar open on it.
async function up(env, { rules, path = "article.html" } = {}) {
  if (!built()) throw new Error("the sidebar page is not built: run scripts/sidebar.sh (release) or scripts/sidebar.sh debug first");
  const lmgw = fakeLmgw();
  env.kai.rules = rules ?? (() => "act");
  env.kai.beforeSite = null;
  env.kai.siteError = null;
  const rec = serveSidebar(env.kai, lmgw);
  const first = await firstTab(env);
  await call(env, "tabs.switch@1", { tab: first });
  await call(env, "tabs.go@1", { tab: first, url: env.site.url(path) });
  await openSidebar(env.ff, { ready: CHAT_READY, what: "the Chat" });
  return { lmgw, rec, first };
}

async function firstTab(env) {
  const list = await call(env, "tabs.list@1");
  return list.tabs.find((t) => t.index === 0 && t.window === list.tabs[0].window).id;
}

// What the page shows.
const page = (env) =>
  inSidebar(
    env.ff,
    `({
      site: document.querySelector("[data-kai=site]")?.textContent ?? null,
      rule: document.querySelector("[data-kai=rule]")?.textContent ?? null,
      link: document.querySelector("[data-kai=link]")?.textContent ?? null,
      attach: document.querySelector("[data-kai=attach]")?.disabled === false,
      hints: document.querySelector("[data-kai=hints]")?.disabled === false,
      gatewayLeft: document.querySelector("[data-kai=gateway-left]")?.innerText ?? null,
      threads: document.querySelector(".chat-drawer-btn .count")?.textContent ?? null,
      text: document.querySelector(".chat-scroll")?.innerText ?? "",
      toasts: [...document.querySelectorAll(".toast")].map((e) => e.innerText),
      stop: !!document.querySelector("[aria-label=Stop]"),
    })`,
  );

// Clicks the element `sel` in the sidebar's page.
const click = (env, sel) => inSidebar(env.ff, `(document.querySelector(${JSON.stringify(sel)}).click(), 1)`);

// Types `text` into the composer and sends it.
async function send(env, text) {
  await inSidebar(
    env.ff,
    `(() => { const t = document.querySelector("textarea.composer-input"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`,
  );
  await waitFor(() => inSidebar(env.ff, `document.querySelector(".composer-send")?.disabled === false`), { what: "the Send button enabled" });
  await click(env, ".composer-send");
}

// The request of `method path` Kai got (the first from index `from` of rec.reqs).
const reqOf = (rec, method, path, from = 0) => waitFor(() => rec.reqs.slice(from).find((r) => r.frame.method === method && r.frame.path === path), { what: `the ${method} ${path} request at Kai` });

// The frames Kai takes, as the fake Kai lists them by default.
const TAKES = ["hello", "error", "op_result", "event", "ask", "req", "ack", "abort", "site", "chunk", "end"];

// Links the fake Kai again, its welcome listing `takes` (null: none, as a Kai before the list).
async function relink(env, takes) {
  env.kai.takes = takes;
  const linked = env.kai.linked();
  env.conn().close();
  await linked;
}

// What the inline frame of the HTML preview and the sandbox page around it can reach: whether the
// extension's APIs are there (read without Xrays, as the page's own script sees its globals).
const previewApis = (env) =>
  inSidebarChrome(
    env.ff,
    `(() => {
      const outer = content.document.querySelector("iframe.preview-frame");
      const inner = outer?.contentDocument?.querySelector("iframe");
      const of = (w) => w && { browser: typeof w.wrappedJSObject.browser, chrome: typeof w.wrappedJSObject.chrome };
      return { page: of(content), sandbox: of(outer?.contentWindow), inner: of(inner?.contentWindow) };
    })()`,
  );

// A second port to the background from the sidebar's own page, for the background's answers to
// the page's calls (`page_text`) beside what the strip's buttons allow.
const pageCall = (env, frame) =>
  inSidebar(
    env.ff,
    `(() => {
      const st = (window.__kaiCall = { answer: null });
      const p = browser.runtime.connect({ name: "kai-sidebar" });
      p.onMessage.addListener((m) => { if (m.t === "answer") { st.answer = m; p.disconnect(); } });
      p.postMessage(${JSON.stringify(frame)});
      return 1;
    })()`,
  ).then(() => waitFor(() => inSidebar(env.ff, "window.__kaiCall.answer"), { what: `the background's answer to ${frame.t}` }));

export default [
  {
    name: "chat: the Chat loads its threads through the relay and opens the first",
    async fn(env) {
      const { rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread's reply in the Chat" });
        assert.equal((await page(env)).threads, "2", "two threads listed");
        const list = await reqOf(rec, "GET", "/chat/api/threads");
        assert.equal(list.frame.read, "whole");
        assert.deepEqual(list.frame.headers, {});
        assert.equal(list.frame.body, null);
        assert.ok(list.ended, "the list's answer ended");
        const feed = await reqOf(rec, "GET", "/chat/api/feed");
        assert.equal(feed.frame.read, "stream", "the feed is read as a stream");
        await reqOf(rec, "GET", "/chat/api/threads/1");
        await reqOf(rec, "GET", "/v1/models");
        // Both threads in the list's drawer.
        await click(env, "[data-drawer=Conversations]");
        const titles = await waitFor(() => inSidebar(env.ff, `[...document.querySelectorAll("[data-thread] .thread-title")].map((e) => e.textContent.trim())`).then((t) => t.length === 2 && t), {
          what: "the list's drawer",
        });
        assert.deepEqual(titles.sort(), ["Lamp shopping", "Trip to the hills"]);
        // Every request went to Kai under an id of the link's, none directly to lmgw (the fake
        // lmgw saw exactly Kai's).
        assert.ok(rec.reqs.length >= 4);
        assert.ok(rec.reqs.every((r) => Number.isSafeInteger(r.frame.id) && r.frame.id > 0));
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: the page runs under lmgw's §8.9 policy: an image from elsewhere and an inline script are refused",
    async fn(env) {
      await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        assert.equal(await inSidebar(env.ff, `document.documentElement.dataset.cspViolations ?? "0"`), "0", "the Chat ran under the policy with nothing refused");
        await inSidebar(
          env.ff,
          `(() => {
            window.__kaiCsp = [];
            document.addEventListener("securitypolicyviolation", (e) => window.__kaiCsp.push(e.violatedDirective));
            const img = document.createElement("img");
            img.src = "https://198.51.100.7/elsewhere.png";
            document.body.appendChild(img);
            const s = document.createElement("script");
            s.textContent = "window.__kaiInline = 1";
            document.body.appendChild(s);
            return 1;
          })()`,
        );
        const got = await waitFor(() => inSidebar(env.ff, "window.__kaiCsp.length >= 2 && window.__kaiCsp"), { what: "two violations reported" });
        assert.ok(got.some((d) => d.startsWith("img-src")), JSON.stringify(got));
        assert.ok(got.some((d) => d.startsWith("script-src")), JSON.stringify(got));
        assert.equal(await inSidebar(env.ff, "window.__kaiInline ?? null"), null, "the inline script did not run");
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: a send streams its reply through the relay, the page acking the pieces as it takes them",
    async fn(env) {
      const { lmgw, rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        const from = rec.reqs.length;
        await send(env, "Where is the lamp?");
        const r = await reqOf(rec, "POST", "/chat/api/threads/1/send", from);
        assert.equal(r.frame.read, "stream");
        assert.equal(r.frame.headers["content-type"], "application/json");
        assert.equal(JSON.parse(r.frame.body.text).content, "Where is the lamp?");
        // The first piece is shown while lmgw holds the rest, and it was acknowledged: the page
        // took it.
        await waitFor(async () => (await page(env)).text.includes("The"), { what: "the reply's first piece" });
        await waitFor(() => r.acked >= 2, { what: "the acks of the turn's first pieces" });
        lmgw.releaseSend();
        await waitFor(async () => (await page(env)).text.includes("The lamp is on the table."), { what: "the whole reply" });
        // Every piece the page took was acknowledged while the stream was open.
        await waitFor(() => r.sent.length === 7 && r.acked === 7, { what: `the acks of all 7 pieces (${r.acked} of ${r.sent.length})` });
        lmgw.releaseEnd();
        await waitFor(() => r.ended, { what: "the send's end" });
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: a send carries the origin naming the tab beside the sidebar, an edit too",
    async fn(env) {
      const { lmgw, rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        await waitFor(async () => (await page(env)).rule === "act", { what: "the strip's rule act" });
        const named = `Typed in Kai's sidebar in Firefox, beside the tab \u201cJournal: a night on the ridge\u201d (${env.site.url("article.html")}).`;
        const from = rec.reqs.length;
        await send(env, "Where is the lamp?");
        const r = await reqOf(rec, "POST", "/chat/api/threads/1/send", from);
        assert.equal(JSON.parse(r.frame.body.text).origin, named);
        lmgw.releaseSend();
        lmgw.releaseEnd();
        await waitFor(() => r.ended, { what: "the send's end" });
        // An edit of the first user message.
        const at = rec.reqs.length;
        await click(env, "[aria-label=Edit]");
        await waitFor(() => inSidebar(env.ff, `!!document.querySelector(".msg-edit-ta")`), { what: "the message editor" });
        await inSidebar(env.ff, `(() => { const t = document.querySelector(".msg-edit-ta"); t.value = "Which lamp for the ridge?"; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
        await waitFor(() => inSidebar(env.ff, `document.querySelector(".msg-edit-btns .btn.primary")?.disabled === false`), { what: "Save & send enabled" });
        await click(env, ".msg-edit-btns .btn.primary");
        const e = await reqOf(rec, "POST", "/chat/api/threads/1/messages/11/edit", at);
        const body = JSON.parse(e.frame.body.text);
        assert.equal(body.content, "Which lamp for the ridge?");
        assert.equal(body.origin, named);
        lmgw.releaseSend();
        lmgw.releaseEnd();
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: a send beside a none site carries the origin without the tab",
    async fn(env) {
      const { rec } = await up(env, { rules: () => "none" });
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        await waitFor(async () => (await page(env)).rule === "none", { what: "the strip's rule none" });
        const from = rec.reqs.length;
        await send(env, "Where is the lamp?");
        const r = await reqOf(rec, "POST", "/chat/api/threads/1/send", from);
        assert.equal(JSON.parse(r.frame.body.text).origin, "Typed in Kai's sidebar in Firefox.");
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: a whole answer larger than Kai's 4 MB window completes, the page acking its pieces as they come",
    async fn(env) {
      const { lmgw, rec } = await up(env);
      try {
        lmgw.padding[2] = 6 * 1024 * 1024;
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        const from = rec.reqs.length;
        await click(env, "[data-drawer=Conversations]");
        await waitFor(() => inSidebar(env.ff, `!!document.querySelector("[data-thread='2']")`), { what: "the list's drawer" });
        await click(env, "[data-thread='2']");
        const r = await reqOf(rec, "GET", "/chat/api/threads/2", from);
        assert.equal(r.frame.read, "whole");
        await waitFor(async () => (await page(env)).text.includes("Compare two lamps"), { what: "thread 2 open", ms: 30000 });
        const total = r.sent.reduce((a, b) => a + b, 0);
        assert.ok(total > AHEAD, `the answer (${total} bytes of pieces) is larger than the window (${AHEAD})`);
        assert.ok(r.maxAhead <= AHEAD, `never more than the window unacknowledged (${r.maxAhead})`);
        assert.ok(r.ackedBeforeEnd > 0, "pieces were acknowledged before the answer was whole");
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: Stop aborts the streaming send at Kai",
    async fn(env) {
      const { rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        const from = rec.reqs.length;
        await send(env, "Tell me more");
        const r = await reqOf(rec, "POST", "/chat/api/threads/1/send", from);
        await waitFor(async () => (await page(env)).stop, { what: "the Stop button" });
        const at = env.conn().frames.length;
        await click(env, "[aria-label=Stop]");
        await env.conn().next((f) => f.t === "abort" && f.id === r.frame.id, { from: at, what: "the send's abort at Kai" });
        assert.ok(r.aborted);
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: Kai gone locks the Chat and ends its feed; Kai back opens the feed again with its cursor",
    async fn(env) {
      const { lmgw, rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        const feed = await reqOf(rec, "GET", "/chat/api/feed");
        await waitFor(() => feed.sent.length >= 1, { what: "the feed's hello" });
        // An event after the hello moves the cursor.
        lmgw.announce(3, "Made on the phone");
        await waitFor(async () => (await page(env)).threads === "3", { what: "the thread made elsewhere, through the feed" });
        const cursor = `e1:${lmgw.feedCursor}:aa`;
        // Kai goes, and does not welcome the host's next hello until told.
        env.kai.mode = "hold";
        const helloed = env.kai.helloed();
        const from = rec.reqs.length;
        env.conn().close();
        await waitFor(async () => (await page(env)).link === "Kai is not linked", { what: "the strip saying Kai is not linked" });
        const conn = await helloed;
        // Locked: no feed is asked while there is no link.
        await sleep(1500);
        assert.equal(rec.reqs.slice(from).filter((r) => r.frame.path === "/chat/api/feed").length, 0);
        env.kai.mode = "welcome";
        env.kai.welcome(conn);
        const again = await reqOf(rec, "GET", "/chat/api/feed", from);
        assert.equal(again.frame.headers["last-event-id"], cursor, "the feed resumed from the last event's id");
        await waitFor(async () => (await page(env)).link === null, { what: "the strip back on the site" });
      } finally {
        env.kai.mode = "welcome";
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: Kai leaving its lmgw (gateway_left) ends the open requests and the page says so",
    async fn(env) {
      const { rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        const feed = await reqOf(rec, "GET", "/chat/api/feed");
        rec.open.delete(feed.frame.id);
        feed.aborted = true;
        env.conn().send({ t: "end", id: feed.frame.id, seq: feed.sent.length, error: { code: "gateway_left", message: "Kai was paired with another lmgw" } });
        const said = await waitFor(async () => (await page(env)).gatewayLeft, { what: "the page saying Kai left its lmgw" });
        assert.match(said, /Kai left the lmgw this Chat came from: Kai was paired with another lmgw/);
        assert.match(said, /Reload/);
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: the HTML preview runs in the sandbox page, its inline script too, posted the code by the Chat",
    async fn(env) {
      const { rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        await click(env, "[data-drawer=Conversations]");
        await waitFor(() => inSidebar(env.ff, `!!document.querySelector("[data-thread='2']")`), { what: "the list's drawer" });
        await click(env, "[data-thread='2']");
        await waitFor(() => inSidebar(env.ff, `!!document.querySelector(".code-tools button[title^=Preview]")`), { what: "the code block's Preview button" });
        await click(env, ".code-tools button[title^=Preview]");
        const frame = await waitFor(
          () =>
            inSidebar(env.ff, `(() => { const f = document.querySelector("iframe.preview-frame"); return f && { src: f.getAttribute("src"), sandbox: f.getAttribute("sandbox"), srcdoc: f.hasAttribute("srcdoc") }; })()`),
          { what: "the preview frame" },
        );
        assert.deepEqual(frame, { src: "preview.html", sandbox: null, srcdoc: false }, "the sandbox page as the frame's src, no sandbox attribute, no srcdoc");
        // The sandbox page got the code and shows it in its own srcdoc frame, whose inline script ran.
        const inner = await waitFor(
          () =>
            inSidebarChrome(
              env.ff,
              `(() => {
                const outer = content.document.querySelector("iframe.preview-frame");
                const d = outer?.contentDocument;
                const f = d?.querySelector("iframe");
                return f?.contentDocument?.getElementById("p") ? { received: d.body.dataset.received, lang: d.body.dataset.lang, sandbox: f.getAttribute("sandbox"), text: f.contentDocument.getElementById("p").textContent, origin: String(outer.contentWindow.origin) } : null;
              })()`,
            ).then((v) => v && v.text === "ran inline" && v),
          { what: "the previewed page's inline script running" },
        );
        assert.equal(inner.lang, "html");
        assert.equal(inner.origin, "null", "the sandbox page has an opaque origin");
        assert.match(inner.sandbox, /allow-scripts/);
        // Neither the sandbox page nor the previewed page has an extension API; the sidebar's own
        // page, read the same way, has them.
        const apis = await previewApis(env);
        assert.deepEqual(apis.page, { browser: "object", chrome: "object" }, JSON.stringify(apis));
        assert.deepEqual(apis.sandbox, { browser: "undefined", chrome: "undefined" }, JSON.stringify(apis));
        assert.deepEqual(apis.inner, { browser: "undefined", chrome: "undefined" }, JSON.stringify(apis));
        assert.ok(rec.reqs.every((r) => !r.frame.path.includes("preview")), "the preview loads nothing through Kai");
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: Attach this page attaches the active tab's readable text, headed with its title and URL",
    async fn(env) {
      const { lmgw, rec } = await up(env);
      try {
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        const url = env.site.url("article.html");
        await waitFor(async () => (await page(env)).rule === "act", { what: "the strip's rule" });
        assert.equal((await page(env)).site, new URL(url).host);
        assert.ok(rec.sites.some((urls) => urls.includes(url)), "the rule was asked of Kai");
        const sites = rec.sites.length;
        await click(env, "[data-kai=attach]");
        const up1 = await waitFor(() => lmgw.uploads[0], { what: "the page's upload into the thread" });
        assert.equal(up1.thread, 1);
        assert.match(up1.name, /\.txt$/);
        assert.equal(up1.type, "text/plain");
        const title = await env.ff.evalIn(env.ff.context, "document.title");
        assert.ok(up1.text.startsWith(`Page: ${title} (${url})\n\n`), up1.text.slice(0, 200));
        assert.ok(up1.text.length > 200, "the article's text is in it");
        assert.ok(rec.sites.length > sites, "the background asked Kai the rule again before it read the page");
        await waitFor(() => inSidebar(env.ff, `[...document.querySelectorAll(".composer *")].some((e) => e.textContent.includes(${JSON.stringify(up1.name)}))`), { what: "the file's chip in the composer" });
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: Attach this page gives nothing of a none site, and never reads an extension's page",
    async fn(env) {
      const { lmgw, rec, first } = await up(env, { rules: (u) => (u.includes("article.html") ? "none" : "act") });
      let tab = null;
      try {
        await waitFor(async () => (await page(env)).rule === "none", { what: "the strip's rule none" });
        const p = await page(env);
        assert.equal(p.attach, false, "Attach is off on a none site");
        assert.equal(p.hints, false, "Hints are off on a none site");
        // The background refuses it too, whatever the strip allows.
        const a = await pageCall(env, { t: "page_text", id: 1, tab: first });
        assert.equal(a.error.code, "site_none");
        assert.equal(lmgw.uploads.length, 0);
        // An extension's page (this extension's options page) is never read: the background does
        // not even ask Kai.
        const list = await call(env, "tabs.list@1");
        const ext = list.tabs.find((t) => t.url.startsWith("moz-extension:"));
        await call(env, "tabs.switch@1", { tab: ext.id });
        tab = first;
        await waitFor(async () => (await page(env)).rule === "no site", { what: "the strip on the extension's page" });
        assert.equal((await page(env)).site, "An extension's page");
        assert.equal((await page(env)).attach, false);
        const asked = rec.sites.length;
        const b = await pageCall(env, { t: "page_text", id: 2, tab: ext.id });
        assert.equal(b.error.code, "not_a_site");
        assert.equal(rec.sites.length, asked, "no site question for an extension's page");
        assert.equal(lmgw.uploads.length, 0);
      } finally {
        if (tab !== null) await call(env, "tabs.switch@1", { tab });
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: the site strip follows the active tab and its navigations",
    async fn(env) {
      const { rec, first } = await up(env, { rules: (u) => (u.startsWith("http://localhost") ? "read" : "act") });
      let other = null;
      try {
        const a = new URL(env.site.url("article.html")).host;
        await waitFor(async () => (await page(env)).site === a && (await page(env)).rule === "act", { what: `the strip on ${a}` });
        const opened = await call(env, "tabs.open@1", { url: env.site.url("shop.html", "localhost") });
        other = opened.tab.id;
        const b = new URL(env.site.url("shop.html", "localhost")).host;
        await waitFor(async () => (await page(env)).site === b && (await page(env)).rule === "read", { what: `the strip on ${b} (read)` });
        assert.equal((await page(env)).attach, true, "a read site may be attached");
        await call(env, "tabs.switch@1", { tab: first });
        await waitFor(async () => (await page(env)).site === a && (await page(env)).rule === "act", { what: `the strip back on ${a}` });
        // A navigation in the tab.
        await call(env, "tabs.go@1", { tab: first, url: env.site.url("help.html", "localhost") });
        await waitFor(async () => (await page(env)).site === b && (await page(env)).rule === "read", { what: "the strip after the navigation" });
        assert.ok(rec.sites.length >= 3);
        // The hints switch shows the labels on the tab (hints.show@1 in the page).
        await inSidebar(env.ff, `(() => { const c = document.querySelector("[data-kai=hints]"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
        const shown = () => env.ext(`browser.tabs.sendMessage(${first}, { kai: "overlay_state" }, { frameId: 0 })`).then((s) => (s.hints ?? []).filter((l) => l.shown).length);
        await waitFor(async () => (await shown()) > 0, { what: "the hint labels on the page" });
        // Off again: the labels go.
        await inSidebar(env.ff, `(() => { const c = document.querySelector("[data-kai=hints]"); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
        await waitFor(async () => (await shown()) === 0, { what: "the hint labels gone" });
      } finally {
        if (other !== null) await call(env, "tabs.close@1", { tab: other }).catch(() => {});
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: Attach this page refuses a page that went to a none site while it was read (pinned to its document), uploading nothing",
    async fn(env) {
      const none = env.site.url("shop.html", "localhost");
      const { lmgw, first } = await up(env, { rules: (u) => (u.startsWith("http://localhost") ? "none" : "act") });
      try {
        const url = env.site.url("article.html");
        await waitFor(async () => (await page(env)).rule === "act", { what: "the strip's rule act" });
        // The tab goes to the none site between the background's question about the page's rule
        // and the read: Kai answers the question once the next page has committed. Armed just
        // before each call, so the strip's own questions pass.
        let armed = false;
        let moved = 0;
        env.kai.beforeSite = async (urls) => {
          if (!armed || urls.length !== 1 || urls[0] !== url) return;
          armed = false;
          await call(env, "tabs.go@1", { tab: first, url: none });
          moved++;
        };
        armed = true;
        const a = await pageCall(env, { t: "page_text", id: 1, tab: first });
        assert.equal(moved, 1, "the tab went to the none site while its rule was asked");
        // Not site_none: the none page was never read (the read went to the document whose rule
        // was asked, which was gone), so there was no rule of it to apply.
        assert.equal(a.error?.code, "page_changed", JSON.stringify(a));
        assert.equal(lmgw.uploads.length, 0, "nothing uploaded");
        await waitFor(async () => (await page(env)).rule === "none", { what: "the strip on the none site" });
        // The hints are pinned the same way: asked for the page before, drawn on none.
        await call(env, "tabs.go@1", { tab: first, url });
        await waitFor(async () => (await page(env)).rule === "act", { what: "the strip back on the act site" });
        armed = true;
        const h = await pageCall(env, { t: "hints", id: 2, tab: first, on: true });
        assert.equal(moved, 2);
        assert.equal(h.error?.code, "page_changed", JSON.stringify(h));
        const labels = await env.ext(`browser.tabs.sendMessage(${first}, { kai: "overlay_state" }, { frameId: 0 })`).then((st) => (st.hints ?? []).length);
        assert.equal(labels, 0, "no hint labels on the none site");
      } finally {
        env.kai.beforeSite = null;
        await call(env, "tabs.go@1", { tab: first, url: env.site.url("article.html") }).catch(() => {});
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: a rule word Kai for Firefox does not know is none: shown as none, nothing read, no hints",
    async fn(env) {
      const { lmgw, first } = await up(env, { rules: () => "ask" });
      try {
        await waitFor(async () => (await page(env)).rule === "none", { what: "the strip's rule none for the word ask" });
        const p = await page(env);
        assert.equal(p.attach, false);
        assert.equal(p.hints, false);
        const a = await pageCall(env, { t: "page_text", id: 1, tab: first });
        assert.equal(a.error?.code, "site_none", JSON.stringify(a));
        const h = await pageCall(env, { t: "hints", id: 2, tab: first, on: true });
        assert.equal(h.error?.code, "site_none", JSON.stringify(h));
        const s = await pageCall(env, { t: "site", id: 3, url: env.site.url("article.html") });
        assert.equal(s.ok?.rule, "none", JSON.stringify(s));
        assert.equal(lmgw.uploads.length, 0);
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: a Kai too old for the site question is said in the strip at once, and so is Kai's unknown_frame",
    async fn(env) {
      let rec;
      try {
        // A Kai whose welcome lists no frames, as one before the list: the question is not sent.
        await relink(env, null);
        ({ rec } = await up(env));
        const chip = () => inSidebar(env.ff, `(() => { const c = document.querySelector("[data-kai=rule]"); return c && { text: c.textContent, title: c.title }; })()`);
        let c = await waitFor(async () => ((await chip())?.text === "update Kai" ? chip() : null), { what: "the strip saying Kai is too old" });
        assert.match(c.title, /does not answer the sidebar's question about a site's rule yet: update Kai/);
        assert.equal(rec.sites.length, 0, "no site question went to it");
        await closeSidebar(env.ff);
        // A Kai that answers a frame it does not take with its error (unknown_frame).
        await relink(env, TAKES);
        ({ rec } = await up(env));
        env.kai.siteError = () => ({ code: "unknown_frame", message: "Kai 0.0.0-fake does not take a site frame: update Kai" });
        await call(env, "tabs.go@1", { tab: await firstTab(env), url: env.site.url("help.html") });
        c = await waitFor(async () => ((await chip())?.text === "update Kai" ? chip() : null), { what: "the strip saying Kai does not take the frame" });
        assert.match(c.title, /does not take a site frame/);
      } finally {
        if (env.kai.takes !== TAKES) await relink(env, TAKES);
        env.kai.siteError = null;
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "chat: a diagram shows its source and says it is not drawn in Kai's sidebar yet (Mermaid's stand-in)",
    async fn(env) {
      const { lmgw } = await up(env);
      try {
        lmgw.messages[2].push({ id: 23, thread_id: 2, role: "assistant", content: "The route:\n\n```mermaid\ngraph TD\n  Tent --> Lamp\n```", created_at: "2026-11-03T10:00:00Z" });
        await waitFor(async () => (await page(env)).text.includes("Trail Lamp"), { what: "the first thread" });
        await click(env, "[data-drawer=Conversations]");
        await waitFor(() => inSidebar(env.ff, `!!document.querySelector("[data-thread='2']")`), { what: "the list's drawer" });
        await click(env, "[data-thread='2']");
        const shown = await waitFor(
          () => inSidebar(env.ff, `(() => { const e = document.querySelector(".mermaid-error"); const c = document.querySelector("code.language-mermaid"); return e && c && { note: e.textContent, source: c.textContent, svg: !!document.querySelector(".mermaid-view svg") }; })()`),
          { what: "the diagram's source and its note" },
        );
        assert.match(shown.source, /Tent --> Lamp/);
        assert.match(shown.note, /diagrams are not drawn in Kai's sidebar yet; the diagram's source is above/);
        assert.equal(shown.svg, false, "nothing drawn");
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
];

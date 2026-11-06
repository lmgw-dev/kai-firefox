// The sidebar's requests through the background's relay (design §8.2, §4.4; docs/protocol/
// operations.md, "The sidebar's requests"), from the real sidebar panel through the real
// kai-browser-host to the fake Kai: the relay takes the port only from the extension's own sidebar
// page (not the same page in a tab, not the options page, not a content script), renumbers the
// requests for the link and Kai's answers back, passes the page's acks on (and makes none of its
// own), aborts at Kai what a closed sidebar leaves open, and ends what the link's end leaves open.
// These tests run in an environment of their own, with the extension's copy that has the test
// page as its sidebar (tests/lib/sidebar.mjs).
import assert from "node:assert/strict";
import { openSidebar, closeSidebar, inSidebar } from "../lib/sidebar.mjs";
import { openExtPage } from "../lib/env.mjs";
import { inPage, sleep, waitFor, status } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

// The page's state (tests/sidebar-relay/relay-test.js).
const page = (env) => inSidebar(env.ff, "relayTest.st");
const pageReq = async (env, id) => (await page(env)).reqs[id];
// Frames of a type from the extension, from index `from` of the current link's on.
const sent = (env, from, t) => env.conn().frames.slice(from).filter((f) => f.t === t);
const nextFrame = (env, from, what, pred) => env.conn().next((f) => pred(f), { from, what });

// The sidebar open, its page linked to Kai.
async function sidebarUp(env) {
  await openSidebar(env.ff);
  await waitFor(async () => (await page(env)).link.at(-1) === true, { what: "the sidebar's page told the link is up" });
}

// Sends `req` (the page's id `id`) from the sidebar; the `req` frame Kai got.
async function ask(env, req) {
  const from = env.conn().frames.length;
  await inSidebar(env.ff, `relayTest.send(${JSON.stringify(req)})`);
  return nextFrame(env, from, `the req of the page's ${req.id}`, (f) => f.t === "req" && f.path === req.path);
}

export default [
  {
    name: "sidebar: a request reaches Kai under the link's own id, and the answer comes back under the page's",
    async fn(env) {
      await sidebarUp(env);
      const c = env.conn();
      const r = await ask(env, { id: 1, method: "POST", path: "/chat/api/threads", headers: { "content-type": "application/json" }, body: { text: '{"title":"x"}' } });
      assert.ok(Number.isSafeInteger(r.id) && r.id > 0, `a whole-number id of the link's: ${r.id}`);
      assert.deepEqual(
        { method: r.method, path: r.path, headers: r.headers, body: r.body, read: r.read },
        { method: "POST", path: "/chat/api/threads", headers: { "content-type": "application/json" }, body: { text: '{"title":"x"}' }, read: "whole" },
      );
      const from = c.frames.length;
      c.send({ t: "res", id: r.id, status: 201, headers: { "content-type": "application/json" }, body: "text" });
      c.send({ t: "chunk", id: r.id, seq: 0, data: '{"id":' });
      c.send({ t: "chunk", id: r.id, seq: 1, data: "7}" });
      // The page's acks reach Kai under the link's id (while the request is open: after its end
      // the relay has forgotten it, and Kai has no use for them).
      await nextFrame(env, from, "the ack of both chunks", (f) => f.t === "ack" && f.id === r.id && f.seq === 2);
      assert.ok(sent(env, from, "ack").every((a) => a.id === r.id));
      c.send({ t: "end", id: r.id, seq: 2 });
      await waitFor(async () => (await pageReq(env, 1))?.end, { what: "the page got the end" });
      const got = await pageReq(env, 1);
      assert.deepEqual(got.res, { t: "res", id: 1, status: 201, headers: { "content-type": "application/json" }, body: "text" });
      assert.equal(got.chunks.map((ch) => ch.data).join(""), '{"id":7}');
      assert.deepEqual(got.chunks.map((ch) => [ch.id, ch.seq]), [[1, 0], [1, 1]]);
      assert.deepEqual(got.end, { t: "end", id: 1, seq: 2 });
      // A second request gets another link id, and the same page id may come again once ended.
      const r2 = await ask(env, { id: 1, method: "GET", path: "/v1/models" });
      assert.notEqual(r2.id, r.id);
      assert.deepEqual(r2.headers, {});
      assert.equal(r2.body, null);
      c.send({ t: "res", id: r2.id, status: 200, headers: {}, body: "text" });
      c.send({ t: "end", id: r2.id, seq: 0 });
      await closeSidebar(env.ff);
    },
  },
  {
    name: "sidebar: a stream's acks are the page's, so Kai's window holds until the page takes the chunks; an end with an error reaches it",
    async fn(env) {
      await sidebarUp(env);
      const c = env.conn();
      await inSidebar(env.ff, "relayTest.hold(true)");
      try {
        const r = await ask(env, { id: 2, method: "GET", path: "/chat/api/feed", headers: { "Last-Event-ID": "e1:9:bb" }, read: "stream" });
        assert.deepEqual([r.headers, r.read], [{ "Last-Event-ID": "e1:9:bb" }, "stream"]);
        const from = c.frames.length;
        c.send({ t: "res", id: r.id, status: 200, headers: { "content-type": "text/event-stream" }, body: "text" });
        for (let i = 0; i < 3; i++) c.send({ t: "chunk", id: r.id, seq: i, data: `id: e${i}\ndata: {}\n\n` });
        await waitFor(async () => (await pageReq(env, 2))?.chunks.length === 3, { what: "three chunks in the page" });
        await sleep(500);
        assert.deepEqual(sent(env, from, "ack"), [], "the relay acknowledges nothing itself");
        await inSidebar(env.ff, "relayTest.release()");
        await nextFrame(env, from, "the page's ack", (f) => f.t === "ack" && f.id === r.id && f.seq === 3);
        c.send({ t: "end", id: r.id, seq: 3, error: { code: "lmgw_broke_off", message: "lmgw's answer broke off: reset" } });
        await waitFor(async () => (await pageReq(env, 2))?.end, { what: "the end in the page" });
        assert.deepEqual((await pageReq(env, 2)).end, { t: "end", id: 2, seq: 3, error: { code: "lmgw_broke_off", message: "lmgw's answer broke off: reset" } });
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "sidebar: a whole answer larger than Kai's window completes, since the page acks each piece as it takes it",
    async fn(env) {
      await sidebarUp(env);
      const c = env.conn();
      try {
        const r = await ask(env, { id: 8, method: "GET", path: "/chat/api/attachments/9", read: "whole" });
        assert.equal(r.read, "whole");
        // Kai's window as Kai keeps it (src/browser/sidebar/reply.rs): a piece goes while the
        // pieces' frames not acknowledged, it included, stay within WINDOW, and one piece always
        // goes. Ten pieces of 300 KiB against 1 MiB: the answer is three windows long, so it ends
        // only if the page acks pieces before it has the whole answer.
        const WINDOW = 1024 * 1024;
        const pieces = Array.from({ length: 10 }, (_, i) => String.fromCharCode(65 + i).repeat(300 * 1024));
        c.send({ t: "res", id: r.id, status: 200, headers: { "content-type": "image/png" }, body: "base64" });
        const taken = () => Math.max(0, ...c.frames.filter((f) => f.t === "ack" && f.id === r.id).map((f) => f.seq));
        const out = []; // each sent piece's frame length, by seq
        for (let seq = 0; seq < pieces.length; seq++) {
          const frame = { t: "chunk", id: r.id, seq, data: pieces[seq] };
          const len = JSON.stringify(frame).length;
          const room = () => {
            const acked = Math.min(taken(), seq);
            return acked === seq || out.slice(acked).reduce((a, b) => a + b, 0) + len <= WINDOW;
          };
          if (!room()) await waitFor(room, { what: `the page's acks making room for piece ${seq}` });
          c.send(frame);
          out.push(len);
        }
        c.send({ t: "end", id: r.id, seq: pieces.length });
        await waitFor(async () => (await pageReq(env, 8))?.end, { what: "the whole answer in the page" });
        const got = await inSidebar(env.ff, `(() => { const q = relayTest.st.reqs[8]; return { len: q.chunks.reduce((a, ch) => a + ch.data.length, 0), seqs: q.chunks.map((ch) => ch.seq) }; })()`);
        assert.equal(got.len, 10 * 300 * 1024);
        assert.deepEqual(got.seqs, [...pieces.keys()]);
        assert.deepEqual((await pageReq(env, 8)).end, { t: "end", id: 8, seq: 10 });
        assert.ok(out.reduce((a, b) => a + b, 0) > 2 * WINDOW, "the answer is more than two windows long");
        // Piece 9 went once the page had taken piece 6: before it had the whole answer.
        assert.ok(taken() >= 7, `the page acked the pieces of a whole answer as it took them (${taken()})`);
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "sidebar: Kai's error frame about a request (duplicate_req) ends it at the page, and Kai's request under that id is aborted",
    async fn(env) {
      await sidebarUp(env);
      const c = env.conn();
      try {
        const r = await ask(env, { id: 9, method: "GET", path: "/chat/api/feed", read: "stream" });
        const from = c.frames.length;
        c.send({ t: "error", code: "duplicate_req", id: r.id, message: "a request with this id is open on this link; the second was not sent" });
        await waitFor(async () => (await pageReq(env, 9))?.end, { what: "the end in the page" });
        assert.deepEqual((await pageReq(env, 9)).end, {
          t: "end",
          id: 9,
          error: { code: "duplicate_req", message: "a request with this id is open on this link; the second was not sent" },
        });
        await nextFrame(env, from, "the abort of Kai's request under the id", (f) => f.t === "abort" && f.id === r.id);
        // The relay forgot it: a late frame for it is dropped, and the page's id is free again.
        c.send({ t: "res", id: r.id, status: 200, headers: {}, body: "text" });
        const r2 = await ask(env, { id: 9, method: "GET", path: "/v1/models" });
        assert.notEqual(r2.id, r.id);
        c.send({ t: "res", id: r2.id, status: 200, headers: {}, body: "text" });
        c.send({ t: "end", id: r2.id, seq: 0 });
        await waitFor(async () => (await pageReq(env, 9))?.res?.status === 200, { what: "the second request's head" });
        // Kai's error frames without an id stay the link's.
        c.send({ t: "error", code: "bad_frame", message: "a frame Kai could not read" });
        await waitFor(async () => (await status(env)).last_error?.code === "bad_frame", { what: "the link's last error" });
      } finally {
        await closeSidebar(env.ff);
      }
    },
  },
  {
    name: "sidebar: the page's abort, and closing the sidebar, abort its open requests at Kai",
    async fn(env) {
      await sidebarUp(env);
      const c = env.conn();
      const a = await ask(env, { id: 3, method: "GET", path: "/chat/api/feed", read: "stream" });
      let from = c.frames.length;
      await inSidebar(env.ff, "relayTest.abort(3)");
      await nextFrame(env, from, "the abort", (f) => f.t === "abort" && f.id === a.id);
      // Kai's frames for it that were on their way are dropped.
      c.send({ t: "res", id: a.id, status: 200, headers: {}, body: "text" });
      const b = await ask(env, { id: 4, method: "GET", path: "/chat/api/feed", read: "stream" });
      const d = await ask(env, { id: 5, method: "POST", path: "/chat/api/threads/12/send", headers: { "content-type": "application/json" }, body: { text: "{}" }, read: "stream" });
      c.send({ t: "res", id: b.id, status: 200, headers: {}, body: "text" });
      await waitFor(async () => (await pageReq(env, 4))?.res, { what: "the second feed's head" });
      assert.equal((await pageReq(env, 3))?.res ?? null, null, "nothing of the aborted one");
      from = c.frames.length;
      await closeSidebar(env.ff);
      await nextFrame(env, from, "the feed's abort", (f) => f.t === "abort" && f.id === b.id);
      await nextFrame(env, from, "the send's abort", (f) => f.t === "abort" && f.id === d.id);
    },
  },
  {
    name: "sidebar: only the sidebar page opens the port: the same page in a tab, the options page and a content script are refused and reach nothing",
    async fn(env) {
      const c = env.conn();
      const reqs = () => c.frames.filter((f) => f.t === "req").length;
      const before = reqs();
      // The sidebar's page in a tab: a tab is attached.
      const tab = await openExtPage(env.ff, "sidebar/sidebar.html", { select: false });
      await waitFor(() => env.ff.evalIn(tab, "relayTest.st.disconnected"), { what: "the tab's port closed" });
      const st = await env.ff.evalIn(tab, "relayTest.st");
      assert.match(st.refused ?? "", /only Kai for Firefox's sidebar page/);
      await env.ff.evalIn(tab, `relayTest.send({ id: 1, method: "GET", path: "/v1/models" })`);
      // Another page of the extension: not the sidebar's URL.
      const options = await env.ext(`new Promise((resolve) => {
        const got = [];
        const p = browser.runtime.connect({ name: "kai-sidebar" });
        p.onMessage.addListener((m) => got.push(m));
        p.onDisconnect.addListener(() => resolve(got));
        p.postMessage({ t: "req", id: 1, method: "GET", path: "/v1/models" });
      })`);
      assert.equal(options.length, 1);
      assert.equal(options[0].t, "refused");
      // A content script, in a web page.
      await home(env);
      await inPage(env, `(window.postMessage("kai-sidebar-probe", "*"), 1)`);
      const probe = await waitFor(() => inPage(env, "document.documentElement.dataset.kaiSidebarProbe"), { what: "the probe's port closed" });
      const result = JSON.parse(probe);
      assert.ok(result.disconnected);
      assert.equal(result.messages[0]?.t, "refused");
      await sleep(500);
      assert.equal(reqs(), before, "no req reached Kai");
      await env.ff.send("browsingContext.close", { context: tab });
    },
  },
  {
    name: "sidebar: Kai gone ends the open requests with no_link and refuses new ones at once; the page hears the link come back",
    async fn(env) {
      await sidebarUp(env);
      await ask(env, { id: 6, method: "GET", path: "/chat/api/feed", read: "stream" });
      const linked = env.kai.linked();
      env.conn().close();
      await waitFor(async () => (await pageReq(env, 6))?.end, { what: "the feed's end" });
      assert.equal((await pageReq(env, 6)).end.error.code, "no_link");
      await waitFor(async () => (await page(env)).link.at(-1) === false, { what: "the page told the link went" });
      await inSidebar(env.ff, `relayTest.send({ id: 7, method: "GET", path: "/v1/models" })`);
      await waitFor(async () => (await pageReq(env, 7))?.end, { what: "the refused request's end" });
      assert.deepEqual((await pageReq(env, 7)).end, { t: "end", id: 7, error: { code: "no_link", message: "Kai is not linked" } });
      await linked;
      await waitFor(async () => (await status(env)).link === "linked", { what: "linked again" });
      await waitFor(async () => (await page(env)).link.at(-1) === true, { what: "the page told the link is back" });
      await closeSidebar(env.ff);
    },
  },
];

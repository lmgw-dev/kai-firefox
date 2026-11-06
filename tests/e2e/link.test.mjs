// The link (design §2, §4): hello and welcome, Kai going and coming, a refusal, the host's and
// Kai's error frames, split frames both ways at and over 1 048 576 bytes (the host's own frames
// between Kai's pieces included), cancel, and the helper started again when it ends.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { EXT_DIR, HOST_NAME } from "../lib/env.mjs";
import { LIMIT, kaiSplit } from "../lib/fake-kai.mjs";
import { waitFor, status, toolbar, call, inPage, sleep } from "../lib/util.mjs";

const OPS = [
  "bookmarks.find@1",
  "context.get@1",
  "downloads.list@1",
  "element.check@1",
  "element.choose@1",
  "element.describe@1",
  "element.dom@1",
  "element.drag@1",
  "element.file@1",
  "element.fill@1",
  "element.focus@1",
  "element.hover@1",
  "element.mark@1",
  "element.point@1",
  "element.press@1",
  "element.scroll@1",
  "element.see@1",
  "element.show@1",
  "element.text@1",
  "element.unmark@1",
  "events.config@1",
  "focus.check@1",
  "gate.open@1",
  "gate.result@1",
  "hints.hide@1",
  "hints.show@1",
  "history.find@1",
  "history.seen@1",
  "input.begin@1",
  "input.end@1",
  "page.controls@1",
  "page.css@1",
  "page.css_check@1",
  "page.css_remove@1",
  "page.dom@1",
  "page.fields@1",
  "page.find@1",
  "page.key@1",
  "page.links@1",
  "page.outline@1",
  "page.script@1",
  "page.script_main@1",
  "page.scroll@1",
  "page.see@1",
  "page.selection@1",
  "page.source@1",
  "page.text@1",
  "page.text_all@1",
  "page.text_visible@1",
  "page.zoom@1",
  "pdf.bytes@1",
  "read.close@1",
  "read.mark@1",
  "read.open@1",
  "read.paragraph@1",
  "reader.view@1",
  "table.read@1",
  "tabs.back@1",
  "tabs.close@1",
  "tabs.forward@1",
  "tabs.go@1",
  "tabs.list@1",
  "tabs.mute@1",
  "tabs.open@1",
  "tabs.reload@1",
  "tabs.switch@1",
];
// What the options page test sets retry_ms to; the other tests read the value in force.
const RETRY_MS = 250;
const retryMs = async (env) => (await env.ext(`browser.storage.local.get("retry_ms")`)).retry_ms ?? 2000;

// An op frame of exactly `bytes` bytes of JSON: tabs.list@1 with a `pad` it does not take.
function opOfSize(id, bytes) {
  const empty = JSON.stringify({ t: "op", id, op: "tabs.list@1", args: { pad: "" } });
  return JSON.stringify({ t: "op", id, op: "tabs.list@1", args: { pad: "x".repeat(bytes - Buffer.byteLength(empty)) } });
}

// Closes Kai's side of the link: the host reports Kai gone and connects again after retry_ms.
const dropLink = (env) => env.conn().close();

export default [
  {
    name: "link: the hello says who the extension is, and is the first frame",
    async fn(env) {
      const c = env.conn();
      const h = c.hello;
      const manifest = JSON.parse(readFileSync(join(EXT_DIR, "manifest.json"), "utf8"));
      assert.equal(h.protocol, 1);
      assert.equal(h.ext_version, manifest.version);
      assert.match(h.firefox, /^159\./);
      assert.match(h.profile, /^[0-9a-f-]{36}$/);
      assert.deepEqual([...h.ops].sort(), OPS);
      assert.equal(c.raw[0].t, "hello", "nothing before the hello");
      const s = await status(env);
      assert.equal(s.link, "linked");
      assert.equal(s.kai_version, env.kai.version);
      assert.deepEqual(await toolbar(env), { title: `Kai for Firefox: linked to Kai ${env.kai.version}`, badge: "" });
    },
  },
  {
    name: "link: the options page saves its settings and refuses values that are no whole number of at least 1",
    async fn(env) {
      const KEYS = ["retry_ms", "nav_start_ms", "nav_load_ms", "content_ms"];
      const submit = (values) =>
        env.ext(`(() => {
          const values = ${JSON.stringify(values)};
          for (const k of ${JSON.stringify(KEYS)}) document.getElementById(k).value = values[k];
          document.getElementById("settings").requestSubmit();
          return new Promise((r) => setTimeout(() => r({
            saved: document.getElementById("saved").textContent,
            errors: Object.fromEntries(${JSON.stringify(KEYS)}.map((k) => [k, document.getElementById(k + "-error").hidden ? null : document.getElementById(k + "-error").textContent])),
          }), 200));
        })()`);
      const rule = "Must be a whole number of milliseconds, at least 1.";
      const bad = await submit({ retry_ms: "0", nav_start_ms: "1.5", nav_load_ms: "", content_ms: "-3" });
      assert.equal(bad.saved, "Not saved: see the fields above.");
      assert.deepEqual(bad.errors, { retry_ms: rule, nav_start_ms: rule, nav_load_ms: rule, content_ms: rule });
      assert.deepEqual(await env.ext(`browser.storage.local.get(${JSON.stringify(KEYS)})`), {});
      const good = await submit({ retry_ms: String(RETRY_MS), nav_start_ms: "400", nav_load_ms: "60000", content_ms: "15000" });
      assert.deepEqual(good, { saved: "Saved.", errors: { retry_ms: null, nav_start_ms: null, nav_load_ms: null, content_ms: null } });
      assert.deepEqual(await env.ext(`browser.storage.local.get(${JSON.stringify(KEYS)})`), { retry_ms: RETRY_MS, nav_start_ms: 400, nav_load_ms: 60000, content_ms: 15000 });
    },
  },
  {
    name: "link: Kai gone shows in the toolbar; Kai back links again within retry_ms with the same profile",
    async fn(env) {
      const before = env.conn();
      await env.kai.stop();
      await waitFor(async () => (await status(env)).link === "kai_down", { what: "status kai_down" });
      assert.deepEqual(await toolbar(env), { title: "Kai for Firefox: Kai is not running", badge: "off" });
      const retry = await retryMs(env);
      const t0 = Date.now();
      const next = env.kai.linked({ ms: 4 * retry + 5000 });
      await env.kai.start();
      const c = await next;
      // The host tries every retry_ms; the rest is slack for a busy machine.
      assert.ok(Date.now() - t0 < 2 * retry + 2000, `linked again after ${Date.now() - t0} ms (retry_ms ${retry})`);
      assert.equal(c.hello.profile, before.hello.profile);
      assert.equal(c.raw[0].t, "hello");
      await waitFor(async () => (await status(env)).link === "linked", { what: "status linked" });
      assert.ok((await call(env, "tabs.list@1")).tabs.length >= 1);
    },
  },
  {
    name: "link: until the welcome the extension sends nothing but its hello",
    async fn(env) {
      env.kai.mode = "hold";
      try {
        const next = env.kai.helloed();
        dropLink(env);
        const c = await next;
        c.send({ t: "op", id: 900001, op: "tabs.list@1", args: {} });
        await sleep(600);
        assert.deepEqual(
          c.frames.map((f) => f.t),
          ["hello"],
        );
        assert.notEqual((await status(env)).link, "linked");
        const linked = env.kai.linked();
        env.kai.welcome(c);
        await linked;
        await waitFor(async () => (await status(env)).link === "linked", { what: "status linked" });
        assert.ok((await call(env, "tabs.list@1")).tabs.length >= 1);
        assert.ok(!c.frames.some((f) => f.id === 900001), "the op before the welcome is not answered");
      } finally {
        env.kai.mode = "welcome";
      }
    },
  },
  {
    name: "link: a refusal shows its reason in the toolbar and the options page, and is not retried faster than retry_ms",
    async fn(env) {
      const reason = "update the extension: it speaks protocol 1, this Kai protocol 2";
      env.kai.mode = { refuse: reason };
      const from = env.kai.conns.length;
      try {
        dropLink(env);
        await waitFor(async () => (await status(env)).link === "refused", { what: "status refused" });
        const s = await status(env);
        assert.equal(s.reason, reason);
        assert.deepEqual(await toolbar(env), { title: `Kai for Firefox: Kai refused the link: ${reason}`, badge: "!" });
        const page = await waitFor(
          () => env.ext(`(() => { const s = document.getElementById("state").textContent; return s.includes("refused") && { state: s, details: document.getElementById("details").textContent }; })()`),
          { what: "the options page showing the refusal" },
        );
        assert.equal(page.state, "Kai refused the link.");
        assert.ok(page.details.includes(reason), page.details);
        const retry = await retryMs(env);
        await sleep(6 * retry);
        const refused = env.kai.conns.slice(from).filter((c) => c.hello);
        assert.ok(refused.length >= 2, `${refused.length} refused hellos`);
        for (let i = 1; i < refused.length; i++) {
          const gap = refused[i].t0 - refused[i - 1].t0;
          assert.ok(gap >= retry - 50, `a refused link was retried after ${gap} ms (retry_ms ${retry})`);
        }
        const linked = env.kai.linked();
        env.kai.mode = "welcome";
        await linked;
        await waitFor(async () => (await status(env)).link === "linked", { what: "status linked" });
        assert.equal((await status(env)).reason, null);
      } finally {
        env.kai.mode = "welcome";
      }
    },
  },
  {
    name: "link: after a refusal, Kai going away shows as not running",
    async fn(env) {
      env.kai.mode = { refuse: "update Kai: this Kai speaks protocol 0" };
      try {
        dropLink(env);
        await waitFor(async () => (await status(env)).link === "refused", { what: "status refused" });
        await env.kai.stop();
        const retry = await retryMs(env);
        // Within twice retry_ms and a second of the refused link's end, and slack for a busy machine.
        await waitFor(async () => (await status(env)).link === "kai_down", { ms: 2 * retry + 1000 + 5000, what: "status kai_down after the refusal" });
        assert.equal((await status(env)).reason, null);
        assert.deepEqual(await toolbar(env), { title: "Kai for Firefox: Kai is not running", badge: "off" });
      } finally {
        env.kai.mode = "welcome";
        if (!env.kai.server) {
          const linked = env.kai.linked();
          await env.kai.start();
          await linked;
        }
      }
      await waitFor(async () => (await status(env)).link === "linked", { what: "status linked" });
    },
  },
  {
    name: "link: Kai's frame of exactly 1 048 576 bytes arrives whole; one byte more is the host's frame_too_large and the link stays",
    async fn(env) {
      const c = env.conn();
      const exact = opOfSize(910001, LIMIT);
      assert.equal(Buffer.byteLength(exact), LIMIT);
      c.sendText(exact, { raw: true });
      const r = await c.next((f) => f.t === "op_result" && f.id === 910001, { what: "the answer to the 1 MiB op" });
      assert.equal(r.error.code, "bad_args");
      assert.equal(r.error.message, "tabs.list@1 has no argument 'pad' (it takes none)");
      const over = opOfSize(910002, LIMIT + 1);
      c.sendText(over, { raw: true });
      const e = await waitFor(async () => {
        const s = await status(env);
        return s.last_error?.code === "frame_too_large" && s.last_error;
      }, { what: "the host's frame_too_large in the status" });
      assert.equal(e.size, LIMIT + 1);
      assert.equal(e.limit, LIMIT);
      assert.ok((await call(env, "tabs.list@1")).tabs.length >= 1, "the link is still up");
      assert.ok(!c.frames.some((f) => f.id === 910002));
    },
  },
  {
    name: "link: Kai's split frames are joined (a 2.5 MiB op in pieces)",
    async fn(env) {
      const c = env.conn();
      const pad = 'ä€😀 "quoted" \\ \n'.repeat(Math.ceil((2.5 * 1024 * 1024) / 20));
      const id = env.kai.nextOp;
      const { result } = c.op("tabs.list@1", { pad });
      const r = await result;
      assert.equal(r.id, id);
      assert.equal(r.error.code, "bad_args");
      assert.match(r.error.message, /no argument 'pad'/);
      assert.ok(c.splitsSent >= 1);
    },
  },
  {
    name: "link: a malformed split from Kai is answered with bad_split, and the link goes on",
    async fn(env) {
      const c = env.conn();
      c.writeRaw(JSON.stringify({ t: "chunk", split: 77, seq: 0, data: '{"t":"op",' }));
      c.writeRaw(JSON.stringify({ t: "chunk", split: 77, seq: 2, data: '"id":1}' }));
      c.writeRaw(JSON.stringify({ t: "end", split: 77, seq: 3 }));
      const e = await c.next((f) => f.t === "error" && f.split === 77, { what: "the bad_split error frame" });
      assert.deepEqual(e, { t: "error", code: "bad_split", split: 77, message: "split 77's piece 2 came where piece 1 was due" });
      assert.equal((await status(env)).last_error.code, "bad_split");
      assert.ok((await call(env, "tabs.list@1")).tabs.length >= 1);
    },
  },
  {
    name: "link: the host's own frames between the pieces of Kai's split pass it, and the split joins",
    async fn(env) {
      const c = env.conn();
      const id = 920001;
      const pieces = kaiSplit(opOfSize(id, 2 * LIMIT + 100), 9001);
      assert.ok(pieces.length >= 3);
      c.writeRaw(pieces[0]);
      // The host's frame_too_large, in place of a frame Kai sends whole over the limit.
      c.sendText(opOfSize(920002, LIMIT + 1), { raw: true });
      c.writeRaw(pieces[1]);
      // The host's kai frame, its answer to the config a changed retry_ms sends.
      const retry = await retryMs(env);
      await env.ext(`browser.storage.local.set({ retry_ms: ${retry + 1} })`);
      await sleep(300);
      for (const p of pieces.slice(2)) c.writeRaw(p);
      await env.ext(`browser.storage.local.set({ retry_ms: ${retry} })`);
      const r = await c.next((f) => f.t === "op_result" && f.id === id, { what: "the answer to the split op" });
      assert.equal(r.error.message, "tabs.list@1 has no argument 'pad' (it takes none)");
      assert.ok(!c.frames.some((f) => f.t === "error" && f.split === 9001), "no bad_split");
      assert.equal((await status(env)).last_error.code, "frame_too_large");
    },
  },
  {
    name: "link: a split cut off by Kai going away is dropped without an error",
    async fn(env) {
      const c = env.conn();
      const t0 = Date.now();
      c.writeRaw(kaiSplit(opOfSize(920003, 2 * LIMIT), 9002)[0]);
      await sleep(200);
      const next = env.kai.linked();
      dropLink(env);
      await next;
      await waitFor(async () => (await status(env)).link === "linked", { what: "status linked" });
      const e = (await status(env)).last_error;
      assert.ok(!(e?.code === "bad_split" && e.at >= t0), `the cut-off split was reported: ${JSON.stringify(e)}`);
      assert.ok((await call(env, "tabs.list@1")).tabs.length >= 1);
    },
  },
  {
    name: "link: results over 1 048 576 bytes reach Kai in pieces; one of exactly that size goes whole",
    async fn(env) {
      const c = env.conn();
      // A paragraph of 1 100 000 ASCII letters, its first n selected: context.get's first_line.
      const tab = (await call(env, "tabs.list@1")).user_tab;
      await call(env, "tabs.go@1", { tab, url: env.site.url("long?chars=1100000&ascii") });
      const select = (n) => inPage(env, `(() => { const t = document.getElementById("long").firstChild; getSelection().setBaseAndExtent(t, 0, t, ${n}); return 1; })()`);
      // The op_result's size on the wire for n selected letters.
      const sizeFor = async (n) => {
        await select(n);
        const { id, result } = c.op("context.get@1");
        const r = await result;
        assert.equal(r.ok.selection.length, n);
        const raw = c.raw.filter((x) => x.t === "op_result");
        return { r, id, whole: r._split ? null : raw.at(-1).bytes, split: r._split };
      };
      // Aims n at a frame of `target` bytes (the op id's digits can move it by one; try again).
      const aim = async (target) => {
        let n = 1000000;
        for (let i = 0; i < 4; i++) {
          const got = await sizeFor(n);
          const bytes = got.whole ?? got.split.bytes;
          if (bytes === target) return got;
          n += target - bytes;
        }
        throw new Error(`no selection gave a frame of ${target} bytes`);
      };
      const at = await aim(LIMIT);
      assert.equal(at.whole, LIMIT, "a result of exactly the limit goes whole");
      const over = await aim(LIMIT + 1);
      assert.equal(over.whole, null, "one byte more is split");
      assert.equal(over.split.bytes, LIMIT + 1);
      assert.equal(over.split.pieces, 2);
      assert.ok(over.split.maxPiece <= LIMIT);
      assert.equal(over.r.ok.selection.first_line, "abcdefghij".repeat(110000).slice(0, over.r.ok.selection.length));
      // 3 MB of letters, quotes, backslashes and characters of 2 to 4 bytes.
      await call(env, "tabs.go@1", { tab, url: env.site.url("long?chars=2000000") });
      const text = await inPage(env, `document.getElementById("long").textContent`);
      await select(text.length);
      const big = await c.op("context.get@1").result;
      assert.ok(big._split.pieces >= 3, `${big._split.pieces} pieces`);
      assert.ok(big._split.maxPiece <= LIMIT);
      assert.equal(big.ok.selection.first_line, text.trim());
      assert.deepEqual(c.splitErrors, []);
    },
  },
  {
    name: "link: cancel ends a waiting operation with cancelled",
    async fn(env) {
      const c = env.conn();
      const { id, result } = c.op("tabs.open@1", { url: env.site.url("slow"), active: false });
      await waitFor(() => env.site.slowOpen() === 1, { what: "the slow page requested" });
      const t0 = Date.now();
      c.send({ t: "cancel", id });
      const r = await result;
      assert.equal(r.error.code, "cancelled");
      assert.ok(Date.now() - t0 < 2000);
      env.site.release();
      const list = await call(env, "tabs.list@1");
      const slow = list.tabs.find((t) => t.url.endsWith("/slow"));
      if (slow) await call(env, "tabs.close@1", { tab: slow.id });
    },
  },
  {
    name: "link: an operation running when Kai goes away gets no answer on the next link",
    async fn(env) {
      const c = env.conn();
      c.op("tabs.open@1", { url: env.site.url("slow"), active: false }).result.catch(() => {});
      await waitFor(() => env.site.slowOpen() === 1, { what: "the slow page requested" });
      const next = env.kai.linked();
      dropLink(env);
      const c2 = await next;
      env.site.release();
      await sleep(500);
      assert.ok(!c2.frames.some((f) => f.t === "op_result"), "no stale result on the new link");
      const list = await call(env, "tabs.list@1");
      const slow = list.tabs.find((t) => t.url.endsWith("/slow"));
      if (slow) await call(env, "tabs.close@1", { tab: slow.id });
    },
  },
  {
    name: "link: a helper that ends is started again after retry_ms, the wait doubling while it cannot start",
    async fn(env) {
      const manifest = join(env.ff.paths.home, ".mozilla/native-messaging-hosts", `${HOST_NAME}.json`);
      const profile = env.conn().hello.profile;
      const hosts = env.hosts();
      assert.equal(hosts.length, 1, `one host runs: ${hosts}`);
      await rename(manifest, manifest + ".off");
      let restored = false;
      try {
        process.kill(hosts[0], "SIGKILL");
        const s = await waitFor(
          async () => {
            const s = await status(env);
            return s.link === "no_helper" && s.helper_failures >= 3 && s;
          },
          { what: "three failures to start the helper" },
        );
        assert.match(s.reason, /No such native application dev\.rootshell\.kai/);
        assert.equal((await toolbar(env)).title, `Kai for Firefox: Kai's helper (kai-browser-host) cannot start: ${s.reason}`);
        // The wait before the next try: retry_ms doubled per failure in a row. It is read shortly
        // after the failure, so at least half of it is left.
        const wait = s.helper_retry_at - Date.now();
        const retry = await retryMs(env);
        assert.ok(wait <= retry * 2 ** (s.helper_failures - 1) + 50, `next try in ${wait} ms after ${s.helper_failures} failures`);
        assert.ok(wait >= retry * 2 ** (s.helper_failures - 2), `next try in only ${wait} ms after ${s.helper_failures} failures (retry_ms ${retry})`);
        const linked = env.kai.linked({ ms: 20000 });
        await rename(manifest + ".off", manifest);
        restored = true;
        const c = await linked;
        assert.equal(c.hello.profile, profile);
        assert.equal(env.hosts().length, 1);
        assert.notEqual(env.hosts()[0], hosts[0]);
        await waitFor(async () => (await status(env)).link === "linked", { what: "status linked" });
      } finally {
        if (!restored) await rename(manifest + ".off", manifest);
      }
    },
  },
];

// The commit guard (design §6.4): its page side (the contract's word list in what a target says,
// the submitter and the form's action; a form submit to another origin; an Enter in an editor)
// answers `guard` without acting until Kai sends those verdicts `confirmed`, and looks again right
// before the click; the network gate holds the acted-on document's writes and its GET navigations
// to origins the user never visited within the window and asks Kai with `ask` frames (masked
// bodies and URLs), and Kai's `answer`, its silence, its cancel, the link or the tab decides. The
// trusted path: input spans, focus.check opens the gate, gate.result reads it and the key seen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { call, fails, inPage, waitFor, sleep, press } from "../lib/util.mjs";
import { onPage, refOf, QUIET, GUARD_WORDS } from "./act.test.mjs";

const GUARD = { words: GUARD_WORDS, window_ms: 1000, answer_ms: 15000 };
const MASKED = (n) => `password field, filled (${n} characters)`;
// WebDriver's Enter key.
const ENTER = "\uE007";

// Starts an operation; its id and result promise (the test answers its asks meanwhile).
const start = (env, op, args) => env.conn().op(op, args, { ms: 30000 });
// The next `ask` frame (for operation `op` when given) from now on.
const nextAsk = (env, from, op = null) => env.conn().next((f) => f.t === "ask" && (op === null || f.op === op), { from, what: "an ask frame", ms: 15000 });
const answer = (env, ask, allow) => env.conn().send({ t: "answer", id: ask.id, allow });
const posts = (env, path) => env.site.log.filter((e) => e.method !== "GET" && e.method !== "HEAD" && e.path === path);
const text = (env, id) => inPage(env, `document.getElementById(${JSON.stringify(id)}).textContent`);
// The ref of the control in view named `name`.
async function ctl(env, name) {
  const c = (await call(env, "page.controls@1")).controls.find((x) => x.name === name);
  assert.ok(c, `no control named '${name}' in view`);
  return c.ref;
}

export default [
  {
    name: "commit guard: a word in the name stops a press; confirmed, the form's POST is asked about with its card number masked",
    async fn(env) {
      const user = await onPage(env, "buy.html");
      const buy = await refOf(env, "Buy now");
      const g = await call(env, "element.press@1", { ref: buy, guard: GUARD });
      // Its form's action holds a word too: one question for both.
      assert.deepEqual(g.guard, [
        { reason: "word", word: "buy", where: "name", text: "Buy now" },
        { reason: "word", word: "order", where: "form_action", text: env.site.url("order") },
      ]);
      assert.ok(!("clicked" in g) && !("requests" in g));
      await sleep(300);
      assert.equal(posts(env, "/order").length, 0, "nothing was sent");
      const from = env.conn().frames.length;
      const { id, result } = start(env, "element.press@1", { ref: buy, guard: GUARD, confirmed: g.guard });
      const ask = await nextAsk(env, from, id);
      assert.deepEqual(
        { ...ask, id: 0 },
        {
          t: "ask",
          id: 0,
          op: id,
          gate: ask.gate,
          tab: user,
          frame: 0,
          origin: `http://127.0.0.1:${env.site.port}`,
          method: "POST",
          url: env.site.url("order"),
          type: "main_frame",
          reason: "write",
          body: { kind: "form", fields: [["item", "trail-lamp"], ["buyer", "Ada Example"], ["card", MASKED(19)]] },
        },
      );
      answer(env, ask, true);
      const r = (await result).ok;
      assert.deepEqual(r.requests, [{ method: "POST", url: env.site.url("order"), type: "main_frame", reason: "write", decision: "allowed" }]);
      assert.equal(r.clicked, true);
      assert.equal(r.after, "page_left");
      assert.equal(r.tab.url, env.site.url("order"));
      // Where the press went: the form action's origin.
      assert.deepEqual(r.goes, { by: "submit", origin: `http://127.0.0.1:${env.site.port}` });
      assert.equal(posts(env, "/order").length, 1);
      assert.match(posts(env, "/order")[0].body, /card=4111/, "the server got the real number");
    },
  },
  {
    name: "commit guard: a submit to another origin; a word in a link that acts by script, not in one that loads a page; a button that does not submit presses",
    async fn(env) {
      await onPage(env, "buy.html");
      const c = await call(env, "element.press@1", { ref: await refOf(env, "Continue"), guard: QUIET });
      assert.deepEqual(c.guard, [{ reason: "cross_origin_submit", action: `http://localhost:${env.site.port}/partner`, origin: `http://localhost:${env.site.port}`, method: "post" }]);
      // A link to a fragment of this page or a javascript: URL acts through the page's script:
      // the words apply.
      const r = await call(env, "element.press@1", { ref: await refOf(env, "Remove the lamp"), guard: GUARD });
      assert.deepEqual(r.guard, [{ reason: "word", word: "remove", where: "name", text: "Remove the lamp" }]);
      const o = await call(env, "element.press@1", { ref: await refOf(env, "Cancel the order"), guard: GUARD });
      assert.deepEqual(o.guard, [{ reason: "word", word: "order", where: "name", text: "Cancel the order" }]);
      const n = await call(env, "element.press@1", { ref: await refOf(env, "Add a note"), guard: GUARD });
      assert.deepEqual([n.clicked, n.requests, n.guard], [true, [], undefined]);
      assert.equal(await text(env, "noted"), "note added");
      // Whatever words Kai sends.
      const k = await call(env, "element.press@1", { ref: await refOf(env, "Add a note"), guard: { ...GUARD, words: ["note"] } });
      assert.equal(k.guard[0].word, "note");
      // A link that opens a page in a new window loads it by GET too: no word verdict, it needs the
      // trusted path.
      const h = await call(env, "element.press@1", { ref: await refOf(env, "How to buy"), guard: { ...GUARD, words: ["buy"] } });
      assert.deepEqual([h.guard, h.needs_trusted], [undefined, "new_window"]);
      // The trusted press's link goes to its href's origin.
      assert.deepEqual(h.goes, { by: "link", origin: `http://127.0.0.1:${env.site.port}` });
      // A link that loads another page by GET commits nothing by itself: no word verdict; what
      // that page sends goes through the network gate.
      const d = await call(env, "element.press@1", { ref: await refOf(env, "Delete account"), guard: GUARD });
      assert.deepEqual([d.guard, d.clicked], [undefined, true]);
      assert.equal(d.tab.url, env.site.url("account/close"));
      assert.deepEqual(d.goes, { by: "link", origin: `http://127.0.0.1:${env.site.port}` });
      // A press that goes nowhere says nothing of it.
      assert.ok(!("goes" in n), JSON.stringify(n));
    },
  },
  {
    name: "commit guard: a link that loads a page keeps its words where it may commit by script (a word in its URL, a script marker, a handler the page set on it or an ancestor); one added by addEventListener alone is not seen",
    async fn(env) {
      await onPage(env, "links.html");
      const verdict = async (name) => (await call(env, "element.press@1", { ref: await refOf(env, name), guard: GUARD })).guard;
      // "Cancel order" whose handler calls preventDefault and commits by sendBeacon: its URL holds
      // "order", so the guard asks before anything is sent.
      assert.deepEqual(await verdict("Cancel order"), [{ reason: "word", word: "order", where: "name", text: "Cancel order" }]);
      await sleep(300);
      assert.equal(posts(env, "/api/cancel").length, 0, "no beacon went");
      // Script markers on the link (Turbo's method, htmx, an inline handler, Vue).
      for (const name of ["Delete the lamp", "Remove the bag", "Remove the tent", "Remove the stove"]) {
        const v = await verdict(name);
        assert.equal(v?.[0]?.reason, "word", `${name}: ${JSON.stringify(v)}`);
      }
      // A handler the page set as a property, on the link and on an ancestor.
      assert.deepEqual(await verdict("Remove the plan"), [{ reason: "word", word: "remove", where: "name", text: "Remove the plan" }]);
      assert.deepEqual(await verdict("Remove the strap"), [{ reason: "word", word: "remove", where: "name", text: "Remove the strap" }]);
      // Not yet seen: a listener addEventListener added, on a link whose URL holds no word.
      const quiet = await call(env, "element.press@1", { ref: await refOf(env, "Remove the hook"), guard: GUARD });
      assert.deepEqual([quiet.guard, quiet.clicked], [undefined, true]);
      await waitFor(async () => posts(env, "/api/remove").length === 1, { what: "the beacon the gate does not hold" });
    },
  },
  {
    name: "commit guard: Enter in a form's field reads the form's action; confirmed, Kai declines the POST and it is not sent",
    async fn(env) {
      const user = await onPage(env, "form.html");
      await call(env, "element.fill@1", { ref: await refOf(env, "E-mail"), text: "ada@shop.example", guard: "off" });
      const g = await call(env, "page.key@1", { keys: "Enter", guard: GUARD });
      assert.deepEqual(g.guard, [{ reason: "word", word: "subscribe", where: "form_action", text: env.site.url("subscribe") }]);
      assert.equal(g.target.name, "E-mail");
      const from = env.conn().frames.length;
      const { id, result } = start(env, "page.key@1", { keys: "Enter", guard: GUARD, confirmed: g.guard });
      const ask = await nextAsk(env, from, id);
      assert.deepEqual([ask.method, ask.url, ask.type, ask.body], ["POST", env.site.url("subscribe"), "main_frame", { kind: "form", fields: [["email", "ada@shop.example"]] }]);
      answer(env, ask, false);
      const r = (await result).ok;
      assert.equal(r.emulated, "submit");
      assert.deepEqual(r.requests, [{ method: "POST", url: env.site.url("subscribe"), type: "main_frame", reason: "write", decision: "declined" }]);
      assert.equal(posts(env, "/subscribe").length, 0);
      assert.equal((await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).url, env.site.url("form.html"), "the page stays");
    },
  },
  {
    name: "network gate: a fetch's JSON is asked about with the password masked; allowed it is sent, declined it fails",
    async fn(env) {
      await onPage(env, "post.html");
      const save = await refOf(env, "Save draft");
      const gate = { words: [], window_ms: 1000, answer_ms: 15000 };
      let from = env.conn().frames.length;
      let op = start(env, "element.press@1", { ref: save, guard: gate });
      let ask = await nextAsk(env, from, op.id);
      assert.deepEqual([ask.method, ask.url, ask.type], ["POST", env.site.url("api/draft"), "xmlhttprequest"]);
      assert.deepEqual(ask.body, { kind: "json", text: JSON.stringify({ text: "Three nights in the hills", password: MASKED(16) }) });
      answer(env, ask, true);
      let r = (await op.result).ok;
      assert.deepEqual(r.requests, [{ method: "POST", url: env.site.url("api/draft"), type: "xmlhttprequest", reason: "write", decision: "allowed" }]);
      await waitFor(async () => (await text(env, "status")) === "saved 200", { what: "the save answered" });
      assert.equal(posts(env, "/api/draft").length, 1);
      assert.match(posts(env, "/api/draft")[0].body, /example-secret-9/);
      from = env.conn().frames.length;
      op = start(env, "element.press@1", { ref: save, guard: gate });
      ask = await nextAsk(env, from, op.id);
      answer(env, ask, false);
      r = (await op.result).ok;
      assert.equal(r.requests[0].decision, "declined");
      await waitFor(async () => (await text(env, "status")) === "save failed", { what: "the page saw a network error" });
      assert.equal(posts(env, "/api/draft").length, 1, "the declined one was not sent");
    },
  },
  {
    name: "network gate: no answer within answer_ms cancels; a binary PUT; a beacon (never held, a trade-off against noise), a write after the window and a GET pass unasked",
    async fn(env) {
      await onPage(env, "post.html");
      const t = await call(env, "element.press@1", { ref: await refOf(env, "Save draft"), guard: { words: [], window_ms: 300, answer_ms: 400 } });
      assert.equal(t.requests[0].decision, "timeout");
      await waitFor(async () => (await text(env, "status")) === "save failed", { what: "the page saw a network error" });
      // A beacon is never held (design §6.4: a trade-off against the noise of the pages'
      // telemetry; one a page sends because of Kai's action goes unasked too).
      const asksAtPing = env.conn().frames.filter((f) => f.t === "ask").length;
      const ping = await call(env, "element.press@1", { ref: await refOf(env, "Ping"), guard: QUIET });
      assert.deepEqual(ping.requests, []);
      await waitFor(async () => posts(env, "/api/ping").length === 1, { what: "the beacon, sent unasked" });
      assert.equal(env.conn().frames.filter((f) => f.t === "ask").length, asksAtPing, "no ask for the beacon");
      const from = env.conn().frames.length;
      const op = start(env, "element.press@1", { ref: await refOf(env, "Upload"), guard: QUIET });
      const ask = await nextAsk(env, from, op.id);
      assert.deepEqual([ask.method, ask.body], ["PUT", { kind: "binary", bytes: 5, type: null }]);
      answer(env, ask, true);
      assert.equal((await op.result).ok.requests[0].decision, "allowed");
      await waitFor(async () => (await text(env, "status")) === "uploaded 200", { what: "the upload answered" });
      const asksBefore = env.conn().frames.filter((f) => f.t === "ask").length;
      const later = await call(env, "element.press@1", { ref: await refOf(env, "Save later"), guard: QUIET });
      assert.deepEqual(later.requests, []);
      await waitFor(async () => posts(env, "/api/later").length === 1, { what: "the write after the window, sent unasked" });
      const load = await call(env, "element.press@1", { ref: await refOf(env, "Load"), guard: QUIET });
      assert.deepEqual(load.requests, []);
      assert.equal(env.conn().frames.filter((f) => f.t === "ask").length, asksBefore, "no ask for either");
    },
  },
  {
    name: "network gate: Kai's cancel ends the wait and the held request is cancelled",
    async fn(env) {
      await onPage(env, "post.html");
      const sent = posts(env, "/api/draft").length;
      const from = env.conn().frames.length;
      const op = start(env, "element.press@1", { ref: await refOf(env, "Save draft"), guard: GUARD });
      await nextAsk(env, from, op.id);
      env.conn().send({ t: "cancel", id: op.id });
      const r = await op.result;
      assert.equal(r.error?.code, "cancelled");
      await waitFor(async () => (await text(env, "status")) === "save failed", { what: "the page saw a network error" });
      assert.equal(posts(env, "/api/draft").length, sent);
    },
  },
  {
    name: "trusted path: inside Kai's input span focus.check opens the gate, a trusted key presses, gate.result tells Kai's decision and where the key landed; the key is Kai's, not the user's",
    async fn(env) {
      const user = await onPage(env, "post.html");
      await env.ff.chromeEval(`(gBrowser.selectedBrowser.focus(), 1)`);
      const save = await refOf(env, "Save draft");
      const f = await call(env, "element.press@1", { ref: save, activate: false, guard: GUARD });
      assert.equal(f.focused, true);
      const before = (await call(env, "tabs.list@1")).tabs.find((t) => t.id === user);
      const { span } = await call(env, "input.begin@1");
      const check = await call(env, "focus.check@1", { ref: save, guard: GUARD });
      assert.equal(check.focused, true);
      assert.ok(Number.isSafeInteger(check.gate), JSON.stringify(check));
      const from = env.conn().frames.length;
      // Kai's trusted key; WebDriver's input is trusted too.
      await press(env, ENTER);
      const res = start(env, "gate.result@1", { gate: check.gate });
      const ask = await nextAsk(env, from);
      assert.deepEqual([ask.gate, ask.method, ask.url, ask.reason], [check.gate, "POST", env.site.url("api/draft"), "write"]);
      answer(env, ask, true);
      const r = (await res.result).ok;
      assert.deepEqual(r, {
        gate: check.gate,
        requests: [{ method: "POST", url: env.site.url("api/draft"), type: "xmlhttprequest", reason: "write", decision: "allowed" }],
        key_seen: { key: "Enter", element: { ref: save, role: "button", name: "Save draft" } },
        // The button's activation by the key is a trusted click on it.
        click_seen: { element: { ref: save, role: "button", name: "Save draft" } },
      });
      await fails(env, "gate.result@1", { gate: check.gate }, "unknown_gate");
      assert.deepEqual(await call(env, "input.end@1", { span, settle_ms: 0 }), { span, tabs: [user] });
      await fails(env, "input.end@1", { span, settle_ms: 0 }, "unknown_span");
      const during = (await call(env, "tabs.list@1")).tabs.find((t) => t.id === user);
      assert.deepEqual([during.user_at, during.user_origin], [before.user_at, before.user_origin], "Kai's key is not the user's act");
      assert.ok(during.kai_input_at > (before.kai_input_at ?? 0), JSON.stringify(during));
      // The same trusted input outside a span is the user's.
      await press(env, "\uE008");
      await waitFor(async () => (await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).user_at > (before.user_at ?? 0), { what: "the user's key seen" });
      // Without guard, focus.check opens none; a gate with no key reports key_seen null.
      assert.ok(!("gate" in (await call(env, "focus.check@1", { ref: save }))));
      const quiet = await call(env, "focus.check@1", { ref: save, guard: QUIET });
      assert.deepEqual(await call(env, "gate.result@1", { gate: quiet.gate }), { gate: quiet.gate, requests: [], key_seen: null, click_seen: null });
    },
  },
  {
    name: "trusted path: a kept gate gate.result does not read within answer_ms expires, and says so",
    async fn(env) {
      await onPage(env, "post.html");
      await env.ff.chromeEval(`(gBrowser.selectedBrowser.focus(), 1)`);
      const save = await refOf(env, "Save draft");
      await call(env, "element.focus@1", { ref: save, guard: "off" });
      const t0 = Date.now();
      const check = await call(env, "focus.check@1", { ref: save, guard: { words: [], window_ms: 200, answer_ms: 1500 } });
      await sleep(1700);
      // A write after the expiry is not held: it goes unasked.
      const asks = env.conn().frames.filter((x) => x.t === "ask").length;
      await press(env, ENTER);
      await waitFor(async () => (await text(env, "status")) === "saved 200", { what: "the save sent unasked" });
      const r = await call(env, "gate.result@1", { gate: check.gate });
      assert.equal(r.expired, true);
      assert.ok(r.expired_at >= t0 + 1500 && r.expired_at <= Date.now(), JSON.stringify(r));
      assert.deepEqual([r.requests, r.key_seen, r.click_seen], [[], null, null]);
      assert.equal(env.conn().frames.filter((x) => x.t === "ask").length, asks);
      // One nobody reads is gone answer_ms after it expired.
      const lost = await call(env, "focus.check@1", { ref: save, guard: { words: [], window_ms: 200, answer_ms: 200 } });
      await sleep(700);
      const e = await fails(env, "gate.result@1", { gate: lost.gate }, "unknown_gate");
      assert.match(e.message, /expired/);
    },
  },
  {
    name: "press through accessibility: element.mark sets a fresh kai-mark on the element alone, element.unmark takes it away (a copy too); gate.open on the ref opens a kept gate whose gate.result says the trusted click and the requests",
    async fn(env) {
      const user = await onPage(env, "post.html");
      const save = await refOf(env, "Save draft");
      const marked = () => inPage(env, `[...document.querySelectorAll("[aria-kai-mark]")].map((e) => [e.id, e.getAttribute("aria-kai-mark")])`);
      const m = await call(env, "element.mark@1", { ref: save });
      assert.deepEqual(
        { ...m, value: "", tab: m.tab.id },
        { ref: save, tab: user, role: "button", name: "Save draft", attribute: "aria-kai-mark", object_attribute: "kai-mark", value: "", url: env.site.url("post.html"), frames: [env.site.url("post.html")] },
      );
      assert.match(m.value, /^[0-9a-f]{32}$/);
      assert.deepEqual(await marked(), [["save", m.value]]);
      // A page that copied the mark: both go.
      await inPage(env, `document.getElementById("ping").setAttribute("aria-kai-mark", ${JSON.stringify(m.value)})`);
      assert.deepEqual(await call(env, "element.unmark@1", { value: m.value }), { value: m.value, removed: 2 });
      const again = await call(env, "element.mark@1", { ref: save });
      assert.notEqual(again.value, m.value, "a new value for each mark");
      assert.deepEqual(await call(env, "element.unmark@1", { value: again.value }), { value: again.value, removed: 1 });
      assert.deepEqual(await marked(), []);
      await fails(env, "element.unmark@1", { value: m.value }, "unknown_mark");
      // The gate, inside Kai's input span: a trusted click (WebDriver's, as Kai's doAction is trusted).
      const { span } = await call(env, "input.begin@1");
      const opened = await call(env, "gate.open@1", { ref: save, guard: GUARD });
      assert.deepEqual({ ...opened, tab: opened.tab.id, gate: 0 }, { ref: save, tab: user, gate: 0 });
      const at = await inPage(env, `(() => { const r = document.getElementById("save").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      const from = env.conn().frames.length;
      await env.ff.send("input.performActions", {
        context: env.ff.context,
        actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: Math.round(at[0]), y: Math.round(at[1]) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
      });
      const res = start(env, "gate.result@1", { gate: opened.gate });
      const ask = await nextAsk(env, from);
      assert.deepEqual([ask.gate, ask.method, ask.url], [opened.gate, "POST", env.site.url("api/draft")]);
      answer(env, ask, true);
      const r = (await res.result).ok;
      assert.deepEqual(r, {
        gate: opened.gate,
        requests: [{ method: "POST", url: env.site.url("api/draft"), type: "xmlhttprequest", reason: "write", decision: "allowed" }],
        key_seen: null,
        click_seen: { element: { ref: save, role: "button", name: "Save draft" } },
      });
      await call(env, "input.end@1", { span, settle_ms: 0 });
      // A gate on a tab's top document; a click elsewhere names that element; no guard is no gate.
      const onTab = await call(env, "gate.open@1", { tab: user, guard: QUIET });
      const load = await inPage(env, `(() => { const r = document.getElementById("load").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      await env.ff.send("input.performActions", {
        context: env.ff.context,
        actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: Math.round(load[0]), y: Math.round(load[1]) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
      });
      const loaded = await call(env, "gate.result@1", { gate: onTab.gate });
      assert.deepEqual([loaded.click_seen.element.role, loaded.click_seen.element.name, loaded.requests], ["button", "Load", []]);
      await fails(env, "gate.open@1", { ref: save, guard: "off" }, "bad_args");
      await fails(env, "gate.open@1", { ref: save, tab: user, guard: QUIET }, "bad_args");
      // Two kept gates on one document aimed at a control and at one inside it: one click on the
      // inner names each gate's own element.
      await onPage(env, "nested.html");
      const controls = (await call(env, "page.controls@1")).controls;
      const outer = controls.find((c) => c.name.startsWith("Outer card")).ref;
      const inner = controls.find((c) => c.name === "Inner").ref;
      const go = await call(env, "gate.open@1", { ref: outer, guard: QUIET });
      const gi = await call(env, "gate.open@1", { ref: inner, guard: QUIET });
      const xy = await inPage(env, `(() => { const r = document.getElementById("inner").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      await env.ff.send("input.performActions", {
        context: env.ff.context,
        actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: Math.round(xy[0]), y: Math.round(xy[1]) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
      });
      const ro = await call(env, "gate.result@1", { gate: go.gate });
      const ri = await call(env, "gate.result@1", { gate: gi.gate });
      assert.deepEqual([ro.click_seen.element.ref, ri.click_seen.element.ref], [outer, inner]);
    },
  },
  {
    name: "press through accessibility: a mark in a cross-origin frame names its frames, top page first; a mark goes by itself after MARK_TTL_MS (5000 ms) without element.unmark",
    async fn(env) {
      await onPage(env, "framed.html");
      const port = env.site.port;
      const note = await waitFor(async () => refOf(env, "Save a note"), { what: "the partner frame read" });
      const m = await call(env, "element.mark@1", { ref: note });
      assert.deepEqual([m.role, m.name, m.url, m.frames], ["button", "Save a note", `http://localhost:${port}/frame-inner.html`, [env.site.url("framed.html"), `http://localhost:${port}/frame-inner.html`]]);
      assert.deepEqual([m.frame > 0, m.origin], [true, `http://localhost:${port}`]);
      await call(env, "element.unmark@1", { value: m.value });
      // Left alone, the mark goes by itself.
      await onPage(env, "post.html");
      const save = await refOf(env, "Save draft");
      const left = await call(env, "element.mark@1", { ref: save });
      const marked = () => inPage(env, `document.querySelectorAll("[aria-kai-mark]").length`);
      assert.equal(await marked(), 1);
      await sleep(4000);
      assert.equal(await marked(), 1, "still there before MARK_TTL_MS");
      await waitFor(async () => (await marked()) === 0, { what: "the mark gone after MARK_TTL_MS", ms: 3000 });
      assert.deepEqual(await call(env, "element.unmark@1", { value: left.value }), { value: left.value, removed: 0 });
    },
  },
  {
    name: "commit guard: page code between the guard's look and the click: a button renamed on pointerdown, one replaced, a form action changed; confirmed verdicts must match",
    async fn(env) {
      await onPage(env, "late.html");
      const rename = await ctl(env, "Add to list");
      const r = await call(env, "element.press@1", { ref: rename, guard: GUARD });
      const buy = [{ reason: "word", word: "buy", where: "name", text: "Buy now" }];
      assert.deepEqual([r.clicked, r.guard, r.requests], [false, buy, []]);
      assert.equal(await text(env, "renamed"), "not clicked");
      // A confirmation of another verdict is none of this one.
      const wrong = await call(env, "element.press@1", { ref: rename, guard: GUARD, confirmed: [{ ...buy[0], text: "Buy later" }] });
      assert.deepEqual([wrong.guard, "clicked" in wrong], [buy, false]);
      const ok = await call(env, "element.press@1", { ref: rename, guard: GUARD, confirmed: r.guard });
      assert.deepEqual([ok.clicked, ok.guard], [true, undefined]);
      assert.equal(await text(env, "renamed"), "clicked");
      const s = await call(env, "element.press@1", { ref: await ctl(env, "Save"), guard: GUARD });
      assert.deepEqual([s.clicked, s.stopped, s.after], [false, "removed", "removed"]);
      assert.equal(await text(env, "swapped"), "no click", "the new button was not pressed");
      const k = await call(env, "element.press@1", { ref: await ctl(env, "Keep"), guard: GUARD });
      assert.deepEqual([k.clicked, k.guard], [false, [{ reason: "word", word: "delete", where: "form_action", text: env.site.url("account/delete") }]]);
      await sleep(200);
      assert.equal(posts(env, "/note").length + posts(env, "/account/delete").length, 0, "nothing was submitted");
      // A toggle button's state is `pressed`; `clicked` says the press happened.
      const bold = await call(env, "element.press@1", { ref: await ctl(env, "Bold"), guard: GUARD });
      assert.deepEqual([bold.clicked, bold.pressed], [true, true]);
    },
  },
  {
    name: "commit guard: the contract's words in German labels, behind soft hyphens and full-width letters, in the text under an aria-label, in a title",
    async fn(env) {
      await onPage(env, "late.html");
      const cs = (await call(env, "page.controls@1")).controls;
      const verdict = async (name) => {
        const c = cs.find((x) => x.name.replace(/­/g, "") === name);
        assert.ok(c, `no control named '${name}'`);
        const r = await call(env, "element.press@1", { ref: c.ref, guard: GUARD });
        return r.guard?.[0] ?? null;
      };
      assert.deepEqual(await verdict("Jetzt kaufen"), { reason: "word", word: "kauf", where: "name", text: "Jetzt kaufen" });
      assert.equal((await verdict("Zahlungspflichtig bestellen")).word, "bestell");
      assert.equal((await verdict("Bestellen")).word, "bestell");
      assert.deepEqual(await verdict("Ｂｕｙ"), { reason: "word", word: "buy", where: "name", text: "Ｂｕｙ" });
      assert.deepEqual(await verdict("Close"), { reason: "word", word: "delete", where: "text", text: "Delete everything" });
      assert.deepEqual(await verdict("✕"), { reason: "word", word: "remove", where: "title", text: "Remove item" });
      assert.equal((await verdict("In den Einkaufswagen")).word, "kauf");
      assert.equal((await verdict("Abonnieren")).word, "abo");
      assert.equal(await verdict("Weiter"), null);
    },
  },
  {
    name: "commit guard: Enter in an editor outside a form (enter_in_editor), with modifiers too; a plain Enter in a form's field reads its submit button (submitter)",
    async fn(env) {
      await onPage(env, "late.html");
      await call(env, "element.focus@1", { ref: await ctl(env, "Message"), guard: "off" });
      const e = await call(env, "page.key@1", { keys: "Enter", guard: GUARD });
      assert.deepEqual(e.guard, [{ reason: "enter_in_editor", text: "Message" }]);
      assert.ok(!("prevented" in e));
      const c = await call(env, "page.key@1", { keys: "ctrl+Enter", guard: QUIET });
      assert.deepEqual(c.guard, [{ reason: "enter_in_editor", text: "Message" }]);
      assert.equal(await text(env, "chat"), "nothing sent");
      const sent = await call(env, "page.key@1", { keys: "Enter", guard: GUARD, confirmed: e.guard });
      assert.deepEqual([sent.prevented, sent.guard], [true, undefined]);
      assert.equal(await text(env, "chat"), "sent: ");
      await call(env, "element.focus@1", { ref: await ctl(env, "Gift note"), guard: "off" });
      const s = await call(env, "page.key@1", { keys: "Enter", guard: GUARD });
      assert.deepEqual(s.guard, [{ reason: "word", word: "order", where: "submitter", text: "Place order" }]);
      // Pressed itself, the button's word is in its name.
      const p = await call(env, "element.press@1", { ref: await ctl(env, "Place order"), guard: GUARD });
      assert.deepEqual(p.guard, [{ reason: "word", word: "order", where: "name", text: "Place order" }]);
    },
  },
  {
    name: "network gate: a password the page clears before it sends is masked, in the body and the URL (the question's and requests[]); a busy page's body is withheld and its URL masked",
    async fn(env) {
      await onPage(env, "post.html");
      let from = env.conn().frames.length;
      let op = start(env, "element.press@1", { ref: await refOf(env, "Sign in"), guard: QUIET });
      let ask = await nextAsk(env, from, op.id);
      assert.equal(ask.url, env.site.url("api/login?check=") + MASKED(16));
      assert.deepEqual(ask.body, { kind: "json", text: JSON.stringify({ user: "ada", password: MASKED(16) }) });
      answer(env, ask, true);
      let r = (await op.result).ok;
      assert.deepEqual([r.requests[0].url, r.requests[0].decision], [ask.url, "allowed"]);
      await waitFor(async () => (await text(env, "status")) === "signed in 200", { what: "the sign-in answered" });
      assert.match(posts(env, "/api/login?check=example-secret-9")[0].body, /example-secret-9/, "the server got the password");
      await onPage(env, "post.html");
      await env.ext(`browser.storage.local.set({ content_ms: 1000 }).then(() => 1)`);
      try {
        from = env.conn().frames.length;
        op = start(env, "element.press@1", { ref: await refOf(env, "Save and think"), guard: { words: [], window_ms: 1000, answer_ms: 15000 } });
        ask = await nextAsk(env, from, op.id);
        assert.equal(ask.body.kind, "withheld", JSON.stringify(ask.body));
        assert.match(ask.body.why, /could not mask/);
        assert.equal(ask.url, env.site.url("api/busy?key=") + MASKED(16));
        answer(env, ask, false);
        r = (await op.result).ok;
        assert.deepEqual([r.requests[0].url, r.requests[0].decision], [ask.url, "declined"]);
      } finally {
        await env.ext(`browser.storage.local.remove("content_ms").then(() => 1)`);
      }
    },
  },
  {
    name: "network gate: a POST redirected with 307 is asked about again at its new address; a dedicated worker's fetch is not the document's",
    async fn(env) {
      await onPage(env, "post.html");
      const long = { words: [], window_ms: 1500, answer_ms: 15000 };
      let from = env.conn().frames.length;
      let op = start(env, "element.press@1", { ref: await refOf(env, "Save, moved"), guard: long });
      const a1 = await nextAsk(env, from, op.id);
      assert.deepEqual([a1.method, a1.url, a1.type, a1.body], ["POST", env.site.url("r307?to=/moved-here"), "main_frame", { kind: "form", fields: [["note", "lamp"]] }]);
      answer(env, a1, true);
      const a2 = await env.conn().next((f) => f.t === "ask" && f.op === op.id && f.id !== a1.id, { from, what: "the redirected POST's ask", ms: 15000 });
      assert.deepEqual([a2.method, a2.url, a2.type], ["POST", env.site.url("moved-here"), "main_frame"]);
      answer(env, a2, true);
      const r = (await op.result).ok;
      assert.deepEqual(r.requests.map((x) => [x.url, x.decision]), [[a1.url, "allowed"], [a2.url, "allowed"]]);
      await waitFor(() => posts(env, "/moved-here").length === 1, { what: "the redirected POST arrived" });
      assert.match(posts(env, "/moved-here")[0].body, /note=lamp/);
      await onPage(env, "post.html");
      from = env.conn().frames.length;
      op = start(env, "element.press@1", { ref: await refOf(env, "Save in a worker"), guard: long });
      const w = (await op.result).ok;
      await waitFor(async () => (await text(env, "status")) === "worker saved 200", { what: "the worker's save answered" });
      assert.deepEqual(w.requests, []);
      assert.equal(env.conn().frames.slice(from).filter((f) => f.t === "ask").length, 0, "nobody asked");
    },
  },
  {
    name: "network gate: a question waiting when the link drops is cancelled (no_link); one whose tab closes is decided tab_closed",
    async fn(env) {
      const user = await onPage(env, "post.html");
      const sent = posts(env, "/api/draft").length;
      let from = env.conn().frames.length;
      const op = start(env, "element.press@1", { ref: await refOf(env, "Save draft"), guard: GUARD });
      // Its answer is dropped with the link.
      op.result.catch(() => {});
      await nextAsk(env, from, op.id);
      const next = env.kai.linked();
      env.conn().close();
      await next;
      await waitFor(async () => (await text(env, "status")) === "save failed", { what: "the page saw a network error" });
      assert.equal(posts(env, "/api/draft").length, sent);
      await waitFor(() => readFileSync(env.ff.logFile, "utf8").includes(`from tab ${user} cancelled (no_link)`), { what: "the request logged as no_link" });
      const t = await call(env, "tabs.open@1", { url: env.site.url("post.html") });
      try {
        const save = (await call(env, "page.find@1", { tab: t.tab.id, text: "Save draft" })).matches.map((m) => m.element).find((x) => x?.name === "Save draft").ref;
        from = env.conn().frames.length;
        const op2 = start(env, "element.press@1", { ref: save, guard: GUARD });
        await nextAsk(env, from, op2.id);
        await call(env, "tabs.close@1", { tab: t.tab.id });
        const r = (await op2.result).ok;
        assert.deepEqual([r.requests[0].decision, r.after], ["tab_closed", "page_left"]);
      } finally {
        await call(env, "tabs.close@1", { tab: t.tab.id }).catch(() => {});
      }
    },
  },
  {
    name: "network gate: a link to an origin the user never visited is held (unseen_origin); declined the page stays, allowed the visit is Kai's, not the user's; a same-origin link passes",
    async fn(env) {
      const user = await onPage(env, "post.html");
      const third = `http://127.0.0.3:${env.site.port}`;
      assert.equal((await call(env, "history.seen@1", { url: third })).seen_by_user, false);
      let from = env.conn().frames.length;
      let op = start(env, "element.press@1", { ref: await refOf(env, "Read the guide"), guard: QUIET });
      let ask = await nextAsk(env, from, op.id);
      const guide = `${third}/help.html?draft=Three%20nights%20in%20the%20hills`;
      assert.deepEqual([ask.method, ask.type, ask.reason, ask.body, ask.url, ask.origin], ["GET", "main_frame", "unseen_origin", null, guide, `http://127.0.0.1:${env.site.port}`]);
      answer(env, ask, false);
      let r = (await op.result).ok;
      assert.deepEqual(r.requests, [{ method: "GET", url: guide, type: "main_frame", reason: "unseen_origin", decision: "declined" }]);
      assert.equal((await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).url, env.site.url("post.html"), "the page stays");
      from = env.conn().frames.length;
      op = start(env, "element.press@1", { ref: await refOf(env, "Read the guide"), guard: QUIET });
      ask = await nextAsk(env, from, op.id);
      answer(env, ask, true);
      r = (await op.result).ok;
      assert.equal(r.requests[0].decision, "allowed");
      await waitFor(async () => (await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).url === guide, { what: "the guide loaded" });
      const seen = await waitFor(async () => {
        const x = await call(env, "history.seen@1", { url: third });
        return x.seen && x;
      }, { what: "the guide in the history" });
      assert.deepEqual([seen.seen_by_user, seen.first_visit > 0], [false, true]);
      await onPage(env, "post.html");
      const asks = env.conn().frames.filter((f) => f.t === "ask").length;
      const h = await call(env, "element.press@1", { ref: await refOf(env, "Help"), guard: QUIET });
      assert.deepEqual(h.requests, []);
      assert.equal(env.conn().frames.filter((f) => f.t === "ask").length, asks);
    },
  },
  {
    name: "network gate: a form posting into a frame of the document (parentDocumentId); acting in a cross-origin frame (its fetch); a frame's form that targets the top document (originUrl)",
    async fn(env) {
      await onPage(env, "framed.html");
      const long = { words: [], window_ms: 1000, answer_ms: 15000 };
      const port = env.site.port;
      let from = env.conn().frames.length;
      let op = start(env, "element.press@1", { ref: await refOf(env, "Post into the frame"), guard: long });
      let ask = await nextAsk(env, from, op.id);
      assert.deepEqual([ask.method, ask.type, ask.url, ask.frame > 0], ["POST", "sub_frame", env.site.url("framed"), true]);
      answer(env, ask, true);
      let r = (await op.result).ok;
      assert.deepEqual([r.requests[0].frame, r.requests[0].decision], [ask.frame, "allowed"]);
      const note = await waitFor(async () => refOf(env, "Save a note"), { what: "the partner frame read" });
      from = env.conn().frames.length;
      op = start(env, "element.press@1", { ref: note, guard: long });
      ask = await nextAsk(env, from, op.id);
      assert.deepEqual([ask.origin, ask.url, ask.type, ask.body], [`http://localhost:${port}`, `http://localhost:${port}/api/note`, "xmlhttprequest", { kind: "text", text: "lamp" }]);
      answer(env, ask, true);
      r = (await op.result).ok;
      assert.deepEqual([r.origin, r.frame, "frame" in r.requests[0]], [`http://localhost:${port}`, ask.frame, false]);
      // A form of a frame that targets the top document: its navigation was started by the frame's
      // document (originUrl). Firefox lets only a same-origin frame do that without a gesture.
      from = env.conn().frames.length;
      op = start(env, "element.press@1", { ref: await refOf(env, "Post up from the frame"), guard: long });
      ask = await nextAsk(env, from, op.id);
      assert.deepEqual([ask.method, ask.type, ask.frame, ask.url], ["POST", "main_frame", 0, env.site.url("from-frame")]);
      answer(env, ask, false);
      r = (await op.result).ok;
      assert.ok(r.frame > 0, JSON.stringify(r));
      assert.deepEqual([r.requests[0].frame, r.requests[0].decision], [0, "declined"]);
      assert.equal(posts(env, "/from-frame").length, 0);
    },
  },
  {
    name: "focus.check: a tab not shown, another window",
    async fn(env) {
      await onPage(env, "form.html");
      const bg = await call(env, "tabs.open@1", { url: env.site.url("form.html"), active: false });
      try {
        const name = (await call(env, "page.fields@1", { tab: bg.tab.id })).fields.find((x) => x.name === "Full name").ref;
        assert.deepEqual(await call(env, "focus.check@1", { ref: name }), { ref: name, tab: { id: bg.tab.id, title: bg.tab.title, url: bg.tab.url }, focused: false, focus: "other_tab" });
        const user = (await call(env, "tabs.list@1")).user_tab;
        const mine = (await call(env, "page.fields@1", { tab: user })).fields.find((x) => x.name === "Full name").ref;
        const w = await env.ext(`browser.windows.create({ url: "about:blank" }).then((w) => w.id)`);
        try {
          await waitFor(async () => (await env.ext(`browser.windows.get(${w}).then((x) => x.focused)`)) === true, { what: "the new window focused" });
          const other = await call(env, "focus.check@1", { ref: mine });
          assert.deepEqual([other.focused, other.focus], [false, "other_window"]);
          const list = await call(env, "tabs.list@1");
          assert.deepEqual(list.windows.filter((x) => x.focused).map((x) => x.id), [w]);
        } finally {
          await env.ext(`browser.windows.remove(${w}).then(() => 1)`);
        }
      } finally {
        await call(env, "tabs.close@1", { tab: bg.tab.id });
      }
    },
  },
];

// Events (design §7.1): Kai turns them on and off (events.config@1); while on, the user's tab
// reports its loads and navigations, live regions (coalesced over quiet_ms), field errors,
// modal dialogs, the tabs its pages open, finished downloads and the focus, each with its frame
// and origin, numbered in order; nothing while off, nothing from another tab. A negative ("this
// said nothing") is checked against a positive control in the same test: a change after it that
// is reported, before which nothing came.
import assert from "node:assert/strict";
import { call, fails, inPage, frameContext, sleep, siteOrigin, waitFor } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";
import { QUIET as GUARD } from "./act.test.mjs";

const QUIET = 400;
const on = (env, quiet_ms = QUIET) => call(env, "events.config@1", { on: true, quiet_ms });
const off = (env) => call(env, "events.config@1", { on: false });
// Where the frames of the link are now: events after it are the test's.
const mark = (env) => env.conn().frames.length;
const since = (env, from) => env.conn().frames.slice(from).filter((f) => f.t === "event");
const next = (env, from, what, pred, ms = 10000) => env.conn().next((f) => f.t === "event" && pred(f), { from, what, ms });
const liveWith = (env, from, words) => next(env, from, `a live event with '${words}'`, (f) => f.kind === "live" && f.text.includes(words));
// The events since `from` that came before `e` (the positive control) and match pred.
const before = (env, from, e, pred = () => true) => since(env, from).filter((f) => f.seq < e.seq && pred(f));
const set = (id, js) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); ${js}; return 1; })()`;
const text = (id, t) => set(id, `el.textContent = ${JSON.stringify(t)}`);

// The user's tab on events.html, its frames loaded, events on.
async function onEvents(env, quiet_ms = QUIET) {
  const user = await home(env);
  await call(env, "tabs.go@1", { tab: user, url: env.site.url("events.html") });
  await frameContext(env, "events-frame.html");
  await inPage(env, "(scrollTo(0, 0), 1)");
  await on(env, quiet_ms);
  return user;
}
// Changes something with `change` (given a round number) until an event matching pred comes:
// for a frame that begins to watch a moment after the call that made it the user's.
async function untilEvent(env, what, change, pred) {
  const from = mark(env);
  let round = 0;
  return waitFor(
    async () => {
      const hit = since(env, from).find(pred);
      if (hit) return hit;
      await change(++round);
      await sleep(QUIET + 300);
      return since(env, from).find(pred);
    },
    { what, every: 1 },
  );
}

export default [
  {
    name: "events.config: off by default, nothing sent; on watches the user's tab; off stops; quiet_ms required with on",
    async fn(env) {
      await off(env);
      const user = await home(env);
      const from = mark(env);
      await call(env, "tabs.go@1", { tab: user, url: env.site.url("events.html") });
      await inPage(env, text("alert", "Card declined."));
      await inPage(env, `(document.getElementById("terms").showModal(), document.getElementById("terms").close(), 1)`);
      await fails(env, "events.config@1", { on: true }, "bad_args");
      await fails(env, "events.config@1", { on: true, quiet_ms: -1 }, "bad_args");
      assert.deepEqual(await on(env), { on: true, quiet_ms: QUIET, tab: user });
      await inPage(env, text("alert", "Payment failed: card declined."));
      const e = await liveWith(env, from, "Payment failed");
      assert.deepEqual(before(env, from, e), [], "nothing while off");
      assert.equal(e.tab, user);
      assert.equal(e.url, env.site.url("events.html"));
      assert.equal(e.title, "Your account: Northwind Gear");
      assert.equal(e.frame, 0);
      assert.equal(e.origin, siteOrigin(env));
      assert.equal(typeof e.focused, "boolean");
      assert.equal(e.by_kai, false);
      assert.ok(Number.isSafeInteger(e.at) && Number.isSafeInteger(e.seq));
      assert.deepEqual(await off(env), { on: false, quiet_ms: null, tab: null });
      const f3 = mark(env);
      await inPage(env, text("alert", "Try another card."));
      await call(env, "tabs.reload@1", { tab: user });
      await on(env);
      await inPage(env, text("alert", "Card accepted."));
      const back = await liveWith(env, f3, "Card accepted");
      assert.deepEqual(before(env, f3, back), [], "nothing after off");
      await off(env);
    },
  },
  {
    name: "events: a new link starts with events off; Kai turns them on again",
    async fn(env) {
      const user = await onEvents(env);
      const linked = env.kai.linked();
      env.conn().close();
      await linked;
      const from = mark(env);
      await inPage(env, text("alert", "Sent while Kai was away."));
      assert.deepEqual((await on(env)).tab, user);
      await inPage(env, text("alert", "Kai is back."));
      const e = await liveWith(env, from, "Kai is back");
      assert.deepEqual(before(env, from, e), [], "the new link began with events off");
      assert.equal(e.seq, 1, "seq begins again with the link");
      await off(env);
    },
  },
  {
    name: "events: navigated (a load, a pushState, a fragment) before loaded, in seq order; a history call that keeps the URL says nothing",
    async fn(env) {
      const user = await onEvents(env);
      try {
        const from = mark(env);
        await call(env, "tabs.go@1", { tab: user, url: env.site.url("help.html") });
        const nav = await next(env, from, "navigated", (f) => f.kind === "navigated" && f.url.endsWith("/help.html"));
        assert.equal(nav.same_document, false);
        assert.equal(nav.frame, 0);
        assert.equal(nav.origin, siteOrigin(env));
        assert.equal(nav.by_kai, true, "Kai's tabs.go");
        const loaded = await next(env, from, "loaded", (f) => f.kind === "loaded" && f.url.endsWith("/help.html"));
        assert.ok(loaded.title.length > 0, JSON.stringify(loaded));
        assert.equal(loaded.by_kai, true);
        assert.ok(nav.seq < loaded.seq, "navigated comes before loaded");
        const f2 = mark(env);
        await inPage(env, `(history.pushState(null, "", "?step=2"), 1)`);
        const same = await next(env, f2, "a same-document navigation", (f) => f.kind === "navigated" && f.url.endsWith("?step=2"));
        assert.deepEqual([same.same_document, same.by_kai], [true, false]);
        // The same URL again, by replaceState and by pushState: nothing; a fragment: navigated.
        const f3 = mark(env);
        await inPage(env, `(history.replaceState(null, "", location.href), history.pushState(null, "", location.href), 1)`);
        await inPage(env, `(location.hash = "#top", 1)`);
        const frag = await next(env, f3, "the fragment", (f) => f.kind === "navigated" && f.url.endsWith("#top"));
        assert.deepEqual(before(env, f3, frag), [], "a history call that keeps the URL said nothing");
        assert.ok(!since(env, f2).some((f) => f.kind === "loaded"), "a same-document navigation loads nothing");
        const all = since(env, from);
        assert.deepEqual(
          all.map((f) => f.seq),
          all.map((_, i) => all[0].seq + i),
          "seq rises by one with each event, in the order they came",
        );
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: live regions: a countdown coalesced to its latest text, a log's additions, a status shown, an alert inserted; a class change alone is not",
    async fn(env) {
      await onEvents(env, 1500);
      try {
        let from = mark(env);
        const last = await inPage(env, "window.countdown(10, 30)");
        const e = await liveWith(env, from, "Your session expires");
        assert.equal(e.text, `Your session expires in ${last} seconds.`, "the latest text only");
        assert.equal(e.politeness, "polite");
        assert.equal(e.atomic, true);
        assert.equal(e.region.role, "generic");
        assert.ok(Number.isSafeInteger(e.region.ref));

        from = mark(env);
        await inPage(env, `(() => { const log = document.getElementById("log"); for (const t of ["Order shipped.", "Invoice ready."]) { const li = document.createElement("li"); li.textContent = t; log.append(li); } return 1; })()`);
        const l = await liveWith(env, from, "Order shipped");
        assert.equal(l.text, "Order shipped.\nInvoice ready.", "the additions, not the whole log");
        assert.deepEqual([l.politeness, l.atomic, l.region.role, l.region.name], ["polite", false, "log", "Messages"]);
        assert.deepEqual(before(env, from, l, (f) => f.kind === "live"), [], "one event for ten countdown changes, then the log's");

        from = mark(env);
        await inPage(env, set("saved", "el.hidden = false"));
        const s = await liveWith(env, from, "saved");
        assert.deepEqual([s.text, s.politeness, s.atomic, s.region.role], ["Your changes are saved.", "polite", true, "status"]);

        from = mark(env);
        await inPage(env, set("saved", `el.classList.add("faded")`));
        await inPage(env, `(() => { const a = document.createElement("div"); a.setAttribute("role", "alert"); a.textContent = "Your card expires this month."; document.body.append(a); return 1; })()`);
        const a = await liveWith(env, from, "card expires");
        assert.deepEqual([a.politeness, a.atomic, a.region.role], ["assertive", true, "alert"]);
        // The status's class change settles in the same tick as the alert or before it.
        await inPage(env, text("saved", "Saved again."));
        const again = await liveWith(env, from, "Saved again");
        assert.deepEqual(
          before(env, from, again, (f) => f.kind === "live").map((f) => f.text),
          ["Your card expires this month."],
          "the class change on the status said nothing",
        );
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: a live event names its region: its own name, an <output>'s controls, a labelled ancestor; none without one",
    async fn(env) {
      await onEvents(env);
      try {
        let from = mark(env);
        await inPage(env, `(() => { const li = document.createElement("li"); li.textContent = "A named entry."; document.getElementById("log").append(li); return 1; })()`);
        const own = await liveWith(env, from, "A named entry");
        assert.deepEqual([own.name, own.name_from], ["Messages", "region"]);

        // A slider's <output>: the slider's name, not a bare "3".
        from = mark(env);
        await inPage(env, set("tip-out", `el.value = "3"`));
        const out = await next(env, from, "the output's event", (f) => f.kind === "live" && f.text === "3");
        assert.deepEqual([out.region.role, out.region.name, out.name, out.name_from], ["status", "", "Tip", "for"]);

        from = mark(env);
        await inPage(env, text("tip-note", "Thank you for the tip."));
        const box = await liveWith(env, from, "Thank you for the tip");
        assert.deepEqual([box.region.name, box.name, box.name_from], ["", "Courier tip", "ancestor"]);

        from = mark(env);
        await inPage(env, text("countdown", "Your session expires in 5 seconds."));
        const none = await liveWith(env, from, "5 seconds");
        assert.ok(!("name" in none) && !("name_from" in none), JSON.stringify(none));
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: a log's attribute changes report only what they showed; churn does not put off a pending addition",
    async fn(env) {
      await onEvents(env);
      try {
        let from = mark(env);
        // An old entry re-styled and a hidden one shown: only the one shown is said.
        await inPage(env, `(document.getElementById("feed-first").classList.remove("new"), document.getElementById("feed-later").hidden = false, 1)`);
        const shown = await liveWith(env, from, "parcel");
        assert.equal(shown.text, "Your parcel arrived.");
        assert.deepEqual([shown.region.name, shown.atomic], ["Feed", false]);

        from = mark(env);
        await inPage(
          env,
          `(() => { const li = document.createElement("li"); li.innerHTML = 'New message <span aria-hidden="true">(bell)</span>'; document.getElementById("feed").append(li); window.churning = true; window.churn(${8 * QUIET}, 50).then(() => (window.churning = false)); return 1; })()`,
        );
        const added = await liveWith(env, from, "New message");
        assert.equal(added.text, "New message", "aria-hidden text says nothing, and the re-styled entry is not said again");
        assert.equal(await inPage(env, "window.churning"), true, "the addition was said while the class still changed");
        await waitFor(() => inPage(env, "!window.churning"), { what: "the churn to end" });
        await inPage(env, `(() => { const li = document.createElement("li"); li.textContent = "Last message."; document.getElementById("feed").append(li); return 1; })()`);
        const lastOne = await liveWith(env, from, "Last message");
        assert.deepEqual(
          before(env, from, lastOne, (f) => f.kind === "live").map((f) => f.text),
          ["New message"],
          "the churn said nothing",
        );
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: a region made later by aria-live or role=alert speaks its first change; aria-busy holds; aria-relevant=additions ignores text changes",
    async fn(env) {
      await onEvents(env);
      try {
        let from = mark(env);
        await inPage(env, set("plain-box", `el.setAttribute("aria-live", "polite")`));
        await inPage(env, text("plain-box", "Now it speaks."));
        const made = await liveWith(env, from, "Now it speaks");
        assert.deepEqual([made.politeness, made.atomic], ["polite", false]);
        from = mark(env);
        await inPage(env, set("email-hint", `el.setAttribute("role", "alert")`));
        const alert = await next(env, from, "the element that became an alert", (f) => f.kind === "live" && f.region.role === "alert" && f.text === "We send receipts here.");
        assert.equal(alert.politeness, "assertive");

        from = mark(env);
        await inPage(env, set("busy", `el.setAttribute("aria-busy", "true"); el.textContent = "Prices as of noon."`));
        await inPage(env, text("alert", "A control while busy."));
        const control = await liveWith(env, from, "A control while busy");
        assert.deepEqual(before(env, from, control, (f) => f.kind === "live"), [], "a busy region waits");
        await inPage(env, set("busy", `el.setAttribute("aria-busy", "false")`));
        const released = await liveWith(env, from, "Prices as of noon");
        assert.equal(released.text, "Prices as of noon.");

        from = mark(env);
        await inPage(env, text("adds-first", "First entry, edited."));
        await inPage(env, `(() => { const p = document.createElement("p"); p.textContent = "Second entry."; document.getElementById("adds").append(p); return 1; })()`);
        const add = await liveWith(env, from, "Second entry");
        assert.equal(add.text, "Second entry.");
        assert.deepEqual(before(env, from, add, (f) => f.kind === "live"), [], "a text change in an additions-only region says nothing");
      } finally {
        await inPage(env, set("email-hint", `el.removeAttribute("role")`));
        await off(env);
      }
    },
  },
  {
    name: "events: field_error for a field turning aria-invalid with its error text, for the browser's own check, never with a sensitive value",
    async fn(env) {
      await onEvents(env);
      try {
        let from = mark(env);
        await inPage(
          env,
          `(() => { const e = document.getElementById("email-error"); e.textContent = "Enter an address like ada@shop.example."; e.hidden = false; document.getElementById("email").setAttribute("aria-invalid", "true"); return 1; })()`,
        );
        const f = await next(env, from, "the e-mail field's error", (x) => x.kind === "field_error" && x.field.name === "E-mail");
        assert.equal(f.field.role, "textbox");
        assert.ok(Number.isSafeInteger(f.field.ref));
        assert.equal(f.error, "Enter an address like ada@shop.example.");
        assert.equal(f.description, "We send receipts here.");
        assert.deepEqual(f.regions, []);
        assert.equal(f.frame, 0);
        // The same ref as page.fields gives the field.
        const fields = await call(env, "page.fields@1");
        assert.equal(fields.fields.find((x) => x.name === "E-mail").ref, f.field.ref);

        from = mark(env);
        await inPage(env, `(document.getElementById("pw-error").textContent = "hunter2-example is too common.", document.getElementById("pw").setAttribute("aria-invalid", "true"), 1)`);
        const p = await next(env, from, "the password field's error", (x) => x.kind === "field_error" && x.field.name === "Password");
        assert.equal(p.error, "password field, filled (15 characters) is too common.");
        assert.ok(!JSON.stringify(since(env, from)).includes("hunter2"), "the value is in no event");

        from = mark(env);
        await inPage(env, `(document.getElementById("zip").value = "12", document.getElementById("profile").requestSubmit(), 1)`);
        const z = await next(env, from, "the postcode's error", (x) => x.kind === "field_error" && x.field.name === "Postcode");
        assert.ok(z.error && z.error.length > 0, JSON.stringify(z));
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: an error that is itself a live region comes as field_error with that region's ref, before the region's own event and with the same at",
    async fn(env) {
      await onEvents(env);
      try {
        const from = mark(env);
        await inPage(env, `(document.getElementById("code-error").textContent = "This code expired.", document.getElementById("code").setAttribute("aria-invalid", "true"), 1)`);
        const live = await liveWith(env, from, "This code expired");
        const fe = since(env, from).find((x) => x.kind === "field_error" && x.field.name === "Promo code");
        assert.ok(fe, "the field_error came too");
        assert.equal(fe.error, "This code expired.");
        assert.deepEqual(
          fe.regions.map((r) => [r.ref, r.role]),
          [[live.region.ref, "alert"]],
        );
        assert.ok(fe.seq < live.seq && fe.at === live.at, `one batch, the field_error first: ${fe.seq}/${fe.at} and ${live.seq}/${live.at}`);
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: sensitive values are masked in live text and names, also with other white space and after 'show password'",
    async fn(env) {
      await onEvents(env);
      try {
        let from = mark(env);
        await inPage(env, set("alert", `el.setAttribute("aria-label", "About correct horse battery staple"); el.textContent = "The phrase correct horse\\n battery staple is weak."`));
        const e = await liveWith(env, from, "is weak");
        assert.equal(e.text, "The phrase password field, filled (29 characters) is weak.");
        assert.equal(e.region.name, "About password field, filled (29 characters)");
        // "Show" makes it a text field: it stays sensitive.
        await inPage(env, `(document.getElementById("show-phrase").click(), 1)`);
        assert.equal(await inPage(env, `document.getElementById("phrase").type`), "text");
        from = mark(env);
        await inPage(env, text("alert", "Shown: correct horse  battery staple."));
        const shown = await liveWith(env, from, "Shown:");
        assert.equal(shown.text, "Shown: password field, filled (29 characters).");
        const field = (await call(env, "page.fields@1")).fields.find((x) => x.name === "Recovery phrase");
        assert.equal(field.masked, true, JSON.stringify(field));
        assert.ok(!JSON.stringify(env.conn().frames.slice(from)).includes("horse"), "the phrase is in no frame");
      } finally {
        await inPage(env, set("alert", `el.removeAttribute("aria-label")`));
        await off(env);
      }
    },
  },
  {
    name: "events: dialog opened and closed, a <dialog> shown modally and an aria-modal one, with its name",
    async fn(env) {
      await onEvents(env);
      try {
        let from = mark(env);
        await inPage(env, `(document.getElementById("terms").showModal(), 1)`);
        const o = await next(env, from, "the dialog opening", (f) => f.kind === "dialog" && f.open);
        assert.deepEqual([o.dialog.role, o.dialog.name], ["dialog", "Terms of sale"]);
        await inPage(env, `(document.getElementById("terms").close(), 1)`);
        const c = await next(env, from, "the dialog closing", (f) => f.kind === "dialog" && !f.open);
        assert.deepEqual(c.dialog, o.dialog, "the same element and ref");
        from = mark(env);
        await inPage(env, set("cookie", "el.hidden = false"));
        const ao = await next(env, from, "the aria-modal dialog opening", (f) => f.kind === "dialog" && f.open);
        assert.equal(ao.dialog.name, "Cookie settings");
        await inPage(env, set("cookie", "el.hidden = true"));
        const ac = await next(env, from, "the aria-modal dialog closing", (f) => f.kind === "dialog" && !f.open);
        assert.equal(ac.dialog.ref, ao.dialog.ref);
        assert.equal(since(env, from).filter((f) => f.kind === "dialog" && f.seq <= ac.seq).length, 2);
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: nested modals, a visibility-hidden one, one closed by aria-hidden (a11y-dialog), a role among other tokens, one in a closed shadow root",
    async fn(env) {
      await onEvents(env);
      const dialogs = (from, until) =>
        since(env, from)
          .filter((f) => f.kind === "dialog" && f.seq <= until.seq)
          .map((f) => `${f.open ? "open" : "close"} ${f.dialog.name}`);
      try {
        let from = mark(env);
        await inPage(env, `(document.getElementById("outer").showModal(), 1)`);
        await next(env, from, "the outer dialog", (f) => f.kind === "dialog" && f.open);
        await inPage(env, set("inner", "el.hidden = false"));
        await next(env, from, "the inner dialog", (f) => f.kind === "dialog" && f.open && f.dialog.name === "Confirm removal");
        await inPage(env, set("inner", "el.hidden = true"));
        await next(env, from, "the inner dialog closing", (f) => f.kind === "dialog" && !f.open);
        await inPage(env, `(document.getElementById("outer").close(), 1)`);
        const last = await next(env, from, "the outer dialog closing", (f) => f.kind === "dialog" && !f.open && f.dialog.name === "Order details");
        assert.deepEqual(dialogs(from, last), ["open Order details", "open Confirm removal", "close Confirm removal", "close Order details"]);

        from = mark(env);
        await inPage(env, set("ghost", `el.classList.add("checked")`));
        await inPage(env, set("ghost", `el.style.visibility = "visible"`));
        const ghost = await next(env, from, "the ghost panel", (f) => f.kind === "dialog" && f.open);
        assert.deepEqual(dialogs(from, ghost), ["open Ghost panel"], "hidden by visibility it was not open");
        await inPage(env, set("ghost", `el.style.visibility = "hidden"`));
        await next(env, from, "the ghost panel closing", (f) => f.kind === "dialog" && !f.open);

        from = mark(env);
        await inPage(env, set("sheet-box", `el.removeAttribute("aria-hidden")`));
        const sheet = await next(env, from, "the sheet", (f) => f.kind === "dialog" && f.open);
        assert.deepEqual([sheet.dialog.role, sheet.dialog.name], ["alertdialog", "Leave the page?"]);
        await inPage(env, set("sheet-box", `el.setAttribute("aria-hidden", "true")`));
        const shut = await next(env, from, "the sheet closing by aria-hidden", (f) => f.kind === "dialog" && !f.open);
        assert.equal(shut.dialog.ref, sheet.dialog.ref);

        from = mark(env);
        await inPage(env, "(window.chatDialog(true), 1)");
        const chat = await next(env, from, "the chat dialog in the shadow root", (f) => f.kind === "dialog" && f.open);
        assert.equal(chat.dialog.name, "Chat with us");
        await inPage(env, "(window.chatDialog(false), 1)");
        await next(env, from, "the chat dialog closing", (f) => f.kind === "dialog" && !f.open);
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: focus moving in the page, with role and name",
    async fn(env) {
      await onEvents(env);
      try {
        // Headless Firefox gives the page the keyboard focus only when asked to, as a user's
        // click into it would; without it, focus() fires no focus events.
        await env.ff.chromeEval(`(gBrowser.selectedBrowser.focus(), 1)`);
        const from = mark(env);
        await inPage(env, `(document.getElementById("email").focus(), 1)`);
        const f = await next(env, from, "the focus event", (x) => x.kind === "focus");
        assert.deepEqual([f.element.role, f.element.name, f.by_kai], ["textbox", "E-mail", false]);
        assert.ok(Number.isSafeInteger(f.element.ref));
      } finally {
        await inPage(env, `(document.activeElement.blur(), 1)`);
        await off(env);
      }
    },
  },
  {
    name: "events: floods coalesce: a focus loop says its last focus, open and close in one task say nothing, a toggling dialog alternates and ends closed",
    async fn(env) {
      await onEvents(env);
      try {
        await env.ff.chromeEval(`(gBrowser.selectedBrowser.focus(), 1)`);
        let from = mark(env);
        assert.equal(await inPage(env, "window.focusLoop(200)"), "spot-b");
        await next(env, from, "the loop's focus", (f) => f.kind === "focus");
        await inPage(env, `(document.getElementById("email").focus(), 1)`);
        const control = await next(env, from, "the focus after the loop", (f) => f.kind === "focus" && f.element.name === "E-mail");
        assert.deepEqual(
          before(env, from, control).map((f) => `${f.kind} ${f.element?.name}`),
          ["focus Second spot"],
          "400 focus moves in one task: one event, the last",
        );

        from = mark(env);
        await inPage(env, `(() => { const d = document.getElementById("terms"); for (let i = 0; i < 20; i++) { d.showModal(); d.close(); } return 1; })()`);
        await inPage(env, set("cookie", "el.hidden = false"));
        const opened = await next(env, from, "the cookie dialog", (f) => f.kind === "dialog" && f.open);
        // (The focus the dialog took and gave back comes as one focus event.)
        assert.deepEqual(before(env, from, opened, (f) => f.kind === "dialog"), [], "twenty openings and closings in one task said nothing");
        await inPage(env, set("cookie", "el.hidden = true"));
        await next(env, from, "the cookie dialog closing", (f) => f.kind === "dialog" && !f.open);

        from = mark(env);
        assert.equal(await inPage(env, "window.toggleLoop(50)"), false);
        await inPage(env, text("alert", "After the toggling."));
        const after = await liveWith(env, from, "After the toggling");
        const states = before(env, from, after, (f) => f.kind === "dialog").map((f) => f.open);
        assert.ok(states.length <= 100 && states.length % 2 === 0, `${states.length} dialog events`);
        states.forEach((s, i) => assert.equal(s, i % 2 === 0, `alternating from an opening: ${JSON.stringify(states)}`));
      } finally {
        await inPage(env, `(document.activeElement.blur(), 1)`);
        await off(env);
      }
    },
  },
  {
    name: "events: by_kai for what Kai's acting operation caused, not for the page's own changes",
    async fn(env) {
      await onEvents(env);
      try {
        const from = mark(env);
        const press = (await call(env, "page.controls@1")).controls.find((c) => c.name === "Check stock").ref;
        await call(env, "element.press@1", { ref: press, guard: GUARD });
        const kai = await liveWith(env, from, "In stock");
        assert.equal(kai.by_kai, true);
        await inPage(env, text("alert", "The page's own news."));
        const page = await liveWith(env, from, "own news");
        assert.equal(page.by_kai, false);
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events: tab_opened when the page opens a tab, download_done when its download finished, with the tab it came from",
    async fn(env) {
      const user = await onEvents(env);
      let opened = null;
      try {
        let from = mark(env);
        // A click with the user's activation, so Firefox lets the page open the tab.
        await env.ff.send("script.evaluate", { expression: `document.getElementById("open-help").click()`, target: { context: env.ff.context }, awaitPromise: false, userActivation: true });
        const t = await next(env, from, "tab_opened", (f) => f.kind === "tab_opened");
        opened = t.opened_tab;
        assert.equal(t.tab, user);
        assert.equal(t.frame, 0);
        assert.equal(t.origin, siteOrigin(env));
        assert.equal(t.opened_url, env.site.url("help.html"));
        assert.equal(t.new_window, false);
        assert.equal(t.by_kai, false);
        assert.ok(Number.isSafeInteger(t.opened_window));
        await call(env, "tabs.close@1", { tab: opened });
        opened = null;
        await call(env, "tabs.switch@1", { tab: user });

        from = mark(env);
        await inPage(env, `(document.getElementById("dl").click(), 1)`);
        const d = await next(env, from, "download_done", (f) => f.kind === "download_done" && f.url.includes("download?events"), 20000);
        // Firefox numbers the file when an earlier test downloaded it already.
        assert.match(d.file, /^price-list(\(\d+\))?\.txt$/);
        assert.ok(d.path.endsWith(`/${d.file}`), d.path);
        assert.equal(d.size, 14);
        assert.equal(d.referrer, env.site.url("events.html"));
        assert.ok(!("tab" in d) && !("frame" in d) && !("origin" in d), "a download is no tab's event");
        assert.deepEqual(d.source, { tab: user, title: "Your account: Northwind Gear", url: env.site.url("events.html"), frame: 0, origin: siteOrigin(env) });
        assert.equal(d.by_kai, false);
      } finally {
        if (opened !== null) await call(env, "tabs.close@1", { tab: opened }).catch(() => {});
        await off(env);
      }
    },
  },
  {
    name: "events come only from the user's tab: a background tab says nothing until the user switches to it, and the watching moves without another events.config",
    async fn(env) {
      const user = await onEvents(env);
      const other = (await call(env, "tabs.open@1", { url: env.site.url("events.html"), active: false })).tab.id;
      try {
        const ctx = (await env.ff.send("browsingContext.getTree", {})).contexts.find((c) => c.context !== env.ff.context && c.url === env.site.url("events.html")).context;
        let from = mark(env);
        await env.ff.evalIn(ctx, text("alert", "From the other tab."));
        await inPage(env, text("alert", "From the user's tab."));
        const mine = await liveWith(env, from, "From the user's tab");
        await inPage(env, text("countdown", "A control from the user's tab."));
        const control = await liveWith(env, from, "A control from");
        assert.ok(!since(env, from).some((f) => f.seq <= control.seq && f.tab === other), "nothing from the background tab");
        assert.equal(mine.tab, user);
        assert.deepEqual((await call(env, "tabs.switch@1", { tab: other })).tab.user, true);
        from = mark(env);
        const moved = await untilEvent(
          env,
          "an event from the tab the user switched to",
          (n) => env.ff.evalIn(ctx, text("alert", `Now from the other tab (${n}).`)),
          (f) => f.kind === "live" && f.text.startsWith("Now from the other tab"),
        );
        assert.equal(moved.tab, other);
        await inPage(env, text("alert", "Now from the first tab."));
        await env.ff.evalIn(ctx, text("countdown", "A control from the other tab."));
        const control2 = await liveWith(env, from, "A control from the other");
        assert.ok(!since(env, from).some((f) => f.seq <= control2.seq && f.tab === user), "nothing from the tab the user left");
      } finally {
        await off(env);
        await call(env, "tabs.close@1", { tab: other });
        await call(env, "tabs.switch@1", { tab: user });
      }
    },
  },
  {
    name: "events: a page restored from the back-forward cache asks again and is watched",
    async fn(env) {
      const user = await onEvents(env);
      try {
        // Firefox 159 restores a page from its back-forward cache about four times in five here,
        // so the step is repeated until the page is restored (as in the styles test).
        let restored = 0;
        for (let i = 0; i < 8 && !restored; i++) {
          await call(env, "tabs.go@1", { tab: user, url: env.site.url("cached-a.html") });
          await call(env, "tabs.go@1", { tab: user, url: env.site.url("cached-b.html") });
          await call(env, "tabs.back@1", { tab: user });
          restored = await inPage(env, "window.restored");
        }
        assert.equal(restored, 1, "the page came back from the back-forward cache (8 tries)");
        const e = await untilEvent(
          env,
          "an event from the restored page",
          (n) => inPage(env, `(() => { const a = document.createElement("div"); a.setAttribute("role", "alert"); a.textContent = "Restored (${n})."; document.body.append(a); return 1; })()`),
          (f) => f.kind === "live" && f.text.startsWith("Restored"),
        );
        assert.deepEqual([e.tab, e.url], [user, env.site.url("cached-a.html")]);
      } finally {
        await off(env);
      }
    },
  },
  {
    name: "events of a cross-origin frame carry its frame id and origin",
    async fn(env) {
      const user = await onEvents(env);
      try {
        const ctx = await frameContext(env, "events-frame.html");
        const frames = await env.ext(`browser.webNavigation.getAllFrames({ tabId: ${user} })`);
        const partner = frames.find((f) => f.url.includes("events-frame.html"));
        const from = mark(env);
        await env.ff.evalIn(ctx, `(document.getElementById("offer").textContent = "Two lamps for the price of one.", 1)`);
        const e = await liveWith(env, from, "Two lamps");
        assert.equal(e.frame, partner.frameId);
        assert.equal(e.origin, siteOrigin(env, "localhost"));
        assert.equal(e.tab, user);
        assert.equal(e.url, env.site.url("events.html"), "the tab's own URL");
        assert.deepEqual([e.region.role, e.atomic], ["status", true]);
      } finally {
        await off(env);
      }
    },
  },
];

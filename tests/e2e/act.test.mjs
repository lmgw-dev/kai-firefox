// Hands (design §5.4): pressing, filling (controlled inputs, comboboxes, rich editors, sliders,
// dates), choosing, checking, files, focus, hover, drag, show, scrolling and keys, on the
// fixture's form page; what each answers and how it refuses.
import assert from "node:assert/strict";
import { call, fails, inPage, waitFor } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

// A guard with no words and a short window: the page-side checks find nothing to ask about, and
// the network gate watches for a moment.
export const QUIET = { words: [], window_ms: 200, answer_ms: 10000 };
// The contract's default word list (docs/protocol/operations.md, Guard), as Kai sends it.
export const GUARD_WORDS = ["buy", "order", "pay", "checkout", "purchase", "subscribe", "delete", "remove", "send", "transfer", "confirm",
  "kauf", "bestell", "bezahl", "zahlung", "zahlen", "kasse", "abo", "lösch", "entfern", "überweis", "bestätig"];

// The user's tab on page `path` of the fixture site.
export async function onPage(env, path) {
  const user = await home(env);
  await call(env, "tabs.go@1", { tab: user, url: env.site.url(path) });
  await inPage(env, "(scrollTo(0, 0), 1)");
  return user;
}

// The ref of the element named `name`: a field, a link, or what page.find finds with that name.
export async function refOf(env, name) {
  const f = await call(env, "page.fields@1");
  const field = f.fields.find((x) => x.name === name);
  if (field) return field.ref;
  const l = await call(env, "page.links@1");
  const link = l.links.find((x) => x.name === name);
  if (link) return link.ref;
  const m = await call(env, "page.find@1", { text: name });
  const el = m.matches.map((x) => x.element).find((x) => x && x.name === name);
  assert.ok(el, `nothing named '${name}': ${JSON.stringify(m.matches.map((x) => x.element))}`);
  return el.ref;
}
// The ref of the first element of role `role` whose text page.find finds (list items and
// paragraphs have no name).
export async function refByText(env, words, role) {
  const m = await call(env, "page.find@1", { text: words });
  const el = m.matches.map((x) => x.element).find((x) => x && x.role === role);
  assert.ok(el, `no ${role} with '${words}': ${JSON.stringify(m.matches.map((x) => x.element))}`);
  return el.ref;
}
const text = (env, id) => inPage(env, `document.getElementById(${JSON.stringify(id)}).textContent`);
const value = (env, id) => inPage(env, `document.getElementById(${JSON.stringify(id)}).value`);

export default [
  {
    name: "element.fill: a controlled input takes the text through the native setter (its state follows)",
    async fn(env) {
      const user = await onPage(env, "form.html");
      const ref = await refOf(env, "Full name");
      const r = await call(env, "element.fill@1", { ref, text: "Ada Example", guard: QUIET });
      assert.deepEqual(r, {
        ref,
        tab: { id: user, title: "Your order: Northwind Gear", url: env.site.url("form.html") },
        role: "textbox",
        name: "Full name",
        value: "Ada Example",
        how: "value",
        took: true,
        scrolled: false,
        requests: [],
      });
      assert.equal(await text(env, "greeting"), "Hello, Ada Example");
    },
  },
  {
    name: "focus.check: the element with the keyboard focus, another element, Firefox's own UI",
    async fn(env) {
      await onPage(env, "form.html");
      // The page holds the keyboard focus, as after the user clicked into it (Firefox leaves it in
      // the address bar after start).
      await env.ff.chromeEval(`(gBrowser.selectedBrowser.focus(), 1)`);
      const notes = await refOf(env, "Notes");
      const name = await refOf(env, "Full name");
      const f = await call(env, "element.focus@1", { ref: notes, guard: "off" });
      assert.equal(f.focused, true);
      const yes = await call(env, "focus.check@1", { ref: notes });
      assert.equal(yes.focused, true, JSON.stringify(yes));
      const no = await call(env, "focus.check@1", { ref: name });
      assert.deepEqual([no.focused, no.focus, no.element?.ref], [false, "element", notes]);
      await env.ff.chromeEval(`(gURLBar.focus(), 1)`);
      try {
        const ui = await call(env, "focus.check@1", { ref: notes });
        assert.deepEqual([ui.focused, ui.focus], [false, "firefox"]);
      } finally {
        await env.ff.chromeEval(`(gBrowser.selectedBrowser.focus(), 1)`);
      }
    },
  },
  {
    name: "element.fill: a combobox gets the text one key at a time, and element.choose picks a suggestion",
    async fn(env) {
      await onPage(env, "form.html");
      const ref = await refOf(env, "City");
      const r = await call(env, "element.fill@1", { ref, text: "Ber", guard: QUIET });
      assert.deepEqual([r.role, r.value, r.how, r.took, r.expanded], ["combobox", "Ber", "keys", true, true]);
      assert.equal(await text(env, "city-keys"), "3", "one keydown per character");
      const shown = await inPage(env, `[...document.querySelectorAll("#cities li")].map((li) => li.textContent)`);
      assert.deepEqual(shown, ["Berlin", "Bern", "Bergen"]);
      const c = await call(env, "element.choose@1", { ref, option: "berlin", guard: QUIET });
      assert.deepEqual([c.chosen, c.took, c.value, c.expanded], ["Berlin", true, "Berlin", false]);
      // Again: the list is closed now.
      const e = await fails(env, "element.choose@1", { ref, option: "Bonn", guard: QUIET }, "no_option");
      assert.deepEqual(e.options, []);
      assert.match(e.message, /shows no options now/);
    },
  },
  {
    name: "element.fill: a rich editor that changes only through beforeinput takes the text; one that refuses says so",
    async fn(env) {
      await onPage(env, "form.html");
      const note = await refOf(env, "Note");
      const r = await call(env, "element.fill@1", { ref: note, text: "Ring twice", guard: QUIET });
      assert.deepEqual([r.how, r.took, r.value], ["editor", true, "Ring twice"]);
      assert.equal(await text(env, "note-model"), "Ring twice", "the editor's own model has it");
      const stubborn = await refOf(env, "Gift message");
      const s = await call(env, "element.fill@1", { ref: stubborn, text: "Many happy returns", guard: QUIET });
      assert.deepEqual([s.how, s.took, s.value], ["editor", false, "Happy birthday"]);
      assert.match(s.note, /did not take the text.*element\.focus and then Kai's type_text/);
    },
  },
  {
    name: "element.fill: a range, a date and a number take the value; ARIA sliders get arrow keys until they match",
    async fn(env) {
      await onPage(env, "form.html");
      const vol = await call(env, "element.fill@1", { ref: await refOf(env, "Volume"), text: "35", guard: QUIET });
      assert.deepEqual([vol.role, vol.value, vol.took, vol.min, vol.max], ["slider", "35", true, "0", "100"]);
      assert.equal(await value(env, "volume-out"), "35");
      const date = await call(env, "element.fill@1", { ref: await refOf(env, "Arrival"), text: "2026-11-24", guard: QUIET });
      assert.deepEqual([date.value, date.took], ["2026-11-24", true]);
      const bad = await call(env, "element.fill@1", { ref: await refOf(env, "Arrival"), text: "next Tuesday", guard: QUIET });
      assert.deepEqual([bad.value, bad.took], ["", false]);
      const qty = await call(env, "element.fill@1", { ref: await refOf(env, "Quantity"), text: "3", guard: QUIET });
      assert.deepEqual([qty.role, qty.value, qty.took], ["spinbutton", "3", true]);
      const bright = await refOf(env, "Brightness");
      const b = await call(env, "element.fill@1", { ref: bright, text: "7", guard: QUIET });
      assert.deepEqual([b.how, b.took, b.value], ["keys", true, "7"]);
      const b2 = await call(env, "element.fill@1", { ref: bright, text: "10", guard: QUIET });
      assert.deepEqual([b2.took, b2.value], [true, "10"]);
      const b3 = await call(env, "element.fill@1", { ref: bright, text: "2", guard: QUIET });
      assert.deepEqual([b3.took, b3.value], [true, "2"]);
      const e = await fails(env, "element.fill@1", { ref: bright, text: "11", guard: QUIET }, "bad_value");
      assert.match(e.message, /takes a number from 0 to 10/);
      // Warmth steps by 30: 50 is between two steps.
      const w = await call(env, "element.fill@1", { ref: await refOf(env, "Warmth"), text: "50", guard: QUIET });
      assert.deepEqual([w.took, w.value], [false, "60"]);
      assert.match(w.note, /its steps pass 50: one key took it from 30 to 60/);
    },
  },
  {
    name: "element.fill: state a page commits in a microtask is read after it (a field that puts back what it refuses, a slider); Page Up for a long way; keys_ms bounds the keys",
    async fn(env) {
      await onPage(env, "widgets.html");
      const pc = await refOf(env, "Postcode");
      const a = await call(env, "element.fill@1", { ref: pc, text: "12345", guard: QUIET });
      assert.deepEqual([a.took, a.value], [true, "12345"]);
      const b = await call(env, "element.fill@1", { ref: pc, text: "123456", guard: QUIET });
      assert.deepEqual([b.took, b.value], [false, "12345"], "the page put its value back a microtask later");
      const level = await call(env, "element.fill@1", { ref: await refOf(env, "Level"), text: "7", guard: QUIET });
      assert.deepEqual([level.how, level.took, level.value, level.note], ["keys", true, "7", undefined]);
      const budget = await refOf(env, "Budget");
      const c = await call(env, "element.fill@1", { ref: budget, text: "870", guard: QUIET });
      assert.deepEqual([c.took, c.value], [true, "870"]);
      // One arrow learns the step, eight Page Ups go 800 further, 69 arrows the rest.
      assert.equal(await text(env, "budget-keys"), "78");
      await env.ext(`browser.storage.local.set({ keys_ms: 30 }).then(() => 1)`);
      try {
        const d = await call(env, "element.fill@1", { ref: budget, text: "3", guard: QUIET });
        assert.equal(d.took, false);
        assert.match(d.note, /^it did not reach 3 within Kai for Firefox's setting keys_ms \(30 ms\): it is at \d+$/);
      } finally {
        await env.ext(`browser.storage.local.remove("keys_ms").then(() => 1)`);
      }
    },
  },
  {
    name: "element.fill: a password field's value comes back masked; read-only, disabled and other kinds refuse",
    async fn(env) {
      await onPage(env, "form.html");
      const pw = await call(env, "element.fill@1", { ref: await refOf(env, "Password"), text: "example-secret-3", guard: QUIET });
      assert.equal(pw.took, true);
      assert.equal(pw.masked, true);
      assert.equal(pw.length, 16);
      assert.ok(!("value" in pw), JSON.stringify(pw));
      assert.ok(!JSON.stringify(pw).includes("example-secret"));
      await fails(env, "element.fill@1", { ref: await refOf(env, "Order number"), text: "x", guard: QUIET }, "readonly");
      await fails(env, "element.fill@1", { ref: await refOf(env, "Voucher"), text: "x", guard: QUIET }, "disabled");
      const box = await fails(env, "element.fill@1", { ref: await refOf(env, "Gift wrap"), text: "x", guard: QUIET }, "not_fillable");
      assert.match(box.message, /element\.check/);
      const sel = await fails(env, "element.fill@1", { ref: await refOf(env, "Country"), text: "x", guard: QUIET }, "not_fillable");
      assert.match(sel.message, /element\.choose/);
      await fails(env, "element.fill@1", { ref: await refOf(env, "Full name"), text: "x", guard: { words: [] } }, "bad_args");
      await fails(env, "element.fill@1", { ref: await refOf(env, "Full name"), text: "x" }, "bad_args");
    },
  },
  {
    name: "element.choose: a select, a radio group and a list box by label; unknown and disabled options refuse",
    async fn(env) {
      await onPage(env, "form.html");
      const country = await refOf(env, "Country");
      const c = await call(env, "element.choose@1", { ref: country, option: "Austria", guard: QUIET });
      assert.deepEqual([c.role, c.chosen, c.took, c.value], ["combobox", "Austria", true, "Austria"]);
      const none = await fails(env, "element.choose@1", { ref: country, option: "Atlantis", guard: QUIET }, "no_option");
      assert.deepEqual(none.options, ["Choose one", "Germany", "Austria", "Mars"]);
      await fails(env, "element.choose@1", { ref: country, option: "Mars", guard: QUIET }, "disabled");
      const ship = await refOf(env, "Standard");
      const r = await call(env, "element.choose@1", { ref: ship, option: "Express", guard: QUIET });
      assert.deepEqual([r.chosen, r.took], ["Express", true]);
      assert.equal(await inPage(env, `document.querySelector("input[value=exp]").checked`), true);
      const colour = await refOf(env, "Colour");
      const l = await call(env, "element.choose@1", { ref: colour, option: "Blue", guard: QUIET });
      assert.deepEqual([l.chosen, l.took], ["Blue", true]);
      await fails(env, "element.choose@1", { ref: await refOf(env, "Full name"), option: "x", guard: QUIET }, "not_choosable");
    },
  },
  {
    name: "element.check: a checkbox, a switch, a hidden checkbox through its label; a radio cannot be turned off",
    async fn(env) {
      await onPage(env, "form.html");
      const gift = await refOf(env, "Gift wrap");
      const a = await call(env, "element.check@1", { ref: gift, on: true, guard: QUIET });
      assert.deepEqual([a.checked, a.changed, a.took], [true, true, true]);
      const b = await call(env, "element.check@1", { ref: gift, on: true, guard: QUIET });
      assert.deepEqual([b.checked, b.changed, b.took], [true, false, true]);
      assert.ok(!("requests" in b), "nothing was done, so nothing was watched");
      const news = await call(env, "element.check@1", { ref: await refOf(env, "Newsletter"), on: true, guard: QUIET });
      assert.deepEqual([news.role, news.checked, news.took], ["switch", true, true]);
      const terms = await call(env, "element.check@1", { ref: await refOf(env, "I accept the terms"), on: true, guard: QUIET });
      assert.deepEqual([terms.checked, terms.took], [true, true]);
      // A box the page hid after its ref was given is used through its label.
      await inPage(env, `(document.getElementById("gift").style.display = "none", 1)`);
      const off = await call(env, "element.check@1", { ref: gift, on: false, guard: QUIET });
      assert.deepEqual([off.checked, off.took], [false, true]);
      assert.equal(await inPage(env, `document.getElementById("gift").checked`), false);
      await fails(env, "element.check@1", { ref: await refOf(env, "Standard"), on: false, guard: QUIET }, "bad_value");
      await fails(env, "element.check@1", { ref: await refOf(env, "Full name"), on: true, guard: QUIET }, "not_checkable");
    },
  },
  {
    name: "page.fields: inputs HTML-AAM gives no role carry the contract's role words (file, date, time, datetime, month, week, color), a range is a slider",
    async fn(env) {
      await onPage(env, "inputs.html");
      const f = await call(env, "page.fields@1");
      const roles = Object.fromEntries(f.fields.map((x) => [x.name, x.role]));
      // Firefox 159 has no month or week input: they are text inputs there (`type` reads "text"),
      // so textboxes; a Firefox that has them gives `month` and `week`.
      const plain = await inPage(env, `document.getElementById("month").type === "text" && document.getElementById("week").type === "text"`);
      const [month, week] = plain ? ["textbox", "textbox"] : ["month", "week"];
      assert.deepEqual(roles, { Photo: "file", Day: "date", Time: "time", Slot: "datetime", Month: month, Week: week, Colour: "color", Tip: "slider" }, JSON.stringify(roles));
      // element.fill takes the kinds it sets as a value, by their role words too.
      const day = f.fields.find((x) => x.name === "Day").ref;
      const r = await call(env, "element.fill@1", { ref: day, text: "2026-11-04", guard: QUIET });
      assert.deepEqual([r.role, r.value, r.took], ["date", "2026-11-04", true]);
      // The <time> element keeps the ARIA role `time` and is no field.
      const m = await call(env, "page.find@1", { text: "3 November" });
      assert.ok(!f.fields.some((x) => x.name === "3 November"), JSON.stringify(m.matches));
    },
  },
  {
    name: "element.file: the file input gets the bytes Kai sent, with name and type, without a picker",
    async fn(env) {
      await onPage(env, "form.html");
      const ref = await refOf(env, "Receipt");
      const base64 = Buffer.from("Trail Lamp, 29 EUR\n").toString("base64");
      const r = await call(env, "element.file@1", { ref, files: [{ name: "receipt.txt", type: "text/plain", base64 }], guard: QUIET });
      assert.deepEqual(r.files, [{ name: "receipt.txt", type: "text/plain", bytes: 19 }]);
      assert.equal(r.value, "receipt.txt");
      assert.equal(await text(env, "receipt-name"), "receipt.txt (19 bytes, text/plain)");
      await fails(env, "element.file@1", { ref, files: [{ name: "a.txt", base64 }, { name: "b.txt", base64 }], guard: QUIET }, "bad_value");
      await fails(env, "element.file@1", { ref, files: [{ name: "a.txt", base64: "not base64!" }], guard: QUIET }, "bad_args");
      await fails(env, "element.file@1", { ref: await refOf(env, "Full name"), files: [{ name: "a.txt", base64 }], guard: QUIET }, "not_a_file_input");
    },
  },
  {
    name: "element.focus, element.hover and element.show",
    async fn(env) {
      await onPage(env, "form.html");
      const notes = await refOf(env, "Notes");
      await inPage(env, `(document.getElementById("notes").value = "Fragile", 1)`);
      const f = await call(env, "element.focus@1", { ref: notes, guard: QUIET });
      assert.deepEqual([f.focused, f.scrolled], [true, true]);
      assert.deepEqual(await inPage(env, `[document.activeElement.id, document.activeElement.selectionStart]`), ["notes", 7], "the caret at the end");
      assert.equal((await call(env, "context.get@1")).focus.ref, notes);
      const account = await refOf(env, "Account");
      const h = await call(env, "element.hover@1", { ref: account, guard: QUIET });
      assert.deepEqual([h.hovered, h.expanded], [true, true]);
      assert.equal(await inPage(env, `document.getElementById("menu").hidden`), false);
      // Hovering elsewhere leaves the menu's button: it closes.
      await call(env, "element.hover@1", { ref: notes, guard: QUIET });
      assert.equal(await inPage(env, `document.getElementById("menu").hidden`), true);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const full = await refOf(env, "Full screen");
      const s = await call(env, "element.show@1", { ref: full });
      assert.deepEqual(s, { ref: full, tab: s.tab, role: "button", name: "Full screen", scrolled: true });
      assert.equal((await call(env, "element.show@1", { ref: full })).scrolled, false);
    },
  },
  {
    name: "element.drag: HTML5 drag and drop, and a list that follows the pointer",
    async fn(env) {
      await onPage(env, "form.html");
      const lamp = await refByText(env, "Lamp", "listitem");
      const stove = await refByText(env, "Stove", "listitem");
      const d = await call(env, "element.drag@1", { ref: lamp, to: stove, guard: QUIET });
      assert.deepEqual([d.how, d.dropped, d.to.ref, d.to.role], ["html5", true, stove, "listitem"]);
      assert.equal(await text(env, "pack-order"), "Tent, Stove, Lamp");
      const one = await refByText(env, "One", "listitem");
      const three = await refByText(env, "Three", "listitem");
      const p = await call(env, "element.drag@1", { ref: one, to: three, guard: QUIET });
      assert.deepEqual([p.how, p.to.ref], ["pointer", three]);
      assert.equal(await text(env, "sort-order"), "Two, Three, One");
    },
  },
  {
    name: "element.drag: both refs must be in one document",
    async fn(env) {
      await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const c = await call(env, "page.controls@1");
      const accept = c.controls.find((x) => x.name === "Accept all cookies").ref;
      const search = c.controls.find((x) => x.name === "Search the shop").ref;
      await fails(env, "element.drag@1", { ref: accept, to: search, guard: QUIET }, "other_document");
    },
  },
  {
    name: "element.scroll scrolls its container; page.scroll the page",
    async fn(env) {
      await onPage(env, "form.html");
      const term = await refByText(env, "Term 1:", "paragraph");
      const down = await call(env, "element.scroll@1", { ref: term, to: "down", guard: QUIET });
      assert.deepEqual([down.name, down.scrolled, down.at_top, down.at_bottom], ["Terms text", true, false, false]);
      assert.ok(down.percent > 0 && down.percent < 100, JSON.stringify(down));
      const pane = down.ref;
      const bottom = await call(env, "element.scroll@1", { ref: pane, to: "bottom", guard: QUIET });
      assert.deepEqual([bottom.percent, bottom.at_bottom], [100, true]);
      const top = await call(env, "element.scroll@1", { ref: pane, to: "top", guard: QUIET });
      assert.deepEqual([top.percent, top.at_top], [0, true]);
      const again = await call(env, "element.scroll@1", { ref: pane, to: "up", guard: QUIET });
      assert.equal(again.scrolled, false);
      await fails(env, "element.scroll@1", { ref: await refOf(env, "Full name"), to: "down", guard: QUIET }, "not_scrollable");
      await inPage(env, "(scrollTo(0, 0), 1)");
      const pg = await call(env, "page.scroll@1", { to: "down", guard: QUIET });
      assert.deepEqual([pg.container, pg.scrolled, pg.at_top], [null, true, false]);
      const y = await inPage(env, "scrollY");
      const h = await inPage(env, "document.documentElement.clientHeight");
      assert.equal(y, Math.round(h * 0.9));
      const end = await call(env, "page.scroll@1", { to: "bottom", guard: QUIET });
      assert.deepEqual([end.percent, end.at_bottom], [100, true]);
      await call(env, "page.scroll@1", { to: "top", guard: QUIET });
      assert.equal(await inPage(env, "scrollY"), 0);
    },
  },
  {
    name: "page.key: keys to the focused element; Escape closes a modal dialog, Enter submits a form",
    async fn(env) {
      const user = await onPage(env, "form.html");
      await call(env, "element.focus@1", { ref: await refOf(env, "Notes"), guard: "off" });
      const k = await call(env, "page.key@1", { keys: "ctrl+k", guard: QUIET });
      assert.deepEqual([k.keys, k.target.name, k.prevented, k.emulated], ["Ctrl+K", "Notes", false, null]);
      assert.equal(await text(env, "last-key"), "ctrl+k (75)");
      await fails(env, "page.key@1", { keys: "ctrl+nope", guard: QUIET }, "bad_args");
      await fails(env, "page.key@1", { keys: "hyper+k", guard: QUIET }, "bad_args");
      const open = await call(env, "element.press@1", { ref: await refOf(env, "Edit address"), guard: QUIET });
      assert.equal(open.clicked, true);
      assert.equal((await call(env, "context.get@1")).dialog.name, "Address");
      const esc = await call(env, "page.key@1", { keys: "Escape", guard: QUIET });
      assert.equal(esc.emulated, "close");
      assert.equal((await call(env, "context.get@1")).dialog, null);
      await call(env, "element.fill@1", { ref: await refOf(env, "Search"), text: "lamp", guard: "off" });
      const enter = await call(env, "page.key@1", { keys: "Enter", tab: user, guard: QUIET });
      assert.deepEqual([enter.target.name, enter.emulated], ["Search", "submit"]);
      // Where the Enter's submit goes: the form action's origin (design §6.4, the owner's moves).
      assert.deepEqual(enter.goes, { by: "submit", origin: new URL(env.site.url("search")).origin });
      assert.ok(!("goes" in esc) && !("goes" in k), "a key that submits nothing goes nowhere");
      await waitFor(async () => (await call(env, "tabs.list@1")).tabs.find((t) => t.id === user).title === "Results for lamp", { what: "the search's results" });
    },
  },
  {
    name: "element.press: a press activates; elements that need a gesture answer needs_trusted; activate: false only focuses",
    async fn(env) {
      await onPage(env, "form.html");
      const prices = await refOf(env, "Open the price list");
      const before = (await call(env, "tabs.list@1")).tabs.length;
      const t = await call(env, "element.press@1", { ref: prices, guard: QUIET });
      assert.deepEqual([t.needs_trusted, t.key, t.focused], ["new_window", "Enter", true]);
      assert.ok(!("clicked" in t) && !("requests" in t));
      assert.equal((await call(env, "tabs.list@1")).tabs.length, before, "no tab opened");
      // A video with controls is a control (in view).
      await inPage(env, `(document.getElementById("clip").scrollIntoView(), 1)`);
      const video = (await call(env, "page.controls@1")).controls.find((x) => x.name === "Product video");
      assert.ok(video, "the video is listed among the controls");
      const clip = await call(env, "element.press@1", { ref: video.ref, guard: QUIET });
      assert.deepEqual([clip.needs_trusted, clip.key], ["media", "Space"]);
      const full = await call(env, "element.press@1", { ref: await refOf(env, "Full screen"), guard: QUIET });
      assert.equal(full.needs_trusted, "fullscreen");
      const receipt = await call(env, "element.press@1", { ref: await refOf(env, "Receipt"), guard: QUIET });
      assert.equal(receipt.needs_trusted, "file_input");
      const edit = await refOf(env, "Edit address");
      const account = await refOf(env, "Account");
      const only = await call(env, "element.press@1", { ref: edit, activate: false, guard: QUIET });
      assert.deepEqual([only.focused, only.key, "clicked" in only, "needs_trusted" in only], [true, "Enter", false, false]);
      // Focus only also says which key Kai's trusted press sends, and what needs one by its kind.
      const box = await call(env, "element.press@1", { ref: await refOf(env, "Gift wrap"), activate: false, guard: QUIET });
      assert.deepEqual([box.key, box.checked, box.focused], ["Space", false, true]);
      const clipOnly = await call(env, "element.press@1", { ref: video.ref, activate: false, guard: QUIET });
      assert.deepEqual([clipOnly.key, clipOnly.needs_trusted], ["Space", "media"]);
      assert.equal((await call(env, "context.get@1")).dialog, null, "not pressed");
      await fails(env, "element.press@1", { ref: await refOf(env, "Voucher"), guard: QUIET }, "disabled");
      const p = await call(env, "element.press@1", { ref: edit, guard: QUIET });
      assert.deepEqual([p.clicked, p.requests], [true, []]);
      assert.equal((await call(env, "context.get@1")).dialog.name, "Address");
      // Outside the open modal dialog nothing can be pressed.
      await fails(env, "element.press@1", { ref: account, guard: QUIET }, "inert");
      await call(env, "page.key@1", { keys: "Escape", guard: QUIET });
    },
  },
];


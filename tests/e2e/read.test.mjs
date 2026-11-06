// The reading operations (design §5.3): outline, controls, links, fields, the article, all the
// text and the text in view, an element's text, tables, the selection, find and a PDF's bytes;
// frames, open and closed shadow roots and a modal dialog; masking in everything that reports a
// value; stale refs; a page too busy to answer (content_ms).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/env.mjs";
import { PER_GROUP, bigPdf } from "../lib/large-page.mjs";
import { call, fails, waitFor, inPage, sleep, frameContext } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

const SHOP = "Northwind Gear: lamps and tents";
const go = (env, path) => call(env, "tabs.go@1", { url: env.site.url(path) });
const texts = (blocks) => blocks.filter((b) => b.text).map((b) => b.text);
const byName = (list, name) => {
  const hit = list.find((x) => x.name === name);
  assert.ok(hit, `no ${name} in ${JSON.stringify(list.map((x) => x.name))}`);
  return hit;
};
// The ref of the element a find match is in.
const refOf = async (env, text) => (await call(env, "page.find@1", { text })).matches[0].element.ref;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export default [
  {
    name: "page.outline: landmarks and headings of the whole page, the frame's at its place, the heading in view marked",
    async fn(env) {
      const user = await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const o = await call(env, "page.outline@1");
      assert.deepEqual(o.tab, { id: user, title: SHOP, url: env.site.url("shop.html") });
      assert.deepEqual(
        o.items.map((i) => [i.role, i.name, i.level ?? null]),
        [
          ["banner", "", null],
          ["navigation", "Main", null],
          ["search", "", null],
          ["main", "", null],
          ["heading", "Lamps and tents", 1],
          ["region", "Cookie banner", null],
          ["heading", "Trail Lamp", 2],
          ["heading", "Ridge Tent", 2],
          ["heading", "Camp Stove", 2],
          ["heading", "Pocket Knife", 2],
          ["contentinfo", "", null],
        ],
      );
      assert.deepEqual(o.items.filter((i) => i.here).map((i) => i.name), ["Lamps and tents"]);
      assert.ok(o.items.every((i) => Number.isSafeInteger(i.ref)));
      assert.deepEqual(o.frames, { read: 2, unread: 0, unread_frames: [] });
      assert.equal(o.modal, null);
      const camp = byName(o.items, "Camp Stove");
      const d = await call(env, "element.describe@1", { ref: camp.ref });
      assert.deepEqual([d.role, d.name, d.level], ["heading", "Camp Stove", 2]);
      await inPage(env, `(document.getElementById("p3").scrollIntoView({ block: "start" }), 1)`);
      const after = await call(env, "page.outline@1");
      assert.deepEqual(after.items.filter((i) => i.here).map((i) => [i.name, i.ref]), [["Camp Stove", camp.ref]], "the same element keeps its ref");
      // The text between two headings: the last heading above the view.
      await inPage(env, `(() => { const h = document.querySelector("#p3 h2"); scrollBy(0, h.getBoundingClientRect().bottom + 2); return 1; })()`);
      const between = await call(env, "page.outline@1");
      const here = between.items.find((i) => i.here);
      assert.ok(here, JSON.stringify(between.items));
    },
  },
  {
    name: "page.controls: the controls in view across frames and a closed shadow root, in reading order; a modal dialog's only",
    async fn(env) {
      await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const c = await call(env, "page.controls@1");
      const names = c.controls.map((x) => x.name);
      assert.deepEqual(names.slice(0, 7), ["Shop", "Journal", "Help", "Search the shop", "Search", "Accept all cookies", "Reject optional cookies"]);
      assert.equal(byName(c.controls, "Search the shop").role, "searchbox");
      assert.equal(byName(c.controls, "Shop").url, env.site.url("shop.html"));
      assert.ok(!names.includes("Add Pocket Knife to cart"), "out of view");
      assert.ok(!names.includes("Remove"), "the closed dialog's buttons are not shown");
      assert.equal(c.modal, null);
      assert.deepEqual(c.frames, { read: 2, unread: 0, unread_frames: [] });
      for (const x of c.controls) assert.deepEqual(Object.keys(x).slice(0, 3), ["ref", "role", "name"]);
      await inPage(env, `(document.getElementById("p3").scrollIntoView({ block: "start" }), 1)`);
      const later = await call(env, "page.controls@1");
      const stove = byName(later.controls, "Add Camp Stove to cart");
      assert.equal(stove.role, "button");
      assert.ok(!later.controls.some((x) => x.name === "Shop"), "scrolled out of view");
      await inPage(env, `(document.getElementById("confirm").showModal(), 1)`);
      try {
        const m = await call(env, "page.controls@1");
        assert.deepEqual(
          m.controls.map((x) => [x.role, x.name]),
          [
            ["button", "Remove"],
            ["button", "Keep it"],
          ],
        );
        assert.equal(m.modal.name, "Remove the Trail Lamp?");
        assert.equal(m.modal.role, "dialog");
        assert.equal(m.modal.frame, 0);
        // A modal dialog opened inside the open one: the inner one's controls only.
        await inPage(env, `(document.getElementById("confirm-more").showModal(), 1)`);
        const inner = await call(env, "page.controls@1");
        assert.deepEqual(inner.controls.map((x) => [x.role, x.name]), [["button", "Remove all"]]);
        assert.deepEqual([inner.modal.name, inner.modal.frame], ["Remove all lamps?", 0]);
        assert.equal((await call(env, "context.get@1")).dialog.name, "Remove all lamps?");
      } finally {
        await inPage(env, `(document.getElementById("confirm-more").close(), document.getElementById("confirm").close(), 1)`);
      }
    },
  },
  {
    name: "page.fields: values and states, labels, groups, errors and descriptions, and a field in an open shadow root",
    async fn(env) {
      await home(env);
      await go(env, "account.html");
      const f = await call(env, "page.fields@1");
      const get = (name) => byName(f.fields, name);
      const pick = (x, keys) => Object.fromEntries(keys.filter((k) => k in x).map((k) => [k, x[k]]));
      const STATE = ["role", "value", "masked", "length", "checked", "selected", "pressed", "expanded", "disabled", "readonly", "required", "invalid", "error", "description", "label", "group", "min", "max"];
      assert.deepEqual(pick(get("Full name"), STATE), { role: "textbox", value: "Ada Example", required: true });
      assert.deepEqual(pick(get("E-mail"), STATE), { role: "textbox", value: "ada@shop", invalid: true, error: "Enter an address like ada@shop.example.", description: "We send receipts here." });
      assert.deepEqual(pick(get("Nickname"), STATE), { role: "textbox", value: "ada", label: "Shown name" });
      assert.deepEqual(pick(get("Password"), STATE), { role: "textbox", masked: true, length: 16 });
      assert.deepEqual(pick(get("Standard"), STATE), { role: "radio", checked: true, group: "Delivery" });
      assert.deepEqual(pick(get("Express"), STATE), { role: "radio", checked: false, group: "Delivery" });
      assert.deepEqual(pick(get("Newsletter"), STATE), { role: "checkbox", checked: true });
      assert.deepEqual(pick(get("All topics"), STATE), { role: "checkbox", checked: "mixed" });
      assert.deepEqual(pick(get("Country"), STATE), { role: "combobox", value: "Austria" });
      assert.deepEqual(pick(get("Lamps"), STATE), { role: "slider", value: "3", min: "0", max: "10" });
      assert.deepEqual(pick(get("Volume"), STATE), { role: "slider", value: "40 percent", min: "0", max: "100" });
      assert.deepEqual(pick(get("Dark mode"), STATE), { role: "switch", checked: true });
      assert.deepEqual(pick(get("Voucher"), STATE), { role: "textbox", value: "NW-2026", disabled: true });
      assert.deepEqual(pick(get("Customer since"), STATE), { role: "textbox", value: "2024", readonly: true });
      assert.deepEqual(pick(get("Notes"), STATE), { role: "textbox", value: "Leave at the door." });
      assert.deepEqual(pick(get("Postcode"), STATE), { role: "textbox", value: "10115" });
      assert.ok(f.fields.every((x) => x.in_view === true && !x.inert), "the form fits the view; nothing is inert");
      assert.ok(!JSON.stringify(f).includes("example-secret-3"));
      const c = await call(env, "page.controls@1");
      assert.deepEqual(pick(byName(c.controls, "More options"), STATE), { role: "button", expanded: false });
      assert.deepEqual(pick(byName(c.controls, "Bold"), STATE), { role: "button", pressed: true });
      assert.ok(!c.controls.some((x) => x.name === "Behind inert"), "inert content is not a control");
      assert.deepEqual(pick(byName(c.controls, "Help"), [...STATE, "url"]), { role: "button", url: env.site.url("help.html") });
    },
  },
  {
    name: "page.controls and page.fields with an aria-modal dialog open: only the dialog's controls; the fields marked inert",
    async fn(env) {
      await home(env);
      await go(env, "account.html");
      await inPage(env, `(document.getElementById("dlg").hidden = false, 1)`);
      const c = await call(env, "page.controls@1");
      assert.deepEqual(c.controls.map((x) => x.name), ["Leave", "Stay"]);
      assert.equal(c.modal.name, "Leave without saving?");
      const f = await call(env, "page.fields@1");
      assert.equal(f.modal.name, "Leave without saving?");
      assert.ok(f.fields.length > 10 && f.fields.every((x) => x.inert === true), "every field is outside the dialog");
      const l = await call(env, "page.links@1");
      assert.deepEqual(
        l.links.map((x) => [x.role, x.name, x.url, x.in_view, x.inert]),
        [["button", "Help", env.site.url("help.html"), true, true]],
      );
    },
  },
  {
    name: "masking: sensitive values stay out of controls, fields, text, element text, tables, find and the selection",
    async fn(env) {
      await home(env);
      const said = [];
      const run = async (op, args = {}) => {
        const r = await call(env, op, args);
        said.push(r);
        return r;
      };
      await go(env, "checkout.html");
      const f = await run("page.fields@1");
      // The card, the code, its copy, the new password, the second card, a card whose
      // autocomplete is in capitals and a security code; the field labelled by the new password
      // reports its own (empty) value and a masked name.
      assert.deepEqual(
        f.fields.map((x) => [x.name, x.masked ?? false, x.length ?? x.value]),
        [
          ["Card number", true, 19],
          ["One-time code", true, 6],
          ["", true, 6],
          ["", true, 16],
          ["password field, filled (16 characters)", false, ""],
          ["", true, 19],
          ["Gift card", true, 19],
          ["Security code", true, 3],
        ],
      );
      await run("page.controls@1");
      const all = await run("page.text_all@1");
      assert.ok(texts(all.blocks).some((t) => t.includes("Card number password field, filled (19 characters)")), JSON.stringify(all.blocks));
      await run("page.text_visible@1");
      await run("page.text@1");
      const card = byName(f.fields, "Card number").ref;
      const et = await run("element.text@1", { ref: card });
      assert.deepEqual(texts(et.blocks), ["password field, filled (19 characters)"]);
      await inPage(env, `(() => { const c = document.getElementById("card"); c.focus(); c.select(); return 1; })()`);
      const sel = await run("page.selection@1");
      assert.deepEqual({ ...sel.selection, field: sel.selection.field.name }, { text: null, length: 19, masked: true, field: "Card number" });
      await run("page.find@1", { text: "Card" });
      // Finding a secret's digits finds nothing: no match, no count, no highlight.
      for (const secret of ["4111", "6011", "902614"]) {
        const probe = await call(env, "page.find@1", { text: secret });
        assert.deepEqual([probe.count, probe.matches, probe.highlighted], [0, [], false], `find ${secret}: ${JSON.stringify(probe)}`);
      }
      // A focused sensitive field whose selection cannot be read lets no other selection through.
      await inPage(env, `(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("h1")); getSelection().removeAllRanges(); getSelection().addRange(r); document.getElementById("csc").focus(); return 1; })()`);
      assert.equal((await run("page.selection@1")).selection, null);
      assert.equal((await run("context.get@1")).selection, null);
      await inPage(env, `(document.activeElement.blur(), getSelection().removeAllRanges(), 1)`);
      await go(env, "compare.html");
      const t = await run("table.read@1", { ref: await refOf(env, "Card") });
      // The header cell beside a cell that holds only a field heads its row.
      assert.deepEqual(
        t.cells.map((x) => [x.text, x.header ?? null, x.row_headers]),
        [
          ["Card", "row", []],
          ["password field, filled (19 characters)", null, ["Card"]],
        ],
      );
      await go(env, "login.html");
      await run("page.fields@1");
      await run("page.text_all@1");
      const out = JSON.stringify(said);
      for (const secret of ["4111", "902614", "example-secret-1", "example-secret-2", "5500", "6011"]) assert.ok(!out.includes(secret), `${secret} was reported`);
    },
  },
  {
    name: "page.links and page.fields read a large page whole (frames, shadow roots), page.controls only the view; timings",
    async fn(env) {
      await home(env);
      const GROUPS = 500;
      await go(env, `large?groups=${GROUPS}`);
      const frameGroups = 3 * 20;
      const time = async (op) => {
        const t0 = performance.now();
        const r = await call(env, op, {}, { ms: 60000 });
        return { r, ms: performance.now() - t0 };
      };
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(await time("page.controls@1"));
      const c = runs.at(-1).r;
      assert.ok(c.controls.length > 20 && c.controls.length < 400, `${c.controls.length} controls in view`);
      assert.deepEqual(c.frames, { read: 4, unread: 0, unread_frames: [] });
      assert.ok(c.controls.some((x) => x.name === "Link x-0"), "the cross-origin frame's controls in view");
      const links = await time("page.links@1");
      const fields = await time("page.fields@1");
      assert.equal(links.r.links.length, (GROUPS + frameGroups) * PER_GROUP.links);
      assert.equal(fields.r.fields.length, (GROUPS + frameGroups) * PER_GROUP.fields);
      const inView = links.r.links.filter((x) => x.in_view).length;
      assert.ok(inView > 0 && inView < links.r.links.length / 4, `${inView} links in view`);
      assert.ok(links.r.links.some((x) => x.name === "Link 495"), "a link in a closed shadow root");
      assert.ok(links.r.links.some((x) => x.name === "Image link 490"), "a link in an open shadow root");
      const text = await time("page.text_all@1");
      const ms = runs.map((r) => Math.round(r.ms));
      console.log(
        `       large page (${GROUPS * PER_GROUP.controls} controls + ${frameGroups * PER_GROUP.controls} in 3 frames): page.controls ${c.controls.length} in view, ms ${ms.join(", ")} (median ${median(ms)}); page.links ${links.r.links.length} in ${Math.round(links.ms)} ms; page.fields ${fields.r.fields.length} in ${Math.round(fields.ms)} ms; page.text_all ${text.r.blocks.length} blocks in ${Math.round(text.ms)} ms`,
      );
      // A bound far above the figures logged, against a regression by an order of magnitude.
      assert.ok(median(ms) < 2000, `page.controls took ${median(ms)} ms (median)`);
    },
  },
  {
    name: "page.text_all: the whole page in reading order, the cross-origin frame at its place, a closed shadow root and headings with refs",
    async fn(env) {
      await home(env);
      const t = await call(env, "page.text_all@1");
      const consent = await env.ext(`browser.webNavigation.getAllFrames({ tabId: ${t.tab.id} }).then((f) => f.find((x) => x.url.includes("consent")).frameId)`);
      assert.deepEqual(
        t.blocks.map((b) => [b.text, b.heading ?? null, b.frame ?? null]),
        [
          ["Northwind Gear, shop.example", null, null],
          ["Shop Journal Help", null, null],
          ["Search the shop Search", null, null],
          ["Lamps and tents", 1, null],
          ["Gear for long evenings outside.", null, null],
          ["shop.example uses cookies to remember your cart.", null, consent],
          ["Accept all cookies Reject optional cookies", null, consent],
          ["Trail Lamp", 2, null],
          ["A lamp for the trail. 29 €", null, null],
          ["Add Trail Lamp to cart", null, null],
          ["Ridge Tent", 2, null],
          ["Two people, three seasons.", null, null],
          ["Add Ridge Tent to cart", null, null],
          ["Camp Stove", 2, null],
          ["Boils a litre in four minutes.", null, null],
          ["Add Camp Stove to cart", null, null],
          ["Pocket Knife", 2, null],
          ["Eleven tools, one blade.", null, null],
          ["Add Pocket Knife to cart", null, null],
          ["Northwind Gear, 198.51.100.7 is our test address.", null, null],
        ],
      );
      const h = t.blocks.find((b) => b.text === "Ridge Tent");
      assert.equal((await call(env, "element.describe@1", { ref: h.ref })).name, "Ridge Tent");
      assert.deepEqual(t.frames, { read: 2, unread: 0, unread_frames: [] });
    },
  },
  {
    name: "page.text_visible: the text in view, frames clipped to their part in view, and after scrolling",
    async fn(env) {
      await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const top = texts((await call(env, "page.text_visible@1")).blocks);
      assert.ok(top.includes("Lamps and tents") && top.includes("shop.example uses cookies to remember your cart."), JSON.stringify(top));
      assert.ok(!top.includes("Eleven tools, one blade."));
      await inPage(env, `(document.getElementById("p4").scrollIntoView({ block: "start" }), 1)`);
      const low = texts((await call(env, "page.text_visible@1")).blocks);
      assert.ok(low.includes("Eleven tools, one blade."), JSON.stringify(low));
      assert.ok(!low.includes("Lamps and tents") && !low.includes("shop.example uses cookies to remember your cart."), JSON.stringify(low));
    },
  },
  {
    name: "frames: the frames that could not be read, with their origin, the reason and their title; a sandboxed frame is read",
    async fn(env) {
      const user = await home(env);
      await go(env, "frames.html");
      const all = await env.ext(`browser.webNavigation.getAllFrames({ tabId: ${user} })`);
      const restricted = all.find((f) => f.url.includes("127.0.0.2")).frameId;
      const want = { read: 3, unread: 1, unread_frames: [{ frame: restricted, origin: `http://127.0.0.2:${env.site.port}`, code: "restricted_domain", title: "Partner offers" }] };
      const t = await call(env, "page.text_all@1");
      assert.deepEqual(t.frames, want);
      assert.deepEqual(t.blocks.find((b) => b.unread), { frame: restricted, origin: `http://127.0.0.2:${env.site.port}`, unread: "restricted_domain", title: "Partner offers" });
      const other = `http://localhost:${env.site.port}`;
      assert.ok(t.blocks.filter((b) => b.frame && !b.unread).every((b) => b.origin === other || b.origin === `http://127.0.0.1:${env.site.port}`), JSON.stringify(t.blocks));
      const c = await call(env, "page.controls@1");
      const accept = byName(c.controls, "Accept all cookies");
      assert.deepEqual([typeof accept.frame, accept.origin], ["number", other]);
      const described = await call(env, "element.describe@1", { ref: accept.ref });
      assert.deepEqual([described.frame, described.origin], [accept.frame, other]);
      assert.equal((await call(env, "element.describe@1", { ref: t.blocks[0].ref })).origin, `http://127.0.0.1:${env.site.port}`);
      assert.ok(!("frame" in t.blocks[0]) && !("origin" in t.blocks[0]), "the top document's blocks carry neither");
      assert.ok(texts(t.blocks).includes("Write to help@shop.example."), "the sandboxed frame (sandbox without allow-scripts) is read");
      assert.deepEqual((await call(env, "context.get@1")).frames, want);
      assert.deepEqual((await call(env, "page.outline@1")).frames, want);
    },
  },
  {
    name: "page.text_visible and page.controls: a scroll container's hidden part and text beyond the view's width are out of view; a block cut by the edge comes whole",
    async fn(env) {
      await home(env);
      await go(env, "view.html");
      await inPage(env, `(scrollTo(0, 0), document.getElementById("pane").scrollTop = 200, 1)`);
      const all = texts((await call(env, "page.text_all@1")).blocks);
      const seen = texts((await call(env, "page.text_visible@1")).blocks);
      assert.ok(all.includes("Off to the right of the view.") && !seen.includes("Off to the right of the view."), JSON.stringify(seen));
      assert.ok(all.includes("Text directly in a shadow root."), JSON.stringify(all));
      const note = await call(env, "page.find@1", { text: "directly in a shadow" });
      assert.deepEqual(note.matches.map((m) => m.sentence), ["Text directly in a shadow root."]);
      assert.ok(seen.includes("Pane line 6 Pane button 6") && seen.includes("Pane line 8 Pane button 8"), JSON.stringify(seen));
      for (const out of [1, 5, 9, 12]) assert.ok(!seen.includes(`Pane line ${out} Pane button ${out}`), `pane line ${out} is scrolled out of the pane: ${JSON.stringify(seen)}`);
      const names = (await call(env, "page.controls@1")).controls.map((x) => x.name);
      assert.ok(names.includes("Pane button 6") && names.includes("Pane button 8"), JSON.stringify(names));
      for (const out of [1, 5, 9, 12]) assert.ok(!names.includes(`Pane button ${out}`), `pane button ${out}: ${JSON.stringify(names)}`);
      const links = await call(env, "page.fields@1");
      assert.deepEqual(links.fields, []);
      // The paragraph's first lines are above the view: it comes whole all the same.
      await inPage(env, `(() => { const p = document.getElementById("cut"); scrollTo(0, p.getBoundingClientRect().top + scrollY + 60); return 1; })()`);
      const cut = all.find((t) => t.startsWith("The first part of a long paragraph"));
      assert.ok(cut.endsWith("a little past its first lines."), cut);
      const now = texts((await call(env, "page.text_visible@1")).blocks);
      assert.ok(now.includes(cut), `${JSON.stringify(now)} has not ${JSON.stringify(cut)}`);
    },
  },
  {
    name: "page.text: the article Readability finds, whole, with what it left out; without one, all the text",
    async fn(env) {
      await home(env);
      await go(env, "journal.html");
      const a = await call(env, "page.text@1");
      assert.equal(a.article, true, JSON.stringify(a).slice(0, 400));
      assert.equal(a.title, "Three nights in the hills");
      assert.equal(a.byline, "By Ada Example");
      const t = texts(a.blocks);
      assert.ok(t.some((x) => x.startsWith("We set out on a Thursday")) && t.some((x) => x.includes("the most luxurious thing we had ever seen.")), JSON.stringify(t));
      assert.ok(!t.some((x) => x.includes("Lovely trip")), "comments are left out");
      assert.ok(!t.some((x) => x.includes("Draft note") || x.includes("Hidden aside")), "what the page's stylesheet hides is left out");
      const second = a.blocks.find((b) => b.text === "The second night");
      assert.equal(second.heading, 2);
      assert.equal((await call(env, "element.describe@1", { ref: second.ref })).name, "The second night");
      assert.deepEqual(a.left_out, { navigation: 1, banner: 1, contentinfo: 1, complementary: 3, comments: 1 });
      // A shop page: headlines and buttons, no article.
      await go(env, "shop.html");
      const s = await call(env, "page.text@1");
      assert.equal(s.article, false);
      assert.equal(typeof s.why, "string");
      const all = await call(env, "page.text_all@1");
      assert.deepEqual(s.blocks, all.blocks);
    },
  },
  {
    name: "element.text: a heading's section, a paragraph, a field's value; frames inside an element are read",
    async fn(env) {
      await home(env);
      const o = await call(env, "page.outline@1");
      const trail = await call(env, "element.text@1", { ref: byName(o.items, "Trail Lamp").ref });
      assert.deepEqual([trail.role, trail.level, trail.section], ["heading", 2, true]);
      assert.deepEqual(texts(trail.blocks), ["Trail Lamp", "A lamp for the trail. 29 €", "Add Trail Lamp to cart"]);
      const main = await call(env, "element.text@1", { ref: byName(o.items, "Lamps and tents").ref });
      assert.ok(texts(main.blocks).includes("shop.example uses cookies to remember your cart."), "the frame in the section");
      assert.ok(texts(main.blocks).includes("Eleven tools, one blade."));
      const m = byName(o.items, "Cookie banner");
      const banner = await call(env, "element.text@1", { ref: m.ref });
      assert.equal(banner.section, false);
      assert.ok(!("level" in banner), "a level only for a heading");
      assert.deepEqual(texts(banner.blocks), ["shop.example uses cookies to remember your cart.", "Accept all cookies Reject optional cookies"]);
      await go(env, "journal.html");
      const j = await call(env, "page.outline@1");
      const first = await call(env, "element.text@1", { ref: byName(j.items, "The first night").ref });
      assert.deepEqual(texts(first.blocks).map((x) => x.slice(0, 24)), ["The first night", "The first camp was a she", "Gear note: the Trail Lam"]);
    },
  },
  {
    name: "table.read: cells with their row and column headers through rowspan, colspan, headers ids and an ARIA table",
    async fn(env) {
      await home(env);
      await go(env, "compare.html");
      const t = await call(env, "table.read@1", { ref: await refOf(env, "1.8 kg") });
      assert.equal(t.role, "table");
      assert.equal(t.caption, "Tents compared");
      assert.equal(t.name, "Tents compared");
      assert.equal(t.rows, 5);
      assert.equal(t.columns, 4);
      const cell = (text) => {
        const c = t.cells.find((x) => x.text === text);
        assert.ok(c, `no cell ${text}`);
        return c;
      };
      assert.deepEqual(cell("1.8 kg"), { row: 3, column: 3, text: "1.8 kg", column_headers: ["Weight", "Trail"], row_headers: ["Ridge Tent"] });
      assert.deepEqual(cell("2.9 kg"), { row: 4, column: 2, text: "2.9 kg", colspan: 2, column_headers: ["Weight", "Packed", "Trail"], row_headers: ["Valley Tent"] });
      assert.deepEqual(cell("149 €"), { row: 4, column: 4, text: "149 €", rowspan: 2, column_headers: ["Price"], row_headers: ["Valley Tent", "Lake Tent"] });
      assert.deepEqual(cell("3.4 kg"), { row: 5, column: 2, text: "3.4 kg", column_headers: ["Weight", "Packed"], row_headers: ["Lake Tent"] });
      assert.deepEqual(cell("Tent"), { row: 1, column: 1, text: "Tent", rowspan: 2, header: "column", column_headers: [], row_headers: [] });
      assert.deepEqual(cell("Lake Tent"), { row: 5, column: 1, text: "Lake Tent", header: "row", column_headers: ["Tent"], row_headers: [] });
      assert.equal((await call(env, "element.describe@1", { ref: t.ref })).role, "table");
      const d = await call(env, "table.read@1", { ref: await refOf(env, "9.90") });
      assert.deepEqual(d.cells.find((x) => x.text === "9.90 €"), { row: 2, column: 3, text: "9.90 €", column_headers: ["Express"], row_headers: ["Germany"] });
      assert.deepEqual(d.cells.find((x) => x.text === "6.90 €"), { row: 3, column: 2, text: "6.90 €", column_headers: ["Standard"], row_headers: ["Austria"] });
      const h = await call(env, "table.read@1", { ref: await refOf(env, "10–14") });
      assert.equal(h.name, "Opening hours");
      assert.deepEqual(h.cells.find((x) => x.text === "10–14"), { row: 3, column: 2, text: "10–14", column_headers: ["Hours"], row_headers: ["Saturday"] });
      // Section header rows and a repeated header row: the nearer header hides one further up
      // at the same place; hidden rows and cells are left out.
      const sch = await call(env, "table.read@1", { ref: await refOf(env, "closed") });
      assert.deepEqual([sch.rows, sch.columns], [7, 2]);
      const at = (text) => sch.cells.find((x) => x.text === text);
      assert.deepEqual(at("closed"), { row: 5, column: 2, text: "closed", column_headers: ["Hours", "Weekend"], row_headers: [] });
      assert.deepEqual(at("10–12").column_headers, ["Weekend", "Hours"]);
      assert.deepEqual(at("Monday").column_headers, ["Day", "Weekdays"]);
      assert.ok(!sch.cells.some((x) => /hidden|never/i.test(x.text)), JSON.stringify(sch.cells));
      const e = await fails(env, "table.read@1", { ref: await refOf(env, "side by side") }, "not_a_table");
      assert.match(e.message, /^ref \d+ \(paragraph\) is no table and is in none$/);
    },
  },
  {
    name: "table.read: a large table with headers ids answers within content_ms",
    async fn(env) {
      await home(env);
      const ROWS = 4000;
      const COLS = 8;
      await go(env, `table?rows=${ROWS}&cols=${COLS}`);
      const ref = await refOf(env, "Cell 0-0");
      const t0 = performance.now();
      const t = await call(env, "table.read@1", { ref }, { ms: 60000 });
      const ms = Math.round(performance.now() - t0);
      console.log(`       large table (${ROWS} rows, ${COLS} columns, ${t.cells.length} cells): table.read in ${ms} ms`);
      assert.deepEqual([t.rows, t.columns, t.cells.length], [ROWS + 1, COLS + 1, (ROWS + 1) * (COLS + 1)]);
      assert.deepEqual(t.cells.find((x) => x.text === "Cell 1234-5"), { row: 1236, column: 7, text: "Cell 1234-5", column_headers: ["Column 5"], row_headers: ["Row 1234"] });
      assert.deepEqual(t.cells.find((x) => x.text === "Row 3999"), { row: 4001, column: 1, text: "Row 3999", header: "row", column_headers: [], row_headers: [] });
    },
  },
  {
    name: "page.selection: a selection across elements, whole; in a cross-origin frame; none",
    async fn(env) {
      await home(env);
      const text = await inPage(
        env,
        `(() => { document.activeElement?.blur(); const r = document.createRange(); r.setStartBefore(document.querySelector("#p1 h2")); r.setEndAfter(document.querySelector("#p2 p")); getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString(); })()`,
      );
      const s = await call(env, "page.selection@1");
      assert.deepEqual(s.selection, { text, length: [...text].length, masked: false, field: null });
      assert.ok(text.includes("Trail Lamp") && text.includes("Two people, three seasons."));
      await inPage(env, `(getSelection().removeAllRanges(), 1)`);
      assert.equal((await call(env, "page.selection@1")).selection, null);
      const ctx = await frameContext(env, "consent.html");
      const inFrame = await env.ff.evalIn(ctx, `(() => { const r = document.createRange(); r.selectNodeContents(document.body); getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString(); })()`);
      const f = await call(env, "page.selection@1");
      const consent = await env.ext(`browser.webNavigation.getAllFrames({ tabId: ${f.tab.id} }).then((x) => x.find((y) => y.url.includes("consent")).frameId)`);
      assert.deepEqual(f.selection, { text: inFrame, length: [...inFrame].length, masked: false, field: null, frame: consent, origin: `http://localhost:${env.site.port}` });
      assert.ok(inFrame.includes("remember your cart") && inFrame.includes("Reject optional cookies"));
      await env.ff.evalIn(ctx, `(getSelection().removeAllRanges(), 1)`);
    },
  },
  {
    name: "page.find: Firefox's matches, highlighted, each with its element and sentence, in a frame and a closed shadow root",
    async fn(env) {
      const user = await home(env);
      const f = await call(env, "page.find@1", { text: "cart" });
      assert.equal(f.text, "cart");
      assert.equal(f.highlighted, true);
      assert.equal(f.matches.length, f.count);
      const lines = f.matches.map((m) => [m.element?.role, m.element?.name, m.sentence, m.frame ? "frame" : "top"]);
      assert.deepEqual(lines, [
        ["button", "Add Trail Lamp to cart", "Add Trail Lamp to cart", "top"],
        ["button", "Add Ridge Tent to cart", "Add Ridge Tent to cart", "top"],
        ["button", "Add Camp Stove to cart", "Add Camp Stove to cart", "top"],
        ["button", "Add Pocket Knife to cart", "Add Pocket Knife to cart", "top"],
        ["paragraph", "", "shop.example uses cookies to remember your cart.", "frame"],
      ]);
      // Firefox holds exactly `count` ranges for the tab: the last one highlights, one more is out of range.
      await env.ext(`browser.find.highlightResults({ tabId: ${user}, rangeIndex: ${f.count - 1}, noScroll: true })`);
      const out = await env.ext(`browser.find.highlightResults({ tabId: ${user}, rangeIndex: ${f.count}, noScroll: true }).then(() => "highlighted", (e) => e.message)`);
      assert.equal(out, "index supplied was out of range");
      const p = await call(env, "page.find@1", { text: "for the trail" });
      assert.deepEqual(p.matches.map((m) => [m.element.role, m.sentence]), [["paragraph", "A lamp for the trail."]]);
      // Matches only in a child frame.
      const consent = await env.ext(`browser.webNavigation.getAllFrames({ tabId: ${user} }).then((f) => f.find((x) => x.url.includes("consent")).frameId)`);
      const inFrame = await call(env, "page.find@1", { text: "remember your" });
      assert.deepEqual(
        { count: inFrame.count, matches: inFrame.matches.map((m) => ({ ...m, element: m.element?.role })) },
        { count: 1, matches: [{ text: "remember your", element: "paragraph", sentence: "shop.example uses cookies to remember your cart.", frame: consent, origin: `http://localhost:${env.site.port}` }] },
      );
      const none = await call(env, "page.find@1", { text: "xylophone" });
      assert.deepEqual({ count: none.count, matches: none.matches, highlighted: none.highlighted }, { count: 0, matches: [], highlighted: false });
      await fails(env, "page.find@1", {}, "bad_args");
      await fails(env, "page.find@1", { text: " " }, "bad_args");
    },
  },
  {
    name: "pdf.bytes: a PDF in Firefox's viewer as base64, in pieces when over 1 MiB; a page is no PDF",
    async fn(env) {
      const user = await home(env);
      await fails(env, "pdf.bytes@1", {}, "not_pdf");
      await go(env, "prices.pdf");
      const p = await call(env, "pdf.bytes@1");
      const file = readFileSync(join(ROOT, "tests", "site", "prices.pdf"));
      assert.deepEqual({ ...p, base64: undefined }, { tab: { id: user, title: p.tab.title, url: env.site.url("prices.pdf") }, url: env.site.url("prices.pdf"), content_type: "application/pdf", bytes: file.length, base64: undefined });
      assert.ok(Buffer.from(p.base64, "base64").equals(file));
      await go(env, "big.pdf");
      const { result } = env.conn().op("pdf.bytes@1");
      const big = await result;
      assert.ok(big._split && big._split.pieces >= 2, "the answer came in pieces");
      assert.ok(Buffer.from(big.ok.base64, "base64").equals(bigPdf()));
      const e = await fails(env, "page.text_all@1", {}, "pdf_viewer");
      assert.match(e.message, /PDF in Firefox's viewer/);
      // A URL that redirects when fetched again: `url` is where the bytes came from.
      await go(env, "moved.pdf");
      const moved = await call(env, "pdf.bytes@1");
      assert.deepEqual([moved.url, moved.tab.url, moved.bytes], [env.site.url("prices.pdf"), env.site.url("moved.pdf"), file.length]);
    },
  },
  {
    name: "pdf.bytes asks the server again, not the tab's cache, and a cancel ends its fetch",
    async fn(env) {
      await home(env);
      // The PDF is served cacheable once; a second request hangs.
      await go(env, "once.pdf");
      await fails(env, "page.text_all@1", {}, "pdf_viewer");
      const c = env.conn();
      const { id, result } = c.op("pdf.bytes@1");
      await waitFor(() => env.site.hungOpen() === 1, { what: "pdf.bytes requesting the PDF again" });
      const t0 = Date.now();
      c.send({ t: "cancel", id });
      const r = await result;
      assert.equal(r.error?.code, "cancelled", JSON.stringify(r).slice(0, 300));
      assert.ok(Date.now() - t0 < 2000);
      await waitFor(() => env.site.hungOpen() === 0, { what: "the fetch ended" });
      // The URL now answers a page (release() answers the hanging request with one).
      const again = c.op("pdf.bytes@1");
      await waitFor(() => env.site.hungOpen() === 1, { what: "pdf.bytes requesting the PDF once more" });
      env.site.release();
      const late = (await again.result).error;
      assert.equal(late?.code, "not_pdf", JSON.stringify(late));
      assert.match(late.message, /^the PDF's URL now answers 'text\/html; charset=utf-8' and no PDF; tab \d+ shows the PDF of an earlier answer$/);
      assert.deepEqual([late.url, late.response_url], [env.site.url("once.pdf"), env.site.url("once.pdf")]);
    },
  },
  {
    name: "stale refs into element.text, table.read and element.point say why",
    async fn(env) {
      const user = await home(env);
      await go(env, "compare.html");
      const cell = await refOf(env, "1.8 kg");
      const intro = await refOf(env, "side by side");
      await inPage(env, `(document.getElementById("intro").remove(), 1)`);
      for (const [op, args] of [
        ["element.text@1", { ref: intro }],
        ["table.read@1", { ref: intro }],
        ["element.point@1", { ref: intro, ms: 100 }],
      ]) {
        const e = await fails(env, op, args, "stale_element");
        assert.equal(e.message, `ref ${intro}'s element is no longer in the page of tab ${user} (the page removed it)`);
      }
      await go(env, "help.html");
      for (const [op, args] of [
        ["element.text@1", { ref: cell }],
        ["table.read@1", { ref: cell }],
        ["element.point@1", { ref: cell, ms: 100 }],
      ]) {
        const e = await fails(env, op, args, "stale_document");
        assert.deepEqual(e, { code: "stale_document", message: `ref ${cell} is from the page before the last navigation in tab ${user}`, tab: user, title: "Help: Northwind Gear", url: env.site.url("help.html") });
      }
      await fails(env, "element.point@1", { ref: cell }, "bad_args");
      await fails(env, "element.point@1", { ref: cell, ms: 0 }, "bad_args");
      const long = await fails(env, "element.point@1", { ref: cell, ms: 2 ** 31 }, "bad_args");
      assert.equal(long.message, "element.point@1's 'ms' must be a whole number from 1 to 2147483647, not the number 2147483648");
    },
  },
  {
    name: "content_ms: reading a page whose script keeps it busy fails with content_timeout; then it answers again",
    async fn(env) {
      const user = await home(env);
      const t = (await call(env, "tabs.open@1", { url: env.site.url("busy.html", "localhost") })).tab.id;
      const ctx = (await env.ff.send("browsingContext.getTree", {})).contexts.find((c) => c.url.includes("busy.html")).context;
      const outline = await call(env, "page.outline@1", { tab: t });
      const ref = outline.items.find((i) => i.name === "Busy").ref;
      await env.ext(`browser.storage.local.set({ content_ms: 500 })`);
      try {
        await env.ff.evalIn(ctx, `(spin(4000), 1)`);
        await sleep(100);
        const t0 = Date.now();
        const e = await fails(env, "page.text_all@1", { tab: t }, "content_timeout");
        assert.ok(Date.now() - t0 < 2500, `answered after ${Date.now() - t0} ms`);
        assert.deepEqual(e, { code: "content_timeout", message: `tab ${t} did not answer within 500 ms (Kai for Firefox's setting content_ms): its page is busy, or its script is stuck`, tab: t, title: "Busy: Northwind Gear", url: env.site.url("busy.html", "localhost") });
        const d = await fails(env, "element.text@1", { ref }, "content_timeout");
        assert.match(d.message, new RegExp(`^ref ${ref}'s page in tab ${t} did not answer within 500 ms`));
      } finally {
        await env.ext(`browser.storage.local.remove("content_ms")`);
      }
      await waitFor(async () => (await call(env, "page.text_all@1", { tab: t }).catch(() => null))?.blocks.length, { ms: 10000, what: "the busy page answering again" });
      await call(env, "tabs.close@1", { tab: t });
      await call(env, "tabs.switch@1", { tab: user });
    },
  },
];

// Hints and pointing (design §5.4): labels numbered with the refs over the controls in view, in
// every frame, out of the page's reach; redrawn for the new view after a scroll; gone with a
// navigation (also into the back-forward cache) and with hints.hide; element.point's ring.
import assert from "node:assert/strict";
import { call, waitFor, inPage, sleep } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";

const framesOf = (env, tab) => env.ext(`browser.webNavigation.getAllFrames({ tabId: ${tab} })`);
// What the content script of a frame has drawn.
const overlay = (env, tab, frameId = 0) => env.ext(`browser.tabs.sendMessage(${tab}, { kai: "overlay_state" }, { frameId: ${frameId} })`);
const shownRefs = (s) => (s.hints ?? []).filter((l) => l.shown).map((l) => Number(l.text));

export default [
  {
    name: "hints.show: labels numbered with the refs over the controls in view, in the cross-origin frame too, out of the page's CSS",
    async fn(env) {
      const user = await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      // Page rules aimed at overlays.
      await inPage(
        env,
        `(() => { const s = document.createElement("style"); s.textContent = "html > div, [popover], :popover-open { display: none !important; opacity: 0 !important; visibility: hidden !important; } div { filter: opacity(0) !important; transform: scale(0) !important; }"; document.head.append(s); return 1; })()`,
      );
      try {
        const h = await call(env, "hints.show@1");
        assert.deepEqual(h, await call(env, "page.controls@1"), "the same lines and refs as page.controls");
        const consent = (await framesOf(env, user)).find((f) => f.url.includes("consent")).frameId;
        const top = await overlay(env, user);
        const frame = await overlay(env, user, consent);
        assert.deepEqual(top.host, { display: "block", visibility: "visible", opacity: "1", pointer_events: "none", top_layer: true });
        const inFrame = new Set(["Accept all cookies", "Reject optional cookies"]);
        assert.deepEqual(
          shownRefs(top),
          h.controls.filter((x) => !inFrame.has(x.name)).map((x) => x.ref),
        );
        assert.deepEqual(
          shownRefs(frame),
          h.controls.filter((x) => inFrame.has(x.name)).map((x) => x.ref),
        );
        // pointer-events: none: what is under a label is the page's control, not the label.
        for (const l of [...top.hints, ...frame.hints]) assert.ok(l.under && l.under !== "generic", `label ${l.text} is over ${l.under}`);
        assert.equal((await call(env, "hints.hide@1")).shown, true);
      } finally {
        await inPage(env, `(document.querySelector("head style:last-of-type").remove(), 1)`);
      }
    },
  },
  {
    name: "hints: redrawn for the new view after a scroll; gone after a navigation, also from the back-forward cache",
    async fn(env) {
      const user = await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const h = await call(env, "hints.show@1");
      const shop = h.controls.find((x) => x.name === "Shop").ref;
      assert.ok(shownRefs(await overlay(env, user)).includes(shop));
      await inPage(env, `(document.getElementById("p3").scrollIntoView({ block: "start" }), 1)`);
      // The button in the closed shadow root comes into view and is labelled.
      const after = await waitFor(
        async () => {
          const s = await overlay(env, user);
          return s.hints?.some((l) => l.shown && Number(l.text) > shop && l.under === "button") && !shownRefs(s).includes(shop) && s;
        },
        { what: "the hints redrawn for the new view" },
      );
      const c = await call(env, "page.controls@1");
      assert.deepEqual(shownRefs(after), c.controls.map((x) => x.ref));
      assert.ok(c.controls.some((x) => x.name === "Add Camp Stove to cart"));
      await call(env, "tabs.go@1", { url: env.site.url("help.html") });
      assert.deepEqual(await overlay(env, user), { host: null, hints: null, ring: null, mark: null });
      assert.equal((await call(env, "hints.hide@1")).shown, false, "the navigation ended the tab's hints");
      // A page restored from the back-forward cache shows no labels from before. Firefox 159
      // restores a page from it about four times in five here (with or without hints), so the
      // step is repeated until one is restored.
      let restored = 0;
      for (let i = 0; i < 8 && !restored; i++) {
        await call(env, "tabs.go@1", { url: env.site.url("cached-a.html") });
        await call(env, "hints.show@1");
        assert.ok(shownRefs(await overlay(env, user)).length > 0);
        await call(env, "tabs.go@1", { url: env.site.url("cached-b.html") });
        await call(env, "tabs.back@1");
        restored = await inPage(env, "window.restored");
      }
      assert.equal(restored, 1, "Back restored the page from the back-forward cache (8 tries)");
      assert.deepEqual(await overlay(env, user), { host: null, hints: null, ring: null, mark: null });
      await inPage(env, "(scrollTo(0, 50), 1)");
      await sleep(400);
      assert.deepEqual(await overlay(env, user), { host: null, hints: null, ring: null, mark: null }, "scrolling does not bring them back");
    },
  },
  {
    name: "hints: the labels are not the page's text, its find or its outline",
    async fn(env) {
      await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const before = await call(env, "page.text_all@1");
      const seen = await call(env, "page.text_visible@1");
      const h = await call(env, "hints.show@1");
      try {
        assert.ok(h.controls.length > 3);
        assert.deepEqual(await call(env, "page.text_all@1"), before);
        assert.deepEqual(await call(env, "page.text_visible@1"), seen);
        // A label's number is found nowhere in the page.
        const label = String(h.controls[0].ref);
        const f = await call(env, "page.find@1", { text: label });
        assert.ok(!f.matches.some((m) => m.text === label && !m.element), JSON.stringify(f));
      } finally {
        await call(env, "hints.hide@1");
      }
    },
  },
  {
    name: "hints: a page script that removes or hides the labels' host gets it back",
    async fn(env) {
      const user = await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const h = await call(env, "hints.show@1");
      try {
        const want = h.controls.filter((x) => !["Accept all cookies", "Reject optional cookies"].includes(x.name)).map((x) => x.ref);
        const back = (what) =>
          waitFor(
            async () => {
              const s = await overlay(env, user);
              return s.host?.top_layer && s.host.display === "block" && JSON.stringify(shownRefs(s)) === JSON.stringify(want);
            },
            { ms: 3000, what },
          );
        // The host is the element after the body.
        await inPage(env, `(document.body.nextElementSibling.remove(), 1)`);
        await back("the host put back after the page removed it");
        await inPage(env, `(document.body.nextElementSibling.style.display = "none", 1)`);
        await back("the host shown again after the page hid it");
        await inPage(env, `(document.body.nextElementSibling.hidePopover(), 1)`);
        await back("the host in the top layer again after the page closed its popover");
      } finally {
        await call(env, "hints.hide@1");
      }
    },
  },
  {
    name: "hints.hide during a redraw: the redraw draws nothing",
    async fn(env) {
      const user = await home(env);
      await call(env, "tabs.go@1", { url: env.site.url("view.html") });
      await inPage(env, "(scrollTo(0, 0), 1)");
      await call(env, "hints.show@1");
      assert.ok(shownRefs(await overlay(env, user)).length > 0);
      // The scroll's redraw asks the page for its controls while the page is busy; hints.hide
      // comes meanwhile and waits for the page too.
      await inPage(env, "(busyAfterScroll(1500), scrollBy(0, 5), 1)");
      await sleep(500);
      const r = await call(env, "hints.hide@1");
      assert.equal(r.shown, true);
      await sleep(800);
      for (const f of await framesOf(env, user)) assert.deepEqual(await overlay(env, user, f.frameId), { host: null, hints: null, ring: null, mark: null }, `frame ${f.frameId}`);
    },
  },
  {
    name: "hints.hide removes the labels from every frame",
    async fn(env) {
      const user = await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const h = await call(env, "hints.show@1");
      const r = await call(env, "hints.hide@1");
      assert.deepEqual(r, { tab: h.tab, shown: true, removed: h.controls.length });
      for (const f of await framesOf(env, user)) assert.deepEqual(await overlay(env, user, f.frameId), { host: null, hints: null, ring: null, mark: null });
      await inPage(env, "(scrollTo(0, 400), 1)");
      await sleep(400);
      assert.equal((await overlay(env, user)).hints, null);
    },
  },
  {
    name: "element.point: a ring around the element, scrolled into view when it is not, gone after ms",
    async fn(env) {
      const user = await home(env);
      await inPage(env, "(scrollTo(0, 0), 1)");
      const ref = (await call(env, "page.find@1", { text: "Add Pocket Knife" })).matches[0].element.ref;
      const p = await call(env, "element.point@1", { ref, ms: 700 });
      assert.deepEqual(p, { ref, tab: { id: user, title: "Northwind Gear: lamps and tents", url: env.site.url("shop.html") }, role: "button", name: "Add Pocket Knife to cart", ms: 700, scrolled: true });
      const s = await overlay(env, user);
      assert.equal(s.ring.shown, true);
      assert.equal(s.ring.under, "button");
      assert.equal(s.host.top_layer, true);
      await waitFor(async () => (await overlay(env, user)).host === null, { ms: 3000, what: "the ring gone" });
      const again = await call(env, "element.point@1", { ref, ms: 300 });
      assert.equal(again.scrolled, false, "in view now");
      await waitFor(async () => (await overlay(env, user)).host === null, { ms: 3000, what: "the ring gone" });
      // An element that is not shown gets no ring.
      await inPage(env, `(document.getElementById("buy4").style.display = "none", 1)`);
      try {
        const hidden = await call(env, "element.point@1", { ref, ms: 300 });
        assert.deepEqual([hidden.hidden, hidden.scrolled], [true, false]);
        assert.deepEqual(await overlay(env, user), { host: null, hints: null, ring: null, mark: null });
      } finally {
        await inPage(env, `(document.getElementById("buy4").style.display = "", 1)`);
      }
    },
  },
];

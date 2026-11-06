// Reading aloud, the page side (design §7.3): read.open lists the page's paragraphs in reading
// order (frames spliced in, hidden text and Kai's own drawings out, sensitive values masked) and
// where to start (a ref, else the focus, else the top of the view); read.paragraph gives one as
// text and cleaned for speech; read.mark draws the reading mark and scrolls it into view (and
// answers marked: false for a paragraph the page took away); a navigation ends the session, and a
// session that ends without Kai's doing (its tab navigates, closes, is discarded) is a read_ended
// event at once, whether or not events are on.
import assert from "node:assert/strict";
import { call, fails, inPage, frameContext, siteOrigin, sleep, waitFor } from "../lib/util.mjs";
import { home } from "./tabs.test.mjs";
import { refByText } from "./act.test.mjs";

const TEXTS = [
  "Three nights in the hills",
  "We left at dawn [1] and walked **north** along the ridge.",
  "The route is at https://maps.example/ridge and questions go to trips@journal.example.",
  "The tent held through the storm 🙂 ★ and we slept well.",
  "The hut sits on 1200 m² of meadow.",
  "Am dritten Tag regnete es.",
  "Water at the second bridge.",
  "Camp above the lake.",
  "Read the packing list before you go.",
  "Hut code password field, filled (15 characters)",
  "On the last morning we packed up and walked down.",
];
const overlay = (env, tab, frameId = 0) => env.ext(`browser.tabs.sendMessage(${tab}, { kai: "overlay_state" }, { frameId: ${frameId} })`);

// The user's tab on aloud.html, its frame loaded, at the top, nothing focused.
async function onAloud(env) {
  const user = await home(env);
  await call(env, "tabs.go@1", { tab: user, url: env.site.url("aloud.html") });
  await frameContext(env, "aloud-frame.html");
  await inPage(env, "(scrollTo(0, 0), document.activeElement?.blur(), 1)");
  return user;
}
// aloud-more.html's paragraphs.
const MORE = [
  "Bonjour, said the guide at the gate.",
  "3. Oktober was the opening day, under § 5 of the club rules.",
  "1. FC Köln played the first match.",
  "Gate code password field, filled (15 characters)",
  "Your gate code password field, filled (15 characters) opens the side door.",
  "The first note in the box.",
  "The second note in the box.",
  "The last note in the box.",
  "This paragraph moves when the page shifts it.",
];
async function onMore(env) {
  const user = await home(env);
  await call(env, "tabs.go@1", { tab: user, url: env.site.url("aloud-more.html") });
  await inPage(env, "(scrollTo(0, 0), document.activeElement?.blur(), 1)");
  return user;
}
const paragraphs = async (env, s) => {
  const out = [];
  for (let i = 0; i < s.paragraphs; i++) out.push(await call(env, "read.paragraph@1", { session: s.session, index: i }));
  return out;
};


// ---- read_ended ----
const events = (env, from) => env.conn().frames.slice(from).filter((f) => f.t === "event");
const readEnds = (env, from) => events(env, from).filter((f) => f.kind === "read_ended");
// Where the frames of the link are now: events after it are the test's.
const framesNow = (env) => env.conn().frames.length;
const readEnded = (env, from, session) => env.conn().next((f) => f.t === "event" && f.kind === "read_ended" && f.session === session, { from, what: `the read_ended event of session ${session}`, ms: 10000 });
const eventsConfig = (env, on, quiet_ms = 400) => call(env, "events.config@1", on ? { on, quiet_ms } : { on });
// What a read_ended event carries besides its numbering: no page of the tab, whatever the tab
// shows now.
const ofEnd = (e) => {
  assert.ok(Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.at) && typeof e.focused === "boolean", JSON.stringify(e));
  const { seq, at, focused, ...rest } = e;
  void seq, void at, void focused;
  return rest;
};
// A reading session in a tab of its own that the user is not in (aloud.html): the tab, its BiDi
// context and the session. The user's tab stays the shop.
async function readingAway(env) {
  await home(env);
  const url = env.site.url("aloud.html");
  const tab = (await call(env, "tabs.open@1", { url, active: false })).tab.id;
  const ctx = (await env.ff.send("browsingContext.getTree", {})).contexts.find((c) => c.context !== env.ff.context && c.url === url).context;
  const s = await call(env, "read.open@1", { tab });
  return { tab, ctx, s };
}
const closeQuietly = (env, tab) => call(env, "tabs.close@1", { tab }).catch(() => {});

export default [
  {
    name: "read.open: the page's paragraphs in reading order, the frame's spliced in, hidden text left out, a password masked; from the top of the view",
    async fn(env) {
      const user = await onAloud(env);
      const s = await call(env, "read.open@1");
      assert.ok(Number.isSafeInteger(s.session) && s.session > 0);
      assert.deepEqual(s.tab, { id: user, title: "Three nights in the hills: Northwind Journal", url: env.site.url("aloud.html") });
      assert.deepEqual([s.paragraphs, s.start, s.from], [TEXTS.length, 0, "view"]);
      assert.deepEqual(s.frames, { read: 2, unread: 0, unread_frames: [] });
      const ps = await paragraphs(env, s);
      assert.deepEqual(
        ps.map((p) => p.text),
        TEXTS,
      );
      const frameId = (await env.ext(`browser.webNavigation.getAllFrames({ tabId: ${user} })`)).find((f) => f.url.includes("aloud-frame")).frameId;
      for (const [i, p] of ps.entries()) {
        assert.equal(p.session, s.session);
        assert.equal(p.index, i);
        assert.deepEqual(p.tab, s.tab);
        assert.ok(Number.isSafeInteger(p.ref), `paragraph ${i} has a ref`);
        const inFrame = i === 6 || i === 7;
        assert.equal(p.frame, inFrame ? frameId : 0);
        assert.equal(p.origin, siteOrigin(env, inFrame ? "localhost" : "127.0.0.1"));
        assert.equal(p.lang, inFrame ? "en-GB" : i === 5 ? "de" : "en");
      }
      assert.equal(ps[0].heading, 1);
      assert.ok(!("heading" in ps[1]));
      // The paragraph's ref names its element: the same as page.text_all's heading ref, and
      // element.describe says what it is.
      const all = await call(env, "page.text_all@1");
      assert.equal(ps[0].ref, all.blocks[0].ref);
      assert.equal((await call(env, "element.describe@1", { ref: ps[10].ref })).role, "paragraph");
      assert.ok(!JSON.stringify(ps).includes("hunter2"));
      await call(env, "read.close@1", { session: s.session });
    },
  },
  {
    name: "read.paragraph: spoken is the text through the speech rules (citations, markdown, URLs, emoji; superscripts kept), each switchable",
    async fn(env) {
      await onAloud(env);
      const s = await call(env, "read.open@1");
      try {
        const spoken = async (index, rules) => (await call(env, "read.paragraph@1", { session: s.session, index, ...(rules ? { rules } : {}) })).spoken;
        assert.equal(await spoken(1), "We left at dawn and walked north along the ridge.");
        assert.equal(await spoken(2), "The route is at and questions go to.");
        assert.equal(await spoken(3), "The tent held through the storm and we slept well.");
        assert.equal(await spoken(4), "The hut sits on 1200 m² of meadow.");
        assert.equal(await spoken(4, { superscripts: true }), "The hut sits on 1200 m of meadow.");
        assert.equal(await spoken(1, { citations: false }), "We left at dawn [1] and walked north along the ridge.");
        assert.equal(await spoken(1, { markdown: false, citations: false }), TEXTS[1]);
        await fails(env, "read.paragraph@1", { session: s.session, index: 1, rules: { emoji: false } }, "bad_args");
        await fails(env, "read.paragraph@1", { session: s.session, index: TEXTS.length }, "bad_args");
      } finally {
        await call(env, "read.close@1", { session: s.session });
      }
    },
  },
  {
    name: "read.open: from a ref (also one in a frame), else from the focused element, else the first paragraph in view",
    async fn(env) {
      const user = await onAloud(env);
      const end = await refByText(env, "packed up", "paragraph");
      let s = await call(env, "read.open@1", { ref: end });
      assert.deepEqual([s.start, s.from], [10, "ref"]);
      const bridge = await refByText(env, "second bridge", "paragraph");
      s = await call(env, "read.open@1", { ref: bridge });
      assert.deepEqual([s.start, s.from], [6, "ref"]);
      // A link inside a paragraph starts at that paragraph.
      const list = (await call(env, "page.links@1")).links.find((l) => l.name === "packing list").ref;
      s = await call(env, "read.open@1", { ref: list });
      assert.deepEqual([s.start, s.from], [8, "ref"]);
      await fails(env, "read.open@1", { ref: list, tab: user }, "bad_args");

      await inPage(env, `(document.getElementById("list").focus(), scrollTo(0, 0), 1)`);
      s = await call(env, "read.open@1");
      assert.deepEqual([s.start, s.from], [8, "focus"]);
      await inPage(env, `(document.activeElement.blur(), document.getElementById("p6").scrollIntoView({ block: "start" }), 1)`);
      s = await call(env, "read.open@1", { tab: user });
      assert.deepEqual([s.start, s.from], [8, "view"]);
      // No paragraph in view: the next one below.
      await inPage(env, `(document.querySelector(".spacer").scrollIntoView({ block: "start" }), scrollBy(0, 400), 1)`);
      s = await call(env, "read.open@1");
      assert.deepEqual([s.start, s.from], [10, "below_view"]);
      await call(env, "read.close@1", { session: s.session });
    },
  },
  {
    name: "read.mark: the paragraph highlighted and scrolled into view, in a frame too; cleared without an index",
    async fn(env) {
      const user = await onAloud(env);
      const s = await call(env, "read.open@1");
      try {
        const m = await call(env, "read.mark@1", { session: s.session, index: 10 });
        assert.deepEqual(m, { session: s.session, index: 10, marked: true, scrolled: true });
        const box = await inPage(env, `(() => { const r = document.getElementById("end").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, h: innerHeight }; })()`);
        assert.ok(box.top >= 0 && box.bottom <= box.h, `the paragraph is in view: ${JSON.stringify(box)}`);
        let o = await overlay(env, user);
        assert.equal(o.mark.session, s.session);
        assert.equal(o.mark.shown, true);
        assert.ok(o.mark.y <= box.top && o.mark.y + o.mark.h >= box.bottom && o.mark.x <= box.left, `the mark is around it: ${JSON.stringify(o.mark)}`);
        // Marked again where it is: nothing scrolls.
        assert.equal((await call(env, "read.mark@1", { session: s.session, index: 10 })).scrolled, false);
        // The mark is not the page's text.
        assert.deepEqual(
          (await call(env, "page.text_all@1")).blocks.map((b) => b.text),
          TEXTS,
        );

        const f = await call(env, "read.mark@1", { session: s.session, index: 6 });
        assert.deepEqual([f.marked, f.scrolled], [true, true]);
        const frameId = (await env.ext(`browser.webNavigation.getAllFrames({ tabId: ${user} })`)).find((x) => x.url.includes("aloud-frame")).frameId;
        assert.equal((await overlay(env, user)).mark, null, "the top document's mark moved into the frame");
        o = await overlay(env, user, frameId);
        assert.equal(o.mark.shown, true);
        const frameBox = await inPage(env, `(() => { const r = document.getElementById("notes").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight }; })()`);
        assert.ok(frameBox.top >= 0 && frameBox.top < frameBox.h, `the frame is in view: ${JSON.stringify(frameBox)}`);

        assert.deepEqual(await call(env, "read.mark@1", { session: s.session }), { session: s.session, index: null, marked: false, scrolled: false });
        assert.equal((await overlay(env, user, frameId)).mark, null);
        assert.equal((await overlay(env, user)).host, null, "nothing of Kai's is left in the page");
      } finally {
        await call(env, "read.close@1", { session: s.session });
      }
    },
  },
  {
    name: "reading sessions end: a navigation (also to another path by pushState, not by a query), another read.open in the tab, read.close; unknown ids",
    async fn(env) {
      const user = await onAloud(env);
      let s = await call(env, "read.open@1");
      await call(env, "read.mark@1", { session: s.session, index: 1 });
      await call(env, "tabs.go@1", { tab: user, url: env.site.url("help.html") });
      let e = await fails(env, "read.paragraph@1", { session: s.session, index: 0 }, "session_ended");
      assert.deepEqual([e.why, e.tab], ["navigated", user]);
      await fails(env, "read.mark@1", { session: s.session, index: 0 }, "session_ended");

      await onAloud(env);
      s = await call(env, "read.open@1");
      await inPage(env, `(history.pushState(null, "", "?page=2"), 1)`);
      await sleep(200);
      assert.equal((await call(env, "read.paragraph@1", { session: s.session, index: 1 })).text, TEXTS[1], "a query of its own does not end it");
      await call(env, "read.mark@1", { session: s.session, index: 1 });
      await inPage(env, `(history.pushState(null, "", "/trips/hills"), 1)`);
      await sleep(200);
      e = await fails(env, "read.paragraph@1", { session: s.session, index: 1 }, "session_ended");
      assert.equal(e.why, "navigated");
      assert.equal((await overlay(env, user)).mark, null, "its mark is gone");

      await onAloud(env);
      const a = await call(env, "read.open@1");
      const b = await call(env, "read.open@1");
      assert.ok(b.session > a.session);
      assert.equal((await fails(env, "read.paragraph@1", { session: a.session, index: 0 }, "session_ended")).why, "replaced");
      assert.deepEqual(await call(env, "read.close@1", { session: b.session }), { session: b.session, closed: true });
      assert.deepEqual(await call(env, "read.close@1", { session: b.session }), { session: b.session, closed: false, why: "closed" });
      assert.equal((await fails(env, "read.paragraph@1", { session: b.session, index: 0 }, "session_ended")).why, "closed");
      await fails(env, "read.paragraph@1", { session: 1, index: 0 }, "unknown_session");
      await fails(env, "read.close@1", { session: 1 }, "unknown_session");
    },
  },
  {
    name: "read.open leaves Kai's hint labels out of the paragraphs, and refuses Firefox's own pages",
    async fn(env) {
      await onAloud(env);
      await call(env, "hints.show@1");
      try {
        const s = await call(env, "read.open@1");
        assert.deepEqual(
          (await paragraphs(env, s)).map((p) => p.text),
          TEXTS,
        );
        await call(env, "read.close@1", { session: s.session });
      } finally {
        await call(env, "hints.hide@1");
      }
      // Firefox refuses its own pages to extensions; BiDi opens one as the user would.
      await env.ff.send("browsingContext.navigate", { context: env.ff.context, url: "about:robots", wait: "complete" });
      await fails(env, "read.open@1", {}, "firefox_page");
    },
  },
  {
    name: "read.paragraph on page text: lang is the paragraph's own, a sensitive value echoed in the text is masked, list numbers and § stay in spoken",
    async fn(env) {
      await onMore(env);
      const s = await call(env, "read.open@1");
      try {
        const ps = await paragraphs(env, s);
        assert.deepEqual(
          ps.map((p) => p.text),
          MORE,
        );
        assert.equal(ps[0].lang, "en", "a paragraph that begins with French words is the paragraph's language");
        assert.equal(ps[1].spoken, MORE[1], "'3. Oktober' and '§ 5' stay");
        assert.equal(ps[2].spoken, MORE[2], "'1. FC Köln' stays");
        assert.ok(!JSON.stringify(ps).includes("hunter2"), "the value echoed in page text is masked");
      } finally {
        await call(env, "read.close@1", { session: s.session });
      }
    },
  },
  {
    name: "read.open: a ref or a focus with no paragraph at or after it starts by the view; a page without paragraphs answers start and from null",
    async fn(env) {
      await onMore(env);
      const notes = (await call(env, "page.fields@1")).fields.find((f) => f.name === "Notes").ref;
      let s = await call(env, "read.open@1", { ref: notes });
      assert.deepEqual([s.paragraphs, s.start, s.from], [MORE.length, 0, "view"]);
      await inPage(env, `(document.getElementById("notes").focus({ preventScroll: true }), scrollTo(0, 0), 1)`);
      s = await call(env, "read.open@1");
      assert.deepEqual([s.start, s.from], [0, "view"]);
      await call(env, "read.close@1", { session: s.session });
      await call(env, "tabs.go@1", { url: env.site.url("aloud-empty.html") });
      s = await call(env, "read.open@1");
      assert.deepEqual([s.paragraphs, s.start, s.from], [0, null, null]);
      await call(env, "read.close@1", { session: s.session });
    },
  },
  {
    name: "read.mark: a scroll container with smooth scrolling is scrolled at once; the mark follows a paragraph the page moves without a resize or a scroll",
    async fn(env) {
      const user = await onMore(env);
      const s = await call(env, "read.open@1");
      try {
        const m = await call(env, "read.mark@1", { session: s.session, index: 7 });
        assert.deepEqual([m.marked, m.scrolled], [true, true]);
        const fits = await inPage(
          env,
          `(() => { const b = document.getElementById("box"), r = b.getBoundingClientRect(), p = document.getElementById("b3").getBoundingClientRect(); const top = r.top + b.clientTop; return p.top >= top - 1 && p.bottom <= top + b.clientHeight + 1 && p.top >= 0 && p.bottom <= innerHeight; })()`,
        );
        assert.equal(fits, true, "the last note is in the box's view and the page's when read.mark answers");

        await call(env, "read.mark@1", { session: s.session, index: 8 });
        const was = (await overlay(env, user)).mark;
        await inPage(env, `(document.getElementById("shift").style.transform = "translateY(60px)", 1)`);
        const moved = await waitFor(
          async () => {
            const now = (await overlay(env, user)).mark;
            return Math.abs(now.y - (was.y + 60)) < 1 ? now : null;
          },
          { what: "the mark 60 px lower" },
        );
        const top = await inPage(env, `document.getElementById("moving").getBoundingClientRect().top`);
        assert.ok(moved.y <= top && moved.y + moved.h >= top, `the mark is around the moved paragraph: ${JSON.stringify(moved)}, top ${top}`);
      } finally {
        await call(env, "read.close@1", { session: s.session });
      }
    },
  },
  {
    name: "read_ended: the reading tab navigated while the user is elsewhere says navigated at once, with events off; a pushState to another path, Kai's own tabs.go; a query of its own, once",
    async fn(env) {
      await eventsConfig(env, false);
      let { tab, ctx, s } = await readingAway(env);
      try {
        const from = framesNow(env);
        await env.ff.evalIn(ctx, `(location.href = ${JSON.stringify(env.site.url("help.html"))}, 1)`);
        const e = await readEnded(env, from, s.session);
        assert.deepEqual(ofEnd(e), { t: "event", kind: "read_ended", by_kai: false, session: s.session, tab, why: "navigated" });
        // At once: the session was not asked about. Its calls say the same, and it is not told again.
        assert.deepEqual(
          events(env, from).map((f) => f.kind),
          ["read_ended"],
          "events are off: nothing else came",
        );
        const err = await fails(env, "read.paragraph@1", { session: s.session, index: 0 }, "session_ended");
        assert.deepEqual([err.why, err.tab], ["navigated", tab]);
        assert.deepEqual(await call(env, "read.close@1", { session: s.session }), { session: s.session, closed: false, why: "navigated" });
        await sleep(300);
        assert.equal(readEnds(env, from).length, 1, "told once");

        // A same-document navigation to another path ends it; a query of its own does not (the
        // positive control comes after it, and nothing before).
        await call(env, "tabs.go@1", { tab, url: env.site.url("aloud.html") });
        s = await call(env, "read.open@1", { tab });
        const f2 = framesNow(env);
        const ctx2 = (await env.ff.send("browsingContext.getTree", {})).contexts.find((c) => c.context !== env.ff.context && c.url === env.site.url("aloud.html")).context;
        await env.ff.evalIn(ctx2, `(history.pushState(null, "", "?page=2"), 1)`);
        await env.ff.evalIn(ctx2, `(history.pushState(null, "", "/trips/hills"), 1)`);
        const path = await readEnded(env, f2, s.session);
        assert.deepEqual([path.why, path.by_kai], ["navigated", false]);
        assert.deepEqual(readEnds(env, f2).length, 1, "the query alone said nothing");

        // Kai's own navigation of the tab ends it too, and says so.
        await call(env, "tabs.go@1", { tab, url: env.site.url("aloud.html") });
        s = await call(env, "read.open@1", { tab });
        const f3 = framesNow(env);
        await call(env, "tabs.go@1", { tab, url: env.site.url("help.html") });
        const kai = await readEnded(env, f3, s.session);
        assert.deepEqual([kai.why, kai.by_kai, kai.tab], ["navigated", true, tab]);
      } finally {
        await closeQuietly(env, tab);
      }
    },
  },
  {
    name: "read_ended: with events on in the user's tab it follows the navigated event of the same navigation; the page changing its own text does not end the session",
    async fn(env) {
      const user = await onAloud(env);
      await eventsConfig(env, true);
      try {
        const s = await call(env, "read.open@1");
        const from = framesNow(env);
        await inPage(env, `(document.getElementById("p1").textContent = "Changed under the session.", 1)`);
        assert.equal((await call(env, "read.mark@1", { session: s.session, index: 4 })).marked, true, "the session lives");
        assert.deepEqual(readEnds(env, from), []);
        await call(env, "tabs.go@1", { tab: user, url: env.site.url("help.html") });
        const e = await readEnded(env, from, s.session);
        const nav = events(env, from).find((f) => f.kind === "navigated" && f.url.endsWith("/help.html"));
        assert.ok(nav && nav.seq < e.seq, `navigated (${nav?.seq}) comes before read_ended (${e.seq})`);
        assert.deepEqual([e.why, e.by_kai, e.tab], ["navigated", true, user]);
        assert.deepEqual(
          events(env, from).filter((f) => f.kind === "read_ended").map((f) => f.session),
          [s.session],
        );
      } finally {
        await eventsConfig(env, false);
      }
    },
  },
  {
    name: "read_ended: the reading tab closed says tab_closed (by_kai for tabs.close, not for the user's close), with events off",
    async fn(env) {
      await eventsConfig(env, false);
      let { tab, s } = await readingAway(env);
      try {
        const from = framesNow(env);
        await env.ext(`browser.tabs.remove(${tab})`);
        const e = await readEnded(env, from, s.session);
        assert.deepEqual(ofEnd(e), { t: "event", kind: "read_ended", by_kai: false, session: s.session, tab, why: "tab_closed" });
        const err = await fails(env, "read.mark@1", { session: s.session, index: 0 }, "session_ended");
        assert.deepEqual([err.why, err.tab], ["tab_closed", tab]);

        ({ tab, s } = await readingAway(env));
        const f2 = framesNow(env);
        await call(env, "tabs.close@1", { tab });
        const kai = await readEnded(env, f2, s.session);
        assert.deepEqual([kai.why, kai.by_kai, kai.tab], ["tab_closed", true, tab]);
        assert.equal(readEnds(env, from).length, 2);
      } finally {
        await closeQuietly(env, tab);
      }
    },
  },
  {
    name: "read_ended: a discarded reading tab says discarded",
    async fn(env) {
      await eventsConfig(env, false);
      const { tab, s } = await readingAway(env);
      try {
        const from = framesNow(env);
        await env.ext(`browser.tabs.discard([${tab}])`);
        const e = await readEnded(env, from, s.session);
        assert.deepEqual(ofEnd(e), { t: "event", kind: "read_ended", by_kai: false, session: s.session, tab, why: "discarded" });
        assert.equal((await fails(env, "read.paragraph@1", { session: s.session, index: 0 }, "session_ended")).why, "discarded");
      } finally {
        await closeQuietly(env, tab);
      }
    },
  },
  {
    name: "read_ended: Kai's own read.close and a read.open that replaces a session say nothing; the next end that is not Kai's does",
    async fn(env) {
      await eventsConfig(env, false);
      const { tab, s: first } = await readingAway(env);
      try {
        const from = framesNow(env);
        const second = await call(env, "read.open@1", { tab });
        assert.deepEqual((await fails(env, "read.paragraph@1", { session: first.session, index: 0 }, "session_ended")).why, "replaced");
        assert.deepEqual(await call(env, "read.close@1", { session: second.session }), { session: second.session, closed: true });
        const third = await call(env, "read.open@1", { tab });
        // The positive control: the tab navigates, and that is the only end Kai is told of.
        await call(env, "tabs.go@1", { tab, url: env.site.url("help.html") });
        const e = await readEnded(env, from, third.session);
        assert.equal(e.why, "navigated");
        await sleep(300);
        assert.deepEqual(
          readEnds(env, from).map((f) => f.session),
          [third.session],
          "neither the replaced session nor the closed one came",
        );
      } finally {
        await closeQuietly(env, tab);
      }
    },
  },
  {
    name: "read.mark: a paragraph the page took away answers marked: false with why removed (also text replaced in place), one whose frame is gone frame_left; the session goes on",
    async fn(env) {
      const user = await onAloud(env);
      const s = await call(env, "read.open@1");
      try {
        assert.equal((await call(env, "read.mark@1", { session: s.session, index: 3 })).marked, true);
        assert.ok((await overlay(env, user)).mark, "paragraph 3 is marked");
        await inPage(env, `(document.getElementById("p1").remove(), 1)`);
        assert.deepEqual(await call(env, "read.mark@1", { session: s.session, index: 1 }), { session: s.session, index: 1, marked: false, scrolled: false, why: "removed" });
        assert.equal((await overlay(env, user)).mark, null, "nothing is drawn");
        // The text replaced in place: the old text node is gone, the paragraph is not.
        assert.equal((await call(env, "read.mark@1", { session: s.session, index: 2 })).marked, true);
        await inPage(env, `(document.getElementById("p2").textContent = "Replaced in place.", 1)`);
        const replaced = await call(env, "read.mark@1", { session: s.session, index: 2 });
        assert.deepEqual([replaced.marked, replaced.why], [false, "removed"]);
        // Its other paragraphs can still be marked and read; reading one is no error either.
        const again = await call(env, "read.mark@1", { session: s.session, index: 4 });
        assert.deepEqual([again.marked, again.index], [true, 4]);
        assert.equal((await call(env, "read.paragraph@1", { session: s.session, index: 1 })).text, TEXTS[1], "the paragraph's text is as read.open found it");
        // A paragraph of a frame the page removed.
        await inPage(env, `(document.getElementById("notes").remove(), 1)`);
        assert.deepEqual(await call(env, "read.mark@1", { session: s.session, index: 6 }), { session: s.session, index: 6, marked: false, scrolled: false, why: "frame_left" });
        // Clearing is not a failure: no why.
        assert.deepEqual(await call(env, "read.mark@1", { session: s.session }), { session: s.session, index: null, marked: false, scrolled: false });
      } finally {
        await call(env, "read.close@1", { session: s.session });
      }
    },
  },
];

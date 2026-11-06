#!/usr/bin/env node
// WP10's measurement of the network gate's noise on real public sites (design §6.4: "WP10
// measures how often"): how often the gate asks after Kai's acting operations, by kind (a write;
// a GET navigation to an origin the user never visited), with the origins involved.
//
//   KAI_BROWSER_HOST=… node tests/accept/noise.mjs [--only <site name part>] [--extension <dir>]
//
// --extension installs another copy of the extension (an earlier commit's `extension/`, from
// `git archive <commit> extension | tar -x -C target/<dir>`), so a change to the gate is measured
// against the build before it on the same day.
//
// - One headless Firefox with a throwaway profile under target/t/<time>/ (tests/lib/env.mjs), the
//   real kai-browser-host and the test harness's fake Kai, which sends the operations as Kai does,
//   each with Kai's default guard (its word list, window_ms 2000).
// - Only these actions: typing a fake-looking search ("kettle example"), pressing search, opening
//   a result (a link of the page where the fake search finds nothing), toggling a menu, scrolling. Nothing is submitted with data, nobody logs in, consent
//   banners are left alone, nothing is bought or posted.
// - The gate's questions are answered as the owner of a careful setup would: a write the page
//   sends is declined (it never leaves), a GET navigation the action itself asked for is allowed.
//   The page side's verdicts (the guard's words) are counted and the action is sent again
//   confirmed, as Kai does after the owner's yes.
// - Every site starts with a navigation Kai's tabs.go makes (no action, no gate). The profile's
//   history is empty, so every other origin counts as never visited: a user's own history would
//   make fewer `unseen_origin` questions.
// - Writes a JSON record to target/noise-<time>.json and prints a table; tests/accept/RESULTS.md
//   holds the figures.
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setup, ROOT } from "../lib/env.mjs";
import { sleep } from "../lib/firefox.mjs";

const QUERY = "kettle example";
const GUARD = {
  words: ["buy", "order", "pay", "checkout", "purchase", "subscribe", "delete", "remove", "send", "transfer", "confirm",
    "kauf", "bestell", "bezahl", "zahlung", "zahlen", "kasse", "abo", "lösch", "entfern", "überweis", "bestätig"],
  window_ms: 2000,
  answer_ms: 15000,
};

// Finders: the first element of a list op whose role and name (and URL) match.
const field = (name) => ({ list: "page.fields@1", key: "fields", role: /^(searchbox|combobox|textbox)$/, name });
const button = (name) => ({ list: "page.controls@1", key: "controls", role: /^button$/, name });
const link = (url, name = /./) => ({ list: "page.links@1", key: "links", role: /^link$/, name, url });

const SITES = [
  {
    name: "Wikipedia (encyclopedia)",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    steps: [
      { act: "type a search", fill: field(/^Search Wikipedia$/) },
      { act: "press search", press: button(/^Search$/) },
      { act: "open a result", press: link(/en\.wikipedia\.org\/wiki\/(?!Special:|Help:|Wikipedia:|Main_Page|Portal:|Talk:)[^:?#]+$/, /ettle|xample/i) },
      { act: "toggle a menu", press: button(/^Main menu$/) },
      { act: "toggle a menu", press: button(/^Main menu$/) },
      { act: "scroll", scroll: "down" },
      { act: "scroll", scroll: "down" },
    ],
  },
  {
    name: "MDN (documentation)",
    url: "https://developer.mozilla.org/en-US/",
    steps: [
      { act: "toggle a menu", press: button(/^HTML$/) },
      { act: "toggle a menu", press: button(/^HTML$/) },
      { act: "toggle a menu (the search)", press: button(/^Search the site$/) },
      { act: "type a search", fill: field(/search/i) },
      { act: "press search", key: "Enter" },
      { act: "open a result", press: link(/developer\.mozilla\.org\/en-US\/docs\//) },
      { act: "scroll", scroll: "down" },
      { act: "scroll", scroll: "down" },
    ],
  },
  {
    name: "Python docs (documentation)",
    url: "https://docs.python.org/3/",
    steps: [
      { act: "open a result (Tutorial)", press: link(/docs\.python\.org\/3\/tutorial\/index\.html$/) },
      { act: "scroll", scroll: "down" },
      { act: "scroll", scroll: "down" },
      { act: "type a search", fill: field(/^Quick search$/) },
      { act: "press search", press: button(/^Go$/), wait: 4000 },
      { act: "scroll", scroll: "down" },
    ],
  },
  {
    name: "tagesschau.de (news front page)",
    url: "https://www.tagesschau.de/",
    steps: [
      { act: "toggle a menu", press: button(/^Hauptmenü$/) },
      { act: "toggle a menu", press: button(/^Hauptmenü/) },
      { act: "open a result (an article)", press: link(/tagesschau\.de\/.+\.html$/, /.{25,}/) },
      { act: "scroll", scroll: "down" },
      { act: "scroll", scroll: "down" },
      { act: "toggle a menu", press: button(/^Hauptmenü/) },
      { act: "type a search", fill: field(/such/i) },
      { act: "press search", key: "Enter" },
    ],
  },
  {
    name: "GitHub rust-lang/rust (code hosting)",
    url: "https://github.com/rust-lang/rust",
    steps: [
      { act: "toggle a menu", press: button(/^Code$/) },
      { act: "toggle a menu", press: button(/^Code$/) },
      { act: "type a search (Go to file)", fill: field(/^Go to file$/) },
      { act: "scroll", scroll: "down" },
      { act: "open a result", press: link(/github\.com\/rust-lang\/rust\/blob\/[^/]+\/README\.md$/) },
      { act: "scroll", scroll: "down" },
    ],
  },
  {
    name: "IKEA search (shop)",
    url: "https://www.ikea.com/de/de/search/?q=wasserkocher",
    steps: [
      { act: "toggle a menu", press: button(/^Sortieren$/) },
      { act: "toggle a menu", press: button(/^Sortieren$/) },
      { act: "scroll", scroll: "down" },
      { act: "open a result", press: link(/ikea\.com\/de\/de\/p\//, /.{10,}/) },
      { act: "scroll", scroll: "down" },
      { act: "type a search", fill: field(/^Suche nach Produkten/) },
      { act: "press search", press: button(/^Suchen$/) },
    ],
  },
];

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const extension = argv.includes("--extension") ? resolve(argv[argv.indexOf("--extension") + 1]) : undefined;
const origin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return String(u);
  }
};

const env = await setup({ extension });
const record = [];
try {
  await env.ready();
  const c = env.conn();
  // The gate's questions, answered as the module doc says, kept by the operation that held them.
  const asks = new Map();
  let seen = 0;
  const answering = setInterval(() => {
    for (; seen < c.frames.length; seen++) {
      const f = c.frames[seen];
      if (f.t !== "ask") continue;
      const allow = f.reason === "unseen_origin" && f.method === "GET";
      c.send({ t: "answer", id: f.id, allow });
      if (!asks.has(f.op)) asks.set(f.op, []);
      asks.get(f.op).push({ reason: f.reason, method: f.method, type: f.type, url: f.url, to: origin(f.url), from: f.origin, allowed: allow });
    }
  }, 20);
  const user = (await c.call("tabs.list@1")).tabs.find((t) => t.user).id;
  const settle = async (extra = 1500) => {
    for (let i = 0; i < 100; i++) {
      const t = (await c.call("tabs.list@1")).tabs.find((x) => x.id === user);
      if (t && !t.loading) break;
      await sleep(200);
    }
    await sleep(extra);
  };
  const findRef = async (f) => {
    const r = await c.call(f.list, {}, { ms: 30000 });
    const hit = r[f.key].find((x) => f.role.test(x.role) && f.name.test(x.name ?? "") && (!f.url || f.url.test(x.url ?? "")) && !x.inert);
    return hit ?? null;
  };
  // One acting operation with the guard; again confirmed when the page side stopped it.
  const acting = async (op, args) => {
    const first = c.op(op, { ...args, guard: GUARD }, { ms: 60000 });
    let r = await first.result;
    const ids = [first.id];
    let verdicts = [];
    if (r.ok?.guard?.length) {
      verdicts = r.ok.guard;
      const again = c.op(op, { ...args, guard: GUARD, confirmed: verdicts }, { ms: 60000 });
      ids.push(again.id);
      r = await again.result;
    }
    await sleep(100);
    return { r, verdicts, asked: ids.flatMap((id) => asks.get(id) ?? []) };
  };
  for (const site of SITES.filter((s) => !only || s.name.includes(only))) {
    const rows = [];
    record.push({ site: site.name, url: site.url, actions: rows });
    console.log(`\n${site.name} (${site.url})`);
    try {
      await c.call("tabs.go@1", { tab: user, url: site.url }, { ms: 60000 });
    } catch (e) {
      console.log(`  could not open it: ${e.message}`);
      continue;
    }
    await settle(3000);
    for (const step of site.steps) {
      const row = { act: step.act, target: null, error: null, verdicts: [], asked: [] };
      rows.push(row);
      try {
        let out;
        if (step.scroll) out = await acting("page.scroll@1", { tab: user, to: step.scroll });
        else if (step.key) out = await acting("page.key@1", { tab: user, keys: step.key });
        else {
          const el = await findRef(step.fill ?? step.press);
          if (!el) throw new Error("not found on the page");
          row.target = `${el.role} ${JSON.stringify(el.name)}`;
          out = step.fill ? await acting("element.fill@1", { ref: el.ref, text: QUERY }) : await acting("element.press@1", { ref: el.ref });
        }
        row.verdicts = out.verdicts.map((v) => `${v.reason}${v.word ? ` "${v.word}"` : ""}${v.where ? ` (${v.where})` : ""}`);
        row.asked = out.asked;
        if (out.r.error) row.error = `${out.r.error.code}: ${out.r.error.message}`;
      } catch (e) {
        row.error = e.message;
      }
      const writes = row.asked.filter((a) => a.reason === "write").length;
      const unseen = row.asked.filter((a) => a.reason === "unseen_origin").length;
      console.log(`  ${step.act.padEnd(28)} ${String(row.target ?? "").slice(0, 50).padEnd(52)} write ${writes}, unseen ${unseen}${row.verdicts.length ? `, guard words: ${row.verdicts.join("; ")}` : ""}${row.error ? `  [${row.error.slice(0, 120)}]` : ""}`);
      for (const a of row.asked) console.log(`      ${a.reason} ${a.method} ${a.type} ${a.to} (from ${a.from})${a.allowed ? " allowed" : " declined"}`);
      await settle(step.wait ?? 1500);
    }
  }
  clearInterval(answering);
} finally {
  const file = join(ROOT, "target", `noise-${Date.now()}.json`);
  await writeFile(file, JSON.stringify({ extension: extension ?? "extension/", sites: record }, null, 2));
  console.log(`\nrecord: ${file}`);
  const { hostsKilled, firefoxLeft } = await env.teardown();
  if (hostsKilled.length) console.log(`killed host processes Firefox left: ${hostsKilled.join(", ")}`);
  if (firefoxLeft.length) console.log(`Firefox processes still there 5 s after Firefox ended: ${firefoxLeft.join(", ")}`);
}

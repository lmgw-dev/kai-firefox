#!/usr/bin/env node
// The sidebar page's look and load time (design §8.4, §8.5): headless Firefox at a device
// scale of 1.25 (a common desktop scale), the real sidebar panel with the page as built in extension/sidebar/
// (scripts/sidebar.sh), the fake Kai answering from the scripted lmgw (tests/lib/fake-lmgw.mjs).
//   node tests/sidebar-shots.mjs [--out <folder>] [--runs <n>]
// Writes sidebar-<width>-<theme>.png for 338 px (Firefox's default sidebar width) and 280 px, light
// and dark, into --out (default target/wp8b-shots/), and prints the load times of --runs (default
// 5) openings: the wasm running (`kai-wasm-started`), the first frame after it (`kai-first-frame`,
// two animation frames later) and the open thread's first message drawn, each in ms since the
// page's navigation began. The first opening is the profile's first (cold).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setup } from "./lib/env.mjs";
import { openSidebar, closeSidebar, inSidebar, sidebarShot, sidebarWidth } from "./lib/sidebar.mjs";
import { fakeLmgw, serveSidebar } from "./lib/fake-lmgw.mjs";
import { call, sleep, waitFor } from "./lib/util.mjs";

const argv = process.argv.slice(2);
const opt = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
const out = opt("--out", join(import.meta.dirname, "..", "target", "wp8b-shots"));
const runs = Number(opt("--runs", "5"));

const env = await setup({ prefs: { "layout.css.devPixelsPerPx": "1.25", "ui.systemUsesDarkTheme": 0 } });
let failed = false;
try {
  await env.ready();
  const lmgw = fakeLmgw();
  // A thread that shows what the Chat draws: markdown, a list, code.
  lmgw.threads[0].title = "A night on the ridge";
  lmgw.messages[1] = [
    { id: 11, thread_id: 1, role: "user", content: "Summarise this page for me, and what would I need to pack?" },
    {
      id: 12,
      thread_id: 1,
      role: "assistant",
      content:
        "The article describes **one night on the ridge above Lake Example**: a two-hour climb, a clear sky and a cold wind after sunset.\n\nTo pack:\n\n- a three-season tent (the *Ridge Tent* is 2.9 kg)\n- a warm layer for the evening\n- the **Trail Lamp** (120 lumens) and spare batteries\n\n```sh\n# the route's GPX, from trails.example\ncurl -O https://trails.example/ridge.gpx\n```",
    },
  ];
  env.kai.rules = (u) => (u.includes("localhost") ? "read" : "act");
  serveSidebar(env.kai, lmgw);
  const list = await call(env, "tabs.list@1");
  const first = list.tabs.find((t) => t.index === 0).id;
  await call(env, "tabs.switch@1", { tab: first });
  await call(env, "tabs.go@1", { tab: first, url: env.site.url("article.html") });

  // Load times: open and close the sidebar `runs` times.
  const times = [];
  for (let i = 0; i < runs; i++) {
    await openSidebar(env.ff, { ready: `performance.getEntriesByName("kai-first-frame").length > 0`, what: "the page's first frame" });
    await waitFor(() => inSidebar(env.ff, `!!document.querySelector(".msg-assistant")`), { what: "the thread's messages", ms: 20000 });
    const t = await inSidebar(
      env.ff,
      `({ wasm: performance.getEntriesByName("kai-wasm-started")[0]?.startTime, frame: performance.getEntriesByName("kai-first-frame")[0]?.startTime, thread: performance.getEntriesByName("kai-thread-drawn")[0]?.startTime ?? null })`,
    );
    times.push(t);
    await closeSidebar(env.ff);
  }
  const fmt = (v) => (v === null || v === undefined ? "-" : `${Math.round(v)} ms`);
  console.log("load (ms since the page's navigation began): wasm running / first frame / first message drawn");
  times.forEach((t, i) => console.log(`  ${i === 0 ? "cold  " : "reload"} ${fmt(t.wasm)} / ${fmt(t.frame)} / ${fmt(t.thread)}`));

  // Screenshots: 338 and 280 px, light and dark (Firefox's colour scheme, changed while the page is
  // open: it follows).
  await mkdir(out, { recursive: true });
  await openSidebar(env.ff, { ready: `!!document.querySelector(".msg-assistant")`, what: "the Chat with its thread" });
  for (const theme of ["light", "dark"]) {
    await env.ff.chromeEval(`(Services.prefs.setIntPref("ui.systemUsesDarkTheme", ${theme === "dark" ? 1 : 0}), "ok")`);
    await waitFor(() => inSidebar(env.ff, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), { what: `the page in ${theme}` });
    for (const width of [338, 280]) {
      await sidebarWidth(env.ff, width);
      await sleep(600);
      const w = await inSidebar(env.ff, `({ inner: innerWidth, scroll: document.documentElement.scrollWidth, dpr: devicePixelRatio })`);
      if (Math.abs(w.inner - width) > 2) console.log(`  note: the panel is ${w.inner} CSS px wide, not ${width}`);
      if (w.scroll > w.inner) {
        console.log(`  FAIL: at ${width} px the page is ${w.scroll} px wide (horizontal overflow)`);
        failed = true;
      }
      const file = join(out, `sidebar-${width}-${theme}.png`);
      await writeFile(file, await sidebarShot(env.ff));
      console.log(`  ${file} (${w.inner} CSS px at ${w.dpr})`);
    }
  }
  await closeSidebar(env.ff);
} finally {
  await env.teardown();
}
process.exit(failed ? 1 : 0);

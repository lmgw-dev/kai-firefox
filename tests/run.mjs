#!/usr/bin/env node
// npm test: the unit tests in Node, then the end-to-end tests against one headless Firefox with
// the extension, the real kai-browser-host and a fake Kai (tests/lib/env.mjs).
//   node tests/run.mjs [--only <substring>] [--unit] [--keep] [--test-ms <ms>]
// --unit runs the unit tests only: no Firefox and no Kai host needed (npm run test:unit, CI's check).
// --keep leaves the run folder under target/t/ for a look at firefox.log.
// Each test has TEST_MS (--test-ms) to finish. One that does not is reported as failed with that
// number and stopped before the next test starts: its signal aborts (waitFor and sleep in
// tests/lib/util.mjs throw), its environment is ended (Firefox, the host, the fake Kai and the
// site, so what it waits on fails), the runner waits for it to return, and the next test gets a
// new environment.
import { setup } from "./lib/env.mjs";
import { useSignal } from "./lib/util.mjs";
import unit from "./unit/frames.test.mjs";
import refsUnit from "./unit/refs.test.mjs";
import actUnit from "./unit/act.test.mjs";
import userUnit from "./unit/user.test.mjs";
import link from "./e2e/link.test.mjs";
import tabs from "./e2e/tabs.test.mjs";
import context from "./e2e/context.test.mjs";
import access from "./e2e/access.test.mjs";
import read from "./e2e/read.test.mjs";
import hints from "./e2e/hints.test.mjs";
import act from "./e2e/act.test.mjs";
import guard from "./e2e/guard.test.mjs";
import facts from "./e2e/facts.test.mjs";
import features from "./e2e/features.test.mjs";
import source from "./e2e/source.test.mjs";
import styles from "./e2e/styles.test.mjs";
import scripts from "./e2e/scripts.test.mjs";
import see from "./e2e/see.test.mjs";
import cssUnit from "./unit/css.test.mjs";
import shotUnit from "./unit/shot.test.mjs";
import docRequestsUnit from "./unit/docrequests.test.mjs";
import htmlFramesUnit from "./unit/htmlframes.test.mjs";
import urlUnit from "./unit/url.test.mjs";
import speechUnit from "./unit/speech.test.mjs";
import releaseUnit from "./unit/release.test.mjs";
import pageTextUnit from "./unit/pagetext.test.mjs";
import sidebarBuildUnit from "./unit/sidebar-build.test.mjs";
import events from "./e2e/events.test.mjs";
import aloud from "./e2e/aloud.test.mjs";
import sidebar from "./e2e/sidebar.test.mjs";
import chat from "./e2e/chat.test.mjs";
import { sidebarExtension } from "./lib/sidebar.mjs";

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const only = opt("--only");
const keep = argv.includes("--keep");
const unitOnly = argv.includes("--unit");
const TEST_MS = opt("--test-ms") === null ? 90000 : Number(opt("--test-ms"));
if (!Number.isSafeInteger(TEST_MS) || TEST_MS < 1) throw new Error(`--test-ms must be a whole number of milliseconds, at least 1, not ${opt("--test-ms")}`);
const pick = (list) => list.filter((t) => !only || t.name.includes(only));

let passed = 0;
const failed = [];
// A promise a test left behind that failed: reported, and the run goes on.
process.on("unhandledRejection", (e) => {
  failed.push(`unhandled: ${e?.message ?? e}`);
  console.log(`  FAIL an unhandled rejection: ${String(e?.stack || e).split("\n").slice(0, 4).join("\n       ")}`);
});

let env = null;
// What the environment is set up with (`setup`'s options); a stopped test's new one gets the same.
let envOpts = {};
async function startEnv(opts = envOpts) {
  envOpts = opts;
  env = await setup(opts);
  console.log(env.host.note);
  await env.ready();
}
async function endEnv() {
  const { hostsKilled, firefoxLeft } = await env.teardown({ keep });
  if (hostsKilled.length) console.log(`killed host processes Firefox left: ${hostsKilled.join(", ")}`);
  if (firefoxLeft.length) console.log(`Firefox processes still there 5 s after Firefox ended: ${firefoxLeft.join(", ")}`);
  env = null;
}

const DONE = Symbol("done");
const LATE = Symbol("late");
async function runOne(t, withEnv) {
  const t0 = Date.now();
  const ac = new AbortController();
  useSignal(ac.signal);
  const test = Promise.resolve().then(() => t.fn(withEnv ? env : undefined));
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve(LATE), TEST_MS)));
  try {
    if ((await Promise.race([test.then(() => DONE), late])) === DONE) {
      passed++;
      console.log(`  ok   ${t.name} (${Date.now() - t0} ms)`);
      return;
    }
  } catch (e) {
    failed.push(t.name);
    console.log(`  FAIL ${t.name} (${Date.now() - t0} ms)\n       ${String(e.stack || e).split("\n").slice(0, 6).join("\n       ")}`);
    return;
  } finally {
    clearTimeout(timer);
  }
  failed.push(t.name);
  console.log(`  FAIL ${t.name}: did not finish within ${TEST_MS} ms (tests/run.mjs TEST_MS, --test-ms); stopping it`);
  ac.abort(new Error(`the test ran over ${TEST_MS} ms`));
  if (withEnv) await endEnv();
  const t1 = Date.now();
  let wait;
  const returned = await Promise.race([test.then(() => true, () => true), new Promise((resolve) => (wait = setTimeout(() => resolve(false), TEST_MS)))]);
  clearTimeout(wait);
  console.log(returned ? `       it returned ${Date.now() - t1} ms after it was stopped` : `       it has not returned ${TEST_MS} ms after it was stopped; its environment is gone, so it cannot touch the next one`);
  if (withEnv) await startEnv();
}

const units = [...pick(unit), ...pick(refsUnit), ...pick(actUnit), ...pick(userUnit), ...pick(cssUnit), ...pick(shotUnit), ...pick(docRequestsUnit), ...pick(htmlFramesUnit), ...pick(urlUnit), ...pick(speechUnit), ...pick(releaseUnit), ...pick(pageTextUnit), ...pick(sidebarBuildUnit)];
if (units.length) {
  console.log("unit");
  for (const t of units) await runOne(t, false);
}
const groups = [
  ["link", link],
  ["tabs", tabs],
  ["context and refs", context],
  ["private windows and restricted pages", access],
  ["reading", read],
  ["hints and pointing", hints],
  ["acting", act],
  ["the commit guard and the network gate", guard],
  ["what the focus rule needs", facts],
  ["Firefox's own features", features],
  ["source and DOM", source],
  ["styles", styles],
  ["scripts", scripts],
  ["screenshots", see],
  ["events", events],
  ["reading aloud", aloud],
].map(([n, list]) => [n, pick(list)]);
if (!unitOnly && groups.some(([, list]) => list.length)) {
  try {
    await startEnv();
    for (const [name, list] of groups) {
      if (!list.length) continue;
      console.log(name);
      for (const t of list) await runOne(t, true);
    }
  } finally {
    if (env) await endEnv();
  }
}
// The sidebar's relay needs a sidebar page, which the shipped extension does not have yet (WP8b):
// its tests run in an environment of their own, with the extension's copy that has the test page.
const sidebarTests = pick(sidebar);
if (!unitOnly && sidebarTests.length) {
  try {
    await startEnv({ extension: await sidebarExtension() });
    console.log("the sidebar's relay (the extension with a test sidebar)");
    for (const t of sidebarTests) await runOne(t, true);
  } finally {
    if (env) await endEnv();
  }
}
// The sidebar page (WP8b): the extension as it ships, with the page built into extension/sidebar/
// (scripts/sidebar.sh), in an environment of its own, as its tests make the fake Kai answer the
// sidebar's requests.
const chatTests = pick(chat);
if (!unitOnly && chatTests.length) {
  try {
    await startEnv({});
    console.log("the sidebar page (lmgw's Chat over the relay)");
    for (const t of chatTests) await runOne(t, true);
  } finally {
    if (env) await endEnv();
  }
}
console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? ": " + failed.join("; ") : ""}`);
process.exit(failed.length ? 1 : 0);

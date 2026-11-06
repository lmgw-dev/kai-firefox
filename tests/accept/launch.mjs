#!/usr/bin/env node
// The kai-firefox side of WP10's acceptance runs (design §6.6, §11): the fixture site and a headless
// Firefox with the extension, whose real kai-browser-host links to the Kai serving --socket (Kai's
// real browser server, started by Kai's driver: `just browser-accept` in Kai). Kai's driver starts
// this process, reads what it prints and ends it; nothing here sends a page a mouse or key event.
//
//   node tests/accept/launch.mjs --socket <path> [--start <path on the site>] [--keep]
//
// - Firefox runs in a transient systemd scope named as Plasma names a Firefox it starts that way
//   (`app-org.mozilla.firefox-<random>.scope`), so Kai's peer check lets its host in with Kai's
//   default `browser.peer_scopes`.
// - The run folder is target/accept/<time>/ (profile, HOME with the native manifest, XDG folders),
//   removed at the end unless --keep.
// - Once the host has connected, the user's tab is taken to --start (default accept/store.html)
//   by WebDriver BiDi's navigate: the page the user had open before talking to Kai. It is no input
//   event, and the extension does not count it as the user's act (user_origin stays null).
// - stdout: one JSON object per line: {"ready": {...}} once the user's tab shows the start page,
//   then one answer per command. stdin: one JSON command per line: {"cmd": "site_log"} (the
//   site's requests, with bodies of writes) or {"cmd": "stop"}; a closed stdin stops too.
// - Stopping ends Firefox, the hosts it left and the site, each by PID with its start time checked,
//   and answers {"stopped": {"left": [...]}}: the run's Firefox processes still there after 5 s
//   (those naming its profile, and its content processes by their -parentPid).
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT, EXT_ID, HOST_NAME, hostBinary, installExtension, fixtureSearchEngine, ourHosts } from "../lib/env.mjs";
import { launchFirefox, sleep } from "../lib/firefox.mjs";
import { serveSite } from "../lib/site.mjs";
import { killChecked, firefoxProcesses } from "../lib/proc.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const socket = opt("--socket");
if (!socket) throw new Error("--socket <path> is required: the browser.sock Kai's driver serves");
const start = opt("--start", "accept/store.html");
const keep = argv.includes("--keep");
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const note = (s) => process.stderr.write(`launch: ${s}\n`);

const host = hostBinary();
const stamp = `${Date.now()}`;
const dir = join(ROOT, "target", "accept", stamp);
for (const d of ["profile", "home/.mozilla/native-messaging-hosts", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "tmp"]) await mkdir(join(dir, d), { recursive: true });
await writeFile(
  join(dir, "home/.mozilla/native-messaging-hosts", `${HOST_NAME}.json`),
  JSON.stringify({ name: HOST_NAME, description: "Kai (acceptance run)", path: host.path, type: "stdio", allowed_extensions: [EXT_ID] }, null, 2),
);
note(host.note);

let site = null;
let ff = null;
let stopping = null;

// Ends everything this process started (module doc); the processes still naming the profile.
async function stop() {
  if (ff) await ff.close().catch(() => ff.killNow());
  for (let i = 0; i < 20 && ourHosts(host.path, socket).length; i++) await sleep(100);
  const hostsLeft = ourHosts(host.path, socket);
  for (const h of hostsLeft) killChecked(h.pid, h.start, "SIGKILL");
  if (site) await site.close();
  // Its content processes end a moment after the main one.
  let left = ff ? firefoxProcesses(ff.paths.profile, ff.pid) : [];
  for (let i = 0; i < 50 && left.length; i++) {
    await sleep(100);
    left = firefoxProcesses(ff.paths.profile, ff.pid);
  }
  if (!keep) await rm(dir, { recursive: true, force: true });
  return { left, hostsKilled: hostsLeft.map((h) => h.pid) };
}
const stopOnce = () => (stopping ??= stop());
function killSync() {
  ff?.killNow();
  for (const h of ourHosts(host.path, socket)) killChecked(h.pid, h.start, "SIGKILL");
}
process.on("exit", killSync);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

try {
  site = await serveSite();
  ff = await launchFirefox({
    dir,
    env: { KAI_BROWSER_SOCKET: socket },
    prefs: { "extensions.webextensions.restrictedDomains": "127.0.0.2" },
    wrap: ["systemd-run", "--user", "--scope", "--quiet", `--unit=app-org.mozilla.firefox-kaiaccept${stamp}x${process.pid}.scope`],
  });
  await fixtureSearchEngine(ff, site);
  await installExtension(ff);
  const t0 = Date.now();
  while (!ourHosts(host.path, socket).length) {
    if (Date.now() - t0 > 20000) throw new Error("Firefox started no kai-browser-host within 20 s");
    await sleep(100);
  }
  await ff.send("browsingContext.navigate", { context: ff.context, url: site.url(start), wait: "complete" });
  say({
    ready: {
      site: site.url(""),
      other: site.url("", "localhost"),
      start: site.url(start),
      firefox: { pid: ff.pid, start: ff.start },
      profile: ff.paths.profile,
      dir,
      host: host.path,
    },
  });
} catch (e) {
  note(`failed to start: ${e.stack || e}`);
  say({ failed: String(e.message || e), stopped: await stopOnce() });
  process.exit(1);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line).cmd;
  } catch {
    say({ error: `not a command: ${line}` });
    return;
  }
  if (cmd === "site_log") say({ site_log: site.log });
  else if (cmd === "stop") lines.close();
  else say({ error: `unknown command ${cmd}` });
});
lines.on("close", async () => {
  say({ stopped: await stopOnce() });
  process.exit(0);
});

// One test environment: a run folder under target/t/, the fixture site, a fake Kai on a socket in
// the run folder, the real kai-browser-host behind a native manifest in the run's
// $HOME/.mozilla/native-messaging-hosts/, and a headless Firefox with the extension installed
// (temporarily, from extension/). teardown() ends every process it started, by PID, and removes
// the run folder.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchFirefox, sleep } from "./firefox.mjs";
import { fakeKai } from "./fake-kai.mjs";
import { serveSite } from "./site.mjs";
import { startTime, killChecked, firefoxProcesses } from "./proc.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXT_DIR = join(ROOT, "extension");
export const EXT_ID = "kai-firefox@rootshell.dev";
export const HOST_NAME = "dev.rootshell.kai";

// The kai-browser-host binary: $KAI_BROWSER_HOST, else ../kai/target/debug/kai-browser-host
// beside the main checkout.
export function hostBinary() {
  if (process.env.KAI_BROWSER_HOST) {
    const p = resolve(process.env.KAI_BROWSER_HOST);
    if (!existsSync(p)) throw new Error(`KAI_BROWSER_HOST is ${p}, which does not exist`);
    return { path: p, note: `kai-browser-host from KAI_BROWSER_HOST: ${p}` };
  }
  let main = ROOT;
  try {
    // A worktree's common git dir is the main checkout's .git.
    main = dirname(execFileSync("git", ["-C", ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  } catch {
    /* not a git checkout: the folder itself */
  }
  const primary = join(dirname(main), "kai", "target", "debug", "kai-browser-host");
  if (existsSync(primary)) return { path: primary, note: `kai-browser-host: ${primary}` };
  throw new Error(`no kai-browser-host: ${primary} does not exist; build it in Kai (cargo build -p kai-browser-host) or set KAI_BROWSER_HOST`);
}

// Our host processes: running the host binary with our socket in their environment.
export function ourHosts(bin, socket) {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readlinkSync(`/proc/${d}/exe`) !== bin) continue;
      if (readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(`KAI_BROWSER_SOCKET=${socket}`)) out.push({ pid: Number(d), start: startTime(Number(d)) });
    } catch {
      /* gone, or not ours */
    }
  }
  return out;
}

// If the harness dies (a signal, an uncaught error), its Firefox and hosts go with it, by PID,
// and the run folder is removed.
const LIVE = new Set();
process.on("exit", () => {
  for (const env of LIVE) env.killSync();
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

// `extension`: the folder of the extension to install (default extension/); noise.mjs measures an
// earlier build with it.
export async function setup({ prefs = {}, extension = EXT_DIR } = {}) {
  const host = hostBinary();
  // The run's folder is named short (the time in base 36): a worktree's long path leaves the test
  // socket's path little room under the 107 bytes a Unix socket takes.
  const dir = join(ROOT, "target", "t", Date.now().toString(36));
  for (const d of ["profile", "home/.mozilla/native-messaging-hosts", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "tmp"]) await mkdir(join(dir, d), { recursive: true });
  // A Unix socket path has at most 107 bytes.
  const socket = join(dir, "kai.sock");
  if (Buffer.byteLength(socket) > 107) throw new Error(`the test socket's path is ${Buffer.byteLength(socket)} bytes, more than a Unix socket takes (107): ${socket}`);
  await writeFile(
    join(dir, "home/.mozilla/native-messaging-hosts", `${HOST_NAME}.json`),
    JSON.stringify({ name: HOST_NAME, description: "Kai (test)", path: host.path, type: "stdio", allowed_extensions: [EXT_ID] }, null, 2),
  );
  const site = await serveSite();
  const kai = await fakeKai(socket);
  const ff = await launchFirefox({
    dir,
    env: { KAI_BROWSER_SOCKET: socket },
    prefs: {
      // 127.0.0.2 stands in for addons.mozilla.org.
      "extensions.webextensions.restrictedDomains": "127.0.0.2",
      ...prefs,
    },
  });
  const env = {
    dir,
    host,
    socket,
    site,
    kai,
    ff,
    // Installs the extension, waits for its link and opens its options page in a background tab
    // (env.page) for reading the extension's state.
    async ready() {
      await fixtureSearchEngine(ff, site);
      const linked = kai.linked();
      await installExtension(ff, extension);
      await linked;
      env.page = await openExtPage(ff, "options/options.html", { select: false });
    },
    // Evaluates an expression in the extension's options page (browser.* available).
    ext: (expr) => ff.evalIn(env.page, expr),
    conn: () => kai.current(),
    // The PIDs of the kai-browser-host processes of this run.
    hosts: () => ourHosts(host.path, socket).map((h) => h.pid),
    killSync() {
      ff.killNow();
      for (const h of ourHosts(host.path, socket)) killChecked(h.pid, h.start, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
    async teardown({ keep = false } = {}) {
      await ff.close().catch(() => ff.killNow());
      LIVE.delete(env);
      // Firefox ends its host with the port; one that outlived it is killed by its PID.
      for (let i = 0; i < 20 && ourHosts(host.path, socket).length; i++) await sleep(100);
      const left = ourHosts(host.path, socket);
      for (const h of left) killChecked(h.pid, h.start, "SIGKILL");
      await kai.stop();
      await site.close();
      // Firefox's content processes end a moment after its main process.
      for (let i = 0; i < 50 && firefoxProcesses(ff.paths.profile, ff.pid).length; i++) await sleep(100);
      if (!keep) await rm(dir, { recursive: true, force: true });
      return { hostsKilled: left.map((h) => h.pid), firefoxLeft: firefoxProcesses(ff.paths.profile, ff.pid).map((p) => p.pid) };
    },
  };
  LIVE.add(env);
  return env;
}

// The test profile's default search engine: the fixture site's /search, so a search never leaves
// the machine.
export async function fixtureSearchEngine(ff, site) {
  return ff.chromeEval(`(async () => {
    const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
    await SearchService.init();
    const e = await SearchService.addUserEngine({ name: "Fixture", url: ${JSON.stringify(site.url("search?q={searchTerms}"))} });
    await SearchService.setDefault(e, SearchService.CHANGE_REASON.UNKNOWN);
    return (await SearchService.getDefault()).name;
  })()`);
}

export async function installExtension(ff, path = EXT_DIR) {
  const r = await ff.send("webExtension.install", { extensionData: { type: "path", path } });
  if (r.extension !== EXT_ID) throw new Error(`installed ${JSON.stringify(r)}`);
  return r;
}

// Opens a moz-extension: page of ours in a new tab of the first window (only the chrome window
// may), selected or in the background, and returns its BiDi context.
export async function openExtPage(ff, path, { select = true } = {}) {
  const url = await ff.chromeEval(`WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)}).getURL(${JSON.stringify(path)})`);
  const add = `gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })`;
  await ff.chromeEval(select ? `(gBrowser.selectedTab = ${add}, "ok")` : `(${add}, "ok")`);
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const c = (await ff.send("browsingContext.getTree", {})).contexts.find((x) => x.url === url);
    if (c) {
      for (let k = 0; k < 100; k++) {
        if (await ff.evalIn(c.context, `document.readyState === "complete"`).catch(() => false)) return c.context;
        await sleep(100);
      }
      return c.context;
    }
  }
  throw new Error(`${path} did not open`);
}

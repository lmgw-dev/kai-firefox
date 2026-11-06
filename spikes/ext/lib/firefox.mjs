// Headless Firefox over WebDriver BiDi for the WP0 spike. Adapted from an earlier
// BiDi launcher: no geckodriver, Firefox speaks BiDi itself
// behind --remote-debugging-port and Node 22 has a WebSocket client.
//
// Every run lives in its own folder under <worktree>/target/ext-spike/: the profile, and HOME,
// XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME and XDG_STATE_HOME, so the test Firefox never
// reads or writes the real ~/.mozilla or ~/.config/mozilla. /tmp may be a RAM-backed tmpfs, so nothing goes there.
// The binary is started directly (/usr/lib64/firefox/firefox), not through Fedora's
// /usr/bin/firefox wrapper, whose langpack step can mkdir inside $HOME/.mozilla or
// $XDG_CONFIG_HOME/mozilla (that would change point (e)'s answer). FIREFOX overrides it.

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKTREE = join(SPIKE, "..", "..");
export const TARGET = join(WORKTREE, "target", "ext-spike");
export const EXT_ID = "kai-firefox-spike@rootshell.dev";
export const HOST_NAME = "dev.rootshell.kai_spike";
export const FIREFOX = process.env.FIREFOX || "/usr/lib64/firefox/firefox";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

// A fresh run folder: profile, fake HOME and XDG dirs, host log folder. Nothing in HOME yet:
// whether $HOME/.mozilla exists is part of what point (e) measures.
export async function makeRun(name) {
  const dir = join(TARGET, `${name}-${Date.now()}`);
  const paths = {
    dir,
    profile: join(dir, "profile"),
    home: join(dir, "home"),
    xdgConfig: join(dir, "xdg-config"),
    xdgCache: join(dir, "xdg-cache"),
    xdgData: join(dir, "xdg-data"),
    xdgState: join(dir, "xdg-state"),
    hostlog: join(dir, "hostlog"),
  };
  for (const [k, d] of Object.entries(paths)) if (k !== "dir") await mkdir(d, { recursive: true });
  return paths;
}

// Writes the spike host's native manifest into `dir` (a native-messaging-hosts folder).
export async function writeHostManifest(dir, { name = HOST_NAME, path = join(SPIKE, "host", "spike_host.py") } = {}) {
  await mkdir(dir, { recursive: true });
  const m = { name, description: "Kai for Firefox WP0 spike host", path, type: "stdio", allowed_extensions: [EXT_ID] };
  await writeFile(join(dir, name + ".json"), JSON.stringify(m, null, 2));
  return join(dir, name + ".json");
}

// /proc/<pid>/stat state letter, or null when the pid is gone. Z (zombie) counts as exited.
export function procState(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2, s.lastIndexOf(")") + 3);
  } catch {
    return null;
  }
}
export const alive = (pid) => {
  const s = procState(pid);
  return s !== null && s !== "Z";
};

// Children of a pid (direct), from /proc/<pid>/task/*/children: Firefox forks from other threads
// than its main one, so every thread's list counts.
export function childrenOf(pid) {
  const out = new Set();
  let tids = [];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  for (const tid of tids) {
    try {
      for (const c of readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").split(/\s+/).filter(Boolean)) out.add(Number(c));
    } catch {
      /* gone */
    }
  }
  return [...out];
}
export function descendants(pid) {
  const all = [];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    for (const c of childrenOf(p)) {
      all.push(c);
      stack.push(c);
    }
  }
  return all;
}
export function rssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
export function pssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/Pss:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
export function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

// Read all host log lines (one JSONL file per host process) of a run.
export function hostEvents(hostlog) {
  const out = [];
  if (!existsSync(hostlog)) return out;
  for (const f of readdirSyncSafe(hostlog)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(hostlog, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* partial line */
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
function readdirSyncSafe(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

// Safety net: if the harness dies, kill the Firefox processes it started and the hosts they
// started (by the PIDs the hosts logged), never by pattern.
const LIVE = new Set();
function killHostsSync(hostlog) {
  for (const e of hostEvents(hostlog)) {
    if (e.ev === "start" && alive(e.pid) && cmdline(e.pid).some((a) => a.endsWith("spike_host.py"))) {
      try {
        process.kill(e.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}
process.on("exit", () => {
  for (const { proc, hostlog } of LIVE) {
    try {
      if (alive(proc.pid)) proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
    killHostsSync(hostlog);
  }
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
process.on("uncaughtException", (e) => {
  console.error(e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error(e);
  process.exit(1);
});

export async function launchFirefox({ run, prefs = {}, env = {}, unset = [], width = 1280, height = 900, bannerTimeout = 30000, args = [] }) {
  const base = {
    "remote.active-protocols": 1,
    "browser.shell.checkDefaultBrowser": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "browser.aboutwelcome.enabled": false,
    "devtools.console.stdout.chrome": true,
    "devtools.console.stdout.content": true,
    "extensions.webextensions.restrictedDomains": "",
  };
  const userJs = Object.entries({ ...base, ...prefs }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  await writeFile(join(run.profile, "user.js"), userJs.join("\n") + "\n");
  const fenv = {
    ...process.env,
    HOME: run.home,
    XDG_CONFIG_HOME: run.xdgConfig,
    XDG_CACHE_HOME: run.xdgCache,
    XDG_DATA_HOME: run.xdgData,
    XDG_STATE_HOME: run.xdgState,
    MOZ_HEADLESS: "1",
    MOZ_CRASHREPORTER_DISABLE: "1",
    // Firefox 159 wants this in the environment, not only --remote-allow-system-access, before
    // BiDi may evaluate in the chrome window.
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
    SPIKE_HOST_LOG: run.hostlog,
    ...env,
  };
  delete fenv.DISPLAY;
  delete fenv.WAYLAND_DISPLAY;
  for (const k of unset) delete fenv[k];
  const logFile = join(run.dir, "firefox.log");
  await writeFile(logFile, "");
  const proc = spawn(FIREFOX, ["--headless", "--no-remote", "--profile", run.profile, "--remote-debugging-port", "0", "--remote-allow-system-access", ...args, "about:blank"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: fenv,
  });
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, t: Date.now() })));
  LIVE.add({ proc, hostlog: run.hostlog });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    let announced = false;
    const onData = (d) => {
      appendFile(logFile, d).catch(() => {});
      if (announced) return;
      buf += d;
      const m = buf.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m) {
        announced = true;
        resolve(m[1]);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`firefox exited (${code}) before announcing BiDi\n${buf}`)));
    setTimeout(() => reject(new Error(`no BiDi banner within ${bannerTimeout}ms\n${buf}`)), bannerTimeout).unref();
  });

  const sock = new WebSocket(wsUrl + "/session");
  await new Promise((resolve, reject) => {
    sock.onopen = resolve;
    sock.onerror = () => reject(new Error("websocket to " + wsUrl + " failed"));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "event") {
      for (const l of listeners) l(m);
      return;
    }
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === "error") reject(new Error(`${m.error}: ${m.message}`));
    else resolve(m.result);
  };
  sock.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error("BiDi socket closed"));
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try {
        sock.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });

  await send("session.new", { capabilities: {} });
  const tree = await send("browsingContext.getTree");
  const context = tree.contexts[0].context;
  await send("browsingContext.setViewport", { context, viewport: { width, height } });
  const chrome = (await send("browsingContext.getTree", { "moz:scope": "chrome" })).contexts[0].context;

  // Evaluate an expression in a context; the value comes back through JSON.
  async function evalIn(ctx, expr) {
    const r = await send("script.evaluate", { expression: `(async () => JSON.stringify(await (${expr})))()`, target: { context: ctx }, awaitPromise: true });
    if (r.type !== "success") throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails || r).slice(0, 800));
    return r.result.value == null ? undefined : JSON.parse(r.result.value);
  }
  const chromeEval = (expr) => evalIn(chrome, expr);

  const ff = {
    pid: proc.pid,
    proc,
    exited,
    context,
    chrome,
    send,
    evalIn,
    chromeEval,
    logFile,
    onEvent: (fn) => listeners.push(fn),
    navigate: (ctx, url, wait = "complete") => send("browsingContext.navigate", { context: ctx, url, wait }),
    // The extension's background state as the parent process sees it ("running", "suspending",
    // "stopped", "starting"); reading it does not touch the extension.
    bgState: () => chromeEval(`WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)})?.extension?.backgroundState ?? "no extension"`),
    // Open a moz-extension: page as a tab (only the chrome window may) and return its context.
    async openExtPage(path) {
      const url = await chromeEval(`WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)}).getURL(${JSON.stringify(path)})`);
      await chromeEval(`(gBrowser.selectedTab = gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }), "ok")`);
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        const c = (await send("browsingContext.getTree", {})).contexts.find((x) => x.url === url);
        if (c) {
          for (let k = 0; k < 100; k++) {
            if (await evalIn(c.context, `document.readyState === "complete"`).catch(() => false)) return c.context;
            await sleep(100);
          }
          return c.context;
        }
      }
      throw new Error(`${path} did not open`);
    },
    async installExtension(path) {
      return send("webExtension.install", { extensionData: { type: "path", path } });
    },
    // Ask Firefox to quit like the user would (Ctrl+Q): returns the moment the request went out.
    async quit() {
      const t = Date.now();
      send("script.evaluate", { expression: "Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 1", target: { context: chrome }, awaitPromise: false }).catch(() => {});
      return t;
    },
    // Kill our own Firefox by PID (and only it) if it is still up, then remove the run folder
    // unless keep is set.
    async close({ keep = false } = {}) {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      if (alive(proc.pid)) {
        proc.kill("SIGTERM");
        const t0 = Date.now();
        while (alive(proc.pid) && Date.now() - t0 < 15000) await sleep(100);
        if (alive(proc.pid)) proc.kill("SIGKILL");
      }
      await exited;
      if (!keep) await rm(run.dir, { recursive: true, force: true });
    },
  };
  return ff;
}

// Kill leftover spike host processes of a run (by the PIDs they logged), never by pattern.
export async function killHosts(hostlog) {
  const pids = new Set(hostEvents(hostlog).filter((e) => e.ev === "start").map((e) => e.pid));
  const killed = [];
  for (const pid of pids) {
    if (alive(pid) && cmdline(pid).some((a) => a.endsWith("spike_host.py"))) {
      try {
        process.kill(pid, "SIGKILL");
        killed.push(pid);
      } catch {
        /* gone */
      }
    }
  }
  return killed;
}

// A copy of ext/ for one run variant: config.js says whether the background connects at startup,
// the manifest gets `version`.
export async function prepareExt(run, { connectNative = true, version = "0.1.0", host = HOST_NAME } = {}) {
  const { cp, readFile } = await import("node:fs/promises");
  const dst = join(run.dir, `ext-${version}${connectNative ? "" : "-noport"}`);
  await cp(join(SPIKE, "ext"), dst, { recursive: true });
  await writeFile(join(dst, "config.js"), `globalThis.SPIKE = ${JSON.stringify({ connectNative, host })};\n`);
  const mf = JSON.parse(await readFile(join(dst, "manifest.json"), "utf8"));
  mf.version = version;
  await writeFile(join(dst, "manifest.json"), JSON.stringify(mf, null, 2));
  return dst;
}

// The tree under a folder, two levels deep, relative names (what Firefox created in HOME/XDG).
export function listTree(dir, depth = 3, prefix = "") {
  const out = [];
  let names;
  try {
    names = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    out.push(rel + (d.isDirectory() ? "/" : ""));
    if (d.isDirectory() && depth > 1) out.push(...listTree(dir, depth - 1, rel));
  }
  return out;
}

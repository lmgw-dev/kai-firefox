// Headless Firefox over WebDriver BiDi for the tests, from the WP0 spike's launcher (itself from
// an earlier BiDi launcher): no geckodriver, Firefox speaks BiDi behind
// --remote-debugging-port and Node 22 has a WebSocket client.
//
// The profile, HOME and the XDG folders live in the run folder under target/ (never /tmp, which
// may be RAM (tmpfs), never the real ~/.mozilla). Firefox reads per-user native manifests only from
// $HOME/.mozilla/native-messaging-hosts/ (WP0 (e)), so the run's HOME carries the manifest. The
// binary is started directly, not through a distribution's /usr/bin/firefox wrapper. FIREFOX overrides it.

import { spawn } from "node:child_process";
import { writeFile, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTime, killChecked } from "./proc.mjs";

export const FIREFOX = process.env.FIREFOX || "/usr/lib64/firefox/firefox";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const alive = (pid) => {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2, s.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
};

// Quiet prefs: no first-run pages, telemetry, updates or remote settings traffic.
const BASE_PREFS = {
  "remote.active-protocols": 1,
  "browser.shell.checkDefaultBrowser": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "datareporting.healthreport.uploadEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "toolkit.telemetry.enabled": false,
  "browser.aboutwelcome.enabled": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "browser.newtabpage.enabled": false,
  "browser.startup.page": 0,
  "app.update.auto": false,
  "app.update.enabled": false,
  "extensions.update.enabled": false,
  "extensions.getAddons.cache.enabled": false,
  "network.captive-portal-service.enabled": false,
  "network.connectivity-service.enabled": false,
  "browser.safebrowsing.malware.enabled": false,
  "browser.safebrowsing.phishing.enabled": false,
  "browser.safebrowsing.downloads.enabled": false,
  "browser.search.update": false,
  "services.settings.server": "http://127.0.0.1:9/",
  "browser.urlbar.suggest.searches": false,
  "browser.ml.enable": false,
  "devtools.console.stdout.chrome": true,
  "devtools.console.stdout.content": true,
};

// `wrap`: a command Firefox is started through that execs it in place (the acceptance runs'
// `systemd-run --user --scope`), so the PID stays Firefox's.
export async function launchFirefox({ dir, env = {}, prefs = {}, width = 1280, height = 900, bannerTimeout = 30000, wrap = [], url = "about:blank" }) {
  const paths = {
    profile: join(dir, "profile"),
    home: join(dir, "home"),
    xdgConfig: join(dir, "xdg-config"),
    xdgCache: join(dir, "xdg-cache"),
    xdgData: join(dir, "xdg-data"),
    xdgState: join(dir, "xdg-state"),
    tmp: join(dir, "tmp"),
  };
  const userJs = Object.entries({ ...BASE_PREFS, ...prefs }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  await writeFile(join(paths.profile, "user.js"), userJs.join("\n") + "\n");
  const fenv = {
    ...process.env,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_DATA_HOME: paths.xdgData,
    XDG_STATE_HOME: paths.xdgState,
    TMPDIR: paths.tmp,
    MOZ_HEADLESS: "1",
    MOZ_CRASHREPORTER_DISABLE: "1",
    // Firefox 159 wants this in the environment, besides --remote-allow-system-access, before BiDi
    // may evaluate in the chrome window.
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
    ...env,
  };
  delete fenv.DISPLAY;
  delete fenv.WAYLAND_DISPLAY;
  const logFile = join(dir, "firefox.log");
  await writeFile(logFile, "");
  const argv = ["--headless", "--no-remote", "--profile", paths.profile, "--remote-debugging-port", "0", "--remote-allow-system-access", url];
  const proc = wrap.length ? spawn(wrap[0], [...wrap.slice(1), FIREFOX, ...argv], { stdio: ["ignore", "pipe", "pipe"], env: fenv }) : spawn(FIREFOX, argv, { stdio: ["ignore", "pipe", "pipe"], env: fenv });
  // Its start time, so the PID is signalled only while it is still this Firefox (an exec keeps it).
  const start = startTime(proc.pid);
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
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
    setTimeout(() => reject(new Error(`no BiDi banner within ${bannerTimeout} ms\n${buf}`)), bannerTimeout).unref();
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

  // Evaluates an expression (awaited) in a context; the value comes back through JSON.
  async function evalIn(ctx, expr) {
    const r = await send("script.evaluate", { expression: `(async () => JSON.stringify(await (${expr})))()`, target: { context: ctx }, awaitPromise: true });
    if (r.type !== "success") throw new Error("evaluate failed: " + (r.exceptionDetails?.text || JSON.stringify(r.exceptionDetails || r)));
    return r.result.value == null ? undefined : JSON.parse(r.result.value);
  }

  return {
    pid: proc.pid,
    start,
    paths,
    context,
    chrome,
    send,
    evalIn,
    chromeEval: (expr) => evalIn(chrome, expr),
    onEvent: (fn) => listeners.push(fn),
    logFile,
    exited,
    async close() {
      try {
        await send("session.end");
      } catch {
        /* gone */
      }
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      if (alive(proc.pid)) {
        killChecked(proc.pid, start, "SIGTERM");
        const t0 = Date.now();
        while (alive(proc.pid) && Date.now() - t0 < 15000) await sleep(100);
        if (alive(proc.pid)) killChecked(proc.pid, start, "SIGKILL");
      }
      await exited;
    },
    killNow() {
      if (alive(proc.pid)) killChecked(proc.pid, start, "SIGKILL");
    },
  };
}

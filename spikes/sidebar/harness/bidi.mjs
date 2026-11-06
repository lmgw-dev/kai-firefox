// Drive a headless Firefox over WebDriver BiDi: no geckodriver, no Playwright (Firefox speaks BiDi
// behind --remote-debugging-port, Node >= 22 has a WebSocket client). Copied from an earlier
// BiDi launcher and changed in three ways:
//   * the profile, HOME and TMPDIR live under `root` (the caller passes a directory in target/),
//     never in /tmp, which may be a RAM-backed tmpfs;
//   * BiDi events are delivered (`on`), and `log.entryAdded` is subscribed;
//   * the display variables are dropped, so a headless run cannot open a window by mistake.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function launchFirefox({ root, width = 1280, height = 900, binary = process.env.FIREFOX || "firefox", bannerTimeout = 30000, prefs = {}, args = [], onOutput = null } = {}) {
  const profile = join(root, "profile");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  await rm(root, { recursive: true, force: true });
  for (const d of [profile, home, tmp]) await mkdir(d, { recursive: true });
  const base = {
    "remote.active-protocols": 1,
    "browser.shell.checkDefaultBrowser": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "app.update.auto": false,
    "app.update.enabled": false,
    "network.captive-portal-service.enabled": false,
    "browser.aboutwelcome.enabled": false,
    "extensions.update.enabled": false,
  };
  const userJs = Object.entries({ ...base, ...prefs }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  await writeFile(join(profile, "user.js"), userJs.join("\n") + "\n");
  // Firefox 159 wants chrome-scope BiDi (needed to open a moz-extension: tab) enabled by this
  // variable; the --remote-allow-system-access flag the earlier launcher passes is not enough any more.
  const env = { ...process.env, HOME: home, TMPDIR: tmp, MOZ_HEADLESS: "1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const proc = spawn(binary, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", ...args, "about:blank"], { stdio: ["ignore", "pipe", "pipe"], env });
  const exited = new Promise((resolve) => proc.on("exit", resolve));
  let announcedUrl = null;
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      if (announcedUrl) {
        if (onOutput) onOutput(String(d));
        return;
      }
      buf += d;
      const m = buf.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m) {
        announcedUrl = m[1];
        resolve(m[1]);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`firefox exited (${code}) before announcing BiDi\n${buf}`)));
    setTimeout(() => reject(new Error(`no "WebDriver BiDi listening" banner within ${bannerTimeout}ms\n${buf}`)), bannerTimeout).unref();
  });

  const sock = new WebSocket(wsUrl + "/session");
  await new Promise((resolve, reject) => {
    sock.onopen = resolve;
    sock.onerror = () => reject(new Error("websocket to " + wsUrl + " failed"));
  });
  let nextId = 0;
  const pending = new Map();
  const handlers = new Map();
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "event") {
      for (const h of handlers.get(m.method) || []) h(m.params);
      return;
    }
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === "error") reject(new Error(`${m.error}: ${m.message}`));
    else resolve(m.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      sock.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, handler) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(handler);
  };

  await send("session.new", { capabilities: {} });
  await send("session.subscribe", { events: ["log.entryAdded"] });
  const tree = await send("browsingContext.getTree");
  const context = tree.contexts[0].context;
  await send("browsingContext.setViewport", { context, viewport: { width, height } });

  return {
    context,
    pid: proc.pid,
    send,
    on,
    async close() {
      try {
        await send("session.end");
      } catch {
        /* already gone */
      }
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      proc.kill("SIGTERM");
      const t = setTimeout(() => proc.kill("SIGKILL"), 8000);
      await exited;
      clearTimeout(t);
      await rm(root, { recursive: true, force: true });
    },
  };
}

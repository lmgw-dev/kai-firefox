#!/usr/bin/env node
// WP0 (a): MV3 event page + native port.
//
//   node run-a.mjs keepalive [--minutes 5] [--idle-ms 2000]
//       Three headless Firefox side by side, extensions.background.idle.timeout = --idle-ms:
//       "ping"    the background opens the port at startup, the host sends a ping every 30 s;
//       "silent"  the same, the host never sends;
//       "control" no port.
//       The background state is read from the parent process every 500 ms (chrome scope,
//       WebExtensionPolicy...extension.backgroundState), which does not touch the extension.
//   node run-a.mjs sizes
//       Throughput extension -> host for one large message and for the same bytes in 1 MiB and
//       256 KiB messages, with the default pipe and with the host enlarging it to 1 MiB.
//   node run-a.mjs pageport [--seconds 60]
//       The background opens no port; an extension page (the sidebar's stand-in) opens the native
//       port and a runtime.connect port to the background: is the event page still suspended?
//   node run-a.mjs lifecycle [--mode stubborn|term-exit|eof-exit]
//       One Firefox: message sizes (20 MiB to the host, exactly 1 MiB and 1 MiB + 1 byte from the
//       host), then disable/enable, runtime.reload(), installing 0.2.0 over 0.1.0, uninstall,
//       reinstall and quit; for each, the host's stdin EOF, SIGTERM, exit and the moment its PID is
//       gone, and the next host's start.
//
// The host logs to the run's hostlog/; the run folder under target/ext-spike/ is deleted at the end
// (--keep keeps it).
import { join } from "node:path";
import {
  makeRun, launchFirefox, prepareExt, writeHostManifest, hostEvents, killHosts, alive, sleep, EXT_ID,
} from "./lib/firefox.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const keep = argv.includes("--keep");

async function setup(name, { connectNative = true, env = {}, idleMs = 2000, prefs = {} } = {}) {
  const run = await makeRun(name);
  // (e): Firefox 159 reads per-user manifests from $HOME/.mozilla/native-messaging-hosts only.
  await writeHostManifest(join(run.home, ".mozilla", "native-messaging-hosts"));
  const ext1 = await prepareExt(run, { connectNative, version: "0.1.0" });
  const ff = await launchFirefox({ run, env, prefs: { "extensions.background.idle.timeout": idleMs, ...prefs } });
  return { run, ff, ext1 };
}

const fmt = (o) => JSON.stringify(o);

// ---------------------------------------------------------------- keepalive
async function keepaliveOne(label, { connectNative, pingS, minutes, idleMs }) {
  const { run, ff, ext1 } = await setup("a-" + label, { connectNative, idleMs, env: { SPIKE_PING_S: String(pingS), SPIKE_HOST_MODE: "eof-exit" } });
  const out = { label, connectNative, pingS, idleMs, minutes };
  try {
    const t0 = Date.now();
    const inst = await ff.installExtension(ext1);
    if (inst.extension !== EXT_ID) throw new Error(fmt(inst));
    const transitions = [];
    let last = null;
    const until = t0 + minutes * 60000;
    let ffExit = null;
    ff.exited.then((e) => (ffExit = e));
    while (Date.now() < until && !ffExit) {
      let s;
      try {
        s = await ff.bgState();
      } catch (e) {
        s = "BiDi error: " + e.message;
      }
      if (s !== last) {
        transitions.push({ ms: Date.now() - t0, state: s });
        last = s;
      }
      if (s.startsWith("BiDi error")) break;
      await sleep(minutes > 10 ? 2000 : 500);
    }
    out.transitions = transitions;
    out.final_state = last;
    await sleep(500);
    if (ffExit) {
      // Firefox itself went away during the run: say how, keep the folder and its log.
      out.firefox_exited = { ms: ffExit.t - t0, code: ffExit.code, signal: ffExit.signal, log: run.dir };
      out.host_tail = hostEvents(run.hostlog).slice(-4);
      out.killed_hosts = await killHosts(run.hostlog);
      return out;
    }
    const ev = hostEvents(run.hostlog);
    out.host_processes = new Set(ev.filter((e) => e.ev === "start").map((e) => e.pid)).size;
    out.host_eof = ev.filter((e) => e.ev === "eof").length;
    const pongs = ev.filter((e) => e.ev === "msg" && e.msg?.t === "pong");
    out.pings_sent = ev.filter((e) => e.ev === "ping").length;
    out.pongs = pongs.length;
    out.pong_instances = [...new Set(pongs.map((p) => p.msg.instance))];
    out.pong_lag_ms_max = pongs.length ? Math.max(...pongs.map((p) => p.msg.lag_ms)) : null;
    out.hello_instances = ev.filter((e) => e.ev === "msg" && e.msg?.t === "hello").map((e) => e.msg.instance);
    // Only now look inside (this wakes a suspended background, so it comes last).
    const page = await ff.openExtPage("harness.html");
    const st = await ff.evalIn(page, `browser.storage.local.get(["boots", "lastSuspend"])`);
    out.boots = (st.boots || []).map((b) => ({ ms: b.t - t0, instance: b.instance }));
    out.last_suspend = st.lastSuspend ? { ms: st.lastSuspend.t - t0, instance: st.lastSuspend.instance } : null;
  } finally {
    if (!out.firefox_exited) {
      out.killed_hosts = await killHosts(run.hostlog);
      await ff.close({ keep });
    }
  }
  return out;
}

async function keepalive() {
  const minutes = Number(opt("minutes", "5"));
  const idleMs = Number(opt("idle-ms", "2000"));
  console.log(`keepalive: ${minutes} min, idle timeout ${idleMs} ms`);
  const res = await Promise.allSettled([
    keepaliveOne("ping", { connectNative: true, pingS: 30, minutes, idleMs }),
    keepaliveOne("silent", { connectNative: true, pingS: 0, minutes, idleMs }),
    keepaliveOne("control", { connectNative: false, pingS: 0, minutes: Math.min(minutes, 1), idleMs }),
  ]);
  for (const r of res) console.log(r.status === "fulfilled" ? JSON.stringify(r.value, null, 1) : "failed: " + (r.reason?.stack || r.reason));
}

// ---------------------------------------------------------------- pageport
// The background opens no native port; an extension page (standing in for the sidebar) opens the
// native port itself and holds a runtime.connect port to the background. Does either keep the
// event page from being suspended?
async function pageport() {
  const seconds = Number(opt("seconds", "60"));
  const idleMs = Number(opt("idle-ms", "2000"));
  const { run, ff, ext1 } = await setup("a-pageport", { connectNative: false, idleMs, env: { SPIKE_PING_S: "10", SPIKE_HOST_MODE: "eof-exit" } });
  const out = { seconds, idleMs };
  try {
    await ff.installExtension(ext1);
    const page = await ff.openExtPage("harness.html");
    const t0 = Date.now();
    await ff.evalIn(page, `(() => {
      window.np = browser.runtime.connectNative("dev.rootshell.kai_spike");
      window.npMsgs = 0;
      np.onMessage.addListener((m) => { npMsgs++; if (m.t === "ping") np.postMessage({ t: "pong", seq: m.seq, from: "page" }); });
      window.rp = browser.runtime.connect({ name: "sidebar-standin" });
      window.rpDisconnected = null;
      rp.onDisconnect.addListener((p) => { rpDisconnected = { t: Date.now(), error: p.error && p.error.message }; });
      return true;
    })()`);
    const transitions = [];
    let last = null;
    while (Date.now() - t0 < seconds * 1000) {
      const s = await ff.bgState();
      if (s !== last) {
        transitions.push({ ms: Date.now() - t0, state: s });
        last = s;
      }
      await sleep(250);
    }
    out.transitions = transitions;
    out.page = await ff.evalIn(page, `({ npMsgs, rpDisconnected: rpDisconnected && { ms: rpDisconnected.t - ${t0}, error: rpDisconnected.error } })`);
    out.host_pongs_from_page = hostEvents(run.hostlog).filter((e) => e.msg?.t === "pong").length;
  } finally {
    out.killed_hosts = await killHosts(run.hostlog);
    await ff.close({ keep });
  }
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------- lifecycle
async function lifecycle() {
  const mode = opt("mode", "stubborn");
  const { run, ff, ext1 } = await setup("a-life-" + mode, { env: { SPIKE_PING_S: "30", SPIKE_HOST_MODE: mode } });
  const ext2 = await prepareExt(run, { connectNative: true, version: "0.2.0" });
  const results = { mode, steps: [] };
  // A watcher that notes when each host PID disappears (or turns zombie).
  const gone = new Map();
  const watcher = setInterval(() => {
    for (const e of hostEvents(run.hostlog)) {
      if (e.ev === "start" && !gone.has(e.pid) && !alive(e.pid)) gone.set(e.pid, Date.now());
    }
  }, 10);
  const starts = () => hostEvents(run.hostlog).filter((e) => e.ev === "start");
  async function waitNewHost(known, ms = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = starts().find((e) => !known.has(e.pid));
      if (s) return s;
      await sleep(20);
    }
    return null;
  }
  // The timeline of one host after an action at t: EOF, SIGTERM, its own exit, PID gone.
  async function timeline(pid, t, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !gone.has(pid)) await sleep(20);
    await sleep(50);
    const ev = hostEvents(run.hostlog).filter((e) => e.pid === pid);
    const at = (name) => {
      const e = ev.find((x) => x.ev === name);
      return e ? Math.round(e.t - t) : null;
    };
    return { pid, eof_ms: at("eof"), sigterm_ms: at("sigterm"), own_exit_ms: at("exit"), gone_ms: gone.has(pid) ? gone.get(pid) - t : "still running", killed: gone.has(pid) && at("exit") === null };
  }
  const step = (name, data) => {
    results.steps.push({ step: name, ...data });
    console.log(name.padEnd(28), fmt(data));
  };
  const addon = (method) => ff.chromeEval(`ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager.getAddonByID(${fmt(EXT_ID)}).then((a) => a.${method}()).then(() => "ok", (e) => "error: " + e)`);
  let known = new Set();
  try {
    const inst = await ff.installExtension(ext1);
    if (inst.extension !== EXT_ID) throw new Error(fmt(inst));
    let h = await waitNewHost(known);
    known.add(h.pid);
    step("install 0.1.0", { host_start_ms: "n/a", pid: h.pid, argv: h.argv.slice(1) });
    let page = await ff.openExtPage("harness.html");

    // sizes
    const big20 = await ff.evalIn(page, `bg({ op: "ext_big", bytes: 20 * 1024 * 1024 })`);
    const hostSaw = hostEvents(run.hostlog).filter((e) => e.ev === "msg" && e.msg?.t === "big").pop();
    step("ext->host 20 MiB", { ...big20, host_len: hostSaw?.len, host_read_ms: hostSaw?.read_ms });
    for (const n of [1048575, 1048576]) step(`host->ext ${n} B`, await ff.evalIn(page, `bg({ op: "host_big", bytes: ${n} })`));
    let t = Date.now();
    const over = await ff.evalIn(page, `bg({ op: "host_big", bytes: 1048577 })`);
    step("host->ext 1048577 B", { ...over, host: await timeline(h.pid, t) });

    // reconnect for the lifecycle
    await ff.evalIn(page, `bg({ op: "connect" })`);
    h = await waitNewHost(known);
    known.add(h.pid);

    // disable / enable
    t = Date.now();
    step("disable", { call: await addon("disable"), host: await timeline(h.pid, t), bg: await ff.bgState() });
    t = Date.now();
    const en = await addon("enable");
    h = await waitNewHost(known);
    known.add(h.pid);
    step("enable", { call: en, new_host_ms: h ? h.t - t : null });

    // runtime.reload()
    page = await ff.openExtPage("harness.html");
    t = Date.now();
    await ff.evalIn(page, `bg({ op: "reload" })`);
    const tl = await timeline(h.pid, t);
    h = await waitNewHost(known);
    known.add(h.pid);
    step("runtime.reload()", { host: tl, new_host_ms: h ? h.t - t : null });

    // install 0.2.0 over 0.1.0
    t = Date.now();
    const up = await ff.installExtension(ext2);
    const tl2 = await timeline(h.pid, t);
    h = await waitNewHost(known);
    known.add(h.pid);
    const hello = hostEvents(run.hostlog).find((e) => e.pid === h?.pid && e.msg?.t === "hello");
    step("install 0.2.0 over", { install: up, host: tl2, new_host_ms: h ? h.t - t : null, new_hello_version: hello?.msg?.version });

    // uninstall
    t = Date.now();
    const un = await ff.send("webExtension.uninstall", { extension: EXT_ID }).then(() => "ok", (e) => String(e));
    const tl3 = await timeline(h.pid, t);
    const after = await waitNewHost(known, 2000);
    step("uninstall", { call: un, host: tl3, new_host: after ? after.pid : null });

    // reinstall, then quit
    await ff.installExtension(ext1);
    h = await waitNewHost(known);
    known.add(h.pid);
    t = await ff.quit();
    const tl4 = await timeline(h.pid, t, 20000);
    const ex = await Promise.race([ff.exited, sleep(30000).then(() => null)]);
    step("quit Firefox", { host: tl4, firefox_exit_ms: ex ? ex.t - t : "timeout" });
  } finally {
    clearInterval(watcher);
    results.killed_hosts = await killHosts(run.hostlog);
    if (results.killed_hosts.length) console.log("killed leftover hosts", results.killed_hosts);
    await ff.close({ keep });
  }
}

// ---------------------------------------------------------------- sizes
// Throughput extension -> host: one message of 1, 5, 20, 50 MiB; 50 MiB as 1 MiB messages; with
// the host's default pipe and with the host enlarging its pipes to 1 MiB (F_SETPIPE_SZ).
async function sizes() {
  for (const pipe of [null, 1048576]) {
    const env = { SPIKE_PING_S: "0", SPIKE_HOST_MODE: "eof-exit", ...(pipe ? { SPIKE_PIPE_SZ: String(pipe) } : {}) };
    const { run, ff, ext1 } = await setup("a-sizes", { env });
    try {
      await ff.installExtension(ext1);
      let start = null;
      for (let i = 0; i < 100 && !start; i++) {
        await sleep(50);
        start = hostEvents(run.hostlog).find((e) => e.ev === "start");
      }
      const page = await ff.openExtPage("harness.html");
      console.log(`pipe ${pipe ? "1 MiB (F_SETPIPE_SZ " + JSON.stringify(start.pipe_size) + ")" : "default (64 KiB)"}`);
      for (const mib of [1, 5, 20, 50]) {
        const r = await ff.evalIn(page, `bg({ op: "ext_big", bytes: ${mib} * 1048576 })`);
        console.log(`  one message ${String(mib).padStart(3)} MiB: ${r.kind} after ${r.post_ms + r.ack_ms} ms (${(mib / ((r.post_ms + r.ack_ms) / 1000)).toFixed(1)} MiB/s)`);
      }
      for (const chunk of [1048576, 262144]) {
        const r = await ff.evalIn(page, `bg({ op: "ext_chunks", bytes: 50 * 1048576, chunk: ${chunk} })`);
        console.log(`  50 MiB as ${r.messages} messages of ${chunk / 1024} KiB: ${r.kind} after ${r.total_ms} ms (${(50 / (r.total_ms / 1000)).toFixed(1)} MiB/s)`);
      }
    } finally {
      await killHosts(run.hostlog);
      await ff.close({ keep });
    }
  }
}

if (cmd === "keepalive") await keepalive();
else if (cmd === "sizes") await sizes();
else if (cmd === "pageport") await pageport();
else if (cmd === "lifecycle") await lifecycle();
else {
  console.error("usage: node run-a.mjs keepalive [--minutes 5] [--idle-ms 2000] | sizes | pageport [--seconds 60] | lifecycle [--mode stubborn|term-exit|eof-exit] [--keep]");
  process.exit(2);
}

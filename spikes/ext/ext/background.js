// WP0 (a) spike background: an MV3 event page that opens the native port at startup (when
// SPIKE.connectNative) and answers the harness page's commands.
/* global SPIKE */
const BOOT = { t: Date.now(), instance: Math.random().toString(36).slice(2, 10) };
const events = [];
const rec = (ev, extra = {}) => {
  events.push({ t: Date.now(), ev, ...extra });
  if (events.length > 1000) events.shift();
};
let port = null;
const waiters = new Set();
const waitFor = (pred, ms) =>
  new Promise((resolve) => {
    const w = { pred, resolve };
    waiters.add(w);
    setTimeout(() => {
      if (waiters.delete(w)) resolve({ timeout: ms });
    }, ms);
  });
const notify = (what) => {
  for (const w of [...waiters]) {
    if (w.pred(what)) {
      waiters.delete(w);
      w.resolve(what);
    }
  }
};

browser.storage.local.get("boots").then(({ boots = [] }) => browser.storage.local.set({ boots: [...boots, BOOT] }));
browser.runtime.onSuspend.addListener(() => {
  browser.storage.local.set({ lastSuspend: { t: Date.now(), instance: BOOT.instance } });
});

function connect() {
  port = browser.runtime.connectNative(SPIKE.host);
  rec("connect");
  port.onMessage.addListener((m) => {
    if (m.t === "ping") {
      port.postMessage({ t: "pong", seq: m.seq, instance: BOOT.instance, boot: BOOT.t, lag_ms: Date.now() - m.sent_at });
      rec("ping", { seq: m.seq });
    } else if (m.t === "big") {
      rec("big", { pad_len: m.pad.length });
      notify({ kind: "big", pad_len: m.pad.length, t: Date.now() });
    } else if (m.t === "big_ack") {
      rec("big_ack", { len: m.len });
      notify({ kind: "big_ack", len: m.len, pad_len: m.pad_len, t: Date.now() });
    } else rec("host_msg", { t: m.t });
  });
  port.onDisconnect.addListener((p) => {
    const error = p.error ? p.error.message : null;
    rec("disconnect", { error });
    notify({ kind: "disconnect", error, t: Date.now() });
    port = null;
  });
  port.postMessage({ t: "hello", instance: BOOT.instance, boot: BOOT.t, version: browser.runtime.getManifest().version });
}

if (SPIKE.connectNative) connect();

// A page's runtime.connect port (the sidebar's, in the design) is held here.
const pagePorts = new Set();
browser.runtime.onConnect.addListener((p) => {
  rec("runtime_port", { name: p.name });
  pagePorts.add(p);
  p.onDisconnect.addListener(() => pagePorts.delete(p));
});

browser.runtime.onMessage.addListener(async (cmd) => {
  switch (cmd.op) {
    case "state":
      return { boot: BOOT, connected: !!port, events, version: browser.runtime.getManifest().version };
    case "connect":
      if (!port) connect();
      return { connected: true };
    case "disconnect":
      port?.disconnect();
      port = null;
      return { connected: false };
    case "host_big": {
      // Ask the host for one message of exactly cmd.bytes bytes of JSON.
      if (!port) return { error: "no port" };
      const t0 = Date.now();
      port.postMessage({ t: "send_big", bytes: cmd.bytes });
      const r = await waitFor((w) => w.kind === "big" || w.kind === "disconnect", 15000);
      return { ...r, ms: Date.now() - t0 };
    }
    case "ext_big": {
      // Send one message whose JSON is exactly cmd.bytes bytes to the host.
      if (!port) return { error: "no port" };
      const t0 = Date.now();
      const pad = "x".repeat(cmd.bytes - 20);
      const msg = { t: "big", pad };
      const t1 = Date.now();
      try {
        port.postMessage(msg);
      } catch (e) {
        return { error: String(e) };
      }
      const t2 = Date.now();
      const r = await waitFor((w) => w.kind === "big_ack" || w.kind === "disconnect", 60000);
      return { ...r, build_ms: t1 - t0, post_ms: t2 - t1, ack_ms: Date.now() - t2 };
    }
    case "ext_chunks": {
      // The same amount as cmd.bytes, sent as messages of cmd.chunk bytes each.
      if (!port) return { error: "no port" };
      const n = Math.ceil(cmd.bytes / cmd.chunk);
      const pad = "x".repeat(cmd.chunk - 20);
      let acks = 0;
      const done = waitFor((w) => (w.kind === "big_ack" && ++acks === n) || w.kind === "disconnect", 120000);
      const t0 = Date.now();
      for (let i = 0; i < n; i++) port.postMessage({ t: "big", pad });
      const t1 = Date.now();
      const r = await done;
      return { ...r, messages: n, post_ms: t1 - t0, total_ms: Date.now() - t0 };
    }
    case "reload":
      setTimeout(() => browser.runtime.reload(), 50);
      return { reloading: true, t: Date.now() };
    default:
      return { error: "unknown op " + cmd.op };
  }
});

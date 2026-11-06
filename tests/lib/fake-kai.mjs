// A fake Kai on a Unix socket (KAI_BROWSER_SOCKET for the real kai-browser-host): answers hello
// with welcome (or refused), sends operations and records every frame. Frames are native
// messaging's: a 4-byte little-endian length and UTF-8 JSON. Like Kai (src/browser/chunk.rs) it
// splits what it sends over LIMIT into chunk frames unless told to send a frame raw, and it joins
// the extension's split frames, strictly: any deviation from §4.2's contract is recorded in
// `splitErrors` instead of guessed around.

import { createServer } from "node:net";
import { rm } from "node:fs/promises";

export const LIMIT = 1024 * 1024;

const sizeOf = (s) => Buffer.byteLength(s, "utf8");

// Kai's chunker, written again: pieces of `text` whose chunk frames are at most `limit` bytes.
export function kaiSplit(text, n, limit = LIMIT) {
  const out = [];
  const cps = Array.from(text);
  let i = 0;
  while (i < cps.length) {
    const seq = out.length;
    const room = limit - sizeOf(JSON.stringify({ t: "chunk", split: n, seq, data: "" }));
    let used = 0;
    let j = i;
    while (j < cps.length) {
      const w = sizeOf(JSON.stringify(cps[j])) - 2;
      if (used + w > room) break;
      used += w;
      j++;
    }
    out.push(JSON.stringify({ t: "chunk", split: n, seq, data: cps.slice(i, j).join("") }));
    i = j;
  }
  out.push(JSON.stringify({ t: "end", split: n, seq: out.length }));
  return out;
}

class Conn {
  constructor(kai, socket) {
    this.kai = kai;
    this.socket = socket;
    this.frames = []; // every frame, split ones joined: { t, ..., _raw: bytes on the wire }
    this.raw = []; // every frame as it came: { bytes, t }
    this.waiters = [];
    this.hello = null;
    this.t0 = Date.now(); // when the host connected
    this.closed = false;
    this.splitsSent = 0;
    this.open = null; // the extension's split being joined
    this.splitErrors = [];
    this.closedP = new Promise((r) => socket.on("close", () => {
      this.closed = true;
      r();
      this.#wake();
    }));
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len).toString("utf8");
        buf = buf.subarray(4 + len);
        this.#frame(body, len);
      }
    });
    socket.on("error", () => {});
  }

  #frame(body, bytes) {
    let f;
    try {
      f = JSON.parse(body);
    } catch {
      this.splitErrors.push(`a frame that is no JSON (${bytes} bytes)`);
      return;
    }
    this.raw.push({ bytes, t: f.t, split: f.split });
    if ((f.t === "chunk" || f.t === "end") && "split" in f) {
      if (f.t === "chunk") {
        if (!this.open) {
          if (f.seq !== 0) this.splitErrors.push(`split ${f.split} began at seq ${f.seq}`);
          this.open = { split: f.split, parts: [], count: 0, bytes: 0 };
        } else if (this.open.split !== f.split) this.splitErrors.push(`split ${f.split} interleaved with ${this.open.split}`);
        if (f.seq !== this.open.count) this.splitErrors.push(`split ${f.split}: seq ${f.seq} where ${this.open.count} was due`);
        this.open.parts.push(f.data);
        this.open.count++;
        this.open.maxPiece = Math.max(this.open.maxPiece || 0, bytes);
        return;
      }
      const o = this.open;
      this.open = null;
      if (!o || o.split !== f.split || o.count !== f.seq) {
        this.splitErrors.push(`end of split ${f.split} at seq ${f.seq} does not close what came`);
        return;
      }
      const text = o.parts.join("");
      const whole = JSON.parse(text);
      whole._split = { split: f.split, pieces: o.count, bytes: sizeOf(text), maxPiece: o.maxPiece };
      this.#accept(whole);
      return;
    }
    if (this.open) this.splitErrors.push(`split ${this.open.split} interrupted by ${f.t}`);
    this.#accept(f);
  }

  #accept(f) {
    this.frames.push(f);
    // A test's own handler (the sidebar's Kai side: fake-lmgw.mjs serveSidebar).
    this.kai.onFrame?.(this, f);
    if (f.t === "hello" && !this.hello) {
      this.hello = f;
      this.helloAt = Date.now();
      this.kai.onHello(this, f);
    }
    this.#wake();
  }

  #wake() {
    for (const w of [...this.waiters]) {
      const hit = this.frames.find((f, i) => i >= w.from && w.pred(f));
      if (hit || this.closed) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        if (hit) w.resolve(hit);
        else w.reject(new Error(`the connection closed while waiting for ${w.what}`));
      }
    }
  }

  // The first frame from index `from` on matching pred.
  next(pred, { from = 0, what = "a frame", ms = 20000 } = {}) {
    const hit = this.frames.find((f, i) => i >= from && pred(f));
    if (hit) return Promise.resolve(hit);
    if (this.closed) return Promise.reject(new Error(`the connection is closed (waiting for ${what})`));
    return new Promise((resolve, reject) => {
      const w = { pred, from, what, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`no ${what} within ${ms} ms`));
        }
      }, ms).unref();
    });
  }

  // A frame as JSON text, split over LIMIT as Kai splits (unless raw).
  sendText(text, { raw = false } = {}) {
    const pieces = !raw && sizeOf(text) > LIMIT ? kaiSplit(text, ++this.splitsSent) : [text];
    for (const p of pieces) this.writeRaw(p);
    return pieces.length;
  }

  send(frame, opts) {
    return this.sendText(JSON.stringify(frame), opts);
  }

  writeRaw(text) {
    const body = Buffer.from(text, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([len, body]));
  }

  // Sends an op; its op_result's promise.
  op(op, args = {}, opts = {}) {
    const id = this.kai.nextOp++;
    const from = this.frames.length;
    this.send({ t: "op", id, op, args }, opts);
    const result = this.next((f) => f.t === "op_result" && f.id === id, { from, what: `op_result ${id} (${op})`, ms: opts.ms ?? 20000 });
    return { id, result };
  }

  // An op's result: `ok` or throws an Error carrying `code`.
  async call(op, args = {}, opts = {}) {
    const r = await this.op(op, args, opts).result;
    if (r.error) {
      const e = new Error(`${op}: ${r.error.code}: ${r.error.message}`);
      e.code = r.error.code;
      e.error = r.error;
      throw e;
    }
    return r.ok;
  }

  close() {
    this.socket.destroy();
  }
}

export async function fakeKai(path) {
  await rm(path, { force: true });
  const kai = {
    path,
    // "welcome", "hold" (no answer to the hello; the test answers) or { refuse: "<reason>" }
    mode: "welcome",
    version: "0.0.0-fake",
    // The extension's frames this Kai takes, as Kai's welcome lists them (`takes`); null: a welcome
    // without the list, as a Kai before it sent.
    takes: ["hello", "error", "op_result", "event", "ask", "req", "ack", "abort", "site", "chunk", "end"],
    nextOp: 1,
    conns: [],
    linkWaiters: [],
    server: null,
    onHello(conn, hello) {
      for (const w of this.helloWaiters.splice(0)) w(conn);
      if (this.mode === "hold") return;
      if (this.mode !== "welcome") {
        conn.writeRaw(JSON.stringify({ t: "refused", reason: this.mode.refuse }));
        conn.socket.end();
        return;
      }
      this.welcome(conn);
    },
    welcome(conn) {
      const welcome = { t: "welcome", kai_version: this.version, protocol: conn.hello.protocol };
      if (this.takes) welcome.takes = this.takes;
      conn.writeRaw(JSON.stringify(welcome));
      conn.linked = true;
      for (const w of this.linkWaiters.splice(0)) w(conn);
    },
    helloWaiters: [],
    // The next connection that says hello, welcomed or not.
    helloed({ ms = 20000 } = {}) {
      return new Promise((resolve, reject) => {
        this.helloWaiters.push(resolve);
        setTimeout(() => reject(new Error(`no hello within ${ms} ms`)), ms).unref();
      });
    },
    // The next connection that gets welcomed (or the current one, when `current`).
    linked({ ms = 20000 } = {}) {
      return new Promise((resolve, reject) => {
        this.linkWaiters.push(resolve);
        setTimeout(() => reject(new Error(`no link within ${ms} ms`)), ms).unref();
      });
    },
    current() {
      return [...this.conns].reverse().find((c) => c.linked && !c.closed);
    },
    async start() {
      await rm(path, { force: true });
      this.server = createServer((s) => this.conns.push(new Conn(this, s)));
      await new Promise((r) => this.server.listen(path, r));
    },
    // Closes the socket and every connection: the host sees Kai go away.
    async stop() {
      if (!this.server) return;
      const srv = this.server;
      this.server = null;
      for (const c of this.conns) c.close();
      await new Promise((r) => srv.close(r));
      await rm(path, { force: true });
    },
  };
  await kai.start();
  return kai;
}

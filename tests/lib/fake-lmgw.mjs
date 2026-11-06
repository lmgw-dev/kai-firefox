// The sidebar page's tests (tests/e2e/chat.test.mjs): Kai's side of the sidebar's requests with a
// scripted lmgw behind it. serveSidebar(kai, lmgw) makes the fake Kai (fake-kai.mjs) answer the
// relay's `req` frames as Kai's proxy does (docs/protocol/operations.md, "The sidebar's requests"):
// a `res` head, the body as `chunk` pieces and an `end`, a streamed answer as lmgw's pieces come,
// at most `ahead` bytes of pieces' frames unacknowledged (one piece always goes), `abort` ending a
// request, and Kai's `site` answers from `kai.rules`. The lmgw is a handful of threads in memory,
// enough for the Chat to load, open, send and attach: `.example` names only.

const sizeOf = (s) => Buffer.byteLength(s, "utf8");
export const AHEAD = 4 * 1024 * 1024;
// A piece of a body: well below Firefox's 1 MiB per frame.
const PIECE = 256 * 1024;

const thread = (id, title, extra = {}) => ({
  id,
  title,
  model_alias: "echo",
  system_prompt: "",
  stop: [],
  kind: "chat",
  mcp_tools: [],
  created_at: "2026-11-03T10:00:00Z",
  updated_at: "2026-11-03T10:0" + (id % 10) + ":00Z",
  last_activity_at: "2026-11-03T10:0" + (id % 10) + ":00Z",
  ...extra,
});

const msg = (id, threadId, role, content) => ({ id, thread_id: threadId, role, content, created_at: "2026-11-03T10:00:00Z" });

// The scripted lmgw: `answer(req)` gives { status, headers, body } (whole) or { status, headers,
// stream } (an async iterable of text pieces, which may wait); `seen` keeps every request.
export function fakeLmgw() {
  const lm = {
    seen: [],
    uploads: [],
    threads: [thread(1, "Trip to the hills"), thread(2, "Lamp shopping")],
    messages: {
      1: [msg(11, 1, "user", "Which lamp for the trail?"), msg(12, 1, "assistant", "The **Trail Lamp** clips on and gives 120 lumens.")],
      2: [msg(21, 2, "user", "Compare two lamps"), msg(22, 2, "assistant", "Here is a page to look at:\n\n```html\n<p id=\"p\">Preview</p><script>document.getElementById('p').textContent = 'ran inline';</script>\n```")],
    },
    // Bytes of padding in a thread's detail (a whole answer larger than Kai's window).
    padding: {},
    // The feed: each connection's events and whether it stays open after them.
    feedCursor: 0,
    feeds: [],
    // A send's reply, piece by piece; `sendGate` holds it after its first piece and `endGate`
    // before its `done`, each until released.
    reply: ["The ", "lamp ", "is ", "on ", "the ", "table."],
    sendGate: null,
    endGate: null,
    releaseSend() {
      const g = lm.sendGate;
      lm.sendGate = null;
      g?.resolve();
    },
    releaseEnd() {
      const g = lm.endGate;
      lm.endGate = null;
      g?.resolve();
    },
    answer(req) {
      lm.seen.push(req);
      const url = new URL(req.path, "http://lmgw.example");
      const p = url.pathname;
      const json = (status, v) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
      const ok = (v) => json(200, v);
      let m;
      if (req.method === "GET" && p === "/chat/api/feed") return lm.feed(req);
      if (req.method === "GET" && p === "/chat/api/threads") return ok({ threads: lm.threads, archived_count: 0, temporary: [], folders: [] });
      if (req.method === "GET" && p === "/chat/api/threads/rows") return ok({ threads: lm.threads });
      if (req.method === "GET" && (m = p.match(/^\/chat\/api\/threads\/(-?\d+)$/))) {
        const id = Number(m[1]);
        const t = lm.threads.find((x) => x.id === id);
        if (!t) return json(404, { code: "not_found", message: `no thread ${id}` });
        const detail = { thread: t, messages: lm.messages[id] ?? [], draft_attachments: [], tasks: [] };
        if (lm.padding[id]) detail.padding = "x".repeat(lm.padding[id]);
        return ok(detail);
      }
      if (req.method === "POST" && (m = p.match(/^\/chat\/api\/threads\/(\d+)\/attachments$/))) {
        const bytes = Buffer.from(req.body?.base64 ?? "", "base64");
        const id = 900 + lm.uploads.length;
        lm.uploads.push({ thread: Number(m[1]), name: url.searchParams.get("name"), type: req.headers?.["content-type"] ?? null, text: bytes.toString("utf8") });
        return json(201, { id, thread_id: Number(m[1]), name: url.searchParams.get("name"), kind: "text", mime: "text/plain", size: bytes.length, mode: "text", created_at: "2026-11-03T10:00:00Z" });
      }
      if (req.method === "POST" && (m = p.match(/^\/chat\/api\/threads\/(\d+)\/send$/))) return lm.send(Number(m[1]), JSON.parse(req.body?.text ?? "{}"));
      // A user message edited: answered again, as a send is.
      if (req.method === "POST" && (m = p.match(/^\/chat\/api\/threads\/(\d+)\/messages\/\d+\/edit$/))) return lm.send(Number(m[1]), JSON.parse(req.body?.text ?? "{}"));
      if (req.method === "GET" && p === "/chat/api/settings") return ok({});
      if (req.method === "GET" && p === "/v1/models") return ok({ object: "list", data: [{ id: "echo", object: "model", owned_by: "lmgw", capabilities: { tasks: ["chat"] } }] });
      if (req.method === "GET" && p === "/chat/api/profiles") return ok({ profiles: [] });
      if (req.method === "GET" && p === "/chat/api/tools") return ok({ tools: [], labels: [] });
      if (req.method === "GET" && p === "/chat/api/knowledge/bases") return ok({ bases: [] });
      if (req.method === "GET" && p.startsWith("/chat/api/media/defaults")) return ok({});
      if (req.method === "GET" && p === "/v1/audio/voices") return ok({ voices: [] });
      if (req.method === "POST" && /\/chat\/api\/threads\/\d+\/(settings|title|pin)$/.test(p)) return ok({ ok: true });
      return json(404, { code: "not_found", message: `the fake lmgw has no ${req.method} ${p}` });
    },
    feed(req) {
      const n = lm.feeds.length;
      const f = { req, lastEventId: req.headers?.["last-event-id"] ?? null, open: true, push: null };
      lm.feeds.push(f);
      const queue = [];
      let wake = null;
      f.push = (text) => {
        queue.push(text);
        wake?.();
      };
      const cursor = () => `e1:${++lm.feedCursor}:aa`;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: (async function* () {
          yield `id: ${cursor()}\nevent: hello\ndata: ${JSON.stringify({ epoch: "e1", cursor: `e1:${lm.feedCursor}:aa`, keepalive_s: 20, retention_days: 30, principal: { kind: "device", name: "Kai on desk.example" }, hosts_label: "kai", admin: "off", running: [] })}\n\n`;
          for (;;) {
            while (queue.length) yield queue.shift();
            if (!f.open) return;
            await new Promise((r) => (wake = r));
            wake = null;
          }
        })(),
        feedIndex: n,
      };
    },
    // A thread made elsewhere, said on every open feed.
    announce(id, title) {
      lm.threads.unshift(thread(id, title));
      for (const f of lm.feeds) if (f.open) f.push(`id: e1:${++lm.feedCursor}:aa\nevent: thread.created\ndata: ${JSON.stringify({ thread_id: id })}\n\n`);
    },
    send(threadId, body) {
      const userId = 1000 + lm.seen.length;
      const replyId = userId + 1;
      lm.messages[threadId] = [...(lm.messages[threadId] ?? []), msg(userId, threadId, "user", body.content ?? "")];
      const pieces = lm.reply;
      const gate = (lm.sendGate = Promise.withResolvers());
      const last = (lm.endGate = Promise.withResolvers());
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: (async function* () {
          yield `event: turn\ndata: ${JSON.stringify({ user_message_id: userId })}\n\n`;
          for (const [i, text] of pieces.entries()) {
            yield `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;
            if (i === 0) await gate.promise;
          }
          await last.promise;
          lm.messages[threadId].push(msg(replyId, threadId, "assistant", pieces.join("")));
          yield `event: done\ndata: ${JSON.stringify({ aborted: false, message_id: replyId, user_message_id: userId })}\n\n`;
        })(),
      };
    },
  };
  return lm;
}

// Makes `kai` answer the relay's frames with `lmgw` behind it, as Kai's proxy does. `kai.rules`:
// url -> "act" | "read" | "none" (or any other word, as a newer Kai might send) for the `site`
// questions (default act); `kai.beforeSite(urls)`, when set, is awaited before a question is
// answered (a test's moment between the question and the answer); `kai.siteError(urls)`, when it
// gives { code, message }, answers the question with Kai's `error` frame instead. Returns the
// record: `reqs` (each req frame with its answer's state), `sites` (each site question).
export function serveSidebar(kai, lmgw, { ahead = AHEAD } = {}) {
  const rec = { reqs: [], sites: [], open: new Map() };
  kai.rules = kai.rules ?? (() => "act");
  kai.onFrame = (conn, f) => {
    if (f.t === "site") {
      rec.sites.push(f.urls);
      (async () => {
        await kai.beforeSite?.(f.urls);
        const error = kai.siteError?.(f.urls);
        if (error) {
          conn.send({ t: "error", id: f.id, ...error });
          return;
        }
        const rules = f.urls.map((u) => {
          let site = "";
          try {
            site = new URL(u).host;
          } catch {
            /* none */
          }
          return { site, rule: kai.rules(u) };
        });
        conn.send({ t: "site", id: f.id, rules });
      })().catch((e) => console.log(`  the fake Kai's site answer failed: ${e.message}`));
      return;
    }
    if (f.t === "ack") {
      const r = rec.open.get(f.id);
      if (r) {
        r.acked = Math.max(r.acked, Math.min(f.seq, r.sent.length));
        r.wake?.();
      }
      return;
    }
    if (f.t === "abort") {
      const r = rec.open.get(f.id);
      if (r) {
        r.aborted = true;
        rec.open.delete(f.id);
        r.wake?.();
      }
      return;
    }
    if (f.t !== "req") return;
    const r = { frame: f, sent: [], acked: 0, aborted: false, ended: null, wake: null, maxAhead: 0, ackedBeforeEnd: 0 };
    rec.reqs.push(r);
    rec.open.set(f.id, r);
    run(conn, r, lmgw.answer({ method: f.method, path: f.path, headers: f.headers, body: f.body, read: f.read }), ahead, rec).catch((e) => {
      r.ended = { error: String(e) };
    });
  };
  return rec;
}

async function run(conn, r, a, ahead, rec) {
  const id = r.frame.id;
  const text = !Buffer.isBuffer(a.body);
  conn.send({ t: "res", id, status: a.status, headers: a.headers, body: text ? "text" : "base64" });
  const piece = async (data) => {
    const frame = { t: "chunk", id, seq: r.sent.length, data };
    const len = sizeOf(JSON.stringify(frame));
    // Kai's window: a piece goes while the unacknowledged pieces, it included, stay within it.
    for (;;) {
      if (r.aborted || conn.closed) return false;
      const out = r.sent.slice(r.acked).reduce((x, y) => x + y, 0);
      if (r.acked === r.sent.length || out + len <= ahead) break;
      await new Promise((w) => (r.wake = w));
      r.wake = null;
    }
    conn.send(frame);
    r.sent.push(len);
    r.maxAhead = Math.max(r.maxAhead, r.sent.slice(r.acked).reduce((x, y) => x + y, 0));
    return true;
  };
  if (a.stream) {
    for await (const t of a.stream) {
      if (!(await piece(t))) return;
    }
  } else {
    const body = text ? a.body : a.body.toString("base64");
    for (let i = 0; i < body.length; i += PIECE) if (!(await piece(body.slice(i, i + PIECE)))) return;
  }
  if (r.aborted || conn.closed) return;
  r.ackedBeforeEnd = r.acked;
  rec.open.delete(id);
  r.ended = { seq: r.sent.length };
  conn.send({ t: "end", id, seq: r.sent.length });
}

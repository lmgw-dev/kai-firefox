// The link to Kai (design §2, §4): the native port to kai-browser-host, which Firefox starts and
// ends with the port, and the conversation with Kai through it.
//
// - The background owns the port: an open native port keeps an MV3 event page from being
//   suspended (WP0 (a)).
// - `config` goes to the host once per port, and again when the user changes retry_ms; never in
//   reaction to `kai up:false` (the host retries by itself).
// - After `kai up:true` the extension sends only `hello` until `welcome` or `refused`.
// - Frames longer than LIMIT go to Kai as split frames; Kai's split frames are joined (frames.js).
// - When the port ends (the helper is missing, crashed or was ended), the helper is started
//   again after retry_ms, doubling with each failure in a row up to HELPER_RETRY_MAX_MS; the
//   wait shows in the status. While the port is down Firefox may suspend the background; it
//   starts again on the next tab or window event (main.js, tabs.js and refs.js listen at the top
//   level: switching tabs, a navigation, a tab or window closing, a window focused) and connects.
// - A refusal stays shown while Kai answers each of the host's tries with another; when no try
//   reaches Kai within twice retry_ms after the refused link closed, Kai shows as not running.
// - The sidebar's requests (sidebar.js) go to Kai with toKai(); Kai's answers to them (`res`, and
//   `chunk` and `end` keyed by `id`) go to the handler onBody() registered, and onLink() hears the
//   link come and go.

import { LIMIT, frameBytes, split, Joiner, BadSplit } from "./frames.js";
import * as ops from "./ops.js";
import * as status from "./status.js";
import { settings, profileId, HELPER_RETRY_MAX_MS } from "./settings.js";

const HOST = "dev.rootshell.kai";
const PROTOCOL = 1;

let port = null;
// "down": no Kai behind the host; "hello": hello sent, waiting; "linked"; "refused": Kai
// refused and will close.
let phase = "down";
// Bumped at every hello: results of operations a previous link asked for are dropped.
let link = 0;
let splits = 0;
// The last event frame's number on this link (`seq`, from 1).
let eventSeq = 0;
const joiner = new Joiner();
// op id -> { controller, link }
const running = new Map();
let helperFailures = 0;
let retryTimer = null;
let gotFrame = false;
// The reason of the refusal the status shows, while Kai keeps refusing; null otherwise.
let refusal = null;
// What the linked Kai said of itself in its welcome: its version, and the frames of the
// extension's it takes (`takes`, a list since Kai's answer to the sidebar's site question; a Kai
// before that sends none).
let kai = { version: null, takes: null };
let refusedTimer = null;

export function start() {
  connect();
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const p = browser.runtime.connectNative(HOST);
  port = p;
  phase = "down";
  gotFrame = false;
  joiner.reset();
  p.onMessage.addListener((m) => {
    if (port === p) onMessage(m);
  });
  p.onDisconnect.addListener(() => {
    if (port === p) portGone(p.error);
  });
  if (!refusal) status.set({ link: "starting", helper_retry_at: null });
  sendConfig();
}

// Tells the host how often to try Kai's socket (retry_ms).
export function sendConfig() {
  post({ t: "config", retry_ms: settings.retry_ms });
}

function post(frame) {
  try {
    port?.postMessage(frame);
    return true;
  } catch (e) {
    console.warn(`Kai for Firefox: a ${frame.t} frame was not sent: ${e.message}`);
    return false;
  }
}

// A frame for Kai, split when longer than LIMIT.
function send(frame) {
  if (phase !== "linked" && frame.t !== "hello") {
    console.warn(`Kai for Firefox: a ${frame.t} frame was not sent: no link`);
    return;
  }
  const text = JSON.stringify(frame);
  if (frameBytes(text) <= LIMIT) {
    post(frame);
    return;
  }
  for (const piece of split(text, ++splits)) if (!post(piece)) return;
}

function portGone(error) {
  port = null;
  phase = "down";
  refusal = null;
  clearTimeout(refusedTimer);
  joiner.reset();
  abortAll("the link to Kai closed");
  helperFailures = gotFrame ? 1 : helperFailures + 1;
  const wait = Math.min(settings.retry_ms * 2 ** (helperFailures - 1), HELPER_RETRY_MAX_MS);
  const reason = error?.message || "it ended";
  console.warn(`Kai for Firefox: the native port to ${HOST} closed (${reason}); starting it again in ${wait} ms (failure ${helperFailures} in a row; the wait doubles up to ${HELPER_RETRY_MAX_MS} ms)`);
  status.set({ link: "no_helper", reason, helper_retry_at: Date.now() + wait, helper_failures: helperFailures, kai_version: null, protocol: null });
  retryTimer = setTimeout(connect, wait);
}

function onMessage(m) {
  gotFrame = true;
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    console.warn("Kai for Firefox: a frame that is no JSON object; ignored");
    return;
  }
  const bad = joiner.interrupted(m);
  if (bad) badSplit(bad);
  if ((m.t === "chunk" || m.t === "end") && "split" in m) {
    let whole;
    try {
      whole = joiner.piece(m);
    } catch (e) {
      if (e instanceof BadSplit) badSplit(e);
      else throw e;
      return;
    }
    if (whole) handle(whole);
    return;
  }
  handle(m);
}

function badSplit(e) {
  console.warn(`Kai for Firefox: a split frame from Kai dropped: ${e.message}`);
  status.set({ last_error: { code: "bad_split", message: e.message, at: Date.now() } });
  if (phase === "linked") send({ t: "error", code: "bad_split", split: e.split, message: e.message });
}

function handle(m) {
  switch (m.t) {
    case "kai":
      if (m.up === true) {
        helperFailures = 0;
        clearTimeout(refusedTimer);
        // up:true while a hello is out or the link is up is the host's answer to a config.
        if (phase === "down" || phase === "refused") hello();
      } else if (m.up === false) {
        if (phase === "linked" || phase === "hello") abortAll("Kai went away");
        const wasRefused = phase === "refused";
        phase = "down";
        // A split cut off by the closing link is dropped without a word (§4.2).
        joiner.reset();
        clearTimeout(refusedTimer);
        // Kai closes a refused link itself and the host tries again after retry_ms; the added
        // second is slack for a busy machine.
        if (wasRefused) refusedTimer = setTimeout(kaiDown, 2 * settings.retry_ms + 1000);
        else kaiDown();
      }
      return;
    case "welcome":
      if (phase !== "hello") {
        console.warn("Kai for Firefox: a welcome without a hello; ignored");
        return;
      }
      phase = "linked";
      refusal = null;
      eventSeq = 0;
      kai = { version: m.kai_version ?? null, takes: Array.isArray(m.takes) ? m.takes.map(String) : null };
      status.set({ link: "linked", reason: null, kai_version: m.kai_version ?? null, protocol: m.protocol ?? null });
      for (const f of linkHandlers) f(true);
      return;
    case "refused":
      phase = "refused";
      refusal = String(m.reason ?? "no reason given");
      clearTimeout(refusedTimer);
      abortAll("Kai refused the link");
      console.warn(`Kai for Firefox: Kai refused the link: ${m.reason}`);
      status.set({ link: "refused", reason: refusal, kai_version: null, protocol: null });
      return;
    case "error": {
      const e = { code: String(m.code ?? "error"), message: String(m.message ?? ""), at: Date.now() };
      if (m.size !== undefined) e.size = m.size;
      if (m.limit !== undefined) e.limit = m.limit;
      console.warn(`Kai for Firefox: an error frame (${e.code}): ${e.message}`);
      status.set({ last_error: e });
      // One that names a request (`duplicate_req`) is about one of the sidebar's: it ends there.
      if (m.id !== undefined && m.id !== null && phase === "linked") bodyHandler?.(m);
      return;
    }
    case "op":
      if (phase !== "linked") {
        console.warn(`Kai for Firefox: an op before the link; ignored`);
        return;
      }
      runOp(m);
      return;
    case "cancel": {
      const r = running.get(m.id);
      if (r) r.controller.abort(new ops.OpError("cancelled", "Kai cancelled the call"));
      return;
    }
    case "answer":
      if (phase !== "linked") return;
      if (!answerHandler || !answerHandler(m.id, m.allow === true)) console.warn(`Kai for Firefox: an answer to ask ${JSON.stringify(m.id)}, which is not waiting; ignored`);
      return;
    case "res":
    case "chunk":
    case "end":
    case "site":
      // A split frame's pieces never come here (onMessage joins them): these are the sidebar's
      // (`site`: Kai's answer to the sidebar's question about a site's rule).
      if (phase === "linked") bodyHandler?.(m);
      return;
    default:
      console.debug(`Kai for Firefox: a ${m.t} frame, which this version does not handle; ignored`);
  }
}

function kaiDown() {
  refusal = null;
  status.set({ link: "kai_down", reason: null, kai_version: null, protocol: null, helper_retry_at: null, helper_failures: 0 });
}

async function hello() {
  phase = "hello";
  const mine = ++link;
  splits = 0;
  if (!refusal) status.set({ link: "linking" });
  const [info, profile] = await Promise.all([browser.runtime.getBrowserInfo(), profileId()]);
  const frame = {
    t: "hello",
    protocol: PROTOCOL,
    ext_version: browser.runtime.getManifest().version,
    firefox: info.version,
    profile,
    ops: ops.served(),
  };
  status.set({ firefox: info.version, profile, ops: frame.ops });
  if (phase === "hello" && link === mine) send(frame);
}

async function runOp(m) {
  const { id, op, args } = m;
  if (!Number.isSafeInteger(id)) {
    console.warn("Kai for Firefox: an op without a whole-number id; ignored");
    return;
  }
  const entry = { controller: new AbortController(), link };
  running.get(id)?.controller.abort(new ops.OpError("cancelled", `Kai sent another call with id ${id}`));
  running.set(id, entry);
  let reply;
  try {
    const ok = await ops.run(op, args, { signal: entry.controller.signal, id });
    reply = { t: "op_result", id, ok: ok ?? {} };
  } catch (e) {
    if (!(e instanceof ops.OpError)) console.error(`Kai for Firefox: ${op} failed`, e);
    reply = { t: "op_result", id, error: ops.errorOf(e) };
  } finally {
    if (running.get(id) === entry) running.delete(id);
  }
  if (entry.link === link && phase === "linked") send(reply);
}

function abortAll(why) {
  for (const r of running.values()) r.controller.abort(new ops.OpError("closed", why));
  running.clear();
  for (const f of lostHandlers) f(why);
  for (const f of linkHandlers) f(false);
}

// The network gate's question to Kai (design §4.2, §6.4); false when there is no link to ask
// on, so nobody can answer it.
export function ask(frame) {
  if (phase !== "linked") return false;
  send({ ...frame, t: "ask" });
  return true;
}

// An `event` frame for Kai (design §4.2, §7.1), numbered in the order sent; false when there is
// no link, and then nothing is kept for a later one.
export function event(frame) {
  if (phase !== "linked") return false;
  send({ t: "event", seq: ++eventSeq, ...frame });
  return true;
}

// Kai's `answer` frames go to `fn(id, allow)`, which says whether an ask was waiting for it.
let answerHandler = null;
export const onAnswer = (fn) => (answerHandler = fn);

// `fn(why)` runs when the link ends or Kai goes away: questions asked on it get no answer.
const lostHandlers = [];
export const onLost = (fn) => lostHandlers.push(fn);

// A frame for Kai from the sidebar's relay (sidebar.js); false when there is no link to send it on.
export function toKai(frame) {
  if (phase !== "linked") return false;
  send(frame);
  return true;
}

// Whether the link to Kai is up now.
export const linked = () => phase === "linked";

// Whether the linked Kai takes the extension's frame `t`, by its welcome's `takes`: a Kai whose
// welcome has none is older than the list, which came with its answer to the sidebar's site
// question. Its version, for saying so.
export const kaiTakes = (t) => phase === "linked" && (kai.takes?.includes(t) ?? false);
export const kaiVersion = () => kai.version;

// Kai's `res`, and its `chunk`, `end`, `site` and `error` frames keyed by `id`, go to `fn(frame)`
// (sidebar.js).
let bodyHandler = null;
export const onBody = (fn) => (bodyHandler = fn);

// `fn(up)` runs when the link comes (true, at the welcome) and when it goes (false).
const linkHandlers = [];
export const onLink = (fn) => linkHandlers.push(fn);

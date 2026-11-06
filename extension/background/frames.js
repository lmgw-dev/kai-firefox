// Frames in pieces (design §4.1, §4.2), the extension's half of Kai's `src/browser/chunk.rs`.
// Firefox takes at most LIMIT bytes of JSON in one message from the host, and writes one large
// message toward the host slowly, so both sides send a frame longer than LIMIT as
//   {"t":"chunk","split":<n>,"seq":<i>,"data":"<a piece of the frame's JSON text>"} ...
//   {"t":"end","split":<n>,"seq":<count>}
// and the receiver joins the `data` texts in `seq` order and reads them as one frame. Splitting is
// framing, not a cap: the pieces join to exactly the frame. No browser API here, so Node's tests
// import this file as it is.

// Firefox's `webextensions.native-messaging.max-input-message-bytes` (MAX_READ): one message of
// at most this many bytes of UTF-8 JSON, this size included, reaches the extension.
export const LIMIT = 1024 * 1024;

const encoder = new TextEncoder();

// The UTF-8 bytes of a frame as Firefox sends it (JSON.stringify, then UTF-8).
export const frameBytes = (text) => encoder.encode(text).length;

// The bytes one code point of `data` takes inside a JSON string as JSON.stringify writes it.
function escapedLen(cp) {
  if (cp === 0x22 || cp === 0x5c) return 2; // " and \
  if (cp === 0x08 || cp === 0x0c || cp === 0x0a || cp === 0x0d || cp === 0x09) return 2;
  if (cp < 0x20) return 6; // \u00XX
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // a lone surrogate, written as \uXXXX
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}
// The widest a code point gets (\u00XX).
const WIDEST = 6;

// `text` (a serialized frame, longer than `limit`) as the frames that carry it: chunk frames of
// split `n` and the end, as objects whose JSON is at most `limit` bytes each. Pieces are cut
// between code points, never inside a surrogate pair.
export function split(text, n, limit = LIMIT) {
  const out = [];
  let seq = 0;
  let i = 0;
  while (i < text.length) {
    const empty = frameBytes(JSON.stringify({ t: "chunk", split: n, seq, data: "" }));
    const room = limit - empty;
    if (room < WIDEST) throw new Error(`a chunk frame's key takes ${empty} bytes, which leaves no room for data in a frame of at most ${limit} bytes`);
    let used = 0;
    const start = i;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      const w = escapedLen(cp);
      if (used + w > room) break;
      used += w;
      i += cp > 0xffff ? 2 : 1;
    }
    out.push({ t: "chunk", split: n, seq, data: text.slice(start, i) });
    seq++;
  }
  out.push({ t: "end", split: n, seq });
  return out;
}

// A split that cannot be joined: dropped, and said in an `error` frame (`bad_split`).
export class BadSplit extends Error {
  constructor(split, message) {
    super(message);
    this.split = split;
  }
}

const isWhole = (v) => Number.isSafeInteger(v) && v >= 0;

// The host's own frames (design §4.2): `kai`, and `error` with its codes. The host writes them
// between Kai's frames, so they may come between a split's pieces; they are not Kai's and do not
// interrupt it.
const HOST_ERRORS = new Set(["frame_too_large", "bad_config"]);
export const fromHost = (f) => !!f && (f.t === "kai" || (f.t === "error" && HOST_ERRORS.has(f.code)));

// One link's incoming split frames, joined. The rules and the words are Kai's Joiner's: a split's
// pieces come one after the other, `seq` from 0, and its end's `seq` is their count; anything else
// from Kai drops the split with a BadSplit, and its later pieces and end are read past. The host's
// own frames pass (fromHost).
export class Joiner {
  open = null; // { split, count, text }
  dropped = null;

  // A frame `f` came: when a split is open and `f` is not its next piece or end, the split is
  // dropped, and the BadSplit saying why is returned.
  interrupted(f) {
    if (!this.open || fromHost(f)) return null;
    const t = f && typeof f.t === "string" ? f.t : null;
    if ((t === "chunk" || t === "end") && f.split === this.open.split) return null;
    const split = this.open.split;
    this.#dropOpen();
    let what;
    if ((t === "chunk" || t === "end") && isWhole(f.split)) what = `split ${f.split}'s ${t}`;
    else if (t) what = `Kai's ${t} frame`;
    else what = "a frame without a type";
    return new BadSplit(split, `split ${split} was interrupted by ${what} (a split's pieces come one after the other); it is dropped`);
  }

  // A `chunk` or `end` frame with a `split` key, after interrupted(): the joined frame (an
  // object) at a valid end, else null; throws BadSplit.
  piece(f) {
    const { t, split, seq } = f;
    if (!isWhole(split) || !isWhole(seq)) {
      this.#dropOpen();
      if (isWhole(split)) this.dropped = split;
      throw new BadSplit(isWhole(split) ? split : null, `a ${t} frame from Kai needs a whole-number split and seq`);
    }
    if (!this.open && this.dropped === split) {
      if (t === "end") this.dropped = null;
      return null;
    }
    const fail = (message) => {
      this.#dropOpen();
      this.dropped = split;
      throw new BadSplit(split, message);
    };
    if (this.open && this.open.split !== split) fail(`split ${split}'s ${t} came while split ${this.open.split} was open; both are dropped`);
    if (t === "end") {
      const o = this.open;
      if (!o) fail(`an end of split ${split}, which never began`);
      this.open = null;
      if (o.count !== seq) fail(`split ${split} ended at seq ${seq}, and ${o.count} pieces came`);
      const text = o.parts.join("");
      let frame;
      try {
        frame = JSON.parse(text);
      } catch (e) {
        fail(`split ${split} joined to ${frameBytes(text)} bytes that are no JSON: ${e.message}`);
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.t !== "string" || frame.t === "chunk" || frame.t === "end") {
        fail(`split ${split} joined to ${frameBytes(text)} bytes that are no frame (a JSON object with a type other than chunk and end)`);
      }
      return frame;
    }
    if (typeof f.data !== "string") fail(`split ${split}'s piece ${seq} has no text data`);
    if (!this.open) {
      if (seq !== 0) fail(`split ${split}'s piece ${seq} came, and its piece 0 never did`);
      this.open = { split, count: 1, parts: [f.data] };
      return null;
    }
    if (this.open.count !== seq) fail(`split ${split}'s piece ${seq} came where piece ${this.open.count} was due`);
    this.open.count++;
    this.open.parts.push(f.data);
    return null;
  }

  // The split open now; a link that closes drops it.
  get openSplit() {
    return this.open ? this.open.split : null;
  }

  reset() {
    this.open = null;
    this.dropped = null;
  }

  #dropOpen() {
    if (this.open) {
      this.dropped = this.open.split;
      this.open = null;
    }
  }
}

// The frame splitting and joining of extension/background/frames.js (design §4.1, §4.2), in Node:
// pieces within the limit that join to exactly the frame, and every malformed split an error
// with Kai's words. Kai's own splitter is the fake Kai's kaiSplit, written separately.
import assert from "node:assert/strict";
import { LIMIT, frameBytes, split, Joiner, BadSplit } from "../../extension/background/frames.js";
import { kaiSplit } from "../lib/fake-kai.mjs";

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Splits `text` within `limit` and checks the pieces; returns them.
function checkSplit(text, limit, n = 7) {
  const pieces = split(text, n, limit);
  const end = pieces.at(-1);
  const chunks = pieces.slice(0, -1);
  assert.deepEqual(end, { t: "end", split: n, seq: chunks.length });
  chunks.forEach((c, i) => {
    assert.equal(c.t, "chunk");
    assert.equal(c.split, n);
    assert.equal(c.seq, i);
    assert.ok(frameBytes(JSON.stringify(c)) <= limit, `piece ${i} is ${frameBytes(JSON.stringify(c))} > ${limit}`);
    if (!LONE.test(text)) assert.ok(!LONE.test(c.data), `piece ${i} cuts a surrogate pair`);
  });
  assert.equal(chunks.map((c) => c.data).join(""), text, "the pieces join to the frame");
  return pieces;
}

// Feeds frames to a joiner as link.js does; [{ frame } | { error }] in order.
function feed(j, frames) {
  const out = [];
  for (const f of frames) {
    const bad = j.interrupted(f);
    if (bad) out.push({ error: bad.message, split: bad.split });
    if ((f.t === "chunk" || f.t === "end") && "split" in f) {
      try {
        const whole = j.piece(f);
        if (whole) out.push({ frame: whole });
      } catch (e) {
        assert.ok(e instanceof BadSplit);
        out.push({ error: e.message, split: e.split });
      }
    } else out.push({ other: f.t });
  }
  return out;
}

const big = (bytes) => {
  const frame = { t: "op_result", id: 12, ok: { text: "" } };
  const unit = 'a::before { content: "\\201C" } ä€😀\n\t\u0001\u001f"\\ ';
  frame.ok.text = unit.repeat(Math.ceil(bytes / frameBytes(unit)));
  return JSON.stringify(frame);
};

export default [
  {
    name: "frames: the limit is Firefox's 1 048 576 bytes, counted in UTF-8",
    fn() {
      assert.equal(LIMIT, 1048576);
      assert.equal(frameBytes('{"s":"ä€😀"}'), 8 + 2 + 3 + 4);
    },
  },
  {
    name: "frames: a long frame splits within the limit and joins to itself",
    fn() {
      const text = big(4000);
      for (const limit of [60, 61, 97, 128, 1000, frameBytes(text) - 1]) assert.ok(checkSplit(text, limit).length > 2, `limit ${limit}`);
      // Every character class takes its JSON width: pieces stop where one more would not fit.
      for (const c of ["a", '"', "\\", "\n", "\t", "\u0001", "\u001f", "\u007f", "ä", "€", "😀", "/", " ", "\ud800"]) {
        const pieces = checkSplit(c.repeat(300), 80);
        for (const p of pieces.slice(0, -2)) assert.ok(frameBytes(JSON.stringify({ ...p, data: p.data + c })) > 80, `${JSON.stringify(c)}: a piece could have taken one more`);
      }
    },
  },
  {
    name: "frames: a 3 MiB frame at the real limit takes full pieces",
    fn() {
      const text = big(3 * 1024 * 1024);
      const pieces = checkSplit(text, LIMIT, 1);
      assert.equal(pieces.length, Math.ceil(frameBytes(JSON.stringify(text)) / (LIMIT - 64)) + 1);
      for (const p of pieces.slice(0, -2)) assert.ok(frameBytes(JSON.stringify(p)) > LIMIT - 8, "a piece is filled to within one character of the limit");
    },
  },
  {
    name: "frames: Kai's split frames join to the frame",
    fn() {
      const text = big(2500);
      const frames = kaiSplit(text, 4, 200).map((s) => JSON.parse(s));
      const j = new Joiner();
      assert.deepEqual(feed(j, frames), [{ frame: JSON.parse(text) }]);
      assert.equal(j.openSplit, null);
      // Two in a row with a frame between them.
      const twice = [...frames, { t: "op", id: 3 }, ...kaiSplit(text, 5, 200).map((s) => JSON.parse(s))];
      assert.deepEqual(feed(j, twice), [{ frame: JSON.parse(text) }, { other: "op" }, { frame: JSON.parse(text) }]);
    },
  },
  {
    name: "frames: the host's own frames between a split's pieces pass it, and the split joins",
    fn() {
      const text = big(2500);
      const frames = kaiSplit(text, 6, 200).map((s) => JSON.parse(s));
      const host = [
        { t: "kai", up: true },
        { t: "error", code: "frame_too_large", size: 1048577, limit: 1048576, message: "…" },
        { t: "error", code: "bad_config", message: "…" },
      ];
      const mixed = [frames[0], ...host, ...frames.slice(1, 3), host[0], ...frames.slice(3)];
      const out = feed(new Joiner(), mixed);
      assert.deepEqual(out.filter((o) => o.error), []);
      assert.deepEqual(out.at(-1), { frame: JSON.parse(text) });
      assert.deepEqual(out.filter((o) => o.other).map((o) => o.other), ["kai", "error", "error", "kai"]);
      // Kai's own error frame is not the host's: it interrupts.
      const kais = feed(new Joiner(), [frames[0], { t: "error", code: "bad_split", split: 3, message: "…" }]);
      assert.equal(kais[0].error, "split 6 was interrupted by Kai's error frame (a split's pieces come one after the other); it is dropped");
    },
  },
  {
    name: "frames: every malformed split is an error with Kai's words, and the next one joins",
    fn() {
      const text = JSON.stringify({ t: "op", id: 1, op: "tabs.list@1", args: { pad: "y".repeat(300) } });
      const pieces = (n) => kaiSplit(text, n, 100).map((s) => JSON.parse(s));
      const p = pieces(1);
      const n = p.length - 1;
      const errorsOf = (frames) => {
        const out = feed(new Joiner(), [...frames, ...pieces(2)]);
        assert.deepEqual(out.at(-1), { frame: JSON.parse(text) }, "the next split joins after");
        return out.filter((o) => o.error).map((o) => o.error);
      };
      const gap = [...p];
      gap.splice(1, 1);
      assert.deepEqual(errorsOf(gap), ["split 1's piece 2 came where piece 1 was due"]);
      const between = [...p];
      between.splice(1, 0, { t: "op", id: 9 });
      assert.deepEqual(errorsOf(between), ["split 1 was interrupted by Kai's op frame (a split's pieces come one after the other); it is dropped"]);
      const other = feed(new Joiner(), [...p.slice(0, 2), ...pieces(2)]);
      assert.deepEqual(other.filter((o) => o.error), [{ error: "split 1 was interrupted by split 2's chunk (a split's pieces come one after the other); it is dropped", split: 1 }]);
      assert.deepEqual(other.at(-1), { frame: JSON.parse(text) });
      const short = [...p];
      short[n] = { t: "end", split: 1, seq: n + 1 };
      assert.deepEqual(errorsOf(short), [`split 1 ended at seq ${n + 1}, and ${n} pieces came`]);
      assert.deepEqual(errorsOf(p.slice(1)), ["split 1's piece 1 came, and its piece 0 never did"], "the rest is read past");
      assert.deepEqual(errorsOf([{ t: "end", split: 9, seq: 0 }]), ["an end of split 9, which never began"]);
      assert.deepEqual(errorsOf([{ t: "chunk", split: "a", seq: 0, data: "{" }]), ["a chunk frame from Kai needs a whole-number split and seq"]);
      assert.deepEqual(errorsOf([{ t: "chunk", split: 7, seq: 0 }]), ["split 7's piece 0 has no text data"]);
      for (const [data, says] of [
        ["[1, 2]", "no frame"],
        ['{"t": "chunk"}', "no frame"],
        ['{"t": ', "no JSON"],
      ]) {
        const e = errorsOf([
          { t: "chunk", split: 8, seq: 0, data },
          { t: "end", split: 8, seq: 1 },
        ]);
        assert.equal(e.length, 1);
        assert.ok(e[0].startsWith("split 8 joined to") && e[0].includes(says), e[0]);
      }
    },
  },
];

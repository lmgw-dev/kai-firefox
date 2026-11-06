// page.key's parser (extension/background/keys.js) and the network gate's body decoding
// and masking (extension/background/body.js), in Node.
import assert from "node:assert/strict";
import { parseKeys } from "../../extension/background/keys.js";
import { decodeBody, maskText } from "../../extension/background/body.js";

const bytes = (...b) => ({ bytes: new Uint8Array(b).buffer });
const utf8 = (s) => ({ bytes: new TextEncoder().encode(s).buffer });

export default [
  {
    name: "keys: names, characters and modifiers as KeyboardEvents carry them",
    fn() {
      assert.deepEqual(parseKeys("Enter"), { key: "Enter", code: "Enter", keyCode: 13, charCode: 13, ctrl: false, shift: false, alt: false, meta: false, text: "Enter" });
      assert.deepEqual(parseKeys("ctrl+k"), { key: "k", code: "KeyK", keyCode: 75, charCode: 0, ctrl: true, shift: false, alt: false, meta: false, text: "Ctrl+K" });
      assert.deepEqual(parseKeys("Ctrl+Shift+p"), { key: "P", code: "KeyP", keyCode: 80, charCode: 0, ctrl: true, shift: true, alt: false, meta: false, text: "Ctrl+Shift+P" });
      assert.deepEqual(parseKeys("esc").key, "Escape");
      assert.deepEqual(parseKeys("shift+Tab"), { key: "Tab", code: "Tab", keyCode: 9, charCode: 0, ctrl: false, shift: true, alt: false, meta: false, text: "Shift+Tab" });
      assert.deepEqual(parseKeys("space"), { key: " ", code: "Space", keyCode: 32, charCode: 32, ctrl: false, shift: false, alt: false, meta: false, text: "Space" });
      assert.deepEqual(parseKeys(" ").key, " ");
      assert.deepEqual(parseKeys("F5"), { key: "F5", code: "F5", keyCode: 116, charCode: 0, ctrl: false, shift: false, alt: false, meta: false, text: "F5" });
      assert.deepEqual([parseKeys("ä").key, parseKeys("ä").charCode, parseKeys("ä").code], ["ä", 228, ""]);
      assert.deepEqual([parseKeys("7").code, parseKeys("7").keyCode], ["Digit7", 55]);
      assert.deepEqual([parseKeys("+").key, parseKeys("ctrl++").key, parseKeys("ctrl++").ctrl], ["+", "+", true]);
      assert.deepEqual([parseKeys("up").key, parseKeys("PageDown").keyCode], ["ArrowUp", 34]);
      assert.match(parseKeys("ctrl+nope").error, /'nope' is no key/);
      assert.match(parseKeys("hyper+k").error, /'hyper' in 'hyper\+k' is no modifier/);
    },
  },
  {
    name: "body: form fields, JSON, text, binary, files and unreadable bodies",
    fn() {
      assert.equal(decodeBody(undefined), null);
      assert.equal(decodeBody({ raw: [] }), null);
      assert.deepEqual(decodeBody({ formData: { item: ["lamp"], tag: ["a", "b"] } }), { kind: "form", fields: [["item", "lamp"], ["tag", "a"], ["tag", "b"]] });
      assert.deepEqual(decodeBody({ raw: [utf8('{"a":'), utf8('"ä"}')] }), { kind: "json", text: '{"a":"ä"}' });
      assert.deepEqual(decodeBody({ raw: [utf8("seen=1")] }), { kind: "text", text: "seen=1" });
      assert.deepEqual(decodeBody({ raw: [bytes(0, 159, 146, 150, 255)] }), { kind: "binary", bytes: 5, type: null });
      // Valid UTF-8 with control characters is no text.
      assert.deepEqual(decodeBody({ raw: [bytes(0, 1, 2)] }), { kind: "binary", bytes: 3, type: null });
      assert.deepEqual(decodeBody({ raw: [{ file: "/home/user/a.png" }, bytes(1)] }), { kind: "binary", bytes: 1, type: null, files: ["/home/user/a.png"] });
      assert.deepEqual(decodeBody({ error: "too large" }), { kind: "unreadable", why: "too large" });
    },
  },
  {
    name: "body: maskText masks a value as typed, URL-encoded and as JSON writes it, the longest form first",
    fn() {
      const m = (n) => `password field, filled (${n} characters)`;
      assert.equal(maskText("https://shop.example/a?k=pa%20ss%2Fw%C3%B6rd&j=pa+ss%2Fw%C3%B6rd", ["pa ss/wörd"]), `https://shop.example/a?k=${m(10)}&j=${m(10)}`);
      assert.equal(maskText('{"p":"say \\"hi\\""}', ['say "hi"']), `{"p":"${m(8)}"}`);
      assert.equal(maskText("nothing here", []), "nothing here");
      assert.equal(maskText("x", ["   "]), "x");
    },
  },
];

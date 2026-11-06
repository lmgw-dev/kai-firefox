// The frame addresses page.source lists (extension/background/htmlframes.js), in Node: tags found
// as HTML's tokenizer finds them, each value as the text writes it, its origin against the base.
import assert from "node:assert/strict";
import { startTags, frameAddresses } from "../../extension/background/htmlframes.js";

// The character references these tests use; the extension decodes with Firefox's HTML parser.
const decode = (v) => v.replace(/&(amp|quot|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => (dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { amp: "&", quot: '"' }[name.toLowerCase()]));
const page = "https://shop.example/care/lamps.html";

export default [
  {
    name: "html frames: every src and data of a frame element as written, with its origin; each pair once; blank ones left out",
    fn() {
      const html = `<!doctype html><html><head><title>Lamps</title></head><body>
<iframe title="Consent" src="https://consent.example/banner?site=shop&amp;v=2"></iframe>
<IFRAME SRC='//pay.example/card' loading=lazy></IFRAME>
<frame src=sub/menu.html>
<object data="https://media.example/clip.swf" type="x"><embed src=" https://media.example/clip.swf "></object>
<portal src="https://next.example/"></portal>
<iframe src="&#104;ttps://none.example/x"></iframe>
<iframe src="data:text/html,hi"></iframe><iframe src=""></iframe><iframe src="  "></iframe><iframe srcdoc="<p>x</p>"></iframe><iframe src></iframe>
<iframe src="https://consent.example/banner?site=shop&amp;v=2"></iframe>
<img src="https://img.example/a.png"><a href="https://link.example/">x</a>
</body></html>`;
      assert.deepEqual(frameAddresses(html, page, decode), [
        { src: "https://consent.example/banner?site=shop&amp;v=2", origin: "https://consent.example" },
        { src: "//pay.example/card", origin: "https://pay.example" },
        { src: "sub/menu.html", origin: "https://shop.example" },
        { src: "https://media.example/clip.swf", origin: "https://media.example" },
        { src: " https://media.example/clip.swf ", origin: "https://media.example" },
        { src: "https://next.example/", origin: "https://next.example" },
        { src: "&#104;ttps://none.example/x", origin: "https://none.example" },
        { src: "data:text/html,hi", origin: null },
      ]);
      for (const f of frameAddresses(html, page, decode)) assert.ok(html.includes(f.src), `${f.src} is in the text as written`);
    },
  },
  {
    name: "html frames: not in comments or in the text of script, style, textarea, title and iframe; in svg's foreign content and noscript they count; an iframe left open takes the rest as its text",
    fn() {
      const html = `<!-- <iframe src="https://c1.example/"></iframe> --><!--><iframe src="https://after-empty-comment.example/"></iframe>
<!---><iframe src="https://after-dash-comment.example/"></iframe><!-- x --!><iframe src="https://after-bang-comment.example/"></iframe>
<script>document.write('<iframe src="https://s.example/"></iframe>')</script >
<style>/* <iframe src="https://st.example/"> */</style><textarea><iframe src="https://ta.example/"></textarea>
<title><iframe src="https://ti.example/"></title><iframe src="https://outer.example/"><iframe src="https://inner-text.example/"></iframe>
<svg><style><iframe src="https://svg-style.example/"></iframe></style><![CDATA[ <iframe src="https://cdata.example/"> ]]><svg/></svg>
<style><iframe src="https://html-style-again.example/"></style>
<noscript><iframe src="https://noscript.example/"></iframe></noscript>
<p title="a > b" data-x='<iframe src="https://in-attr.example/">'><embed src=https://last.example/x></p>
<iframe src="https://unclosed.example/"><p><iframe src="https://swallowed.example/">`;
      assert.deepEqual(
        frameAddresses(html, page, decode).map((f) => f.origin),
        ["https://after-empty-comment.example", "https://after-dash-comment.example", "https://after-bang-comment.example", "https://outer.example", "https://svg-style.example", "https://noscript.example", "https://last.example", "https://unclosed.example"],
      );
    },
  },
  {
    name: "html frames: the first <base href> before a frame is its base; a quote that is not closed ends the text",
    fn() {
      const html = `<iframe src="a.html"></iframe><base href="https://cdn.example/x/"><base href="https://ignored.example/"><iframe src="b.html"></iframe><iframe src="https://shop.example:8443/c">`;
      assert.deepEqual(frameAddresses(html, page, decode), [
        { src: "a.html", origin: "https://shop.example" },
        { src: "b.html", origin: "https://cdn.example" },
        { src: "https://shop.example:8443/c", origin: "https://shop.example:8443" },
      ]);
      assert.deepEqual(startTags(`<iframe src="https://x.example/ title=x`), [{ tag: "iframe", name: "src", value: "https://x.example/ title=x", quote: '"' }]);
      assert.deepEqual(startTags(`<a b=1 c d = '2'e="3"/>`), [
        { tag: "a", name: "b", value: "1", quote: "" },
        { tag: "a", name: "c", value: null, quote: "" },
        { tag: "a", name: "d", value: "2", quote: "'" },
        { tag: "a", name: "e", value: "3", quote: '"' },
      ]);
    },
  },
];

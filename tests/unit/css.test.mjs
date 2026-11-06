// page.css's split of a style sheet into rules and declarations and the guard that keeps its
// selectors off Kai's overlay host (extension/background/csssplit.js); what a sheet fetches, read
// with CSS's tokenizer (extension/background/cssfetch.js); in Node.
import assert from "node:assert/strict";
import { split, clean, GROUPS, selectorList, guardSelector } from "../../extension/background/csssplit.js";
import { tokenize, urlsOf, blockOf, cssFetches } from "../../extension/background/cssfetch.js";

const shape = (items) => items.map((i) => (i.kind === "decl" ? i.text : { [i.prelude]: shape(i.body) }));

export default [
  {
    name: "css split: rules, declarations, nested rules and statements; strings, comments, url() and escapes split nothing",
    fn() {
      assert.deepEqual(shape(split("h1 { color: red; colr: blue } p::bogus{x:y}")), [{ h1: ["color: red", "colr: blue"] }, { "p::bogus": ["x:y"] }]);
      assert.deepEqual(shape(split(`a::after { content: "a;b}c{"; background: url(x;y{z}.png) } /* ; { */ b { margin: 0 }`)), [
        { "a::after": ['content: "a;b}c{"', "background: url(x;y{z}.png)"] },
        { b: ["margin: 0"] },
      ]);
      assert.deepEqual(shape(split("@import url(more.css); @media screen { .a { color: red; & b { color: blue } } }")), [
        "@import url(more.css)",
        { "@media screen": [{ ".a": ["color: red", { "& b": ["color: blue"] }] }] },
      ]);
      assert.deepEqual(shape(split(".x\\{y { color: red }")), [{ ".x\\{y": ["color: red"] }]);
      assert.deepEqual(shape(split("colr: red")), ["colr: red"]);
      assert.deepEqual(shape(split("  /* nothing */  ")), []);
      // An unclosed block ends with the text.
      assert.deepEqual(shape(split("h1 { color: red")), [{ h1: ["color: red"] }]);
      assert.equal(split("h1 { color: red }")[0].text, "h1 { color: red }");
    },
  },
  {
    name: "css split: names are cleaned of comments and runs of white space; group at-rules are told apart",
    fn() {
      assert.equal(clean("  colr:\n   red /* typo */ "), "colr: red");
      assert.equal(clean(`content: "/* kept */"`), `content: "/* kept */"`);
      assert.ok(GROUPS.test("@media (width > 3px)") && GROUPS.test("@supports (display: grid)") && GROUPS.test("@layer base"));
      assert.ok(!GROUPS.test("@font-face") && !GROUPS.test("@keyframes spin") && !GROUPS.test("@page"));
    },
  },
  {
    name: "css tokens: escapes resolved in names, functions, strings and url( ); comments make none; a dimension's unit is no function",
    fn() {
      const kinds = (css) => tokenize(css).filter((t) => t.type !== "ws").map((t) => [t.type, t.value]);
      assert.deepEqual(kinds(String.raw`u\72l(https://x.example/a)`), [["url", "https://x.example/a"]]);
      assert.deepEqual(kinds(String.raw`\75 RL( "a b" )`), [["function", "uRL"], ["string", "a b"], [")", ")"]]);
      assert.deepEqual(kinds(String.raw`image-set(v\61r(--u) 1x)`), [["function", "image-set"], ["function", "var"], ["ident", "--u"], [")", ")"], ["dimension", "x"], [")", ")"]]);
      assert.deepEqual(kinds(String.raw`"\68ttps:\2f\2f x.example/\"q\"" 'it\'s'`), [["string", 'https://x.example/"q"'], ["string", "it's"]]);
      assert.deepEqual(kinds(`url(a\\ b.png) url( c.png ) url(d e) url(f"g)`), [["url", "a b.png"], ["url", "c.png"], ["bad-url", ""], ["bad-url", ""]]);
      assert.deepEqual(kinds(`/* url(x) "y" */ 5url(z) #h\\31 @media --x -->`), [["dimension", "url"], ["(", "("], ["ident", "z"], [")", ")"], ["hash", "h1"], ["at", "media"], ["ident", "--x"], ["cdc", ""]]);
      assert.deepEqual(kinds('"line\nnext"'), [["bad-string", "line"], ["ident", "next"], ["string", ""]]);
      const [t] = tokenize('  "x"');
      assert.deepEqual([t.type, t.start, t.end], ["ws", 0, 2]);
    },
  },
  {
    name: "css urls: each url( ) and string, those outside a function that takes a file bare; a var( ) inside one is named whole",
    fn() {
      assert.deepEqual(urlsOf(`background-image: image-set(url("a.png") 1x, 'b.png' 2x); cursor: url(c.cur), auto; content: "url(not-this)" /* url(nor-this) */`).urls, [
        { url: "a.png", bare: false },
        { url: "b.png", bare: false },
        { url: "c.cur", bare: false },
        { url: "url(not-this)", bare: true },
      ]);
      assert.deepEqual(urlsOf(String.raw`--u: u\72l(https://x.example/a); src: local("Foo"), url("https://fonts.example/d.woff2") format("woff2")`).urls, [
        { url: "https://x.example/a", bare: false },
        { url: "Foo", bare: true },
        { url: "https://fonts.example/d.woff2", bare: false },
        { url: "woff2", bare: true },
      ]);
      assert.deepEqual(urlsOf("--u: \"https://evil.example/?d=1\"; background-image: image-set(var(--u) 1x), -webkit-image-set(calc(1) v\\61r(--w))").vars, [
        "image-set(var(--u) 1x)",
        "-webkit-image-set(calc(1) v\\61r(--w))",
      ]);
      assert.deepEqual(urlsOf("a: cross-fade(image-set(var(--a)), url(b.png)); b: src(var(--s)); c: image(var(--i)); d: url(\"x\" var(--m)); e: var(--plain); f: image-set(attr(data-u) 1x)").vars, [
        "cross-fade(image-set(var(--a)), url(b.png))",
        "src(var(--s))",
        "image(var(--i))",
        'url("x" var(--m))',
      ]);
      assert.deepEqual(urlsOf("x: image-set(var(--u)").vars, ["image-set(var(--u)"], "an unclosed function to the end");
      assert.equal(blockOf('@property --p { syntax: "*"; initial-value: "https://x.example/p"; }'), ' syntax: "*"; initial-value: "https://x.example/p"; ');
      assert.equal(blockOf("@layer a, b;"), "");
    },
  },
  {
    name: "css fetches: an escaped url( ), a custom property holding an absolute URL as a string or url( ), each once; relative URLs, data:, words with a colon and selectors fetch nothing",
    fn() {
      const f = (decls, rules = []) => cssFetches(decls, rules);
      assert.deepEqual(f([String.raw`background: u\72l(https://x.example/a) var(--n, red);`]), { fetches: [{ origin: "https://x.example", url: "https://x.example/a" }], vars: [] });
      assert.deepEqual(f(['--u: "https://evil.example/?d=1";', "--v: url(HTTP://Other.example:8080/b.png);"]).fetches, [
        { origin: "https://evil.example", url: "https://evil.example/?d=1" },
        { origin: "http://other.example:8080", url: "http://other.example:8080/b.png" },
      ]);
      assert.deepEqual(f([String.raw`--u: "https:\2f\2f x.example/e"; content: "https://x.example/e";`]).fetches, [{ origin: "https://x.example", url: "https://x.example/e" }], "each URL once");
      assert.deepEqual(f(['--rel: "p-rel.png"; background-image: url(css-relative.png), image-set("img/a.png" 1x); content: "Note: see below";']).fetches, []);
      assert.deepEqual(f(['background-image: url("data:image/png;base64,AA"), url(blob:https://x.example/1); --a: "about:blank";']).fetches, []);
      // An opaque URL where a file is named can never be approved; as a mere string it is no site.
      assert.deepEqual(f(['background-image: url(note:x); content: "mailto:a@x.example";']).fetches, [{ origin: null, url: "note:x" }]);
      // Rule texts are read for url( ) and file-taking functions only: a selector's string is no fetch.
      assert.deepEqual(f([], ['a[href^="https://ext.example"]::after { content: "↗"; }', "@font-face { src: url(https://fonts.example/f.woff2); }"]).fetches, [{ origin: "https://fonts.example", url: "https://fonts.example/f.woff2" }]);
      assert.deepEqual(f(['background-image: image-set(var(--u) 1x);'], ['.a { background-image: image-set(var(--u) 1x); }']).vars, ["image-set(var(--u) 1x)"]);
    },
  },
  {
    name: "css guard: each selector's subject excludes the marker, before its pseudo-element; commas and colons inside brackets, strings and functions split nothing",
    fn() {
      const g = (s) => guardSelector(s, "data-kai-ab12");
      const w = ":where(:not([data-kai-ab12]))";
      assert.equal(g("p"), `p${w}`);
      assert.equal(g("*"), `*${w}`);
      assert.equal(g(":root"), `:root${w}`);
      assert.equal(g("a:hover > b.c::after"), `a:hover > b.c${w}::after`);
      assert.equal(g("p:before"), `p${w}:before`);
      assert.equal(g("::selection"), `${w}::selection`);
      assert.equal(g("x-foo::part(label):hover"), `x-foo${w}::part(label):hover`);
      assert.equal(g("h1, h2::first-line, html > div:last-child"), `h1${w}, h2${w}::first-line, html > div:last-child${w}`);
      assert.equal(g(':is(a, b) [title="x::y, z"]'), `:is(a, b) [title="x::y, z"]${w}`);
      assert.equal(g("div:has(> p, ::slotted(x))"), `div:has(> p, ::slotted(x))${w}`);
      assert.equal(g("& > b"), `& > b${w}`);
      assert.deepEqual(selectorList('a, b[x=","], :is(c, d)'), ["a", 'b[x=","]', ":is(c, d)"]);
    },
  },
];

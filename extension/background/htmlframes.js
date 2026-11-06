// The frame addresses in a page's HTML source (page.source): every src and data attribute of an
// iframe, frame, object, embed or portal start tag, as the text writes it, so Kai can take out the
// addresses of frames of sites it does not reach. Tags are found the way HTML's tokenizer finds
// them: not inside comments, nor in the text of script, style, textarea, title and the other
// elements whose text is no markup (outside svg and math, whose CDATA sections are skipped too).
// Where this reading and a browser's could part (a script's text that HTML escapes twice), it
// reads markup where the browser reads text, so it lists more, never less. No browser API here,
// so Node's tests import this file as it is.

const FRAME_TAGS = new Set(["iframe", "frame", "object", "embed", "portal"]);
const URL_ATTRS = new Set(["src", "data"]);
// Elements whose text up to their end tag is no markup; plaintext's runs to the end.
const TEXT_ONLY = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "textarea", "title", "plaintext"]);
const FOREIGN = new Set(["svg", "math"]);
// Start tags that end svg or math content (HTML's tree construction, "breakout" tags).
const BREAKOUT = new Set(
  "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var".split(" "),
);

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isAlpha = (c) => c !== undefined && /^[A-Za-z]$/.test(c);
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// A tag from just after "<" or "</": { name, attrs: [{ name, value, quote }], end, selfClosing };
// `value` as the text writes it (null without "="), `quote` the quote around it ("" for none).
function readTag(html, j) {
  const n = html.length;
  let name = "";
  while (j < n && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">") name += html[j++];
  const attrs = [];
  for (;;) {
    let slash = false;
    while (j < n && (isSpace(html[j]) || html[j] === "/")) slash = html[j++] === "/";
    if (j >= n) return { name: lower(name), attrs, end: n, selfClosing: false };
    if (html[j] === ">") return { name: lower(name), attrs, end: j + 1, selfClosing: slash };
    let an = html[j++];
    while (j < n && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") an += html[j++];
    while (j < n && isSpace(html[j])) j++;
    if (html[j] !== "=") {
      attrs.push({ name: lower(an), value: null, quote: "" });
      continue;
    }
    j++;
    while (j < n && isSpace(html[j])) j++;
    let value = "";
    let quote = "";
    if (html[j] === '"' || html[j] === "'") {
      quote = html[j];
      const close = html.indexOf(quote, j + 1);
      value = html.slice(j + 1, close < 0 ? n : close);
      j = close < 0 ? n : close + 1;
    } else if (html[j] !== ">") {
      const s = j;
      while (j < n && !isSpace(html[j]) && html[j] !== ">") j++;
      value = html.slice(s, j);
    }
    attrs.push({ name: lower(an), value, quote });
  }
}

// Where a comment that begins at `j` (just after "<!--") ends.
function commentEnd(html, j) {
  if (html[j] === ">") return j + 1;
  if (html[j] === "-" && html[j + 1] === ">") return j + 2;
  const ends = [html.indexOf("-->", j), html.indexOf("--!>", j)].filter((k) => k >= 0);
  if (!ends.length) return html.length;
  const k = Math.min(...ends);
  return k + (html.startsWith("-->", k) ? 3 : 4);
}

// Every start tag's attributes in the order of the text: [{ tag, name, value, quote }].
export function startTags(html) {
  const n = html.length;
  const out = [];
  let foreign = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    const c = html[i + 1];
    if (html.startsWith("<!--", i)) {
      i = commentEnd(html, i + 4);
    } else if (foreign && html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      i = end < 0 ? n : end + 3;
    } else if (c === "!" || c === "?") {
      const gt = html.indexOf(">", i + 2);
      i = gt < 0 ? n : gt + 1;
    } else if (c === "/") {
      if (isAlpha(html[i + 2])) {
        const t = readTag(html, i + 2);
        if (foreign && FOREIGN.has(t.name)) foreign--;
        i = t.end;
      } else if (html[i + 2] === ">") i += 3;
      else {
        const gt = html.indexOf(">", i + 2);
        i = gt < 0 ? n : gt + 1;
      }
    } else if (isAlpha(c)) {
      const t = readTag(html, i + 1);
      for (const a of t.attrs) out.push({ tag: t.name, ...a });
      i = t.end;
      if (FOREIGN.has(t.name)) {
        if (!t.selfClosing) foreign++;
      } else if (foreign && BREAKOUT.has(t.name)) foreign = 0;
      else if (!foreign && TEXT_ONLY.has(t.name)) {
        if (t.name === "plaintext") break;
        const re = new RegExp(`</${t.name}[\\t\\n\\f\\r />]`, "ig");
        re.lastIndex = i;
        const m = re.exec(html);
        i = m ? m.index : n;
      }
    } else i++;
  }
  return out;
}

// The frame addresses of `html`, a document answered at `url`: [{ src, origin }], each pair once,
// in the order of the text. `src` is the attribute as the text writes it (character references
// and all), so Kai finds it in the text; `origin` is the origin of the URL it names, resolved
// against the document's base (its first <base href> before it, else `url`), null when it has
// none or an opaque one. `decode(value, quote)` resolves an attribute value's character
// references as HTML does. An attribute that names nothing (empty or blank) is not listed.
export function frameAddresses(html, url, decode) {
  const out = [];
  const seen = new Set();
  let base = url;
  let baseSet = false;
  for (const a of startTags(html)) {
    if (a.value === null) continue;
    if (!baseSet && a.tag === "base" && a.name === "href") {
      baseSet = true;
      try {
        base = new URL(decode(a.value, a.quote).trim(), url).href;
      } catch {
        /* the document's URL stays the base */
      }
      continue;
    }
    if (!FRAME_TAGS.has(a.tag) || !URL_ATTRS.has(a.name)) continue;
    const value = decode(a.value, a.quote).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    if (!value) continue;
    let origin = null;
    try {
      const o = new URL(value, base).origin;
      origin = o === "null" ? null : o;
    } catch {
      /* no URL: no origin */
    }
    const key = `${a.value}\n${origin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src: a.value, origin });
  }
  return out;
}

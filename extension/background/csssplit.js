// CSS text split into its rules and declarations, as far as page.css needs it to name what the
// browser's parser dropped (styles.js asks the parser about each piece). Comments, strings,
// escapes, parentheses and brackets are skipped over, so a ";" or "{" inside them splits nothing.
// No browser API here, so Node's tests import this file as it is.
//
// Items: { kind: "rule", prelude, body: [items], text } for a block (a style rule, an at-rule with
// a block, a nested rule); { kind: "decl", text } for what ends with ";" or its block's end (a
// declaration, or at the top level a statement such as @import).

// The end of the comment, string or bracketed run starting at i, or i + 1.
function skip(css, i) {
  const c = css[i];
  if (c === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if (c === "\\") return Math.min(css.length, i + 2);
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== c && css[j] !== "\n") j = css[j] === "\\" ? j + 2 : j + 1;
    return Math.min(css.length, j + 1);
  }
  if (c === "(" || c === "[") {
    const close = c === "(" ? ")" : "]";
    let j = i + 1;
    while (j < css.length && css[j] !== close) j = /["'/\\([]/.test(css[j]) ? skip(css, j) : j + 1;
    return Math.min(css.length, j + 1);
  }
  return i + 1;
}

// Comments taken out and white space collapsed: how a piece is named in page.css's answer.
export function clean(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const j = skip(text, i);
    if (text[i] === "/" && text[i + 1] === "*") out += " ";
    else out += text.slice(i, j);
    i = j;
  }
  return out.replace(/\s+/g, " ").trim();
}

function items(css, i, nested) {
  const out = [];
  let start = i;
  const piece = (end) => {
    const text = css.slice(start, end);
    if (clean(text)) out.push({ kind: "decl", text: text.trim() });
  };
  while (i < css.length) {
    const c = css[i];
    if (c === ";") {
      piece(i);
      start = ++i;
    } else if (c === "{") {
      const prelude = css.slice(start, i);
      const [body, end] = items(css, i + 1, true);
      out.push({ kind: "rule", prelude: clean(prelude), body, text: css.slice(start, end).trim() });
      start = i = end;
    } else if (c === "}") {
      piece(i);
      if (nested) return [out, i + 1];
      start = ++i;
    } else i = skip(css, i);
  }
  piece(i);
  return [out, i];
}

export const split = (css) => items(css, 0, false)[0];

// At-rules whose block holds rules, which are checked one by one; the blocks of other at-rules
// (@font-face, @keyframes, @page, @property, ...) hold descriptors or keyframes and are checked
// whole.
export const GROUPS = /^@(media|supports|layer|container|scope|starting-style|document|-moz-document)\b/i;

// A selector list split at its top-level commas.
export function selectorList(sel) {
  const out = [];
  let start = 0;
  for (let i = 0; i < sel.length; ) {
    if (sel[i] === ",") {
      out.push(sel.slice(start, i).trim());
      start = ++i;
    } else i = skip(sel, i);
  }
  out.push(sel.slice(start).trim());
  return out;
}

// Pseudo-elements Firefox still reads with one colon.
const LEGACY_PSEUDO = /^:(before|after|first-line|first-letter)(?![\w-])/i;

// `sel` (a selector list) with `:where(:not([marker]))` on each selector's subject, before its
// pseudo-element: no rule of it then styles an element that carries the attribute `marker`. Adds
// no specificity.
export function guardSelector(sel, marker) {
  const guard = `:where(:not([${marker}]))`;
  return selectorList(sel)
    .map((s) => {
      for (let i = 0; i < s.length; ) {
        if (s[i] === ":" && (s[i + 1] === ":" || LEGACY_PSEUDO.test(s.slice(i)))) return `${s.slice(0, i)}${guard}${s.slice(i)}`;
        i = s[i] === ":" ? i + 1 : skip(s, i);
      }
      return `${s}${guard}`;
    })
    .join(", ");
}

// What a style sheet makes Firefox fetch (page.css, page.css_check): its text read with CSS
// Syntax 3's tokenizer (§4.3), so escapes are resolved wherever they are (`u\72l(` is url(,
// `v\61r(` is var(), `"\68ttps:` is "https:) and comments and strings hide nothing. Firefox keeps
// a value with var() and a custom property's value as written, escapes included (measured), so
// the text Firefox writes out is not enough to look at.
//
// A sheet fetches through url( ) and through the strings of the functions that take a file
// (image-set( ) and the others in URL_FUNCS). A custom property's value is used where a rule names
// it, the page's own rules too: a string or url( ) Kai's sheet puts in `--u` is fetched when the
// page's rule says image-set(var(--u)) (measured). So every string of every declaration that is an
// absolute URL of a site counts. A var( ) inside a function that takes a file names what is
// fetched only when the page is styled, so such a sheet is refused (css_var_url). attr( ) there
// fetches nothing: Firefox 159 does not use an attribute's value as a URL (measured).
// No browser API here, so Node's tests import this file as it is.

import { originOf } from "./url.js";

const isDigit = (c) => c >= "0" && c <= "9";
const isHex = (c) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isNewline = (c) => c === "\n" || c === "\r" || c === "\f";
const isSpace = (c) => c === " " || c === "\t" || isNewline(c);
// NUL reads as U+FFFD, which is a name code point.
const isNameStart = (c) => c !== undefined && (/^[A-Za-z_\0]$/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c) => isNameStart(c) || isDigit(c) || c === "-";
const validEscape = (a, b) => a === "\\" && !isNewline(b);
const startsIdent = (a, b, c) => (a === "-" ? isNameStart(b) || b === "-" || validEscape(b, c) : isNameStart(a) || validEscape(a, b));
const startsNumber = (a, b, c) => (a === "+" || a === "-" ? isDigit(b) || (b === "." && isDigit(c)) : a === "." ? isDigit(b) : isDigit(a));
const nonPrintable = (c) => /^[\x01-\x08\x0b\x0e-\x1f\x7f]$/.test(c);
// ASCII case-insensitive.
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// The tokens of `css`: { type, value, start, end }, `value` with escapes resolved (a name's, a
// function's, a string's, a url( )'s), `start` and `end` indexes into `css`. Types: ws, string,
// bad-string, url, bad-url, ident, function, at, hash, number, percentage, dimension, delim, cdo,
// cdc and the punctuation ( ) [ ] { } , : ; as itself. Comments make no token.
export function tokenize(css) {
  const n = css.length;
  const out = [];
  // An escape's code point; `i` is just after the backslash.
  const escape = (i) => {
    if (i >= n) return ["�", i];
    if (isHex(css[i])) {
      let j = i;
      while (j < n && j - i < 6 && isHex(css[j])) j++;
      const cp = parseInt(css.slice(i, j), 16);
      if (css[j] === "\r" && css[j + 1] === "\n") j += 2;
      else if (isSpace(css[j])) j++;
      return [cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp), j];
    }
    const ch = String.fromCodePoint(css.codePointAt(i));
    return [ch === "\0" ? "�" : ch, i + ch.length];
  };
  const name = (i) => {
    let s = "";
    for (;;) {
      if (isName(css[i])) {
        s += css[i] === "\0" ? "�" : css[i];
        i++;
      } else if (validEscape(css[i], css[i + 1])) {
        let ch;
        [ch, i] = escape(i + 1);
        s += ch;
      } else return [s, i];
    }
  };
  const string = (i, quote) => {
    let s = "";
    for (;;) {
      if (i >= n) return ["string", s, i];
      const c = css[i];
      if (c === quote) return ["string", s, i + 1];
      if (isNewline(c)) return ["bad-string", s, i];
      if (c === "\\") {
        if (i + 1 >= n) i++;
        else if (isNewline(css[i + 1])) i += css[i + 1] === "\r" && css[i + 2] === "\n" ? 3 : 2;
        else {
          let ch;
          [ch, i] = escape(i + 1);
          s += ch;
        }
      } else {
        s += c === "\0" ? "�" : c;
        i++;
      }
    }
  };
  const badUrlRest = (i) => {
    while (i < n) {
      if (css[i] === ")") return i + 1;
      if (validEscape(css[i], css[i + 1])) i = escape(i + 1)[1];
      else i++;
    }
    return i;
  };
  // An unquoted url( ); `i` is just after "url(".
  const url = (i) => {
    let s = "";
    while (isSpace(css[i])) i++;
    for (;;) {
      if (i >= n) return ["url", s, i];
      const c = css[i];
      if (c === ")") return ["url", s, i + 1];
      if (isSpace(c)) {
        while (isSpace(css[i])) i++;
        if (i >= n) return ["url", s, i];
        if (css[i] === ")") return ["url", s, i + 1];
        return ["bad-url", "", badUrlRest(i)];
      }
      if (c === '"' || c === "'" || c === "(" || nonPrintable(c)) return ["bad-url", "", badUrlRest(i)];
      if (c === "\\") {
        if (!validEscape(c, css[i + 1])) return ["bad-url", "", badUrlRest(i)];
        let ch;
        [ch, i] = escape(i + 1);
        s += ch;
      } else {
        s += c === "\0" ? "�" : c;
        i++;
      }
    }
  };
  const identLike = (i) => {
    let s;
    [s, i] = name(i);
    if (css[i] !== "(") return ["ident", s, i];
    i++;
    if (lower(s) !== "url") return ["function", s, i];
    while (isSpace(css[i]) && isSpace(css[i + 1])) i++;
    const q = (c) => c === '"' || c === "'";
    if (q(css[i]) || (isSpace(css[i]) && q(css[i + 1]))) return ["function", s, i];
    return url(i);
  };
  const numeric = (i) => {
    if (css[i] === "+" || css[i] === "-") i++;
    while (isDigit(css[i])) i++;
    if (css[i] === "." && isDigit(css[i + 1])) {
      i += 2;
      while (isDigit(css[i])) i++;
    }
    if ((css[i] === "e" || css[i] === "E") && (isDigit(css[i + 1]) || ((css[i + 1] === "+" || css[i + 1] === "-") && isDigit(css[i + 2])))) {
      i += isDigit(css[i + 1]) ? 2 : 3;
      while (isDigit(css[i])) i++;
    }
    if (startsIdent(css[i], css[i + 1], css[i + 2])) {
      const [unit, j] = name(i);
      return ["dimension", unit, j];
    }
    if (css[i] === "%") return ["percentage", "", i + 1];
    return ["number", "", i];
  };
  let i = 0;
  while (i < n) {
    const start = i;
    const c = css[i];
    const [a, b, d] = [css[i + 1], css[i + 2], css[i + 3]];
    let t;
    if (c === "/" && a === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (isSpace(c)) {
      while (isSpace(css[i])) i++;
      t = ["ws", "", i];
    } else if (c === '"' || c === "'") t = string(i + 1, c);
    else if (c === "#" && (isName(a) || validEscape(a, b))) {
      const [s, j] = name(i + 1);
      t = ["hash", s, j];
    } else if ("()[]{},:;".includes(c)) t = [c, c, i + 1];
    else if ((c === "+" || c === ".") && startsNumber(c, a, b)) t = numeric(i);
    else if (c === "-") {
      if (startsNumber(c, a, b)) t = numeric(i);
      else if (a === "-" && b === ">") t = ["cdc", "", i + 3];
      else if (startsIdent(c, a, b)) t = identLike(i);
      else t = ["delim", c, i + 1];
    } else if (c === "<" && a === "!" && b === "-" && d === "-") t = ["cdo", "", i + 4];
    else if (c === "@" && startsIdent(a, b, d)) {
      const [s, j] = name(i + 1);
      t = ["at", s, j];
    } else if (c === "\\" && validEscape(c, a)) t = identLike(i);
    else if (isDigit(c)) t = numeric(i);
    else if (isNameStart(c)) t = identLike(i);
    else {
      const ch = String.fromCodePoint(css.codePointAt(i));
      t = ["delim", ch, i + ch.length];
    }
    [, , i] = t;
    out.push({ type: t[0], value: t[1], start, end: i });
  }
  return out;
}

// The functions whose strings (and var( )s) name a file to load: url( ) with a quoted URL, src( ),
// image-set( ), image( ) and cross-fade( ), with their -webkit- forms.
const URL_FUNCS = /^(url|src|image|(-webkit-)?image-set|(-webkit-)?cross-fade)$/;
const CLOSES = { "(": ")", "[": "]", "{": "}", function: ")" };

// What `css` names to load: { urls: [{ url, bare }], vars: [text] }. `urls`: each url( ) and each
// string, as written with its escapes resolved, `bare` for a string outside a function that takes
// a file; `vars`: each outermost function that takes a file with a var( ) somewhere inside it, as
// `css` writes it.
export function urlsOf(css) {
  const urls = [];
  const vars = [];
  const open = []; // { close, file (takes a file), start, hasVar }
  const fileFn = () => open.find((f) => f.file);
  for (const t of tokenize(css)) {
    if (t.type === "url") urls.push({ url: t.value, bare: false });
    else if (t.type === "string") urls.push({ url: t.value, bare: !fileFn() });
    else if (t.type === "function") {
      if (lower(t.value) === "var" && fileFn()) fileFn().hasVar = true;
      open.push({ close: ")", file: URL_FUNCS.test(lower(t.value)), start: t.start, hasVar: false });
    } else if (CLOSES[t.type]) open.push({ close: CLOSES[t.type], file: false, start: t.start, hasVar: false });
    else if (open.length && t.type === open.at(-1).close) {
      const f = open.pop();
      if (f.hasVar) vars.push(css.slice(f.start, t.end));
    }
  }
  for (const f of open) if (f.hasVar) vars.push(css.slice(f.start));
  return { urls, vars };
}

// The text of a rule's block, after its prelude; "" for a rule without one (@namespace, @layer a).
export function blockOf(ruleText) {
  const open = tokenize(ruleText).find((t) => t.type === "{");
  return open ? ruleText.slice(open.end).replace(/}\s*$/, "") : "";
}

// URLs that load nothing from a site.
const NO_SITE = new Set(["data:", "blob:", "about:"]);

// What a sheet fetches, from `declarations` (the text of every declaration block of its rules,
// nested ones too, never a selector or prelude) and `rules` (the text of each top-level rule but
// @namespace, read again for url( ) and file-taking functions, which no prelude can hide):
// { fetches: [{ origin, url }], vars: [text] }, each once. An absolute URL in url( ) or in a
// function that takes a file is a fetch unless it is data:, blob: or about: (an opaque origin is
// listed as null); a string elsewhere is one when it is an absolute URL with an origin, as
// "Note: x" is no site's. A relative URL reaches no site from Kai's sheet (Firefox resolves it
// against no page; measured).
export function cssFetches(declarations, rules) {
  const seen = new Set();
  const fetches = [];
  const vars = [];
  const take = (text, bareToo) => {
    const found = urlsOf(text);
    for (const v of found.vars) if (!vars.includes(v)) vars.push(v);
    for (const { url, bare } of found.urls) {
      if (bare && !bareToo) continue;
      let u;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      const origin = originOf(u.href);
      if (NO_SITE.has(u.protocol) || (bare && origin === null) || seen.has(u.href)) continue;
      seen.add(u.href);
      fetches.push({ origin, url: u.href });
    }
  };
  for (const d of declarations) take(d, true);
  for (const r of rules) take(r, false);
  return { fetches, vars };
}

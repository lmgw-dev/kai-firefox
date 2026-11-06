// The speech clean-up rules for reading aloud (design §7.3), lifted from an earlier
// extension. Web text carries marks that mean something to the eye and nothing
// to the ear (reference numbers, markdown asterisks, raw URLs, emoji), which a TTS model would
// pronounce, so read.paragraph@1 gives the paragraph as text and as `spoken`, scrubbed by these
// rules. They remove marks and join what they broke; they never drop a sentence or cut the text.
// Each rule can be switched on its own: Kai owns the setting and passes it as `rules`. No browser
// API, so Node's tests load this module.
//
// Page text (`{ page: true }`, read.paragraph's paragraphs) differs in three places from
// the earlier extension's defaults, which stay for other text: DOM text has no markdown list numbers, so a
// line's leading number stays ("3. Oktober", "1. FC Köln"); the symbols rule keeps the section
// sign (§ 5 is read as "section 5"); and the hyphen join joins letters of any script (\p{L}),
// not only \w.

export const RULES = [
  // "infor-\nmation" → "information"; soft hyphens and zero-width characters go.
  { id: "hyphens", apply: joinHyphenation },
  // **bold**, `code`, # headings, bullets, list numbers, tables, [text](url) → text, stray HTML
  // tags.
  { id: "markdown", apply: stripMarkdown },
  // [23], [12–15], [a], [iv], [^1], [citation needed], [edit].
  { id: "citations", apply: stripCitations },
  // ¹²³: off by default, as the same characters carry meaning in units (m², cm³, xⁿ) and nothing
  // tells a reference mark from an exponent.
  { id: "superscripts", on: false, apply: (s) => s.replace(/[\u00B2\u00B3\u00B9\u2070\u2074-\u207F]+/g, "") },
  // URLs and e-mail addresses, which TTS spells out character by character.
  { id: "urls", apply: stripUrls },
  // Emoji, ★ ▪ • bullets, arrows, box drawing.
  { id: "symbols", apply: stripSymbols },
];

export const DEFAULT_RULES = Object.fromEntries(RULES.map((r) => [r.id, r.on !== false]));

// What `rules` must be (an object of the rules' ids with true or false), or null when it is.
export function rulesProblem(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return `an object of rules (${RULES.map((r) => r.id).join(", ")}) with true or false`;
  for (const [k, on] of Object.entries(v)) {
    if (!Object.hasOwn(DEFAULT_RULES, k)) return `an object of the rules ${RULES.map((r) => r.id).join(", ")}; '${k}' is none of them`;
    if (typeof on !== "boolean") return `an object whose values are true or false; '${k}' is not`;
  }
  return null;
}

// The text with the switched-on rules applied in the order above (line-level fixes first, so the
// later ones see joined words), then tidied. `page`: the text is a page's (above).
export function cleanForSpeech(text, rules = {}, { page = false } = {}) {
  let out = String(text ?? "").replace(/\r\n?/g, "\n");
  const on = { ...DEFAULT_RULES, ...rules };
  for (const rule of RULES) if (on[rule.id]) out = rule.apply(out, page);
  return tidy(out);
}

function joinHyphenation(s, page) {
  return s
    .replace(/\u00AD/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(page ? /(\p{L})[-\u2010\u2011]\n(\p{L})/gu : /(\w)[-\u2010\u2011]\n(\w)/g, "$1$2");
}

function stripMarkdown(s, page) {
  return (
    s
      // Fenced code keeps its code; only the fence lines go.
      .replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^\s{0,3}>[ \t]?/gm, "")
      .replace(page ? /^\s*[-*+][ \t]+/gm : /^\s*([-*+]|\d+[.)])[ \t]+/gm, "")
      .replace(/^\s*([-*_][ \t]*){3,}$/gm, "")
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "")
      .replace(/[ \t]*\|[ \t]*/g, " ")
      .replace(/(\*\*|__)(.+?)\1/gs, "$2")
      .replace(/(?<![\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/gs, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/<\/?[a-z][^>\n]*>/gi, "")
      .replace(/~~(.+?)~~/gs, "$1")
  );
}

function stripCitations(s) {
  return (
    s
      .replace(/\[\s*\^?\d+(?:\s*[–—,;-]\s*\d+)*\s*\]/g, "")
      .replace(/\[\s*\^[\w-]+\s*\]/g, "")
      .replace(/\[\s*(?:citation needed|citation-needed|edit|sic|note\s*\d*|nb\s*\d*|clarification needed|verification needed|according to whom\??|who\?|when\?|why\?|update|…|\.\.\.)\s*\]/gi, "")
      // A single letter or a roman numeral only: "[was]" and "[big]" are words, not marks.
      .replace(/\[\s*(?:[a-z]|[ivxlcdm]{2,4})\s*\]/gi, "")
  );
}

function stripUrls(s) {
  return s
    .replace(/<?\bhttps?:\/\/[^\s<>"')\]]+>?/gi, "")
    .replace(/\bwww\.[^\s<>"')\]]+/gi, "")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "");
}

function stripSymbols(s, page) {
  return s
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, "")
    .replace(/[\u2190-\u21FF\u2500-\u257F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF]/g, " ")
    .replace(page ? /[\u2022\u00B7\u25AA\u25AB\u25E6\u2023\u2043\u203B\u00B6\u2020\u2021]/g : /[\u2022\u00B7\u25AA\u25AB\u25E6\u2023\u2043\u203B\u00A7\u00B6\u2020\u2021]/g, " ");
}

// Closes the holes the rules leave: a removed [23] strands a space before the full stop, a
// removed URL strands empty brackets, a removed heading strands a blank line.
function tidy(s) {
  return s
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([,.;:!?%)\]}»”’])/g, "$1")
    .replace(/([(\[{«“‘]) /g, "$1")
    .replace(/(^|\n)[ \t]+/g, "$1")
    .replace(/[ \t]+(\n|$)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

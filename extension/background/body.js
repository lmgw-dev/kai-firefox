// The network gate's view of a request (gate.js): its body decoded, and text with sensitive
// values masked. No browser API, so Node's tests load it.

// A request body as webRequest gives it: null (none), form fields, JSON or text (UTF-8), or
// binary (its size; webRequest gives the body before the headers, so its type is not known).
// Firefox gives form data grouped by name: each name once, in the order of its first field, with
// its values in order.
export function decodeBody(rb) {
  if (!rb) return null;
  if (rb.error) return { kind: "unreadable", why: String(rb.error) };
  if (rb.formData) return { kind: "form", fields: Object.entries(rb.formData).flatMap(([k, vs]) => (Array.isArray(vs) ? vs : [vs]).map((v) => [k, String(v)])) };
  if (!rb.raw?.length) return null;
  const files = rb.raw.filter((p) => p.file).map((p) => p.file);
  const parts = rb.raw.filter((p) => p.bytes).map((p) => new Uint8Array(p.bytes));
  const size = parts.reduce((n, p) => n + p.length, 0);
  if (files.length) return { kind: "binary", bytes: size, type: null, files };
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    return { kind: "binary", bytes: size, type: null };
  }
  // Control characters other than tab and line ends: not text.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return { kind: "binary", bytes: size, type: null };
  try {
    JSON.parse(text);
    return { kind: "json", text };
  } catch {
    return { kind: "text", text };
  }
}

const MASK = (n) => `password field, filled (${n} characters)`;
const codePoints = (s) => [...s].length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Text with each of `values` masked as content/act.js masks it: as typed, trimmed, URL-encoded
// and as JSON writes it. For a URL whose page could not mask it (the values are the ones its
// sensitive fields had when the gate opened).
export function maskText(s, values) {
  const forms = new Map();
  for (const v of values) {
    for (const f of [v, v.trim(), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1)]) if (f.trim()) forms.set(f, codePoints(v));
  }
  if (!forms.size) return s;
  const keys = [...forms.keys()].sort((a, b) => b.length - a.length);
  return s.replace(new RegExp(keys.map(escapeRe).join("|"), "g"), (m) => MASK(forms.get(m)));
}

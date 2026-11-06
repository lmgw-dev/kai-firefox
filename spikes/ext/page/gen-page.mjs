#!/usr/bin/env node
// WP0 (f): generates the large test page into a folder.
//   node page/gen-page.mjs <dir> [--controls 5000]
// index.html: about --controls interactive elements with mixed labelling (aria-label,
// aria-labelledby, <label for>, wrapping labels, alt text, title, placeholder, value, role=button
// with content, hidden content, ::before content), every 10th group inside an open declarative
// shadow root and every 10th + 5 inside a closed one, plus three iframes at the top: two
// same-origin (frame-same-1.html, frame-same-2.html) and one cross-origin (frame-cross.html loaded
// from localhost while the page is on 127.0.0.1). Each control carries data-expect, the name the
// accname spec gives it, so the naming result can be checked.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KINDS = [
  (i) => [`<a href="#l${i}" data-expect="Link text ${i}">Link text ${i}</a>`, 1],
  (i) => [`<button data-expect="Button ${i}">Button ${i}</button>`, 1],
  (i) => [`<button aria-label="Aria button ${i}" data-expect="Aria button ${i}">×</button>`, 1],
  (i) => [`<span id="lb${i}">Labelled by ${i}</span> <input aria-labelledby="lb${i}" data-expect="Labelled by ${i}">`, 1],
  (i) => [`<label for="f${i}">For label ${i}</label> <input id="f${i}" data-expect="For label ${i}">`, 1],
  (i) => [`<label>Wrapping label ${i} <input type="checkbox" data-expect="Wrapping label ${i}"></label>`, 1],
  (i) => [`<a href="#i${i}" data-expect="Image link ${i}"><img alt="Image link ${i}" width="16" height="16"></a>`, 1],
  (i) => [`<input type="text" title="Title only ${i}" data-expect="Title only ${i}">`, 1],
  (i) => [`<select aria-label="Select ${i}" data-expect="Select ${i}"><option>One</option><option>Two</option></select>`, 1],
  (i) => [`<textarea placeholder="Placeholder ${i}" data-expect="Placeholder ${i}"></textarea>`, 1],
  (i) => [`<div role="button" tabindex="0" data-expect="Div button ${i}">Div button ${i}</div>`, 1],
  (i) => [`<input type="submit" value="Submit ${i}" data-expect="Submit ${i}">`, 1],
  (i) => [`<button data-expect="Visible ${i}"><span style="display:none">hidden </span>Visible ${i}</button>`, 1],
  (i) => [`<a href="#c${i}" class="pseudo" data-expect="Icon Before ${i}">Before ${i}</a>`, 1],
];

function group(i) {
  let html = "";
  let n = 0;
  for (const k of KINDS) {
    const [h, c] = k(i);
    html += h + "\n";
    n += c;
  }
  return [html, n];
}

function wrap(i, inner) {
  if (i % 10 === 0) return `<div class="row"><x-host><template shadowrootmode="open"><style>:host{display:block}.pseudo::before{content:"Icon "}</style>${inner}</template></x-host></div>`;
  if (i % 10 === 5) return `<div class="row"><x-host><template shadowrootmode="closed"><style>:host{display:block}.pseudo::before{content:"Icon "}</style><span hidden>closed-root-marker</span>${inner}</template></x-host></div>`;
  return `<div class="row">${inner}</div>`;
}

function page(title, target, { frames = false, prefix = "" } = {}) {
  let body = "";
  let total = 0;
  let i = 0;
  while (total < target) {
    const [h, n] = group(prefix + i);
    body += wrap(i, h);
    total += n;
    i++;
  }
  const frameHtml = frames
    ? `<div class="frames"><iframe src="frame-same-1.html" title="same 1"></iframe><iframe src="frame-same-2.html" title="same 2"></iframe><iframe id="cross" title="cross"></iframe></div>
<script>document.getElementById("cross").src = "http://localhost:" + location.port + "/frame-cross.html";</script>`
    : "";
  return [
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body { font: 14px sans-serif; margin: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0; border-bottom: 1px solid #ddd; }
.pseudo::before { content: "Icon "; }
.frames iframe { width: 400px; height: 260px; border: 1px solid #888; }
input, select, textarea { width: 110px; }
</style></head><body>
<h1>${title}</h1>
${frameHtml}
${body}
</body></html>
`,
    total,
  ];
}

export async function generate(dir, controls = 5000) {
  await mkdir(dir, { recursive: true });
  const counts = {};
  for (const [file, title, n, opts] of [
    ["index.html", "Naming cost test page", controls, { frames: true }],
    ["frame-same-1.html", "Same-origin frame 1", 200, { prefix: "s1-" }],
    ["frame-same-2.html", "Same-origin frame 2", 200, { prefix: "s2-" }],
    ["frame-cross.html", "Cross-origin frame", 200, { prefix: "x-" }],
  ]) {
    const [html, total] = page(title, n, opts);
    await writeFile(join(dir, file), html);
    counts[file] = total;
  }
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node page/gen-page.mjs <dir> [--controls 5000]");
    process.exit(2);
  }
  const i = process.argv.indexOf("--controls");
  console.log(await generate(dir, i > 0 ? Number(process.argv[i + 1]) : 5000));
}

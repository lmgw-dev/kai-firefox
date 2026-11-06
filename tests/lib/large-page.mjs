// The fixture site's generated pages: a large page of controls (after WP0 (f)'s, spikes/ext/page/
// gen-page.mjs) and a PDF larger than one native message.
//   /large?groups=N   N groups of ten controls (two links, five fields), every 10th group in an
//                     open shadow root and every 10th + 5 in a closed one, and three frames at the
//                     top: two same-origin, one cross-origin (localhost against 127.0.0.1)
//   /large-frame?groups=N&p=<prefix>  the same without frames, for the frames
//   /big.pdf          a one-page PDF of about 1.5 MB (a long comment in its content stream)
//   /table?rows=N&cols=M  one table of N data rows and M columns: a header row, a row header per
//                     row, every data cell naming its headers by id

// One group's controls: [html, links, fields].
const group = (i) => [
  `<a href="#l${i}">Link ${i}</a>
<button>Button ${i}</button>
<label for="f${i}">Field ${i}</label> <input id="f${i}">
<label><input type="checkbox"> Check ${i}</label>
<select aria-label="Select ${i}"><option>One</option><option>Two</option></select>
<textarea placeholder="Note ${i}"></textarea>
<div role="button" tabindex="0">Div button ${i}</div>
<input type="submit" value="Submit ${i}">
<a href="#i${i}"><img alt="Image link ${i}" width="16" height="16"></a>
<input type="range" aria-label="Range ${i}">`,
  2,
  5,
];
export const PER_GROUP = { controls: 10, links: 2, fields: 5 };

function rows(groups, prefix) {
  let html = "";
  for (let i = 0; i < groups; i++) {
    const [inner] = group(`${prefix}${i}`);
    if (i % 10 === 0) html += `<div class="row"><x-host><template shadowrootmode="open"><style>:host{display:block}</style>${inner}</template></x-host></div>\n`;
    else if (i % 10 === 5) html += `<div class="row"><x-host><template shadowrootmode="closed"><style>:host{display:block}</style>${inner}</template></x-host></div>\n`;
    else html += `<div class="row">${inner}</div>\n`;
  }
  return html;
}

const STYLE = `<style>
body { font: 14px sans-serif; margin: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0; border-bottom: 1px solid #ddd; }
.frames iframe { width: 400px; height: 260px; border: 1px solid #888; }
input, select, textarea { width: 110px; }
</style>`;

export function largePage(groups, port) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Many controls: Northwind Gear</title>${STYLE}</head><body>
<h1>Many controls</h1>
<div class="frames"><iframe src="/large-frame?groups=20&amp;p=s1-" title="Same 1"></iframe><iframe src="/large-frame?groups=20&amp;p=s2-" title="Same 2"></iframe><iframe src="http://localhost:${port}/large-frame?groups=20&amp;p=x-" title="Cross"></iframe></div>
${rows(groups, "")}
</body></html>`;
}

export const largeFrame = (groups, prefix) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Frame ${prefix}</title>${STYLE}</head><body>
<h2>Frame ${prefix}</h2>
${rows(groups, prefix)}
</body></html>`;

// A PDF with one page that says `title`, padded to about `bytes` by a comment in its content
// stream; the cross-reference table has the real offsets.
export function bigPdf(title = "Northwind Gear big price list", bytes = 1_500_000) {
  const pad = Array.from({ length: Math.ceil(bytes / 64) }, (_, i) => `% padding line ${String(i).padStart(8, "0")} ${"x".repeat(32)}`).join("\n");
  const content = `BT /F1 24 Tf 72 700 Td (${title}) Tj ET\n${pad}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A table of `rows` data rows under one header row; cell (r, c) says "Cell r-c" and names its
// column and row header by id.
export function largeTable(rows, cols) {
  const head = Array.from({ length: cols }, (_, c) => `<th id="c${c}">Column ${c}</th>`).join("");
  let body = "";
  for (let r = 0; r < rows; r++) {
    body += `<tr><th id="r${r}" scope="row">Row ${r}</th>`;
    for (let c = 0; c < cols; c++) body += `<td headers="c${c} r${r}">Cell ${r}-${c}</td>`;
    body += "</tr>\n";
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Large table: Northwind Gear</title></head><body>
<h1>Large table</h1>
<table id="big"><caption>Every row</caption><thead><tr><td></td>${head}</tr></thead><tbody>
${body}</tbody></table>
</body></html>`;
}

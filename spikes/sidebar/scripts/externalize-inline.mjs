#!/usr/bin/env node
// Trunk post_build hook: Trunk 0.21 writes its loader as an inline <script type="module"> in
// index.html, which an extension page's CSP (`script-src 'self' 'wasm-unsafe-eval'`) refuses.
// This moves every inline <script> of the staged index.html into init.js (same directory, so its
// relative imports keep working) and points a <script src> at it. Fails if an inline script is
// left, so a Trunk that starts emitting another inline block cannot slip through.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.env.TRUNK_STAGING_DIR;
if (!dir) {
  console.error("externalize-inline: TRUNK_STAGING_DIR is not set (run it as a Trunk post_build hook)");
  process.exit(1);
}
const file = join(dir, "index.html");
let html = await readFile(file, "utf8");
const inline = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
const parts = [];
html = html.replace(inline, (_m, attrs, body) => {
  if (!/\btype="module"/.test(attrs)) throw new Error("externalize-inline: an inline classic script: " + body.slice(0, 80));
  parts.push(body.trim());
  return parts.length === 1 ? '<script type="module" src="./init.js"></script>' : "";
});
if (parts.length === 0) {
  console.error("externalize-inline: no inline script found (Trunk changed its output?)");
  process.exit(1);
}
await writeFile(join(dir, "init.js"), parts.join("\n\n") + "\n");
await writeFile(file, html);
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) throw new Error("externalize-inline: an inline script is left");
console.log(`externalize-inline: ${parts.length} inline script(s) moved to init.js`);

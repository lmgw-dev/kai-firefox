// Bundles src/naming.js with dom-accessibility-api into ext/naming.bundle.js (one IIFE).
// usage: npm install && npm run build
import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "ext", "naming.bundle.js");
await build({
  entryPoints: [join(here, "src", "naming.js")],
  bundle: true,
  format: "iife",
  target: "firefox154",
  minify: true,
  legalComments: "inline",
  outfile: out,
});
const v = JSON.parse(readFileSync(join(here, "node_modules", "dom-accessibility-api", "package.json"), "utf8")).version;
console.log(`ext/naming.bundle.js: ${statSync(out).size} bytes (dom-accessibility-api ${v})`);

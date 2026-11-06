// Bundles the libraries the content scripts load into extension/vendor/ as classic scripts (one
// IIFE each, setting a global), unminified so a reviewer can read them; the output is committed.
// usage: npm install && npm run vendor [-- <package>...]
// Without packages it builds every bundle the extension loads; naming a package builds that one.
import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundles = [
  { pkg: "dom-accessibility-api", global: "DomAccessibilityApi", out: "dom-accessibility-api.js", loaded: true },
  // Run in a page's top frame by page.text only (background/read.js), not with every page.
  { pkg: "@mozilla/readability", global: "ReadabilityLib", out: "readability.js", loaded: true },
];

const named = process.argv.slice(2);
for (const n of named) if (!bundles.some((b) => b.pkg === n)) throw new Error(`no bundle for ${n}; known: ${bundles.map((b) => b.pkg).join(", ")}`);

for (const b of bundles.filter((x) => (named.length ? named.includes(x.pkg) : x.loaded))) {
  const meta = JSON.parse(readFileSync(join(root, "node_modules", b.pkg, "package.json"), "utf8"));
  const outfile = join(root, "extension", "vendor", b.out);
  await build({
    entryPoints: [b.pkg],
    absWorkingDir: root,
    bundle: true,
    format: "iife",
    globalName: b.global,
    target: "firefox154",
    legalComments: "inline",
    banner: { js: `// ${b.pkg} ${meta.version} (${meta.license}), bundled by scripts/vendor.mjs as the global ${b.global}.` },
    outfile,
  });
  console.log(`extension/vendor/${b.out}: ${statSync(outfile).size} bytes (${b.pkg} ${meta.version})`);
}

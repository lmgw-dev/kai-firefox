// Signs Kai for Firefox with AMO as an unlisted add-on and leaves the signed XPI under
// target/sign/<version>/signed/.
// usage: AMO_JWT_ISSUER=... AMO_JWT_SECRET=... npm run sign [-- --release] [-- --dry-run] [-- --wait-min <minutes>]
//
// - The version is the manifest's three-part base plus a fourth part: the commit count for a build,
//   0 for --release (design §10). The committed manifest is never changed; the version and the
//   channel's update URL are spliced into a copy.
// - The channel comes from the environment (scripts/channel.mjs), never from an option: GITLAB_CI
//   is the builds channel (updates from this project's GitLab package registry), GITHUB_ACTIONS with
//   --release the releases channel (updates from the GitHub repository's latest release), and
//   anything else a local build with no update URL. --release is for GitHub Actions only, and
//   GitHub Actions signs only with --release.
// - With an update channel a second file is made next to the signed one: updates.json, Firefox's
//   update manifest for the XPI (scripts/publish-gitlab.mjs uploads both to GitLab; the release
//   workflow attaches both to the GitHub release).
// - The tree must be clean: the copy and the source upload are both made from HEAD. The sidebar page
//   (sidebar/, Rust and wasm, design §8) is built by `scripts/sidebar.sh release` beforehand (CI's
//   sidebar job; by hand on a desk), never committed: its output in extension/sidebar/ joins the
//   copy when target/sidebar-build.json (scripts/sidebar-build.mjs) says it was built, in release,
//   from HEAD's sidebar/ and LMGW_PIN, and that what is there now (and in the copy) is what that
//   build made; and, for a real run, with rustup's Rust at scripts/ci/rust-version, which the
//   source upload's rust-toolchain.toml names (a dry run only warns of another).
// - target/sign/<version>/ holds ext/ (the copy that is signed), source.zip (AMO's source upload),
//   BUILD-FOR-REVIEWERS.md (also at the zip's root), signed/ (the XPI as AMO named it) and, with an
//   update channel, kai-firefox-<version>.xpi (the same file under the name its update_link has)
//   and updates.json.
// - Resumable: when AMO already knows the version, the signed file is downloaded if there is one,
//   waited for if it is pending, and AMO's status is the failure if it was rejected.
// - Credentials come from the environment (or a gitignored .env), never from the command line.
//   KAI_FIREFOX_UPDATE_TOKEN ("<deploy token user>:<deploy token>", read_package_registry) is read
//   in GitLab CI only: it goes into the update URLs of a private registry, so it is inside every
//   XPI of the builds channel, and Mozilla receives it with the upload.
// - --dry-run does everything except contacting AMO.
// - The source upload carries SOURCE_PATHS (the sidebar's sources and its Cargo.lock among them),
//   plus BUILD-FOR-REVIEWERS.md, a rust-toolchain.toml naming the Rust that built the page
//   (scripts/ci/rust-version) and build-for-amo.sh at its root. lmgw's crates the page is built with (LMGW_PIN) are not in it:
//   build-for-amo.sh clones the public lmgw at LMGW_PIN's lmgw_tag, and while that is
//   `unpublished` a reviewer cannot build the page (the run says so).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ChannelError, channelFor, signedFileProblem, updatesJson, xpiName } from "./channel.mjs";
import { xpiManifest } from "./xpi.mjs";
import { SIDEBAR_OUT, SIDEBAR_RECORD, RUST_VERSION_FILE, buildProblem, rustProblem, sourcesHash, treeHash } from "./sidebar-build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AMO = "https://addons.mozilla.org";
const AMO_VERSION = /^(0|[1-9][0-9]{0,8})([.](0|[1-9][0-9]{0,8})){0,3}$/;
const THREE_PART = /^(0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})$/;
const SOURCE_PATHS = ["extension", "sidebar", "scripts", "LMGW_PIN", "package.json", "package-lock.json", "README.md", "LICENSE.md"];
const POLL_MS = 15000;
const DEFAULT_WAIT_MIN = 60;

const die = (m) => {
  console.error(`sign: ${m}`);
  process.exit(1);
};
const log = (m) => console.log(m);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const fmt = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${(ms / 1000).toFixed(1)} s`;
};
const stamp = (t = Date.now()) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- arguments and credentials -------------------------------------------------------------
let opts;
try {
  opts = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      release: { type: "boolean", default: false },
      "wait-min": { type: "string", default: String(DEFAULT_WAIT_MIN) },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }).values;
} catch (e) {
  die(`${e.message}\nusage: npm run sign [-- --release] [-- --dry-run] [-- --wait-min <minutes>]`);
}
if (opts.help) {
  log("usage: AMO_JWT_ISSUER=... AMO_JWT_SECRET=... npm run sign [-- --release] [-- --dry-run] [-- --wait-min <minutes>]");
  log("  --release        sign <base>.0 instead of <base>.<commit count>; GitHub Actions' release workflow only (and it needs this)");
  log("  --dry-run        stage, lint and build the source archive; do not contact AMO");
  log(`  --wait-min <n>   how long to wait for AMO to sign a pending version (default ${DEFAULT_WAIT_MIN}); re-running resumes`);
  process.exit(0);
}
const waitMin = Number(opts["wait-min"]);
if (!(waitMin > 0)) die(`--wait-min needs a number of minutes above 0, got "${opts["wait-min"]}"`);
const dryRun = opts["dry-run"];

// The channel is read from the environment the process started with: a .env must not be able to
// make a desk look like a CI job.
let channel;
try {
  channel = channelFor(process.env, { release: opts.release });
} catch (e) {
  if (!(e instanceof ChannelError)) throw e;
  die(e.message);
}

// A gitignored .env in the repository root fills in what the environment does not set.
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!dryRun && !(issuer && secret)) {
  const missing = ["AMO_JWT_ISSUER", "AMO_JWT_SECRET"].filter((k) => !process.env[k]);
  die(
    `${missing.join(" and ")} not set. Take both from https://addons.mozilla.org/developers/addon/api/key/ and put them in the ` +
      "environment (or a gitignored .env). Nothing was sent to AMO.",
  );
}

// ---- git: the commit, the version, a clean tree ----------------------------------------------
if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
  die("this checkout is shallow, so the commit count (the build's version) would be wrong; fetch the full history");
}
const commit = git("rev-parse", "HEAD").trim();
const subject = git("log", "-1", "--format=%s", "HEAD").trim().slice(0, 100);

const trackedDirty = git("status", "--porcelain", "-z", "--untracked-files=no").split("\0").filter(Boolean);
const untrackedDirty = git("status", "--porcelain", "-z", "--untracked-files=all", "--", ...SOURCE_PATHS)
  .split("\0")
  .filter((l) => l.startsWith("?? "));
if (trackedDirty.length || untrackedDirty.length) {
  die(
    "the working tree is not clean. The copy that is signed and the source upload are made from HEAD, so they would not " +
      `match what is on disk. Commit or remove these first:\n${[...trackedDirty, ...untrackedDirty].map((l) => `  ${l}`).join("\n")}`,
  );
}

const committedManifest = JSON.parse(git("show", "HEAD:extension/manifest.json"));
const base = committedManifest.version;
if (!THREE_PART.test(base)) die(`extension/manifest.json's version "${base}" is not three numeric parts (the fourth part is the build's)`);
const last = opts.release ? "0" : git("rev-list", "--count", "HEAD").trim();
const version = `${base}.${last}`;
if (!AMO_VERSION.test(version)) die(`"${version}" is not a version AMO accepts (^(0|[1-9][0-9]{0,8})([.](0|[1-9][0-9]{0,8})){0,3}$)`);
const addonId = committedManifest.browser_specific_settings?.gecko?.id;
if (!addonId) die("extension/manifest.json has no browser_specific_settings.gecko.id");

// ---- the sidebar page: built in release from HEAD's sources --------------------------------------
const sidebarSources = sourcesHash(root);
const lmgwTree = execFileSync("bash", ["scripts/lmgw-pin.sh", "tree"], { cwd: root, encoding: "utf8" }).trim();
const lmgwTag = (/^lmgw_tag\s+(\S+)/m.exec(git("show", "HEAD:LMGW_PIN")) ?? [])[1] ?? "unpublished";
let built;
try {
  built = JSON.parse(readFileSync(join(root, SIDEBAR_RECORD), "utf8"));
} catch {
  built = null;
}
if (!existsSync(join(root, SIDEBAR_OUT, "sidebar.html")) || !built) {
  die(`the sidebar page is not built: run scripts/sidebar.sh release (it writes ${SIDEBAR_OUT}/ and ${SIDEBAR_RECORD})`);
}
const sidebarOutput = treeHash(join(root, SIDEBAR_OUT));
const builtProblem = buildProblem(built, { sources: sidebarSources, lmgwTree, output: sidebarOutput });
if (builtProblem) die(`${SIDEBAR_OUT}/ cannot be signed: ${builtProblem} (${SIDEBAR_RECORD}); run scripts/sidebar.sh release`);
const rustPin = git("show", `HEAD:${RUST_VERSION_FILE}`).trim();
const rustNote = rustProblem(built.rustc, rustPin);
if (rustNote && !dryRun) die(`${rustNote}: a reviewer's rustup build would differ. Build with rustup's Rust ${rustPin} (RUSTUP_TOOLCHAIN=${rustPin} scripts/sidebar.sh release), or change ${RUST_VERSION_FILE} and both CIs with it`);

const out = join(root, "target", "sign", version);
const stage = join(out, "ext");
const signedDir = join(out, "signed");
const zipPath = join(out, "source.zip");
const notePath = join(out, "BUILD-FOR-REVIEWERS.md");
const toolchainPath = join(out, "rust-toolchain.toml");
const buildScriptPath = join(out, "build-for-amo.sh");

log(`Kai for Firefox ${version} (${opts.release ? "release" : "build"}, ${channel.name} channel) from ${commit.slice(0, 10)} "${subject}"`);
log(`  output: ${out}`);
if (dryRun) log("  dry run: AMO is not contacted");

// ---- staging: extension/ from HEAD, with the version and the channel's update URL spliced in -------
mkdirSync(out, { recursive: true });
rmSync(stage, { recursive: true, force: true });
const tarPath = join(out, "ext.tar");
execFileSync("git", ["archive", "--format=tar", "--prefix=ext/", `-o`, tarPath, "HEAD:extension"], { cwd: root });
execFileSync("tar", ["-x", "-C", out, "-f", tarPath]);
rmSync(tarPath);
// The sidebar page, built (above) from HEAD's sources; the copy is checked again, as what is signed.
cpSync(join(root, SIDEBAR_OUT), join(stage, "sidebar"), { recursive: true });
if (treeHash(join(stage, "sidebar")) !== built.output) die(`the staged copy of ${SIDEBAR_OUT}/ is not what the recorded build made: it changed while it was copied`);
log(`  sidebar page: ${SIDEBAR_OUT}/ (built from sources ${sidebarSources.slice(0, 12)}, lmgw tree ${lmgwTree.slice(0, 12)}, ${lmgwTag}${built.rustc ? `, ${built.rustc}` : ""}; output ${built.output.slice(0, 12)})`);
if (rustNote) log(`  warning: ${rustNote}; a real run refuses it`);
// The fonts go with their licence (IBM Plex: the SIL Open Font License, fonts/OFL.txt).
const fontsDir = join(stage, "sidebar", "fonts");
if (existsSync(fontsDir) && readdirSync(fontsDir).some((f) => /\.(woff2?|ttf|otf)$/i.test(f)) && !existsSync(join(fontsDir, "OFL.txt"))) {
  die(`the staged sidebar page has fonts without their licence text (sidebar/fonts/OFL.txt): its build did not copy sidebar/assets/IBM-Plex-OFL.txt`);
}
if (lmgwTag === "unpublished") log("  warning: LMGW_PIN's lmgw_tag is unpublished: a reviewer cannot fetch lmgw's crates to build the sidebar page (BUILD-FOR-REVIEWERS.md says so)");

const manifestPath = join(stage, "manifest.json");
const staged = JSON.parse(readFileSync(manifestPath, "utf8"));
staged.version = version;
if (channel.updateUrl) {
  staged.browser_specific_settings ??= {};
  staged.browser_specific_settings.gecko ??= {};
  staged.browser_specific_settings.gecko.update_url = channel.updateUrl;
}
writeFileSync(manifestPath, `${JSON.stringify(staged, null, 2)}\n`);
log(`  staged ${stage}: manifest version ${staged.version}`);
log(`  update_url: ${channel.shown}`);

// ---- lint the staged copy ----------------------------------------------------------------
const webExt = join(root, "node_modules", ".bin", "web-ext");
if (!existsSync(webExt)) die("node_modules/.bin/web-ext is missing; run npm ci");
// --self-hosted: the add-on is unlisted, and an update_url is an error for the listed channel only.
const lint = spawnSync(webExt, ["lint", `--source-dir=${stage}`, "--self-hosted", "--output=json", "--no-input", "--no-config-discovery"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 1 << 28,
});
let report;
try {
  report = JSON.parse(lint.stdout);
} catch {
  die(`web-ext lint gave no JSON report (exit ${lint.status}):\n${lint.stderr || lint.stdout}`);
}
const counts = (list) => {
  const c = {};
  for (const m of list) c[m.code] = (c[m.code] || 0) + 1;
  return Object.entries(c)
    .map(([code, n]) => `${code} x${n}`)
    .join(", ");
};
for (const [kind, list] of [["error", report.errors], ["warning", report.warnings], ["notice", report.notices]]) {
  for (const m of list) log(`  lint ${kind} ${m.code} ${m.file ?? ""}${m.line ? `:${m.line}` : ""}: ${m.message}`);
}
log(`  lint: ${report.errors.length} errors, ${report.warnings.length} warnings, ${report.notices.length} notices`);
for (const [kind, list] of [["errors", report.errors], ["warnings", report.warnings], ["notices", report.notices]]) {
  if (list.length) log(`    ${kind}: ${counts(list)}`);
}
if (report.errors.length) die("web-ext lint found errors in the staged copy; nothing was sent to AMO");

// ---- the source archive for AMO's source upload ------------------------------------------------
const vendorLines = execFileSync("git", ["ls-tree", "--name-only", "HEAD:extension/vendor/"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((f) => `- \`extension/vendor/${f}\`: ${git("show", `HEAD:extension/vendor/${f}`).split("\n", 1)[0].replace(/^\/\/\s*/, "")}`);
writeFileSync(
  notePath,
  `# Building Kai for Firefox ${version}: notes for reviewers

This archive is the git repository \`kai-firefox\` at commit ${commit}, limited to what builds the extension:
${SOURCE_PATHS.map((p) => `\`${p}\``).join(", ")}; besides this note, \`rust-toolchain.toml\` and \`build-for-amo.sh\`
at its root.

## What the submitted XPI is

The XPI is the \`extension/\` folder of this archive with the sidebar page built into \`extension/sidebar/\` (below), and
one change to \`extension/manifest.json\`: its \`version\` is set to \`${version}\` (and, for a build that has an update
channel, \`browser_specific_settings.gecko.update_url\` is added). The file is written out again as JSON, so its line
breaks differ from the archive's. The background script, the content scripts and the options page are plain ES modules
and classic scripts that run as written: there is no transpiler, bundler or minifier in front of them.

## Generated: \`extension/vendor/\`

${vendorLines.join("\n")}

They are bundles (unminified, one IIFE each) of the npm packages pinned in \`package.json\` and \`package-lock.json\`,
made by \`scripts/vendor.mjs\` with esbuild. To make them again, with Node 22 or newer:

\`\`\`sh
npm ci
npm run vendor
\`\`\`

The result equals \`extension/vendor/\` in this archive, file for file.

## Generated: \`extension/sidebar/\`, the sidebar page

The sidebar page is Rust compiled to WebAssembly with Leptos (\`sidebar/\`, its dependencies pinned in
\`sidebar/Cargo.lock\`), built with Trunk by \`scripts/sidebar.sh release\` into \`extension/sidebar/\`: the wasm and
its wasm-bindgen glue (\`kai-firefox-sidebar-*.js\`, \`snippets/\`), the page and its loader, and stylesheets, fonts and
the code-block libraries (\`vendor/\`: highlight.js, KaTeX and DOMPurify as published by their authors, and in Mermaid's
place a stand-in, \`sidebar/assets/mermaid-absent.js\`, since Mermaid's one 5.6 MB script is over the validator's 5 MB)
copied from the crates it builds with (IBM Plex's licence, the SIL Open Font License, beside the fonts:
\`fonts/OFL.txt\`, from \`sidebar/assets/IBM-Plex-OFL.txt\`). It uses lmgw's chat crates (\`lmgw-chat-ui\`, \`lmgw-ui-kit\`, \`lmgw-api-types\`,
\`lmgw-client\`, MIT) at the source tree \`LMGW_PIN\` names (tree ${lmgwTree}${lmgwTag === "unpublished" ? "" : `, release ${lmgwTag} of https://github.com/lmgw-dev/lmgw`}).
${
  lmgwTag === "unpublished"
    ? `
**That lmgw source is not published yet** (\`LMGW_PIN\`'s \`lmgw_tag\` is \`unpublished\`): it is in lmgw's development
repository only, so \`build-for-amo.sh\` cannot fetch it for this version.
`
    : ""
}
The tools: rustup's Rust ${rustPin} with the \`wasm32-unknown-unknown\` target (\`rust-toolchain.toml\`, which rustup
reads; a distribution's own build of Rust has other patches and paths, and makes another wasm), Trunk 0.21.14, wasm-bindgen 0.2.123 and binaryen's wasm-opt version_123 (Trunk fetches the two
into its cache, or takes them from the PATH), Node 22. Then, from this archive's root:

\`\`\`sh
bash build-for-amo.sh
\`\`\`

It clones lmgw at the pinned release next to this folder, checks its tree, and runs \`scripts/sidebar.sh release\`.
The panic messages inside the wasm name source files by their paths with the build machine's prefixes replaced
(\`/cargo\`, \`/rust\`, \`/kai-firefox\`), so they do not depend on where it was built.
`,
);
writeFileSync(
  toolchainPath,
  `# The Rust that built the sidebar page of Kai for Firefox ${version} (scripts/sidebar.sh; ${RUST_VERSION_FILE}).\n[toolchain]\nchannel = "${rustPin}"\nprofile = "minimal"\ntargets = ["wasm32-unknown-unknown"]\n`,
);
writeFileSync(
  buildScriptPath,
  `#!/usr/bin/env bash
# Builds Kai for Firefox ${version}'s generated files from this archive: extension/vendor/ (npm run vendor) and the
# sidebar page in extension/sidebar/ (scripts/sidebar.sh release), with lmgw's crates at the pinned tree.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tag=${lmgwTag === "unpublished" ? "" : lmgwTag}
if [ -z "$tag" ]; then
  echo "lmgw's source for this version (tree ${lmgwTree}) is not published yet; see BUILD-FOR-REVIEWERS.md" >&2
  exit 1
fi
lmgw="$here/../lmgw-$tag"
[ -d "$lmgw" ] || git clone --depth 1 --branch "$tag" https://github.com/lmgw-dev/lmgw "$lmgw"
[ "$(git -C "$lmgw" rev-parse 'HEAD^{tree}')" = "${lmgwTree}" ] || { echo "lmgw $tag has another tree than ${lmgwTree}" >&2; exit 1; }
cd "$here"
npm ci
npm run vendor
LMGW_DIR="$lmgw" bash scripts/sidebar.sh release
`,
);
execFileSync("git", ["archive", "--format=zip", "-o", zipPath, `--add-file=${notePath}`, `--add-file=${toolchainPath}`, `--add-file=${buildScriptPath}`, "HEAD", "--", ...SOURCE_PATHS], { cwd: root });
const zipEntries = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ...SOURCE_PATHS], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean).length;
log(`  source archive: ${zipPath} (${zipEntries + 3} files including BUILD-FOR-REVIEWERS.md, rust-toolchain.toml and build-for-amo.sh, ${statSync(zipPath).size} bytes)`);

if (dryRun) {
  log(`dry run done: ${stage}, ${zipPath}. Credentials ${issuer && secret ? "are set" : "are not set (a real run needs them)"}.`);
  if (channel.updateUrl) log(`A real run would also write kai-firefox-${version}.xpi and updates.json next to signed/ (the ${channel.name} channel).`);
  log(`A real run would: web-ext sign --channel=unlisted --source-dir=${stage} --upload-source-code=${zipPath}`);
  process.exit(0);
}

// ---- AMO ----------------------------------------------------------------------------------------
// AMO's REST API takes a short-lived HS256 JWT made from the same issuer and secret web-ext uses.
function amoJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: issuer, jti: randomUUID(), iat, exp: iat + 240 });
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
// Only ever to AMO's origin: the JWT must not follow a link anywhere else.
const amoGet = (pathOrUrl) => {
  const u = new URL(pathOrUrl, AMO);
  return fetch(new URL(u.pathname + u.search, AMO), {
    headers: { Authorization: `JWT ${amoJwt()}`, Accept: "application/json", "User-Agent": "kai-firefox-sign" },
  });
};

// The version's record on AMO, or null when AMO does not know it (or the add-on, on the first signing).
async function amoVersion() {
  let next = `/api/v5/addons/addon/${encodeURIComponent(addonId)}/versions/?filter=all_with_unlisted`;
  while (next) {
    const r = await amoGet(next);
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) die(`AMO refused the credentials (${r.status}); check AMO_JWT_ISSUER and AMO_JWT_SECRET`);
    if (!r.ok) throw new Error(`AMO answered ${r.status} to the version list: ${(await r.text()).slice(0, 300)}`);
    const body = await r.json();
    const hit = (body.results || []).find((v) => v.version === version);
    if (hit) return hit;
    next = body.next;
  }
  return null;
}
function classify(v) {
  if (!v) return { state: "unknown", text: "not on AMO" };
  const file = v.file || (v.files || [])[0];
  const text = `version id ${v.id}, channel ${v.channel}, file status ${file?.status ?? "none"}${v.is_disabled ? ", version disabled" : ""}`;
  if (v.is_disabled || file?.status === "disabled") return { state: "rejected", text };
  if (file?.status === "public" && file.url) return { state: "signed", url: file.url, text };
  return { state: "pending", text };
}

const tStart = Date.now();
log(`AMO: started ${stamp(tStart)} (wait for a pending version: up to ${waitMin} min, polling every ${POLL_MS / 1000} s; re-run to resume)`);
let rec;
try {
  rec = classify(await amoVersion());
} catch (e) {
  die(`could not ask AMO about ${version}: ${e.message}`);
}
const committedFile = join(out, "uploaded-commit");
let tUploaded = null;
if (rec.state === "unknown") {
  log(`AMO: ${version} is new there; uploading the copy and the source archive with web-ext`);
  // The credentials go through the environment: web-ext echoes its command line when it fails.
  const sign = spawnSync(
    webExt,
    [
      "sign",
      "--channel=unlisted",
      `--source-dir=${stage}`,
      `--artifacts-dir=${signedDir}`,
      `--upload-source-code=${zipPath}`,
      "--approval-timeout=0", // web-ext only uploads; the wait and the download below are this script's
      "--no-input",
      "--no-config-discovery",
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret } },
  );
  if (sign.status !== 0) {
    die(`web-ext sign failed (exit ${sign.status ?? sign.signal}); re-running asks AMO again and resumes if it already has ${version}`);
  }
  tUploaded = Date.now();
  writeFileSync(committedFile, `${commit}\n`);
  log(`AMO: upload accepted ${stamp(tUploaded)} (${fmt(tUploaded - tStart)} after the start)`);
} else {
  log(`AMO: already knows ${version} (${rec.text})`);
  const was = existsSync(committedFile) ? readFileSync(committedFile, "utf8").trim() : null;
  if (was && was !== commit) {
    die(
      `AMO's ${version} came from commit ${was.slice(0, 10)}, this tree is ${commit.slice(0, 10)}: the commit count is the same on two ` +
        "histories. AMO signs each version once; make a commit here (or sign from the other history) so the count moves.",
    );
  }
  if (!was) log(`AMO: warning, no local record of which commit uploaded ${version} (${committedFile}); the XPI below is whatever AMO signed for it`);
}

// Wait for a pending version, give up on a rejected one, then download the signed file.
const deadline = Date.now() + waitMin * 60000;
let lastText = "";
while (rec.state !== "signed") {
  if (rec.state === "rejected") die(`AMO rejected ${version}: ${rec.text}`);
  if (Date.now() > deadline) {
    die(`AMO still has not signed ${version} after ${waitMin} min (${rec.text}); re-run to resume, or raise --wait-min`);
  }
  if (rec.text !== lastText) log(`AMO: waiting for the signature (${rec.state === "unknown" ? "AMO does not list the version yet" : rec.text})`);
  lastText = rec.text;
  await sleep(POLL_MS);
  try {
    rec = classify(await amoVersion());
  } catch (e) {
    die(`lost AMO while waiting for ${version}: ${e.message}; re-run to resume`);
  }
}
const tSigned = Date.now();
log(`AMO: signed, seen ${stamp(tSigned)}`);

const url = new URL(rec.url);
const name = basename(url.pathname);
if (!name.endsWith(".xpi")) die(`AMO's file URL does not end in .xpi: ${url.pathname}`);
const dl = await amoGet(url.pathname + url.search);
if (!dl.ok) die(`downloading the signed XPI failed: AMO answered ${dl.status}; re-run to resume`);
const bytes = Buffer.from(await dl.arrayBuffer());
if (bytes.length < 4 || bytes.subarray(0, 2).toString("latin1") !== "PK") die(`the downloaded file ${name} is not a zip/XPI (${bytes.length} bytes)`);

// What AMO signed must be what this run meant to sign (see signedFileProblem).
let signedManifest;
try {
  signedManifest = xpiManifest(bytes);
} catch (e) {
  die(`could not read manifest.json from the downloaded ${name}: ${e.message}`);
}
const problem = signedFileProblem(signedManifest, { version, channel });
if (problem) {
  die(
    `AMO's signed ${version} is not what this run meant to sign: ${problem}. The file came from another run (a local one, ` +
      "another channel or another token). AMO signs each version once: make a commit so the commit count moves, then sign again.",
  );
}
mkdirSync(signedDir, { recursive: true });
const xpiPath = join(signedDir, name);
writeFileSync(`${xpiPath}.part`, bytes);
renameSync(`${xpiPath}.part`, xpiPath);
const tEnd = Date.now();

log(`AMO: started ${stamp(tStart)}`);
log(`AMO: ended   ${stamp(tEnd)}`);
log(
  `AMO: duration ${fmt(tEnd - tStart)}` +
    (tUploaded ? ` (upload and validation ${fmt(tUploaded - tStart)}, signature ${fmt(tSigned - tUploaded)}, download ${fmt(tEnd - tSigned)})` : " (resumed, so the upload is not in it)"),
);
log(`signed XPI: ${xpiPath}`);
log(`sha256: ${createHash("sha256").update(bytes).digest("hex")}`);

// ---- the update manifest, for a channel that has updates -------------------------------------------
if (channel.updateUrl) {
  const named = join(out, xpiName(version));
  copyFileSync(xpiPath, named);
  const updatesPath = join(out, "updates.json");
  writeFileSync(updatesPath, `${JSON.stringify(updatesJson({ addonId, version, updateLink: channel.xpiLink(version), xpi: bytes }), null, 2)}\n`);
  log(`${channel.name} channel: ${named}`);
  log(`${channel.name} channel: ${updatesPath}`);
} else {
  log("local build: no update URL, no updates.json; Firefox does not update this XPI");
}

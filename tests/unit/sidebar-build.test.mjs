// The sidebar page's build record and its checks (scripts/sidebar-build.mjs, scripts/lmgw-pin.sh
// verify-staged; design §10), in Node: what scripts/sign.mjs refuses to sign, and what
// scripts/sidebar.sh release refuses to build from. Offline: lmgw is a scratch repository here.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProblem, rustProblem, treeHash } from "../../scripts/sidebar-build.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// A scratch folder under target/ (gitignored; /tmp is RAM).
function scratch() {
  mkdirSync(join(ROOT, "target"), { recursive: true });
  return mkdtempSync(join(ROOT, "target", "unit-sidebar-build-"));
}

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();

// A scratch "lmgw" with the crates scripts/lmgw-pin.sh stages, and a scratch kai-firefox root with
// that script and an LMGW_PIN naming the scratch lmgw's commit and tree.
function pinnedPair() {
  const at = scratch();
  const lmgw = join(at, "lmgw");
  write(lmgw, {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.0.1"\nedition = "2024"\nlicense = "MIT"\n',
    "crates/lmgw-chat-ui/Cargo.toml": '[package]\nname = "lmgw-chat-ui"\n',
    "crates/lmgw-chat-ui/src/lib.rs": "pub fn chat() {}\n",
    "crates/lmgw-chat-ui/assets/chat.css": ".chat-head { display: flex; }\n",
    "crates/lmgw-ui-kit/Cargo.toml": '[package]\nname = "lmgw-ui-kit"\n',
    "crates/lmgw-ui-kit/src/lib.rs": "pub fn kit() {}\n",
    "crates/lmgw-api-types/Cargo.toml": '[package]\nname = "lmgw-api-types"\n',
    "crates/lmgw-api-types/src/lib.rs": "pub struct Thread;\n",
    "crates/lmgw-client/Cargo.toml": '[package]\nname = "lmgw-client"\n',
    "crates/lmgw-client/src/lib.rs": "pub fn client() {}\n",
    "crates/lmgw-ui/assets/app.css": "body { margin: 0; }\n",
    "crates/lmgw-ui/assets/fonts/Plex.woff2": "not really a font",
    "crates/lmgw-core/src/lib.rs": "pub fn not_staged() {}\n",
  });
  git(lmgw, "init", "-q");
  git(lmgw, "add", "-A");
  git(lmgw, "commit", "-q", "-m", "scratch lmgw");
  const commit = git(lmgw, "rev-parse", "HEAD");
  const tree = git(lmgw, "rev-parse", "HEAD^{tree}");
  const kf = join(at, "kai-firefox");
  mkdirSync(join(kf, "scripts"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "lmgw-pin.sh"), join(kf, "scripts", "lmgw-pin.sh"));
  writeFileSync(join(kf, "LMGW_PIN"), `lmgw_commit ${commit}\nlmgw_tag unpublished\nlmgw_tree ${tree}\n`);
  const pin = (...args) => spawnSync("bash", [join(kf, "scripts", "lmgw-pin.sh"), ...args, lmgw], { encoding: "utf8" });
  return { at, lmgw, kf, staged: join(kf, "target", "lmgw-pin"), pin };
}

export default [
  {
    name: "sidebar build: the output's hash follows every file's path and bytes, and nothing else",
    fn() {
      const a = scratch();
      try {
        const files = { "sidebar.html": "<!doctype html>", "kai-firefox-sidebar-1a2b.wasm": "\0asm", "fonts/OFL.txt": "SIL Open Font License", "snippets/x/ext.js": "export {};" };
        write(join(a, "one"), files);
        write(join(a, "two"), files);
        const h = treeHash(join(a, "one"));
        assert.match(h, /^[0-9a-f]{64}$/);
        assert.equal(treeHash(join(a, "two")), h, "the same files elsewhere hash the same");
        mkdirSync(join(a, "two", "empty"));
        assert.equal(treeHash(join(a, "two")), h, "an empty folder does not count");
        appendFileSync(join(a, "two", "sidebar.html"), " ");
        assert.notEqual(treeHash(join(a, "two")), h, "a changed byte");
        write(join(a, "two"), { "sidebar.html": "<!doctype html>" });
        assert.equal(treeHash(join(a, "two")), h);
        write(join(a, "two"), { "fonts/extra.woff2": "x" });
        assert.notEqual(treeHash(join(a, "two")), h, "an added file");
        rmSync(join(a, "two", "fonts", "extra.woff2"));
        rmSync(join(a, "two", "fonts", "OFL.txt"));
        assert.notEqual(treeHash(join(a, "two")), h, "a removed file");
        write(join(a, "two"), { "fonts/OFL.txt": "SIL Open Font License" });
        assert.equal(treeHash(join(a, "two")), h);
        renameSync(join(a, "two", "snippets", "x", "ext.js"), join(a, "two", "snippets", "x", "ext2.js"));
        assert.notEqual(treeHash(join(a, "two")), h, "a renamed file");
      } finally {
        rmSync(a, { recursive: true, force: true });
      }
    },
  },
  {
    name: "sidebar build: signing refuses a page the record does not vouch for (another build since, other sources, a debug build, another lmgw)",
    fn() {
      const now = { sources: "s".repeat(64), lmgwTree: "a".repeat(40), output: "o".repeat(64) };
      const record = { sources: now.sources, lmgw_tree: now.lmgwTree, output: now.output, profile: "release", rustc: "rustc 1.98.1 (48a229cea 2026-09-01)", trunk: "trunk 0.21.14" };
      assert.equal(buildProblem(record, now), null);
      // A trunk watch (debug) build of edited sources, the sources then checked out again: the
      // sources match, the output does not.
      assert.match(buildProblem(record, { ...now, output: "d".repeat(64) }), /is not what the recorded build made/);
      assert.match(buildProblem(record, { ...now, sources: "t".repeat(64) }), /other sources/);
      assert.match(buildProblem({ ...record, profile: "debug" }, now), /not in release/);
      assert.match(buildProblem(record, { ...now, lmgwTree: "b".repeat(40) }), /lmgw tree/);
      const { output, ...old } = record;
      assert.match(buildProblem(old, now), /no hash of the built page/);
      assert.match(buildProblem(null, now), /no build record/);
    },
  },
  {
    name: "sidebar build: only rustup's Rust at the pinned version is the page's reproducible Rust",
    fn() {
      assert.equal(rustProblem("rustc 1.98.1 (48a229cea 2026-09-01)", "1.98.1"), null);
      assert.match(rustProblem("rustc 1.98.1 (48a229cea 2026-09-01) (Fedora 1.98.1-1.fc44)", "1.98.1"), /not with rustup's Rust 1\.98\.1/);
      assert.match(rustProblem("rustc 1.99.0 (0123abcde 2026-10-13)", "1.98.1"), /built with Rust 1\.99\.0, not with 1\.98\.1/);
      assert.match(rustProblem(null, "1.98.1"), /an unrecorded rustc/);
    },
  },
  {
    name: "sidebar build: the staged lmgw crates are checked against the pinned tree: an edit, an added or a removed file is refused",
    fn() {
      const { at, staged, pin } = pinnedPair();
      try {
        let r = pin("verify-staged");
        assert.notEqual(r.status, 0, "nothing staged yet");
        assert.match(r.stderr, /is not staged from the pinned lmgw tree/);
        r = pin("stage");
        assert.equal(r.status, 0, r.stderr);
        r = pin("verify-staged");
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /holds the pinned lmgw tree [0-9a-f]{12}: 11 files/);
        // An edit in the staged copy: `stage` skips a staged tree it finds, so only this sees it.
        appendFileSync(join(staged, "crates", "lmgw-chat-ui", "src", "lib.rs"), "pub fn edited() {}\n");
        r = pin("stage");
        assert.equal(r.status, 0);
        assert.match(r.stdout, /is staged in/);
        r = pin("verify-staged");
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /differs from the pinned lmgw tree/);
        assert.match(r.stderr, /^\+ [0-9a-f]{40} crates\/lmgw-chat-ui\/src\/lib\.rs$/m);
        writeFileSync(join(staged, "crates", "lmgw-chat-ui", "src", "lib.rs"), "pub fn chat() {}\n");
        assert.equal(pin("verify-staged").status, 0, "the file as the tree has it again");
        // An added file.
        writeFileSync(join(staged, "crates", "lmgw-ui-kit", "src", "extra.rs"), "pub fn extra() {}\n");
        r = pin("verify-staged");
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /^\+ [0-9a-f]{40} crates\/lmgw-ui-kit\/src\/extra\.rs$/m);
        rmSync(join(staged, "crates", "lmgw-ui-kit", "src", "extra.rs"));
        // A removed file.
        rmSync(join(staged, "crates", "lmgw-ui", "assets", "fonts", "Plex.woff2"));
        r = pin("verify-staged");
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /^- [0-9a-f]{40} crates\/lmgw-ui\/assets\/fonts\/Plex\.woff2$/m);
        writeFileSync(join(staged, "crates", "lmgw-ui", "assets", "fonts", "Plex.woff2"), "not really a font");
        assert.equal(pin("verify-staged").status, 0);
        // The workspace root stage writes.
        appendFileSync(join(staged, "Cargo.toml"), "\n[patch.crates-io]\n");
        r = pin("verify-staged");
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Cargo\.toml is not the workspace root/);
      } finally {
        rmSync(at, { recursive: true, force: true });
      }
    },
  },
];

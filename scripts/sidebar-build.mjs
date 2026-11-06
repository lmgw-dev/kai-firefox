// The sidebar page's build record, target/sidebar-build.json (design §10): what
// `scripts/sidebar.sh release` built extension/sidebar/ from, and a hash of what it built, which
// scripts/sign.mjs checks before the page goes into a signed XPI.
// usage: node scripts/sidebar-build.mjs record   (scripts/sidebar.sh release, after its build)
//
// - `sources`: the sidebar's files and LMGW_PIN as they are on disk, hashed as git hashes them
//   (sign.mjs computes the same of the clean tree it signs).
// - `output`: the built page, every file of extension/sidebar/ by its path and bytes ([treeHash]),
//   so a build made since (a `trunk watch` of edited sources, then the sources checked out again)
//   is told from the one recorded.
// - `lmgw_tree`: the lmgw tree the crates were staged from; sidebar.sh checks the staged files
//   against it before and after the build (scripts/lmgw-pin.sh verify-staged).
// - `rustc`, `trunk`: the tools' versions. The page is reproducible with rustup's Rust at
//   scripts/ci/rust-version ([rustProblem]), which both CIs install and the source upload's
//   rust-toolchain.toml names.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SIDEBAR_OUT = "extension/sidebar";
export const SIDEBAR_RECORD = "target/sidebar-build.json";
export const RUST_VERSION_FILE = "scripts/ci/rust-version";

// A hash of the tree under `dir`: each file's path (relative, `/`-separated, in byte order) and the
// sha256 of its bytes. Empty folders do not count; a file's mode and time do not either.
export function treeHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(relative(dir, p).split(sep).join("/"));
      else throw new Error(`${p} is neither a file nor a folder; the sidebar page's build makes none such`);
    }
  };
  walk(dir);
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const h = createHash("sha256");
  for (const f of files) h.update(`${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}\n`);
  return h.digest("hex");
}

// The sidebar's sources and LMGW_PIN as they are on disk in the checkout at `at`, as git hashes
// them.
export function sourcesHash(at = root) {
  return execFileSync("bash", ["-c", "git ls-files -z -- sidebar LMGW_PIN | xargs -0 git hash-object | sha256sum | cut -c1-64"], { cwd: at, encoding: "utf8" }).trim();
}

// Why the record does not vouch for the page about to be signed (`now`: { sources, lmgwTree,
// output } of the commit and the folder), or null when it does.
export function buildProblem(record, now) {
  if (!record || typeof record !== "object") return "there is no build record";
  if (record.profile !== "release") return `the page was built in ${record.profile ?? "an unknown profile"}, not in release`;
  if (record.sources !== now.sources) return `the page was built from other sources than this commit's sidebar/ and LMGW_PIN (built from ${record.sources}, this commit has ${now.sources})`;
  if (record.lmgw_tree !== now.lmgwTree) return `the page was built against lmgw tree ${record.lmgw_tree}, LMGW_PIN names ${now.lmgwTree}`;
  if (typeof record.output !== "string") return "the record has no hash of the built page (made before sidebar.sh recorded one)";
  if (record.output !== now.output) return `${SIDEBAR_OUT}/ is not what the recorded build made (it hashed ${record.output}, it now hashes ${now.output}): another build, or an edit, came after it`;
  return null;
}

// Why `rustc` (`rustc --version` of the build) is not the Rust the page is reproducible with,
// rustup's `pin` (scripts/ci/rust-version), or null. A distribution's build of the same version
// (Fedora's says so after the date) has its own patches, LLVM and paths.
export function rustProblem(rustc, pin) {
  const m = /^rustc (\d+\.\d+\.\d+) \([0-9a-f]+ \d{4}-\d{2}-\d{2}\)$/.exec(rustc ?? "");
  if (!m) return `the page was built with "${rustc ?? "an unrecorded rustc"}", not with rustup's Rust ${pin}`;
  if (m[1] !== pin) return `the page was built with Rust ${m[1]}, not with ${pin} (${RUST_VERSION_FILE})`;
  return null;
}

const tool = (cmd) => {
  try {
    return execFileSync(cmd, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "record") {
    console.error("usage: node scripts/sidebar-build.mjs record");
    process.exit(2);
  }
  const lmgwTree = execFileSync("bash", [join(root, "scripts", "lmgw-pin.sh"), "tree"], { encoding: "utf8" }).trim();
  const record = {
    sources: sourcesHash(),
    lmgw_tree: lmgwTree,
    output: treeHash(join(root, SIDEBAR_OUT)),
    profile: "release",
    rustc: tool("rustc"),
    trunk: tool("trunk"),
  };
  writeFileSync(join(root, SIDEBAR_RECORD), `${JSON.stringify(record)}\n`);
  const pin = readFileSync(join(root, RUST_VERSION_FILE), "utf8").trim();
  const rust = rustProblem(record.rustc, pin);
  console.log(`recorded the build in ${SIDEBAR_RECORD}: output ${record.output.slice(0, 12)}, sources ${record.sources.slice(0, 12)}, lmgw tree ${lmgwTree.slice(0, 12)}`);
  if (rust) console.log(`warning: ${rust}; a signed release needs rustup's Rust ${pin} (scripts/sign.mjs refuses another)`);
}

#!/usr/bin/env bash
# Builds Kai for Firefox's sidebar page (sidebar/, design §8) into extension/sidebar/, the folder the
# manifest's sidebar_action names. Usage: scripts/sidebar.sh [release|debug|test|clippy]
#   release (default)  trunk build --release: wasm-opt -Oz, what the XPI carries; the staged lmgw
#                      crates checked against the pinned tree before and after the build
#                      (scripts/lmgw-pin.sh verify-staged); records what it was built from and a hash
#                      of what it built in target/sidebar-build.json (scripts/sidebar-build.mjs, which
#                      scripts/sign.mjs checks); needs Node besides
#   debug              trunk build: no wasm-opt, quicker to build (the dev loop)
#   test               cargo test: the wire's tests, natively (no browser)
#   clippy             cargo clippy for wasm32 and natively, warnings as errors
# Each first stages the lmgw crates LMGW_PIN names (scripts/lmgw-pin.sh stage; LMGW_DIR names the
# checkout, else the sibling ../lmgw). Needs trunk 0.21.14 and the wasm32-unknown-unknown target;
# trunk fetches the wasm-bindgen and wasm-opt it wants once into its cache (CI installs them pinned).
# A release that is signed needs rustup's Rust at scripts/ci/rust-version (both CIs install it).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
"$root/scripts/lmgw-pin.sh" stage
cd "$root/sidebar"

# The wasm names the source file of every panic location by the path it was compiled from, so this
# machine's home, cargo's registry and the checkout would go out in the XPI. A cargo configuration
# of the page's own (sidebar/.cargo/config.toml, gitignored, written for this machine) remaps them
# for the wasm32 target only: the native configuration's flags (the linker) stay as they are, and
# the same text each time keeps cargo's fingerprints.
cargo_home=${CARGO_HOME:-$HOME/.cargo}
sysroot=$(rustc --print sysroot)
mkdir -p .cargo
{
  echo "# Written by scripts/sidebar.sh for this machine (gitignored): its paths out of the page's wasm."
  echo "[target.wasm32-unknown-unknown]"
  echo "rustflags = ["
  echo "  \"--remap-path-prefix=$cargo_home/registry/src=/cargo\","
  echo "  \"--remap-path-prefix=$cargo_home/git/checkouts=/cargo-git\","
  echo "  \"--remap-path-prefix=$sysroot=/rust\","
  echo "  \"--remap-path-prefix=$root=/kai-firefox\","
  echo "]"
} >.cargo/config.toml.new
if cmp -s .cargo/config.toml.new .cargo/config.toml; then rm .cargo/config.toml.new; else mv .cargo/config.toml.new .cargo/config.toml; fi

case "${1:-release}" in
  release)
    # The record of an earlier build goes first: a build that fails leaves none.
    rm -f "$root/target/sidebar-build.json"
    "$root/scripts/lmgw-pin.sh" verify-staged
    trunk build --release --locked
    "$root/scripts/lmgw-pin.sh" verify-staged
    # What the page was built from, and a hash of what it built (scripts/sign.mjs checks both).
    node "$root/scripts/sidebar-build.mjs" record
    ;;
  debug)
    trunk build --locked
    rm -f "$root/target/sidebar-build.json"
    ;;
  test) cargo test --locked ;;
  clippy)
    cargo clippy --locked --target wasm32-unknown-unknown --all-targets -- -D warnings
    cargo clippy --locked --lib --tests -- -D warnings
    ;;
  *) echo "usage: $0 [release|debug|test|clippy]" >&2; exit 2 ;;
esac

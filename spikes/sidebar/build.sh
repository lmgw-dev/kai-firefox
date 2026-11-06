#!/usr/bin/env bash
# Build the sidebar spike into dist/ (the extension root). Usage: ./build.sh [release|debug]
#   release (default): trunk build --release, wasm-opt per index.html; debug: unoptimized wasm.
# Needs: trunk, the wasm32-unknown-unknown target, and a sibling lmgw checkout (found by walking up
# from here, or set LMGW_DIR). Only one cargo build at a time; 8 jobs by default.
set -euo pipefail
cd "$(dirname "$0")"
profile="${1:-release}"

find_lmgw() {
  if [[ -n "${LMGW_DIR:-}" ]]; then echo "$LMGW_DIR"; return; fi
  local d="$PWD"
  while [[ "$d" != "/" ]]; do
    d="$(dirname "$d")"
    if [[ -f "$d/lmgw/crates/lmgw-ui-kit/Cargo.toml" ]]; then echo "$d/lmgw"; return; fi
  done
  echo "no sibling lmgw checkout found; set LMGW_DIR" >&2
  exit 1
}
ln -sfn "$(find_lmgw)" .lmgw

: "${CARGO_BUILD_JOBS:=8}"
export CARGO_BUILD_JOBS
case "$profile" in
  release) trunk build --release --dist "dist" ;;
  debug)   trunk build --dist "dist-debug" ;;
  *) echo "usage: $0 [release|debug]" >&2; exit 2 ;;
esac

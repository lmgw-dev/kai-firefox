#!/usr/bin/env bash
# Sizes of the release build, stage by stage, and of the packaged extension. Usage: scripts/sizes.sh
# Run ./build.sh first. It repeats Trunk's wasm-bindgen and wasm-opt steps by hand on the cargo output
# (same tools from Trunk's cache, same flags as index.html) to show what each step saves; the numbers
# of dist/ itself are what Trunk produced. Writes nothing outside target/sizes/.
set -euo pipefail
cd "$(dirname "$0")/.."
name=kai-firefox-spike-sidebar
bindgen_ver=$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[^0-9.]/,"",$0); print; exit}' Cargo.lock)
bindgen="$HOME/.cache/trunk/wasm-bindgen-$bindgen_ver/wasm-bindgen"
wasm_opt=$(ls "$HOME"/.cache/trunk/wasm-opt-version_*/bin/wasm-opt | tail -1)
out=target/sizes
rm -rf "$out" && mkdir -p "$out"
sz() { stat -c %s "$1"; }
kb() { awk -v b="$1" 'BEGIN{printf "%.1f KiB", b/1024}'; }

cargo_wasm=target/wasm32-unknown-unknown/release/$name.wasm
"$bindgen" --target web --no-typescript --out-dir "$out" --out-name raw "$cargo_wasm"
"$wasm_opt" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int -o "$out/opt_bg.wasm" "$out/raw_bg.wasm"
dist_wasm=$(ls dist/*_bg.wasm)
dist_js=$(ls dist/$name-*.js)

echo "release wasm, stage by stage:"
printf '  %-44s %s\n' "cargo output (lto, opt-level s, strip)" "$(kb "$(sz "$cargo_wasm")")"
printf '  %-44s %s\n' "after wasm-bindgen (no wasm-opt)" "$(kb "$(sz "$out/raw_bg.wasm")")"
printf '  %-44s %s\n' "after wasm-opt -Oz (by hand)" "$(kb "$(sz "$out/opt_bg.wasm")")"
printf '  %-44s %s\n' "dist/ as Trunk wrote it (data-wasm-opt=z)" "$(kb "$(sz "$dist_wasm")")"
printf '  %-44s %s\n' "dist/ wasm, gzip -9" "$(kb "$(gzip -9 -c "$dist_wasm" | wc -c)")"
printf '  %-44s %s\n' "dist/ wasm, brotli -q 11" "$(kb "$(brotli -q 11 -c "$dist_wasm" | wc -c)")"
printf '  %-44s %s\n' "wasm-bindgen JS glue" "$(kb "$(sz "$dist_js")")"
if [[ -d dist-debug ]]; then
  printf '  %-44s %s\n' "debug build wasm (dist-debug/, no wasm-opt)" "$(kb "$(sz "$(ls dist-debug/*_bg.wasm)")")"
fi
echo
echo "dist/ files:"
(cd dist && ls -l | awk 'NR>1{printf "  %-52s %8d\n", $9, $5}')
total=$(find dist -type f -printf '%s\n' | awk '{s+=$1} END{print s}')
printf '  %-52s %8d  (%s)\n' "total" "$total" "$(kb "$total")"
rm -f "$out/ext.xpi"
(cd dist && zip -q -9 -X -r "../$out/ext.xpi" .)
printf '  %-52s %8d  (%s)\n' "zipped as an .xpi (zip -9)" "$(sz "$out/ext.xpi")" "$(kb "$(sz "$out/ext.xpi")")"

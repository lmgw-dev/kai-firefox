// The page's loader, as a file: Trunk writes an inline module script by default, which an
// extension page refuses. Trunk.toml's `pattern_script` leaves this build's file names on
// <meta name="lmgw-wasm"> instead (lmgw's crates/lmgw-ui/assets/start.js does the same), and this
// loads the wasm-bindgen glue and runs the page.
//
// It also marks the load for the measurements (design §8.4, tests/sidebar-shots.mjs):
// `kai-wasm-started` when the page is mounted, `kai-first-frame` two animation frames later, and
// `kai-thread-drawn` when the Chat first shows a message (its requests went through Kai).
const meta = document.querySelector('meta[name="lmgw-wasm"]');
const seen = new MutationObserver(() => {
  if (document.querySelector(".msg-item")) {
    performance.mark("kai-thread-drawn");
    seen.disconnect();
  }
});
seen.observe(document.body, { childList: true, subtree: true });
const bindings = await import(meta.dataset.js);
await bindings.default({ module_or_path: meta.dataset.wasm });
performance.mark("kai-wasm-started");
requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("kai-first-frame")));

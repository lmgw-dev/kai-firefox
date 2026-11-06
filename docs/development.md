# Working on Kai for Firefox

How the repository is laid out, how to build the sidebar page and what the tests need. Releases
and signing are in [releasing.md](releasing.md); the design record is
[design/2026-11-03-kai-firefox-design.md](design/2026-11-03-kai-firefox-design.md), and the
operations Kai calls are in [protocol/operations.md](protocol/operations.md).

## Layout

- `extension/`: the WebExtension (MV3, Firefox 154 or newer), plain ES modules without a build
  step: `background/` (the native port to Kai, refs, the operations, the events), `content/` (the
  scripts of every frame: `kai.js` first, then `walk.js`, `read.js`, `overlay.js`, `act.js`,
  `page.js`, `listen.js`, `aloud.js`), `options/`, `vendor/` (bundles made by `npm run vendor`,
  committed; `readability.js` runs only when `page.text` asks).
- `sidebar/`: the sidebar page, a Leptos (Rust, wasm) crate on lmgw's `lmgw-chat-ui`, built by Trunk
  into `extension/sidebar/` (gitignored: made at package time, never committed). `src/transport.rs`
  is the kit's transport over the background's `kai-sidebar` port (the frames in `src/wire.rs`),
  `src/page.rs` the Chat's host, `src/strip.rs` the site strip; `assets/preview.html` is the HTML
  preview's sandboxed page.
- `LMGW_PIN`: the lmgw source the sidebar is built against (`scripts/lmgw-pin.sh`).
- `tests/`: `npm test`, with the fixture site in `tests/site/`, the sidebar page's tests
  (`tests/e2e/chat.test.mjs`, the fake Kai answering from a scripted lmgw in
  `tests/lib/fake-lmgw.mjs`) and the sidebar relay's test page in `tests/sidebar-relay/` (tests only:
  its tests install a copy of the extension under `target/ext-sidebar/` with that page as its
  sidebar, in an environment of their own). `tests/accept/` holds the acceptance runs that Kai's
  `just browser-accept` drives.
- `spikes/`: the early measurements the design rests on, each with its `RESULTS.md`.

## Commands

```sh
npm ci
npm run lint      # web-ext lint
npm run test:unit # the unit tests only: no Firefox, no Kai host (what CI runs)
npm test          # unit tests, then headless Firefox with the real kai-browser-host and a fake Kai
npm run vendor    # rebuild the bundles the extension loads (extension/vendor/) after a library update
npm run vendor -- @mozilla/readability   # rebuild one of them
```

## The sidebar page

```sh
scripts/sidebar.sh          # release build into extension/sidebar/ (what the XPI carries)
scripts/sidebar.sh debug    # quicker, no wasm-opt (the dev loop)
scripts/sidebar.sh test     # the wire's unit tests, natively
scripts/sidebar.sh clippy   # clippy for wasm32 and natively, warnings as errors
node tests/sidebar-shots.mjs  # screenshots at 338 and 280 px, light and dark, at 1.25, and load times
```

Each first stages lmgw's crates at the pinned tree (`scripts/lmgw-pin.sh stage`): a `git archive` out
of lmgw's checkout next to this repository (or `LMGW_DIR`) into `target/lmgw-pin/`, whatever that
checkout has out, so the build is always the pinned source. To raise the pin, set `LMGW_PIN`'s three
lines to the new lmgw commit, its tree and its release tag (or `unpublished`); the next build stages
it. The build needs trunk 0.21.14 and the `wasm32-unknown-unknown` target; trunk fetches
wasm-bindgen and wasm-opt once into its cache. With the page built, `extension/` is the whole
extension: `npx web-ext run --source-dir extension` loads it in a Firefox of its own. The sidebar
opens with the toolbar button or `Ctrl+Alt+K`.

Against a real lmgw: Kai's `just live-check-sidebar ../kai-firefox ../lmgw <headless lmgw binary>`
serves Kai's real browser server and sidebar relay, pairs with a dev lmgw (an echoing mock as its
chat model) and runs this repository's `tests/real-run.mjs`, which drives the page in headless
Firefox: the thread listed, a reply streamed, the strip's rule from Kai, Attach this page.

## What the tests need

`npm test` needs Firefox (`FIREFOX` overrides `/usr/lib64/firefox/firefox`) and Kai's
`kai-browser-host` binary: `KAI_BROWSER_HOST`, else `../kai/target/debug/kai-browser-host`
beside this checkout. Its profile, `HOME` and XDG folders live under `target/t/` and are removed
after the run; `node tests/run.mjs --only <part of a test name> [--keep]` runs some tests and
keeps the folder. Each test has 90 s (`--test-ms <ms>`); one that takes longer fails and is
stopped, and the next test gets a new Firefox. The sidebar page's tests need the page built
(`scripts/sidebar.sh`) and say so when it is not.

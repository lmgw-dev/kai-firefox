# WP0 (c): a minimal Leptos sidebar with lmgw's UI kit

Run 2026-11-03, Firefox 159.0 (build 20261027085239), headless, on Fedora without a GPU (one
profile per run under `target/`). Design: `docs/design/2026-11-03-kai-firefox-design.md` §8, WP0 row in §12.

## Verdict

**(c) holds: a Leptos sidebar on `lmgw-ui-kit` runs in a Firefox MV3 sidebar panel under
`script-src 'self' 'wasm-unsafe-eval'` with no violation, and it is small and quick.** One part of the
design is wrong as written: the HTML preview cannot be a `srcdoc` frame in the sidebar page. A sandbox
page has to host it (see "What changes in the design", 1). Everything else below confirms the design or
adds build and test details.

What was built (`spikes/sidebar/`): a Leptos CSR app (Trunk) with a site strip, a thread list in the
kit's `Section`, four messages rendered from markdown with `pulldown-cmark` (the Chat's crate and
features, raw HTML kept as text), a composer, and the kit's `Modal` holding the preview frames. It
depends on `lmgw-ui-kit` by path and links `kit.css`, as Kai's `ui/` does. `shot.png` (320 px),
`shot-280.png` and `shot-preview.png` show it, taken from the real sidebar panel at 2x.

All 50 harness checks pass: 4 on the install, then 23 each in the real sidebar panel and in the same page in a tab
(`run-results.json` has the load numbers and every check's evidence; `run-results-debug.json` is the debug build).

## Numbers

### Sizes (release, `./build.sh`; `scripts/sizes.sh` prints them)

| | size |
|---|---|
| cargo output (`lto`, `opt-level = "s"`, `strip`) | 1561.7 KiB |
| after wasm-bindgen | 467.7 KiB |
| after wasm-opt (`data-wasm-opt="z"`, in `dist/`) | **434.8 KiB** (445,241 B); 432.8 KiB by hand |
| the same wasm, gzip -9 / brotli -q 11 | 170.0 KiB / 136.2 KiB |
| JS glue (wasm-bindgen) | 33.8 KiB |
| `kit.css` + `sidebar.css` | 23.1 KiB + 6.6 KiB |
| whole `dist/` (the extension, with the spike's probe and preview pages) | 506.4 KiB |
| as an `.xpi` (`zip -9`) | **191.3 KiB** |
| **debug build** wasm (`./build.sh debug`, no wasm-opt) | **4525 KiB** (4.4 MiB), glue 36.5 KiB |

wasm-opt takes about 7 % off what wasm-bindgen leaves (468 to 433 KiB). The kit's unused widgets are
gone (LTO): this app uses `Section` and `Modal` only. The spike is the floor (framework, kit core,
markdown); the Chat's own bundle is WP8's measurement. As a rough extrapolation only: the debug/release
ratio here is 10.4x, and §8.4 gives the dashboard's debug wasm as 63 MB.

### Load time (ms since navigation start; `window.__probe`, `performance` marks)

`wasm started` is when `init()` has compiled and instantiated the module and Leptos has mounted (it
mounts inside the start function, so first DOM is the same instant). `first frame` is two animation
frames after the first thread row is in the DOM. FCP is Firefox's own paint timing.

| | cold (first load in the profile) | reload, median (range over 5 to 9) |
|---|---|---|
| release, sidebar panel: wasm started | 41 to 65 | 14 to 17 |
| release, sidebar panel: **first frame** | **63 to 100** (4 runs) | **36 to 44** (34 to 54) |
| release, sidebar panel: FCP | 48 to 100 | 20 to 30 |
| debug (4.4 MiB), sidebar panel: wasm started / first frame | 55 to 78 / 79 to 113 | 27 to 37 / 42 to 64 |

The same page in a tab is 5 to 15 ms slower on reloads. Instantiation of 0.43 MiB takes about 15 ms
and 4.4 MiB about 30 ms, so at these sizes the wasm is not what makes the sidebar slow to appear. The
numbers are headless and have run-to-run noise of about 30 %; they say "tens of milliseconds, not
seconds", not more.

### CSP

- Manifest: `content_security_policy.extension_pages = "script-src 'self' 'wasm-unsafe-eval'"`, MV3,
  gecko id `kai-firefox-spike-sidebar@rootshell.dev`, `strict_min_version 154.0`: accepted, no manifest
  warnings, `sidebar_action.default_panel = index.html` loads in the sidebar.
- Normal load: **0 violations** (page `securitypolicyviolation` events), 0 script errors, no CSP line in
  Firefox's console (`log.entryAdded`), in the sidebar and in the tab. WebAssembly compiles and runs.
- Negative control (run from a page timer, so it is the page's own code): an injected inline `<script>`
  does not run, `eval()` throws `EvalError: call to eval() blocked by CSP`, `new Function()` likewise.
  So the policy is enforced and the zero above means something. (Calling `eval` from inside a WebDriver
  evaluate frame is not refused in Firefox 159; a first run of the harness took that for a CSP hole.)
- Raw HTML in a message (`<script>alert(1)</script>`) is text; no script element reaches the DOM.
- Trunk 0.21.14 writes its loader as an **inline** `<script type="module">` and has no option for it
  (`trunk build --help`; the 0.22.0 and 0.22.1 release notes mention none, not tried). `Trunk.toml` has a
  `post_build` hook, `scripts/externalize-inline.mjs`, that moves it to `init.js` and fails the build if
  any inline script is left. The harness also checks the packaged pages for inline scripts, handler
  attributes and `javascript:` URLs.

### The preview frames (the Chat's HTML preview: a `srcdoc` frame)

The model's HTML has an inline `<style>` and an inline `<script>` that reports back. Five frames in the
kit `Modal` (mounted only while it is open, as the Chat does):

| frame | what it is | HTML and `<style>` | inline `<script>` of the HTML | page's origin and rights |
|---|---|---|---|---|
| V1 | `srcdoc` (+ `sandbox="allow-scripts"`) directly in the sidebar page | renders | **refused** (inherits the sidebar's CSP) | opaque |
| V2 | `src=preview.html`, listed in manifest `sandbox.pages`; it posts the HTML in a nested `srcdoc` frame | renders | **runs** | opaque (`window.origin` "null"), no `browser` API, no access to the sidebar; CSP = the manifest's `sandbox` policy (inline yes, eval no) |
| V2b | as V2, iframe also has the Chat's `sandbox` attribute | renders | runs | opaque, no API, **no CSP** (eval runs although the policy refuses it) |
| V3 | `src=plain.html`, an ordinary extension page (control) | renders | refused | extension origin, `browser` API, sidebar reachable |
| V3b | as V3 plus the `sandbox` attribute | renders | runs | opaque, no API, **no CSP** |

`content_security_policy.sandbox` (`sandbox allow-scripts allow-forms allow-popups allow-modals
allow-pointer-lock; script-src 'self' 'unsafe-inline'`) and `sandbox.pages` are honoured in 159. The
`<dialog>` (`showModal`) of the kit's `Modal` works in the 320 px panel. `shot-preview.png` shows the
five frames (the text in each says what ran).

## What changes in the design

1. **§8.2 item 5:** "The HTML preview's `srcdoc` frame needs the extension's
   `content_security_policy.sandbox` (Firefox 154, D1)." (D1 says the same.) A `srcdoc` frame in the
   sidebar page stays under the sidebar's own CSP whatever its `sandbox` attribute says, so scripts in
   the previewed HTML are refused (V1; HTML and CSS render). What works is V2: a page listed in
   `sandbox.pages` as the frame's `src`, no `sandbox` attribute on that outer frame, the HTML sent in by
   `postMessage`, rendered there in a nested `srcdoc` frame that carries the Chat's `sandbox`
   attribute. For `lmgw-chat-ui` this is one more seam next to §8.2 item 1's list of places that bypass
   the kit: the preview component takes its frame from the host (the dashboard sets `srcdoc`, the
   sidebar points at the sandbox page and posts). Do not lean on V2b/V3b (the `sandbox` attribute on an
   extension page dropping its CSP is observed behaviour, not a documented rule).
   - The sandbox policy is what the preview may do. With `script-src 'self' 'unsafe-inline'`, inline
     scripts run and **remote scripts (a CDN) would not**; the dashboard's preview has no such limit.
     Adding `https:` is a decision for the owner, not tested here.
   - `'unsafe-inline'` makes `web-ext lint` (AMO's validator) warn `MANIFEST_CSP`: "allows remote code
     execution" (a warning, 0 errors; with `script-src 'self'` alone it goes away). WP0 (g), the unlisted
     signing, should be tried with this manifest.
   - Only 159 was tested. Where in 154 to 158 `content_security_policy.sandbox` and `sandbox.pages`
     start to work is unverified.
2. **§8.2 item 5, "Scripts as files":** besides `codeblocks.js` and the dashboard's inline script, Trunk's
   own loader is inline and needs the `post_build` hook above (node at build time, which `web-ext`
   already needs). An external module script and an external classic script both load fine from the
   extension origin.
3. **§10 (repository layout):** `sidebar/` (Leptos, Trunk) and `extension/` are separate there. The
   spike's `dist/` is the extension root (Trunk copies `manifest.json`, `preview.html` and the rest in
   with `copy-file`) and uses `public_url = "./"`. All URLs in it are relative, so the same build should
   work from a `sidebar/` subfolder with `manifest.json` pointing at `sidebar/index.html` (not tried). Cargo takes a path
   dependency below the workspace root for a workspace member; the spike links the lmgw checkout as the
   gitignored symlink `.lmgw` (made by `build.sh`, so one committed path works from a worktree and the
   main checkout) and lists it in `[workspace] exclude`.
4. **§11 (testing, "lifted from an earlier harness"):** in Firefox 159 the `--remote-allow-system-access` flag alone is not
   enough for chrome-scope BiDi; the environment variable `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` is.
   `browsingContext.setViewport` is refused for a `moz-extension:` tab ("privileged scope"; the harness
   sizes the tab's `<browser>` from chrome instead), `reload{ignoreCache}` is not supported yet, and
   BiDi cannot see the real sidebar panel at all (it is a `<browser>` inside `webext-panels.xhtml`).
   `harness/run.mjs` reaches it from chrome scope: `SidebarController.show("<id with _ for . and @>-sidebar-action")`
   and a frame-script bridge for evaluating in the page. Screenshots come from
   `windowGlobal.drawSnapshot`. A sidebar e2e in WP8 can reuse this.
5. **§8.5 (look):** Firefox 159's default sidebar is 338 css px wide, and the layout has no horizontal
   overflow at 320 and 280 px. Firefox's default scrollbars are 12 px wide, 4 % of 320 px; the kit styles
   scrollbars only with `::-webkit-scrollbar` under `html.tauri`, so the sidebar needs the standard
   `scrollbar-width` and `scrollbar-color` rules (in `assets/sidebar.css`). The kit's tokens and
   widgets needed no change; the base rules (`body`, `.btn`, `.input`, message and `.md` styles) live in
   the dashboard's `app.css`, not in `kit.css`, and have to move into `lmgw-chat-ui` (§8.2 item 3).
   The spike is always dark: the kit picks light or dark from `[data-theme]` on `<html>`, not from
   `prefers-color-scheme`, so §8.5's "light and dark from `prefers-color-scheme`" needs a small external
   script (or CSS) in the sidebar that sets the attribute; not built here.
6. **§8.4 (size):** the numbers above. The risk in §8.4 is the Chat's code, not the framework.
7. **§10 (signing):** the Leptos glue sets `innerHTML` (`inner_html`, here for rendered markdown), so
   `web-ext lint` gives `UNSAFE_VAR_ASSIGNMENT` on every build of the sidebar. A warning, but a reviewer
   will see it; the source upload and `build-for-amo` in §10 are how to answer it. The other lint
   warnings (`DANGEROUS_EVAL`) come from the spike's own probe and preview scripts.
   `browser_specific_settings.gecko.data_collection_permissions` is missing from older-style manifests and
   Firefox will require it; the spike sets `{"required": ["none"]}`, the real value is for Kai's data
   flow to decide.

## Rebuild and rerun

Needs `trunk` 0.21, the `wasm32-unknown-unknown` target, node 22+, Firefox at `/usr/bin/firefox`
(`FIREFOX=` overrides), and an lmgw checkout beside this repository (`LMGW_DIR=` if it is elsewhere).
One cargo build at a time, `CARGO_BUILD_JOBS` defaulting to 8 (set by the script).

```sh
spikes/sidebar/build.sh               # release into dist/; `build.sh debug` into dist-debug/
node spikes/sidebar/harness/run.mjs   # installs dist/, runs both targets; exit 0 = every check passes
```

Options: `--dist dist-debug --no-shots --out FILE --runs N`. Sizes: `spikes/sidebar/scripts/sizes.sh`.
Lint (not scripted, it needs `web-ext`): `web-ext lint --source-dir spikes/sidebar/dist`.
The harness keeps its profile, `HOME` and `TMPDIR` in `target/ff/` and removes them on exit; it unsets
`DISPLAY` and `WAYLAND_DISPLAY` so no window can open.

## Not measured

- Firefox 154 to 158; a signed, permanently installed build (a temporary add-on gets Firefox's base
  policy, whose console message lists `http://localhost:*`, on top of the manifest's).
- Windowed Firefox with a GPU; timings are headless.
- The real Chat components, the HTTP transport seam, voice, media, `highlight.js`, KaTeX, Mermaid.
- Remote scripts and `connect-src` behaviour of the preview under the sandbox policy.

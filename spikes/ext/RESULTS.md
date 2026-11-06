# WP0 spike, extension points (a), (b), (d), (e), (f), (g)

2026-11-03, Firefox 159.0 (the binary `/usr/lib64/firefox/firefox`, headless,
WebDriver BiDi), Node 22.23.1, Python 3.14.8, `dom-accessibility-api` 0.7.1, esbuild 0.28.2. Every
Firefox ran with its profile, `HOME` and `XDG_*` under `target/ext-spike/` (deleted after each run).
Source references are to Firefox 159's `omni.ja`.

## Verdicts

| Point | Verdict | Numbers |
|---|---|---|
| (a) MV3 background + native port | **Holds.** A port the background opened keeps the event page running; Firefox ends the host on every lifecycle event as the design says. Two changes needed (frames toward Kai, host exit), see below. | Idle timeout lowered to 2000 ms: with the port, running for 5 min and for 40 min, one host, one background instance, with pings every 30 s and with a silent host; without the port, suspended at 2.29 s. Host: stdin EOF 3 to 150 ms after the event, SIGTERM at +3.0 s, SIGKILL at +6.0 s; a new host 52 to 136 ms after enable, reload, update. |
| (b) `userScripts.execute`, both worlds | **Works.** Values, promises and per-frame exceptions come back; MAIN sees page globals, USER_SCRIPT does not. A BiDi click grants the permission. | 1 to 5 ms per call; a 2 MiB string result 48 ms. |
| (e) native manifest lookup | **Only `$HOME/.mozilla/native-messaging-hosts/`** (plus `/usr/lib64/mozilla/native-messaging-hosts/`), whatever exists in XDG. §11's XDG assumption is wrong for manifests. | 7 layouts, table below. |
| (f) naming cost | **Cheap for the view, ~0.3 s for a whole 5 600-control page.** Names right for 12 of 14 labelling kinds, shadow roots (closed too) included; `placeholder` is missing; `::before` needs an option. Frames addressable per `frameId`, cross-origin too. | All 5 642 controls in 4 frames: 258 to 423 ms wall (325 to 539 with the `::before` option; a cold first call up to 860 ms); in view (126): 32 to 58 ms. |
| (d) AT-SPI | **Works with `IsEnabled` on before Firefox starts; no pref needed.** A run on a windowed Plasma session (2026-11-03, Firefox 159.0): with `accessibility.force_disabled = 1` Firefox is not on the bus; by default and with `-1` it is, at once, and exposes the page (14 nodes) and its own UI (131 nodes: 4 tool bars, tabs, menus, buttons). `doAction` gives trusted, user-activated clicks that opened a tab and a popup, and the tab-modal alert is in the tree with its text and OK button. The file picker was **not observed**. The cost of accessibility was not measurable on this page. | Memory use did not change measurably between the variants; the tree walk 0.03 s for 145 nodes. |
| (d2) DocURL and frames | **Holds for pages, frames at any depth and origin, and `about:` pages; empty for `data:` and `blob:`.** On a headless Firefox on the private bus: `GetAttributeValue("DocURL")` equals the document's own address for every http(s) frame (same-origin, same-site, cross-site, sandboxed, nested, navigated), `about:blank`, `about:srcdoc`, `about:robots`, `file:` and `view-source:`; a refused connection shows the address that was refused; every frame document is in the top document's subtree. `data:` and `blob:` documents answer the empty string, with no `DocURL` among their attributes. | 21 documents in 322 nodes; the DocURL of a navigated frame changed together with its content (old document, no document 11 to 31 ms, new document), eight runs; see (d2). |
| (g) unlisted signing | **Works.** `npm run sign` (WP11a) signed 0.1.0.47 with its source archive; AMO signed it unreviewed. A human source review was not observed. | 2 min 19 s from start to signed file: upload and validation 16.3 s, signature 2 min 2 s, download 0.3 s. |

## (a) MV3 background and native port

`node run-a.mjs keepalive`, `pageport`, `sizes`, `lifecycle --mode stubborn|eof-exit`. The background
state is read from the parent process (`WebExtensionPolicy...extension.backgroundState`), which does not
touch the extension.

**Keepalive** (`extensions.background.idle.timeout` = 2000 ms):

| Run | Background | Host |
|---|---|---|
| port opened by the background, host pings every 30 s, 5 min | `running` from 0.28 s to the end, one instance (9 pongs from it, lag ≤ 1.6 ms) | one process, no EOF |
| port opened by the background, host silent, 5 min | `running` to the end | one process, no EOF |
| no port (control) | `stopped` at 2.29 s, `runtime.onSuspend` at 2.27 s | none |
| no port in the background; an extension page (the sidebar's stand-in) holds a native port and a `runtime.connect` port to the background, 60 s | `stopped` at 2.24 s; the page's runtime port was disconnected at 2.03 s (`error` null) | the page's port keeps its host |

Source agrees: `terminateBackground` resets the idle timer while `backgroundContext.hasActiveNativeAppPorts`,
and `trackNativeAppPort` counts only ports of the background context (`ExtensionParent.sys.mjs`).

**Lifecycle**, ms after the action (two runs each, same to ±10 ms). "stubborn" ignores EOF and SIGTERM;
"eof-exit" exits on stdin EOF, as `kai-browser-host` should:

| Action | stubborn: EOF / SIGTERM / PID gone | eof-exit: EOF / gone | Next host starts |
|---|---|---|---|
| disable (AddonManager) | 14 / 3014 / 6024 (SIGKILL) | 14 / 21 | enable: +52 to 72 |
| `runtime.reload()` | 62 / 3062 / 6071 | 62 / 71 | +117 to 136 |
| install 0.2.0 over 0.1.0 | 4 / 3005 / 6014 | 5 / 6 | +59 to 73, its hello says 0.2.0 |
| uninstall | 3 / 3003 / 6013 | 3 / 4 | none |
| quit (`eAttemptQuit`) | 147 / 3147 / 6151 | 144 / 151 | Firefox exits after **6.25 s** (stubborn) vs **0.42 to 0.53 s** |

The add-on was temporary (BiDi `webExtension.install`); "over" is a temporary reinstall, not an AMO update.

**Longer run** (`keepalive --minutes 40`): both runs `running` for the whole 40 min, one host each, no
EOF; the ping run's 80 pings got 80 pongs from one background instance (lag ≤ 5 ms); the control was
`stopped` at 2.15 s. A first 60 min attempt ended after 16 min 38 s when both Firefox instances' BiDi
sockets closed at the same moment, under unrelated concurrent load;
that harness did not record why, no OOM kill was logged, and the 40 min rerun passed that mark.

**Message sizes:**
- Host → extension: 1 048 575 and 1 048 576 bytes arrive (11 to 19 ms). 1 048 577 bytes: the **port**
  closes, `port.error.message` = "Native application tried to send a message of 1048577 bytes, which
  exceeds the limit of 1048576 bytes." Then stdin close, SIGTERM +3 s, SIGKILL +6 s. The limit is the pref
  `webextensions.native-messaging.max-input-message-bytes` (default 1 MiB).
- Extension → host, one message (`run-a.mjs sizes`): 1 MiB 64 ms, 5 MiB 168 ms, 20 MiB 1.6 to 1.8 s,
  50 MiB **11.0 s**, 100 MiB **41.8 s**: quadratic. Firefox's subprocess worker copies the unwritten rest
  after every partial pipe write (`subprocess_unix.worker.js`: `writes[0].buffer = buffer.slice(written)`).
  The same 50 MiB as 1 MiB messages: 212 ms; as 256 KiB messages: 169 ms. With the host enlarging its
  pipes to 1 MiB (`F_SETPIPE_SZ`): 50 MiB in one message 1.12 s, in 1 MiB messages 133 ms.

## (b) `userScripts.execute` and `scripting.executeScript`

`node run-b.mjs` (test page `page/b.html` defines `pageGlobal = 42`).

**Granting `userScripts`** (optional-only):

| Attempt | Result |
|---|---|
| A: `permissions.request` evaluated in an extension page | "permissions.request may only be called from a user input handler" |
| B: BiDi `input.performActions` click on the options page's button | the click is `isTrusted`, `navigator.userActivation.isActive` true; Firefox shows the doorhanger "… requests additional settings" (Allow); accepted from chrome scope (`mainAction.callback`) → `true` |
| C: the same click with `extensions.webextOptionalPermissionPrompts = false` | granted at once, no prompt (6 to 21 ms); without a click still refused |
| D: chrome scope `ExtensionPermissions.add(id, {permissions: ["userScripts"]})` | granted, no page involved |

`browser.userScripts` appears in already open extension pages right after the grant (no reload).

**Results** (both worlds alike unless noted): the last expression's value (`1 + 1` → 2,
`let x = 5; x * 2` → 10), a returned promise's value (awaited), plain objects. Exceptions come back per frame
in `InjectionResult.error` as the thrown value (`Error` with `message`, or a plain string), including
`SyntaxError`. Top-level `return` is a `SyntaxError`: the code is a script, not a function body. A result
that is not structured-clonable (a DOM node, a function) **rejects the whole call**: "Script '<anonymous
code>' result is non-structured-clonable data". `typeof pageGlobal`: `undefined` in USER_SCRIPT, `number` in
MAIN; a global written in MAIN is visible to the page, one written in USER_SCRIPT is not.
`scripting.executeScript({world: "MAIN", func, args})`: page globals visible, args passed, promises
awaited, throws in `error`, the same non-clonable rejection.

On a page with `script-src 'self'`, the injected code runs in both worlds, but `eval` and `new Function`
inside it fail with `EvalError: call to eval() blocked by CSP`, in USER_SCRIPT too and also after
`userScripts.configureWorld({csp: "… 'unsafe-eval'"})`.

A `setTimeout(…, 200)` in a background tab took about 1 s (timer throttling of non-active tabs).

## (e) Native manifest lookup

`node run-e.mjs`. `HOME` and `XDG_CONFIG_HOME` point at temp folders; the host logs `argv[1]`, the
manifest path Firefox used. `Services.dirsvc.get("XREUserNativeManifests")` was `$HOME/.mozilla` in
every case.

| Layout before start | Manifest used | Firefox's own folder (created) |
|---|---|---|
| manifest in `$HOME/.mozilla/native-messaging-hosts` | that one | `$XDG_CONFIG_HOME/mozilla/firefox/` |
| manifest in `$XDG_CONFIG_HOME/mozilla/native-messaging-hosts`, no `~/.mozilla` | **none**: "No such native application dev.rootshell.kai_spike" | `$XDG_CONFIG_HOME/mozilla/firefox/` |
| XDG manifest, empty `~/.mozilla` | none | `$XDG_CONFIG_HOME/mozilla/firefox/` |
| XDG manifest, `~/.mozilla/firefox/` exists | none | `~/.mozilla/firefox/` |
| manifests in both | the `$HOME/.mozilla` one | `$XDG_CONFIG_HOME/mozilla/firefox/` |
| `XDG_CONFIG_HOME` unset, manifest in `$HOME/.config/mozilla/…` | none | `$HOME/.config/mozilla/firefox/` |
| no manifest | none, the same error | `$XDG_CONFIG_HOME/mozilla/firefox/` |

The rule: per-user native manifests come only from `$HOME/.mozilla/native-messaging-hosts/`; the XDG
switch concerns Firefox's own folder only and follows `~/.mozilla/firefox/`, not `~/.mozilla`. So
creating `~/.mozilla/native-messaging-hosts/` does not move anyone's profiles. The extension sees the
same error for a missing manifest as for any other refusal. (Fedora's `/usr/bin/firefox` wrapper picks
its langpack folder by `~/.mozilla` alone and may `mkdir` there; the harness starts the binary directly.)

## (f) Element naming cost

`npm run build && node run-f.mjs --repeat 5`. Page (`page/gen-page.mjs`): 5 012 controls of 14 labelling
kinds, every 10th group in an open and every 10th + 5 in a closed declarative shadow root (72 roots), two
same-origin frames and one cross-origin frame (`localhost` vs `127.0.0.1`), 210 controls each; 1280 × 900
viewport. Content script: `src/naming.js` bundled with `dom-accessibility-api` into one 15.9 KB IIFE
(`ext/naming.bundle.js`); refs in `Map<number, WeakRef>`.

| What | Time (warm median; range over 3 runs) |
|---|---|
| top document, all 5 012 controls | 234 ms (collect 17, name + role 216); 0.05 to 0.12 ms per control; first call 460 to 860 ms |
| top document, in view (84 of 5 012) | 24 ms (collect 14, rect filter ~6, name 4) |
| each 210-control frame, all / in view (14) | 10 to 12 ms / 1 to 2 ms |
| all four frames in parallel from an extension page (`getAllFrames` + `tabs.sendMessage` per `frameId`) | all 5 642: 258 ms (258 to 423); in view 126: 32 ms (32 to 58) |
| the same with `computedStyleSupportsPseudoElements: true` | all: 325 ms (325 to 539); in view: 32 ms (32 to 51) |
| memory, content process of the top document | RSS 162 → 217 MB, PSS 60 → 113 MB after 24 walks of the whole document (refs plus garbage, not separated); cross-origin frame's process 119 → 131 MB RSS |

**Names** checked against `data-expect` (the accname result): right for `aria-label`, `aria-labelledby`,
`<label for>`, wrapping labels, `alt`, `title`, `value` of submit, content of `role=button`, hidden
content skipped, including `aria-labelledby` and `<label for>` inside closed shadow roots. Wrong:
`placeholder` (empty name; HTML-AAM uses it as the last fallback): 358 of 5 012. `::before` content: wrong
with the library's default, right with `computedStyleSupportsPseudoElements: true` (the default is for
jsdom).

**Shadow roots and frames:**
- `element.openOrClosedShadowRoot` reaches all 36 closed roots from the content script.
- `body.getHTML()` and `getHTML({serializableShadowRoots: true})` serialise none of the declarative
  roots; `getHTML({shadowRoots: [...]})` with the 72 roots serialises all 36 open and 36 closed ones.
- `webNavigation.getAllFrames` lists all four frames with `documentId`; `tabs.sendMessage(tab, msg,
  {frameId})` reaches the cross-origin (separate process) frame's content script.
- In the parent, `browser.runtime.getFrameId(iframeElement)` returns the same `frameId` as
  `getAllFrames` for all three iframes, next to `getBoundingClientRect()`: the parent can report each
  frame's box by `frameId`. `frameId`s exceed 32 bits (17179869185 = 4 · 2³² + 1).

## (d) AT-SPI

### The run on a windowed Plasma session

`spikes/ext/atspi-check.sh`, variants `baseline,default,force`, on 2026-11-03, Firefox 159.0
(`Mozilla Firefox 159.0`). The session's accessibility bus had been rebound just before the run
(an earlier self-test had left a dead socket). Before the run
`org.a11y.Status` had `IsEnabled` false and `ScreenReaderEnabled` false. Report
`target/atspi-check-<time>.json`, log `target/run2.log` (not committed). One run per variant, each
with its own throwaway profile and `HOME`; the script looked at the bus 8 s after the start.

| Variant | Setup | On the bus | The page's document | Firefox's own UI |
|---|---|---|---|---|
| baseline | `IsEnabled` as it was (false), `accessibility.force_disabled = 1` | **no** (looked for 5 s) | – | – |
| default | `IsEnabled` switched on before Firefox starts, no pref | **yes**, found at the first look (8 s after the start) | found, 14 nodes | 131 nodes |
| force | `IsEnabled` on, `accessibility.force_disabled = -1` | **yes**, at the first look | found, 14 nodes | 131 nodes |

- **Nothing needed a pref.** With `IsEnabled` on before Firefox started, a windowed Firefox 159 joined
  the bus and exposed pages, its UI and the alert, with and without `force_disabled = -1`; default and
  force gave the same tree (145 nodes for the application, walked in 0.03 s). The 2026-10-09 finding
  was an application node alone; this run started Firefox with `IsEnabled` already on, and does not
  say what a Firefox that started before it does.
- **The page** (14 nodes): 6 paragraphs, 4 buttons, 2 links, 1 heading, 1 document web. All six test
  elements were found: the plain link (no action listed), the plain button (none listed either; its
  `doAction(0)` worked), the `target=_blank` link (`jump`), the `window.open` button, the file input (a
  button named "Upload file Browse… No file selected.") and the alert button (`press` each). Those two
  empty lists are first reads: (d2) shows a first `NActions` read of a link or button can be 0 and read 1
  about 100 ms later.
- **Firefox's own UI** (131 nodes outside the page): 4 tool bars, 1 page tab, 1 entry (the address bar),
  26 buttons; the most frequent roles were menu 35, section 31, button 26, link 5. A sample of the
  names: "Back", "Forward", "Reload", "Search with Google or enter address", "Open a new tab (Ctrl+T)",
  "Bookmark this page (Ctrl+D)", "List all tabs", "Close tab", "View site information", "Menu Bar",
  "Browser tabs", "Navigation", "Sidebars", "Extensions", "Customize", and the tab "Kai AT-SPI check". The
  sample also holds the New Tab page's tiles ("Open context menu for Wikipedia", "Open weather menu")
  although the only tab showed the test page: the tree holds documents the window does not show (the
  headless runs of (d2) show it with state flags).

**`doAction(0)`** on each element (all returned true; the script waited 1.5 to 3 s before looking):

| Element | What the page saw | What followed |
|---|---|---|
| the button | a `click` with `isTrusted` true and active user activation | – |
| the `target=_blank` link | trusted, user activation | the server saw the request for the new page; page tabs 1 → 2 |
| the `window.open` button | trusted, user activation; `window.open` returned a window; activation inactive right after it | the server saw the popup's request; page tabs 2 → 3 |
| the file input | a `click`, trusted, user activation | **no file chooser in Firefox's tree and the number of top-level windows stayed at 1 (looked 3 s after the click, `widget.use-xdg-desktop-portal.file-picker = 0`). The picker was not observed**; whether one opened where the tree does not show it is not known |
| the alert button | trusted, user activation | the tab-modal alert, below |

- **The tab-modal alert** was in the tree as a node of role `alert` (no name) with the text "Kai check
  alert" and an OK button; `doAction` on OK returned true and the page saw `alert-closed` (its script
  went on after `alert()`).
- **Memory.** Memory use did not change measurably between the variants.
  `libatk-bridge` was mapped in all three variants, baseline
  included. Accessibility off came out no lower than on, so the cost was not measurable on this small page
  with one run per variant (what a large page costs was not tried).
- **The run itself** exited 0; `org.a11y.Status IsEnabled` was restored to false (the log's last line);
  each Firefox ended on SIGTERM with nothing left over; a `ps` right after showed no Firefox of the check.

### What the check does

It starts its own Firefox per variant (throwaway profile and `HOME`/`XDG_*` under `target/ext-spike/`,
`--no-remote`, its own process group): `baseline` (`accessibility.force_disabled = 1`, `IsEnabled` as it
was), `default` (`IsEnabled` switched on before Firefox starts), `force` (`IsEnabled` on plus
`force_disabled = -1`), optionally `env`. It serves a page with a link, a button, a `target=_blank` link,
a `window.open` button, a file input and an `alert()` button, and reports per variant: on the bus or not,
the page in the tree, Firefox's UI in the tree (tool bars, tabs, the address bar, button names), each
element's actions, `doAction` on each (what the page saw: `isTrusted`, user activation; whether the
new tab and the popup opened, seen by the server; whether a GTK file chooser appeared in Firefox's tree,
`widget.use-xdg-desktop-portal.file-picker = 0`, then Cancel; whether the tab-modal alert is in the tree,
then OK), and RSS/PSS of Firefox's process tree with `libatk-bridge` mapped or not. `IsEnabled` is
restored on exit, Ctrl+C and errors (it is GSettings-backed: persistent). Report:
`target/atspi-check-<time>.json` plus the terminal.

### Before it: the headless self-test

Done before the windowed run: `--dry-run` (page served and fetched, profile written, `org.a11y.Status` read:
`IsEnabled` false, `ScreenReaderEnabled` false). `atspi-selftest.sh` runs the same code with a
**headless** Firefox on a private `dbus-daemon` session with its own AT-SPI bus (in-memory GSettings),
so the session's `IsEnabled` is never touched and no window opens. Its result:
- `force` (`force_disabled = -1`): Firefox on the bus at once; the page's document (14 nodes) and
  Firefox's UI (128 nodes: 4 tool bars, the tab, Back, Reload, "Search with Google or enter address", …)
  in the tree. `doAction` on the button, the `target=_blank` link and the `window.open` button: the page
  saw `isTrusted` true and user activation true; the new tab and the popup opened. The `alert()` showed
  as role `alert` with its text, and `doAction` on its OK closed it. The file picker was skipped
  (headless).
- `default` (`IsEnabled` on the private bus) and `env` (`GNOME_ACCESSIBILITY=1`): a headless Firefox
  did not join the bus within 15 s. This said nothing about a windowed Firefox; the windowed run above has one join with `IsEnabled` alone.
- On the session bus, the AT-SPI bus socket that `org.a11y.Bus` named did not exist while `IsEnabled`
  was false (`dbind-WARNING … No such file or directory`); the script reports "not on the bus" then.
- Leak fixed: D-Bus activated `xdg-desktop-portal-kde`, `ksecretd` (and the portals, `gvfsd`) on the private bus and they outlived the script, holding the caller's pipe; `atspi-selftest.sh` now starts the bus itself with all stdio on `/dev/null` and, on every exit path (trap), ends its children, every process of the user whose `/proc/<pid>/environ` carries that bus's exact address, then the bus; checked after normal end and after SIGTERM mid-run with services activated: nothing left, pipe released; `atspi-check.sh` starts no bus and `atspi_check.py` now also kills its Firefox's leftover tree by pid.
- The first `atspi-selftest.sh` ran the private AT-SPI launcher with the session's `XDG_RUNTIME_DIR` and `DISPLAY`, so it replaced the session's accessibility socket with a dead one (`systemctl --user restart at-spi-dbus-bus.service` rebinds it); the self-test now runs everything it starts with a private `XDG_RUNTIME_DIR` (`/tmp/kai-atspi-XXXXXX`, removed at exit), no display and no D-Bus activation, and the session's `at-spi/bus_0` had the same inode and mtime before and after full runs. `atspi-check.sh` (also `--dry-run`) refuses to start, exit 2 with nothing started or changed, when the session's accessibility bus refuses connections, because libatspi aborts the whole process then. A hard abort skipped every `finally`, so the check keeps a state file and the wrapper (no longer `exec`) runs `atspi_check.py --cleanup` after a signal or nonzero exit: `IsEnabled` restored, the recorded Firefox group ended (pid and start time checked), the profile removed; `atspi-selftest.sh --abort-test` checks this on the private bus.

## (d2) DocURL and frames on a private bus

Kai's desktop tools (Kai at `98f8891`, `src/desktop/fdo/atspi.rs`, `doc_url` and `documents_of`) judge each
Firefox page and frame by `GetAttributeValue("DocURL")` on the `org.a11y.atspi.Document` interface of every
element that has it: by descending from the window through VISIBLE elements (`read_window`, `ui_press`'s
find) or by following `Parent` up from a pressed element. An empty answer counts as a page without a host
and gets the strictest rule (`SiteRules::page_rule`). That was tested only against a fake bus.

`spikes/ext/atspi-selftest.sh --docurl` (code in `atspi_docurl.py`, run by `atspi_check.py --docurl`, which
refuses to run anywhere but under the self-test): a **headless** Firefox 159.0 with
`accessibility.force_disabled = -1` on the private bus (the same private runtime folder, display-less
environment and cleanup as every self-test mode; `stat` of the session's `at-spi/bus_0` identical before and
after). Two local servers on `127.0.0.1` (ports A and B) serve a top page with 12 iframes (13 frame
documents, since the nested one holds another): same-origin (`A`), same-site cross-origin
(`127.0.0.1:B`), cross-site (`localhost:A`), `sandbox="allow-scripts"` (opaque origin), nested two deep
(`A`, then `localhost:B`), `about:blank`, `data:`, `srcdoc`, a `blob:` URL the page makes, a refused
connection (`127.0.0.1:1`), one the top page navigates to `localhost:B` after 1.5 s, and one it navigates
when the probe says go. The top page itself calls `history.pushState`. The Firefox also opens
`about:robots`, `about:blank`, a `data:` page (Firefox's block on top-level `data:` navigations is lifted
for this one, since it refuses one on the command line; the frames are unaffected), a `file:` page,
`view-source:` and Reader view as tabs. The probe asks over raw D-Bus (python-dbus on the accessibility
bus; the destination, path, interface, method and argument of Kai's call; an error counted as the empty
string, as Kai's `unwrap_or_default`), and compares with `document.URL`, which each served page sends to
the server. Nine runs gave the same answers for every kind they had (the last five
with all 13 frames, the last with Reader view); the numbers below are from the last run.

**DocURL per document kind** (A, B: the servers' ports; the page's own `document.URL` in the last column):

| Document | `GetAttributeValue("DocURL")` | Against the page |
|---|---|---|
| top page, after `history.pushState` to `/top-pushed.html` | `http://127.0.0.1:A/top-pushed.html` | equal: follows the pushed address |
| same-origin frame | `http://127.0.0.1:A/frame.html?who=same` | equal |
| same-site cross-origin frame | `http://127.0.0.1:B/frame.html?who=sibling` | equal |
| cross-site frame (`localhost`) | `http://localhost:A/frame.html?who=crosssite` | equal |
| sandboxed frame (opaque origin) | `http://127.0.0.1:A/frame.html?who=sandboxed` | equal: the address, not an opaque one |
| nested frames, outer and inner | `http://127.0.0.1:A/nested.html`, `http://localhost:B/frame.html?who=nested-inner` | equal |
| frame the top page navigated | the new address (`http://localhost:B/…?who=moves-end`) | equal |
| `about:blank` frame | `about:blank` | – |
| `srcdoc` frame | `about:srcdoc` | – (nothing of the embedding page) |
| **`data:` frame** | **empty** | – |
| **`blob:` frame** (from `URL.createObjectURL`) | **empty** | – |
| refused connection, Firefox's error page | `http://127.0.0.1:1/refused`, the address that failed (not `about:neterror`); states `busy`, `stale` | – |
| tab: `about:robots` | `about:robots` | – |
| tab: `about:blank` | `about:blank` | – |
| the preloaded New Tab page | `about:newtab` | – |
| tab: `file:` page | `file:///…/file-page.html`, the full path | – |
| tab: `view-source:` | `view-source:http://127.0.0.1:A/top.html` | – |
| tab: Reader view | `about:reader?url=http%3A%2F%2F127.0.0.1%3AA%2Farticle.html` | – |
| tab: top-level `data:` (block lifted) | **empty** | – |
| the window itself (Firefox's chrome is a Document too) | `chrome://browser/content/browser.xhtml` | – |

**`GetAttributes()`** is a dictionary of exactly `MimeType` (`text/html`; `application/xhtml+xml` for
`about:robots` and the chrome window) and `DocURL`, the same address; for `data:` and `blob:` documents
there is no `DocURL` key at all, and `GetAttributeValue` returns the empty string without an error.
`GetLocale` gives the page's language (`en` for the served frames, `en-US` for Firefox's own pages, empty for
`file:`, `view-source:` and `about:blank` tabs).

**Frames are reachable.** All 13 frame documents (cross-site and nested ones too) lie in the top document's
subtree: walking only below the top document node finds the same 13, and each is under the same bus name as
the application (a cross-site frame does not have its own). Roles and parents:
- top page: `frame` (the window) > `panel` > `scroll pane` > `internal frame` > `document web`;
- frame: `… > document web` (the top) `> internal frame` `> document web`; a nested one adds one more
  `internal frame > document web`. The `internal frame` is named by the iframe's `title` attribute (empty
  without one); the document under it carries that name too for a same-site frame, while a cross-site
  frame's document carries its own `<title>`. Both are the page's words.
- Kai's descent through VISIBLE elements reaches every one of them, and Kai's `documents_of` from an
  element inside a frame returns the chain outermost first (the top page and the frame; three for the
  nested inner one), each right. An `about:blank` frame has no element inside, so there is nothing to press
  or read. All frame documents had `visible`; 12 of the 13 `showing` (the nested inner frame lay below its
  outer frame's 56 px, VISIBLE but not SHOWING).

**Timing.** A frame the page navigates to another origin showed, polled every 10 ms: the old document (old
address, old title, old text), then **no document below the iframe** for 11 to 31 ms, then the new document
with the new address, title and text together. Eight runs: the old document was gone 11 to 43 ms after the
navigation began, the new one there at 31 to 64 ms (the page's script ran 4 to 5 ms after the server saw the
request). No poll ever showed new content under the old address or the reverse. The top page's
`pushState` was in `DocURL` at the first look (2 s after it ran; not timed finer). The first look and a
second one after switching through every tab and back gave the same `DocURL` for every document; the top
document's accessible name was empty at the first look in all nine runs and its title later.

**Tabs.** All 21 documents (the seven tabs' pages, the 13 frames, the preloaded New Tab page) stay in the
tree whichever tab is selected: 20 or 21 carry `visible`, exactly one top-level document (with its frames
when it is the top page's) carries `showing`. The one document without `visible` was `about:robots`
while it sat in the background. `visible` therefore does not tell the page in front from a background
tab's, `showing` does (headless only).

**`NActions`** (what `ui_press` needs above 0): the first read of a link or button can be 0, and the same
read 100 ms later 1. The plain link read 0 the first time in six of six runs (1 at 100 ms in the four that
read it again); the plain button 0 in two of six; a button with an `onclick`, read after them, was 1 at once
in four of four. The windowed run listed no action for the plain link and the plain button, which fits.

**What Kai's WP7b check can rely on:**
- `DocURL` is non-empty and equal to the document's own address for pages, frames of any origin relation
  and depth, sandboxed frames, `about:blank`, `about:srcdoc`, `about:robots`, `about:newtab`, `file:` and
  `view-source:` documents, and it follows `pushState` and a frame's navigation (no poll saw content and
  address disagree).
- Every frame document is below the top document and below the window, by either route Kai takes, and
  `documents_of` lists the chain in the order Kai expects.
- An error page carries the address that failed; Reader view carries `about:reader?url=<the article's
  address, percent-encoded>`, and `view-source:` documents carry `view-source:<address>`, which are the
  forms Kai's `effective()` unwraps.

**What it cannot rely on:**
- **`data:` and `blob:` documents answer the empty string** (frame or top level), so "a non-empty
  `DocURL` for every frame document" is false. Kai's `page_rule("")` parses nothing and gives the
  strictest rule, so the failure is closed, as the design says; but Kai cannot tell such a page from a
  call that failed, and its `effective()`, which unwraps a `blob:` address to its origin's, never gets one
  from AT-SPI: a page's own `blob:` frame is refused like any hostless page while some site is `none`.
- `about:blank` and `about:srcdoc` say nothing of the page that embeds them (a `srcdoc` frame has its
  embedder's origin and content); Kai gives them the strictest rule too.
- `visible` includes background tabs' pages and the preloaded New Tab page, so a read or a press that
  descends through VISIBLE elements reaches those documents too, each judged by its own `DocURL` (that
  holds) but not "what the window shows". `showing` is the flag for the page in front.
- A document's accessible name is the page's own words and was empty at first look: it is no basis
  for a rule.

Not tested: a windowed Firefox (the windowed run of (d) tested no frames), `DocURL` while a page loads
(only the navigated frame), the PDF viewer, a private window, a `display:none` or
`visibility:hidden` frame, the cross-site frame's process (site isolation is Firefox's default; the split
was not checked), and Kai's own code against this Firefox (the probe makes Kai's calls itself).

## (g) Unlisted signing with a source upload

`npm run sign` (`scripts/sign.mjs`, WP11a, design §10) from `b82c256` on 2026-11-03, the log in
`target/sign/run-0.1.0.47.log` (not committed):

| Step | Result |
|---|---|
| version | 0.1.0.47 (the manifest's 0.1.0 plus the commit count), spliced into the staged copy; no `update_url` (`KAI_FIREFOX_UPDATE_URL` unset) |
| `web-ext lint --self-hosted` | 0 errors, 2 warnings (`UNSAFE_VAR_ASSIGNMENT`, `innerHTML` in the vendored Readability) |
| source archive | `source.zip`, 55 files including `BUILD-FOR-REVIEWERS.md`, 247 630 bytes, attached to the version |
| upload and validation | 16.3 s after the start (web-ext with `--approval-timeout=0`) |
| signature | 2 min 2 s later; AMO listed the version as unlisted with file status "unreviewed" until it was signed |
| download | 0.3 s; the XPI's sha256 printed |
| total | **2 min 19 s** |

Not observed: a human review of the source, and whether a reviewer's build (`npm ci && npm run
vendor`, as `BUILD-FOR-REVIEWERS.md` says) runs. The signed XPI has no update URL, so it is installed
by hand and Firefox does not update it; the update hosting and the builds channel's GitLab upload are
not built yet (design §10).

## Surprises that should change the design

1. **§4.1 "Frames toward Kai are not split."** One large message from the extension to the host costs
   quadratic time in Firefox (50 MiB: 11 s, 100 MiB: 42 s); the same bytes in 1 MiB messages take
   0.2 s. The extension should split toward Kai too, with the same `chunk` framing; the host can also
   set `F_SETPIPE_SZ` to 1 MiB (5 to 10× faster single messages, 1.6× on 1 MiB messages).
2. **§11 "Firefox 147 and newer use XDG folders when `~/.mozilla` is missing".** Not for native
   manifests: only `$HOME/.mozilla/native-messaging-hosts/`. §4.5's dev path is right; the test harness
   writes the manifest into the temporary `$HOME/.mozilla/native-messaging-hosts/`.
3. **§1 "ends it with the port (stdin closed; SIGTERM after 3 s; SIGKILL 3 s later)".** Confirmed, and:
   a host that does not exit on EOF holds Firefox's quit for 6 s (AsyncShutdown blocker; 6.25 s vs
   0.42 s). `kai-browser-host` must exit on stdin EOF and must never block its stdin reader behind a
   stdout write: in the over-limit case the spike host sat in a blocked write and saw no EOF until
   SIGTERM.
4. **§4.1 the 1 MiB cap.** 1 048 576 bytes of UTF-8 JSON pass, one byte more **closes the port** (the
   link drops and a new host starts), not just the message. Kai's chunk size must count encoded bytes.
5. **D1, and §1 "serves the sidebar's port": a page's ports do not keep the background.** Confirmed for an extension page; also, the
   sidebar's `runtime.connect` port is cut when the background is suspended (2.0 s after idle in the
   test). With no host installed (`connectNative` fails), the background will suspend, so the sidebar
   must reconnect its port.
6. **§5.8 results "come back as JSON".** A non-clonable value rejects the whole call; the tool should
   tell the model to return plain data. Code is a script (no top-level `return`). On CSP-strict pages,
   `eval`/`new Function` inside the code fail in both worlds, so Kai must not wrap code through `eval`.
7. **§5.8 the permission button.** Works; for tests: `extensions.webextOptionalPermissionPrompts = false`
   plus a BiDi click, or chrome-scope `ExtensionPermissions.add`. The user sees "requests additional
   settings".
8. **D5 "its gaps, such as `::before` content".** `::before` is right with
   `computedStyleSupportsPseudoElements: true`; the real gap is `placeholder`, which needs our fallback.
9. **D4.** `frameId` needs 64-bit integers in Kai; `documentId` comes from `webNavigation`.
   §5.3's frame merge can use `runtime.getFrameId(iframe)` in the parent.
10. **§3, §6.3, §13 (AT-SPI).** With `IsEnabled` on before Firefox starts, a windowed Firefox 159 on a
    windowed Plasma session exposes the page (14 nodes), its UI (131 nodes) and the tab-modal alert, with or without
    `force_disabled = -1`; `doAction` gives a trusted, user-activated click that opens tabs and popups. The
    file picker was not observed, and the memory use did not change measurably between the variants.
11. **§11 harness.** Firefox 159 needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in the environment besides
    `--remote-allow-system-access` for chrome-scope BiDi.
12. **§6.7 `DocURL`.** Firefox answers it for every http(s) document and frame (any origin relation or depth,
    sandboxed, navigated, after `pushState`), `about:` pages, `file:` and `view-source:`, and the frames
    are below the top document. It answers the **empty string for `data:` and `blob:` documents** (no
    `DocURL` attribute either), so Kai's rule "an empty answer is a page without a host" is what keeps
    those closed, not a non-empty address. See (d2).
13. **§6.7 `VISIBLE`.** Background tabs' documents and the preloaded New Tab page carry `visible` in the
    tree; only the page in front carries `showing`. A walk through VISIBLE elements reads more than the tab in front.
14. **§12 WP12, `ui_press`.** A first `NActions` read of a link or button can be 0 (100 ms later 1): a
    press that reads it once can miss a control.

## How to run

```
cd spikes/ext && npm install && npm run build   # esbuild + dom-accessibility-api (node_modules ignored)
node run-a.mjs keepalive [--minutes 5]          # (a) keepalive: ping, silent, control in parallel
node run-a.mjs pageport                         # (a) ports held by an extension page
node run-a.mjs sizes                            # (a) extension -> host throughput
node run-a.mjs lifecycle --mode stubborn        # (a) disable/enable, reload, update, uninstall, quit; also --mode eof-exit
node run-b.mjs                                  # (b)
node run-e.mjs                                  # (e)
node run-f.mjs [--controls 5000] [--repeat 5]   # (f)
./atspi-check.sh --dry-run | ./atspi-selftest.sh   # (d) without windows; ./atspi-check.sh opens windows on the desktop
./atspi-selftest.sh --abort-test                # (d) the wrapper's cleanup after an abort, on the private bus
./atspi-selftest.sh --docurl                    # (d2) DocURL, GetAttributes and frames on real Firefox, on the private bus
npm run sign                                    # (g) from the repository root, with AMO_JWT_ISSUER and AMO_JWT_SECRET
```

Files: `ext/` the spike extension (MV3, `kai-firefox-spike@rootshell.dev`, min 154), `host/spike_host.py`
the native host (modes via `SPIKE_HOST_MODE`, `SPIKE_PING_S`, `SPIKE_PIPE_SZ`), `lib/firefox.mjs` the
headless BiDi launcher (from an earlier BiDi harness), `page/` the test pages, server and generator,
`src/naming.js` the naming content script, `atspi_check.py` with its two wrappers and `atspi_docurl.py` (d2).

# Kai for Firefox: the browser as Kai's hands and eyes, and the Chat beside the page

**Draft v6, 2026-11-03.** v5 plus what WP6, WP7, WP7b, WP9 and WP11a built and decided, WP0 (g)'s
first signing, WP0 (d)'s repaired self-test, its run on a Plasma desktop session and the DocURL probe (d2),
and lmgw's WP2, in the appendix "Built so far (v5 → v6)". v5 was v4 plus what WP1 to WP5b built and decided, in the appendix "Built so far (v4 → v5)".
v4 was v3 plus WP0's verdicts (`spikes/ext/RESULTS.md`, `spikes/sidebar/RESULTS.md`)
and WP1's review, in the appendix "WP0 and WP1 into v4". v3 was v2 plus the owner's answers to its
open questions (decisions 9 to 15).
v2 was v1 plus an adversarial review (against Kai at f370fb0, lmgw at 81ddd11b and Firefox
159); every finding's disposition is in the first appendix. "Decided by the owner"
collects the owner's decisions from the design conversation of 2026-11-02 and 2026-11-03. "Taken in
this draft" is this document's own decision.

Companions, cited by short name:
- "kai §n", "kai Kn", "kai ruling n": Kai's design,
  [kai docs/design/2026-10-06-kai-design.md](../../../kai/docs/design/2026-10-06-kai-design.md);
- "api §n", "api Ln": lmgw's client-apps design (`lmgw/docs/design/2026-10-06-client-apps-design.md`);
- "link Dn": lmgw's device-link design (`lmgw/docs/design/2026-10-14-device-link-design.md`).

Facts about Firefox are as read on 2026-11-02 against Firefox 159, its
source and MDN. Every fact this design leans on that nobody has
measured yet is a point of WP0 (§12).

The wire is `docs/protocol/operations.md` (this repository): what each operation takes, answers
and how it fails. Where this document says "as built", that file is authoritative for the wire
facts and this document does not repeat them.

Kai for Firefox is a WebExtension that makes Firefox a part of Kai:
- **Kai's browser tools.** Kai hosts tools that read and operate the pages open in Firefox, for
  every caller that reaches Kai's label: Kai's own voice, the lmgw Chat, the phone (api §5.6).
  They work whether the sidebar is open or not.
- **The user's hands and eyes.** The same tools, plus a few that exist for it, let Kai act for a
  user who keeps browsing: read what is in front of them, say what changed, press what they name.
- **The Chat beside the page.** The sidebar is lmgw's Chat: the user's folders and threads, the
  same threads as the dashboard, Kai's voice and the phone.

The extension holds no credential and never talks to lmgw. Everything goes through Kai.

## Decided by the owner (2026-11-02, 2026-11-03)

1. **A new extension in its own repository.** An earlier extension is a parts
   bin: lift what is worth lifting, use the rest as inspiration, with no obligation to reuse.
2. **The extension depends on Kai** instead of adding a background service. It reaches lmgw only
   through Kai, over native messaging and Kai's local socket (kai ruling 18 stands); the
   native-messaging helper is started and ended by Firefox.
3. **The sidebar is a full Chat.** The user roams between chats and devices; the sidebar is one more
   view of the same threads. The sidebar is the right place; the earlier extension's look and UX are not the model.
4. **The sidebar is Leptos and reuses lmgw's Chat components.** Source uploads to Mozilla for
   signing are fine (AMO asks for the source of generated code).
5. **Unlisted AMO signing** is the distribution path. It has been shown to work, but it is slow.
6. **Kai's browser tools work with the sidebar closed.**
7. **Accessibility is a supported use case:** Kai as the user's hands and eyes, not an agent that
   browses by itself. It is designed and tested even though the owner does not depend on it.
8. **Firefox first.** Chromium is not part of this design.
9. **The sidebar is Kai** (2026-11-03, answering v2's D7, which made it a second device). Kai in the
   browser is Kai and has Kai's identity. When the user lets Kai administer lmgw and also uses Kai
   in Firefox, that choice stands over the safety concern: Kai tells the user it may be unwise and
   prevents nothing; the choice is the user's. §8.3.
10. **Admin Chat is not needed in the browser** (2026-11-03): what lmgw shows a device is enough.
11. **GitLab for all builds, GitHub for targeted releases**, as for lmgw and Kai (2026-11-03). §10.
12. **55 tools are too many to keep listed only to save a prefill** (2026-11-03, on v2's D3, which
    kept them listed while Firefox was closed). D3.
13. **§6.4's defaults are confirmed** (2026-11-03): acting tools confirmed until the hands-and-eyes
    switch is on, the focus rule, the commit guard with new origins and cross-origin submits.
14. **Announcements are spoken by Kai without a model**, off by default (2026-11-03). §7.2.
15. **The name is "Kai for Firefox"**, the id `kai-firefox@rootshell.dev` (2026-11-03).

## Taken in this draft

**D1. Manifest V3, Firefox 154 or newer.**
- 153 brings `userScripts.execute` (assistant-written code, §5.8); 154 brings
  `content_security_policy.sandbox`, under which the Chat's HTML preview runs in an extension page
  (§8.2); 128 brought `scripting.executeScript` in the `MAIN` world.
- The background is an MV3 event page. An open `connectNative` port opened *by the background*
  keeps it from being suspended (`hasActiveNativeAppPorts`, reason "nativeapp", Firefox source).
  *Measured, WP0 (a):* with the idle timeout lowered to 2 s, the port kept one background instance
  alive for 40 minutes, with traffic every 30 s and with a silent host; without the port it was
  suspended after 2.2 s. A page's ports do not keep it alive, so the background, not the sidebar,
  owns the native port.
- The sidebar's `runtime.connect` port is cut when the background is suspended, which happens when
  the native port cannot open (Kai's helper not installed). The sidebar reconnects whenever its
  port drops.
- *Why not MV2:* MV2 still runs without an end date, but code strings in MV2
  (`tabs.executeScript({code})`) have no successor there, the WebAssembly CSP is only report-only
  in MV2 (bug 1770909), and MV3 is where new APIs land.

**D2. Kai owns the tools; the extension owns operations.**
- The tool contract (names, descriptions, parameters, annotations) lives in Kai's `kai-desktop`
  crate as a new area `browser` (kai K23), under Kai's per-tool policy (kai K15).
- The extension implements **operations**: small, generic, versioned verbs (`tabs.list@1`,
  `page.outline@1`, `element.press@1`, §4.3). A Kai tool calls one or a few of them.
- *Why:* a new tool, a better description or a policy change needs no new XPI, and every XPI goes
  through slow AMO signing.

**D3. Browser tools are listed while Firefox runs with the extension connected** (*changed
2026-11-03,* decision 12).
- Kai lists the browser tools whose operations a connected extension serves (the union over
  connected profiles), and sends `list_changed` when the first extension connects or the last one
  disconnects: kai K23's rule, what cannot work now is not listed.
- The eight tools that exist only for hands and eyes (`page_links`, `page_fields`, `table_read`,
  `read_aloud`, `read_aloud_from`, `read_pause`, `read_resume`, `read_skip`) are listed only while
  the hands-and-eyes switch is on (§6.4), so the usual list is 47 tools.
- A model that wants the browser while Firefox is closed starts it (`app_launch firefox`); the
  tools are there from the next turn.
- **The trade** (the figure from `just tool-cost` in WP5): the tools render near the start of the
  prompt, and llama-server reuses its cached prompt only up to the first differing token, so a
  changed list re-prefills the whole conversation at the next turn. That happens when Firefox
  starts or quits during a conversation and a turn follows; a quit and a restart between two turns
  leave the list as it was and cost nothing. v2 avoided those prefills by keeping the list (an
  estimated 3 000 to 5 000 tokens) in every request of every thread with Kai's tools for as long as
  Firefox was closed: context and memory on local models, input tokens on cloud ones, and tools the
  model might try with no browser running. The owner judged that the worse trade.

**D4. Element refs are numbers, unique for a Firefox run.**
- The background allocates refs from one counter per Firefox run (kept in `storage.local` across
  restarts of the extension, begun again at Firefox's start); a ref names
  `(tab, frameId, documentId, element)`. The content script of that frame keeps the element in a
  `Map<localId, WeakRef<Element>>`; the background keeps the ref → (tab, frame, document, localId)
  map. A ref is never reused.
  - *As built (WP4a):* the counter lives in `storage.local` and starts again at 1 only when Firefox
    starts (`runtime.onStartup`), so refs stay unique across reloads, updates and suspensions of
    the extension. A restarted extension does not know the elements it gave out before: a ref from
    before the restart is an explicit error (`unknown_ref`, "from before Kai for Firefox
    restarted"), never another element. So a ref is valid within one instance of the extension and
    unique for the Firefox run (`docs/protocol/operations.md`, Element).
- A ref is reported the first time a tool names its element and keeps its number while that
  document is shown. A page left counts as gone even when Back restores it from Firefox's
  back-forward cache: its elements get new refs. A ref whose document is gone, or whose element is gone,
  is an error that says which: "ref 214 is from the page before the last navigation in tab
  'Checkout'; call page_controls", never a silent miss or another element.
- Element tools take only the ref: it names the tab, the frame and the document.
- `frameId`s exceed 32 bits (17179869185 was seen, WP0 (f)); refs and frame ids are 64-bit
  everywhere. `webNavigation.getAllFrames` gives each frame's `documentId`. *As built (WP4a):*
  `documentId` is a UUID string, not a number; frame ids are numbers above 2^32 and below 2^53.
- With two Firefox profiles running, Kai maps each extension's refs into one number space.
  - *As built (Kai, WP5 and WP5b):* Kai keeps one number space across profiles, retires every
    dropped number (stored as ranges) and persists the highest number it handed out
    (`$XDG_STATE_HOME/kai/browser-refs`), so no number ever names a second element, even across a
    Firefox or Kai restart.
  - *Taken in this draft:* with two profiles linked, a number that would mean two things is
    refused, the element Kai already called by it gets a new number, and `hints_show` marks a
    control whose label differs from its ref with "(hint N)" (§14). Hints could later take Kai's
    labels.
- Hint labels (§5.4) show the same numbers, so "press 214" and `element_press {ref: 214}` mean one
  element. The numbers grow over a Firefox run and Kai keeps them growing across restarts (above);
  short per-view labels would be easier to say but would put two numbers on every element. WP10
  tries both by voice.
- *Why not positional ids:* the earlier extension numbered `querySelectorAll` hits on every call, so an
  insertion shifted every id and the model's next click hit the wrong element; and a per-document
  number cannot tell tab A's 7 from tab B's.

**D5. Accessible names and roles are computed the way assistive technology does.** The content
script bundles `dom-accessibility-api` (MIT; the accname spec, 138 of 159 web-platform tests under
jsdom) for names and descriptions, and maps roles by HTML-AAM and ARIA. No WebExtension API exposes
Firefox's own accessibility tree. *Measured, WP0 (f), version 0.7.1:* `::before` text comes out
right with `computedStyleSupportsPseudoElements: true`; `placeholder` is not used as a name, so the
content script falls back to it itself; names inside closed shadow roots, `aria-labelledby` across
them included, are right. Cost on a page of 5 642 controls in four frames: 258 to 423 ms for all of
them, 32 to 58 ms for the 126 in view. *Taken in this draft (WP10b):* inputs HTML-AAM gives no
role get role words for their kind, as screen readers name them: `file`, `date`, `time`,
`datetime`, `month`, `week`, `color` (a range is a `slider`); Firefox 159 has no month and week
inputs, so those are textboxes there.

**D6. Input is synthetic first, trusted when it has to be** (§6.3).

**D7. The sidebar is Kai** (*changed 2026-11-03,* decision 9; §8.3). Kai proxies the sidebar's Chat
requests with its own device certificate. The extension still holds nothing.

**D8. One look with Kai and lmgw:** the Breeze-like graphite and blue of lmgw's kit, light and dark
following the desktop (`prefers-color-scheme`). Nothing of the earlier extension's palette.

**D9. The user's tab** is the active tab of the most recently focused Firefox window. Tools default
to it, and the focus rule (§6.4) is anchored on it.

## 1. Overview

```
Firefox                                                  Kai (one process)            lmgw
┌──────────────────────────────────────────┐            ┌─────────────────────┐
│ sidebar (Leptos, lmgw-chat-ui)           │            │ browser provider    │  /mcp/host (Kai's device)
│   │ runtime port                         │            │  (tools, policy) ───┼──────────── tools
│ background (MV3 event page)              │  stdio     │ lmgw proxy ─────────┼──────────── /chat/api/*
│   │ owns the native port ────────────────┼── kai-browser-host ── browser.sock │  (Kai's device)
│ content scripts (per frame)              │            │ trusted input,      │
│   elements, outline, actions, hints,     │            │ AT-SPI, speech      │
│   events                                 │            └─────────────────────┘
└──────────────────────────────────────────┘
```

- **Content scripts** do the page work in each frame: keep elements, outline, read, act, draw hints
  and highlights, watch for changes worth announcing.
- **The background** holds the native port, allocates refs, routes operations to the right tab and
  frame, merges frames, keeps per-tab state (inserted CSS, the find state, document request
  methods), runs the network gate, and serves the sidebar's port.
- **`kai-browser-host`** is a small Rust binary in Kai's repository (kai WP24, built in WP1). It must
  exit as soon as stdin closes, even while a write is blocked: a host that waits for the signals
  holds up Firefox's quit by 6 s (WP0 (a): 6.25 s against 0.42 s). Firefox starts it on
  `connectNative` and ends it with the port (stdin closed; SIGTERM after 3 s; SIGKILL 3 s later). It
  relays frames between stdio and `$XDG_RUNTIME_DIR/kai/browser.sock` and holds nothing.
- **Kai** hosts the tools to lmgw (kai §11.1), decides policy and confirmations (kai K15), proxies
  the sidebar's Chat requests with its own device certificate, and supplies what an
  extension cannot do: trusted input, AT-SPI, speech, PDF text.

What the extension never does: hold a key, open a network connection to lmgw, run a model, or
decide policy.

## 2. Lifecycle

- **Firefox starts:** the background starts and calls `connectNative("dev.rootshell.kai")`. It sends
  the host a `config` frame (`retry_ms`). The host connects to `browser.sock`; while Kai is not
  running it reports `{"t":"kai","up":false}` and retries every `retry_ms` (a visible field in the
  extension's options, default 2000 ms). The toolbar icon shows "Kai is not running" and the sidebar
  says it in place of the Chat.
- **Hello** (§4.2): versions, the profile id and the operation list go to Kai; Kai answers its
  version and protocol and lists the tools the operations serve (D3).
- **Firefox quits, the extension is disabled, updated or reloaded:** Firefox closes the port and
  ends the host; Kai sees the socket close, fails in-flight calls with "Firefox closed while the
  call ran"; when it was the last connected extension, the browser tools leave the list (D3).
- **Kai restarts:** the host's socket closes; the host retries; the extension's port stays up.
- **Several profiles or instances:** each runs its own host and link. Kai routes a call by its ref
  (D4) or `tab`, else to the instance with the user's tab (D9). `tab_list` names the profile when
  two are linked. Settings differ by profile only once the owner uses two (§13).

## 3. Where Kai cannot reach through the extension

Firefox keeps WebExtensions out of some places. "Not covered yet" means no path is built today;
AT-SPI is the route (below, WP12). On 2026-10-09 Firefox exposed just its application node on the
Plasma desktop session (kai WP13 (a)); WP0 (d), on 2026-11-03, found that a Firefox started with the
accessibility service on exposes its pages, its own UI and its dialogs.

| Place | Why | Covered by |
|---|---|---|
| PDFs in Firefox's viewer | privileged viewer | the background fetches the PDF's bytes (it has host permission for the URL) and Kai extracts the text with poppler's `pdftotext`, sandboxed (§5.3) |
| `about:` pages, Reader view, `view-source:` | privileged documents | AT-SPI (WP12): `page_text` reads one in the tab in front through the desktop's accessibility, `firefox_press` presses its controls, never in `about:config`, `about:addons`, `about:debugging`, `about:profiles`, `about:support`, `about:policies` or `about:preferences`; `about:logins` and another extension's pages are never read; elsewhere `page_text` says "Kai cannot read Firefox's own pages; this is about:preferences" |
| the restricted domains (`extensions.webextensions.restrictedDomains`: addons.mozilla.org, accounts.firefox.com and others) and quarantined domains | Firefox policy | not covered; the error names the pref |
| `file://` pages | since Firefox 153 the user's "Access local files" permission | the error says where to grant it |
| private windows | extensions run there only with the user's per-extension permission | not requested yet; tools say "Kai has no access to private windows" and never list their tabs |
| Firefox's own UI: menus, the address bar, permission prompts, save dialogs | not a page | AT-SPI (WP12): `firefox_ui` reads an allow-list around the tab in front (a site's permission prompts, the notification bars, the main tool bars without the tab strip, the menus), `firefox_press` presses them, a site's prompt only after the owner's yes to its words, never an add-on's prompt or a screen share; everything else (the address bar's text and suggestions, the tab strip, history, bookmarks, synced and recently closed tabs, the downloads, saved cards and addresses) is left out; save and file dialogs not covered yet |
| a page's `alert`, `confirm`, `prompt`, `beforeunload` | no WebExtension API sees them (bug 1351938, WONTFIX) | AT-SPI (WP12): `firefox_ui` reads the dialog as the page's text, `firefox_press` answers it (a `prompt()`'s text not yet: a headless Firefox kept its field) |
| user gestures | synthetic events grant no activation | the trusted path (§6.3) |

Overriding `window.alert` in the page at `document_start` would make dialogs visible, but it
changes how every page behaves. *Taken in this draft:* not done.

**AT-SPI, as measured** (WP0 (d), a run on a Plasma desktop session, 2026-11-03, Firefox
159.0, `spikes/ext/RESULTS.md` (d)): a Firefox started with `org.a11y.Status` `IsEnabled` already on
was on the accessibility bus at the first look, 8 s after its start, with or without
`accessibility.force_disabled = -1`; with the pref at 1 it was not. It exposed the test page (14 nodes) and its own UI (131 nodes: 4 tool bars, the tab,
the address bar, 26 buttons, menus; names such as "Back", "Reload", the address bar's placeholder, "List all tabs"), and a page's tab-modal `alert()` as an `alert` node with its text and an OK
button, which `doAction` pressed to close it. `doAction` gave clicks the page saw as trusted and
user-activated; a `target=_blank` link opened a tab and a `window.open` button a popup. A file input's
`doAction` was trusted and activated too, but no file chooser appeared in Firefox's tree and the number
of top-level windows stayed at 1: **the picker was not observed**. Firefox's memory use did not change
measurably between the three variants, so accessibility's cost was not measurable on a small
page. The run started Firefox after `IsEnabled` was on; whether a Firefox that started earlier joins
when it is switched on later (the 2026-10-09 case) was not tried again. The run exited cleanly,
restored `IsEnabled` to false and left nothing running. The Kai desktop provider that would cover the
rows above is WP12 (§12); WP0 (d) no longer blocks it.

*As built (WP12, Kai):* `firefox_ui` and `firefox_press` in the `browser` area, and `page_text` on
one of Firefox's own pages, Reader view or an error page, read and press through the desktop's
accessibility, only around the tab in front of its window (Kai's window of the link's Firefox
process whose shown page is the tab's address), and are listed only where the desktop offers
accessibility. Firefox 159's tree on a private bus (headless): the window's tool bars
(`TabsToolbar`, `nav-bar`, `notifications-toolbar`), the tab panels (per tab its page and, while
one is open, its dialog, a document `chrome://global/content/commonDialog.xhtml` of role `dialog`
titled "The page at <origin> says:", with its text as a label, a prompt's `entry`, a check box
"Prevent this page from creating additional dialogs" and its buttons), and the prompts and popups
open as the window's own children (`notification-popup`, an `alert`: "Allow <host> to access your
location?" with Block and Allow; `appMenu-popup`); elements carry their Firefox `id` and `class`
as object attributes. The rules: Kai's desktop tools' `page_rule` (Firefox's own pages the
strictest rule configured), a dialog by the stricter of its tab's rule and the origin its title
names (the strictest where it names none); the focus rule for `firefox_press`; with the commit guard
on, a dialog offering a choice or a site's prompt pressed only after the owner's yes; the network
gate on the tab's page around the press (`gate.open@1`); never `about:logins`, the password
manager's prompt, the logins' autocomplete or a password field. Checked on a headless Firefox 159 on
a private bus (Kai's `just atspi-firefox`): the page in front read and a background tab's not, a
cross-site frame's address and a `data:` frame's empty one, a mark found in the page and in a
cross-site frame but not in a background tab, its `doAction` a trusted, user-activated click on that
element alone, a `target=_blank` link opening a tab, `confirm()` as Firefox's dialog titled with the
page's origin and answered by its OK, Firefox's tool bars with the tab strip left out, a page tab
pressed bringing `about:preferences` to the front. Two findings: Firefox answered `SetTextContents`
on its `prompt()` field with yes and kept the field as it was (so `firefox_press` takes no text yet;
Kai's `set_text` reads the field again and says so), and after a tab switch it still marked the page
before `showing` for about 230 ms. Kai's design, WP24, has the drafts.

*As built (WP12's review round, Kai and kai-firefox):* the window is the tab's own: its page in
front (the page in its selected tab panel, Firefox's `deck-selected`, since a headless Firefox 159
kept a background tab's page `SHOWING` for good, the first tab's after an add-on opened a tab)
has the tab's address and its tab strip's selected tab is the tab, so a second window on the same page and the moment after a tab switch are
not taken; two shown pages with no selected panel (a split view) are refused. `page_rule` is an allow-list: an `http:`, `https:` or `file:` page with a host gets its
site's rule, every other page the strictest configured (another extension's `moz-extension:`
page, which has a host that is no site, too), and Kai never reads or presses in `about:logins`,
another extension's page or Firefox's saved cards and addresses. `firefox_ui` reads an allow-list:
the page's dialog (`commonDialog.xhtml` in the tab's own panel), Firefox's prompt for the tab's
site (Firefox 159 exposes the prompt's own parts under `notification-popup`, not the prompt: a
prompt is a site's when its description names the tab's site, "Allow 127.0.0.1:8080 to access
your location?", and it holds only the generic parts and the camera, microphone, screen, serial
port and canvas choices), the notification bars, the main tool bars without the tab strip, and the
menus (the application menu's main view by its items' ids); everything else is left out and
counted. A prompt for a site is judged by the stricter of the tab's rule and every site its words
name, and pressed only after the owner's yes to its words, whatever the commit guard and the
tool's state, as is a notification bar's button (Firefox's bars carry a site's pop-ups and DRM);
a dialog's choice with the commit guard on. Right before `doAction` Kai reads the tab,
the window and the control again (shown on the screen, the same role, name, part and words), and
any change refuses with what changed. Never pressed, whatever the rules, the guard and the tool's
state: `about:config`, `about:addons`, `about:debugging`, `about:profiles`, `about:support`,
`about:policies` and the whole of `about:preferences`, Firefox's add-on prompts (their install and
permissions, optional permissions such as `userScripts` and private windows included), a site's
request to share the screen or a window, and a page dialog with a password field. Checked on a
headless Firefox 159 on a private bus: a site's location prompt read as the tab's site's with its
words, a mark the page copied onto a second element said as two, an error page's window found by
the address that failed (its `DocURL`, not `about:neterror`), and another extension's page (a
temporary add-on installed through WebDriver BiDi) in front with the address Kai refuses.

*WP0 (d2), the DocURL and frames probe* (a headless Firefox on a private bus, `spikes/ext/RESULTS.md`
(d2)): the documents of a window are in its tree with their addresses, including the ones the extension
cannot reach (`about:robots`, `about:newtab`, Reader view, `view-source:`); §6.7 has what `DocURL` says
and does not. A first read of a link's or button's `NActions` can be 0 (100 ms later 1), which WP12's press
has to allow for (§6.3).

*The repair that preceded the run:* the first self-test ran its private AT-SPI launcher with the
session's runtime folder and display, and the launcher replaced the session's accessibility socket with a
dead one (`$XDG_RUNTIME_DIR/at-spi/bus_0`); every new AT-SPI client of the session was
refused until that bus was rebound. The self-test now runs everything it starts on a private
runtime folder, without a display and without D-Bus activation (kai-firefox `c860469`). The check
first opens a real connection to the session's accessibility bus and stops (exit 2, nothing started or
changed) when the bus refuses, because libatspi would abort the whole process; it keeps a state file, and
its wrapper cleans up after a signal or a hard abort (`IsEnabled` restored, its Firefox ended, the
throwaway profile removed).

## 4. The link: native messaging and `browser.sock`

### 4.1 Framing and sizes

- Firefox ↔ host: native messaging's 4-byte length prefix and UTF-8 JSON.
- Host ↔ Kai: the same frames on the Unix socket. The host reads the `t` field of each frame only
  to answer `config` and to send its own `kai` frames; everything else it relays unread.
- **Firefox caps a message to the extension at exactly 1 048 576 bytes** of JSON (`MAX_READ`, the pref
  `webextensions.native-messaging.max-input-message-bytes`); one byte more closes the whole port and
  Firefox starts a new host (WP0 (a)). Kai splits every frame it sends that is larger (an `op` with a
  long style sheet, script or file, a proxied response, an attachment), counting UTF-8 bytes, and the
  background joins the pieces. The host does not forward a larger frame: it sends the extension an
  `error` frame (`frame_too_large`) instead.
- **Toward the host** Firefox allows 4 GiB per message, but a large single message costs quadratic
  time (WP0 (a): 50 MiB took 11 s, the same as 1 MiB pieces 0.2 s). So the extension splits its
  large frames toward Kai the same way, and the host raises its pipe sizes (`F_SETPIPE_SZ`) where it
  may. Splitting is framing, not a cap: nothing is cut.
- What Kai sends on to lmgw is bounded by lmgw's `/mcp/host` message and frame settings (api §5.1).
  A larger tool result fails with lmgw's error naming the setting (kai ruling 9).

### 4.2 Messages

Every message is an object with a type `t`:

| `t` | Direction | Content |
|---|---|---|
| `config` | ext → host | `retry_ms`; sent once after `connectNative`, never in reaction to `up: false` |
| `kai` | host → ext | `up: bool`: Kai's socket is connected or not |
| `error` | host → ext | `code` (`frame_too_large`, `bad_config`) and `message` |
| `error` | Kai → ext | `code` and `message`: `id_too_long` (a `req` id too long for an answer under the 1 048 576-byte cap), `duplicate_req` (adds `id`: a `req` whose id is open on the link), `bad_split` (adds `split`: pieces that do not join), `unknown_frame` (adds `id`: a frame of a type Kai does not take that carried one, so the extension ends what waits on it), `bad_site` (adds `id`: a `site` question that does not read) |
| `error` | ext → Kai | `code` `bad_split`, `split` and `message`: a split frame from Kai that does not join |
| `hello` | ext → Kai | `ext_version`, `protocol`, `ops` (operation names with versions), `firefox` (version), `profile` (a random id kept in `storage.local`) |
| `welcome` | Kai → ext | `kai_version`, `protocol`, `takes` (the extension's frame types Kai takes; a Kai before WP8b's fix round sends none) |
| `refused` | Kai → ext | `reason` ("update Kai", "update the extension", a peer outside Firefox's units, a first frame over the limit); Kai closes the connection after it |
| `op` | Kai → ext | `id`, `op`, `args` |
| `op_result` | ext → Kai | `id`, `ok` (the result) or `error` (`code`, `message`) |
| `cancel` | Kai → ext | `id`: lmgw stopped waiting (api L11); the extension stops what it can |
| `ask` | ext → Kai | the network gate holds a request (§6.4): `id`, `tab`, `method`, `url`, `body` |
| `answer` | Kai → ext | `id`, `allow: bool` |
| `event` | ext → Kai | `kind` and its fields (§7; each kind's fields: `docs/protocol/operations.md`, Events) |
| `req` | ext → Kai | a sidebar request: `id`, `method`, `path`, `headers`, `body`, `read` (§8.2) |
| `res` | Kai → ext | `id`, `status`, `headers`, `body` (how the pieces read); then `chunk` frames; then `end` |
| `chunk`, `end` | either way | a **split frame**: `split` (a number per link and direction), `seq`, `data` (a piece of the frame's JSON text); or a **body** (Kai → ext only): `id`, `seq`, `data` (text, or base64 when `res.body` says `base64`), the `end` with an `error` when lmgw's stream broke off |
| `ack` | ext → Kai | `id`, `seq`: how many pieces of the body the sidebar took (the flow control, §8.2) |
| `abort` | ext → Kai | `id`: the sidebar dropped a request or stream |
| `site` | ext → Kai | `id`, `urls`: the sidebar's question about sites' rules (§8.1) |
| `site` | Kai → ext | `id`, `rules` (`site`, `rule` per address, in order) |

`protocol` is one integer; a change that is not additive raises it. An additive frame does not:
Kai's `welcome` lists the extension's frames it takes (`takes`), as the `hello` lists the
operations the extension serves, and the extension sends a frame a Kai may lack (the sidebar's
`site`) only to a Kai that lists it; a frame with an `id` that Kai does not take is answered with
`error` `unknown_frame`, so nothing waits on a frame a Kai dropped.

Rules of the conversation:
- After `kai up: true` the extension sends nothing but `hello` until `welcome`; Kai skips anything
  else that arrives before a `hello` (a late frame of the previous link) and logs how many.
- **Joining split frames:** pieces of one `split` arrive contiguously, `seq` from 0, and `end.seq` is
  the number of pieces; the receiver joins the `data` texts and parses the result as the frame. A
  receiver checks `split` before `id`. A malformed or interleaved split is an explicit `error`, never
  a guess; a split cut off by a closing link is dropped.
  - *As built (WP1, WP4a):* the host's and Kai's `error` frames (and the host's `kai` frames) pass
    through a split being joined and do not break it. A split from Kai that the extension cannot
    join is dropped and answered with `error {code: bad_split, split}`; the `op` it carried never
    ran and gets no `op_result`, so Kai fails that op at once. Kai answers a split from the
    extension that it cannot join the same way. The full list of codes and the wire details are in
    `docs/protocol/operations.md` (Calls, Split frames).
- **Bodies** (`res`) are keyed by `id`; each base64 piece decodes on its own.
- An `ask` that nobody in Kai answers is answered `allow: false`.
- A refused link is not retried faster than `retry_ms`; repeated refusals and the host's
  reconnects are logged once and then counted, not on every cycle.

### 4.3 Operations

Operations are what the extension can do; tools (§5) are what the model sees. An operation is
named `area.verb` and versioned (`page.outline@1`). Kai lists a tool only when a connected
extension serves what it needs (D3); a mismatch shows in Kai's log and tray (kai K23's capability
table).

### 4.4 The socket and who may use it

- `$XDG_RUNTIME_DIR/kai/browser.sock`, mode 0600 in Kai's 0700 folder, the peer's uid checked;
  built like `cli.sock` (`kai/src/cli/server.rs`).
- **The peer must run in Firefox's systemd unit.** Kai reads the peer's cgroup through
  `SO_PEERPIDFD` (as `cli.sock` does for routines) and matches the innermost unit of its path (the
  last `.scope` or `.service`, never a parent slice) against `browser.peer_scopes`, a visible
  setting. The defaults cover what Plasma names Firefox: a Firefox started from a link
  runs as `app-userapp\x2dFirefox\x2d<id>@<uuid>.service`; the menu and autostart forms
  (`app-org.mozilla.firefox@*.service`, `app-firefox-*.scope` and the like) are inferred from KIO's
  and systemd's naming (WP1). A pattern that would match the user's manager unit or a slice is
  refused when saved. Others are refused and logged once with their executable and cgroup. Tests
  set `KAI_BROWSER_SOCKET` and a dev Kai's `browser.peer_scopes`.
- This raises the bar; it is not a boundary: a process of the same user can move itself into
  Firefox's scope. A successful impostor gets Kai's reach on the Chat plane (the sidebar is Kai, D7)
  and can answer operations falsely.
- **In the extension**, the background accepts `req` frames only from the sidebar page's port
  (`sender.url` is the sidebar's, no `sender.tab`), never from content scripts or other pages.

### 4.5 The native manifest

- Name `dev.rootshell.kai` (Kai's app id), `type: stdio`, `allowed_extensions: ["kai-firefox@rootshell.dev"]`.
- The Kai RPM installs it at `/usr/lib64/mozilla/native-messaging-hosts/dev.rootshell.kai.json`
  pointing at `/usr/libexec/kai/kai-browser-host`. A dev build installs a per-user manifest in
  `~/.mozilla/native-messaging-hosts/` with `just browser-dev`.
- A Flatpak or Snap Firefox needs the native-messaging portal or proxy, which this design does not
  support yet; the extension then says "Kai cannot be reached from a sandboxed Firefox yet".
  Fedora's RPM Firefox is not sandboxed.

## 5. The tools

All tools follow kai K22: one purpose, at most two plain parameters, no parameter that applies only
in some mode, terse descriptions, compact line results, never truncated, the scope chosen by which
tool is called. lmgw shows them as `kai__<name>`.

Common parameters:
- `tab?`: a tab id, or a fragment of its title or URL, resolved by Kai like `window` (kai K22). It
  defaults to the user's tab (D9). An ambiguous fragment is an error that lists the candidates.
- `ref`: an element ref (D4). It names its tab, so element tools take no `tab`.

Every result that comes from a page starts with the tab's title and URL, so page text is never
mistaken for the user's words.

*As built (WP4b, WP5):* an error about a tab carries the tab as fields (`tab`, `title`, `url`), and
its message names tabs by id only, so Kai can withhold a page it may not show
(`docs/protocol/operations.md`, Calls). For a tab on a `none` site (§6.4) Kai says only the tab id
and what failed.

**Sensitive fields are masked** wherever a tool reports a field's value (`page_controls`,
`page_fields`, `browser_context`, `element_text`): a password field, and fields whose `autocomplete`
says `cc-number`, `cc-csc`, `one-time-code` or `current-password`/`new-password`, report "password
field, filled (12 characters)" instead of the value. The page's own text and DOM are not masked,
except such a field's `value` attribute and content in `page_dom` and `element_dom`, which read as
the mask: pages such as React's write what was typed back into the DOM. **Screenshots are not
masked** (`page_see`, `element_see`): a password field's dots show its length, and a frame of a
`none` site is in the image like the rest; the extension lists each frame's part of the image and
Kai blanks those of `none` sites before the image leaves it (§6.4, *as built WP7*).
`page_script*` can read anything and is confirmed by default.

Read-only tools carry `readOnlyHint`. Tools that act on a page are state-changing. `page_script`,
`page_script_main` and `element_file` are confirmed by default (kai K15, K24's class).
`page_see` and `element_see` return images (`ToolSpec::returns_images`), so the owner's setting for
who looks at screenshots (kai K25) applies to them as to `see_window`.

### 5.1 Where the user is

- `browser_context {}`: the user's tab (id, title, URL, loading or not, Reader view available or
  on, zoom), the focused element (ref, role, name), the selection's length and its first line, the
  element under the pointer (ref, role, name), the visible part (the first heading in view, how far
  down the page in percent), an open modal dialog (its ref and name), the number of open tabs, and
  the announcements since the previous `browser_context` call (§7.2). One call answers "this",
  "here" and "that link".
  - *As built (WP9, the extension's half):* the announcements are Kai's: Kai keeps the `event`
    frames that came since its previous `browser_context` and adds them; `context.get@1` has no
    such field.
  - *As built (WP9, Kai's half):* each announcement since the previous call (from any caller;
    they are not per thread) comes with whether it was spoken and why not; one older than
    `browser.announce_keep_s` (a visible setting, default 600 s) leaves the list and is counted,
    as are those that went unspoken for their age or the screen lock. A reading's place and state
    are in it too (§7.5). The list has entries only while announcements are on (§7.4).

### 5.2 Tabs and navigation

- `tab_list {}`: one line per tab: id, title, URL, window, active, pinned, audible or muted,
  container. Tabs on `none` sites are left out, and a count line says how many (§6.4).
- `tab_open {url, sandbox?}`: a new tab. `url` that is no URL is a search with the user's default
  engine (`search.query`). `sandbox: true` opens it in the "Kai" container (§6.4).
- `tab_go {url, tab?}`: the same in an existing tab.
- `tab_switch {tab}`, `tab_close {tab?}`, `tab_back {tab?}`, `tab_forward {tab?}`,
  `tab_reload {tab?}`, `tab_mute {on, tab?}`.

### 5.3 Eyes: reading

- `page_outline {tab?}`: the landmarks and headings of the whole page, each with its ref and level,
  the one in view marked. A screen reader's heading and landmark list.
- `page_controls {tab?}`: every link, button, field and control **in view** (partly visible
  included), across frames, one line each: ref, role, name, value or state (`checked`, `disabled`,
  `invalid`, `expanded`), the field's label and its error. When a modal dialog is open (`<dialog>`
  opened modally, `aria-modal`, the rest `inert`) only the dialog's controls are listed, and the
  first line says so.
- `page_links {tab?}`, `page_fields {tab?}`: every link, or every form field, of the whole page: a
  screen reader's elements list.
- `page_text {tab?}`: the article, when Readability finds one, whole; the result says what it left
  out ("navigation, comments and 3 asides left out; page_text_all reads everything"). Without an
  article it is the same as `page_text_all`. In a PDF tab: the PDF's text, extracted by Kai with poppler's `pdftotext` in its default
  reading-order mode (not `-layout`, which interleaves columns; Kai's RPM requires `poppler-utils`),
  whole, page by page; pages without a text layer (scans) and text that is not readable (broken font
  encodings) are named as such instead of returning nothing or garbage.
  - *As built (WP5b):* Kai runs `/usr/bin/pdftotext` in bubblewrap: `/usr` read-only, an empty
    environment but `PATH` and `LANG`. Without bubblewrap it runs unsandboxed and logs a warning;
    the RPM recommends it.
  - Memory is limited by `RLIMIT_AS` and the output is read against a budget. Both are visible
    settings (`browser.pdf_memory_max_mb`, `browser.pdf_text_max_mb`) and a refusal names the
    setting; `browser.pdf_timeout_s` bounds the run.
  - Text that is not readable is judged per line (dot leaders, blanks and leading private-use
    bullets do not count). The lines left out are reported with their count and the reason.
- `page_text_all {tab?}`: all the page's text in reading order, frames included, whole.
- `page_text_visible {tab?}`: the text in view, in reading order.
- `element_text {ref}`: one element's text; for a heading, its section up to the next heading of
  the same or a higher level.
- `table_read {ref}`: a table as lines, each cell with its row and column headers ("Price, Plan
  Pro: 12 €"), the way a screen reader announces cells.
- `page_selection {tab?}`: the selected text, whole (the content script reads `getSelection()`;
  Gecko's menu selection text stops at about 150 characters).
- `page_find {text, tab?}`: the number of matches and one line per match: the containing element's
  ref and the sentence around it. Firefox highlights them (`find.find`, then `find.highlightResults`).
- `page_see {tab?}`: a screenshot of the visible part, as an MCP image block (`tabs.captureTab`).
  Hints and highlights are hidden for the capture. A tab Firefox has not rendered (a background tab
  it unloaded) is an error saying so.
- `element_see {ref}`: the same, cropped to the element: an image without alt text, a chart, a
  canvas, a CAPTCHA. The crop is measured from the decoded image, not from the device pixel ratio.
  - *As built (WP7):* the image covers the viewport with its scroll bars (`innerWidth`,
    `innerHeight`), and its scale is reported per axis (Firefox captures whole CSS pixels: at 150 %
    zoom 1281 × 900 for 853 × 600). page.find's highlights are Kai's too: hidden for the capture
    and drawn again. A background tab is captured (Firefox draws it for the capture); only a
    discarded one is an error. `element_see` scrolls an element out of view into view first, as
    `element_point` does, and says when the image shows only part of it
    (`docs/protocol/operations.md`, `page.see@1`, `element.see@1`).
  - *As built (WP7 review):* every answer lists the child frames as a tree (each with its child
    frames) with their part of the image in image pixels, `null` for a frame out of view,
    measured right before and after the capture; Kai blanks those of `none` sites. A frame whose
    parent cannot be read gets the part of the nearest measured frame around it. A tab whose URL
    or top document changed during the capture answers `page_changed`, never an image under the
    wrong name. Captures at the same time each keep Kai's drawings hidden until the last. A pinch
    zoom does not change the image (Firefox 159 captures the layout viewport; measured with a
    synthesized touchpad pinch).
  - *As built (WP7 second review):* a frame is named by the document it shows right after the
    capture; one that went to another origin between the hiding of Kai's drawings and then also
    carries the origin before (`origin_before`), and Kai applies the stricter of the two.
  - *As built (WP7, Kai, after its review; taken in this draft, §14):* Kai blanks grey every
    child frame whose origin or `origin_before` is a `none` site, an opaque origin under the
    strictest rule configured, and an unmeasured frame by the box the answer gives it; it checks
    the PNG's size against the answer's before decoding, and the colour chunks survive the
    re-encoding. An answer without an image is refused, and while a site is `none` one that names
    no frames gives no image. The line before the image says its size, the CSS pixels it covers
    and the scale measured from it (Kai `622a4c8`).

**Frames.** Each frame's content script reports its own elements; the parent frame reports each
`<iframe>`'s box, and the background offsets the child's coordinates by it to decide "in view" and
to order lines. Cross-origin frames (consent banners, payment forms) are included like any other.
*As built (WP4b):* Firefox 159 runs content scripts in `sandbox=""` frames too, so sandboxed frames
are read like any other, and `about:blank` and `about:srcdoc` frames are read with the origin they
inherited. A frame the content script cannot run in is listed as unread, with its origin, a reason
code (`content_timeout`, `restricted_domain`, `site_permission`, `firefox_page`, `file_access`,
`no_content`) and its `<iframe>`'s title, and in text where its `<iframe>` is. Kai names it:
`pay.example "Payment" (<reason>)` (`docs/protocol/operations.md`, Frames and Block).

What Kai draws over the page (hint labels, the highlight ring) is never part of the page's text,
find matches or outline.

**Shadow DOM.** Content scripts walk open shadow roots and, through `openOrClosedShadowRoot`
(available to extensions), closed ones.

### 5.4 Hands: acting

- `element_press {ref}`: scroll it into view, focus it, activate it (§6.3).
- `element_fill {ref, text}`: replace a field's value.
  - Inputs and text areas: the native value setter plus `input` and `change`.
  - Comboboxes and fields with `aria-autocomplete`: the text goes in one character at a time with
    key events around each, so their suggestion lists open.
  - Rich editors (`contenteditable`: ProseMirror, Lexical, Draft.js): `execCommand("insertText")`
    after selecting the old content, which fires the input events editors handle. Where that fails
    the result says so, and the trusted way is `element_focus` then Kai's `type_text`.
  - Sliders, spin buttons, date and time inputs: native ones take the value; ARIA ones
    (`role=slider`) get arrow, Home and End keys until `aria-valuenow` matches.
- `element_choose {ref, option}`: pick an option of a select, listbox or radio group by its label.
- `element_check {ref, on}`: set a checkbox or switch.
- `element_file {ref, path}`: give a file input a file from this machine: Kai reads the file and the
  content script assigns it through a `DataTransfer`, so no file picker opens. Confirmed by default:
  it sends a local file to a site.
  - *As built (WP6, Kai):* Kai opens the file when the call is prepared, so the dialog names its
    real path and size; only regular files of real file systems are taken. A file that changed
    after the dialog is refused, and so is one larger than one JavaScript string of Firefox's
    holds (the error names the most). The bytes go into the frame as base64 while Kai reads them,
    in split frames (§4.1).
- `element_focus {ref}`: move the focus there (the caret to the end of a field). The step before
  Kai's `type_text` and `key_press`.
- `element_hover {ref}`: pointer-over events, for menus a script opens on hover. CSS `:hover` menus
  do not react to synthetic events; the result cannot tell, so the description says it.
- `element_drag {ref, to}`: drag an element onto the element `to` (both refs), with HTML5 drag events
  and the pointer sequence libraries listen for.
- `element_show {ref}`: scroll the element into view.
- `element_scroll {ref, to}`: scroll inside a scroll container: `to` is `down`, `up` (a screen
  each), `top` or `bottom`.
- `page_scroll {to, tab?}`: the same for the page.
- `page_key {keys, tab?}`: synthetic key events to the focused element (`Escape`, `ctrl+k`). For a
  key that must be trusted, Kai's `key_press`.
- `hints_show {tab?}`: numbered labels over every control in view, the numbers being the refs
  (with two profiles linked, a control whose label differs from its ref is marked "(hint N)", D4);
  answers the same lines as `page_controls`. The labels stay until `hints_hide` or a navigation;
  after a scroll they are redrawn for the new view.
- `hints_hide {tab?}`.
- `element_point {ref}`: a highlight ring that fades after `browser.point_ms` (a visible setting,
  default 3000 ms): "this one?".

Double-click and a native context menu are not built yet (§13).

### 5.5 Firefox's own features

- `page_zoom {percent, tab?}` (`tabs.setZoom`).
- `reader_view {on, tab?}` (`tabs.toggleReaderMode`; an error says when the page is no article).
- `bookmarks_find {query}`, `history_find {query}`: title, URL, when.
- `downloads_list {}`: file, path, size, state, when. Opening a finished file is Kai's
  `open {target}` with its path (`downloads.open` needs a user action in the extension).
- *As built (WP7):* `page.zoom@1` sets the zoom (`percent` is required; `context.get@1` reads it)
  and reports Firefox's zoom scope (by default per site: the zoom applies to every tab of the
  site); `reader.view@1`
  waits for the page Reader view shows, as a navigation; bookmarks carry their folders, history
  and downloads come newest first, private downloads are left out (also when the extension may run
  in private windows), and Firefox 159 reports no end time for a download. A download carries
  `url`, `final_url` and `referrer`, and Kai leaves it out when any of them is a `none` site. Kai
  applies its site rules to the URLs of all three features.
- *As built (WP7 second review):* `page_zoom` and `reader_view` name the origin Kai approved, as
  `page_css` does, and act only on a tab whose page is of it (Reader view's page by the page it
  shows), else `page_changed`. Firefox's zoom and Reader view take a tab, not a document, so the
  check is right before and again right after, not held as `page_css`'s is.

What plays (pause, next, volume) is Kai's through MPRIS already: Firefox publishes its media
sessions there (kai K24's `media_*`).

### 5.6 Source and DOM

- `page_source {tab?}`: the HTML the server sent.
  - The background records every top-level document's request method from load time
    (`webRequest.onBeforeRequest`, type `main_frame`).
  - A document that came from a `GET` is fetched again from the page, from the cache alone first
    and from the server only when the cache has no copy; the result says which (the content may
    then differ from what is shown, and a GET with side effects happens again).
  - A document that came from a `POST`, or one loaded before the extension started, is not fetched
    again; the error says why and points to `page_dom`.
- `page_dom {tab?}`: the live document as HTML, whole: `getHTML()` with every open and closed shadow
  root, and each frame's document after its `<iframe>`, marked with the frame's URL.
- `element_dom {ref}`: one element's HTML, the same way.
- *As built (WP7):* the method goes to the document by tab, URL and time: the newest request that
  began after the tab's previous commit and before the document's own, unless it failed or its
  navigation ended without a document (a download); webRequest's and webNavigation's events come
  in either order, a request's sometimes after its page has loaded, so `page_source` waits for it
  within `content_ms`; the records live in `storage.session`. The fetch asks the cache alone
  first (`only-if-cached`) and the server only when the cache has no copy, which repeats a GET
  with side effects; the answer says which. A page a script wrote or a `blob:` document is unknown
  like one from before the extension started. The DOM comes as a list of HTML strings and frame
  entries (frame id, URL, origin, the element's `src`, the frame's own list), so Kai marks each
  frame and leaves out frames of `none` sites (§6.4); the parent's HTML has a frame's address as
  its origin only, sensitive fields' values as the mask, and none of Kai's own elements
  (`docs/protocol/operations.md`, Source and DOM).
- *As built (WP7 second review):* `page_source` lists the frame addresses of the server's HTML
  (each `src` and `data` of a frame element, exactly as the text writes it, with its origin), so
  Kai takes out those of `none` sites before the text reaches the model; the text itself is the
  server's.
- *As built (WP7, Kai, after its review; taken in this draft, §14):* Kai takes every occurrence
  of each such address out of the text, the longest first, and says how many it took out; while a
  site is `none` it refuses a source that comes without the `frames` list. A source from or
  redirected to a `none` site is not said. The answer gives the size uncompressed, and the
  description says that a GET may be sent again and that a request may be reported late.
  Addresses inside a `srcdoc` attribute's HTML and URLs a script builds are not listed yet (§13).

### 5.7 Styles

- `page_css {css, tab?}`: add a style sheet at the user origin (`cssOrigin: "user"`).
  - A user-origin sheet beats the site only for `!important` declarations, so the tool marks every
    declaration `!important`; the result says so.
  - The text is parsed first with a `CSSStyleSheet`; declarations the parser dropped are listed in
    the result ("not understood: colr: red"), since `replaceSync` drops them without an error.
  - Answers an id.
- `page_css_remove {id}`. The background keeps the exact text per tab and frame, because `removeCSS`
  needs it, and every text ever inserted per frame, because a page restored from the back-forward
  cache keeps its sheets (a measured lesson from the earlier extension).

Sheets last until the page is left. Styles that come back on every visit are not built yet (§13).

*As built (WP7):* a sheet goes into the top document; frames are not styled yet. What is inserted
is the parsed sheet as Firefox writes it out, and the answer lists what the parser dropped by
declaration, rule and statement. A page restored from the back-forward cache comes back without
Kai's sheets, as its refs come back new (D4): the `ever` texts are removed then, and the ids of
the page that was left answer `page_left`. Ids are unique for a Firefox run
(`docs/protocol/operations.md`, Styles).

*As built (WP7 review):* the call names the origin Kai approved, and the sheet goes only into a
top document of that origin, by its document id (`page_changed` otherwise). Every selector's
subject excludes an attribute Kai's overlay host carries, random per document, so a user
`!important` rule cannot hide or move Kai's labels; `@scope` was the first idea, but its plain
selectors no longer reach the root element (measured). A `url( )` is a GET to its site: the answer
lists the sheet's absolute URLs (`fetches`), and a sheet that loads from any origin Kai did not
pass in `fetch_origins` is refused (`fetch_not_approved`), so Kai's dialog is authoritative; the
parse-only `page.css_check@1` gives Kai the fetches to name before it asks. Sheet ids are unique
per Firefox run like refs; Kai keeps them per link.

*As built (WP7 second review):* what a sheet fetches is read from the text as inserted with CSS's
own tokenizer, so escapes in a function's name or a string hide nothing, and every string of every
declaration that is an absolute URL of a site counts, custom properties included: a page's own
rule can use Kai's custom property where a file is named (measured). A `var( )` inside a function
that takes a file is refused (`css_var_url`), as its target is known only once the page is styled.
A fetch from the page's own origin needs `fetch_origins` like any other.

*As built (WP7, Kai, after its review; taken in this draft, §14):* the preparation asks
`page.css_check@1` what the sheet fetches and names each fetch in the dialog. A fetch from a
`none` site or an opaque origin is refused. Each other site than the page's that the user has
never been to is asked about as the navigation guard asks (§6.4), whatever `page_css`'s state,
and also for a call a trusted approver approved in lmgw: that approver saw the sheet, not which of
its sites are new to the user. The call then passes exactly the origins the dialog named as
`fetch_origins`, the page's own among them, so the extension's check is strict. An answer that
names a fetch from another origin breaks the contract: Kai takes the sheet out again and says so
as the call's error. `css_var_url` and `fetch_not_approved` are said in words (Kai `622a4c8`).

### 5.8 Scripts

- `page_script {code, tab?}`: run JavaScript in an isolated world (`userScripts.execute`, world
  `USER_SCRIPT`): it sees the DOM, not the page's own variables. The value of the last expression,
  or a returned promise's result, comes back as JSON. *Measured, WP0 (b):* 1 to 5 ms a call; an
  exception comes back per frame. The tool's description tells the model to end with plain data: a
  result Firefox cannot clone (a DOM node, a function) fails the whole call, and a top-level
  `return` is a syntax error. The code runs as given, never wrapped through `eval` (strict-CSP pages
  refuse `eval` in both worlds).
- `page_script_main {code, tab?}`: the same in the page's own world (`MAIN`), where the site's
  JavaScript lives.
- Both are confirmed by default. A call approved in lmgw must name its tab (`tab` given, not
  defaulted), so the approver saw where the code runs (as kai K15 requires input tools to name their
  window).
- `userScripts` is an optional permission that Firefox grants only on a user action: the extension's
  options page has the button. Until granted, both tools answer "allow user scripts in Kai for
  Firefox's options".
- *As built (WP7):* the code runs in the top document; frames are not run in yet. The value comes
  back as `JSON.stringify` writes it; a thrown value, a value Firefox cannot clone (an object that
  refers to itself included) and one without a JSON form (a `BigInt`) are errors of their own. The
  extension sets no time limit: Kai's deadline and `cancel` end the wait
  (`docs/protocol/operations.md`, Scripts).
- *As built (WP7 review):* the call names the origin Kai approved, and the code runs only in a top
  document of that origin, by its document id (`page_changed` otherwise). The code runs inside a
  block (`{` code `}`), so its `let`, `const` and `class` end with the call; `var` stays, as in any
  script. The isolated world has no messaging, and a credentialed `fetch` to another origin cannot
  read the answer without that site's CORS consent (Firefox's defaults, tested; no
  `configureWorld` needed). `value` and `thrown` are page text: Kai shows them under the page
  header and checks its site rule on the answer's tab URL first; an error's name reaches the
  message only in the form of a built-in one.

### 5.9 The cost

The browser area adds 55 tools (§5.1 to §5.8 and §7.3), 47 while the hands-and-eyes switch is off
(D3). kai K22's check counts Kai's whole tool list through lmgw's `/v1/count_tokens` per alias
(`just tool-cost`); WP5 records the figure. The owner switches off what they do not use (kai K15
`off`).

## 6. Hands and eyes: the accessibility use case

### 6.1 What it means

The user browses. Kai does what the user cannot or does not want to do with their own hands or
eyes:
- **Eyes:** "what is this page", "read the article", "what does the error say", "what is in that
  picture", "what did the button do", told without looking.
- **Hands:** "open the second result", "fill in the form", "press 14", "scroll down", "go back",
  done without mouse or keyboard.

The difference to an agent that browses by itself: the user's focus, selection and pointer are the
reference point, the user's tab is where Kai acts, and every step is one the user asked for. Kai's
conversation mode (kai K27) is the voice side: the user talks, Kai acts and answers, with no key
held.

### 6.2 What it needs beyond an agent's tools

- **The user's position:** `browser_context` (§5.1).
- **Structure before text:** `page_outline`, `page_controls`, `page_links`, `page_fields`,
  `table_read`, with names computed like a screen reader's (D5) and modal dialogs respected.
- **Speakable targets:** hints (§5.4).
- **Change reports without asking:** loaded, a dialog opened, an error appeared under a field, a
  live region spoke (§7).
- **Reading aloud** with the paragraph highlighted, and pause, resume and skip (§7.3).
- **Trusted input** where a page demands a real gesture (§6.3).
- **Files without a picker** (`element_file`).
- **Firefox's own UI and dialogs:** not covered yet (§3).

Gaps a user will hit, not designed yet (§13): data to fill in ("my address": Firefox's address and
password managers have no WebExtension API, and Kai keeps no such data); captions of videos;
CAPTCHAs beyond describing them (`element_see`); a native context menu and double-click.

### 6.3 The trusted path

Events a content script dispatches are `isTrusted: false`, and `element.click()` from a content
script grants no user activation. Pages refuse such events for popups (`window.open`), file
pickers, fullscreen, clipboard writes and sound, and some sites ignore synthetic clicks altogether.
No WebExtension API produces trusted input, and Firefox has no `debugger` API.

`element_press` works in two steps:
1. The extension scrolls the element into view and focuses it. For an element that needs a gesture
   by its kind (a link with `target=_blank`, a fullscreen or media control) it reports
   `needs_trusted`; otherwise it dispatches the synthetic activation and returns. Whether a site's
   own handler needs a gesture cannot be told from outside; `browser.trusted_press = "always"`
   (default `"when_needed"`) sends every press the trusted way.
2. On `needs_trusted` Kai sends the key the trusted way:
   - Kai activates Firefox's window (`window_activate`), then asks the content script whether the
     element's document has the focus (`document.hasFocus()`) and the element is
     `document.activeElement`. If the sidebar, the address bar or anything else holds the focus,
     the press fails with "the page does not have the keyboard focus (the sidebar has it)"; no key
     is sent.
     - *As built (WP6, Kai):* the window is the one of the link's Firefox process, the native
       host's parent pid, which Kai reads through the pidfd at the peer check (§4.4); without it,
       Firefox's windows by app id, Private Browsing windows aside. Among them Kai takes the one
       titled "<tab title> — " after the tab as `element.press@1` left it.
     - *As built (WP6):* `focus.check@1` tells another tab, another Firefox window, another
       application, another element of the page and Firefox's own UI apart, but not yet which part
       of Firefox's UI holds the focus: the sidebar's own report of holding it comes with WP8
       (§13). Until then the failure says "the sidebar or address bar has the keyboard focus".
   - No Kai overlay may hold the keyboard (the approval card takes Enter, kai §11.1); if one does,
     the press waits until it closes.
   - Kai presses Enter (Space for checkboxes and buttons that take it) through its Input capability
     (`org_kde_kwin_fake_input` or the RemoteDesktop portal, kai K23). Firefox receives a trusted
     key on the focused element.
   - The step is decided under `key_press`'s policy state (confirmed by default, kai K24): Kai's
     confirmation names the tab and the element. An lmgw approval of `element_press` does not
     cover it, because the approver saw only a ref. With the hands-and-eyes switch on (§6.4),
     `element_press`'s own state decides the step instead.
     - *Taken in this draft (WP6):* for any call approved in lmgw, the real key is asked at Kai's
       desk unless the deciding tool (`key_press`, or `element_press` with the switch on) is set to
       `allow` (§14).
   - The user typing at the same moment can interleave with the key; the step is one key, so the
     window is short.
   - *As built (WP6):* Kai brackets the step, and every other trusted input it sends to Firefox
     (`key_press`, `type_text`, AT-SPI actions), with an input span (`input.begin`, `input.end`):
     trusted input inside it is Kai's, never the user's act the focus rule reads, also when the
     user typed then. The check is `focus.check` right before the key (after any confirmation),
     which opens the network gate; `gate.result` reports the requests held and which key reached
     which element (`key_seen`), or that the gate expired before Kai read it.
   - *As built (WP6, Kai):* the spans surround every input Kai sends through the desktop (the
     trusted press, `type_text`, `key_press`, `ui_press`), in every linked profile. A span ends
     `browser.input_settle_ms` after Kai's last input (a visible setting, default 1000 ms, for keys
     still on their way to Firefox), or at once after `gate.result@1`. Where a profile's span could
     not be opened, the moment is unbracketed: what the extension saw the user do there during it
     counts as Kai's until the user acts again (*taken in this draft*, §14). The trusted press
     takes the input turn first, opens the spans before the window comes to the front, opens the
     gate also with the guard off (every request allowed, so `key_seen` says where the key went),
     checks the cancel and the screen lock right before the key, and however it ends reads the
     gate and then ends the spans.

A second route is AT-SPI: Firefox's `doAction` on an accessible dispatches the click and calls
`NotifyUserGestureActivation` (Firefox source), so it counts as a gesture, and it needs no active
window. WP0 (d) confirmed the gesture on a Plasma desktop session (§3): the page saw `isTrusted` and an
active user activation, a `target=_blank` link and a `window.open` button opened a tab and a popup,
and the OK of a page's `alert()` was pressed. Firefox joins the bus when `IsEnabled` is on before it
starts; it turns accessibility on at runtime but never off until it restarts, and the cost was not
measurable on a small page (§3). *Not observed:* a file picker after a file input's `doAction`. *For
WP12:* a first read of an element's `NActions` can be 0 and 100 ms later 1 (WP0 (d2)), so a press that
finds no action should read once more before it gives up.

*As built (WP12):* the trusted press goes through accessibility first, the key's path where Kai
cannot find the element on the bus (Firefox not on it, the tab not in front, the element not
exposed). The element is found by a mark: `element.mark@1` sets a new 128-bit value in its
`aria-kai-mark`, which Firefox gives the bus as the object attribute `kai-mark` (an unknown `aria-`
attribute without its `aria-`; set and taken away within one 10 ms poll on a headless Firefox 159);
Kai searches the documents the link's Firefox shows with AT-SPI's Collection (frames of any origin
included), and `element.unmark@1` takes the mark away before the press. The press is taken only
when exactly one element carries the mark in a shown page and, where its document gives an
address, in the element's document. Then `gate.open@1` on the element's document (a kept gate
without a focus check), `doAction`, `gate.result@1` with `click_seen` (which element the trusted
click reached), all inside the input spans, decided as the key is (`key_press`'s state, or
`element_press`'s with the switch on), refused while the screen is locked. Kai reads an element's
`NActions` again after `accessibility.action_settle_ms` (100 ms) where the first read said none, and
reads and presses only in a window's shown pages (Firefox marks a background tab's page visible
too, only the page in front showing). Kai's design, WP24, has the drafts.

*As built (WP12's review round):* Kai searches only the page of the tab's own window (its page in
front the tab's, its selected tab the tab) and takes the element only where it fits the
extension's facts: `element.mark@1` answers the element's `role`, `name` and `frames` (the
addresses from the top page down to the element's document), the element's documents on the bus
must be those frames (an empty `DocURL` refused), each passes the site rules (`page_rule`) and is
none Kai never reads, and the bus's role and name fit the extension's. A mark on two elements is
the page copying it: refused as tampering, and not pressed with the key either. Right before the
press the tab's window is looked at again. The extension takes a mark away by itself after
`MARK_TTL_MS` (5000 ms, a constant of the contract, `docs/protocol/operations.md`), and each kept
gate of a document now gets its own `click_seen` element.

### 6.4 Acting as the user, and the risk

In hands mode Kai acts with the user's logins: their mail, bank and forge. Every page Kai reads is
text from a stranger, and a page can carry instructions aimed at the model. The most likely place
is not another tab but the one in front of the user: an e-mail, a comment, a review. The policy
keeps the common case quick and makes the risky steps visible. It does not make injection
impossible; the model reads the page, and the owner decides how much it may do unasked.

- **Per-tool states as everywhere in Kai** (kai K15): read-only tools are allowed for trusted
  callers, acting tools are confirmed, the code and file tools are confirmed by default. The owner
  sets any of them to `allow` (kai ruling 28).
- **The hands-and-eyes switch**, one setting in Kai's configuration ("Kai may act in Firefox without
  asking"), sets every state-changing tool of §5.2, §5.4 and §7.3 except `element_file` to
  `allow_trusted`, lets `element_press`'s state decide its trusted step (§6.3), turns
  lists the tools that exist only for hands and eyes (D3). It does not turn announcements on
  by itself: they follow `browser.announce` alone (§7.2). `allow_trusted` means trusted *callers*: the owner, the gateway (the
  dashboard's threads and lmgw's in-process agents), Kai's own voice, and whoever the owner put in
  `policy.trusted_callers`. The sidebar's turns are Kai's own (D7).
  - *As built (WP5):* the switch covers exactly §5.2, §5.4 and §7.3 minus `element_file`;
    `page_zoom`, `reader_view` (§5.5), `page_css` (§5.7) and the scripts (§5.8) stay confirmed.
- **The focus rule.** An acting tool follows its state on the user's tab only while that tab is
  one the user activated themselves (a tab Kai switched to or opened does not become the user's
  until the user clicks into it) and on the origin it had when the user last acted there. On any
  other tab or origin it is confirmed, unless `browser.act_in_background = true` (default off).
  *Why:* the user sees what happens in front of them; `tab_switch` or `tab_go` followed by an
  action is how an injected instruction would get somewhere else.
  - *Taken in this draft (WP5):* `tab_switch` and `tab_mute` change the tab, not the page. They are refused
    only on `none` sites, and the focus rule does not apply to them.
  - *Taken in this draft (WP5):* a counted approval in lmgw (an approver Kai trusts, `approval_counts`) is the focus rule's
    confirmation when the call names its tab.
    - *Taken in this draft (WP6):* a call that names a ref only is asked all the same, since its
      approver saw a number, not the tab; nor does an approval in lmgw cover the trusted press's
      real key (§6.3; §14).
  - Kai marks the tabs it opened, navigated or brought forward before it sends the operation, so
    they are not taken for the user's, and marks the tab Firefox shows after Kai closes the user's
    tab. With two profiles that each show a tab in front, or when the listing fails, the call is
    confirmed.
    - *As built (WP6):* the extension's tab facts come first (`activated_by`, `activated_at`,
      `user_origin`, `user_at`) and Kai's marks only where it saw nothing; Kai's own trusted
      input never counts as the user's (§6.3). With two profiles, the focused window decides the
      user's tab, the focus rule and where `tab_open` opens; a window focused during Kai's own
      input decides nothing.
    - *Taken in this draft (WP6):* the marks and input moments outlive a Kai restart, in
      `$XDG_STATE_HOME/kai/browser-moves`, with the last look's tabs each as a SHA-256 digest of
      its id and URL, so no URL is in the file; a site Kai navigated a tab away from is kept as
      its origin. A moment still open when Kai stopped ends when it is read back (§14).
  - *As built (WP6):* the commit guard exists, so `tab_open` and `tab_go` follow their state like
    the other acting tools; v5's interim confirmation is gone.
  - *Taken in this draft (WP10b, hands free; narrowed by its security review):* the rule anchors
    on the site where the user last clicked or typed in the tab, and a hands-free user never does.
    While the hands-and-eyes switch is on, these moves Kai makes in a turn the owner started count
    as the user's own act for the focus rule, and no others: a press of a link that loads another
    document by GET or of a submit control, an Enter that submits a form, `tab_go`, `tab_open`,
    `tab_back`, `tab_forward` (each a navigation, which moves the tab's site to where it went),
    `tab_switch` and the tab Firefox shows after Kai closed the user's (each the user's
    activation; these two go beyond the proposal: a hands-free user switches and closes tabs
    through Kai too). A navigation counts only where the tab landed on the origin it was meant for:
    the link's `href`, the form's action, `tab_go`'s or `tab_open`'s URL, the engine a search
    began at, the history entry back or forward went to (the extension's new fact `goes`, the
    contract's Acting and Navigation). A redirect to another origin, a navigation the page makes
    itself (on a scroll, an input, a hover, a key, a timer, a meta refresh) and a window the page
    opens under Kai's press are Kai's navigation, asked about as for any caller. "The owner
    started" means a call of Kai's own device (Kai's voice session or typed turn, or the sidebar's
    turn), never another principal's turn, lmgw's own runs, a routine, a page's event, nor Kai's
    voice speaking a finished job's result (its continuation's calls are Kai's own, but answer tool
    output: Kai's design WP24). The owner's act stands until the user acts there by hand; Kai's
    later moves for anyone else end it, its site included. Kai keeps it beside its own marks, and
    it counts only while the switch is on: switched off, the rule is as it was without it, also
    for what was marked while it was on. **The risks:** with the switch on, text on a page can
    steer Kai to another site through a link it presses or a URL the model writes, where Kai then
    acts without asking; the commit guard and the network gate still ask before a write and before
    a GET to a site the user never visited. In conversation mode the microphone hears what Firefox
    plays unless echo cancellation removes it, so a page's audio can become a turn of the owner's
    (Kai's design WP24).
  - *As built (WP10b, the rule as written; its review's L1):* WP10's probe found that a link Kai
    pressed to another site left Kai acting there unasked when the user had never acted in the
    tab: such a tab had no site of the user's, so any site counted. Every acting operation is now
    Kai's navigation like `tab_go`'s, marked before it is sent and landed once it answered or
    failed, so the tab keeps the site it had before and acting on a new one is asked: a press
    that left its page, a navigation that commits after the guard's window (with the guard off:
    no window), a call cancelled or timed out, and the trusted press around its real key (unless
    the switch and the owner's turn make it the owner's act, above).
- **Site rules.** Per site (origin pattern): `act` (the default), `read` (acting tools refused) or
  `none` (no tool reaches it, reads and announcements included). Kept in Kai's configuration and
  offered in the sidebar's site strip (§8.1).
  - *As built (WP5):* three lists in Kai's configuration, `[browser.sites] act`, `read` and `none`.
    The most specific pattern wins, the strictest among equals.
  - Tabs on `none` sites are left out of `tab_list` (a count line says how many) and are never
    matched by title or URL.
  - Site rules apply to `blob:`, `view-source:` and Reader URLs by the page's real site, and
    trailing dots in a host are ignored.
  - *Taken in this draft:* a frame's own origin decides its rule (§14). A `none` site framed inside
    an `act` page is not read ("(a frame of a site Kai does not reach)"), its find matches are
    dropped without a marker, and refs inside it are refused. An opaque origin or an empty URL gets
    the strictest rule configured.
    - *As built (WP7 review):* its part of a screenshot is blanked by Kai from the frame boxes the
      extension lists, its address stays out of the parent's `page_dom` text (origin only), and a
      download whose `url`, `final_url` or `referrer` is such a site is left out.
    - *As built (WP7 second review):* a screenshot's frame that changed origin during the capture
      is blanked when either origin is such a site (`origin_before`), and Kai takes such a
      frame's address out of `page_source`'s text by the `frames` list.
    - *As built (WP9 review):* a `download_done` announcement is dropped when its `url`,
      `final_url`, `referrer` or `source` (the tab and the document it came from) is such a site;
      one with neither `source` nor `referrer` names no page and gets the strictest rule
      configured, as an opaque origin does.
  - *Taken in this draft:* the view tools `element_point`, `element_show`, `hints_show` and
    `hints_hide` change only the view. They are allowed on `read` sites, outside the focus rule,
    and refused on `none` sites (§14).
  - *As built (WP7b):* Kai's desktop tools (`see_window`, `see_screen`, `read_window`,
    `read_selection`, `ui_press`, `type_text`, `key_press`) apply the site rules to Firefox's
    windows by the tab each shows in front (§6.7).
- **The commit guard**, on by default (`browser.commit_guard`), asks before:
  - a press or submit whose target's name, form action or button type matches the guard's word
    list (a visible setting; default: buy, order, pay, checkout, purchase, subscribe, delete,
    remove, send, transfer, confirm, in English and German);
    - *As built (WP6):* the German entries are stems (kauf, bestell, bezahl, zahlung, zahlen,
      kasse, abo, lösch, entfern, überweis, bestätig); a word of four or more letters matches
      inside words, after NFKC and without soft hyphens; the accessible name, the shown text, a
      button's value and its title are read; an Enter in an editor (a chat box's "send") asks too.
      The guard looks again right before the click, and a confirmation covers the verdicts the user
      saw, not a button the page renamed meanwhile. Kai asks all of a call's verdicts in one
      dialog, each in words, and a second look that stops a press after its pointer events went
      is asked again with what went and the requests held meanwhile. Letters of other scripts that
      look alike (a Cyrillic "о" in "оrder") are not matched yet (§13);
    - *Taken in this draft (WP10b, narrowed by its security review):* the words apply to what
      commits (a form's submit button, a button, an element that submits, an element acting
      through the page's script), not to a plain link (`a` or `area` with an `href`) whose
      activation loads another document by GET: "Open the lamp" that only opens its page commits
      nothing, and the network gate covers what the next page sends. A link keeps the words where
      it may commit by script as far as the extension can see: its `href`'s path or query holds a
      guard word (`/item/5/delete`, "Order now" to `/order.html`); it carries a script marker
      (`onclick`, `data-method`, `data-turbo-method`, `data-remote`, any `hx-*` attribute,
      `phx-click`, `ng-click`, `@click`, `v-on:click`); or a press handler the page set as a
      property (`onclick` and the pointer and mouse press events) is on it or an ancestor up to
      the document. A link to a fragment of the page (`href="#"`) or a `javascript:` URL counts
      as before. **The risk:** Firefox gives a content script no way to list the listeners
      `addEventListener` added, so a link whose own or delegated listener cancels the navigation
      and commits by script (a "Cancel" whose handler sends a beacon), with no word in its URL and
      no marker, is not asked about by its word; nor is a plain link that commits by a same-site
      GET. Seeing such listeners would mean wrapping the page's `addEventListener`, which changes
      what every page sees (not done yet). It is decided in the extension, where the verdicts are
      made (`content/act.js`), with no new fact for Kai;
  - a form submit (any method) to another origin than the page's;
  - a navigation by `tab_go` or `tab_open` to an origin the user's history has never seen
    (`history.getVisits`), because a URL the model wrote can carry data out as a GET;
    - *As built (WP6):* visits Kai caused do not count (`history.seen`'s `seen_by_user`), and a
      `GET` navigation an acting tool causes to such an origin is held by the network gate. A
      search is not asked about (it goes to the user's own engine), and a counted approval in lmgw
      spares this question, as its approver saw the URL; `page_css`'s question about the sites its
      sheet fetches from is not spared (§5.7);
  - any `POST`, `PUT`, `PATCH` or `DELETE` the acted-on document sends within
    `browser.guard_window_ms` (a visible setting, default 2000 ms) after an acting tool ran, matched
    by tab and `documentId` (`webRequest.onBeforeRequest`, blocking), showing method, URL and the
    decoded body.
  - *Taken in this draft (WP10b), as a trade-off against noise:* requests of type `beacon`
    (`navigator.sendBeacon`) and `ping` (a link's `ping` attribute) are never held. WP10 found them
    all of the gate's noise but one site's XHR (`tests/accept/RESULTS.md` §2: 15 questions after
    42 actions before, 2 after): mostly the pages' telemetry. **The cost:** a write a page makes
    by beacon because of Kai's action is not asked about. A link that cancels its navigation and
    commits by beacon ("Cancel order") is asked about by its words only where the extension sees
    that it acts by script (the narrowed words above); one that does not show it goes unasked. A
    `fetch` with `keepalive` to another site without credentials stays held: Firefox's webRequest
    reports it as `xmlhttprequest` without saying it is keepalive, and whether it carries cookies
    is known only after it was held, so it cannot be told from any other cross-site fetch.

  The question is Kai's confirmation (kai K15's dialog), sent as an `ask` frame. With nobody at the
  desk it waits for the call's deadline, then the request is cancelled and the page sees a network
  error. The acting tool returns after the guard window, with what happened ("pressed; a POST to
  shop.example/cart was allowed by the owner"). The owner can switch the guard off (kai ruling 28).
  **What it does not see:** requests from workers (service, shared and dedicated), WebSocket,
  WebRTC and WebTransport traffic, `GET` requests a page sends by script, and writes after the
  window. The page's
  own analytics by fetch or XHR and autosave writes inside the window do get asked about; WP10
  measured how often on real sites (above).
- *Taken in this draft (WP10b, and its security review):* **Kai's own questions by voice.** The
  focus rule's question, `element_file`'s, the commit guard's verdicts, the network gate's question
  and the trusted press's real key are Kai's own dialog, which a hands-free user could not answer.
  For a call of Kai's own (its voice session, its typed turn, the sidebar) Kai also speaks the
  question, Kai's words first and the page's text last as §7.2 frames it ("May Kai press the link?
  Kai opened this tab. Yes or no? The page calls the link: Order now"; a file's name, which a page
  may have chosen for a download, comes after the field's, as the file's), and takes a spoken yes
  or no the way it takes one for lmgw's approval card (kai K17): the talk key once the question
  was spoken, speech required, transcribed in Kai's thread, matched whole; a barge-in or a press is
  never a yes. One question is spoken at a time, the next once the one before is over; a press
  answers what became answerable last (the card's arming, a question's speech ending), and a
  card's call not armed yet holds back no question. The answer starts at the press with no
  pre-roll, the press stops Kai's own speech, and what the microphone hears while Kai speaks and
  for its echo's guard after (`browser.speech_echo_guard_ms`) is silence in the answer, so the
  end of Kai's own question, or page text Kai read out, is never the answer; the approval card's
  spoken answer has the same rule. The dialog stays; the first answer decides. Not yet: an answer
  without the talk key in conversation mode (the approval card has none either), and muting
  Firefox's tabs while a question waits (a page's audio is in the answer unless echo cancellation
  removes it). Kai's design records it under its WP24.
- **The sandbox container.** `tab_open {sandbox: true}` opens a tab in a "Kai" container
  (`contextualIdentities`, which needs the `cookies` permission too) without the user's cookies, for
  browsing Kai does on its own. Creating it switches on Firefox's container feature. The container
  separates cookies and storage only: history is shared, and Firefox's password manager still
  offers the user's saved logins there.
- **Where page text goes.** Page text reaches the model as tool results, or as an attachment the
  user added with "Attach this page" (§8.1), which carries a header naming the page as its source.
  It is never system text.

### 6.5 Speed

"Scroll down" by voice runs a model turn in conversation mode: speech to text, the model, one tool
call. The tools are deterministic and do no model work; the turn's time is the model's. A path that
maps simple commands ("press 14", "scroll down", "go back") to tool calls without a model would be
Kai's, not the extension's (§13).

### 6.6 Supported, therefore tested

Two acceptance runs on the fixture site (§11), both through Kai's real tool path with a scripted or
real model:
- **Eyes:** find a product, read its description and price, read a comparison table, hear the error
  a form shows and the dialog that opens, without any screenshot reaching the tester: only Kai's
  spoken or written answers.
- **Hands:** search, open the third result, fill a form with a controlled input, a combobox and a
  rich editor, set a slider, choose an option, check a box, attach a file, submit through the
  commit guard, close a cookie banner in a cross-origin frame, without a mouse or keyboard event
  from the tester.

### 6.7 The site rules in Kai's desktop tools (as built, WP7b)

Kai's desktop tools see and act in Firefox's windows without the extension. WP7's review found
that they bypassed the site rules, so WP7b (Kai `365b3d5` to `0db5c8e`; kai's Later entry "Kai's
browser site rules in the desktop's tools") applies the rules to them, by the tab each Firefox
window shows in front. With no rule that could refuse a tool, nothing is checked or listed.

**How a window is judged** (Kai's `src/browser/shown.rs`):
- A window is a linked Firefox's when its process is that Firefox's main process (the link's
  `firefox_pid`, the native host's parent, §6.3). Kai takes all of that process's windows in one
  look and matches each to the tab in front of an extension window by its title ("<title> — ");
  a tab whose title fits two windows decides for neither.
- A window whose page Kai cannot tell gets the strictest rule configured: no linked Firefox owns
  it; its title fits no tab in front (Private Browsing in any language, Firefox's own windows, a
  title KWin changed or cut); the tab in front fits two windows; the page has no site (an
  allow-list since WP12's review round: only an `http:`, `https:` or `file:` page with a host has
  one, so `about:`, `data:`, a host-less `file:`, an opaque `blob:`, `chrome:` and another
  extension's `moz-extension:` have none; an `about:blank` keeps no opener's rule, since the
  listing does not name the opener); or, for a capture, the tab is still loading or came to the front
  within `browser.see_settle_ms` (a visible setting, default 500 ms), since the window's pixels
  can still show the page before.
- Inside a window, AT-SPI names each document with the address it shows (`DocURL`), so a read or
  a press is judged by the pages and frames it actually reached; Firefox gives none for a `data:` or
  a `blob:` document (below), which then count as a page without a host. Firefox's window on the
  accessibility bus is taken by its exact name.

**What each tool does:**
- `see_window`, `read_window`, `read_selection`: refuse a window on a `none` site, before they
  capture or read and again after, with the window as the desktop names it then. While a site is
  `none`, `see_window` refuses a Firefox window that is minimized or only on another desktop.
  `read_window` and `read_selection` leave out the pages and frames Kai may not read, each
  replaced by one line, and say how many.
- `see_screen`: blanks grey every Firefox window on a `none` site (or untold, while a site is
  `none`) by its frame as KWin places it, read before and after the capture, whatever lies over it
  included. It refuses while KWin runs an effect not known to keep windows on their frames
  (`activeEffects`, before and after), and when the windows' places, the output or such a
  window's frame are not known.
- `ui_press`, `type_text`, `key_press`: refuse a window on a `read` or `none` site, before the
  dialog and after it, and for the keys again once the focus is back and whenever the window's
  title changes between two keys. Before every chord, and before the first character and after
  each Tab or line break, the frame with the keyboard focus is checked by its own origin
  (`context.get@1`); a frame, page or focus Kai cannot tell refuses. `ui_press` presses only
  inside a page whose page and frame Kai may act on, never Firefox's own controls under the
  rules.
- `key_press` under the rules refuses Firefox's tab, address, history and panel chords (Ctrl+Tab,
  Ctrl+Page Up/Down, Alt or Ctrl with a digit, Ctrl+L, Alt+D, F6, Ctrl+T/N/W, Alt+Left …), naming
  `tab_switch`, `tab_go`, `tab_open` or `tab_back`; while a site is `none` also the desktop's
  window shortcuts (any Meta chord, Alt+Tab, Ctrl+Alt with an arrow, Print …).
- Answers name such a window by its id, never by its title, and an answer about a Firefox window
  that was let through says what the check does not cover. `look` and `find` call the same tools.
  The browser's trusted press keeps its own checks (§6.3).

**Not covered yet** (kai's Later entry; §13):
- a keyboard focus already in Firefox's own controls (the address bar, the search bar, the
  sidebar): `context.get@1` does not tell it from the page's body, so keys there are judged by the
  page's rule, and an address typed there loads without `tab_go`'s rules;
- shortcuts the owner rebound, in Firefox or KWin (kglobalaccel is not read yet);
- the compositor's thumbnails (the task switcher's, the task bar's), and an effect that starts and
  ends between `see_screen`'s two looks;
- a Firefox window on another activity or covered whole, captured as the compositor has it;
- in a capture, everything besides the tab in front: a second tab of a split view, web panels and
  the sidebars, docked DevTools, other tabs' titles in the tab strip, and a `none` frame inside an
  `act` page (`page_see` blanks such frames, §5.3);
- a `none` site's desktop notifications (plasmashell draws them), its MPRIS metadata and
  `media_play_pause` on its media;
- Firefox's window titles in `window_list`, `desktop_context` and the delegates' window list; the
  window tools; Firefox's popups; `clipboard_get`; `open`, `app_launch` and `run_command` with such
  a URL.

**The risk, checked (WP0 (d2), 2026-11-03):** the `DocURL` path was first tested only against a fake
accessibility bus (Kai's `src/desktop/tests/read.rs`). A headless Firefox 159 on a private AT-SPI bus
(`spikes/ext/atspi-selftest.sh --docurl`, `spikes/ext/RESULTS.md` (d2)) answers it with the document's own
address for pages and for frames of every origin relation and depth (same-origin, same-site,
cross-site, sandboxed, nested, navigated, and the top page after `history.pushState`), for
`about:blank`, `about:srcdoc`, `about:robots` and `about:newtab`, for `file:`, for `view-source:<address>`
and Reader view (`about:reader?url=…`), and with the address that failed for an error page. Every
frame's document lies below the top document in the tree, by either route Kai takes (the descent from the
window, `Parent` up from an element), and `documents_of` returns the right chain, outermost first. A
frame's address and content change together (polled every 10 ms: the old page, no document for 11 to
31 ms, the new page). It answers the **empty string for `data:` and `blob:` documents**, frames or top
level, with no `DocURL` among their attributes, so Kai cannot rely on a non-empty address for every frame
document. By Kai's code (`SiteRules::page_rule`) an empty answer counts as a page without a host and gets
the strictest rule, so those pages stay on the closed side; but Kai's unwrapping of a `blob:` address to its
origin has no `blob:` address to work on, and a page's own `blob:` frame is refused like any hostless page
while a `none` rule exists. If a call fails, Kai cannot tell it from a `data:` page. `about:blank` and
`about:srcdoc` say nothing of the page that embeds them, as this section already assumes. Not the same as
what is on screen: the documents of background tabs and the preloaded New Tab page carry the `visible`
state (only the page in front carries `showing`), so a walk through VISIBLE elements reaches them, each
judged by its own address. Not tested: a windowed Firefox's frames.

*Taken in this draft (WP7b):* the window judged by its tab in front with the strictest rule for an
untold one, the settling time, the chords refused and the capture refused during effects (§14).

## 7. Events, announcements and reading aloud

### 7.1 Events

Content scripts and the background report `event` frames to Kai, for the user's tab:
- `loaded` (the document finished loading: its title);
- `navigated` (the URL changed, same-document navigations included);
- `dialog` (a modal dialog opened or closed: its name);
- `tab_opened` (a page opened a tab or window);
- `live` (an `aria-live` region or a `role=alert|status` element changed: its text, and what it is
  about: its name, an `<output>`'s controls' names, or its labelled ancestor's name);
- `field_error` (a field turned `aria-invalid`, or an error text appeared beside it: field name and
  text);
- `download_done` (file name);
- `focus` (the focus moved within the page: role and name), only while announcements are on.

Sites with announcements off by a site rule (`none`) send none.

One more kind is not about the user's tab or a page: `read_ended` (a reading session ended other
than by Kai's own `read.open@1` or `read.close@1`, §7.4; `by_kai` says whether Kai's navigation or
tab close ended it). It comes in any tab and whether or not events are on.

### 7.2 Announcements

- Off by default; `browser.announce = true` in Kai's configuration turns them on. They follow that
  setting alone (Kai `578a2c8`): the hands-and-eyes switch does not turn them on in the engine.
  Kai's settings window writes `browser.announce` on, visibly, when the owner turns hands and eyes
  on from off, and the owner can turn it off again.
- Kai speaks them itself through lmgw's TTS, with no model turn and nothing written into a thread,
  so they cost no context. Page-controlled text is always introduced as the page's: "A page has
  loaded; its title says: Checkout", "The page says: your session expires in 2 minutes", "The
  page says, at the field “E-mail”: invalid address". Kai never speaks page text as its own
  sentence, names included: a name the page controls is quoted inside the framing, or Kai says
  the role instead ("Error at a text field, the page says: …").
- A region that changes in quick succession (a ticker, a countdown) is spoken once it has been
  quiet for `browser.announce_quiet_ms` (a visible setting, default 1000 ms), its latest text only
  (a log or another non-atomic region: what was added meanwhile, §7.4).
- They queue behind Kai's own speech and never interrupt it. They are spoken while Kai is active on
  the desktop (not on a locked screen, kai K32) and while Firefox has the focused window or
  conversation mode is on. *As built (WP9):* the full set of gates is in §7.5.
- A model turn sees them only through `browser_context` (§5.1).

### 7.3 Reading aloud

- `read_aloud {tab?}`: from the focused element, else from the top of the view.
- `read_aloud_from {ref}`: from that element.
- Kai reads the page through the earlier extension's speech clean-up rules (citations, markdown, URLs, emoji;
  superscripts kept), a paragraph at a time, in the voice Kai has for the paragraph's language
  (`lang`), falling back to Kai's voice. The paragraph being read is highlighted and scrolled into
  view. *As built (WP9):* the speech is made one TTS request per sentence (§7.5).
- `read_pause {}`, `read_resume {}`, `read_skip {by}` (`by` is a signed number of paragraphs).
- The page side (the paragraphs, the mark, the scrolling) is the extension's; the read position and
  the speech are Kai's (§7.4, §7.5). The user talking (barge-in) pauses the reading (kai §5.5).

### 7.4 As built (WP9, the extension's half)

The wire is `docs/protocol/operations.md` (Events, Reading aloud); Kai's half (speaking, the
queue, the tools) is §7.5.

- **Events** are off until Kai sends `events.config@1 {on, quiet_ms}`, and a new link starts with
  them off; while off nothing is watched and nothing is sent. Only the user's tab (D9) is watched,
  and its frames; when the user's tab changes, the watching moves with it. Every event of a tab
  carries the tab's id, title and URL, the frame and its document's origin, so Kai drops what a
  `none` site or frame says (§6.4); every event carries `focused` (a window of this Firefox has
  the keyboard focus) for §7.2's rule.
- *Taken in this draft (WP9, §14):*
  - Kai turns events on while announcements are on (`browser.announce` alone, Kai `578a2c8`), so
    `browser_context` lists announcements only then.
  - A document's changes are watched once it is parsed: what a page does while it loads says
    nothing, as screen readers stay quiet then. A page restored from the back-forward cache asks
    again whether to watch.
  - A live region follows ARIA: an atomic one (`aria-atomic`, `alert`, `status`) says its whole
    text, another (a `log`, a plain `aria-live`) what was added or changed in it during the quiet
    period; a region the page inserts with its text says nothing, except an `alert`; an element
    that becomes a region by `aria-live` or its role is one from then on. `aria-relevant`'s
    additions and text are honoured, its removals only for atomic regions (what a non-atomic
    region loses is not reported yet); `aria-busy` holds a region's changes until it is gone;
    `aria-hidden` content says nothing.
  - A change of attributes alone (a hidden status shown) says what is shown that was not before:
    an atomic region its whole text when it differs, another the new lines of its text, so a log
    entry the page re-styles is not said again. Attribute changes do not put off a wait under way,
    so a page that animates by classes cannot hold a region back.
  - *Taken in this draft (WP10b):* a live event names its region (`name`, `name_from`): its
    accessible name; for an `<output>` without one, the names of the controls its `for` lists;
    else the nearest ancestor its author labelled, a `fieldset` with its `legend` or a `figure`
    with its caption. A slider's output said "The page says: 3"; Kai now says "The page says, at
    “Tip for the courier”: 3".
  - A field's error is the text its `aria-errormessage` names, else the browser's validation
    message; the text its `aria-describedby` names comes as `description`, where many sites put
    their error. An error element that is itself a live region comes twice (`live` and
    `field_error`); `field_error` names the region (`regions`) and Kai speaks the pair once.
  - `download_done` is reported for every download outside private windows. Firefox's downloads
    API names no tab, so the extension attributes a download to the watched tab when it saw that
    tab's navigation become it (`source`), through a blocking `webRequest.onBeforeRequest`
    listener on navigations while events are on, which costs every navigation one round trip to
    the background; a non-blocking one hears of the request after Firefox created the download,
    even after a small one finished (measured with Firefox 159). A download with neither `source`
    nor `referrer` gets the strictest site rule configured (§6.4). `tab_opened` includes the
    user's own middle click on a link (Firefox does not tell it from `window.open`).
  - Floods coalesce, nothing is capped: each document has one batch on its way to the background
    at a time, a newer `focus` replaces one still waiting, a dialog that opened and closed while
    its batch waited says nothing, and the regions and fields whose quiet periods end together
    settle in one timer tick and go in one batch. Firefox fires no focus events while its window
    lacks the keyboard focus, so a focus moved then says nothing.
  - Order: the background stamps `at` when it learns of an event and sends the events through one
    chain; `seq` numbers the event frames of a link, so `navigated` always precedes its `loaded`.
    A same-document navigation that keeps the URL (a `replaceState` of the same URL) says nothing.
  - `by_kai` marks what Kai caused: changes while an acting operation on the tab ran (until it
    answered, so within the commit guard's window) or an input span was open, and Kai's own
    navigations. The watched tab's frames are told when Kai begins and ends acting there.
  - Masking covers every text and name of an event, also a value with its white space collapsed
    or broken differently; a field that was sensitive stays so for the document's life ("show
    password").
  - A modal dialog is open when shown (`checkVisibility` with `visibilityProperty`) and not
    hidden by `aria-hidden` around it (a11y-dialog), its role read as everywhere (the first role
    token Kai knows), in shadow roots too.
  - Elements the page dropped and the garbage collector took leave the content script's element
    table and the background's ref table of their document; their refs answer `stale_element`.
- **Reading aloud:** `read.open@1` answers the page's paragraphs (`page_text_all`'s blocks, frames
  spliced in) and where to start, `read.paragraph@1` one paragraph as text and as `spoken`
  (through the earlier extension's clean-up rules, lifted into `extension/background/speech.js` with their
  defaults; Kai passes its setting as `rules`) with its `lang`, ref, frame and origin,
  `read.mark@1` draws the reading mark (Kai's accent, out of the page's reach like the hint labels)
  and scrolls the paragraph into view, also through frames, and `read.close@1` ends the session.
  Kai keeps the index: pause, resume and skip are Kai's.
- *Taken in this draft (WP9, §14):*
  - The paragraphs are the page's text when `read.open@1` ran. A session ends when its tab shows
    another document, goes to another path by a same-document navigation (a query or fragment of
    its own keeps it), closes, or gets another session; a frame that navigates keeps the session,
    and its paragraphs can no longer be marked (`marked: false`).
  - One session per tab. `read.open@1` without a ref starts at the focused element's paragraph,
    else the first in view, else the first below the view, else the first of the page.
  - A paragraph that fits in the view is centred when marked; a taller one comes with its top at
    the top. Scrolling is instant whatever `scroll-behavior` the page sets, and the mark is placed
    again at each frame the page draws, so a reflow or transform that moves the paragraph moves
    the mark too.
  - A paragraph's `lang` is that of its element, not of an inline part it begins with; `start` is
    never a paragraph before the element of `ref` or the focus (the view decides when there is
    none after it), and `from` is `null` for a page without paragraphs. Page text that repeats a
    sensitive value is masked as events mask it.
- *Taken in this draft (reading's end, §14):* a session that ends other than by Kai's own
  `read.open@1` (replacing) or `read.close@1` is a `read_ended` event `{session, tab, why, by_kai}`
  when the extension learns of it, so the reading stops at once and not at the next call:
  - `why` is one word set for the event, `session_ended` and `read.close@1`'s answer: `navigated`,
    `tab_closed`, `discarded` (Firefox unloaded the tab), `page_changed` (the tab's top document
    is not the one read and no navigation was seen), `replaced` and `closed` (the last two never
    an event). `session_ended` always carried `why` (and `tab`); `discarded` and `page_changed`
    are new. A tab's end is `tab_closed`, not `closed`, which stays `read.close@1`'s.
  - It goes while events are off: reading aloud is its own feature. It carries the tab's id and
    nothing of its page (the tab may show another site now), so Kai's site rules do not judge it.
    It goes through the event chain (`at`, `seq`, after the `navigated` of the same navigation),
    not through a document's batch.
  - `by_kai` is true when Kai's navigation or `tabs.close@1` ended the session, so Kai can tell
    its own doing from the user's.
  - `read.mark@1` for a paragraph the page took away (its text nodes left the document) or whose
    frame is gone answers `marked: false` with `why` `removed` or `frame_left` instead of an error.
- *Taken in this draft (WP9 review, §14):* the speech clean-up rules on page paragraphs differ from
  the earlier extension's in three places: the markdown rule's list numbers are off (DOM text has no markdown
  numbers; "3. Oktober" and "1. FC Köln" stay), the symbols rule keeps `§`, and the hyphen join
  takes letters of any script (`\p{L}`). Its defaults stay for other uses of `speech.js`.

### 7.5 As built (WP9, Kai's half)

Kai `4f7f2e8` to `98f8891`: `src/voice/speak.rs` (the speech), `src/browser/announce.rs` and
`announce/words.rs` (the announcements), `src/browser/tools/aloud.rs` (reading aloud). Kai's
design records the draft calls under its WP24.

- **Direct speech.** Kai makes the speech with lmgw's `POST /v1/audio/speech` (WAV, which Kai turns
  into 24 kHz mono) and plays it on its own playback stream, with no model turn and nothing
  written into a thread. One request per sentence, the next made while one plays;
  `browser.speech_timeout_s` (default 60 s) bounds each sentence. The voice is Kai's own (its
  conversation thread's resolved TTS alias, voice, speech style and seed, read once per run of
  speech, so a voice changed on the dashboard is heard from the next run) or, for a paragraph,
  the one `browser.read.voices` names for its `lang` (entries such as `"de tts-german"` or
  `"fr kokoro ff_siwis"`). The play order is Kai's notices and assertive announcements, then the
  other announcements, then the paragraph read.
- **Kai's words.** One sentence per event: Kai's words first and the page's text last, so nothing
  a page controls comes out as Kai's own sentence ("A page has loaded; its title says: …", "The
  page says, at the field “E-mail”: invalid address"). A role is said in Kai's words, an unknown
  one as "element"; a tab the page opened is said by its site, as the page's. Page text past
  `browser.announce_max_chars` (default 600; 0: all) is spoken to the last word that fits, and Kai
  says before it how much it left out; `browser_context` has it whole. A `navigated` is not spoken
  (its `loaded` follows). What Kai's own acting tool caused (`by_kai`) is not spoken where the
  tool's answer says it already (a page loaded, a focus, a tab opened); a dialog, an error, a
  region or a download it caused is spoken after "After Kai's action:".
- **Which events are spoken.** Kai takes one event per frame in its link's `seq` order and drops,
  and logs, one whose `seq` is not above its link's last. A newer `focus` replaces the waiting
  one, an atomic region's change the waiting one of that region; a non-atomic region's changes
  each wait their turn. A `field_error` and a `live` change of a region it names (`regions`),
  whose text is part of the error, are spoken once, in either order, when they come within
  `browser.announce_quiet_ms` of each other by `at`. An event whose tab URL or document origin is
  a `none` site is dropped, as is a `tab_opened` to one and a `download_done` whose `url`,
  `final_url`, `referrer` or `source` is one (an opaque origin under the strictest rule, a
  download with neither `source` nor `referrer` too); nothing of it is logged.
- **The queue's gates.** The speech is made and played only at the quiet moment Kai's jobs wait
  for: the screen unlocked, not muted, the feed up, no talk key held, no approval waiting, no
  other client's turn in Kai's conversation (kai K16), the session quiet or none on its way; with
  PipeWire up and do not disturb off; and only after `browser.speech_quiet_ms` (default 1500 ms)
  of all that, a hold-off, so a short pause between a turn's tool rounds starts nothing the next
  reply would cut. Nothing is made before; what waits is told why. When an announcement is made,
  and again when it plays, it is dropped if announcements were switched off, its site became
  `none`, it is older than `browser.announce_max_age_s` (default 60 s), or its Firefox does not
  have the focused window (by its link's newest event) while conversation mode is off. The screen
  lock cuts what plays and drops every announcement waiting or arriving. Kai's own reply
  (`response.created`) takes the playback back, and what it stopped waits whole and plays again
  after it. A notice that cannot be spoken (its speech failed, PipeWire down, do not disturb)
  becomes a desktop notification; a failed announcement is logged once per message and counted.
- **The microphone's echo.** lmgw does not know this speech, so in continuous listening the
  microphone can carry it back. In half duplex the session hears silence while it plays. In full
  duplex a `speech_started` while it plays, or within `browser.speech_echo_guard_ms` (default
  500 ms) after it stopped, cuts it and is spent on the cut, as a talk press over a reply is
  (kai K6): Kai sends `input_audio_buffer.clear`, and the session hears silence for that guard
  after every stop (its end, a cut, Kai's reply), so only what the owner says after the guard
  forms a turn.
- **The request** carries no `language` (a `browser.read.voices` entry names a voice for its
  language instead), and the thread's `seed` only where its TTS alias is served on this machine
  and every fallback it names is too. lmgw does not yet tell a client which rows take a language
  or a seed (§13).
- **Reading aloud.** Kai holds the index and one reading at a time; a new one ends the last once
  its `read.open@1` succeeded. Kai sends `[browser.read]`'s clean-up rules (superscripts off, so
  they are kept), skips a paragraph whose `spoken` is empty or whose own or tab's site is `none`,
  hands the next paragraph to the speech while one plays, and calls `read.mark@1` as a paragraph's
  audio begins; `marked: false` reads on, unmarked. A paragraph's site rules are checked again as
  it plays; one that became `none` ends the reading. Pause stops the audio at once; resume reads
  the paragraph it stopped in again from its start; skip moves `by` paragraphs from the one read
  now and reads on, also from a pause. A barge-in, a talk press or the screen lock pause it until
  `read_resume`; Kai's own reply only holds it. `read_ended`, a later `session_ended` and Firefox
  closing stop it at once with one spoken notice ("Reading stopped: the page changed."), none when
  `by_kai`; the last paragraph ends it silently.
- `browser.speech_timeout_s`, `speech_quiet_ms` and `speech_echo_guard_ms` take effect at Kai's
  next start; the `announce_*` settings at once.
- *Taken in this draft (WP9, Kai's half; Kai's design WP24; §14):*
  - the microphone's echo rule above, chosen over gating the microphone while the speech plays,
    since a barge-in by voice matters most to the accessibility use this serves; the cost is that
    words begun while it plays are spent, as a press is;
  - Kai's words in its reply language where that is German, else English; page text as it is;
  - the request's `language` and `seed` as above;
  - the shared quiet moment with `browser.speech_quiet_ms`;
  - `browser.announce_max_age_s`, checked when made and when played;
  - reading aloud's failures: a paragraph lmgw refuses (a 4xx) is skipped with one spoken notice
    and a second refusal in a row pauses; any other failure pauses with one notice
    ("Reading paused: speech failed."); a resumed paragraph that fails again is skipped with a
    notice, so a resume never meets the same failure twice.

## 8. The sidebar

### 8.1 What it is

The sidebar is lmgw's Chat in a narrow column: folders, threads, search, messages with tools,
approvals, attachments and media, and the composer. Its threads are the user's threads; a thread
started here continues on the phone or the dashboard. The Kai conversation is one of them, so the
user can type to Kai beside a page and talk to it a moment later.

**What a device sees.** The sidebar is Kai (D7), and lmgw shows a device less than the owner's
dashboard (api L3, L4), which is enough for the browser (decision 10):
- Admin Chat and folders a device deleted are hidden;
- threads with the self-admin toolset appear at Kai's admin level;
- Kai's alias scope decides the models it may pick;
- writing a folder's retention is refused;
- knowledge bases need `kb__search` in Kai's tool scope.
  - *As built (lmgw WP2):* a file's text in the Chat's citation viewer needs `kb__read` too,
    switched on by the owner; a device gets the text only and no download of the original yet
    (lmgw's chat-plane D8 and D14; a grant for originals would be the owner's decision).

What the sidebar adds for the page beside it:
- **Attach this page:** a composer action that attaches the page's readable text (as `page_text`
  reads it) as a text attachment headed "Page: <title> (<URL>)". It works in any thread, with or
  without Kai's tools.
- **Kai's tools in the thread:** a thread whose tools include Kai's label reaches the browser tools
  as Kai's own (api §5.6: the device that hosts a label reaches it).
- **The site strip:** one line at the top: the site, its rule (act, read, none) and a switch for
  hints. Not a mode toggle per message: rules live per site.
- **Approvals for browser calls** show inline in the thread (lmgw's approval rows); while one waits
  for a call that acts on the page beside the sidebar, the element is highlighted on the page.

The sidebar opens only on a user action (`sidebarAction.open` requires one), so Kai cannot open it
by voice. A toolbar button and a shortcut open it; the default shortcut is chosen in WP4 against
Firefox's and Plasma's own (`Ctrl+Shift+K` is the Web Console), and the user changes it in Firefox's
extension shortcuts.

*As built (WP8b, `sidebar/`, `extension/background/sidebar.js`; the wire of the page's own calls is
`docs/protocol/operations.md`, "The page's own calls"):*
- **The site strip** is one line above the Chat about the sidebar window's active tab, following
  tab switches, navigations and title changes: the site (its host), its rule as a chip (`act`,
  `read`, `none`; "no site" for Firefox's own pages and extensions' pages), a Hints switch and the
  "Page" button (Attach this page). The rule is Kai's: the background asks Kai with a `site` frame,
  which Kai answers from the rules its tools apply to a frame (Kai `src/browser/sidebar/site.rs`,
  `SiteRules::frame_rule`: `""` and `"null"` alike get the strictest rule), read again for each
  question, so a change in Kai's settings shows at the next tab change. The strip cannot change a
  rule yet; Kai's settings do. `act` and `read` are the only words that let anything through: any
  other word Kai might send, or none, is `none` in the strip (`wire::rule_word`) and in the
  background (`ruleWord`) alike. A Kai too old to answer (its `welcome` lists no `site` among the
  frames it takes, §4.2; or it answers `unknown_frame`) is the chip "update Kai", at once. While
  Kai is not linked the strip says so, and a click opens the extension's status page; a page the
  background refused (§4.4) says "Refused", its reason in the chip's title and in a notice.
- **The hints switch** shows the hint labels (`hints.show@1`) on the active tab while it is on,
  again after each navigation and on the tab activated next (the previous tab's go), never on a
  `none` site; the labels a sidebar turned on go when it closes. They are pinned to the top
  document whose rule was asked, as Attach this page's read is (below). The strip records what it
  asked before its calls go (a generation counter), so a slow answer to an earlier change changes
  nothing; the background hides labels whose drawing ended after the page turned them off or its
  port went (`hints_off`).
- **Attach this page** reads the tab's text with `page.text@1`'s reading in the background, only on
  a web page or a local file (never Firefox's own or an extension's page, `moz-extension:`
  included) and only when its rule is not `none`. The read is pinned to the top document whose
  rule was asked: the background takes frame 0's `documentId` (`webNavigation.getFrame`) before it
  asks Kai, and every call of the read to the top frame, Readability's injection included, goes to
  that document alone (`tabs.sendMessage` with `documentId`, `scripting.executeScript` with
  `documentIds`, both used by WP7's operations on Firefox 154+). A navigation that commits before
  or during the read (a meta refresh, an SSO redirect, a script's `location =`) fails it with
  `page_changed`, and the page after it is never read. The content script's answer names the
  document, URL and title it read; the rule is checked against that URL (a `pushState` within the
  document asks Kai again), and the header is that title and URL. The blocks of frames whose
  origin is a `none` site are one line in their place ("(a frame of a site Kai does not reach)",
  Kai's words), each frame's origin being its own answer's. The text goes into the open thread's
  composer as a `text/plain` file named after the page's title at its whole length, its first line
  "Page: <title> (<URL>)", through the Chat's own drop path (a synthetic drop on the conversation):
  `lmgw-chat-ui` has no seam for a host's composer action yet (§13), so the button sits in the
  strip, not the composer. A drop nothing on the conversation took is said in a toast (the
  Chat's handler cancels a drop it takes).
- **Approvals** show inline as lmgw's Chat draws them. *Not built yet:* highlighting the element on
  the page while an approval for a call on it waits (§13).
- **The toolbar button** toggles the sidebar (`sidebarAction.toggle()` in the click's handler); it
  opened the options page before, which stays in about:addons and behind the strip's "Kai is not
  linked". **The shortcut** is `Ctrl+Alt+K` (`_execute_sidebar_action`), checked against Firefox
  159's own keys (`Ctrl+K` focuses the search, `Ctrl+Shift+K` is the Web Console, `Ctrl+Alt+R` Reader
  view) and Plasma's shipped global shortcuts (none on it); on layouts where AltGr is the right
  Alt only, so `Ctrl+Alt` is no AltGr chord. The sidebar does not open at install
  (`open_at_install: false`).

- **The origin of a typed message** (*As built,* lmgw `76a3bfb8`; `sidebar/src/page.rs`,
  `strip.rs`'s `SiteState`, `wire::origin_sentence`): the page sets `ChatHost::origin`, which the
  Chat calls once per send and per edit of a user message and sends as `origin` of the request;
  lmgw stores it with the message, shows it as a caption under it and gives it to the model with
  that message on every turn. The sentence is "Typed in Kai's sidebar in Firefox, beside the tab
  “<title>” (<URL>)." when the tab's rule is `act` or `read` (an empty title: "beside the tab
  <URL>"), and "Typed in Kai's sidebar in Firefox." for a `none` site, a page that is no site, a
  rule not answered yet or a URL the rule was not asked about: a `none` site is kept from Kai
  entirely, so its title and address are not told to the model either. The URL is the one the
  strip's rule question was about (the rule keeps it; a tab that moved on since reads as not
  known yet), the title the tab's current one; neither is shortened. Voice turns have no origin
  (the sidebar has no voice yet).
- **New chat and Back to** (lmgw `76a3bfb8`, the Chat's narrow layout, nothing in the sidebar
  page): a New chat button in the head puts the chat in the open thread's folder, and in an
  ongoing folder such as Kai's it becomes the folder's new current conversation; the folder's
  current thread is marked in the list and a "Back to <folder>" button returns to it.
- **The pin** is raised from lmgw `4add6051` to `76a3bfb8` (tree `2ea6a1cda6c6`, tag
  `unpublished`): `ChatHost::new` is unchanged, `ChatHost::origin` is new.

### 8.2 Reusing lmgw's Chat components

lmgw's Chat today is one large component inside the dashboard binary (`lmgw-ui`, `pages/chat.rs`:
`Chat()` spans about 1900 lines; about 36k lines across the chat modules). It has no transport seam.
What has to change in lmgw, from the call sites as surveyed:

1. **A transport seam in the kit.** `lmgw-ui-kit`'s HTTP client (`http.rs`) gains a transport: the
   dashboard's stays `fetch`; the sidebar's sends `req` frames through the background. The places
   that bypass the kit move onto it: the send stream (`chat_stream.rs`, SSE over a fetch body),
   dictation's upload, `fetch_file`, attachment and media `src` URLs (`chat_attach.rs`,
   `chat_media/card.rs`), and exports (`<a download>`, `chat_export.rs`).
2. **The Chat on Chat-plane routes only.** The Chat reads routes a device cannot reach:
   `/api/events` (the dashboard's live stream, `live.rs`), `/api/settings-full` (seven places),
   `/api/knowledge/bases`, and through the tool picker `/api/mcp-servers`,
   `/api/mcp-servers/{id}/tools` and `/api/tools` (`widgets/tool_picker.rs`). lmgw gives the Chat
   what it needs on `/chat/api/*` (the feed already carries chat frames; the settings and tool
   lists it reads become chat-plane reads scoped to the principal), so the dashboard and every
   client use one set. WP2 starts by listing every call site; the list above is the survey's.
   - *Done (lmgw WP2, `3b54091b` to `24611bd0`; lmgw's
     `docs/design/2026-11-03-chat-plane-design.md`, whose D1 to D17 are draft decisions):* the full list was 86 call sites over 60 routes, 14 of them on the admin
     plane over 9 routes (the citation viewer's two knowledge-file reads and the thread rows route
     beyond the survey; `/api/settings-full` in six places, the seventh being the dashboard's title
     bar). The Chat's code now names no `/api` route: it reads only `/chat/api/*` plus
     `/v1/models`, `/v1/audio/voices` and `/v1/realtime`.
   - The routes added, each `Cap::Chat` and scoped to the caller: `GET /chat/api/settings` (the
     nine values the Chat reads, the same for every caller), `GET /chat/api/tools` and
     `GET /chat/api/tools/{label}` (the tool picker: the caller's tool scope over lmgw's label
     listing; the detail starts no service agent), `GET /chat/api/knowledge/bases`,
     `GET /chat/api/knowledge/files/{id}/text` and `…/original` (the owner's only, §8.1).
     `/chat/api/threads/rows` became a Chat-plane route, and the feed's hold carries `benchmark`.
   - The live updates come from a source the host hands the Chat: the dashboard hands it the
     shell's own `/api/events`, so a dashboard tab keeps one stream (a browser keeps at most six
     HTTP/1.1 connections to one host, and a Chat stream beside the shell's would let three tabs
     take them all); a host that hands none, the sidebar, gets `/chat/api/feed`.
   - **WP3 is built:** the kit's transport seam (3a) and the `lmgw-chat-ui` crate (3b, §12), for
     which the chat-plane design's §6 lists what the crate takes along and what it must replace.
3. **A library crate `lmgw-chat-ui`** with the Chat's components, used by the dashboard and the
   sidebar: no router (`use_query_map` becomes props), no dashboard widgets it does not own
   (toasts, split panes, the tool picker move to the kit or into the crate), and a narrow layout
   (the thread list as a drawer below a width).
4. **Media by bytes.** Images and audio come through the transport as blobs
   (`URL.createObjectURL`).
5. **Scripts as files.** `codeblocks.js` (highlight.js, KaTeX, Mermaid) and the dashboard's inline
   script become module files: an extension page allows only `'self'` scripts (plus
   `'wasm-unsafe-eval'`).
6. **A frame seam for the HTML preview.** A `srcdoc` frame inside the sidebar inherits the sidebar's
   CSP, so a previewed page's scripts would be refused (WP0 (c)). The sidebar's preview is a page
   listed in `sandbox.pages` with its own `content_security_policy.sandbox` (Firefox 154, D1), loaded
   as the frame's `src` without a `sandbox` attribute; it receives the HTML by `postMessage` and
   shows it in a `srcdoc` frame of its own. So the Chat's preview component takes its frame from the
   host (the dashboard keeps its `srcdoc`). That policy allows inline scripts but no remote ones: a
   preview that loads a library from a CDN works in the dashboard and not in the sidebar.

At first the sidebar has no voice controls: the realtime WebSocket and dictation are not proxied,
and Kai's talk key is the voice (§13).

*As built (WP8b, `sidebar/`):* a Leptos crate (`kai-firefox-sidebar`, its own workspace) on
`lmgw-chat-ui` and `lmgw-ui-kit` at the lmgw tree `LMGW_PIN` names, staged by
`scripts/lmgw-pin.sh stage` (a `git archive` of the four crates and lmgw-ui's base stylesheet and
fonts out of lmgw's checkout into `target/lmgw-pin/`, the checkout only read; CI clones lmgw at the
pinned commit), built by Trunk in release with wasm-opt into `extension/sidebar/`
(`scripts/sidebar.sh`). The host hands the Chat what lmgw's chat-plane design §9.8 lists:
`http::configure` with no base and the `401` hook, then `Http::new` of the page's transport before
`provide_model_catalog(locked)`; `ChatHost` with an in-memory `ChatLocation` (a sidebar opened again
starts at the first thread), `dashboard_href` answering `None`, `locked` from the link,
`ChatLive::Feed`, `PreviewFrame::Posted { src: "preview.html" }`, `voice: None`, `machine: None`;
`ToastHost` before the Chat, the dirty guard with one constant path and its question's host (its
"Leave and discard" opens a web link in a tab, the sidebar having no other page). The stylesheets in
§9.8's order (kit, profiles, lmgw-ui's `app.css` for the base components, chat, voice, then the
sidebar's), the IBM Plex fonts `app.css` names, `codeblocks.js` with `vendor/`, the loader as
`start.js` through Trunk's `pattern_script` and `boot.js` for the theme. Trunk names its page
`index.html` whatever the target, so a post-build hook renames it `sidebar.html`.
- **The transport** (`sidebar/src/transport.rs`, the frames without a browser in `wire.rs`, unit
  tested natively): `Body::Json` as `{text}` with `content-type: application/json` unless the
  request names one, `Bytes` and `Blob` as `{base64}` (a blob read first, its type used where no
  header names one), header names in lower case and none dropped (Kai refuses what it does not
  admit, visibly), `Read::Stream` as `"stream"` and `Whole`/`Blob` as `"whole"`. A whole answer is
  gathered and each piece acknowledged as it comes off the port; a stream's pieces are acknowledged
  as the Chat takes them. The request's `AbortSignal`, a dropped `send` future and a stream dropped
  before its end send `abort`. `end` with an error before `res` is `send`'s `Err`, after it the
  stream's (or `send`'s, for a whole answer). `link {up}` and the port drive `locked`; a port that
  drops ends the open requests and is opened again after 1 s, doubling to 30 s, a refused one not
  (its reason shown). `gateway_left` puts a notice over the Chat with a Reload button.
- **The feed's cursor across a lost link:** the Chat closes its feed while `locked` and opens a
  fresh one without `Last-Event-ID` when it unlocks, which would read everything again. The
  transport keeps the cursor as the Chat takes the feed's pieces (each record's `id:`, `hello`'s and
  `caught_up`'s `cursor`) and sends it with a feed the Chat opens without one; a `400` to it is asked
  again at once without it, and `gateway_left` drops it. Each feed stream reads its records with a
  reader of its own (`wire::FeedReader`, on bytes, so a UTF-8 character split across pieces stays
  whole), and only the cursor is shared: a stream the lost link cut off half way through a record
  leaves nothing in the next one's. The feed's dead-link watchdog and its own reconnects stay the
  Chat's (lmgw's D23). Keeping the cursor across `locked` belongs in lmgw-chat-ui's
  `ChatLive::Feed` (lmgw's §9.8, not built yet); until then the transport carries it.
- **The preview** (item 6) is `sidebar/preview.html` in `sandbox.pages` with the manifest's
  `content_security_policy.sandbox`, loaded as the frame's `src` without a `sandbox` attribute; it
  takes a message only when `ev.source === parent` and shows the code in a `srcdoc` frame with the
  dashboard's sandbox flags, where its inline scripts run (checked from the real panel: an opaque
  origin, the inline script ran, and neither the sandbox page nor the previewed page has `browser`
  or `chrome`, read without Xrays, while the sidebar's own page has both). Its policy restricts
  scripts only, so a previewed page can load images and fetch from anywhere, as the dashboard's
  `srcdoc` preview can (§14 item 72).
- **The policy:** the sidebar page runs under lmgw's §8.9 policy word for word, as a
  `<meta http-equiv="Content-Security-Policy">` in `sidebar.html`. Firefox 159 accepts it as the
  manifest's `content_security_policy.extension_pages` too, but that policy covers every extension
  page, the background included, and its `connect-src 'self'` refused the background's own fetches
  (`pdf.bytes@1`'s fetch of the tab's PDF failed with a NetworkError in the e2e suite; `page.see@1`
  fetches its capture's `data:` URL the same way). So the manifest carries §8.9's directives with
  the `connect-src` the background needs (`'self' http: https: file: data: blob:`; `file:` for a
  local PDF) and Firefox's MV3 `upgrade-insecure-requests`, `object-src 'none'` among them, and the
  page's own policy narrows `connect-src` to §8.9's (both apply). A page that lost or moved its
  `<meta>` still has the rest of §8.9 from the manifest. The page counts what its policy refuses on
  `<html data-csp-violations>` (`boot.js`); the e2e checks the Chat ran with none and that an image
  from elsewhere and an inline script are refused, and the whole suite that the background's PDF,
  page and screenshot paths work under the manifest's policy.

Kai's proxy (`lmgw_link/proxy.rs`) today serves its settings window: buffered, GET and POST JSON,
an admit list of routes, bounded by `window.proxy_max_mb` and `window.proxy_timeout_s`. For the
sidebar it gains streams (the send stream, the feed), byte bodies, and an admit list of the Chat
plane plus `/v1/models` and `/v1/audio/voices`. `proxy_max_mb` keeps applying to buffered bodies;
streams are not buffered and `proxy_timeout_s` applies to their start (the response head), not to
their length, so the feed stays open.
- *As built (WP8a, kai-firefox `extension/background/sidebar.js`, Kai `src/browser/sidebar/`,
  `src/lmgw_link/proxy/relay.rs`; the wire is `docs/protocol/operations.md`, "The sidebar's
  requests"):* the page sends `req` frames over a `kai-sidebar` port, which the background takes
  only from the sidebar page itself (§4.4), renumbers for the link and sends to Kai; Kai admits
  exactly the Chat's requests (the Chat's call sites as lmgw's WP3b left them, not the whole Chat
  plane), sends them over its device link, and answers `res`, `chunk` and `end`. The page says
  whether it reads the answer whole or streamed (`read`, the kit's `Read`): a whole answer is read
  under `window.proxy_max_mb` and timed whole, a stream's head is timed and its body passes as lmgw
  sends it. Bodies go as text (UTF-8 JSON and text, SSE streams) or base64. Native messaging has
  no backpressure, so Kai keeps at most `browser.sidebar_ahead_mb` (4 MB) of one answer's pieces
  unacknowledged; the page acknowledges each piece as it takes it from its port, whole answers and
  streams alike (only a stream's consumer may pace), and the background passes the acks on.
  `abort`, a closed sidebar and the link's end end a request, and lmgw sees its connection go;
  Kai leaving its gateway (a re-pair, a revocation) ends them with `gateway_left`, which the page
  shows. The two `window.proxy_*` settings are shared with the settings window and now say so. The
  relay's
  e2e runs from the real sidebar panel (a test page in a copy of the extension) through the real
  host to the fake Kai; Kai's proxy runs against a scripted lmgw behind the tests' device
  listener. *Since WP8b* the page has run through Kai's real server and relay to a dev lmgw once
  (§13).

*From lmgw WP2:* the feed resumes through the browser's `EventSource`, which sends the last
event's id as `Last-Event-ID` when it reconnects, so the catch-up names what changed while the
stream was down. Over `req` frames there is no `EventSource`, so the sidebar's transport has to
carry that cursor itself (each event's `id:`, sent back as `Last-Event-ID` or `?since=`), and
Kai's proxy has to pass the header and the `id:` lines through unchanged; a feed reopened without
it starts afresh with `hello`, and the Chat reads everything again. The feed counts Kai's own feed
and the sidebar's as two links of Kai's device, and neither ends the other. Each sidebar page
opens one feed.

### 8.3 The sidebar is Kai

- **One identity** (decision 9). Kai proxies the sidebar's requests with its own device
  certificate. lmgw records the sidebar's turns as Kai's; their tool calls reach Kai as `Own`,
  trusted as caller and approver; an approval clicked in the sidebar is Kai's. The sidebar reaches
  what Kai reaches: Kai's self-admin level (api L3), its alias scope, its tools,
  `conversation_start` included.
- **The warning.** Page text reaches the model through the sidebar's attachments and through the
  browser tools, and a page can carry instructions (§6.4). While Kai's lmgw admin level is
  `read_only` or `full` and an extension is connected, Kai says so once when Firefox first connects
  and again whenever the level is raised: a notification and a line in Kai's settings, "Kai reads
  web pages in Firefox and can change lmgw (admin level: full). A page's text can steer the model,
  and at this level it reaches lmgw's configuration and the tools that run programs. This may be
  unwise." Nothing is refused or hidden.
  - *As built (WP5):* the notification shows once per Kai start, at the first connection of an
    extension, and again whenever the level is raised. The settings window shows a banner that
    follows changes. An ended pairing resets the warning.
  - *Taken in this draft:* the once-per-start is kept in memory, so a restart of Kai says it again
    (§14).
- **Kai's voice tells the sidebar's turns apart.** lmgw's feed reports a sidebar turn with Kai's own
  name (`by.own`), which Kai's voice reads as its own turn (`src/voice/mod.rs`). The marks below
  are for Kai's voice only and never touch `Caller::Own`: the sidebar's tool calls stay Kai's own,
  trusted as caller and approver, and count as the owner's act in hands-free mode, since the owner
  typed them (WP10b). Kai tells a turn of the sidebar's apart for two things only:
  - automatic listening holds back while it runs, as for another principal's turn (kai K16), and
    the room cannot cancel a typed turn;
  - its approvals are answered on the card or in the sidebar, not through the voice session, like
    calls of other threads, and the card names the sidebar as who asked (kai K17).
  - *As built (WP8a and its fix round, Kai `src/browser/sidebar/turns.rs`):* whose a turn is
    follows the turn, not the request. `send`, `continue`, `answer`, a message's `edit` and
    `regenerate` mark their thread before they go to lmgw; the thread's next own `turn.started`
    that is no voice turn takes the mark and is read as a turn of "Kai's sidebar in Firefox". The
    mark lives while the request is open and, once it ended, until the core has read the thread's
    next `turn.started` or `turn.done` (or a running list without the thread): the feed is a
    connection of its own, and a short turn's stream can end before its start is read. A request
    lmgw refused started no turn, and its mark goes at once. A resumed turn (lmgw runs it as its
    starter, whoever decided its calls: Kai's card, the sidebar, the phone, the dashboard) is an
    own turn that is no voice turn while the thread's last reply waits on calls or had calls
    decided since its last start; it is read as the turn it resumes, and one whose turn Kai never
    saw start is the sidebar's when the sidebar sent the verdicts (`approvals` marks too), else
    Kai's. Any other own turn is Kai's: its voice turns, and one neither marked nor a resume. A
    `hello`'s or `state`'s running list is read the same way and reaches the approval card too.
    Kai counts each thread's turns started and not done, so a cancelled turn's `turn.done` that
    comes after its successor's `turn.started` (lmgw's `turn.done` carries no turn's id) does not
    end the sidebar's turn for the voice. An image card's action
    (`/chat/api/attachments/{id}/media`) starts no turn: lmgw runs it with no model in the loop.
  - *Considered in the fix round, not taken:* reading every own turn that is no voice turn as the
    sidebar's unless Kai started it itself. lmgw marks a bound session's turn as a voice turn only
    when its response speaks (`voice` is the speech plan's, none for text output), so that default
    would read a text-only response of Kai's own session as the sidebar's.
- **lmgw's statement** that no browser page reaches a device label (api §5.6, link D12) gets a note:
  the extension's sidebar, a privileged extension page and no web page, reaches lmgw through Kai's
  proxy as Kai, on the Chat plane only.

### 8.4 Size

The dashboard's debug WebAssembly is 63 MB; no release build of a Chat-only bundle has been
measured. WP0 (c) builds a minimal Leptos page with the kit in release and records its size and
load time in the sidebar; WP8 records the real one.

*Measured (WP8b, 2026-11-04, lmgw 4add6051, rustc 1.98.1, trunk 0.21.14, wasm-opt version_123 at
`-Oz`; `tests/sidebar-shots.mjs` for the times):*

| | size |
|---|---|
| cargo's wasm (`opt-level = "s"`, LTO, one codegen unit, stripped) | 7 454 785 B (7.1 MiB) |
| after wasm-bindgen and `wasm-opt -Oz` (what the XPI carries) | **5 248 081 B (5.0 MiB)**; gzip -9 1 840 352 B, brotli -q 11 1 263 316 B |
| wasm-bindgen's glue | 94 849 B |
| the whole `extension/sidebar/` | 6 668 006 B, of which `vendor/` 726 277 B (Mermaid's stand-in, not its 5.6 MB) and the Plex fonts 296 468 B |
| the whole extension zipped (`zip -9`, unsigned) | 2 853 757 B (2.7 MiB) |

The Chat is twelve times WP0 (c)'s minimal page (435 KiB). Load, in ms since the page's navigation
began, headless, the fake Kai answering at once, 7 openings of the real panel:

| | the wasm running | the first frame | the first message drawn |
|---|---|---|---|
| cold (the profile's first) | 92 | 103 | 136 |
| again (6 openings) | 63 to 100, median 72 | 77 to 106, median 83 | 80 to 116, median 90 |

So 5 MiB of wasm still opens in about a tenth of a second, as WP0 (c) found for the minimal page: the
size is the XPI's and the download's, not the opening's. A real Kai and lmgw add their round trips
to the first message (the real run's, §13).

### 8.5 Look

D8: the kit's tokens (`kit.css`), Breeze-like graphite and blue. The kit picks light or dark by the
`data-theme` attribute, so the sidebar sets it from `prefers-color-scheme` and follows its changes.
Firefox opens an extension sidebar at 338 px; there is no width API, and the layout works from 280
px up (WP0 (c)). Firefox's scrollbars are 12 px wide, so the sidebar sets `scrollbar-width` and
`scrollbar-color` like lmgw's own pages. A minimal Leptos sidebar with the kit is 435 KiB of
WebAssembly after `wasm-opt` and draws its first frame 63 to 100 ms after opening (WP0 (c)).
- *As built (WP8b):* `sidebar/assets/boot.js` sets `data-theme` from `prefers-color-scheme` before
  the first paint and again at each change (checked by switching Firefox's colour scheme with the
  page open); `sidebar/assets/sidebar.css` sets thin scrollbars in the kit's colours (lmgw-ui's
  `app.css` does too) and a column from 280 px. Below 520 px of its own width the Chat lays its
  thread list and the thread's settings as drawers over the conversation (lmgw's D37), which is the
  sidebar's layout at 338 and 280 px. Screenshots at 338 and 280 px, light and dark, at 1.25
  scale: `tests/sidebar-shots.mjs` (into `target/wp8b-shots/`).
- *Fix round:* at 280 px the Chat's head wrapped "Export" onto a second row. `sidebar.css` keeps
  the narrow head's first line whole: Export joins the list's button, the model and the settings'
  button there as a download icon (its word stays the button's name), and only the badges wrap
  under it. The real fix belongs in lmgw-chat-ui's `.chat-head` (lmgw's §9.8, not built yet; §14
  item 73).

## 9. The extension's settings

An options page with what only the extension decides:
- `retry_ms` (§2); the restarts of the native port back off from it, doubling up to 60 s;
- `nav_start_ms` and `nav_load_ms`, how long navigations wait for Firefox; `nav_load_ms` (default
  60 s) bounds the whole wait, and a navigation that never settles ends with `nav_timeout`;
- `content_ms` (default 15 s): how long a page has to answer; a page that does not ends the call
  with `content_timeout`, while another frame counts as unread (§5.3); the values and errors are in
  `docs/protocol/operations.md`;
- the permissions Firefox grants only on a user action: user scripts (§5.8), local files;
- a status block: Kai linked or not, protocol versions, the operations served.

Everything about policy (tool states, site rules, the guard, announcements, the hands-and-eyes
switch) is Kai's configuration, the same from every device.

## 10. Packaging and release

- **Repository** `kai-firefox`: `extension/` (manifest, background, content scripts, options),
  `sidebar/` (Leptos, Trunk), `tests/`, `docs/`. Content scripts and the background are plain ES
  modules without a build step; `dom-accessibility-api` and Readability (`page_text`'s, since
  WP4b) are vendored as bundles by an `npm run vendor` step whose output is committed.
  - *As built (WP8b):* the sidebar page is built into `extension/sidebar/` by
    `scripts/sidebar.sh release` and is **not committed** (gitignored): it is several megabytes of
    binary that every change of the page and every raise of the lmgw pin would rewrite, it holds
    lmgw's compiled code (whose pinned source may be unpublished while kai-firefox is published),
    and AMO reviews it from the source anyway. CI builds it (the `sidebar` job) and signing takes
    it only when `target/sidebar-build.json` (`scripts/sidebar-build.mjs`) says it was built in
    release from the commit's `sidebar/` and `LMGW_PIN`, and only when `extension/sidebar/` hashes
    as that build left it (every file by its path and bytes; the staged copy is hashed again): a
    `trunk watch` build of edited sources after the release build, with the sources checked out
    again, is refused, as is a record from before the hash. The release build replaces this
    machine's paths in the wasm's panic locations (`--remap-path-prefix` in a generated, gitignored
    `sidebar/.cargo/config.toml`, for the wasm32 target only), so no home folder goes out in the
    XPI. The page's fonts (IBM Plex, from lmgw-ui) go with their licence, the SIL Open Font
    License, as `fonts/OFL.txt` beside them (`sidebar/assets/IBM-Plex-OFL.txt`; lmgw's crates
    carry no licence text for them yet); signing refuses a staged page with fonts and no
    `OFL.txt`, and the source archive carries the text in `sidebar/assets/`.
- **The lmgw crates** come from a pinned sibling checkout, like Kai's UI (`LMGW_PIN`; the pin is
  raised at landing).
  - *As built (WP8b):* `LMGW_PIN` has Kai's three lines (`lmgw_commit`, `lmgw_tag`, `lmgw_tree`);
    `scripts/lmgw-pin.sh stage` copies the pinned tree's crates out of the checkout (`git archive`,
    whatever branch the checkout has out) into `target/lmgw-pin/`, so a local build is always the
    pinned source and never the working tree of lmgw's checkout. GitLab's `sidebar` job clones
    lmgw's project at the commit; the GitHub release workflow clones the public lmgw at `lmgw_tag`
    and checks its tree (`verify-tree`), and fails while the tag is `unpublished`. `stage` skips a
    staged tree it finds (`.tree`), so a release build checks the staged files themselves against
    the pinned tree before and after it builds (`verify-staged`: each file's git hash against
    `git ls-tree` of the tree, none missing, none added, the workspace root as `stage` writes it): an
    edit in `target/lmgw-pin/` fails the build instead of going into a "pinned" release.
- **Gecko id** `kai-firefox@rootshell.dev`.
- **Version**: the manifest's three-part base plus a fourth part, valid for AMO's numeric
  four-part rule: the commit count for builds (the earlier extension's scheme), `0` for releases.
- **Trunk** emits an inline loader script with no option to avoid it; a `post_build` hook moves it into
  a file (WP0 (c), `spikes/sidebar/scripts/externalize-inline.mjs`). A custom
  `content_security_policy` makes `web-ext lint` (and AMO) note `MANIFEST_CSP`: more review, expected.
- **Signing**: `web-ext sign --channel=unlisted`, resumable (an already signed version is
  downloaded, a pending one awaited), credentials from the environment. The source upload carries
  `Cargo.lock`, `package-lock.json`, `rust-toolchain.toml` and a `build-for-amo` script, which AMO
  runs when present.
  - *As built (WP11a, kai-firefox `f1e8efc`):* `npm run sign` (`scripts/sign.mjs`) derives the
    version (`<base>.<commit count>`, or `<base>.0` with `--release`) and checks AMO's numeric
    rule. It refuses a tree with tracked changes or untracked files in the source paths, stages
    `extension/` from `HEAD` under `target/sign/<version>/ext` with the version spliced into the
    copy's manifest (and the channel's `gecko.update_url`, below; the committed
    manifest never changes), and fails on `web-ext lint` errors. The source archive is a
    `git archive` of `extension/`, `scripts/`, `package.json`, `package-lock.json`, `README.md`
    and `LICENSE.md`, with a generated `BUILD-FOR-REVIEWERS.md` at its root (the XPI is
    `extension/` as it is; the only generated files are the two vendored bundles, made again by
    `npm ci && npm run vendor`). *Since WP8b* the archive also holds `sidebar/` (with its
    `Cargo.lock`), `LMGW_PIN`, a `rust-toolchain.toml` naming rustup's Rust the page is built with
    (`scripts/ci/rust-version`, written at signing, so desks keep the toolchain they have; a real
    signing refuses a page whose build record names another Rust, or a distribution's build of the
    same version, and a dry run warns) and
    `build-for-amo.sh` (it clones the public lmgw at `lmgw_tag`, checks the tree, and runs
    `npm run vendor` and `scripts/sidebar.sh release`); the staged copy takes `extension/sidebar/`
    from the build. lmgw's crates are not in the archive: while `lmgw_tag` is `unpublished` a
    reviewer cannot build the page, which the note and the run say (§14). Credentials come from
    `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (the environment or a gitignored `.env`). web-ext only
    uploads; the script asks AMO's API for the version, waits for a pending one (`--wait-min`,
    default 60), fails with AMO's status on a rejected one, downloads the signed file and prints
    the start, the end, the duration, the XPI's path and its sha256. A re-run resumes whatever AMO
    already has and refuses a version AMO took from another commit; `--dry-run` does everything
    but contact AMO.
  - *The first signing (WP0 (g)):* 0.1.0.47, from `b95c8be`, on 2026-11-03: 2 min 19 s from the
    start to the signed file (upload and validation 16.3 s, the signature 2 min 2 s, the
    download 0.3 s), lint with no errors and two warnings (`innerHTML` in the vendored
    Readability), the source archive (55 files, 247 630 bytes) attached. AMO signed it while the
    file's status was "unreviewed"; a human review of the source, and whether a reviewer's build
    runs, were not observed. The XPI has no update URL, so it is installed by hand and Firefox
    does not update it.
- **Two channels** (decision 11). Each XPI carries its channel's `gecko.update_url`, which points at an
  `updates.json` with the XPI's `update_hash`:
  - **builds:** every build is signed and uploaded with its `updates.json` to the GitLab package
    registry (the earlier extension's way; the update URL's read token comes from the environment, never the
    repository). Version `<base>.<commit count>`.
  - **releases:** a targeted release is signed separately, with the update URL of this repository's
    latest GitHub release (`releases/latest/download/updates.json`), and attached to a GitHub
    release published the way lmgw's and Kai's are (one squashed commit per release). Version
    `<base>.0`, so it never collides with a build's: AMO signs each version once.
  - *Decided (owner, 2026-11-03):* updates from GitLab only for builds from GitLab, GitHub builds'
    updates from GitHub; a build on a desk carries no update URL.
  - *As built (CI):* `scripts/sign.mjs` takes the channel from the environment, not from an option
    (`scripts/channel.mjs`): `GITLAB_CI=true` is builds, `GITHUB_ACTIONS=true` with `--release` is
    releases, and `--release` anywhere else, or GitHub Actions without it, is refused. The builds
    channel's update URL is `<CI_API_V4_URL>/projects/<CI_PROJECT_ID>/packages/generic/kai-firefox/updates/updates.json`
    and its XPI is `.../kai-firefox/<version>/kai-firefox-<version>.xpi`; the releases channel's is
    the repository's `releases/latest/download/updates.json` and the release's own
    `releases/download/<tag>/kai-firefox-<version>.xpi`. For a registry that requires authentication,
    `KAI_FIREFOX_UPDATE_TOKEN` (`<deploy token user>:<token>`, `read_package_registry`) goes into
    both URLs as userinfo, as the earlier extension does, and so into every signed XPI and to Mozilla; the project's
    "allow anyone to pull" needs no token and is the cleaner choice. After the download the script
    checks the signed file's `version` and `update_url` against the run (AMO signs a version once, so
    an earlier local signing of the same commit would otherwise come back as the CI build, without
    an update URL), copies it to `kai-firefox-<version>.xpi` and writes `updates.json` (one entry,
    the newest, with `sha256:`). `scripts/publish-gitlab.mjs` (GitLab CI only, `JOB-TOKEN`) uploads
    the XPI and then `updates.json`, and keeps a newer `updates.json` the registry already has.
    `.gitlab-ci.yml` runs lint and the unit tests on every branch and the signing on `main`;
    `.github/workflows/release.yml` signs a pushed `vX.Y.Z` tag's release (the tag put on the GitHub commit by `scripts/publish-github.sh`) and attaches the files.
    `docs/releasing.md` lists what the owner sets once in GitLab.
  - *Run (GitLab):* the builds channel has run. The first successful pipeline built 0.1.0.53,
    signed and uploaded with its `updates.json`. The first pipeline with the sidebar
    job failed in it, because the Fedora image has no `cmp` (`scripts/sidebar.sh` and
    `scripts/lmgw-pin.sh` call it); `20874f8` installs diffutils. The fixed pipeline passed on
    2026-11-04: sidebar 222 s, check 9 s, build and signing 334 s, signed 0.1.0.81, and it uploaded
    the fixed-name `kai-firefox.xpi` and `updates.json` to the registry's `updates` package. The
    GitHub release workflow has not run (no GitHub repository yet). Firefox's own update check
    against either registry is not recorded here yet, and CI runs the unit tests only: the
    end-to-end tests need Kai's `kai-browser-host`, built in a repository CI cannot clone yet.
  - *As built (WP8b):* `.gitlab-ci.yml` gains the `sidebar` stage (trunk, wasm-bindgen and
    wasm-opt pinned and hash-checked by `scripts/ci/install-*.sh`, copied from Kai's packaging; lmgw
    cloned with the job's token as Kai's CI does): the wire's tests and the release build, whose
    `extension/sidebar/` and `target/sidebar-build.json` are the artifact `check` lints and `build`
    signs. The GitHub workflow builds the page before it signs. GitLab's pipeline has run with it
    (above); the GitHub workflow has not.
  - *Fix round:* the job first used Fedora's own Rust from dnf, which bakes in Fedora's patches,
    its system LLVM and its std paths, so a reviewer building with rustup at the same version got
    another wasm. Both pipelines now install rustup's Rust at the version `scripts/ci/rust-version`
    names (1.98.1), with the wasm32 target: GitLab with Fedora's `rustup` package (`rustup-init`,
    the toolchain cached in `target/rustup/`), GitHub with the runner's rustup and
    `RUSTUP_TOOLCHAIN`; the source upload's `rust-toolchain.toml` names the same. GitLab's image is
    Fedora 44 pinned by its index digest (2026-11-02), and the job installs Node 22 for the build
    record.
- **Kai's side**: the Kai RPM ships `kai-browser-host` and its native manifest (§4.5). The extension
  is not installed by the RPM; Kai's settings offer "Install Kai for Firefox", which opens the XPI's
  URL in Firefox.

## 11. Testing

- **Headless Firefox over WebDriver BiDi**, lifted from an earlier BiDi harness: a
  throwaway profile, `--remote-debugging-port 0`, the extension installed with
  `webExtension.install`. Chrome-scope BiDi (opening extension pages, granting permissions) needs
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in Firefox 159's environment besides the flag. BiDi cannot set
  an extension tab's viewport or reach the real sidebar panel, so the harness drives them through a
  frame-script bridge (WP0 (c)). A test grants `userScripts` with
  `extensions.webextOptionalPermissionPrompts = false` and a BiDi click, which counts as a user
  action (WP0 (b)).
- **Native manifests in tests:** Firefox 159 reads per-user manifests only from
  `$HOME/.mozilla/native-messaging-hosts/` (and the system folder), never from XDG folders (WP0 (e),
  seven layouts). The test Firefox runs with `HOME` set to a temporary folder. Creating
  `~/.mozilla/native-messaging-hosts` moves no profiles: Firefox's XDG switch looks at
  `~/.mozilla/firefox/` only.
- **A test Kai side**: the real `kai-browser-host` pointed at a test socket (`KAI_BROWSER_SOCKET`),
  served by a harness that sends operations and records results, events and gate questions.
  Operation tests run against it without Kai.
- **The fixture site** (`tests/site/`, a plain local HTTP server, `.example` names and RFC 5737
  addresses only), started in WP4 and grown with each WP: a shop with search, results, a product
  page, a comparison table and a checkout; a form with a controlled input, a combobox, a rich editor,
  a select, a radio group, checkboxes, a slider, a file input and server-side errors; a modal dialog;
  a cookie banner in a cross-origin frame; open and closed shadow roots; `aria-live` regions and a
  countdown; an infinite list with hashed class names; a `target=_blank` link; an article; a PDF.
- **Kai's side** tests the browser provider in Kai's suite against a fake link: policy, the focus
  rule, the guard, D3's listing, the hands-and-eyes tools, the sidebar's turn marking, the peer
  check, the error words.
- **The acceptance runs** of §6.6 through Kai's real tool path, the extension in headless Firefox
  and a scripted model; one live run with a real model is still to be done by hand.
- **The trusted path** cannot run headless (it needs KWin's input): a nested-KWin check like kai's
  `live-check-read`.
- **The sidebar**: `lmgw-chat-ui` keeps the dashboard's tests in lmgw; the sidebar's e2e runs
  against a dev lmgw (`scripts/dev-instance.sh`) and a dev Kai.
  - *As built (WP8b):* `tests/e2e/chat.test.mjs` runs the page as built from the real sidebar panel
    (the frame-script bridge, `tests/lib/sidebar.mjs`, which can now also evaluate with chrome's
    rights to reach the preview's sandboxed frames) through the background and the real
    `kai-browser-host` to the fake Kai, which answers as Kai's proxy does (its 4 MB window, the
    acks, `abort`, the `site` question) from a scripted lmgw (`tests/lib/fake-lmgw.mjs`, `.example`
    names). The wire's mapping has native unit tests (`scripts/sidebar.sh test`). The real run is
    `tests/real-run.mjs`, which Kai's `just live-check-sidebar` starts (§13).
  - *Fix round:* the e2e adds a page that goes to a `none` site between the background's question
    about its rule and the read (the fake Kai answers once the next page committed): the read fails
    with `page_changed`, not `site_none` (the next page was never read), nothing is uploaded, and
    the hints are refused the same way with no label drawn; a rule word the extension does not know
    (`ask`) shown and applied as `none`; a Kai whose `welcome` lists no frames, and one that answers
    `unknown_frame`, shown as "update Kai" with no question sent to the first; the preview's sandbox
    page and its previewed page without `browser` and `chrome`; a diagram's source with the
    stand-in's sentence. Unit tests (`tests/unit/sidebar-build.test.mjs`) cover the output's hash,
    each reason signing refuses a build record, the pinned Rust, and `verify-staged` refusing an
    edited, an added and a removed staged file (on a scratch lmgw repository); native ones the feed
    reader per stream, a split UTF-8 character and the rule words.

## 12. Work packages

| WP | Where | What | Depends on |
|---|---|---|---|
| 0 | kai-firefox, Kai | **Spike** (*done 2026-11-03: (d) with a run on a Plasma session (§3; the self-test's fix kai-firefox `c860469`) and the DocURL probe (d2); (g) with WP11a: 0.1.0.47 signed in 2 min 19 s (§10)*; `spikes/*/RESULTS.md`), one verdict per point: (a) the MV3 background keeps its native port for hours; the host ends on disable, reload, update and quit; (b) `userScripts.execute` in both worlds returns values; the permission button; (c) a minimal Leptos sidebar with the kit: CSP, release size, load time, the sandboxed `srcdoc`; (d) AT-SPI: with `IsEnabled` on from Firefox's start, with or without `accessibility.force_disabled = -1`, a windowed Firefox exposes pages, its UI and its tab-modal alert, and `doAction` opens a tab and a popup (the file picker was not observed; Firefox's memory with accessibility on was not measurably more on a small page); (d2) `DocURL` is the document's address for pages and frames of any origin and depth and empty for `data:` and `blob:` documents, a first `NActions` read can be 0; (e) native manifests under a temporary `HOME`/`XDG_CONFIG_HOME`; (f) `dom-accessibility-api` and the frame merge on a large page (time for `page_controls`); (g) one unlisted signing with a source upload: duration, whether the reviewer build runs; (h) PDF text: a Rust extractor in Kai against lmgw's document reading | — |
| 1 | Kai | `browser.sock` with the peer check, `kai-browser-host`, the dev manifest, `just browser-dev` (kai WP24) (*done 2026-11-03,* Kai `ae7b26f`) | 0 (a) |
| 2 | lmgw | the Chat on Chat-plane routes only (§8.2 2), starting with the full call-site list (*built and reviewed 2026-11-03,* lmgw `24611bd0`, on lmgw's main; its D1 to D17 drafts) | — |
| 3 | lmgw | the kit's transport seam, `lmgw-chat-ui`, narrow layout, media by bytes, scripts as files (§8.2) (*built and reviewed 2026-11-03,* lmgw `0681a0ce` for 3a, the transport seam, and `4add6051` for 3b, the crate `lmgw-chat-ui`, both on lmgw's main and pushed) | 2 |
| 4a | kai-firefox | the skeleton: manifest, background, the link, hello, refs, frames; operations for tabs and context; the test harness (headless Firefox 159, the real host, a fake Kai) and the fixture site's first pages; `docs/protocol/operations.md` (*done 2026-11-03,* kai-firefox `7517cba`) | 1 |
| 4b | kai-firefox | the reading operations: outline, controls, links, fields, text, tables, selection, find, a PDF's bytes; hints and the pointing ring (*done 2026-11-03,* kai-firefox `5b8192b`) | 4a |
| 5 | Kai | the `browser` contract area and provider: tool specs, operation routing, D3's listing, errors, policy defaults, the focus rule, site rules, the hands-and-eyes switch (*done 2026-11-03,* Kai `34ecc2d`) | 1, 4a |
| 5b | Kai | the reading handlers: the reading, hint and pointing tools over WP4b's operations, PDF text, unread frames named (*done 2026-11-03,* Kai `8540e09`) | 4b, 5 |
| 6 | kai-firefox, Kai | acting: press, fill, choose, check, file, focus, hover, drag, show, scroll, keys; the commit guard and the network gate; the trusted path (*done 2026-11-03,* kai-firefox `42812bd`, Kai `8734795`) | 5 |
| 7 | kai-firefox, Kai | Firefox features, source and DOM, styles, scripts, screenshots (PDF text was built in WP4b and WP5b) (*done 2026-11-03,* kai-firefox `1a0816a`, Kai `622a4c8`) | 5, 0 (h) |
| 7b | Kai | the site rules in Kai's desktop tools: `see_window`, `see_screen`, `read_window`, `read_selection`, `ui_press`, `type_text`, `key_press` (§6.7; raised by WP7's review) (*done 2026-11-03,* Kai `0db5c8e`) | 7 |
| 8 | kai-firefox, Kai | the sidebar on `lmgw-chat-ui` over the port; Kai's streaming proxy; the sidebar's turn marking (§8.3; the warning is built, WP5); attach this page; the site strip (*8a done 2026-11-03,* kai-firefox `f5d8cea`, Kai `14269f6`: Kai's proxy, the turn marking, the background's relay and the wire, §8.2, §8.3, §14 items 42 to 50; *8b done 2026-11-04,* kai-firefox `25cc232`, Kai `dbde2f0`, the CI fix `20874f8`: the sidebar page on `lmgw-chat-ui` at lmgw 4add6051 with its transport, the host, the preview page, the manifest's policy, toolbar button and shortcut, attach this page, the site strip with Kai's `site` question, packaging and CI, §8.1, §8.2, §8.4, §8.5, §10, §13, §14 items 51 to 75) | 3, 4, 5 |
| 9 | kai-firefox, Kai | events, announcements, reading aloud (*done 2026-11-03,* kai-firefox `4913149`, Kai `98f8891`; §7.4, §7.5) | 5 |
| 10 | kai-firefox | the acceptance runs (§6.6), the guard's noise on real sites, hint numbering by voice (D4) (*done 2026-11-03,* kai-firefox `ef47f9b`, Kai `09c0403`; 10b, their design findings fixed and hands free, with its security review's fix round: kai-firefox `db9a075`, Kai `7f5ed39`; Kai's `just browser-accept` records 18 steps, all pass, and `tests/accept/RESULTS.md` lists them as 17 rows because its "search, open the third result" row holds two of them; hint numbering by voice has not been run yet, it is the owner's live try, the method in RESULTS.md §3) | 6, 9 |
| 11a | kai-firefox | release: the signing script, `npm run sign` (§10), and with it WP0 (g), the first unlisted signing with a source upload (*done 2026-11-03,* kai-firefox `f1e8efc`; 0.1.0.47 signed) | 4 |
| 11 | kai-firefox, Kai | release, the rest: updates (the update hosting; the builds channel's GitLab upload), the GitHub releases channel, the RPM's host and system manifest, the install entry in Kai (*built 2026-11-03 and 2026-11-04,* Kai `813f2da` for the RPM's host and system manifest and the install entry; kai-firefox `d1fb8b5` for the builds channel on GitLab CI (the owner's go of 2026-11-03, §10) and the GitHub releases channel's workflow, `ec26d63` for the fixed-name XPI; the first pipeline with the sidebar job, #4897 at `20874f8`, went green on 2026-11-04 with signed build 0.1.0.81; the GitHub channel's workflow has not run yet, there is no GitHub repository yet, §10) | 11a |
| 12 | Kai, kai-firefox | an AT-SPI provider for Firefox's own UI, its dialogs and privileged pages, and `doAction` as the trusted path (§3, §6.3) (*built 2026-11-03,* reviewed, and its security review's fix round on the same branches, rebased onto WP10b; kai-firefox `11ade26` to `5085e0d`, Kai `c1cd8d5` to `ce8d9d5`; `element.mark@1`, `element.unmark@1`, `gate.open@1`, `click_seen`; Kai's `firefox_ui`, `firefox_press`, `page_text` on Firefox's own pages, the press through accessibility; `just atspi-firefox` checks it against a headless Firefox on a private bus) | 0 (d), done |

Hands and eyes do not wait for the sidebar: WP4 to WP7b and WP9 to WP10 ship on their own, and the
lmgw work (WP2, WP3) ran beside them. Every package in the table is built; what is left is in §13
and the owner's live tries. "WP4" in the text means 4a and 4b.

## 13. Not built yet

- Chromium (one code base could serve it later; containers and `find` are Firefox's).
- Styles and scripts that return on every visit to a site (the earlier extension's Script mode as a Kai tool).
- A fast path in Kai that maps simple spoken commands to tool calls without a model (§6.5); recorded
  in Kai's ideas.
- Voice in the sidebar (dictation, the realtime session) through Kai's proxy.
- In Firefox's own UI (WP12, §3): the file and save dialogs (separate windows; not observed
  headless), Firefox's own fields (the address bar, the search and find bars), the context menu, a
  dialog's frame's writes beyond the top page's network gate, a list of Firefox's own pages that
  show no site's content (read while some site is `none`), a Firefox that started before
  accessibility was on, a windowed Firefox's popups and permission prompts (checked headless
  only), a page prompt's text where Firefox keeps its field (a headless Firefox did), a setting
  that prefers the key over the press through accessibility, a tab's own notification bar checked
  live (headless Firefox showed none; read by its role in the tab's panel), a site's prompt that
  names no host (a local file's) or is not on the allow-list, and `about:downloads` on the
  never-press list (its "open" runs a downloaded file).
- Private windows (§3).
- Data to fill in (addresses, logins) and captions (§6.2).
- Double-click and a native context menu (§5.4).
- A Flatpak or Snap Firefox (§4.5).
- Settings per Firefox profile (§2).
- `page_source`'s frame addresses inside a `srcdoc` attribute's HTML, and URLs a script builds
  (§5.6): they are not listed, so Kai cannot take a `none` site's out of the text.
- Letters of other scripts that look alike in the commit guard's words (a Cyrillic "о" in
  "оrder") (§6.4).
- Which part of Firefox's own UI holds the focus: the sidebar's own report comes with WP8 (§6.3).
- In Kai's desktop tools under the site rules (§6.7): a focus already in Firefox's own controls,
  rebound shortcuts, the compositor's thumbnails, a window on another activity, split view and web
  panels, a `none` site's notifications and MPRIS metadata, Firefox's titles in the window list,
  and the other gaps of kai's Later entry.
- What a non-atomic live region loses (§7.4).
- lmgw telling a client which TTS rows take a language or a seed (§7.5).
- The GitHub releases channel, which also hosts its updates: the workflow is written and has not
  run yet, there is no GitHub repository yet (§10).
- A device's download of a knowledge file's original (§8.1).
- In the sidebar (WP8b built the page): highlighting the element on the page while an approval for
  a call on it waits (§8.1); a composer seam in `lmgw-chat-ui` for a host's action (Attach this page
  goes through the Chat's drop path and sits in the strip); an address seam to open a given thread
  in a sidebar that is open (lmgw's §9.8: `opened_at` is read once); `dashboard_href` to lmgw's
  dashboard in a tab; the open thread kept across sidebar openings (it lives in memory); the
  sidebar's own report of which part of Firefox's UI holds the focus (§6.3); changing a site's rule
  from the strip (Kai's settings do); `ChatLive::Feed` keeping its cursor across `locked` and a
  narrow `.chat-head` that does not wrap, in lmgw-chat-ui (the sidebar carries both meanwhile,
  §8.2, §8.5). lmgw's chat-plane §9.8 lists the lmgw side of these seams.
- A reviewer's build of the sidebar page while `LMGW_PIN`'s lmgw is unpublished: the source archive
  names lmgw's tree, which only lmgw's development repository has (§10).
- Mermaid diagrams in the sidebar: lmgw vendors Mermaid as one 5.6 MB script, over the 5 MB per file
  that AMO's validator parses (`FILE_TOO_LARGE`, an error that stops the signing), so the sidebar
  ships a stand-in and a diagram shows its source with "diagrams are not drawn in Kai's sidebar
  yet" (§8.2). Mermaid in parts (its chunked ESM build) would need lmgw's `codeblocks.js` to load
  it so.
- Telling the sidebar's resumed turn from Kai's after Kai restarted while its calls waited, when
  the verdicts came from outside the sidebar: Kai reads it as its own (§8.3).
- A run of the sidebar through Kai's whole process to a dev lmgw: its core around the relay and its
  own pairing state (WP8a ran Kai's proxy against a scripted lmgw and the relay against the fake
  Kai; WP8b's e2e runs the page against the fake Kai).
  *Run once (WP8b, 2026-11-04, Kai `just live-check-sidebar`, `src/browser/tests/sidebar_live.rs`
  with kai-firefox's `tests/real-run.mjs`):* the page in headless Firefox, the real
  `kai-browser-host` in a Plasma-named scope through Kai's real browser server (the peer check at
  its default scopes, the admit list, the site question) and Kai's sidebar relay (`relay::send`,
  `Reply::run` with the 4 MB window) over the device link with a device Kai enrolled itself and the
  owner confirmed, to a dev lmgw (a headless build of lmgw's main plus one commit, which holds the
  pinned Chat plane; its own data dir and container prefix) with lmgw's echoing mock: the thread
  listed and opened, a message sent and its echo streamed back and stored in lmgw's thread, the
  strip's rule from Kai (`read`), Attach this page uploaded into the thread, no policy violation;
  5.9 s. Not in it: Kai's core around the relay (the paired state, the turn marking, leaving the
  gateway), which WP8a's tests cover, and Kai's own process (its tray, its configuration file).
  *Run again after the review round (2026-11-04, kai-firefox `d9b0aed`, Kai `dbde2f0`, a headless
  build of lmgw `0114b21a`):* passed in 5.8 s, Kai's `welcome` listing `site` among the frames it
  takes and Attach this page going through the pinned read.

## 14. Open questions

v2's seven questions are answered (decisions 9 to 15). What remains is this draft's own decisions:
1. **D3's footprint:** the eight hands-and-eyes tools listed only while the switch is on.
2. **§10's version scheme:** builds `<base>.<commit count>`, releases `<base>.0`.
3. **§8.3's warning:** its words, and that it shows at the first connection and at each raise of
   Kai's admin level.
4. **D4's numbers with two profiles linked:** a number that would mean two things is refused, the
   element Kai already called by it gets a new number, and `hints_show` marks a differing label
   with "(hint N)".
5. **§6.4's frames:** a frame's own origin decides its rule, so a `none` site framed inside an
   `act` page is not read, its find matches are dropped without a marker and refs inside it are
   refused.
6. **§6.4's view tools:** `element_point`, `element_show`, `hints_show` and `hints_hide` are allowed
   on `read` sites, stand outside the focus rule and are refused on `none` sites.
7. **§8.3's warning once per Kai start:** the count is kept in memory, so a restart of Kai says it
   again.

Added in v6, from WP6 to WP11a:
8. **§6.3, §6.4's lmgw approvals:** a ref-only call is asked about the focus rule all the same, and
   the trusted press's real key is asked at Kai's desk for any call approved in lmgw.
9. **§6.3's input spans:** they end `browser.input_settle_ms` (1000 ms) after Kai's last input; a
   profile whose span could not open counts what the user did there meanwhile as Kai's.
10. **§6.4's marks across Kai restarts:** kept in `browser-moves`, tabs as SHA-256 digests of id and
    URL, a site Kai navigated a tab from as its origin.
11. **§5.7's fetches:** exactly the dialog's origins, the page's own included; opaque and `none`
    origins refused; the unseen-site question not spared by an approval in lmgw.
12. **§5.6's redaction:** every occurrence of a `none` frame's address is taken out, and a source
    without the frames list is refused while a site is `none`.
13. **§5.3's screenshots:** a frame blanked by the stricter of its origin and `origin_before`; no
    image while a site is `none` and the answer names no frames.
14. **§6.7's windows:** a Firefox window judged by its tab in front; one Kai cannot tell gets the
    strictest rule, a capture within `browser.see_settle_ms` (500 ms) of a tab switch too.
15. **§6.7's keys and effects:** Firefox's tab, address and panel chords refused under the rules,
    the desktop's window shortcuts and `see_screen` during unknown effects while a site is `none`.
16. **§7.4's events:** on only while announcements are, quiet while a page loads, live regions as
    ARIA says, floods coalesced and nothing capped.
17. **§7.4's downloads:** attributed through a blocking listener on navigations while events are
    on; one with neither `source` nor `referrer` under the strictest rule.
18. **§7.4's reading sessions:** one per tab, the start rules, the ends with `read_ended` at once,
    and `marked: false` with `why`.
19. **§7.4's clean-up rules on page text:** list numbers kept, `§` kept, the hyphen join for
    letters of any script.
20. **§7.5's microphone echo:** a barge-in during Kai's own speech or within 500 ms after it cuts
    it, is spent, and clears lmgw's input buffer.
21. **§7.5's words:** Kai's words in German when its reply language is German, else in English.
22. **§7.5's speech request:** no `language`; the thread's `seed` only for a TTS served on this
    machine with local fallbacks only.
23. **§7.5's quiet moment:** the jobs' quiet moment plus do not disturb and PipeWire, then
    `browser.speech_quiet_ms` (1500 ms).
24. **§7.5's age:** an announcement waits at most `browser.announce_max_age_s` (60 s), checked when
    made and when played.
25. **§7.5's reading failures:** a refused paragraph skipped with a notice, a second in a row and
    any other failure pausing, a resumed one that fails again skipped.
26. **§10's signing:** a clean tree only, a copy staged from `HEAD`, the extension's paths as the
    source archive, a re-run resuming what AMO has.

Added by WP10b (the acceptance runs' design findings), as its security review narrowed them:
27. **§6.4's hands-free moves:** with the switch on, only these moves of a turn of Kai's own device
    are the user's act: a press of a link that loads a page by GET or of a submit control, an
    Enter that submits a form, `tab_go`, `tab_open`, `tab_back`, `tab_forward` (navigations, each
    only where the tab landed on the origin it was meant for: the `href`, the form's action, the
    URL, the search's engine, the history entry), `tab_switch` and the tab after the owner's close
    (activations). Redirects to another origin, the page's own navigations and windows it opens
    are Kai's navigation; Kai's continuation for a job's result is no turn of the owner's; the
    owner's marks count only while the switch is on and end with Kai's move for anyone else. The
    risks: page text steering Kai to another site where it acts unasked, and in conversation mode
    a page's audio heard as the owner's turn unless echo cancellation removes it.
28. **§6.4's acting operations as Kai's navigation:** every acting operation is marked before it is
    sent and landed once it answered or failed, also where the user never acted in the tab: a
    pressed link, a late commit, a cancelled or failed call, the trusted press's key.
29. **§6.4's questions by voice:** Kai speaks its own questions for a call of its own (the trusted
    press's real key included) and takes a spoken yes or no as for the approval card, one question
    at a time, the press answering what became answerable last, with no pre-roll and Kai's own
    voice and its echo's guard silenced in the answer (the approval card's answer too).
30. **§6.4's guard words:** not on a plain link that loads another document by GET; kept where its
    URL's path or query holds a guard word, it carries a script marker, or a press handler the
    page set as a property is on it or an ancestor; `addEventListener`'s listeners are not seen.
31. **§6.4's gate:** `beacon` and `ping` never held, as a trade-off against noise, which leaves a
    write a page makes by beacon because of Kai's action unasked; a keepalive fetch held like any.
32. **§7.4's live names and D5's role words for inputs.**
33. **The contract's `goes`** (WP10b's review): `element.press@1` (also with `needs_trusted` and
    `activate: false`) and `page.key@1` say where the activation goes (`by` "link" or "submit",
    the origin), read with the guard's second look right before the click; the navigations say
    the URL's origin, a search's engine's as its navigation began, a history entry's as Firefox
    began loading it (`by` "url", "search", "history").
34. **§6.4's Enter on a link:** an Enter that activates a focused link is not the owner's move (only
    one that submits a form is), so it is asked about where it went.
35. **§6.4's switch and trusted press:** the owner's own `tab_switch` keeps the site the owner's
    moves gave the tab; another caller's switch, and Kai's trusted press that raised Firefox's
    window, end it.
36. **§6.4's tabs not muted while Kai asks:** Firefox's tabs are not muted while one of Kai's
    questions waits yet; a page's audio is in a spoken answer unless echo cancellation removes it.

Added from WP12 and its review round (Kai's design, WP24, has each with its reason; numbered after
WP10b's items 27 to 36):
37. **§6.3's press through accessibility first,** the key where the element is not on the bus,
    decided as the key; the element found by a mark (`aria-kai-mark`, 128 random bits, taken away
    before the press, and by the extension itself after `MARK_TTL_MS`, 5000 ms, a constant of the
    contract rather than a setting), searched only in the page of the tab's own window, and taken
    only where its documents are the frames the extension names, each passes the site rules, and
    its role and name are the extension's; a mark on two elements is tampering: refused, and no
    key either.
38. **§3's Firefox UI as two browser tools and `page_text`,** around the tab in front of its own
    window only (its selected tab the tab), by `page_rule`, an allow-list (an `http:`, `https:` or
    `file:` page with a host gets its site's rule, every other page the strictest configured,
    another extension's `moz-extension:` page too); a dialog by the origin its title names, a
    prompt for a site by every site its words name, the strictest where none is named.
39. **§3's allow-list of what `firefox_ui` reads:** the page's dialog (`commonDialog.xhtml` only),
    a prompt for the tab's site, the notification bars, the main tool bars without the tab strip,
    and the menus (the application menu's main view); everything else left out and counted; never
    `about:logins`, another extension's page, saved cards and addresses, the password manager's
    prompt, the logins' autocomplete or a password field.
40. **§3's `firefox_press`:** confirmed by default, not by the switch; a prompt for a site and a
    notification bar (pop-ups, DRM) always asked with their words, whatever the commit guard and
    the tool's state; with the commit guard on, a dialog's choice only after the owner's yes; the
    tab, its window and the control read again right before `doAction`, any change refused with
    what changed; the network gate on the tab's page around it.
41. **§3's never-press list:** `about:config`, `about:addons`, `about:debugging`,
    `about:profiles`, `about:support`, `about:policies` and the whole of `about:preferences` (its
    panes are one document, and its General pane holds the proxy, the applications for file types
    and the updates), Firefox's add-on doorhangers (installs, permissions, optional ones such as
    `userScripts` and private windows), a site's request to share the screen or a window, and a
    page dialog with a password field; refused whatever the rules, the commit guard and the tool's
    state; read as the rules say.


Added from WP8a (the sidebar's proxy, its relay and turn marking; Kai's design, WP24, has each with
its reason):
42. **§8.2's flow control:** a window in bytes on Kai's side, `browser.sidebar_ahead_mb` (default
    4 MB, 0 none), one piece always going; cumulative acks counted like `end`'s `seq`, made by the
    sidebar page as it takes each piece from its port, for whole answers and streams alike (only a
    stream's consumer may pace: a whole answer acked only once complete would stall forever past
    the window), and only passed on by the background; an ack above the pieces sent counts those.
    WP8b's transport must ack so.
43. **§8.2's admit list:** the Chat's call sites as lmgw's WP3b left them (`lmgw-chat-ui` and the kit
    pieces it renders), 51 routes, not the whole Chat plane: the profile editor's writes,
    `GET /chat/api/profiles/{id}` and `GET /chat/api/folders` (the Chat reads the folders in the
    threads' list) are out; `{id}` is any `i64`, every segment checked percent-decoded (no empty,
    `.`, `..`, `/` or `\`); queries are passed on, checked only for their characters.
44. **§8.2's headers:** the page may send `content-type` and `last-event-id` only, anything else
    refused (400 `header_not_admitted`), not dropped; the page reads `content-type`,
    `content-disposition`, `retry-after` and `x-lmgw-*`; content types pass as lmgw sent them.
45. **§8.2's bounds:** the page says whole or stream (`read`); `window.proxy_max_mb` bounds a
    request's body and a whole answer, `window.proxy_timeout_s` a whole exchange and a stream's head;
    both settings shared with the settings window's Personality page.
46. **§8.2's bodies:** a request's body inside its `req` frame (text or base64, split like any long
    frame); an answer as text where it is UTF-8 JSON or text, or an SSE or JSON stream decoded as SSE
    decodes, base64 otherwise.
47. **§8.2's cancel:** `abort` gets nothing back, the background drops late frames of a dropped id,
    a closed sidebar aborts its requests, the link's end ends them with `no_link`, Kai leaving its
    gateway (a re-pair, a revocation) with `gateway_left`, which the page shows.
48. **§8.3's turn marking:** for Kai's voice only (K16, K17); it never touches `Caller::Own`, so the
    sidebar's tool calls stay Kai's own and the owner's act. A new turn's route marks its thread,
    and the mark lives while its request is open and then until the core read the thread's next
    `turn.started` or `turn.done`; the first own non-voice `turn.started` of the thread takes it. A
    resume is read as the turn it resumes, whoever decided its calls; one of a turn Kai never saw
    start is the sidebar's only when the sidebar sent the verdicts. Any other own turn is Kai's. A
    cancelled turn's late `turn.done` does not end its successor. Its calls are not Kai's own even
    in the conversation's thread.
49. **§4.4's sender check:** the port `kai-sidebar`, `sender.url` without query and fragment equal to
    `sidebar/sidebar.html`, no `sender.tab`, the extension's id; others get `refused` and are
    disconnected.
50. **Kai's refusals** are `res` frames in lmgw's error shape, one code per reason; a Kai without the
    sidebar's proxy refuses 503 `no_proxy`, on `browser.sock` and on the voice's link alike; a
    `req` under an id already open is an `error` frame (`duplicate_req`), which the background ends
    at the page as an `end` with that error, aborting Kai's request under the id.

Added from WP8b (the sidebar page):
51. **§10's build output:** `extension/sidebar/` is built at package time (CI's `sidebar` job, or
    `scripts/sidebar.sh release` on a desk) and never committed; signing refuses a build that
    `target/sidebar-build.json` does not tie to the commit's `sidebar/` and `LMGW_PIN`, and a
    folder that does not hash as that build left it (each file's path and bytes, checked again in
    the staged copy). *Revised in the fix round:* the record holds the output's hash.
52. **§10's lmgw crates:** staged from the pinned tree with `git archive`, so a local build never
    takes lmgw's working tree; lmgw-ui's `app.css` and its IBM Plex fonts ride along until the kit
    carries the base components (lmgw's §9.8). *Revised in the fix round:* a release build checks
    the staged files against `git ls-tree` of the pinned tree before and after it builds
    (`lmgw-pin.sh verify-staged`) rather than staging again each time (which would rebuild lmgw's
    crates on every release build); it needs the lmgw checkout that has the tree, which every
    build path has.
53. **§8.1's toolbar button** toggles the sidebar instead of opening the options page, which stays
    in about:addons and behind the strip's "Kai is not linked"; **the shortcut** is `Ctrl+Alt+K`;
    the sidebar does not open at install.
54. **§8.2's acks:** a whole answer's pieces as they come off the port, a stream's as the Chat takes
    them (the one place that paces Kai); none coalesced.
55. **§8.2's port:** opened again after 1 s, doubling to 30 s, while the page cannot reach the
    background; not after a refusal, whose reason is shown.
56. **§8.2's feed cursor:** the transport keeps it and resumes a feed the Chat opens without one,
    since the Chat drops its own when the lost link locks it; a `400` to the kept one is asked again
    without it; `gateway_left` drops it.
57. **§8.2's `gateway_left`:** a notice over the Chat with Reload, which mounts the Chat afresh
    (the threads may be another lmgw's); a `401 session_required` is a notice too and locks the
    Chat until the next link.
58. **§8.2's location:** in memory only, so a sidebar opened again starts at the first thread;
    `dashboard_href` answers `None`, so the Chat leaves its dashboard links out.
59. **§8.1's site rule from Kai:** a `site` frame Kai answers itself from the rules its tools apply
    to a frame (`SiteRules::frame_rule`, read for every question: `"null"` gets the strictest
    rule, as `""` does), addresses in a list so `page_text` asks one question for its frames;
    nothing goes to lmgw. *Revised in the fix round:* `frame_rule` instead of `rule`, which gave
    `"null"` `act`.
60. **§8.1's Attach this page:** web pages and local files only (no `moz-extension:`, Firefox's own
    pages, `data:`), refused before reading on a `none` site, pinned to the top document whose rule
    was asked (item 70), frames of `none` sites one line in their place; the text as Kai's
    `page_text` lines without refs, as a `text/plain` file named after the title at its whole
    length, headed "Page: <title> (<URL>)" with the read document's title and URL; through the
    Chat's drop path, from the strip, a drop nothing took said in a toast. *Revised in the fix
    round:* the pinning, the header from the document read, no 80-character cut of the name (a
    guessed limit; lmgw takes the name or says why not), the untaken drop.
61. **§8.1's hints switch:** the labels on the active tab while it is on, following tab switches
    and navigations, never on a `none` site, gone when the sidebar closes.
62. **§8.2's policy:** lmgw's §8.9 policy on the sidebar page as its `<meta>`; the manifest's
    `extension_pages` is §8.9's directives with the `connect-src` the background needs (`'self'
    http: https: file: data: blob:`) and Firefox's `upgrade-insecure-requests`, since it governs the
    background, whose fetches §8.9's `connect-src 'self'` refuses. *Revised in the fix round:* it
    was Firefox's MV3 default plus `'wasm-unsafe-eval'`, so a page that lost its `<meta>` had
    almost no policy; now it keeps all of §8.9 but `connect-src`.
63. **§8.4's measurement marks** in the shipped loader (`kai-wasm-started`, `kai-first-frame`,
    `kai-thread-drawn`): three `performance.mark` calls and one observer that stops at the first
    message.
64. **§10's paths in the wasm** are remapped (`/cargo`, `/rust`, `/kai-firefox`) by a generated
    cargo configuration for the wasm32 target, not by `RUSTFLAGS`.
65. **§10's source archive** carries a `rust-toolchain.toml` written at signing from
    `scripts/ci/rust-version` (none in the repository's `sidebar/`, so desks keep their toolchain)
    and `build-for-amo.sh`, which clones the public lmgw at `lmgw_tag`; lmgw's crates are not
    uploaded to AMO. *Revised in the fix round:* the version is the pin, not the build's rustc, and
    a real signing refuses a page built with another Rust or a distribution's build (`rustc
    --version` with a suffix after the date); a dry run warns.
66. **§10's CI image** for the page is Fedora 44 pinned by digest, with rustup's Rust at
    `scripts/ci/rust-version` (Fedora's `rustup` package, the toolchain from rustup) and the tools
    pinned by Kai's install scripts (copied to `scripts/ci/`). *Revised in the fix round:* it was
    `fedora:latest` with dnf's Rust, whose patches, LLVM and paths a reviewer's rustup build does
    not have.
67. **§8.2's Mermaid:** a stand-in for lmgw's 5.6 MB Mermaid script, which AMO's validator does not
    parse (an error), so diagrams show their source in the sidebar with a sentence saying so.
68. **§13's real run** drives Kai's server and relay from a Kai test (`just live-check-sidebar`)
    rather than Kai's whole process, with a dev lmgw from any headless build that has the Chat
    plane's routes (the script takes its path).

Added from WP8b's review round:
69. **§8.1's rule words:** `act` and `read` are the only words that let anything through; any
    other word Kai sends, or none, is `none` in the strip and in the background alike (it was `act`
    in the strip for a missing word, and only `none` itself was refused in the background).
70. **§8.1's pinned read:** Attach this page and the hints switch take frame 0's `documentId`
    before Kai is asked and send every top-frame call of the read to that document alone; a
    navigation that commits meanwhile fails them with `page_changed` rather than reading the page
    after it, and the rule is checked against the URL the read document had. A `pushState` within
    the document asks Kai again; a navigation after the read's last call does not fail it.
71. **§4.2's `takes`:** Kai's `welcome` lists the extension's frames it takes, and the extension sends
    the sidebar's `site` only to a Kai that lists it (a Kai before the list gets no question, and
    the strip says "update Kai" at once); a frame with an `id` that Kai does not take is answered
    with `error` `unknown_frame`. `protocol` stays 1: the frames are additive, and the established
    rule raises it only for a change that is not.
72. **§8.2's preview policy** restricts scripts only (`content_security_policy.sandbox`), so a
    previewed page can load images and fetch from anywhere, as the dashboard's `srcdoc` preview
    can: model-written HTML could carry page text out through an image URL. `connect-src 'none'`
    alone would not stop images; restricting `img-src` too would break previews that show remote
    pictures. Left as the dashboard has it. `web-ext lint`'s one `MANIFEST_CSP` warning is this
    policy's (its `'unsafe-inline'` reads to the linter as remote code execution).
73. **§8.5's narrow head:** `sidebar.css` overrides lmgw-chat-ui's narrow `.chat-head` so Export is
    an icon on the first line at 280 px, until lmgw-chat-ui's head does not wrap itself (lmgw's
    §9.8).
74. **§10's font licence:** kai-firefox ships IBM Plex's OFL text beside the fonts
    (`fonts/OFL.txt`) from its own `sidebar/assets/`, since lmgw's crates carry none yet; signing
    refuses a page with fonts and no licence text.
75. **§8.1's hint races:** the strip records what it asked before its calls go (a generation), and
    the background hides labels whose drawing finished after the page turned them off or its port
    went, failing that call with `hints_off`.

## Appendix: Built so far (v5 → v6, 2026-11-03)

WP6, WP7, WP7b and WP9 each had a review and a fix round, lmgw's WP2 a review round of
lmgw's; the logs of WP11a and of WP0 (d)'s repair have no fix commit. A decision marked *taken in
this draft* was taken while the package was built, not by the owner; listed in
§14 items 8 to 26. The wire facts are in `docs/protocol/operations.md`.

| WP | Built | Review and fix round | Decisions, and where they went |
|---|---|---|---|
| 6 (kai-firefox `0538ac2` to `42812bd`, Kai `3ede1fd` to `8734795`) | acting operations and tools, the commit guard and the network gate, `focus.check@1` and `gate.result@1`, the tab facts, `history.seen@1`, the sandbox container; the trusted path | Review, fix round: Kai's input in input spans instead of the user's facts, `history.seen`'s `seen_by_user` (kai-firefox `3b68ccd`); the guard's verdicts in one dialog and its second look, the window by the host's parent pid, an approval in lmgw no longer sparing a ref-only call or the real key, `element_file`'s file opened at the preparation (Kai `8734795`) | `tab_open` and `tab_go` no longer confirmed by default, guard stems and look-alike letters (§6.4, §13); the window and the focus report (§6.3, §13). *Taken in this draft:* approvals and the real key, input spans' settling, the marks across restarts (§6.3, §6.4) |
| 7 (kai-firefox `64b3aa4` to `1a0816a`, Kai `705b504` to `622a4c8`) | Firefox's features, source and DOM, styles, scripts, screenshots | two reviews, fix rounds: the frames tree, origins pinned (`page_changed`), the overlay guard, `fetch_origins` and `page.css_check@1` (kai-firefox `8098731`); CSS's own tokenizer, `css_var_url`, `origin_before`, `page_source`'s frames list (`3b69368`); Kai's blanking, redaction and fetch questions (Kai `622a4c8`) | §5.3, §5.5 to §5.8, §6.4. *Taken in this draft:* strict `fetch_origins`, the redaction, the blanking (§5.3, §5.6, §5.7) |
| 7b (Kai `365b3d5` to `0db5c8e`) | the site rules in Kai's desktop tools | Review, fix round (Kai `5af69d2`): Firefox's and the desktop's chords, one look over a Firefox's windows, pages without a host, `browser.see_settle_ms`, KWin's effects, `DocURL`, the exact window name | §6.7, §13. *Taken in this draft:* the window by its tab in front, untold windows, the chords, the effects |
| 9 (kai-firefox `72895a7` to `4913149`, Kai `4f7f2e8` to `98f8891`) | events, Kai's direct speech, announcements, reading aloud | Reviews, fix rounds: coalescing, `seq`, `at` and `by_kai`, the download's `source`, `field_error`'s `regions` (kai-firefox `6cd088a`, `b95c8be`); `read_ended` and `marked: false` with `why` at Kai's request (`4913149`); Kai: one event per frame in `seq` order, the speak-once rule, one request per sentence, the gates, the echo rule (Kai `c7ed550`) | §5.1, §7.2 to §7.5, §13. *Taken in this draft:* §7.4's event, reading and clean-up rules; Kai's echo rule, words, request, quiet moment, maximum age and reading failures (Kai's design WP24) |
| 11a (kai-firefox `f1e8efc`) | `npm run sign`; WP0 (g): 0.1.0.47 signed in 2 min 19 s from `b95c8be`, its source attached | — | §10, §12. *Taken in this draft:* the script's clean tree, staging and archive |
| 0 (d) (kai-firefox `c860469`, a run on a Plasma session, 2026-11-03, d2 `09bf357`) | the self-test on a private runtime folder; the check preflights the bus and cleans up after an abort; a run on the Plasma session (baseline, default, force); `atspi-selftest.sh --docurl`, the DocURL, attributes and frames of every document of a headless Firefox on the private bus | — | §3, §6.3, §6.7, §12 (WP12 unblocked). The run: on the bus with `IsEnabled` on before Firefox starts, page and UI and alert exposed, `doAction` trusted and user-activated, file picker not observed, memory not measurable; d2: `DocURL` right for pages and frames, empty for `data:` and `blob:`, a first `NActions` read can be 0 |
| lmgw 2 (lmgw `3b54091b` to `24611bd0`) | the Chat on Chat-plane routes only | review round, no blocker, no high: the live source handed by the host, a device's file text behind `kb__read` and its switch, no original for a device, the picker's detail starting no agent (lmgw `79de4528`, `a6ce04a5`) | §8.1, §8.2 (lmgw's D1 to D17) |
| 8a (kai-firefox `feat/sidebar-proto`, Kai `feat/browser-sidebar-proxy`) | the sidebar's requests: the background's relay, Kai's proxy, the window and the acks, the turn marking | Review, fix round: whose a turn is follows the turn (a resume read as the turn it resumes, a mark that waits for the feed, a cancelled turn's late `turn.done`, the running list on the approval card), encoded dot segments refused, the ack rule for whole answers, `GET /chat/api/folders` out, an ack bounded by the pieces sent, Kai's `error` frame ending the page's request, `gateway_left` at a re-pair, the full `i64` range for ids | §8.2, §8.3, §13, §14 items 42 to 50; Kai's design WP24 |
| 8b (kai-firefox `feat/sidebar`, Kai `feat/sidebar-page`) | the sidebar page on `lmgw-chat-ui` (lmgw 4add6051): its transport and host, the preview page, the policy, the toolbar button and shortcut, the site strip with Kai's `site` question, Attach this page, the hints switch; the build, signing and CI; the e2e from the real panel and one real run through Kai's server and relay to a dev lmgw | Review, fix round: Attach this page and the hints pinned to the document whose rule was asked (`page_changed`), the rule words fail closed, signing checks the built output's hash and the staged lmgw crates against the pinned tree, rustup's pinned Rust in both CIs and the source upload, `"null"` as the strictest rule in Kai, an untaken drop said, the hint races, the feed reader per stream, no cut file name, the refusal shown, Kai's `takes` and `unknown_frame`, the manifest's policy widened to §8.9, the narrow head, the fonts' licence | §4.2, §8.1, §8.2, §8.5, §10, §11, §13, §14 items 51 to 75; Kai's design WP24 (the site question); lmgw's chat-plane §8.9 and §9.8 (as-built note, the seams) |

| 10b (kai-firefox `feat/handsfree`, Kai `feat/browser-handsfree`) | the acceptance runs' design findings: the focus rule hands free and pressed links, Kai's own questions by voice, the guard's words off GET links, role words for inputs, live regions' names, beacons and pings never held; the runs extended (`tests/accept/RESULTS.md`) | security review, fix round: the owner's moves narrowed to the listed ones and to where they landed as meant (the extension's `goes`), every acting operation Kai's navigation before it is sent, the owner's marks only while the switch is on, no owner's move during a job's continuation, one spoken question at a time and the press for the one heard last, no pre-roll and Kai's own voice silenced in a spoken answer, the guard's words kept on links that may act by script, the trusted key's question spoken, a file's name after the field's | §6.4, §7.1, §7.4, D5, §14 items 27 to 36; Kai's design WP24 |

At v6, WP10 (the acceptance runs) was in progress and lmgw's WP3 was next; both are built (§12).

## Appendix: Built so far (v4 → v5, 2026-11-03)

Each package had a review and a fix round. A decision marked *taken in this draft* was
taken while the package was built, not by the owner; listed in §14. The
wire facts are in `docs/protocol/operations.md`.

| WP | Built | Review and fix round | Decisions, and where they went |
|---|---|---|---|
| 1 (Kai `ae7b26f`) | `browser.sock` with the peer check, `kai-browser-host`, the dev manifest, `just browser-dev` | Review, fix round; the findings are in the appendix "WP0 and WP1 into v4" | Kai's `error` codes `id_too_long` and `bad_split`; the host's and Kai's `error` frames pass through a split being joined (§4.2) |
| 4a (kai-firefox `7517cba`) | the MV3 extension: the link, hello, refs, `tabs.*`, `context.get@1`, frame splitting both ways; the test harness; the operations contract | Review, fix round: navigations answer for the one asked for and always end, refs stay unique across extension restarts, sensitive values stay out of names (`56489aa`) | the counter in `storage.local`, begun again only at Firefox's start; `documentId` is a UUID string (D4); the extension answers a split it cannot join with `bad_split` (§4.2); `nav_start_ms`, `nav_load_ms` and the backoff of `retry_ms` (§9) |
| 4b (kai-firefox `5b8192b`) | the reading operations, hints and the pointing ring | Review, fix round: sensitive fields stay out of find, Kai's labels out of the page's text, "in view" knows scroll containers (`0b9bfaf`); text directly in a shadow root is read (`5b8192b`) | sandboxed frames are read, unread frames are listed with origin, reason and title (§5.3); `content_ms` (§9); errors carry the tab as fields (§5) |
| 5 (Kai `34ecc2d`) | the `browser` area and provider: tools, routing, D3's listing, policy, site rules, the switch | Review, fix round | site rules as three lists, `none` tabs left out of `tab_list` (§6.4); the switch's scope, `tab_switch` and `tab_mute`, the counted approval, marking Kai's own tabs, `tab_open` and `tab_go` confirmed until WP6 (§6.4); the warning's notification and banner (§8.3). *Taken in this draft:* a frame's own origin decides its rule; the view tools; the warning once per start, in memory; two profiles' numbers (D4) |
| 5b (Kai `8540e09`) | the reading handlers over WP4b's operations | Review, fix round | PDF text in bubblewrap with visible limits, unreadable lines judged one by one (§3, §5.3); unread frames named (§5.3); `hints_show` marks "(hint N)" (D4, *taken in this draft*) |

At v5, WP6 (acting, the commit guard, the network gate) was in progress; it is in the appendix above.

## Appendix: WP0 and WP1 into v4 (2026-11-03)

| Source | Finding | Where |
|---|---|---|
| WP0 (a) | the background's native port keeps it alive (40 min); page ports do not; the sidebar port drops when it is suspended | D1 |
| WP0 (a) | stdin close, SIGTERM at +3 s, SIGKILL at +6 s on every lifecycle event; a host ignoring EOF delays quit by 6 s | §1 |
| WP0 (a) | the cap toward the extension is exactly 1 048 576 bytes and one more closes the port; large messages toward the host are quadratic | §4.1 |
| WP0 (b) | `userScripts.execute` returns values and per-frame errors; uncloneable results fail; no `eval` | §5.8, §11 |
| WP0 (c) | the sidebar works under the CSP; `srcdoc` inherits it, so the preview needs a sandbox page; Trunk's inline loader; `data-theme`; 338 px; scrollbars; sizes | §8.2, §8.5, §10, §11 |
| WP0 (d) | AT-SPI exposes pages, UI and alerts and `doAction` is trusted, on a private bus; on a Plasma desktop session | §3, §6.3 |
| WP0 (e) | manifests only under `~/.mozilla`, never XDG | §11 |
| WP0 (f) | naming cost; `placeholder` fallback; `::before` option; 64-bit frame ids; `documentId` | D4, D5 |
| WP0 (h) | `pdftotext` without `-layout`, whole, with notes for scans and broken encodings | §3, §5.3 |
| WP1 | `refused`, `error`, split frames and their join contract, the conversation rules, innermost-unit scope matching, the unit name of a Firefox started from a link | §4.2, §4.4 |

## Appendix: The owner's answers (v2 → v3, 2026-11-03)

| v2 question | Answer | Changed |
|---|---|---|
| Q1 the sidebar as a second device | the sidebar is Kai; warn, do not prevent | decision 9, D7, §8.3, §6.4, §4.4, §1 |
| Q2 what a device sees | Admin Chat is not needed in the browser | decision 10, §8.1 |
| Q3 where builds live | GitLab for all builds, GitHub for targeted releases | decision 11, §10 |
| Q4 tools listed while Firefox is closed | 55 tools are too many to keep for a prefill | decision 12, D3, §2, §4.3, §5.9 |
| Q5 §6.4's defaults | confirmed | decision 13 |
| Q6 announcements without a model | yes | decision 14 |
| Q7 the name and id | yes | decision 15 |

## Appendix: Review dispositions (v1 → v2, 2026-11-03)

*v3 changed the dispositions of findings 1 and 11 by the owner's decisions 9 and 12.*

A review of v1 against Kai f370fb0, lmgw 81ddd11b and Firefox 159. Every finding was taken.

| # | Finding | Disposition |
|---|---|---|
| 1 | The sidebar as Kai's own device would make page-fed chats `Own` (microphone, configuration tools, Kai's lmgw admin level) | D7, §8.3: its own device, held by Kai; §14 Q1 |
| 2 | Per-document numbers cannot tell tabs and frames apart; staleness was unspecified | D4: refs from one counter in the background, mapped to tab, frame, `documentId` |
| 3 | The trusted key could land in the sidebar or approve Kai's own overlay; it bypassed `key_press`'s policy | §6.3: focus check, overlay wait, `key_press`'s state; §5.8 tab naming for approved scripts |
| 4 | Injection on the active tab, the focus rule bypassed by tab tools, GET exfiltration, attachments as user text, `allow_trusted`'s reach, two defaults | §6.4 rewritten; D9 |
| 5 | The guard's window was a hidden constant; its gaps and asking path were unspecified | §6.4: visible settings, `documentId`, `ask` frames, the gaps named |
| 6 | `browser.sock` was compared to `cli.sock` wrongly; any same-user process could use the sidebar's reach | §4.4: Firefox app-scope peer check, sidebar-only `req` |
| 7 | "Any thread" is untrue for a device; the admin routes list was incomplete; HTML preview, exports, proxy timeout | §8.1 "What a device sees", §8.2 completed, D1 to 154, §14 Q2 |
| 8 | AT-SPI coverage claimed where none works today; PDFs, private windows, quarantined domains missing | §3 rewritten |
| 9 | Accessibility holes: dialogs, frames, tables, element lists, sliders, drag, inner scrolling, hover, comboboxes, files, fill data, masking, captions, voices | §5.3, §5.4, §5.1, §6.2, §7, §13 |
| 10 | Rich editors, CSS origin, `replaceSync`, `page_source`, shadow DOM serialisation, `downloads.open`, the permission prompt, the shortcut, `cookies`, the container's limits | §5.4 to §5.8, §6.4, §8.1 |
| 11 | D3 could not know the operations of a closed Firefox; no unlink; two profiles | D3, D4, §2 |
| 12 | Mode-dependent parameters, a hidden "last three", `page_text` not whole, the tool count, the switch's scope and names | §5.3, §5.4, §5.9, §7.2, §7.3, §6.4 |
| 13 | K25's screenshot setting | §5 (`returns_images`) |
| 14 | Announcements in Kai's own voice, floods, site rules, when they speak | §7.1, §7.2 |
| 15 | WP order, duplicated host packaging, the host's parsing, chunking direction, XDG folders, Flatpak wording | §12, §4.1, §4.2, §11, §4.5 |

# Kai for Firefox

A Firefox extension that gives [Kai](https://github.com/lmgw-dev/kai) hands and eyes in your
browser, and puts lmgw's Chat in a sidebar beside the page.

Kai is a voice assistant for the KDE Plasma desktop. It runs no models itself: they come from
[lmgw](https://github.com/lmgw-dev/lmgw), a local model gateway that runs models on your own GPU
and can route to cloud providers too. With this extension, Kai can read and operate the pages open
in Firefox, whether you talk to Kai, type in lmgw's Chat or use Kai on your phone, and whether the
sidebar is open or not.

## What it does

**Kai uses Firefox for you.** Kai gets a set of browser tools, which lmgw lists to models under
Kai's label (for example `kai__page_text`):

| What | Tools |
| --- | --- |
| Where you are | `browser_context`: your tab, the focused element, the selection, what's under the pointer, how far down the page you are |
| Tabs | `tab_list`, `tab_open`, `tab_go`, `tab_switch`, `tab_close`, `tab_back`, `tab_forward`, `tab_reload`, `tab_mute` |
| Reading | `page_outline`, `page_controls`, `page_links`, `page_fields`, `page_text`, `page_text_all`, `page_text_visible`, `element_text`, `table_read`, `page_selection`, `page_find`, PDFs in Firefox's viewer |
| Looking | `page_see`, `element_see`: screenshots for a vision model |
| Acting | `element_press`, `element_fill`, `element_choose`, `element_check`, `element_file`, `element_focus`, `element_hover`, `element_drag`, `element_show`, `element_scroll`, `page_scroll`, `page_key` |
| Pointing | `hints_show`, `hints_hide` (numbered labels over the controls in view), `element_point` |
| Firefox's features | `page_zoom`, `reader_view`, `bookmarks_find`, `history_find`, `downloads_list` |
| Reading aloud | `read_aloud`, `read_aloud_from`, `read_pause`, `read_resume`, `read_skip` |
| Firefox's own pages and dialogs | `firefox_ui`, `firefox_press`, through the desktop's accessibility |
| For developers | `page_source`, `page_dom`, `element_dom`, `page_css`, `page_css_remove`, `page_script`, `page_script_main` |

Every result that comes from a page starts with the tab's title and address, so page text is never
mistaken for your words.

**Hands and eyes.** The same tools let Kai help while you keep browsing. You ask, Kai acts on the
tab in front of you:

- **Eyes:** "what is this page", "read the article", "what does the error say", "what did the
  button do".
- **Hands:** "open the second result", "fill in the form", "scroll down", "go back". Ask Kai to
  show hints, and every control in view gets a number, so "press 14" works.
- **What changed:** Kai can say on its own that a page loaded, a dialog opened, an error appeared
  at a field or the page reported something, without a model turn.
- **Reading aloud:** a page read paragraph by paragraph, with the paragraph highlighted, and pause,
  resume and skip.

Accessibility is a supported use case, and it is tested: acceptance runs go through Kai's real tool
path and do a search, open a result, read a product and a comparison table, hear a form's errors,
fill a form, attach a file, submit through the commit guard and close a cookie banner, with no
mouse or keyboard input from the tester ([tests/accept/RESULTS.md](tests/accept/RESULTS.md)).

**The Chat beside the page.** The sidebar is lmgw's full Chat in a narrow column: folders,
threads, search, tools, approvals, attachments and the composer. They are your usual threads, so a
conversation started here continues in lmgw's dashboard or on your phone. Kai's own conversation
is one of them. The head has a New chat button that starts the chat in the open thread's folder
(in Kai's folder it becomes Kai's new current conversation), and a "Back to" button returns to
Kai's current conversation. Above the Chat, a strip shows:

- the site of the tab you're on and Kai's rule for it (`act`, `read` or `none`, see
  [Site rules](#site-rules));
- a **Hints** switch that shows the numbered labels on the page;
- **Page** (Attach this page), which adds the page's readable text to the open thread as a text
  file, headed with the page's title and address.

## Requirements

- **Firefox 154 or newer**, as a regular package (Fedora's RPM, for example). A Flatpak or Snap
  Firefox can't reach Kai yet. Other browsers aren't supported yet.
- **Kai 0.3.0 or later** on the same computer, paired with lmgw. Its RPM includes the Firefox link
  (`kai-browser-host`); earlier releases don't have it. See
  [Kai's README](https://github.com/lmgw-dev/kai#install) to install and pair Kai.
- **lmgw 0.6.0 or later**: the sidebar is built on its Chat.
- For Firefox's own pages and dialogs, the desktop's accessibility has to be on when Firefox
  starts.
- Nothing else. The extension talks only to Kai, through Firefox's native messaging. It holds no
  key or token, opens no connection to lmgw and runs no service of its own. Kai reaches lmgw with
  its own device certificate.

## Install

1. **Install Kai and pair it with lmgw.** Kai's RPM also installs the native-messaging host
   (`/usr/libexec/kai/kai-browser-host`) and registers it with Firefox
   (`/usr/lib64/mozilla/native-messaging-hosts/dev.rootshell.kai.json`). There is nothing to set up
   by hand.
2. **Install the extension.** It is signed by Mozilla as an unlisted add-on, so it is not on
   addons.mozilla.org; it comes from this repository's releases. Either:
   - in Kai's settings window, open the **Firefox** section and click **Install Kai for Firefox**
     (Firefox has to be your default browser for this; a Kai build without an install link explains the
     manual install instead), or
   - open the [latest release's XPI](https://github.com/lmgw-dev/kai-firefox/releases/latest/download/kai-firefox.xpi)
     in Firefox and confirm the installation, or
   - download the XPI from the [latest release](https://github.com/lmgw-dev/kai-firefox/releases/latest)
     and choose **about:addons → ⚙ → Install Add-on From File…**.
3. **Check the link.** With Kai running, the Firefox section of Kai's settings counts the linked
   Firefox profiles, and the extension's options page (in about:addons) shows whether Kai is
   linked. While Kai is not running, the toolbar icon and the sidebar say so, and the extension
   keeps trying.

Kai takes the link only from a Firefox that Plasma started (from the application menu, a link or
autostart). A Firefox started from a terminal runs in the terminal's unit and is refused; Kai's log
names it, and **Firefox's app scopes** in Kai's settings lists the units Kai accepts.

### Updates

A copy installed from a GitHub release updates itself from GitHub: Firefox checks this
repository's latest release, the way it checks any add-on, and installs a newer version. Pre-releases
are not offered. A copy you signed yourself has no update address and is updated by hand.

## Use it

- **Open the sidebar** with the toolbar button or `Ctrl+Alt+K`. Change the shortcut in about:addons
  under **⚙ → Manage Extension Shortcuts**.
- **Ask Kai** by voice, in any lmgw Chat thread whose tools include Kai's, or from the phone. With no
  tab named, Kai works on the tab in front of you.
- **The extension's options page** has the timeouts that only the extension decides, Firefox's
  permissions that need a click from you (user scripts for the script tools, access to local
  files), and the link's status.

Everything about policy (site rules, which tools ask, the guard, announcements) is Kai's
configuration, the same for every device: Kai's settings window, its **Firefox** section and its
**Tools** page.

## Site rules and approvals

Every page Kai reads is text from a stranger, and a page can carry instructions aimed at the model:
an e-mail, a comment, a review. In Firefox, Kai acts with your logins. The rules below keep the
common case quick and make the risky steps visible. They don't make such instructions harmless.

### Site rules

Each site gets one of three rules, set in Kai's settings (**Firefox → Site rules**) by host
(`mail.example`), domain (`*.example`) or origin (`https://shop.example:8443`):

| Rule | What Kai may do there |
| --- | --- |
| `act` (the default) | read and act |
| `read` | read only; tools that act on the page are refused |
| `none` | nothing: no reading, no acting, no announcements, and its tabs are left out of Kai's tab list |

The most specific entry wins. A frame inside a page gets its own site's rule: a `none` frame is
left out of what Kai reads and blanked in screenshots. The rules also apply to Kai's desktop tools
when they look at or type into Firefox's windows. The sidebar's strip shows the rule but can't
change it yet.

### What runs without asking

- **By default**, reading tools run for you and for callers you trust, and every tool that acts on
  a page asks first. `element_file` and the script tools always ask unless you change their
  setting on Kai's **Tools** page.
- **"Kai may act in Firefox without asking"** (the hands-and-eyes switch in Kai's **Firefox**
  section) lets the tools that switch tabs, act on pages and read aloud run unasked for you and
  trusted callers and offers the tools made for using Firefox by voice (`page_links`,
  `page_fields`, `table_read` and reading aloud). Attaching a file still asks. A tool's own setting
  on the Tools page wins. Announcements follow their own switch (`browser.announce`) alone: turning
  hands and eyes on in Kai's settings window also turns announcements on, visibly, and you can turn
  them off again.
- **Only on the tab you're on.** Even then, Kai acts unasked only on the tab you brought to the
  front yourself, on the site where you last acted. On any other tab or site it asks, unless you
  switch on **Act in background tabs without asking**.
- **Ask before committing** (on by default) asks before Kai presses or submits something whose name
  holds one of the guard's words (buy, order, pay, delete, send and others, in English and German;
  the list is editable), before a form goes to another site, and before Kai opens a site your
  history has never seen. Writes the page sends right after an action (`POST`, `PUT`, `PATCH`,
  `DELETE`, within two seconds by default) wait for your answer, shown with their method, address
  and body.
- **Some pages need a real key press** (a link that opens a new window, a media or full-screen
  control). Kai then brings Firefox to the front and presses the key through the desktop, but only
  when the page has the keyboard focus.

Questions come as Kai's dialog on the desktop or as an approval in the Chat, the sidebar included.
For Kai's own calls (its voice, what you type to Kai, the sidebar), Kai also says the question
out loud, and you can answer it by pressing the talk key and saying yes or no.

### What the guard doesn't see

The commit guard watches the page's requests right after an action. It doesn't see requests from
workers, WebSocket or WebRTC traffic, `GET` requests a page sends by script, writes after its
window, or `sendBeacon` and link pings. Letters of other scripts that look like Latin
ones (a Cyrillic "о" in "оrder") don't match the guard's words yet.

### lmgw's admin level

The sidebar is Kai: it reaches what Kai's device reaches in lmgw, including the device's admin
level for lmgw's self-administration tools. While that level is **read only** or **full** and
Firefox is linked, Kai warns you once per start
and again whenever the level is raised, because a page's text could then steer a model to lmgw's
configuration and to the tools that run programs. The warning prevents nothing. Setting Kai's admin
level to **off** in lmgw is up to you.

## Privacy

**What leaves the browser, and where it goes**

- **To Kai** on your computer: what Kai's tools read (page text, screenshots, the page's fields
  with passwords and card numbers masked), the pages you attach in the sidebar, the change reports
  while announcements are on, and the sidebar's Chat requests. What you type in the sidebar carries
  a line naming the tab beside it (its title and address; for a site whose rule is `none`, no tab
  is named), stored with the message in lmgw and shown under it, so the model knows where you are
  writing from.
- **Through Kai to your lmgw:** tool results and the Chat. lmgw keeps them in the thread for its
  retention, and sends them to the model the thread uses. If that model is a cloud model, the page
  text goes to that provider like the rest of the conversation.
- **Nothing to anyone else.** The extension has no telemetry and declares no data collection to
  Firefox. Firefox's own update check fetches the update file from GitHub.

**Permissions.** The extension asks Firefox for access to all sites (to read and act on any page
you open), native messaging (the link to Kai), tabs, navigation and request events (the commit
guard), history (the guard's "never seen" check and `history_find`), bookmarks, downloads, search,
find, storage, and containers with cookies (`tab_open` can open a tab in a "Kai" container without
your cookies). User scripts are optional and only asked for when you grant them on the options page.

## Limits

These are not built yet:

- **Other browsers.** Firefox only; no Chromium yet.
- **Flatpak and Snap Firefox** (the extension says "Kai cannot be reached from a sandboxed Firefox
  yet").
- **Private windows.** Kai has no access to them yet and never lists their tabs.
- **Some of Firefox's own UI:** the file and save dialogs, the address bar, the search and find
  bars, the context menu, and text typed into a page's `prompt()`. Kai reads Firefox's own pages,
  page dialogs and permission prompts through the desktop's accessibility, which has to be on when
  Firefox starts.
- **Restricted sites** that Firefox keeps extensions out of (addons.mozilla.org,
  accounts.firefox.com and others).
- **On pages:** double-click, a page's native context menu, filling in your saved addresses or
  logins, and video captions.
- **Voice in the sidebar** (dictation or a voice session): talk to Kai with its talk key instead.
- **In the sidebar:** changing a site's rule from the strip, highlighting the element an approval
  is about, keeping the open thread when you close and reopen the sidebar, and drawing Mermaid
  diagrams (their source is shown instead).
- **Simple commands without a model.** "Scroll down" is a model turn, so it takes as long as the
  model does.
- **Settings per Firefox profile.** Kai links several profiles, with one configuration for all.

Bugs and ideas are welcome in the [issues](https://github.com/lmgw-dev/kai-firefox/issues).

## Contributing

The extension is plain ES modules in `extension/`, with no build step. The sidebar page in
`sidebar/` is Rust (Leptos, compiled to WebAssembly) on lmgw's Chat crates, built by Trunk into
`extension/sidebar/`.

```sh
npm ci
npm run lint        # web-ext lint
npm run test:unit   # unit tests: no Firefox, no Kai host (what CI runs)
npm test            # unit tests, then headless Firefox with the real kai-browser-host and a fake Kai
scripts/sidebar.sh  # build the sidebar page (needs an lmgw checkout next to this one)
npx web-ext run --source-dir extension   # try it in a Firefox of its own
```

- [docs/development.md](docs/development.md): the layout, the sidebar build and the lmgw pin, and
  what the tests need.
- [docs/releasing.md](docs/releasing.md): signing with Mozilla, the update channels and the stable
  install links.
- [docs/protocol/operations.md](docs/protocol/operations.md): the operations Kai calls.
- [docs/design/2026-11-03-kai-firefox-design.md](docs/design/2026-11-03-kai-firefox-design.md): the
  design record.

## Licence

Kai for Firefox is under the MIT License ([LICENSE.md](LICENSE.md)), like Kai and lmgw.

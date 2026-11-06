# Kai for Firefox: the operations

The contract between the extension and Kai's browser provider (design §4.3, D2): what each
operation takes, what it answers and how it fails. Kai owns the tools the model sees and formats
the lines it reads; the extension answers structured JSON. This file describes extension
version 0.1.0, protocol 1. The link itself (framing, `hello`, `welcome`, `refused`, split frames,
`cancel`) is the design's §4.1 and §4.2; what follows is what travels inside `op` and `op_result`,
in the network gate's `ask` and `answer` (Questions), in the `event` frames (Events), and the
sidebar's requests to lmgw through Kai (`req`, `res`, `chunk`, `end`, `ack`, `abort`: The sidebar's
requests).

## Calls

Kai sends `{"t":"op","id":<id>,"op":"<area.verb@version>","args":{…}}`; the extension answers
once with

- `{"t":"op_result","id":<id>,"ok":<result>}`, the result being a JSON object; or
- `{"t":"op_result","id":<id>,"error":{"code":"<code>","message":"<text>", …}}`.

**An error about a tab** carries the tab's id as `tab` and, where the extension can see the tab,
its `title` and `url` as they are when the error happens:

```json
{"code": "content_timeout", "message": "tab 12 did not answer within 15000 ms (Kai for Firefox's setting content_ms): its page is busy, or its script is stuck",
 "tab": 12, "title": "Checkout", "url": "https://shop.example/cart"}
```

- Messages name a tab by its id only: they never carry its title, its URL or a part of it (a
  host, an origin), so Kai can withhold a page it may not show. The only URLs in messages are
  the ones Kai gave (`bad_url`, `url_refused`).
- `no_tab`, `private_window` (for a named tab), `tab_closed`, `stale_tab` and `session_ended`
  carry `tab` only; `nav_timeout` carries `title` and `url` while the tab is still open.
- `reader_view` adds `page`: the URL of the page Reader view shows. `not_pdf` (when the URL now
  answers something else) and `fetch_failed` (for an HTTP error) add `response_url`, the URL that
  answered, after redirects. `not_get` adds `method`, `bad_css` adds `dropped`,
  `fetch_not_approved` adds `fetches`, `script_error` adds `thrown` and `session_ended` adds `why`
  (each at its operation). `page_changed` carries the tab as it is when the error happens: its
  `url` is the page the tab shows instead.
- Errors that concern no tab carry none of them: `bad_args`, `unknown_op`, `cancelled`,
  `internal` outside a tab, `no_window`, `private_window` for the user's tab, `unknown_ref`,
  `bad_url`, `url_refused` and `no_container` of `tabs.open@1`, `unknown_gate`, `unknown_span`,
  `unknown_css`, `bad_css` of `page.css_check@1`, and `unknown_session`.

`id` is a whole number. The `hello`'s `ops` lists every operation with its version, as below.
Operations run concurrently; each answers when it is done. When the link drops while an
operation runs, the extension drops its answer: a later link never sees it.

**Cancel.** A `cancel` for a running `id` ends the operation's waiting for a navigation (the
`wait` of `tabs.open`, `tabs.go`, `tabs.back`, `tabs.forward`, `tabs.reload`, and
`reader.view@1`'s), `pdf.bytes@1`'s fetch, `page.source@1`'s wait for the page's request and its
fetch, the wait for a script's value (`page.script@1`, `page.script_main@1`; the script itself
goes on), or an acting operation's
network gate (its window and the requests it holds, Acting) at once, and it answers `cancelled`;
Kai has stopped waiting and drops that answer. The requests the gate held are cancelled (the page
sees a network error), their `decision` `cancelled`; the same for `gate.result@1`. A cancel of
`input.end@1` ends its settle wait and the span at once. An operation that has no such wait
(every other reading, hint and element operation, each bounded by `content_ms`) runs to its end
and answers its result, also after a `cancel`. A cancel never undoes what the operation did: a
navigation Firefox started goes on, a tab opened or closed stays so, a press is pressed.

**Split frames.** A frame from Kai in pieces (§4.2) that does not join (a piece missing, out of
order, interrupted by another frame of Kai's) is dropped, and the extension answers it with
`{"t":"error","code":"bad_split","split":<n>,"message":"<text>"}` only: an `op` it carried is
never run and gets no `op_result`, so Kai fails that call itself. The host's own frames (`kai`,
and `error` with `frame_too_large` or `bad_config`) may come between the pieces and do not break
them; a split cut off by the link closing is dropped without an error.

**Questions** (design §4.2, §6.4): the network gate (Acting) asks Kai about a request it holds
with an `ask` frame, and Kai answers each with an `answer` frame:

```json
{"t": "ask", "id": 7, "op": 31, "gate": 4, "tab": 12, "frame": 0, "origin": "https://shop.example",
 "method": "POST", "url": "https://shop.example/cart", "type": "xmlhttprequest", "reason": "write",
 "body": {"kind": "json", "text": "{\"item\":\"trail-lamp\",\"password\":\"password field, filled (16 characters)\"}"}}
{"t": "answer", "id": 7, "allow": true}
{"t": "ask", "id": 8, "op": 33, "gate": 5, "tab": 12, "frame": 0, "origin": "https://shop.example",
 "method": "GET", "url": "http://192.0.2.44/upload?d=…", "type": "main_frame", "reason": "unseen_origin", "body": null}
```

- `id`: the question's number, a whole number unique while the extension runs (it starts again at
  1 when the extension does). `op`: the `id` of the operation whose gate holds the request (for a
  gate `focus.check@1` or `gate.open@1` opened: that call's id). `gate`: the gate's number. `tab`: the tab;
  `frame`: the frame id the request comes from (the frame a navigation loads into); `origin`: the
  origin of the acted-on document (Origin; `null` when opaque or unknown).
- `reason`: why it is held: `"write"` (a `POST`, `PUT`, `PATCH` or `DELETE`) or
  `"unseen_origin"` (a `GET` navigation of the document to another origin than its own that the
  user has never visited: `seen_by_user` of `history.seen@1` is `false`; its URL can carry data
  out).
- `method`: `POST`, `PUT`, `PATCH` or `DELETE`, or `GET` (only with `"unseen_origin"`). `url`:
  the request's URL, whole, masked like the body. `type`: Firefox's request type (`main_frame`,
  `sub_frame` for a navigation; `xmlhttprequest` for fetch and XHR; `other` and the rest of
  webRequest's types; never `beacon` or `ping`, which the gate does not hold).
- `body`, decoded, with the values of the document's sensitive fields masked: the values they
  have now, those they had when the gate opened and those typed into them while it was open (a
  page that clears a password field before it sends it is masked all the same); each as typed,
  trimmed, URL-encoded and as JSON writes it; a form field named like a sensitive field whatever
  its value. Whole:

  | `body` | the request sent |
  |---|---|
  | `null` | no body |
  | `{"kind": "form", "fields": [["name", "value"], …]}` | form data (URL-encoded or multipart; a file field's value is its file name) as Firefox gives it: grouped by name, the names in the order of their first field, each name's values in order, a name once per value |
  | `{"kind": "json", "text": "…"}` | UTF-8 text that parses as JSON, as sent |
  | `{"kind": "text", "text": "…"}` | other UTF-8 text without control characters |
  | `{"kind": "binary", "bytes": 5, "type": null}` | anything else: its size; `files` (paths) when Firefox gives file parts. `type` is always `null`: webRequest gives the body before the headers, so the Content-Type is not known when the request is held |
  | `{"kind": "unreadable", "why": "…"}` | Firefox could not read the body |
  | `{"kind": "withheld", "why": "…"}` | the document did not answer the masking within `content_ms` (or is gone): the body is not shown rather than shown unmasked; the `url` is then masked with the values the sensitive fields had when the gate opened |

- `answer.allow`: `true` lets the request go; `false` (or anything that is not `true`) cancels it
  and the page sees a network error. An answer to a question that is no longer waiting is logged
  and ignored.
- A question without an answer within the guard's `answer_ms` is decided `timeout` (cancelled);
  one whose operation Kai cancels, `cancelled`; one asked or waiting while the link drops,
  `no_link` (cancelled); one whose tab closes, `tab_closed`.
- Questions come only while their operation runs: an operation answers after every request its
  gate held is decided, also when it then did nothing (a press the guard stopped, `activate:
  false`, a focus whose handlers wrote) or failed. Kai answers questions for any operation it
  is waiting on, the focus-only ones included.

Conventions:
- **Arguments** are checked strictly: an unknown argument, a missing required one or a value of
  the wrong type is `bad_args`, whose message names the argument. `null` counts as not given.
- **Numbers** are JSON numbers. Tab and window ids are small; refs grow over a Firefox run (see
  Element); frame ids exceed 32 bits (17179869185 was seen) and stay below 2^53. Kai reads all of
  them as 64-bit integers.
- **Settings** of the extension's own, on its options page, bound how long navigations wait:
  `nav_start_ms` (default 1000) and `nav_load_ms` (default 60000), how long a page has to
  answer: `content_ms` (default 15000), and how long `element.fill@1` may press keys in one field:
  `keys_ms` (default 10000). Errors and notes that come from them name them.
- **Pages answer within `content_ms`.** Every operation that reads a page or an element asks the
  content script of each frame concerned, which runs on the page's own thread; a page whose script
  keeps that thread busy cannot answer. A frame that does not answer within `content_ms` is
  `content_timeout`: the operation fails with it when the frame is the top document or the ref's
  document; another frame counts as unread (in `frames.unread_frames`, and where its text would
  be, an unread frame entry). Firefox's own search in `page.find@1` is bounded the same way.
- **`tab`** (optional where listed) is a tab id from `tabs.list@1`. Without it the operation acts
  on **the user's tab** (D9): the active tab of the most recently focused normal window. When
  that window is private, the operation fails with `private_window`.
- **Private windows** are never listed or touched, also when the user lets the extension run in
  them: their tabs are not in `tabs.list@1`, a private tab's id fails with `no_tab` (Firefox does
  not show the extension private tabs, so "closed" and "private" read the same) or, where the
  extension can see the tab, `private_window`.
- **Nothing is cut**: strings and lists come whole, however long (a page's text, every link of a
  page, a PDF's bytes, a page's source and DOM, a screenshot, the whole history a query finds). A
  frame over 1 048 576 bytes travels in pieces (§4.1), which the receiver joins.
- **Optional keys** of a result object are left out, not `null`, where this file says "only
  when"; keys shown without that are always there.

## Shared shapes

**Tab**:

```json
{"id": 12, "window": 1, "index": 3, "title": "Checkout", "url": "https://shop.example/cart",
 "active": true, "user": true, "pinned": false, "loading": false, "discarded": false,
 "audible": false, "muted": false, "container": null, "container_name": null,
 "activated_by": "user", "activated_at": 1793685358954,
 "user_origin": "https://shop.example", "user_at": 1793685361020, "kai_input_at": null}
```

- `user`: this is the user's tab (D9). At most one tab has it; none while the user is in a
  private window.
- `container`: the tab's cookie store id (`"firefox-container-1"`), `null` for the default store;
  `container_name`: that container's name (`"Kai"` for the sandbox container, design §6.4), `null`
  for the default store.

What Kai's focus rule (design §6.4) needs, as the extension saw it (times in milliseconds since
the epoch):
- `activated_by`: who last made the tab the active tab of its window: `"extension"` when that was
  `tabs.open@1` (an active new tab, or the first tab of a window it opened), `tabs.switch@1`, or
  `tabs.close@1` closing the active tab (the tab Firefox shows in its place); also any activation
  in a window while one of those calls is under way there (several `tabs.open@1` at once, or the
  user's click at that moment, cannot be told apart: each counts as the extension's), any while
  `tabs.open@1` opens a window, and any the extension did not make while an input span is open
  (`input.begin@1`: Kai's key may have made it); `"user"` for any other activation (the user's
  click or key, the tab Firefox shows after the user closed the active one, another extension);
  `null` when the extension has not seen the tab activated (it was active before the extension
  started, or it was never active). `activated_at`: when, or `null`.
- `user_origin`: the origin of the tab's page (its top document's, Origin) when the user last acted
  in the tab; `user_at`: when; both `null` when the extension has not seen the user act there. The
  user acts in a tab by **trusted pointer or key input** (a pointer pressed, a key pressed, not
  repeated) in its top document or any of its frames, by **activating it** (`activated_by: "user"`;
  then `user_at` ≥ `activated_at`), or by **loading a page in it from Firefox's own UI** (the address
  bar, a bookmark, a keyword: webNavigation's `typed`, `auto_bookmark`, `keyword` and `generated`
  transitions, or the `from_address_bar` qualifier; then `user_origin` is the new page's), each
  outside Kai's input spans. A navigation the page or the extension makes does not move it.
- `kai_input_at`: when trusted input last reached the tab while an input span was open, or `null`.
  Input Kai sends through the desktop (the trusted path, design §6.3: `key_press`, `type_text`,
  the trusted press, AT-SPI actions) is trusted input like the user's, so Kai brackets every such
  input with `input.begin@1` and `input.end@1`. While a span is open, trusted input in any tab
  moves `kai_input_at` and leaves `user_origin` and `user_at` alone, and a page that begins to load
  from Firefox's UI does not move them either: the user's own input during a span counts as Kai's
  (the conservative side: Kai's focus rule then asks).
- Pages that could not run the content script (Firefox's own pages, restricted domains) report no
  input. The facts are kept in `storage.session`: a background Firefox suspended and started again
  keeps them; a Firefox restart or a reload of the extension begins them again (`null`).

**Window** (`tabs.list@1`'s `windows`, `context.get@1`'s `window`):

```json
{"id": 1, "type": "normal", "focused": true, "focused_at": 1793685358954}
```

- `focused`: the window has the desktop's keyboard focus now (Firefox's `windows.focused`). At
  most one window of a Firefox has it; none while another application (Kai's overlay included) or
  a private window has the focus. With two Firefox profiles linked, at most one window of all of
  them has it.
- `focused_at`: when the extension last saw the window get the focus (whoever gave it: the user,
  `tabs.switch@1`); for the window that had it when the extension started, that start; `null` when
  never seen.
- `type` (only in `tabs.list@1`): `"normal"` or `"popup"`. Private windows are not listed.

**Navigation** (the answer of `tabs.open`, `tabs.go`, `tabs.back`, `tabs.forward`,
`tabs.reload`):

```json
{"tab": <Tab>, "loaded": true}
{"tab": <Tab>, "loaded": false}
{"tab": <Tab>, "loaded": false, "load_error": "NS_ERROR_CONNECTION_REFUSED"}
```

`tab` is the tab as it is when the operation answers. `tabs.open`, `tabs.go`, `tabs.back` and
`tabs.forward` say where the navigation was meant to go, `goes` (Kai counts a navigation of the
owner's own turn as the owner's move only where the tab landed on this origin, design §6.4):

```json
"goes": {"by": "url", "origin": "https://shop.example"}
"goes": {"by": "search", "origin": "https://search.example"}
"goes": {"by": "history", "origin": "https://mail.example"}
```

- `by`: `"url"` (the URL Kai gave), `"search"` (the engine's URL the search's navigation began
  with), `"history"` (the entry Back or Forward went to: the URL its navigation began with, a
  change inside the page for an entry of the same page).
- `origin`: that URL's site's origin (Reader view's and `view-source:`'s the page's inside them);
  `null` when it has none, or when the navigation had not begun when the operation answered
  (`wait: "none"`).

They take `wait`:

| `wait` | answers when |
|---|---|
| `"load"` (default) | the navigation's page has loaded, or it failed |
| `"commit"` | the new page has replaced the old one (it may still be loading: `tab.loading`), or the navigation failed before that |
| `"none"` | at once, after Firefox was asked |

- `loaded` is `true` only with `wait: "load"`, when the page loaded or the navigation stayed
  inside the page; with `"commit"` and `"none"` it is always `false`.
- `load_error` is there only when the navigation failed; never with `"none"`, and with
  `"commit"` only for a failure before the commit.
- **Which navigation:** the one Kai asked for. For a URL it is the first navigation Firefox
  begins to that URL, so a load that was still running in the tab, or a page changing its own
  URL (a live page's `replaceState`), does not answer for it. A navigation inside the page (a
  fragment, `history.pushState`) counts as loaded when it is the one asked for (`tabs.go` to a
  fragment of the page shown, Back to an entry of the same page); one the page makes while it
  loads (a single-page app's `replaceState` or fragment) does not end the wait.
- Back and Forward to a page Firefox keeps in its back-forward cache are navigations like any
  other: the page commits again and loads at once. Its refs from before are stale (Element).
- **Time:** the whole wait, from asking Firefox to the answer, is bounded by `nav_load_ms`; after
  it the call fails with `nav_timeout`, whose message says how far it got ("Firefox did not
  start loading the URL …", "… the search …", "the site has not answered …", "the page has not
  finished loading …") and names the setting; its `url` is the tab's as it is then (the page
  before, while the site has not answered). The tab goes on loading. It also ends with the tab closing (`tab_closed`) or `cancel`.

`load_error`:

| value | meaning |
|---|---|
| `NS_ERROR_CONNECTION_REFUSED`, `NS_ERROR_UNKNOWN_HOST`, `NS_ERROR_NET_TIMEOUT`, `NS_ERROR_OFFLINE`, `NS_ERROR_NET_RESET`, `NS_ERROR_NET_INTERRUPT`, `SSL_ERROR_BAD_CERT_DOMAIN` | Firefox's network error by name; the tab shows Firefox's error page |
| `Error code <n>` | another of Firefox's errors, as Firefox reports it; any other string Firefox gives comes as it is |
| `NS_BINDING_ABORTED` | the load was stopped, or replaced by another navigation |
| `ERROR_PAGE` | Firefox showed its error page without reporting an error (a port it blocks, for one) |
| `NO_PAGE` | Firefox loaded the URL without showing a new page: a download; the tab shows what it showed before |

**Element**: an element the extension names, with its ref (D4):

```json
{"ref": 214, "role": "button", "name": "Add Trail Lamp to cart"}
```

- `ref`: a number unique for this Firefox run; it names its tab, frame, document and element.
  The same element keeps its ref while its document is shown; a ref is never reused. Element
  operations take only the ref.
  - The numbers go on across restarts of the extension (reloaded, updated, disabled and enabled
    again, or its background suspended by Firefox): the counter is kept in the extension's
    `storage.local` and starts again at 1 only when Firefox starts. A restarted extension does
    not know the elements of the refs it gave out before: such a ref fails with `unknown_ref`
    saying it is from before the restart, never with another element. So refs are valid within
    one instance of the extension, and unique for the Firefox run.
  - A page left counts as gone even when Back or Forward brings it back from Firefox's
    back-forward cache: its refs from before fail with `stale_document`, and its elements get new
    refs.
- `role`: the ARIA role, explicit (the first `role` token that is an ARIA role) or as HTML-AAM
  maps the element (`generic` for elements without a role). An `input type=password` is a
  `textbox`, an `input type=range` a `slider`.
  - **Role words for inputs** HTML-AAM gives no ARIA role, as screen readers name them by their
    kind: `file` (`type=file`), `date`, `time`, `datetime` (`type=datetime-local`), `month`,
    `week` and `color` (Firefox 159 has no month and week inputs: they are text inputs there,
    so `textbox`). They are no ARIA role, so a `role` attribute never gives them. The
    `<time>` element keeps the ARIA role `time`, which is text-level and no field; an input of
    role `time` is listed among the fields.
- `name`: the accessible name as assistive technology computes it (accname 1.2,
  `dom-accessibility-api`; a field's `placeholder` when nothing else names it), trimmed; `""`
  when it has none. A sensitive field's value (a password field, or a field whose
  `autocomplete` is `cc-number`, `cc-csc`, `one-time-code`, `current-password` or
  `new-password`) never shows in a name: where accname takes one in (such a field inside a label,
  a button or the element an `aria-labelledby` names), it reads "password field, filled (19
  characters)". The masking is by text, so the same text elsewhere in that name is masked too.
  The `autocomplete` tokens count in any case (`CC-Number` too), here and everywhere below.
- `level`: only for a heading (role `heading`): its level, `aria-level` when it is a whole number
  from 1, else the number of `h1` to `h6`, else 2. Every Element of every result carries it, so
  `element.describe@1`, `element.text@1`, `element.point@1`, a find match's `element`,
  `context.get@1`'s `view.heading` and an outline item have it alike.

**Page** (the `tab` of every reading result; the design's "every result that comes from a page
starts with the tab's title and URL"):

```json
{"id": 12, "title": "Checkout", "url": "https://shop.example/cart"}
```

**Frames** (`frames` of the results that read every frame, and of `context.get@1`):

```json
{"read": 2, "unread": 1,
 "unread_frames": [{"frame": 17179869186, "origin": "https://pay.example", "code": "restricted_domain", "title": "Payment"}]}
```

- `read`, `unread`: how many of the page's frames answered and how many could not be read.
- `unread_frames`: one entry per frame that could not be read (`[]` when none), in Firefox's frame
  order. `frame` is its frame id; `origin` the origin of the URL it shows (`null` for an opaque
  one, `about:blank` for one); `title` its `<iframe>`'s `title` attribute (`""` without one,
  `null` when its parent document could not be read either); `code` why:

  | `code` | the frame |
  |---|---|
  | `content_timeout` | did not answer within `content_ms` |
  | `restricted_domain` | is on Firefox's restricted or quarantined domains |
  | `site_permission` | shows a site the user withdrew the extension's access from |
  | `firefox_page` | shows one of Firefox's own pages (`about:` other than `about:blank` and `about:srcdoc`, an extension's page) |
  | `file_access` | shows a `file:` page while local files are not allowed |
  | `no_content` | anything else; the frame could not run the content script |

  A sandboxed frame is read like any other: Firefox runs content scripts in it, also without
  `allow-scripts`.

**Origin** (`origin` of what comes from a child frame): the origin of the frame's document, by
which Kai applies its site rules to the frame itself: its URL's origin (`"https://pay.example"`),
else, for `about:blank` and `about:srcdoc`, the origin it inherited; `null` when opaque. Blocks,
controls, links, fields, outline items, find matches, the selection, `modal` and `hints.show@1`'s
`undrawn` from a child frame carry it with their `frame`; an unread frame carries its URL's
origin; `element.describe@1` always carries its element's frame's (also the top document's).

**Reading order** across frames: each frame's elements in its document's tree order, open and
closed shadow roots included (a shadow root's content right after its host), and a child frame's
elements where its `<iframe>` is in the parent.

**In view** means partly visible: inside the frame's viewport after the clipping of every
ancestor (in the flat tree) whose `overflow` is not `visible` on that axis (a scroll container,
`overflow: hidden` or `clip`: its padding box without its scroll bars), and inside the top
document's viewport after each frame's box is clipped the same way by its parents. A
fixed-position element is clipped by the viewport only. Text is measured by its own line boxes
wherever its parent element's box is not wholly inside the clip (a parent wider or taller than
what shows of it). An empty box (no width and no height) is never in view.

**Control** (`page.controls@1`, `page.fields@1`, `hints.show@1`): an Element with its value and
states, and `frame` and `origin` (Origin) when it is in a child frame (so are `page.outline@1`'s
and `page.links@1`'s items). Each key below is there only when it applies:

```json
{"ref": 41, "role": "textbox", "name": "E-mail", "value": "ada@shop", "required": true,
 "invalid": true, "error": "Enter an address like ada@shop.example.",
 "description": "We send receipts here.", "label": "Your e-mail"}
```

| key | type | when |
|---|---|---|
| `value` | string | text fields (their current value, whole), selects (the selected options' labels, joined with ", "), file inputs (the file names), colour and range inputs, rich editors (`contenteditable`: their text), ARIA sliders, spin buttons, progress bars, meters and scroll bars (`aria-valuetext`, else `aria-valuenow`), ARIA comboboxes with `aria-valuetext`; never for a sensitive field |
| `masked`, `length` | `true`, integer | a sensitive field (a password field, or one whose `autocomplete` is `cc-number`, `cc-csc`, `one-time-code`, `current-password` or `new-password`): `length` counts its value's characters (code points, 0 for empty); Kai says "password field, filled (12 characters)" |
| `min`, `max` | string | range inputs (`"0"` and `"100"` when not set) and ARIA value roles that set `aria-valuemin`, `aria-valuemax` |
| `checked` | `true` \| `false` \| `"mixed"` | checkboxes (`"mixed"`: indeterminate), radios, switches, ARIA `menuitemcheckbox` and `menuitemradio` |
| `selected` | boolean | options; tabs, tree items, grid cells and rows that carry `aria-selected` |
| `pressed` | `true` \| `false` \| `"mixed"` | toggle buttons (`aria-pressed`) |
| `expanded` | boolean | `aria-expanded`, and a `<summary>` (its `<details>` open) |
| `disabled` | `true` | disabled natively (also by a disabled fieldset) or by `aria-disabled` on it or an ancestor |
| `readonly` | `true` | read-only inputs and text areas, `aria-readonly` |
| `required` | `true` | `required`, `aria-required` |
| `invalid` | `true` | `aria-invalid` (any value but `false`), or the browser's own check failed after the user edited it (`:user-invalid`) |
| `error` | string | with `invalid`: the text of the elements `aria-errormessage` names, else the browser's validation message |
| `description` | string | the accessible description (`aria-describedby`, `title`), when it differs from `name` and `error` |
| `label` | string | the text of the field's `<label>`s when it differs from `name` (an `aria-label` overrides what the user sees: they may say the label) |
| `url` | string \| `null` | links (role `link`) and `a`/`area` elements with an `href` of another role: the absolute URL; `null` for a `role=link` without an `href` |
| `group` | string | `page.fields@1` only: the name of the fieldset (its legend), radio group or group the field is in |

Values and names never carry a sensitive field's value (Element). The page's own text is not
masked; a sensitive field's value inside text (`page.text_all@1` and the others) reads "password
field, filled (19 characters)".

**Modal** (`modal` of `page.outline@1`, `page.controls@1`, `page.links@1`, `page.fields@1`,
`hints.show@1`): the open modal dialog as an Element plus `frame`, the frame id of the document it
is in (0 for the top document), and `origin` (Origin) when that is a child frame; or `null`. The dialog makes the rest of *that* document inert,
and the frames whose `<iframe>` is in that document outside the dialog; other documents are not
affected. It is a `<dialog>` opened with `showModal` or a visible `aria-modal="true"` dialog; with
several, the innermost: the last in tree order, and an `aria-modal` one only inside the open modal
`<dialog>` when there is one. With modal dialogs in several frames, the top document's, else the
first frame's in Firefox's frame order.

**Block** (the text operations): one block of text in reading order.

```json
{"text": "Lamps and tents", "heading": 1, "ref": 5}
{"text": "Gear for long evenings outside."}
{"text": "Two people, three seasons.", "item": true}
{"text": "shop.example uses cookies to remember your cart.", "frame": 17179869185, "origin": "https://consent.example"}
{"frame": 17179869186, "origin": "https://pay.example", "unread": "content_timeout", "title": "Payment"}
```

- `text`: the block's text, never empty: the text of a block-level element (a paragraph, a
  heading, a list item, a table row, a `<div>`) up to the next block, as the page shows it. White
  space is collapsed as CSS collapses it (kept in `<pre>` and `white-space: pre*`), `<br>` is a
  line break, a table row's cells are separated by tabs. Form fields give their value (a text
  field, a select's choice, a button's label), a sensitive field's masked. Hidden content
  (`display: none`, `visibility: hidden`, a closed `<details>`) is left out; text hidden only from
  sight (clipped, transparent, scrolled out of a scroll container) is in. Images' `alt` text is
  not part of the text yet. What Kai draws over the page (hint labels, the ring) is never text.
- `heading` and `ref`: only for a heading (`h1` to `h6`, `role=heading` with its `aria-level`,
  default 2): its level and the heading's ref.
- `item`: only for a list item.
- `frame`, `origin`: only for a block of a child frame: its frame id and the frame's origin
  (Origin).
- An entry without `text` stands for a child frame that could not be read, where its `<iframe>`
  is: `unread` is the reason's code (as `unread_frames`' `code`, Frames), `origin` the origin of
  the frame's URL (`null` when opaque), `title` the `<iframe>`'s `title` attribute or `""`.

## Operations

### `tabs.list@1`

Arguments: none.

```json
{"tabs": [<Tab>, …], "user_tab": 12, "windows": [<Window>, …]}
```

Every tab of every normal and popup window that is not private, by window and then by position.
`user_tab` is `null` while the user is in a private window. The extension's own pages are tabs
too (`moz-extension:` URLs). `windows`: every normal and popup window that is not private, by id.

### `tabs.open@1`

| argument | type | |
|---|---|---|
| `url` | string | an absolute URL of a scheme that loads a page |
| `search` | string, not blank | text to search for with the user's default search engine |
| `active` | boolean | the new tab becomes the active tab of its window; default `true` |
| `sandbox` | boolean | default `false`; `true`: the tab opens in the "Kai" container (design §6.4) |
| `wait` | `"load"` \| `"commit"` \| `"none"` | default `"load"` |

Exactly one of `url` and `search`. The tab opens in the user's window; while the user is in a
private window, in the most recently focused normal window; with none open, in a new window.
Answers a Navigation.

**The sandbox container:** a Firefox container (`contextualIdentities`) named "Kai", blue, with
the fingerprint icon: the one the extension made (it keeps its cookie store id in
`storage.local`), else a new one; a container the user made is never taken, also one named
"Kai". Making it switches Firefox's container feature on. It separates cookies and site storage
from the user's: history is shared (`history.seen@1` counts its visits as Kai's, never the
user's), and Firefox's password manager still offers the user's saved logins in it. Its tabs carry
`container` and `container_name: "Kai"`.

Errors: `bad_url` (`url` does not parse as an absolute URL; the message suggests `search`),
`url_refused` (a scheme that loads no page in a tab, such as `mailto:`, `tel:`, `magnet:` or
`web+…:`, refused before Firefox is asked, the message naming the scheme; or Firefox does not let
extensions open it: `about:config`, `chrome:`, `data:` and `file:` URLs, for instance, the message
carrying Firefox's reason), `no_container` (`sandbox: true` and Firefox did not give the
container; the message carries Firefox's reason), `tab_closed`, `nav_timeout`. `about:blank`
loads like any page.

### `tabs.go@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |
| `url` | string | an absolute URL |
| `search` | string, not blank | as `tabs.open@1` |
| `wait` | `"load"` \| `"commit"` \| `"none"` | default `"load"` |

Exactly one of `url` and `search`; the tab navigates. Answers a Navigation. Errors: `no_tab`,
`private_window`, `no_window` (no `tab` given and Firefox has no normal window), `bad_url`,
`url_refused` (as `tabs.open@1`), `tab_closed`, `nav_timeout`.

### `tabs.switch@1`

| argument | type | |
|---|---|---|
| `tab` | integer | required |

Makes the tab the active tab of its window (`activated_by: "extension"`) and asks for that
window to be focused, so it becomes the user's tab. The desktop may keep another window in front (KWin's focus stealing
prevention); then the tab is active in its window but not the user's tab. `tab.user` in the
answer says which.

```json
{"tab": <Tab>}
```

Errors: `no_tab`, `private_window`.

### `tabs.close@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

```json
{"closed": <Tab>}
```

`closed` is the tab as it was before it closed (`user` is `false` there). Errors: `no_tab`,
`private_window`, `no_window` (no `tab` given and Firefox has no normal window).

### `tabs.back@1`, `tabs.forward@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |
| `wait` | `"load"` \| `"commit"` \| `"none"` | default `"load"` |

Firefox's Back and Forward do nothing, silently, at the ends of the history, so:
- a tab whose history has one page fails at once with `no_history`;
- otherwise Firefox must start the navigation within the extension's setting `nav_start_ms`
  (its options page, default 1000 ms), else `no_navigation`, whose message names the setting and
  says the likely reasons (no such page, or the page asks before it is left).

Then it answers a Navigation. Errors: `no_tab`, `private_window`, `no_window`, `no_history`,
`no_navigation`, `tab_closed`, `nav_timeout`.

### `tabs.reload@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |
| `bypass_cache` | boolean | default `false` |
| `wait` | `"load"` \| `"commit"` \| `"none"` | default `"load"` |

Answers a Navigation. Works on every tab, Firefox's own pages included. Errors: `no_tab`,
`private_window`, `no_window`, `tab_closed`, `nav_timeout`.

### `tabs.mute@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |
| `on` | boolean | required |

```json
{"tab": <Tab>}
```

Errors: `no_tab`, `private_window`, `no_window`.

### `context.get@1`

Arguments: none. Where the user is (design §5.1): one call answers "this", "here" and "that
link".

```json
{
  "tab": <Tab> + {"reader": {"available": true, "on": false}, "zoom_percent": 100},
  "window": {"id": 1, "focused": true, "focused_at": 1793685358954},
  "tabs_open": 7,
  "focus": <Element> | null,
  "selection": {"length": 10, "first_line": "trail lamp", "masked": false, "field": <Element> | null} | null,
  "pointer": <Element> | null,
  "view": {"scrollable": true, "percent": 40, "heading": <Element> + {"level": 2} | null} | null,
  "dialog": <Element> | null,
  "frames": {"read": 2, "unread": 0},
  "page_error": {"code": "<code>", "message": "<text>"} | null
}
```

- `tab`: the user's tab. `reader.available`: Firefox found an article (Reader view can open);
  `reader.on`: the tab shows Reader view. `zoom_percent`: the tab's zoom.
- `window`: the user's tab's window (Window, without `type`): whether it has the focus now and
  when it last got it, so Kai can tell which profile and window hold the user.
- `tabs_open`: the tabs `tabs.list@1` would list.
- `focus`: the focused element, through frames and open and closed shadow roots; `null` when
  nothing in the page has the focus (the body), or when the focus is in a frame that could not
  be read.
- `selection`: the selected text: in the focused text field its selected part (`field` names the
  field), else the document's selection, the focused frame's first. `length` counts characters
  (code points); `first_line` is its first line with text, trimmed, whole. In a password field or
  a field whose `autocomplete` is `cc-number`, `cc-csc`, `one-time-code`, `current-password` or
  `new-password`, `masked` is `true` and `first_line` is `null`. While such a field has the focus
  and its selection cannot be read (an input type without one, such as `number`) or nothing in it
  is selected, that frame reports no selection: the document's is not used in its place.
- `pointer`: the element under the mouse pointer: the nearest control around it, else the nearest
  element with a role (a paragraph, a heading, an image). `null` when the page has seen no
  pointer event since it loaded, the pointer left it, it is over nothing with a role, or it is
  over a frame that could not be read. Only the user's own pointer counts: events a page
  dispatches itself are ignored.
- `view`: the top document's visible part: `percent` is how far down the page the view is
  (0 at the top, 100 at the bottom, 0 when the page does not scroll); `heading` is the first
  heading in view (In view), with its `level`.
- `dialog`: an open modal dialog, the innermost, the top document's first (as Modal, without
  `frame`).
- `frames`: Frames.
- `page_error`: `{code, message}` only (the tab is `tab`): why the page itself cannot be read (the codes under "Errors": `loading`,
  `firefox_page`, `reader_view`, `file_access`, `pdf_viewer`, `error_page`, `site_permission`,
  `restricted_domain`, `no_content`, `content_timeout`). Then `focus`, `selection`, `pointer`,
  `view` and `dialog` are `null` and `frames` is `{"read": 0, "unread": 0, "unread_frames": []}`;
  `tab` and `tabs_open` are still there.

The announcements since the previous call (design §5.1, §7.2) are Kai's: Kai keeps the `event`
frames that came since its previous `context.get@1` (Events) and adds them to `browser_context`;
the extension keeps none and this answer has no such field.

Errors: `private_window` (the user is in a private window), `no_window`.

### `element.describe@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |

What a ref names now, for Kai to check a ref and to name the element in a confirmation (design
§6.3: "Kai's confirmation names the tab and the element").

```json
{"ref": 214, "tab": {"id": 12, "title": "Checkout", "url": "https://shop.example/cart"},
 "frame": 0, "origin": "https://shop.example", "role": "button", "name": "Buy now"}
{"ref": 5, "tab": <Page>, "frame": 0, "origin": "https://shop.example", "role": "heading", "name": "Lamps and tents", "level": 1}
```

`frame` is the frame id (0 for the top document); `origin` its document's origin (Origin, also
for the top document); `level` only for a heading (Element). Errors: the ref errors below,
`content_timeout`.

### Reading a page

The operations below take the page of `tab` (default: the user's tab). Their errors are
`no_tab`, `private_window`, `no_window`, the page errors (`loading`, `firefox_page`,
`reader_view`, `file_access`, `pdf_viewer`, `error_page`, `site_permission`,
`restricted_domain`, `no_content`) and `content_timeout`, unless an operation says otherwise.

### `page.outline@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

The landmarks and headings of the whole page, frames included, in reading order: a screen
reader's heading and landmark list.

```json
{"tab": <Page>, "modal": <Element> | null,
 "items": [{"ref": 3, "role": "navigation", "name": "Main"},
           {"ref": 5, "role": "heading", "name": "Lamps and tents", "level": 1, "here": true}],
 "frames": <Frames>}
```

- `items`: Elements. Landmarks are the roles `banner`, `navigation`, `main`, `complementary`,
  `contentinfo`, `search`, and `form` and `region` when they have a name; headings carry `level`.
  Elements hidden from assistive technology (`aria-hidden`) are left out.
- `here`: on exactly one heading, the one the user is reading: the first heading in view, else
  the last one above the view; on none when no heading is either.
- `modal`: Modal; the outline still lists the whole page.

### `page.controls@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

Every link, button, field and control in view (partly visible included), across frames, in
reading order.

```json
{"tab": <Page>, "modal": <Element> | null, "controls": [<Control>, …], "frames": <Frames>}
```

- Controls are the elements a screen reader's elements list counts: links, buttons, form fields,
  `<summary>`, `<video>` and `<audio>` with controls, editable elements, elements with a
  `tabindex` other than -1, and the ARIA widget roles. Elements hidden from sight (`display: none`, `visibility: hidden`) or from assistive
  technology (`aria-hidden`) and inert ones (`inert`) are left out.
- **A modal dialog** (Modal) makes the rest of its document inert: then only that document's
  controls inside it (and the frames inside it) are listed, and `modal` names it with its
  `frame`. Kai's first line says so.
- Cost: what is in view only. On the fixture's large page (5 600 controls in four frames, about
  135 of them in view) `npm test` logs the call's times; on an idle machine about 65 to 85 ms,
  the first on the page about 110 ms.

### `page.links@1`, `page.fields@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

Every link, or every form field, of the whole page, frames included, in reading order: a screen
reader's elements list.

```json
{"tab": <Page>, "modal": <Element> | null, "links": [<Control> + {"in_view": true}, …], "frames": <Frames>}
{"tab": <Page>, "modal": <Element> | null, "fields": [<Control> + {"in_view": false}, …], "frames": <Frames>}
```

- Links: `a[href]`, `area[href]` and `role=link`; each with `url` (`null` for a `role=link`
  without an `href`).
- Fields: inputs other than buttons and hidden ones, selects, text areas, editable elements, and
  the ARIA roles `textbox`, `searchbox`, `combobox`, `listbox`, `checkbox`, `radio`, `switch`,
  `slider` and `spinbutton`; each with `group` where it has one.
- `in_view`: the element is partly visible now (In view).
- `inert`: only when `true`: the element is inert (inside `inert`, or outside an open modal
  dialog), so it cannot be used now. The whole page is listed all the same; `modal` names the
  dialog.
- Whole pages take longer: on the large page 1 120 links in 0.2 s and 2 800 fields in 0.6 s.

### `page.text@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

The article, when Readability finds one, whole; otherwise all the text, as `page.text_all@1`.

```json
{"tab": <Page>, "article": true, "title": "Three nights in the hills", "byline": "By Ada Example",
 "lang": "en", "blocks": [<Block>, …],
 "left_out": {"navigation": 1, "banner": 1, "contentinfo": 1, "complementary": 3, "comments": 1, "frames": 1}}
{"tab": <Page>, "article": false, "why": "the article Readability found has 187 characters, fewer than 250",
 "blocks": [<Block>, …], "frames": <Frames>}
```

- With `article: true`: Readability's (Mozilla's library, the one behind Reader view) article of
  the top document; `title`, `byline` and `lang` as it finds them, each `null` when it finds none
  (`title` falls back to the document's `<title>` first). Readability reads the document without
  what the page does not show: elements without a box (`display: none`, also by a stylesheet) and
  text directly in a `visibility: hidden` element are taken out before it parses.
- The blocks are the article's; a heading block carries the ref and the level of the page's
  heading of the same text (the first of that text not taken by an earlier article heading;
  Readability turns an `h1` into an `h2`, and the page's level is the one reported), else its
  tag's level and no `ref`. No `frame` (an article is one document's).
- `left_out`: what of the page the article does not contain, by kind, counted only when non-zero:
  `navigation`, `banner`, `contentinfo`, `complementary` (asides), `comments` (elements whose id
  or class says comment), `form` (forms and searches), each the outermost shown element of its
  kind whose text is not in the article (compared with all white space removed); and `frames`,
  the shown child frames, whose text Readability never reads. `{}` when nothing is left out. Kai adds "page_text_all reads
  everything".
- With `article: false`, `page.text_all@1`'s answer plus `article` and `why`: one of
  "Readability found no article", "the article Readability found has N characters, fewer than
  250", "the page's N headlines and links (M characters) outweigh the article Readability found
  (K characters)" (the earlier extension's weighing: on an index page the headlines, h1 to h4 and links of
  12 to 300 characters, are the content; it applies from 5 of them), or "Readability failed: …".

### `page.text_all@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

All the page's text in reading order, frames included, whole.

```json
{"tab": <Page>, "blocks": [<Block>, …], "frames": <Frames>}
```

### `page.text_visible@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

The text in view, in reading order, as `page.text_all@1` answers it. A block is in when any of
its text is in view (In view), and then whole: a paragraph cut by the edge of the view, or by a
scroll container's edge, comes whole. Frames out of view, and a frame's text outside its part in
view, are left out.

### `element.text@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |

One element's text; for a heading, its section: the heading and everything after it up to the
next heading of the same or a higher level (a smaller number), across the page's structure.

```json
{"ref": 41, "tab": <Page>, "role": "heading", "name": "Trail Lamp", "level": 2, "section": true,
 "blocks": [<Block>, …]}
```

- `level`: only for a heading (Element).
- `section`: the ref is a heading and the blocks are its section, which ends at the next shown
  heading of the same or a higher level (`display: none` and `visibility: hidden` headings do
  not end it).
- A field's text is its value, a sensitive field's masked.
- Frames inside the element are read and put in place (their blocks carry `frame`; one that cannot
  be read is an unread entry).
- `hidden`: only when `true`: the element itself is not shown (`display: none`, `visibility:
  hidden`, inside a closed `<details>`). Its blocks are the text of what in it is shown: `[]`
  without a box, but the visible children of a `visibility: hidden` element still give theirs.

Errors: the ref errors, `content_timeout`.

### `table.read@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required: a table, or any element in one (a cell, a link in a cell) |

A table as cells, each with its row and column headers, the way a screen reader announces cells
("Price, Plan Pro: 12 €").

```json
{"ref": 40, "tab": <Page>, "role": "table", "name": "Tents compared", "caption": "Tents compared",
 "rows": 5, "columns": 4,
 "cells": [{"row": 1, "column": 1, "text": "Tent", "rowspan": 2, "header": "column", "column_headers": [], "row_headers": []},
           {"row": 4, "column": 2, "text": "2.9 kg", "colspan": 2, "column_headers": ["Weight", "Packed", "Trail"], "row_headers": ["Valley Tent"]}]}
```

- The table is the nearest `<table>` or `role` `table`, `grid` or `treegrid` at or around the
  ref; `ref` in the answer is the table's. ARIA tables are read from their `row` elements and
  their `cell`, `gridcell`, `columnheader` and `rowheader` cells (with `aria-colspan`,
  `aria-rowspan`).
- `cells`: every cell, row by row (native tables: the header rows, the bodies, then the footer),
  at the row and column where it starts (from 1). Rows and cells that are not rendered
  (`display: none`, also through a hidden row group) are left out, as the table's layout leaves
  them out: they do not count in `rows` and `columns`, and the cells after a hidden cell move left
  as they do on screen. `rowspan` and `colspan` only when more than 1 (`rowspan="0"` spans to the
  end of its row group; as HTML clamps them, colspan to 1000 and rowspan to the rows there are,
  ARIA spans too). `text` is the cell's text (Block texts joined by line breaks; a sensitive
  field's value masked).
- `header`: only for header cells: `"column"` or `"row"`. A `th` with `scope` is what its scope
  says; without, one in `<thead>` or in a row of header cells (and empty cells: no child element
  and no text, so a cell holding only a field or an image is not empty) is a column header, one
  among data cells a row header; `role=columnheader`/`rowheader` as given.
- `column_headers`, `row_headers`: the texts of the cell's headers, top to bottom and left to
  right, each header once. The cells its `headers` attribute names (sorted into row and column
  headers by their kind); else as HTML's algorithm for assigning header cells finds them: up each
  of its columns for column headers, left along each of its rows for row headers. A run of header
  cells (a header block) nearer the cell hides a header further away that starts at the same
  column and is as wide (for row headers: the same row, as tall), so a repeated header row counts
  once and a section's header row hides the previous section's; a header of the other kind
  belongs to a block without being reported.
- `caption`: the `<caption>`'s text, `null` without one.

Errors: `not_a_table` (the ref is no table and is in none), the ref errors, `content_timeout`.

### `page.selection@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

The selected text, whole.

```json
{"tab": <Page>, "selection": {"text": "Trail Lamp\nA lamp for the trail.", "length": 32,
 "masked": false, "field": <Element> | null, "frame": 17179869185, "origin": "https://consent.example"} | null,
 "frames": <Frames>}
```

- Which selection: in the focused text field its selected part (`field` names the field), else the
  document's selection (`getSelection()`); the focused frame's first, else the first frame's that
  has one. `null` when nothing is selected.
- `length` counts characters (code points). In a sensitive field `masked` is `true` and `text` is
  `null`. A frame whose focused sensitive field has no readable selection (as `context.get@1`'s
  `selection`) reports none; its document's selection is not used in its place.
- `frame`, `origin`: only when the selection is in a child frame: its frame id and origin
  (Origin).

### `page.find@1`

| argument | type | |
|---|---|---|
| `text` | string, not blank | required: what to find, as Firefox's find bar finds it (case and diacritics ignored, across element boundaries) |
| `tab` | integer | default: the user's tab |

Firefox finds the text in the page and its frames (`find.find`) and highlights every match
(`find.highlightResults`, without scrolling); the highlights stay until the next find or a
navigation.

```json
{"tab": <Page>, "text": "cart", "count": 5, "highlighted": true,
 "matches": [{"text": "cart", "element": <Element>, "sentence": "Add Trail Lamp to cart"},
             {"text": "cart", "element": <Element>, "sentence": "shop.example uses cookies to remember your cart.",
              "frame": 17179869185, "origin": "https://consent.example"}]}
```

- `count`: Firefox's number of matches less the ones left out (below); `matches` has one entry
  per match, in Firefox's order (the top document's, then each frame's).
- **Sensitive fields are not searched:** a match inside a sensitive field (Element) is neither
  listed nor counted. Where matches cannot be placed, each frame counts the query's occurrences
  in its sensitive fields' values (case and diacritics ignored), and as many of its matches that
  could not be placed go too. Finding nothing but a secret's digits answers `count: 0`. Kai's own
  hint labels are left out the same way. (When other matches are highlighted, Firefox's
  highlighting, on screen only, also marks the ones in sensitive fields.)
- `text`: the match as the page has it (its case).
- `element`: the element the match is in: the nearest one with a role above text level (a
  paragraph, a heading, a cell, a link, a button, a field); `null` when the extension cannot place
  the match (then `sentence` is `null` too).
- `sentence`: the sentence around the match (sentences as `Intl.Segmenter` finds them for the
  page's language; more than one when the match spans them), from the shown text of its block
  (scripts, styles and hidden text left out), white space collapsed.
- `frame`, `origin`: only for a placed match in a child frame: its frame id and origin (Origin).
- `highlighted`: `count > 0`; Firefox's highlights are drawn only then.
- Firefox's search and highlighting are bounded by `content_ms` (`content_timeout`).

### `pdf.bytes@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

The bytes of the PDF a tab shows in Firefox's viewer, for Kai to extract its text (design §3,
§5.3). The extension cannot read the viewer; the background fetches the tab's URL again, with its
host permission and the user's cookies. That is a new request to the server: the extension's
requests do not share the tab's cache entry (`npm test` checks it with a PDF served cacheable).
So a URL that answers only once (a single-use signed link), or only to the form post that opened
it, fails or answers something else (`not_pdf`, `fetch_failed`). A `cancel` ends the fetch
(`cancelled`).

```json
{"tab": <Page>, "url": "https://cdn.shop.example/prices.pdf", "content_type": "application/pdf",
 "bytes": 600, "base64": "JVBERi0xLjQK…"}
```

- `url`: the URL the bytes came from, after redirects; `tab.url` is the tab's URL, which was
  fetched.
- `base64`: the whole file, however large; an answer over 1 048 576 bytes travels in pieces.
- `content_type`: the response's `Content-Type`, `null` without one.
- A tab in a container is fetched with the default cookie store's cookies (not yet the
  container's).

Errors: `not_pdf` (the tab shows a page the extension can read: "tab 12 shows a page, not a PDF
in Firefox's viewer"; or the URL now answers something that is no PDF: "the PDF's URL now answers
'text/html; charset=utf-8' and no PDF; tab 12 shows the PDF of an earlier answer", with
`response_url`), `fetch_failed` (the fetch failed, its reason in the message, or answered an HTTP
error, with `response_url`), `cancelled`,
`no_tab`, `private_window`, `no_window`, the page errors other than `pdf_viewer` and
`no_content`, `content_timeout`.

### `page.see@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

A screenshot of what the tab shows (design §5.3): its viewport, scroll bars included, as the page
is drawn now, as a PNG (`tabs.captureTab`). A background tab is captured too: Firefox draws it for
the capture. What Kai draws is hidden for the capture and shown again right after it (at the
latest after twice `content_ms`, should the showing not reach a frame): the hint labels and the
pointing ring in every frame, and the matches `page.find@1` highlighted (drawn again with the same
search). Captures at the same time each keep them hidden until the last one is taken.

**The image is not masked** (design §5): it shows every frame, a frame of a site Kai does not
reach included, and a sensitive field's dots. So the answer lists the child frames with their part
of the image, and **Kai blanks the box of every frame whose `origin` or `origin_before` is a
`none` site (design §6.4) before the image leaves Kai**, the boxes of frames inside such a frame
included (they lie within it). With an `origin` of `null` the strictest rule applies, as
everywhere.

```json
{"tab": <Page>, "png": "iVBORw0KGgoAAAANSUhEUgAABQAAAAOE…", "width": 1280, "height": 900,
 "view": {"width": 1280, "height": 900}, "scale": {"x": 1, "y": 1},
 "frames": [{"frame": 17179869185, "origin": "https://consent.example", "url": "https://consent.example/banner",
             "box": {"x": 700, "y": 100, "width": 300, "height": 200},
             "frames": [{"frame": 17179869187, "origin": "https://pay.example", "url": "https://pay.example/card",
                         "box": {"x": 860, "y": 210, "width": 100, "height": 60}}]},
            {"frame": 17179869186, "origin": "https://ads.example", "url": "https://ads.example/slot", "box": null}]}
```

- `png`: the image in base64, whole; an answer over 1 048 576 bytes travels in pieces.
- `width`, `height`: the image's size in pixels, read from the decoded image.
- `view`: the viewport the image covers, in the page's CSS pixels (`innerWidth`, `innerHeight`).
- `scale`: image pixels per CSS pixel on each axis, `width / view.width` and `height /
  view.height`: measured from the image, never taken from the device pixel ratio. At 150 % zoom in
  a 1280 × 900 window, `view` is 853 × 600 and the image 1281 × 900 (Firefox captures whole CSS
  pixels), so `x` is 1.5018 and `y` 1.5.
- `not_hidden`: only when frames did not answer the hiding within `content_ms`: `[{"frame": …,
  "code": "content_timeout"}]`; Kai's labels in those frames may be in the image. A frame without
  the content script has none of Kai's drawings and is not listed.
- `frames`: the top document's child frames, `[]` when it has none, in Firefox's frame order, each
  `{"frame", "origin", "url", "box", "frames"?}` (`"unmeasured"` too where it applies):
  - `frame`: its frame id; `origin`: the origin of the document it shows **after the capture**
    (Origin; for a frame without the content script, its URL's; `null` when opaque); `url`: that
    document's URL (`webNavigation.getAllFrames` right after the capture).
  - `origin_before`: only when the frame showed another document of another origin when Kai's
    drawings were hidden, right before the capture: that origin (`null` when opaque). The image
    shows one of the two documents, so **Kai applies the stricter rule of `origin` and
    `origin_before`**. A frame that went to another page of the same origin, or changed its
    address within its document, has none. A frame that is gone after the capture is named as it
    was before it.
  - `box`: its part of the image, `{"x", "y", "width", "height"}` in image pixels (from the image's
    top left corner, whole pixels, widened outward): its content box, cut by the view and by what
    of each frame around it is in view; **`null` when no part of it is in the image** (out of view,
    not rendered). Where it is is measured right before and right after the capture; a frame that
    moved between gets a box over both places.
  - `frames`: only when it has child frames: its own child frames the same way, their boxes also
    in the whole image's pixels (not relative to it).
  - `unmeasured`: only when `true`: the document around the frame could not say where it is (it
    could not be read, or did not list it), so `box` is the part of the nearest frame around it
    that was measured (the whole image when that is the top document); the frame lies somewhere
    inside it.
- A pinch zoom does not change the image: Firefox 159 captures the layout viewport at the page's
  zoom, so `view`, `scale` and every box are as without it (measured).
- `tab` is the tab after the capture. The URL and top document are the same as when the operation
  began, or the call fails with `page_changed` and no image: an image is never sent under another
  page's or address's name.

Errors: `not_rendered` (Firefox unloaded the tab, a discarded background tab: "Firefox has not
rendered tab 12: it unloaded the tab (a discarded background tab), so there is nothing to see
until it is shown again (tabs.switch)"), `page_changed` (the tab showed another page, or the page
another address, after the capture than when the operation began: "tab 12 showed another page or
address when the screenshot was taken than when Kai asked, so no image is sent"; the error's `url`
is the tab's now; Kai asks again to see the new page, under its site rule), `no_content` (Firefox
did not capture it, its reason in the message), and the errors of reading a page.

### `element.see@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |

The same, cropped to one element: an image without alt text, a chart, a canvas, a CAPTCHA. An
element of which no part is in view (In view) is scrolled into view first, centred, as
`element.point@1` does. The crop is the element's part in view (its border box after the clipping
of its scroll containers and of its frames by their parents), in the top document's viewport, times
`scale` as measured from the capture, widened to whole pixels; it is cut from the image in the
extension (`OffscreenCanvas`).

```json
{"ref": 52, "tab": <Page>, "role": "img", "name": "", "png": "…", "width": 200, "height": 100,
 "box": {"x": 100, "y": 100, "width": 200, "height": 100}, "view": {"width": 1280, "height": 900},
 "scale": {"x": 1, "y": 1}, "scrolled": false, "frames": []}
```

- `box`: the part of the element the image shows, in CSS pixels of the top document's viewport.
- `clipped`: only when `true`: part of the element is outside the view, or cut off by a scroll
  container or a frame; the image shows the part in view.
- `scrolled`: the element was scrolled into view first.
- `frame`, `origin`: only for an element of a child frame (Origin). `level`: only for a heading.
- `view`, `scale`, `not_hidden`: as `page.see@1`'s.
- `frames`: as `page.see@1`'s, the same tree, each `box` in the crop's pixels (from the crop's top
  left corner) and cut to it, `null` for a frame with no part in the crop; an element inside a
  child frame has that frame's entry over all or part of the crop. Kai blanks those of `none`
  sites the same way (`origin` or `origin_before`).

Errors: `not_shown` (`display: none`, `visibility: hidden`: nothing to see), `not_in_view` (no part
of it can be brought into view: clipped away by an ancestor that does not scroll, or without a
size), `page_changed` (as `page.see@1`'s: the tab's URL or top document changed during the call),
`not_rendered`, `no_content`, the ref errors, `content_timeout`.

### `hints.show@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

Numbered labels over every control in view, the numbers being the refs (D4), in every frame.
Answers what `page.controls@1` answers, plus `undrawn` when labels could not be drawn:

```json
"undrawn": [{"frame": 17179869185, "origin": "https://consent.example", "code": "content_timeout", "labels": 3}]
```

- `undrawn`: only when some frame's labels could not be drawn: per frame its id, its origin
  (Origin), the reason's code (the frame codes of Frames) and how many labels it would have had.
  Their controls are in `controls` all the same.
- The labels are drawn over the page, at the top left of each control's part in view: page CSS
  cannot reach them (all inline `!important` styles on their host, a closed shadow root, the top
  layer), page scripts cannot read or change the labels themselves, and they take no clicks. The
  host element is in the page's DOM; a page script that removes it, changes its attributes or
  closes its popover gets it back at the next animation frame. The labels are never part of the
  page's text, find matches or outline.
- They stay until `hints.hide@1` or a navigation of the tab's top document (also Back into the
  back-forward cache: the page restored shows none). After the page scrolls or resizes (an inner
  scroll container too) the labels follow at once and, 150 ms after it stopped, are drawn again for
  the new view, new controls getting their refs. A frame's new page gets its labels. Changes of
  the page without a scroll (a dialog opening) do not redraw them yet.

### `hints.hide@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

```json
{"tab": <Page>, "shown": true, "removed": 37}
```

`shown`: hints were on for the tab; `removed`: the labels taken away. A redraw that was under way
(after a scroll) draws nothing once `hints.hide@1` has come, also when its labels reach a frame
after the hide did. Errors: `no_tab`, `private_window`, `no_window`.

### `element.point@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |
| `ms` | integer from 1 to 2147483647 | required: how long the ring shows (Kai's setting `browser.point_ms`); the maximum is the longest timer a browser keeps (2^31 − 1 ms, about 24.8 days); above it `bad_args` names it |

A ring around the element ("this one?"), fading over the last third of `ms`, then gone. An
element out of view (In view) is scrolled into view first (centred). A second point in the same
document replaces the first ring.

```json
{"ref": 214, "tab": <Page>, "role": "button", "name": "Add Trail Lamp to cart", "ms": 3000, "scrolled": true}
{"ref": 215, "tab": <Page>, "role": "button", "name": "Gift wrap", "ms": 3000, "scrolled": false, "hidden": true}
```

- `level`: only for a heading (Element).
- `hidden`: only when `true`: the element is not shown (`display: none`, `visibility: hidden`), so
  no ring is drawn and nothing is scrolled.

Errors: the ref errors, `content_timeout`.

## Acting

The operations of design §5.4 (hands), the commit guard's page side and its network gate (§6.4),
the focus check of the trusted path and Kai's input spans (§6.3). They act with synthetic events
(`isTrusted: false`): they grant no user activation, CSS `:hover` does not follow them, and they
have no default actions besides the activation a click has (a link followed, a box checked, a
form submitted, a `<summary>` toggled); `page.key@1` carries out the defaults of a few keys itself.
Values are set through the native setters of the content script's view of the page, which the
page's own property overrides (React's value tracker) do not see, so the `input` event that
follows reads as a change. The page runs a task between a press's button going down and up,
before its click, between keys and before the answer reads the element again, so state a
framework commits in a microtask or a task (React 18) is there when the guard looks again and
when `took` is read.

**Guard** (`guard`, required by every acting operation): Kai's commit guard for this call, from
its settings (`browser.commit_guard`, `browser.guard_words`, `browser.guard_window_ms`) and the
call's deadline:

```json
"off"
{"words": ["buy", "order", "pay", "checkout", "purchase", "subscribe", "delete", "remove", "send", "transfer", "confirm",
           "kauf", "bestell", "bezahl", "zahlung", "zahlen", "kasse", "abo", "lösch", "entfern", "überweis", "bestätig"],
 "window_ms": 2000, "answer_ms": 120000}
```

- `"off"`: no page-side check and no network gate (the owner switched the guard off, or Kai
  judges the call needs none). There is no default: an acting operation without `guard` is
  `bad_args`, so a forgotten setting never turns the guard off.
- `words`: the word list. The list above is the default Kai ships in `browser.guard_words` and
  sends; the setting is Kai's, the extension has none. It holds stems, so one entry covers a
  word's forms ("bestell": "bestellen", "Bestellung"; "kauf": "kaufen", "Einkaufswagen").
  Matching: the text and the words are NFKC-normalised (full-width "Ｂｕｙ" is "Buy") without
  default-ignorable code points (soft hyphens, zero-width spaces), case ignored. A word of four
  or more letters matches anywhere in the text, also inside a word ("Zahlungspflichtig
  bestellen" holds "bestell" and "zahlung", "resend" holds "send"): a false match costs only a
  question. A shorter word matches where it starts a word of the text: the character before it
  is no letter or digit, or a lower-case letter followed by a capital starts a new word
  ("QuickBuy" holds "buy", "Ebuy" does not). Blank words are skipped. `[]`: no word triggers; a
  cross-origin submit, an Enter in an editor and the network gate still do. Letters of other
  scripts that look alike (a Cyrillic "о" in "оrder") are not matched yet.
- `window_ms` (0 to 2 147 483 647): how long after the action the network gate holds the
  document's requests; 0: only what the action sends while it runs.
- `answer_ms` (1 to 2 147 483 647): how long a held request waits for Kai's `answer` before it is
  cancelled (`timeout`); for focus.check's gate also how long it stays open without
  `gate.result@1`. A request held at the end of the window waits up to `answer_ms` more, so Kai
  sets `answer_ms` to at most the call's deadline less `window_ms`.

**The page side** (element.press@1, page.key@1): before a press, a submit or an Enter in an
editor, the guard finds every verdict below that applies, in this order, each at most once. When
one of them is not among the call's `confirmed`, the operation answers `guard`: the list of those
verdicts, and does nothing (no event reaches the page, no window). Kai asks the user once about
the whole list, then sends the same call with those verdicts as `confirmed` (each as `guard`
answered it; one is confirmed when every key matches).

| `reason` | when | more keys |
|---|---|---|
| `word` | a word is in what the element pressed, or the element its press activates (a button around an icon), says: its accessible name (`where: "name"`), the text it shows (`"text"`: an `aria-label` can say "Close" over "Delete everything"), a button's value (`"value"`) or its `title` (`"title"`), unless that element is a link that loads another document by `GET` (below); for a submit, in what its submit button says when that is not the element pressed (`where: "submitter"`: the default button a field's Enter uses, or a label's button), or in the form's action URL's path, query and fragment (decoded; its host is the next rule's), `where: "form_action"` | `word` (as Kai sent it), `where`, `text` (what matched, masked like every name, or the action URL) |
| `cross_origin_submit` | a submit (method `get` or `post`) whose action is an `http`, `https` or `file` URL of another origin than the document's | `action`, `origin` (the action's, `null` when it has none), `method` (`"get"`, `"post"`) |
| `enter_in_editor` | `page.key@1`'s Enter, with any modifiers, in an editable element (a text area, a `contenteditable` editor, a text-like input, `role` `textbox`, `searchbox` or `combobox`), except a plain Enter (no ctrl, alt or meta) in a text-like input of a form, which the submit rules read: a page's own script may take it as "send" | `text` (the editor's accessible name) |

```json
{"ref": 52, "tab": <Page>, "role": "button", "name": "Buy now",
 "guard": [{"reason": "word", "word": "buy", "where": "name", "text": "Buy now"},
           {"reason": "word", "word": "order", "where": "form_action", "text": "https://shop.example/order"}]}
```

- **A second look.** The page's handlers run during the action: those of `pointerdown` can rename
  the button or change its form. Right before the click (and before `page.key@1` carries out a
  key's default), the guard looks again at the element and its submission as they are then; a
  verdict that is not confirmed stops it: no click, no default, and the answer carries `guard`
  with the events that already went (`clicked: false`; for `page.key@1` `emulated: null`) and the
  window's `requests`. A confirmation is for the verdicts Kai showed: a renamed button or a new
  action is asked about again.
- **Plain links that load a page.** The words do not apply to a link (`a` or `area` with an
  `href`) whose URL is `http`, `https` or `file` and is not this document's with another
  fragment, and that shows no sign of acting by script: its activation is a `GET` navigation,
  which commits nothing by itself ("Open the lamp" that opens its page). What the page it loads
  sends goes through the network gate, and so does a `GET` to a site the user never visited. The
  words still apply to such a link when its URL's path or query (decoded) holds a word of the
  list (`/item/5/delete`; "Order now" to `/order.html`), when it carries one of the attributes by
  which a page's script or a framework acts on its click (`onclick`, `onmousedown`,
  `onmouseup`, `onpointerdown`, `onpointerup`, `onauxclick`, `data-method`,
  `data-turbo-method`, `data-remote`, any `hx-*`, `phx-click`, `ng-click`, `@click`,
  `v-on:click`), or when a press handler the page set as a property (`onclick`, `onmousedown`,
  `onmouseup`, `onpointerdown`, `onpointerup`, `onauxclick`) is on it or on an ancestor up to the
  document. They apply as before to a link to a fragment of this document (`href="#"`), a
  `javascript:` URL, and an element that only has the role `link`. **Not seen:** listeners added
  by `addEventListener` (Firefox gives content scripts no way to list them), so a link whose own
  or delegated listener cancels its navigation and commits by script, with no word in its URL
  and no marker, is not asked about by its word.
- A press submits when it activates a submit button (`<button>` of type `submit`, the default, or
  `<input type=submit|image>`) of a form, or a `<label>` of one. `confirmed` passes the page side
  only: the network gate still asks. A `dialog` form method submits nothing and is not checked.
- `confirmed` (optional, default `[]`): a list of verdicts, each an object with `reason` and the
  keys above as strings (`origin` may be `null`); anything else is `bad_args`.
- The guard on navigations Kai asks for (`tabs.go`, `tabs.open` to an origin the user never
  visited) is Kai's, with `history.seen@1`'s `seen_by_user`. Navigations an acting operation
  causes are the network gate's (below).

**The network gate**: an acting operation with a guard opens a gate on the acted-on document (the
ref's; for `page.key@1` the focused document; for `page.scroll@1` the top document) before it
acts. From then until `window_ms` after the action, the gate holds and asks about (Questions
above):
- every `POST`, `PUT`, `PATCH` and `DELETE` the document sends: requests whose `documentId` is the
  document's (fetch, XHR, subresources), and its navigations, which carry none: a form's POST
  that replaces the document (its frame still shows it when the request starts), one that loads
  into a frame the document holds (its `parentDocumentId`), and one a document at the document's
  URL started (Firefox's `originUrl`: a form or link of a frame that targets `_top`, `_parent` or
  a sibling frame; another document at the same URL counts too); a redirect's next request (a
  307 keeps a POST) is held again;
- every `GET` navigation of those kinds to another origin than the document's that the user has
  never visited (`history.seen@1`'s `seen_by_user`), with `reason: "unseen_origin"`: a link the
  model pressed can carry data out in its URL.

**Never held, as a trade-off against noise:** requests of type `beacon` (`navigator.sendBeacon`)
and `ping` (a link's `ping` attribute; Firefox sends none by default), nearly all of the gate's
questions on real sites (design §6.4), mostly the pages' telemetry. A write a page makes by
beacon because of Kai's action is therefore not asked about here; the page side's words ask
before a press of a link where they see that it acts by script (above). A `fetch` with `keepalive`
is held like any fetch: Firefox's webRequest reports it as `xmlhttprequest` without saying it is
one, nor whether it carries credentials before it is sent.

With several gates open on one document (concurrent operations), a request goes to the oldest.
The operation answers when the window has closed and every held request is decided, with each in
`requests`:

```json
"requests": [{"method": "POST", "url": "https://shop.example/cart", "type": "xmlhttprequest", "reason": "write", "decision": "allowed"}]
```

`decision`: `allowed`, `declined` (Kai's answer), `timeout` (no answer within `answer_ms`),
`cancelled` (Kai cancelled the call), `no_link` (no link to ask on, or it dropped), `tab_closed`;
every one but `allowed` cancelled the request. `frame` is there when the request came from
another frame than the document's (a navigation into a child frame, or of the top document). `url`
is masked as the question's was. The operation's `tab` is then the tab as it is after the window
(a press that navigated shows the new page's title and URL). An acting operation that fails after
its gate held requests carries them in its error as `requests`.

**What the gate does not see**: requests from workers (dedicated, shared and service workers: they
are no document's; the fixture's dedicated worker's `POST` goes unasked), WebSocket, WebRTC and
WebTransport traffic, `GET` and `HEAD` requests other than navigations to unvisited origins (a
page's script can carry data out in a GET's URL, and a navigation to an origin the user has seen),
navigations the document's own script makes after the window, a form with `target=_blank` (it
loads in a new tab), requests of other documents (a child frame's own fetches when the gate is on
its parent), and every request after the window. Firefox itself stops a cross-origin frame from
navigating the top document without a user gesture, so a synthetic press there cannot; Kai's
trusted key can, and the gate holds it by `originUrl`. Within the window the gate asks about
every write of the document but its beacons and pings, the page's own analytics by fetch or XHR
and autosave included. The gate's listener
(webRequest's blocking `onBeforeRequest`) is there only while a gate is open or a question waits.

**Acting** (the answer of the acting operations): the element acted on as a Control (its value and
states after the action and the window, a sensitive field's value masked) with its `ref`, `tab`
(Page, as after the window), `frame` and `origin` (Origin) when it is in a child frame, the
operation's own keys, and `requests` when the network gate watched:

```json
{"ref": 41, "tab": <Page>, "role": "textbox", "name": "Full name", "value": "Ada Example",
 "how": "value", "took": true, "scrolled": false, "requests": []}
```

- `ref`: the element acted on: the ref given, or the element it stands for where the operation
  says so (a label's file input, the scroll container around an element). Either is read again
  after the window.
- `after`: only when the element could not be read again after the window: `"page_left"` (its
  page was left, a press that navigated for one), `"removed"` (the page removed it), or the
  error's code (`content_timeout`); the Control keys are then the element's from before.
- `requests`: only when the gate watched (a guard other than `"off"`) and the operation acted
  (not with a first-look `guard`, `needs_trusted`, `activate: false`, a check that changed
  nothing, a `page.scroll@1` that could not scroll), or when it did not act but the gate held
  requests anyway (a page that writes when an element gets the focus).
- `scrolled` (`element.press@1`, `element.fill@1`, `element.focus@1`, `element.hover@1`,
  `element.show@1`): the element was out of view (In view) and was scrolled into view, centred,
  before the action. The other operations scroll what they act on into view too, without saying
  so.

Refusals, before anything is done: `disabled` (disabled natively, by a disabled fieldset or by
`aria-disabled` on it or an ancestor), `inert` (inside `inert`, or outside the open modal dialog:
the message says which), `not_shown` (`display: none`, `visibility: hidden`), with the ref errors
and `content_timeout`. Messages name the ref, never the element's name.

### `element.press@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |
| `activate` | boolean | default `true`; `false`: only scroll into view and focus (Kai's setting `browser.trusted_press = "always"`) |
| `guard` | Guard | required |
| `confirmed` | list of verdicts | default `[]`; the verdicts of the page side Kai asked the user about (Acting) |

The page side of the guard looks first (Acting); then it scrolls the element into view when it
is not, focuses it, and:
1. with `activate: false`: answers `focused` (whether the element is its document's active
   element now; one that cannot take the focus is not), `key` and, for an element that needs a
   user gesture by its kind, `needs_trusted`, and does nothing else;
2. for an element that needs a user gesture by its kind it answers the same and does not
   activate it;
3. else it presses: the pointer and mouse events of a press of the primary button at the middle
   of the element's part in view (`pointerover`, `pointerenter`, `mouseover`, `mouseenter`,
   `pointermove`, `mousemove`, `pointerdown`, `mousedown`; a task of the page's; `pointerup`,
   `mouseup`; a task) and a `click` (a `PointerEvent`), whose activation follows a link, checks a
   box or submits a form. Before the click the guard looks again (Acting). When a handler removed
   the element meanwhile (a framework re-rendering), the press stops there: its replacement is not
   pressed (`stopped: "removed"`); read the page again for the new element.

```json
{"ref": 52, "tab": <Page>, "role": "button", "name": "Edit address", "clicked": true, "focused": true, "scrolled": false, "requests": []}
{"ref": 63, "tab": <Page>, "role": "button", "name": "Bold", "pressed": true, "clicked": true, "focused": true, "scrolled": false, "requests": []}
{"ref": 60, "tab": <Page>, "role": "link", "name": "Open the price list", "url": "…", "needs_trusted": "new_window", "key": "Enter", "focused": true, "scrolled": false}
{"ref": 55, "tab": <Page>, "role": "checkbox", "name": "Gift wrap", "checked": false, "key": "Space", "focused": true, "scrolled": false}
{"ref": 52, "tab": <Page>, "role": "button", "name": "Buy now", "clicked": false, "focused": true, "scrolled": false,
 "guard": [{"reason": "word", "word": "buy", "where": "name", "text": "Buy now"}], "requests": []}
{"ref": 52, "tab": <Page>, "role": "button", "name": "Save", "clicked": false, "stopped": "removed", "after": "removed", "focused": true, "scrolled": false, "requests": []}
```

- `clicked`: only when it pressed (3.): whether the click was sent; `false` when the second look of
  the guard stopped it (`guard` says why) or the element was removed (`stopped`). `pressed` is the
  Control's: a toggle button's `aria-pressed` state.
- `stopped`: only when the press stopped before its click because a handler removed the element:
  `"removed"`.
- `goes`: where the press takes the tab when the element it activates is a link that loads
  another document by `GET` (Plain links above, whatever the words) or a submit control of a
  form whose method is not `dialog`: `{"by": "link", "origin": <the href's origin>}` or
  `{"by": "submit", "origin": <the action's origin>}` (`null` when it has none). With the click,
  as the guard's second look read it right before the click (a handler may change the link or
  the form); with `needs_trusted` and `activate: false`, as the element is then. Not there when
  the press goes nowhere, nor when it was stopped. Kai counts a press of the owner's own turn as
  the owner's move only where the tab landed on that origin (design §6.4).
- `needs_trusted` (design §6.3), by kind: `new_window` (a link or area whose `target`, or the
  document's `<base target>`, is not `_self`, `_parent`, `_top` or the name of a frame of the
  document: Firefox's popup blocker stops a synthetic one), `file_input` (its picker;
  `element.file@1` gives files without one), `media` (a `<video>` or `<audio>` or an element in
  one), `fullscreen` (an element whose accessible name says "full screen", "fullscreen" or
  "Vollbild"). Whether a site's own handler needs a gesture cannot be told from outside.
- `key` (with `needs_trusted` and with `activate: false`): the key Kai's trusted press sends:
  `"Space"` for a checkbox, radio or switch and a media element, else `"Enter"` (buttons and
  links take it).
- `focused`: whether the element has the focus in its document (the trusted key needs it there).

Errors: `disabled`, `inert`, `not_shown`, the ref errors, `content_timeout`.

### `element.fill@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |
| `text` | string | required; may be empty |
| `guard` | Guard | required |

Replaces a field's value, after scrolling it into view and focusing it, by its kind:

| kind | how | `how` |
|---|---|---|
| text inputs (`text`, `search`, `email`, `url`, `tel`, `password`, no type) and text areas | `beforeinput` (`insertReplacementText`, cancelable; when the page cancels it nothing changes and `note` says so), the value through the native setter, `input`, `change` | `value` |
| comboboxes (`role=combobox`, an input with a `list`) and fields with `aria-autocomplete` (`list`, `inline`, `both`) | the old value selected and deleted (`beforeinput`/`input` `deleteContentBackward`), then each character with `keydown`, `keypress`, `beforeinput` and `input` (`insertText`) around it, inserted at the caret, `keyup`, and a task of the page's; at the end `change`. Their suggestion lists open as for typing. It stops when `keys_ms` is up (`note` says how many characters went) | `keys` |
| range, number, date, time, month, week, datetime-local and colour inputs | the value through the native setter (the browser sanitises it: `"next Tuesday"` in a date input leaves it empty), `input`, `change` | `value` |
| rich editors (`contenteditable`) | the editing host focused, its content selected, then Firefox's `execCommand("insertText")` (`"delete"` for an empty text), which fires a trusted `beforeinput` and `input` editors handle (ProseMirror, Lexical, Draft.js) | `editor` |
| ARIA sliders and spin buttons | keys as `keydown` and `keyup`, a task of the page's after each (a widget may commit its value in a microtask), until `aria-valuenow` is the number: `Home` or `End` for a number at an end; `ArrowRight` (`ArrowUp` when that does not move it) or `ArrowLeft` (`ArrowDown`), which learn the step; `PageUp` or `PageDown` while the number is at least one of their steps away (tried once it is ten arrow steps away; dropped when it does not move the value toward the number, and the arrows come back when it passes it). It stops when an arrow does not move the value, moves it away or passes the number, or when `keys_ms` is up (`note` says which) | `keys` |

```json
{"ref": 41, "tab": <Page>, "role": "textbox", "name": "Full name", "value": "Ada Example", "how": "value", "took": true, "scrolled": false, "requests": []}
{"ref": 43, "tab": <Page>, "role": "textbox", "name": "Gift message", "value": "Happy birthday", "how": "editor", "took": false, "scrolled": false,
 "note": "the editor did not take the text; element.focus and then Kai's type_text type it the trusted way", "requests": []}
{"ref": 48, "tab": <Page>, "role": "textbox", "name": "Password", "masked": true, "length": 16, "how": "value", "took": true, "scrolled": false, "requests": []}
```

- `took`: the field shows the text afterwards: its value is the text (for range and number
  inputs the same number), an editor's text is the text with white space collapsed, a slider's
  `aria-valuenow` is the number. A sensitive field's value is masked like everywhere (`masked`,
  `length`).
- `note`: only when something did not go as asked: the page cancelled the input, an editor did
  not take the text (the trusted way: `element.focus@1`, then Kai's `type_text`), a slider's steps
  pass the number, a slider has no `aria-valuenow`, or the keys ran out of time ("it did not reach
  870 within Kai for Firefox's setting keys_ms (10000 ms): it is at 340", "it typed 12 of 40
  characters within …").
- `took` and the Control are read after a task of the page's: a field whose page puts back what
  it refuses (a controlled field committing in a microtask) shows `took: false`.
- Time: the page has `keys_ms` for the keys and then `content_ms` to answer; past both the call
  fails with `content_timeout`, naming both settings.

Errors: `readonly` (`readonly`, `aria-readonly`), `not_fillable` (a checkbox, radio, file input,
button, hidden input, select or an element that is no field; the message names the operation
that fits), `bad_value` (a slider or spin button and a text that is no number within
`aria-valuemin` and `aria-valuemax`, both named), `disabled`, `inert`, `not_shown`, the ref
errors, `content_timeout`.

### `element.choose@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required: a select, a list box, a radio group (`role=radiogroup`, a fieldset, a `role=group`) or a radio in one, a combobox, or an input with a `list` |
| `option` | string, not blank | required: the option's label (case and runs of white space ignored, otherwise exact) |
| `guard` | Guard | required |

- A **select**: by `option.label`; the option is selected (in a multiple select, added to the
  selection), then `input` and `change`.
- An **input with a datalist**: by its options' labels (else values); the value is set as
  `element.fill@1` sets a text.
- A **radio group**: the radios of the group (native radios of one name and form; `role=radio`
  in the `radiogroup`), by their accessible names; the radio is pressed (a hidden native radio
  through a label of it that is shown).
- A **list box**: its `role=option` descendants and the options it owns (`aria-owns`) that are
  shown, by their names; the option is pressed. A **combobox** (not a select): the list box it
  controls or owns (`aria-controls`, `aria-owns`), likewise; it shows options only while its list
  is open.

```json
{"ref": 50, "tab": <Page>, "role": "combobox", "name": "Country", "value": "Austria", "chosen": "Austria", "took": true, "requests": []}
```

`chosen`: the option's label as the page has it. `took`: the option is selected (checked,
`aria-selected="true"`, or the combobox's value is the label) afterwards.

Errors: `no_option` (none has that label; `options` lists every label, in order, `[]` for a
combobox whose list is closed, the message saying so), `disabled` (also for a disabled option,
named), `not_shown` (a radio that is not shown, nor any label of it), `not_choosable`, `inert`,
the ref errors, `content_timeout`.

### `element.check@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required: a checkbox, radio, switch, `menuitemcheckbox`, `menuitemradio`, or a toggle button (`aria-pressed`) |
| `on` | boolean | required |
| `guard` | Guard | required |

When the state is already `on` it does nothing (`changed: false`, no `requests`); else it presses
the element, or, for a native checkbox or radio that is not shown, a label of it that is.

```json
{"ref": 55, "tab": <Page>, "role": "checkbox", "name": "Gift wrap", "checked": true, "changed": true, "took": true, "requests": []}
```

`took`: the state is `on` afterwards (`checked` for checkboxes, radios and switches, `pressed`
for toggle buttons; an indeterminate box is not on).

Errors: `not_checkable`, `bad_value` (`on: false` for a radio: it goes off when another option of
its group is chosen), `not_shown` (not shown, nor a label of it), `disabled`, `inert`, the ref
errors, `content_timeout`.

### `element.file@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required: a file input, or a `<label>` of one |
| `files` | list | required, not empty: `{"name": "receipt.pdf", "type": "application/pdf", "base64": "…"}` each; `type` optional (default `""`); `base64` the file's bytes, whole |
| `guard` | Guard | required |

Kai reads the file (design §5.4, confirmed by default since it sends a local file to a site) and
sends its bytes; a frame over 1 048 576 bytes travels in pieces (§4.1). The content script builds
`File`s (last modified: now) and gives them to the input through a `DataTransfer`, then `input`
and `change`: no file picker opens. The input's files are replaced.

```json
{"ref": 57, "tab": <Page>, "role": "generic", "name": "Receipt", "value": "receipt.txt",
 "files": [{"name": "receipt.txt", "type": "text/plain", "bytes": 19}], "requests": []}
```

`ref` is the input's (a label's input has its own). `files`: as the input has them now.

Errors: `not_a_file_input`, `bad_value` (more than one file for an input without `multiple`),
`bad_args` (a file without a name, `base64` that is not base64), `disabled`, `inert`, the ref
errors, `content_timeout`.

### `element.focus@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |
| `guard` | Guard | required |

Scrolls the element into view when it is not and focuses it, the caret at the end of a field's
or an editor's text: the step before Kai's `type_text` and `key_press`.

```json
{"ref": 61, "tab": <Page>, "role": "textbox", "name": "Notes", "value": "Fragile", "focused": true, "scrolled": true, "requests": []}
```

`focused`: the element is its document's active element now (one that cannot take the focus is
not). Whether the page has the keyboard focus at all is `focus.check@1`'s.

Errors: `disabled`, `inert`, `not_shown`, the ref errors, `content_timeout`.

### `element.hover@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |
| `guard` | Guard | required |

Scrolls the element into view when it is not, then the pointer's out and leave events on the
element hovered before (by this extension, in this document) and `pointerover`, `pointerenter`,
`mouseover`, `mouseenter`, `pointermove`, `mousemove` at its middle: for menus a script opens on
hover. CSS `:hover` does not follow synthetic events, and the answer cannot tell whether a menu
opened other than by the element's states (`expanded`).

```json
{"ref": 63, "tab": <Page>, "role": "button", "name": "Account", "expanded": true, "hovered": true, "scrolled": false, "requests": []}
```

Errors: `disabled`, `inert`, `not_shown`, the ref errors, `content_timeout`.

### `element.drag@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required: what is dragged |
| `to` | integer from 1 | required: where it is dropped; in the same document |
| `guard` | Guard | required |

Both are scrolled into view (the source centred, the target as little as needed), then from the
source's middle: `pointerdown` and `mousedown`, and
- for a `draggable` source (`draggable="true"`, links and images): a `pointermove`, `dragstart`
  with a new `DataTransfer` (a cancelled one ends the drag), `pointercancel`, `drag`, then on the
  target `dragenter` and `dragover`; when the target cancelled `dragover` (it accepts the drop)
  `drop`, else `dragleave`; then `dragend` on the source. The one `DataTransfer` travels with all
  of them, so what the page put in at `dragstart` is there at `drop`. `how: "html5"`, `dropped`:
  the target accepted the drop.
- else the pointer moves in eight steps to the target's middle (`pointermove`, `mousemove` with
  the button held, each to the element under the point), then `pointerup` and `mouseup` there:
  what pointer-driven libraries listen for. `how: "pointer"`; no `dropped`, since what the page
  made of it cannot be seen.

```json
{"ref": 70, "tab": <Page>, "role": "listitem", "name": "", "how": "html5", "dropped": true,
 "to": {"ref": 72, "role": "listitem", "name": ""}, "requests": []}
```

`to`: the target (Element). `note`: only when the drag did not go through (the page cancelled
`dragstart`, the target did not accept the drop).

Errors: `other_document` (the refs are in different documents), `disabled`, `inert`, `not_shown`
(either), `stale_element` (also for `to`), the ref errors, `content_timeout`.

### `element.show@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |

A view operation, without a guard: scrolls the element into view (centred) when no part of it is
in view (In view).

```json
{"ref": 66, "tab": <Page>, "role": "button", "name": "Full screen", "scrolled": true}
```

`hidden`: only when `true`: the element is not shown, and nothing was scrolled. Errors: the ref
errors, `content_timeout`.

### `element.scroll@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required: a scroll container or an element in one |
| `to` | `"down"` \| `"up"` \| `"top"` \| `"bottom"` | required |
| `guard` | Guard | required |

Scrolls the nearest scroll container at or around the element that can scroll up and down
(`overflow-y` `auto`, `scroll` or `overlay`, and more content than room), at once (no smooth
scrolling): `down` and `up` by a screen of it, its height less a tenth (which stays in view, as
Firefox's Page Down keeps a strip); `top` and `bottom` to its ends. Scrolling sideways is not
built yet.

```json
{"ref": 80, "tab": <Page>, "role": "generic", "name": "Terms text", "scrolled": true, "percent": 18, "at_top": false, "at_bottom": false, "requests": []}
```

`ref` is the container's. `scrolled`: it moved (by a pixel or more); `percent`: how far down it
is now (0 at the top, 100 at the bottom); `at_top`, `at_bottom`: at an end now (within a pixel).
A page that loads more at the bottom grows after the answer.

Errors: `not_scrollable` (no such container at or around the element; the page itself is
`page.scroll@1`'s), the ref errors, `content_timeout`.

### `page.scroll@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |
| `to` | `"down"` \| `"up"` \| `"top"` \| `"bottom"` | required |
| `guard` | Guard | required |

Scrolls the page as `element.scroll@1` scrolls a container, a screen being the viewport's height
less a tenth. A page whose root or body hides its overflow (an app that scrolls an inner pane)
does not scroll itself: then the scroll container under the middle of the view, where a wheel
would scroll, is scrolled (`container`). Frames are not scrolled yet.

```json
{"tab": <Page>, "container": null, "scrolled": true, "percent": 12, "at_top": false, "at_bottom": false, "requests": []}
{"tab": <Page>, "container": null, "scrolled": false, "scrollable": false, "percent": 0, "at_top": true, "at_bottom": true}
```

`container`: the inner container scrolled (Element), `null` for the page. `scrollable`: only when
`false`: neither the page nor anything under the middle of the view scrolls.

Errors: `no_tab`, `private_window`, `no_window`, the page errors, `content_timeout`.

### `page.key@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |
| `keys` | string | required: one key with its modifiers, `+` between: `"Escape"`, `"ctrl+k"`, `"shift+Tab"`, `"ä"` |
| `guard` | Guard | required |
| `confirmed` | list of verdicts | default `[]`; the verdicts of the page side Kai asked the user about (Acting) |

Keys: `Enter` (`Return`), `Escape` (`Esc`), `Tab`, `Backspace`, `Delete` (`Del`), `Insert`, `Space`
(or `" "`), `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` (`Up`, `Down`, `Left`, `Right`),
`Home`, `End`, `PageUp`, `PageDown`, `F1` to `F12` (names in any case), or one character as it is
(a letter with `shift` is its capital; `"+"` and `"ctrl++"` for the plus key). Modifiers: `ctrl`
(`control`), `shift`, `alt` (`option`), `meta` (`super`, `cmd`, `command`, `win`). One key a call;
a sequence is several calls.

The key goes to the focused element of the focused document (through frames and shadow roots;
the document's body when nothing has the focus) as `keydown`, `keypress` (for a character or
Enter or Space without ctrl, alt or meta) and `keyup`, with `key`, `code` and the legacy `keyCode`
and `charCode`. Synthetic keys have no defaults; when the page did not cancel the key, page.key
carries these out (only without ctrl, alt and meta):

| key | on | default | `emulated` |
|---|---|---|---|
| Enter | a text-like input (text, search, url, tel, email, password, date, month, week, time, datetime-local, number) in a form | the form's implicit submission: its default button (the first submit button) clicked, or without one, when the input is the form's only such field, the form submitted (`requestSubmit`); the guard reads that button (`where: "submitter"`) and the form's action first | `submit` |
| Enter | a link, an area, a button, a `<summary>`, an input button | a click (`detail` 0, no pointer) | `click` |
| Space (at `keyup`) | a button, a `<summary>`, an input button, a checkbox, a radio | a click | `click` |
| Escape | an open modal `<dialog>` (the last), else an open `popover=auto` (the last) | the dialog's close request (`requestClose`, which fires `cancel`), or the popover hidden | `close` |

Other defaults (Tab moving the focus, arrows and Page Down scrolling, characters typed into a
field) are not carried out: for them Kai's `key_press` (trusted) or `page.scroll@1` and
`element.fill@1`. The page runs a task after `keyup`; then the guard looks again at the default as
the page has it now (Acting) before carrying it out. An Enter with any modifiers in an editor is
asked about first (`enter_in_editor`): the page's own script may send on it.

```json
{"tab": <Page>, "keys": "Ctrl+K", "target": {"ref": 61, "role": "textbox", "name": "Notes"}, "prevented": false, "emulated": null, "requests": []}
{"tab": <Page>, "keys": "Enter", "target": {"ref": 90, "role": "textbox", "name": "E-mail"},
 "guard": [{"reason": "word", "word": "subscribe", "where": "form_action", "text": "https://shop.example/subscribe"}]}
{"tab": <Page>, "keys": "Ctrl+Enter", "target": {"ref": 93, "role": "textbox", "name": "Message"},
 "guard": [{"reason": "enter_in_editor", "text": "Message"}]}
```

- `keys`: the key as page.key understood it, written one way (`Ctrl+Alt+Shift+Meta+Key`, a letter
  as its capital, `Space` for the space).
- `target`: the element the key went to (Element, with `frame` and `origin` in a child frame),
  `null` for the body.
- `prevented`: the page cancelled `keydown` or `keypress`; then nothing was carried out.
- `emulated`: the default carried out, or `null`.
- `goes`: with `emulated` `submit`, where the form's submit goes (`{"by": "submit", "origin"}`);
  with `emulated` `click` on a link that loads a page or a submit control, as `element.press@1`'s.
- `guard`: only when the page side of the guard stopped the key: at its first look no key event
  reached the page (and the answer has no `prevented`, `emulated` or `requests`); at its second
  look the key events went, the default was not carried out (`emulated: null`), and `requests`
  are there.

Errors: `bad_args` (a key or modifier page.key does not know; the message lists the keys),
`no_tab`, `private_window`, `no_window`, the page errors, `content_timeout`.

### `focus.check@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |
| `guard` | Guard | optional: with the focus on the element, open the network gate for Kai's trusted key |

The check before Kai's trusted key (design §6.3): does the element have the keyboard focus. In
order: its tab is the active tab of its window; its window has the desktop's focus; the page,
not Firefox's own UI, holds the focus (the top document's `document.hasFocus()`); the focused
document (followed through frames) is the element's and its active element (through shadow
roots) is the element.

```json
{"ref": 52, "tab": <Page>, "focused": true, "gate": 4}
{"ref": 52, "tab": <Page>, "focused": false, "focus": "element", "element": {"ref": 61, "role": "textbox", "name": "Notes"}}
{"ref": 52, "tab": <Page>, "focused": false, "focus": "firefox"}
```

`focus`, only when not `focused`, says where the focus is:

| `focus` | |
|---|---|
| `other_tab` | the element's tab is not its window's active tab |
| `other_window` | another Firefox window has the focus |
| `outside` | no window of this Firefox has it: another application (Kai's overlay, a desktop dialog), a private window, or Firefox without the focus |
| `firefox` | the window has it, the page does not: Firefox's own UI (the address bar, the sidebar, a panel, the find bar); which one cannot be told yet |
| `element` | another element of the page has it: `element` names it (Element, `frame` and `origin` in a child frame) |
| `nothing` | the page has it, no element does (the body) |

`gate`: only with `guard` (not `"off"`) and the focus on the element: the network gate is open on
the element's document from now, and that document notes the first trusted keydown and the first
trusted click it gets (`gate.result@1`'s `key_seen` and `click_seen`). Kai presses its key, then reads the gate with `gate.result@1`;
the window ends `window_ms` after `gate.result@1` arrives, or, without one, `answer_ms` after
this call (the gate expired: `gate.result@1` says so, and writes after that were not held).

**The trusted press, in order** (design §6.3): `input.begin@1`; `focus.check@1` with `guard`; the
key through the desktop; `gate.result@1`; `input.end@1`. Kai calls `focus.check@1` right before
its key, after any confirmation the user gave (a dialog can take longer than `answer_ms`, and the
focus can move meanwhile), never before it. Where the focus is inside Firefox's own UI cannot be
told yet: the sidebar's own report of holding the focus comes with WP8 (design §8).

Errors: the ref errors, `content_timeout`.

### `gate.result@1`

| argument | type | |
|---|---|---|
| `gate` | integer from 1 | required: the `gate` of `focus.check@1` |

Answers once the gate's window (`window_ms` from this call) has closed and every request it held
is decided; a gate is read once.

```json
{"gate": 4, "requests": [{"method": "POST", "url": "https://shop.example/api/draft", "type": "xmlhttprequest", "reason": "write", "decision": "allowed"}],
 "key_seen": {"key": "Enter", "element": {"ref": 52, "role": "button", "name": "Save draft"}},
 "click_seen": {"element": {"ref": 52, "role": "button", "name": "Save draft"}}}
{"gate": 5, "requests": [], "key_seen": null, "click_seen": null, "expired": true, "expired_at": 1793685361020}
```

- `key_seen`: the first trusted keydown the element's document got while the gate was open:
  `key` is the key's name (`"Enter"`, `"Space"`, `"Tab"`; `"character"` for any character, never
  which one), `element` the element it went to (Element, `frame` and `origin` in a child frame;
  `null` for the body). `null` when the document got none: the key went elsewhere (Firefox's own
  UI, the sidebar, another frame, another window) or arrived after the window.
- `click_seen`: the first trusted click the gate's document got while the gate was open (a key's
  activation of a button is one, Kai's press through accessibility is one): `element` is the
  gate's own element (the ref of `focus.check@1` or `gate.open@1`) when the click was on it or
  inside it, else the nearest control around what was clicked, or what was clicked (Element,
  `frame` and `origin` in a child frame; `null` for the body). `null` when the document got none.
  Each kept gate of a document gets its own: two gates aimed at a control and at one inside it
  name each its own element for one click on the inner.
- `expired`, `expired_at`: only when the gate's window ended before this call came
  (`answer_ms` after `focus.check@1` or `gate.open@1`): when. Writes after that went unasked; Kai
  treats its key or press as unguarded.

Errors: `unknown_gate` (no such gate waits to be read: never opened, read already, expired and
not read within `answer_ms` after that, or the extension restarted or the link dropped since),
`cancelled`.

### `gate.open@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | the element whose document the gate is on; exactly one of `ref` and `tab` |
| `tab` | integer | the tab whose top document the gate is on |
| `guard` | Guard | required, not `"off"`: its `window_ms` and `answer_ms` |

A gate kept for `gate.result@1`, as `focus.check@1`'s with its `guard` is, without asking where
the keyboard focus is: Kai's press through accessibility (design §6.3, WP12) and its presses in
Firefox's own UI (a page's dialog, a permission prompt) need no keyboard focus. The document notes
the first trusted keydown and click it gets (`key_seen`, `click_seen`).

```json
{"ref": 52, "tab": <Page>, "gate": 6}
{"tab": <Page>, "gate": 7}
{"tab": <Page>, "gate": null, "why": "firefox_page"}
```

- With `tab`, a page the extension cannot reach (one of Firefox's own pages, Reader view, an error
  page: the codes of the table at the end) gets no gate: `gate` is `null` and `why` the code.
- **The press through accessibility, in order** (design §6.3, WP12): `input.begin@1`;
  `element.mark@1`; Kai finds the element on the accessibility bus by the mark, in the page of the
  tab's own window only, and compares it with the answer's `role`, `name` and `frames`;
  `element.unmark@1`; `gate.open@1` with the ref; AT-SPI's `doAction` on that element (a trusted
  click with user activation, Firefox's); `gate.result@1`; `input.end@1`.

Errors: `bad_args` (neither or both of `ref` and `tab`, or `guard` `"off"`), the ref errors,
`no_tab`, `content_timeout`.

### `element.mark@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |

Sets the attribute `aria-kai-mark` on the element to a new value (32 hex digits, 128 random bits
for each mark), which Firefox gives the accessibility bus as the object attribute `kai-mark` (an
unknown `aria-` attribute without its `aria-`), so Kai finds this element there and no other. The
attribute changes nothing the page or a reader shows; the page's own script can see it until
`element.unmark@1`, or until the extension takes it away by itself (`MARK_TTL_MS`).

```json
{"ref": 52, "tab": <Page>, "role": "button", "name": "Add to cart", "attribute": "aria-kai-mark", "object_attribute": "kai-mark", "value": "3f9c…",
 "url": "https://shop.example/cart", "frames": ["https://shop.example/cart"]}
{"ref": 61, "tab": <Page>, "role": "button", "name": "Pay", "attribute": "aria-kai-mark", "object_attribute": "kai-mark", "value": "8a07…",
 "url": "https://pay.example/frame", "frames": ["https://shop.example/cart", "https://pay.example/frame"], "frame": 3, "origin": "https://pay.example"}
```

- `role`, `name`: the element's, as an Element has them. Kai compares them with the element it
  finds on the accessibility bus.
- `object_attribute`: the attribute's name on the accessibility bus; `value`: its value.
- `url`: the address of the element's document as the page has it, `frame` and `origin` in a
  child frame.
- `frames`: the addresses of the documents from the tab's top page down to the element's own
  (`url`, last), as Firefox's navigation has each frame now; `null` when a frame between could not
  be read. Kai compares them, each without its fragment, with the documents the element it found
  lies in (AT-SPI's `DocURL`; an empty one, which Firefox gives `data:` and `blob:` documents, is
  refused).
- **`MARK_TTL_MS` = 5000:** the content script takes the mark away by itself 5000 ms after it set
  it, from every element of the document that carries it, whatever else happens. A constant of
  this contract, not a setting: Kai searches right after the mark and takes it away at once
  (`element.unmark@1`), well within it; a search that would come later finds nothing and takes the
  key's path.
- The extension keeps the marks it set until `element.unmark@1` or `MARK_TTL_MS`, and takes them
  all away when the link drops. A mark an extension that restarted meanwhile set (its content
  script gone with its timer) is not taken away: an attribute that does nothing.

Errors: the ref errors, `content_timeout`.

### `element.unmark@1`

| argument | type | |
|---|---|---|
| `value` | string, not blank | required: the `value` of `element.mark@1` |

Takes the mark away from every element of its document that carries that value (the marked one,
and any the page copied it to).

```json
{"value": "3f9c…", "removed": 1}
```

`removed`: how many elements carried it (0 when the page or its tab is gone).

Errors: `unknown_mark` (no mark of that value is set: never, taken away already, or the link
dropped since).

### `input.begin@1`

Arguments: none.

```json
{"span": 3}
```

Opens an input span: Kai is about to send trusted input through the desktop (design §6.3:
`key_press`, `type_text`, the trusted press, AT-SPI actions). Until it ends, trusted input in any
tab of this Firefox is Kai's (Tab's `kai_input_at`), not the user's: it does not move
`user_origin` or `user_at`, an activation the extension did not make counts as the extension's,
and a page that begins to load from Firefox's UI is not the user's act (also when it commits
after the span), nor the user's visit (`history.seen@1`). The span covers every tab, since Kai's
input lands wherever the focus is. Spans may overlap. With two profiles linked, Kai opens one in
each. The user's own input during a span counts as Kai's.

### `input.end@1`

| argument | type | |
|---|---|---|
| `span` | integer from 1 | required: the `span` of `input.begin@1` |
| `settle_ms` | integer, 0 to 2 147 483 647 | required: how long after this call the span stays open, for keys still on their way to Firefox; Kai sets it from its own setting (0 after `gate.result@1`, whose window already waited) |

Answers when the span has ended, `settle_ms` after this call:

```json
{"span": 3, "tabs": [12]}
```

`tabs`: the tabs that got trusted input during the span (`[]` when none): where Kai's input
landed. A span also ends when the link drops, the extension restarts, or Kai cancels this call.

Errors: `unknown_span` (no such span is open: never opened, ended already, `input.end@1` came
for it already, or the extension restarted or the link dropped since), `cancelled`.

### `history.seen@1`

| argument | type | |
|---|---|---|
| `url` | string, not blank | required: an absolute URL with a host |

Whether the user has visited the URL's origin (its scheme, host and port), for the commit guard's
question before a navigation the model asked for (design §6.4: a URL the model wrote can carry
data out as a GET). Firefox's history is searched for the host, and each page of that origin's
visits read, through the whole history.

```json
{"url": "http://192.0.2.44/upload", "origin": "http://192.0.2.44", "seen": false, "seen_by_user": false, "first_visit": null, "last_visit": null}
{"url": "https://shop.example/cart", "origin": "https://shop.example", "seen": true, "seen_by_user": true, "first_visit": 1790006400000, "last_visit": 1793685358954}
{"url": "https://tracker.example/p", "origin": "https://tracker.example", "seen": true, "seen_by_user": false, "first_visit": 1793685360000, "last_visit": 1793685360000}
```

- `seen`: the history has a visit to a page of that origin, whoever caused it.
- `seen_by_user`: a visit Kai did not cause. Kai's commit guard on `tabs.go` and `tabs.open` asks
  when this is `false`. The extension keeps, per origin, when Kai first caused a page of it to load
  and when it last saw one load that Kai did not cause (`storage.local`, across restarts): Kai's
  are the navigations of `tabs.open`, `tabs.go`, `tabs.back`, `tabs.forward` and `tabs.reload`
  (their target and every URL a redirect went by), anything that begins to load in a tab while a
  network gate is open there or an input span is open, a tab a page opens meanwhile, and every
  page of the sandbox container. The user has seen the origin when the history has a visit to it
  from before Kai first went there, or the extension saw a page of it load since that Kai did not
  cause (the page's own navigations count as the user's).
- `first_visit`, `last_visit`: the first and the last visit to a page of that origin (milliseconds
  since the epoch, Kai's included), `null` when unseen.
- The history is the profile's, the sandbox container's visits included; private windows leave
  none.

Errors: `bad_url` (no absolute URL, or one without an origin a history could have seen:
`about:blank`, `data:`).

## Firefox's own features

The operations of design §5.5. What plays (pause, next, volume) is Kai's through MPRIS.

### `page.zoom@1`

| argument | type | |
|---|---|---|
| `percent` | integer from 1 | required: the zoom to set |
| `origin` | string, not blank | required: the origin of the page Kai approved (Origin) |
| `tab` | integer | default: the user's tab |

Sets the tab's zoom (`tabs.setZoom`). Reading it is `context.get@1`'s (`tab.zoom_percent`).

- **Only on the page Kai approved.** The tab's page must be of `origin`, else `page_changed` and
  the zoom is not changed. The tab's page is read from its URL, so Reader view's page counts as
  the page it shows (`about:reader?url=https://news.example/…` is `https://news.example`), as do
  `view-source:` and `blob:` pages, and a PDF in Firefox's viewer as the PDF's address; a page
  with an opaque origin (`about:blank`, Firefox's `about:` pages, `data:`) is never approved.
- **Checked before and after, not held.** `tabs.setZoom` takes a tab, not a document, so the check
  cannot hold the page as `page.css@1`'s does (its `documentIds`). The origin is checked right
  before the zoom is set and again right after: a page of another origin found after is
  `page_changed` too, and then the zoom may have reached that page (Firefox's zoom is per site by
  default, `scope`).

```json
{"tab": <Page>, "percent": 150, "was": 100, "default_percent": 100, "scope": "per-origin"}
```

- `percent`: the zoom now; `was`: before the call; `default_percent`: Firefox's default zoom.
- `scope`: Firefox's zoom setting (`tabs.getZoomSettings`): `"per-origin"` (Firefox's default:
  the zoom applies to every tab of the site, and Firefox keeps it for the site) or `"per-tab"`.

Errors: `bad_value` (Firefox refused the zoom; its reason in the message, which names its range:
"Firefox does not zoom tab 12 to 9000 %: Zoom value 90 out of range (must be between 0.2 and 5)"),
`page_changed` (before: "tab 12 shows a page of another origin than the one Kai approved, so its
zoom was not changed", or "… of no origin Kai can approve (an opaque one) …"; after: "tab 12 showed
a page of another origin than the one Kai approved when its zoom was set, so the zoom may have
reached that page"; the error's `url` is the tab's), `bad_args` (`percent` or `origin` missing),
`no_tab`, `private_window`, `no_window`.

### `reader.view@1`

| argument | type | |
|---|---|---|
| `on` | boolean | required |
| `origin` | string, not blank | required: the origin of the page Kai approved (Origin) |
| `tab` | integer | default: the user's tab |

Turns Firefox's Reader view on or off (`tabs.toggleReaderMode`) and waits for the page it then
shows as a Navigation with `wait: "load"` waits, within `nav_load_ms`. Reader view is the page
`about:reader?url=…`, which the reading operations refuse (`reader_view`); turning it off goes
back to the page (a page that is not in the back-forward cache loads again, and its refs are
stale).

- **Only on the page Kai approved**, as `page.zoom@1`'s: the tab's page (Reader view's by the page
  it shows) must be of `origin`, else `page_changed` and nothing is done, also when the tab already
  is as asked. `tabs.toggleReaderMode` takes a tab, not a document, so the origin is checked right
  before and again once the page Reader view (or the page after it) shows has loaded: another
  origin then is `page_changed` too (Reader view was turned on or off, and the tab shows a page
  of another origin: the page changed meanwhile, or leaving Reader view loaded a page that went
  elsewhere).

```json
{"tab": <Tab>, "loaded": true, "on": true, "changed": true}
{"tab": <Tab>, "on": true, "changed": false, "loaded": true}
```

- `on`: whether the tab shows Reader view now. `changed`: `false` when it already was as asked;
  nothing was done then, and `loaded` says whether the tab has finished loading.
- `loaded`, `load_error`: as a Navigation's.

Errors: `no_article` (Firefox finds no article in the page, so Reader view cannot show it:
`context.get@1`'s `tab.reader.available` is `false`; Firefox looks once the page has loaded, which
the message adds while it loads), `page_changed` (before: "tab 12 shows a page of another origin
than the one Kai approved, so Reader view was not turned on"; after: "tab 12 showed a page of
another origin than the one Kai approved once Reader view was turned on"), `bad_args` (`on` or
`origin` missing), `no_tab`, `private_window`, `no_window`, `tab_closed`, `nav_timeout`,
`cancelled`.

### `bookmarks.find@1`

| argument | type | |
|---|---|---|
| `query` | string, not blank | required |

Every bookmark Firefox's bookmark search finds for the query (`bookmarks.search`: the words in its
title or URL), whole, the newest first. Folders and separators are not listed.

```json
{"query": "care notes", "bookmarks": [{"title": "Tent care notes", "url": "https://shop.example/tents/care",
 "added": 1793685358954, "folder": ["Bookmarks Toolbar", "Gear"]}]}
```

- `added`: when it was bookmarked, milliseconds since the epoch (`null` when Firefox does not say).
- `folder`: its folders from the top, by title (`[]` when Firefox gives none).
- Bookmarks of every site are listed; Kai leaves out what its site rules hide.

Errors: `bad_args`.

### `history.find@1`

| argument | type | |
|---|---|---|
| `query` | string, not blank | required |

Every page of the history whose title or URL has the query's words (`history.search` through the
whole history), whole, the most recently visited first.

```json
{"query": "Help: Northwind", "pages": [{"title": "Help: Northwind Gear", "url": "https://shop.example/help",
 "last_visit": 1793685358954, "visits": 3}]}
```

- `last_visit`: milliseconds since the epoch, `null` when Firefox does not say; `visits`: Firefox's
  count of visits. Visits Kai caused count like the user's here (`history.seen@1` tells them apart
  for an origin).
- Private windows leave no history. Pages of every site are listed; Kai leaves out what its site
  rules hide.

Errors: `bad_args`.

### `downloads.list@1`

Arguments: none.

Every download Firefox's downloads API lists (`downloads.search`), private windows' left out, the
newest first.

```json
{"downloads": [{"file": "price-list.txt", "path": "/home/ada/Downloads/price-list.txt", "url": "https://shop.example/download",
 "final_url": "https://shop.example/download", "referrer": "https://shop.example/prices",
 "state": "complete", "size": 14, "received": 14, "started": 1793685358954, "exists": true, "mime": "application/octet-stream"}]}
```

- `file`: the file's name; `path`: where it is on this machine. Opening a finished file is Kai's own
  `open` with its path: Firefox's `downloads.open` needs a user action in the extension.
- `url`: the address Firefox gives the download (`DownloadItem.url`); `final_url`: where it came
  from after redirects (`finalUrl`), the same as `url` when Firefox gives none; `referrer`: the page
  it was started from, `null` without one. For a download a navigation started, Firefox 159 gives
  the address after the redirects as `url` (measured). **Kai leaves out an entry when the site of
  any of the three is a `none` site** (design §6.4), and counts it like `tabs.list@1`'s left-out
  tabs.
- `state`: `in_progress`, `interrupted` or `complete`. `error`: only when Firefox gives a reason
  (`NETWORK_FAILED`, `USER_CANCELED`, …). `paused`: only when `true`.
- `size`: the file's size in bytes, else (while it downloads) the size the server announced, else
  `null`; `received`: the bytes so far.
- `started`: when it started, milliseconds since the epoch (`null` when Firefox does not say).
  Firefox 159 gives no end time.
- `exists`: the file is still on disk. `mime`: the type the server gave, `null` without.
- `danger`: only when Firefox flags the file: its kind (`file`, `url`, `content`, `uncommon`,
  `host`, `unwanted`).
- Private windows' downloads are left out, also when the user lets the extension run in private
  windows and Firefox lists them to it.

Errors: `bad_args`.

## Source and DOM

The operations of design §5.6. They read the tab's page; their errors are those of reading a page
unless an operation says otherwise.

### `page.source@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

The HTML the server sent for the tab's page (its top document), fetched again.

- **The request method.** The extension records every top-level request (`webRequest`'s
  `main_frame`; each redirect's hop) and every top-level commit and load (`webNavigation`). A
  document is given the newest request of its tab that began after the tab's commit before it and
  before its own commit, when its URL (after redirects, without the fragment) is the document's,
  it did not fail, and the tab did not finish loading the page before it meanwhile (a download, a
  204); anything else is unknown. So a request is never given to a document that committed before
  it began. A page Back or Forward restores from the back-forward cache keeps its record. The
  records are kept until the tab closes, in `storage.session`: a suspended background keeps them,
  a restarted extension does not.
- **Late reports.** Firefox can report a page's request after the page has loaded (measured: some
  100 ms). For a page that began loading after the extension started and is no page restored from
  the back-forward cache (`performance.timeOrigin` after the tab's commit before it), page.source
  waits for its request, within `content_ms`.
- **A `GET` document** is fetched again from the page itself (its content script's `fetch`, with
  the page's cookies and its cache partition), **first from the cache alone** (`cache:
  "only-if-cached"`): a cached answer is taken, stale or not, and the server is not asked. **Only
  when the cache has none is the server asked** (`cache: "no-store"`): the page's address is
  requested again with the page's cookies, so a page whose address does something when it is
  opened (an unsubscribe or confirmation link, a logout, a counter) does it again, and the answer
  may differ from what is shown. `cache: false` says that this happened; Kai's tool description
  says so. The URL fetched is the one the document was answered for (after redirects, without its
  fragment), also after the page changed its address (`pushState`).
- The fetch has no time limit of the extension's: it waits for the server until it answers or Kai
  cancels (`cancelled`; the fetch is aborted).

```json
{"tab": <Page>, "url": "https://shop.example/care", "method": "GET", "cache": true, "status": 200,
 "content_type": "text/html; charset=utf-8", "charset": "UTF-8", "bytes": 478,
 "frames": [{"src": "https://consent.example/banner?site=shop&amp;v=2", "origin": "https://consent.example"},
            {"src": "help.html", "origin": "https://shop.example"}],
 "text": "<!doctype html>…"}
```

- `cache`: `true`: the browser's cache answered and the server was not asked; `false`: the cache
  had no copy and the server was asked again.
- `status`: the answer's HTTP status (a page that now answers 404 says so); `content_type`: its
  `Content-Type`, `null` without; `response_url`: only when the fetch was redirected elsewhere.
- `bytes`: the size of the body after Firefox took off its content encoding (gzip, Brotli): the
  decoded bytes, not what travelled; `text`: those bytes decoded, whole, with the charset the page
  was read with (`charset`, `document.characterSet`; UTF-8 where that has no decoder).
- `frames`: **the frame addresses in `text`**, `[]` when none: every `src` and `data` attribute of
  an `<iframe>`, `<frame>`, `<object>`, `<embed>` or `<portal>` start tag, each `{"src",
  "origin"}` pair once, in the order of the text. `src` is the attribute's value **exactly as the
  text writes it** (character references and white space included, `&amp;` stays `&amp;`), so it
  is found in `text` as it is; `origin` is the origin of the URL it names (character references
  resolved as HTML does, resolved against the first `<base href>` before it, else against the
  answer's URL; `null` when opaque or no URL). Tags are found as HTML's tokenizer finds them: not
  inside comments, nor in the text of `<script>`, `<style>`, `<textarea>`, `<title>`, `<iframe>`
  and the other elements whose text is no markup; `<noscript>`'s content and `<svg>`'s and
  `<math>`'s count. An attribute that is empty or blank names nothing and is not listed. **The
  text is the server's and is not changed: Kai takes out (or replaces with the origin) every
  `src` whose `origin` is a `none` site before the text reaches the model** (with `null`, the
  strictest rule applies, as everywhere), as
  `page.dom@1` writes such an address as its origin. Not listed yet: addresses in a `srcdoc`
  attribute's HTML (its own frames), and URLs a script builds.

Errors: `source_unknown` (the extension does not know how the page was requested: it loaded before
the extension started (or restarted), Back restored it from the back-forward cache without a
record, it did not come from a request (a page a script wrote, a `blob:` document), or Firefox did
not report its request within `content_ms`, which the message then names), `not_get` (the page is
the answer to a `POST` or another method, in `method`: fetching it again would send that request
again; the message points to `page.dom`), `fetch_failed` (the fetch failed, its reason in the
message), `stale_document` (the page was left while the fetch ran), `cancelled`, and the errors of
reading a page.

### `page.dom@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |

The live document as HTML, whole: the top document as HTML's fragment serialization writes it
(Firefox's `getHTML`; by hand along the way to frames and to Kai's own elements), every open and
closed shadow root as a declarative `<template shadowrootmode="open|closed">` first in its host
(with `shadowrootdelegatesfocus`, `shadowrootserializable` and `shadowrootclonable` where they are
set), and each child frame's document right after its `<iframe>` (`<frame>`, `<object>`,
`<embed>`).

```json
{"tab": <Page>, "url": "https://shop.example/",
 "html": ["<!DOCTYPE html><html lang=\"en\">…<iframe title=\"Cookie consent\" src=\"https://consent.example\"></iframe>",
          {"frame": 17179869185, "url": "https://consent.example/banner", "origin": "https://consent.example",
           "src": "https://consent.example/banner?site=shop", "html": ["<!DOCTYPE html><html lang=\"en\">…</html>"]},
          "</section>…</html>"],
 "frames": <Frames>}
```

- `html`: the document in order: strings of HTML, and after each frame element its frame: `frame`
  (its id), `url` (its document's URL), `origin` (Origin), `src` and `html`, its document the same
  way (its own frames nested in it). Kai marks where a frame's document begins and ends, with its
  URL, and leaves out the frames of sites it does not reach.
- **A frame's address is in its entry only.** In the parent's HTML the frame element's URL
  attribute (`src`; `data` of an `<object>`) reads the origin of the URL it names
  (`src="https://consent.example"`), or its scheme alone where that has none (`src="data:"`), so a
  `none` frame's full address does not travel in the parent's text. The entry's `src`, only when
  the element has the attribute, is the attribute as written; Kai shows it (or `url`) in its frame
  marker for frames it reaches and leaves it out with the frame otherwise.
- A frame that could not be read: `{"frame": …, "url": …, "origin": …, "unread": "<code>", "title":
  "…", "src": "…"}`, the codes of Frames, `title` its element's `title` attribute, `src` as above.
- `url`: the top document's URL. `frames`: Frames.
- Kai's own elements (the host of the hint labels and the ring) are left out.
- **Sensitive fields are masked** (Element's: a password field, and fields whose `autocomplete` is
  `cc-number`, `cc-csc`, `one-time-code`, `current-password` or `new-password`): pages such as
  React's write what was typed back into the DOM, so such a field's `value` attribute reads
  `value="password field, filled (15 characters)"` and its content (a text area's text) reads the
  same. The rest of the DOM is the page's and is not masked.
- A document that is not HTML (an XML or SVG document) is written as XML, without its shadow roots
  and its frames yet; its sensitive fields are masked the same way.

### `element.dom@1`

| argument | type | |
|---|---|---|
| `ref` | integer from 1 | required |

One element's HTML, the same way: the element itself, its shadow root, and the documents of the
frames in it (or of the frame it is).

```json
{"ref": 41, "tab": <Page>, "role": "region", "name": "Consent area",
 "html": ["<section aria-label=\"Consent area\"><h2>Consent</h2><iframe …></iframe>", {"frame": 17179869185, …}, "</section>"]}
```

`level`: only for a heading. `frame`, `origin`: only for an element of a child frame. Frame
addresses and sensitive fields as in `page.dom@1`. Errors: the ref errors, `content_timeout`.

## Styles

The operations of design §5.7.

### `page.css@1`

| argument | type | |
|---|---|---|
| `css` | string, not blank | required: a style sheet |
| `origin` | string, not blank | required: the origin of the page Kai approved (Origin) |
| `fetch_origins` | list of strings | the origins the sheet may load files from, as Kai's owner approved them; the page's own origin is no exception and must be in it too; default none |
| `tab` | integer | default: the user's tab |

Adds the style sheet to the tab's top document at the user origin (`scripting.insertCSS`, `origin:
"USER"`). Frames are not styled yet.

- **Only to the page Kai approved.** The top document's origin must be `origin`, else
  `page_changed` and nothing is added. The sheet then goes to that document by its id
  (`documentIds`), so a page that is left before Firefox adds it gets none (`page_changed` too).
  A page with an opaque origin is never approved.

- **Every declaration `!important`.** A user-origin sheet beats the page's rules only with
  `!important` (and then also the page's `!important`), so every declaration of its style rules is
  made `!important`: nested rules, the rules in `@media`, `@supports`, `@layer`, `@container` and
  `@scope`, and `@page` too; `@keyframes`, `@font-face` and the other descriptor blocks stay as
  they are.
- **Parsed first.** The text is parsed with a `CSSStyleSheet` (`replaceSync`), and what is
  inserted is that sheet written out again by Firefox, so values come in its form (`rgb(…)` for a
  colour). `replaceSync` drops what it does not understand without an error, so each rule and
  declaration of the text is also parsed on its own, and `dropped` lists what the parser dropped:
  a declaration as written (`"colr: red"`), a rule by its selector or prelude (`"p::bogus { … }"`),
  a statement such as `@import` (a sheet Kai adds cannot import others).
- **Never on Kai's own labels.** A user `!important` rule beats the inline `!important` that
  keeps the host of Kai's hint labels and ring as it is, so every selector's subject gets
  `:where(:not([<marker>]))`, the marker being an attribute that host carries, random per document
  (no specificity is added). `* { display: none }` or a `transform` aimed at the host leave Kai's
  drawings as they are; rules for the root element (`html`, `:root`) apply as written (`@scope`
  would not reach the root element with them, measured). A rule whose selector Firefox would not
  take with the guard is not added and is listed in `dropped` ("… { … } (it could not be kept off
  Kai's own labels)").
- **What it fetches.** A `url( )` in a sheet is a `GET` to its site when the rule applies (a
  background, a font, a cursor, `image-set` too). `fetches` lists every fetch Firefox can make for
  the sheet, each URL once: `{"origin": …, "url": …}` (Origin; `null` for an opaque one). It is
  read from the sheet **as inserted** (Firefox's text of it, parsed again) with CSS's own
  tokenizer, so escapes hide nothing (`u\72l(https://x.example/a)` is `url(`; Firefox keeps a
  value with `var( )` and a custom property's value as written, escapes included, measured). It
  counts:
  - every `url( )` and every string in a function that takes a file (`url("…")`, `src( )`,
    `image-set( )`, `-webkit-image-set( )`, `image( )`, `cross-fade( )`) that is an absolute URL,
    unless it is `data:`, `blob:` or `about:`, which fetch nothing;
  - **every string of every declaration, custom properties included, that is an absolute URL with
    an origin** (`--u: "https://evil.example/?d=1"`): a custom property is used wherever a rule
    names it, the page's own rules too, and `image-set(var(--u) 1x)` in the page's sheet fetches
    Kai's string (measured). A string that is no URL of a site (`"Note: see below"`,
    `"mailto:…"`) is no fetch. Strings in selectors and at-rule preludes are not values and are
    not read for this.

  Relative URLs reach no site from the sheet's own rules (Firefox resolves them against no page;
  measured) and are not listed. A relative string in a custom property that the page's own rule
  uses where a file is named is resolved against the page's sheet (measured): it reaches the
  site the page's sheets come from, and is not listed, as everything the sheet holds is the
  page's to read anyway (its scripts read every computed value). `attr( )` in a function that
  takes a file fetches nothing: Firefox 159 does not use an attribute's value as a URL there
  (measured).

  **A `var( )` inside a function that takes a file is refused (`css_var_url`)**, nothing added:
  what it would load is known only once the page is styled (the page's own custom properties
  included), so it cannot be approved before. The error's `uses` lists each such function as the
  sheet writes it (`"image-set(var(--u) 1x)"`); Kai writes the URL out instead.

  **A sheet that fetches from any origin not in `fetch_origins` is refused with
  `fetch_not_approved`**, nothing added, the error's `fetches` listing those fetches. **This holds
  for the page's own origin too**: a fetch from it is listed like any other and must be in
  `fetch_origins`; the extension approves nothing by itself. So Kai's dialog is authoritative:
  Kai calls `page.css_check@1` first, names the fetches in its confirmation (asking about origins
  other than the page's; the page's own it may pass unasked), and passes the approved origins, the
  page's own included when the sheet fetches from it, in `fetch_origins`.
- **Until the page is left.** A new page in the tab has none of Kai's sheets. A page that Back or
  Forward brings back from the back-forward cache comes back without them too: Firefox keeps a
  sheet in such a page, so the extension takes out every text it ever inserted into that tab's
  frames then.

```json
{"id": 3, "tab": <Page>, "rules": 4, "important": true, "dropped": ["colr: red", "p::bogus { … }", "@import url(more.css)"],
 "fetches": [{"origin": "https://fonts.example", "url": "https://fonts.example/serif.woff2"}]}
```

- `id`: the sheet's number for `page.css_remove@1`, unique for the Firefox run like refs (a
  counter in `storage.local`, begun again at 1 at Firefox's start, `runtime.onStartup`). Each
  Firefox profile has its own counter, so with two profiles linked the same id can name two
  sheets: Kai keeps sheet ids per link.
- `rules`: how many style rules were made `!important`. `important`: always `true`: Kai's answer
  says that every declaration was made `!important`.
- `dropped`: what the parser dropped, `[]` when nothing. `fetches`: as above, `[]` when none.

Errors, checked in this order: `page_changed` (the tab's page is not of `origin`, has an opaque
one, or was left before the sheet was added: "tab 12 shows a page of another origin than the one
Kai approved, so no style sheet was added"), `bad_css` (nothing of the text was understood;
`dropped` lists it), `css_var_url` (a `var( )` inside a function that takes a file: "the style
sheet for tab 12 uses var( ) inside url( ), image-set( ) or another function that loads a file
(listed in uses), so what it would load is known only once the page is styled; write the URL
itself"; `uses` lists them, with the tab fields), `fetch_not_approved` (the sheet loads files
from origins not in `fetch_origins`: "the style sheet for tab 12 loads files from origins not in
fetch_origins, so it was not added"; `fetches` lists those), `no_content` (Firefox did not add
the sheet, its reason in the message), and the errors of reading a page. `bad_args` when `origin`
is missing.

### `page.css_check@1`

| argument | type | |
|---|---|---|
| `css` | string, not blank | required: a style sheet |

What `page.css@1` would do with the sheet, without a tab and without adding it: parsed, checked
and guarded the same way, by the same function, so its `fetches` and its refusals are exactly
`page.css@1`'s for the same text. Kai calls it before it asks its owner, so the confirmation names
what the sheet fetches.

```json
{"rules": 4, "dropped": ["colr: red"], "fetches": [{"origin": "https://fonts.example", "url": "https://fonts.example/serif.woff2"}]}
```

`rules`, `dropped`, `fetches`: as `page.css@1`'s. Errors: `bad_css` (nothing understood;
`dropped`, no tab fields), `css_var_url` (as `page.css@1`'s: "the style sheet uses var( ) inside
…"; `uses`, no tab fields), `bad_args`.

### `page.css_remove@1`

| argument | type | |
|---|---|---|
| `id` | integer from 1 | required: the `id` of `page.css@1` |

```json
{"id": 3, "tab": <Page>, "removed": true}
{"id": 3, "tab": <Page>, "removed": false, "why": "page_left"}
```

- `removed`: the sheet was taken out of the page. Firefox keeps one sheet per text in a document,
  so while another id of the same text is on the page the text stays until that id goes too.
- `why`, only with `removed: false`: `"page_left"` (the page it was added to was left, also when
  Back brought it back from the back-forward cache, without the sheet) or `"tab_closed"` (its tab
  closed a moment ago; once the extension has seen the tab close, the id is `unknown_css`; `tab`
  then carries the id and an empty `title` and `url`).
- Either way the id is done: removing it again is `unknown_css`.

Errors: `unknown_css` (no such sheet: never added, removed already, its tab closed, or from before
the extension restarted, which takes an extension's sheets out of the pages), `no_content`.

## Scripts

The operations of design §5.8.

### `page.script@1`, `page.script_main@1`

| argument | type | |
|---|---|---|
| `code` | string, not blank | required: JavaScript, run as a script |
| `origin` | string, not blank | required: the origin of the page Kai approved (Origin) |
| `tab` | integer | default: the user's tab |

Runs `code` in the tab's top document (`userScripts.execute`): `page.script@1` in an isolated
world (`USER_SCRIPT`), which sees the DOM but not the page's own variables; `page.script_main@1`
in the page's own world (`MAIN`), where the site's JavaScript lives and what the code sets is the
page's. Frames are not run in yet.

- **Only in the page Kai approved.** The top document's origin must be `origin`, else
  `page_changed` and nothing runs. The code then goes to that document by its id
  (`documentIds`), so a page that is left before Firefox runs it does not run it either
  (`page_changed`). A page with an opaque origin is never approved.
- The code runs as a script, never through `eval` (pages with a strict CSP refuse `eval` in both
  worlds, also inside the code), **inside a block**: `"{" + code + "\n}"`. So its top-level `let`,
  `const` and `class` end with the call, and two calls can declare the same name; `var` and
  function declarations still become the world's globals, as in any script, and stay for later
  calls in that world. A top-level `return` is a syntax error, and a `"use strict"` at the top is
  no directive there. Places in the code are as given: `line` 1 is the code's first line, and
  `column` there counts from the code's first character; a syntax error at the very end (an
  unclosed expression) is reported on the line after the code.
- Its value is the last statement's completion value (the last expression's), or what a promise
  there resolves to. It comes back as `JSON.stringify` writes it: `value` is left out for
  `undefined`; a `Map` is `{}`, a `Date` its ISO text, `NaN` `null`.
- **The isolated world** has no messaging to the extension (`browser` and `chrome` are not there:
  Firefox's default, `userScripts.configureWorld` is not called), and its `fetch` is the page's: a
  request with `credentials: "include"` to another origin is sent, but its answer is not readable
  without the other site's CORS consent (tested against two other origins).
- **Page text.** `value` and `thrown` come from the page's world and may hold the page's text
  (and in `page.script_main@1` anything the page's own scripts return or throw). Kai shows them
  under the page header like other page text, never as its own words, and checks its site rule
  against the answer's `tab.url` (the tab as it is after the script) before it shows `value`;
  an error's `url` likewise.
- No time limit of the extension's: the call waits for the value as long as a promise takes, until
  Kai cancels (`cancelled`; the script goes on). A call takes 1 to 5 ms besides (WP0 (b)).

```json
{"tab": <Page>, "world": "USER_SCRIPT", "value": "Lamp care: Northwind Gear"}
{"tab": <Page>, "world": "MAIN"}
```

`world`: `"USER_SCRIPT"` or `"MAIN"`. `tab`: as after the script.

Errors:
- `no_user_scripts`: Firefox has not granted the optional permission `userScripts`: "Kai for
  Firefox may not run scripts in pages yet: allow user scripts in Kai for Firefox's options (the
  button 'Allow user scripts')". Firefox grants it only on a user action, the options page's
  button; about:addons withdraws it.
- `script_error`: the code threw, its promise rejected, or it does not parse. `thrown` is what was
  thrown: an Error (or any object with a string `message`) as `{"name": "TypeError", "message":
  "…", "line": 2, "column": 7}` (`line` and `column` when Firefox gives them), anything else as
  `{"value": …}` (as JSON, else its text). The message names the tab, and the error's name only
  when it has the form of a built-in one (`^[A-Z][A-Za-z]{0,40}Error$`: `TypeError`,
  `NotFoundError`): "the script threw in tab 12 (TypeError)", else "the script threw in tab 12".
  `thrown` is page text (above).
- `page_changed`: the tab's page is not of `origin`, has an opaque origin, or was left before the
  script ran: "tab 12 shows a page of another origin than the one Kai approved, so the script did
  not run", "the page Kai approved in tab 12 was left before the script ran, so it did not run".
- `not_cloneable`: the value cannot leave the page (a DOM node, a function, a window, an object
  that refers to itself), and Firefox fails the call: "end the code with plain data".
- `not_json`: the value left the page but has no JSON form (a `BigInt`); `JSON.stringify`'s reason
  in the message.
- `no_content` (Firefox did not run it, its reason in the message), and the errors of reading a
  page.

## Events

Kai turns events on with `events.config@1`. While they are on, the extension sends Kai an
`event` frame (design §4.2) for each change worth announcing in the user's tab (design §7.1). Kai
speaks them as announcements (§7.2) and keeps them for `browser_context` (`context.get@1`); the
extension only reports, and keeps nothing for later. One kind, `read_ended`, is no event of the
user's tab: it reports the end of a reading session (Reading aloud) and comes whether or not
events are on.

```json
{"t": "event", "seq": 41, "kind": "live", "at": 1793685361020, "focused": true,
 "tab": 12, "title": "Your account: Northwind Gear", "url": "https://shop.example/account",
 "frame": 0, "origin": "https://shop.example", "by_kai": false,
 "region": {"ref": 88, "role": "alert", "name": ""}, "politeness": "assertive", "atomic": true,
 "text": "Payment failed: card declined."}
```

Every event carries:
- `kind`: one of the kinds below.
- `seq`: the event's number on this link: 1 for the first `event` frame after the `welcome`, one
  more for each one after it. The extension sends the frames in `seq` order, which is the order
  it learned of the events; Kai orders them by `seq`.
- `at`: when the extension's background learned of it, in milliseconds since the epoch. Events of
  one batch (below) have the same `at` and follow one another in `seq`.
- `focused`: a window of this Firefox has the desktop's keyboard focus now (as Window's
  `focused`); Kai speaks announcements while Firefox has the focused window or conversation mode
  is on (§7.2).
- `by_kai`: `true` when Kai caused it as far as the extension can tell, else `false`:
  - `live`, `field_error`, `dialog`, `focus`: a change it reports happened while Kai acted in the
    tab, that is from the start of an acting operation on the tab (`element.press@1` to
    `element.scroll@1`, `page.scroll@1`, `page.key@1`) until it answered, or while an input span
    was open (`input.begin@1` until `input.end@1` answered, in any tab). An operation with the
    commit guard on answers after the guard's window, so what the page does within `window_ms` of
    the action counts; with the guard `"off"`, what the page does after the answer does not.
  - `navigated` and `loaded`: the navigation was Kai's (`tabs.open@1`, `tabs.go@1`,
    `tabs.back@1`, `tabs.forward@1`, `tabs.reload@1`, `reader.view@1`) or began while Kai acted in
    the tab; a `loaded` has its page's `navigated`'s.
  - `tab_opened`: the page opened it while Kai acted in the tab.
  - `download_done`: its request began while Kai acted in its `source` tab, or (any download)
    while an input span was open.
  - `read_ended`: the navigation that ended the session was Kai's (as `navigated`'s), or
    `tabs.close@1` closed its tab.

  Kai may keep quiet about what it caused itself, as its tool result says it.
- An event of a tab (every kind but `download_done` and `read_ended`): `tab`, `title` and `url`, the tab as it is
  when the event is sent (the fields an error about a tab carries); `frame`, the frame id of the
  document it comes from (0 for the top document); `origin`, that document's origin (Origin,
  `null` when opaque or unknown). **Kai drops an event when the site of `url` or `origin` is a
  `none` site** (§6.4): a frame of such a site inside an `act` page announces nothing. For
  `tab_opened` Kai checks `opened_url` too; for `download_done`, see there.
- Elements (`region`, `field`, `dialog`, `element`, the `regions` of a `field_error`) are Elements
  with their refs (D4), refs of the frame's document like any other. An element the page removed
  and the garbage collector took loses its place in the ref tables: its ref answers
  `stale_element`, as before.
- **Page text** is every `text`, `error`, `description` and `title`, every name, `file` (the name
  the server or the page gave the download) and `opened_url`. Kai introduces it as the page's and
  never makes it part of its own sentence (§7.2): a name goes inside the framing, quoted ("The
  page says, at the field “E-mail”: invalid address"), or Kai says the role instead ("Error at a
  text field, the page says: invalid address"); never "Error at E-mail".
- **No length limit**: `text`, `error` and `description` are what the page shows, however long (a
  log that added a page of text); a frame over the link's size is split (§4.1). Kai decides how
  much of a long one to speak and says that it stopped early; it does not cut one silently.
- **Sensitive values are masked** in every text and name: the value of every sensitive field of
  the document (a password field, or a field whose `autocomplete` is `cc-number`, `cc-csc`,
  `one-time-code`, `current-password` or `new-password`) reads "password field, filled (15
  characters)" wherever the text has it, also with its white space collapsed or broken
  differently, so a field's error never echoes what was typed into it (§5). A field that was
  sensitive stays so for the document's life: a "show password" button that turns it into a text
  field does not unmask it.

When events come:
- **Only while on.** While off the extension watches nothing and sends nothing, except
  `read_ended`, which comes while they are off too (reading aloud is its own feature: Kai needs the
  end either way). A new link starts with events off: Kai sends `events.config@1` after each
  `welcome`. An event while no link is up is dropped, never kept for a later link.
- **Only from the user's tab** (D9) and its frames. When the user's tab changes (the user
  activates another tab, focuses another window, closes the tab), the old tab's frames stop
  watching and the new tab's start, without another `events.config@1`; while the user is in a
  private window, no tab is watched. Background tabs say nothing. `download_done` and `read_ended`
  are the exceptions (below).
- A document's own changes are watched once it is parsed (`DOMContentLoaded`): what a page changes
  while it loads is not reported, as screen readers stay quiet then. A document restored from the
  back-forward cache asks again whether to watch, and is watched when its tab is the user's.
  Changes are watched in the document and in every open and closed shadow root it has when
  watching starts or when the root's host is added.
- **Batches.** A document sends what it has to say in batches, one at a time: the `live` and
  `field_error` events whose quiet periods end together go in one batch (a field's `field_error`
  before the `live` events), and what the page does in one task goes in one. While a batch is on
  its way to Kai the next one gathers, and there a newer `focus` replaces the one waiting, and a
  dialog's opening and closing that both wait cancel out (nothing is said of a dialog that opened
  and closed again meanwhile). So a page that moves the focus in a loop says where it ended, not
  every step, and nothing is capped or dropped otherwise.

| `kind` | when | its fields |
|---|---|---|
| `navigated` | the top document's URL changed: a new page committed, or a same-document navigation (`history.pushState`, `replaceState`, a fragment) to another URL | `same_document`: `false` for a new page, `true` for a same-document navigation; `url` is the new URL and `origin` its origin |
| `loaded` | the top document finished loading (webNavigation's `onCompleted`; a same-document navigation loads nothing) | `title` is the document's title |
| `dialog` | a modal dialog opened or closed | `open`: `true` or `false`; `dialog`: Element |
| `tab_opened` | a page of the tab opened a tab or window | `opened_tab`, `opened_url`, `opened_window`, `new_window` |
| `live` | a live region changed | `region`: Element; `name`, `name_from` (when found); `politeness`; `atomic`; `text` |
| `field_error` | a field turned invalid, or its error text appeared | `field`: Element; `error`; `description`; `regions`: Elements |
| `download_done` | a download finished | `file`, `path`, `size`, `url`, `final_url`, `referrer`, `source` |
| `focus` | the focus moved to another element of the page | `element`: Element |
| `read_ended` | a reading session ended, and Kai did not end it with `read.open@1` or `read.close@1` | `session`, `tab`, `why` |

**`navigated`** and **`loaded`** are the top document's only, Kai's own navigations
(`tabs.go@1`, `tabs.back@1`) included; `navigated` comes before the `loaded` of its page (a lower
`seq`). A same-document navigation that leaves the URL as the last `navigated` of the tab said it
(a `replaceState` or `pushState` of the same URL, the same fragment again) is not reported; a new
page is, also a reload of the same URL.

**`live`**:
- A live region is an element with `aria-live` `polite` or `assertive`, or, unless its
  `aria-live` is `off`, with the role `alert` (assertive), `status` or `log` (polite); `<output>`
  is a `status`. A change counts for the nearest region around it. An element that becomes one
  later (the page sets `aria-live` or the role) is one from then on, and its first change after
  that is reported.
- **The quiet period:** a region is reported once it has been quiet for `quiet_ms` (Kai's
  `browser.announce_quiet_ms`). Every change of its content starts the wait again, so a region
  that changes in quick succession (a countdown, a ticker) is reported once, with its text as it
  is then; one that never stays quiet that long is not reported. A change of attributes alone
  does not start the wait again when one is under way.
- **`aria-busy`:** while the region or an element around it has `aria-busy="true"`, its changes
  wait; once that is gone they are reported after `quiet_ms`.
- **`aria-relevant`** (on the region; default `additions text`, `all` is all three) decides which
  changes count: `additions` (elements added), `text` (text added or changed), `removals`
  (content removed). An atomic region reports its whole text after any change that counts; another
  region reports what was added or changed. What a non-atomic region loses is not reported yet,
  also with `removals`.
- `text`, never empty (a change that leaves nothing to say sends no event): for an **atomic**
  region (`aria-atomic="true"`, or the roles `alert` and `status` without `aria-atomic`) the
  region's whole shown text; for another (a `log`, a plain `aria-live`) the text of what the page
  added or changed in it during the quiet period and is still there at its end, the outermost of
  them, in the order they came. Text as `page.text_all@1` reads it, blocks joined by `"\n"`, with
  hidden content and content with `aria-hidden="true"` left out.
- A region the page **inserts** together with its text is not reported (screen readers announce
  the changes of regions that are there), except an element of role `alert`, which is announced
  as it appears, as is an element that becomes an `alert` while it shows text.
- A region that changes by its attributes alone (`hidden`, `style`, `class`, `aria-hidden` of it
  or of an element in it: a hidden status shown) says what it shows now that it did not show
  before: an atomic region its whole text when that differs from what it was when last reported
  or first seen; another the lines of its text that are new, so an old entry the page re-styles is
  not said again.
- `politeness`: `"polite"` or `"assertive"`; `atomic`: `true` or `false`; `region`: the region.
- `name`: what the region is about, so a bare value ("3") can be said with its place, page text
  like every name, masked: the region's accessible name (`name_from: "region"`); else, for an
  `<output>`, the accessible names of the controls its `for` lists, joined by ", " (`"for"`: a
  slider's output says the slider's name); else the accessible name of the nearest ancestor its
  author labelled (`aria-label`, `aria-labelledby`), of a `fieldset` with its `legend` or of a
  `figure` with its `figcaption` (`"ancestor"`). Names computed from content (a button's, a
  link's) are not taken, since they would repeat the region's own text. Both keys are absent when
  none of these gives a name.

**`field_error`**:
- A field is looked at `quiet_ms` after its `aria-invalid` turned to a value other than `false`,
  its `aria-errormessage` or `aria-describedby` changed while it has `aria-invalid`, the text of an
  element they name changed or was shown or hidden, the browser's own check failed (an `invalid`
  event: a submit, `requestSubmit`, `checkValidity`), or the user left a field the browser's check
  finds invalid (`:user-invalid`).
- It is reported when it is invalid (`aria-invalid` other than `false`, `:user-invalid`, or the
  browser's check failed) or its `aria-errormessage` elements show text, and not again while its
  `error` and `description` are what it last reported, unless it turned invalid again or a submit
  checked it again.
- `error`: the shown text of the elements `aria-errormessage` names; else, when the browser's check
  failed, its validation message; else `null`. `description`: only when there is one and it
  differs from `error`: the shown text of the elements `aria-describedby` names (where many sites
  put their error). Both masked.
- `regions`: the live regions (Elements) that the elements of `error` and `description` are, or
  are in; `[]` when none is. Such a region's change also comes as its own `live` event, in the
  same batch when one change made both (the `field_error` first). **Kai speaks it once:** it does
  not speak a `live` event whose `region.ref` is in the `regions` of a `field_error` and whose
  `text` is part of that field_error's `error` or `description`, when the two come within
  `quiet_ms` of each other (by `at`), in either order.

**`dialog`**: a `<dialog>` shown with `showModal`, or an element with `aria-modal="true"` whose
role (its first role token Kai knows) is `dialog` or `alertdialog`, that is shown (not
`display: none` or `visibility: hidden`, as `checkVisibility` with `visibilityProperty` says) and
not hidden from assistive technology (no `aria-hidden="true"` on it or around it, as a11y-dialog
closes its dialogs), also inside open and closed shadow roots (Modal). Nested dialogs each open
and close. The `dialog` of a closing is the Element reported when it opened: the same ref and the
name it had then, also when the page removed it. Dialogs open when watching starts are not
reported as opened, their closing is.

**`tab_opened`**: a navigation a page of the tab began in a new tab or window (Firefox's
`webNavigation.onCreatedNavigationTarget`): `window.open`, a `target=_blank` link, also the user's
middle click on a link; tabs Kai opens (`tabs.open@1`) are none. `opened_tab`: the new tab's id;
`opened_url`: the URL it opens; `opened_window`: its window; `new_window`: `true` when that is
another window than the tab's. `frame` and `origin` are the opening frame's (an `about:blank` or
`about:srcdoc` frame's origin is its parent's).

**`download_done`**: a download finished (its state became `complete`), whatever tab started it.
It is no tab's event: it has no `tab`, `title`, `url` of a tab, `frame` or `origin`. Private
windows' downloads are left out. `file`, `path`, `url`, `final_url` and `referrer` as
`downloads.list@1` gives them; `size`: the file's size in bytes, `null` when Firefox does not
say.
- `source`: where it came from, when the extension saw it begin: a navigation of the watched
  tab (a link, a form, a frame) that became the download. Then `{tab, title, url, frame, origin}`:
  the tab and its `title` and `url` as they are when the event is sent (`null` when it closed
  meanwhile), the frame that navigated, and `origin`, the origin of the document that began the
  navigation (`null` when opaque or unknown). Else `null`: a download of another tab, of
  Firefox's own UI, or one the page made without a navigation (a `blob:` or `data:` link).
- **Kai drops a `download_done` when the site of `url`, `final_url`, `referrer`, `source.url` or
  `source.origin` is a `none` site.** When `source` and `referrer` are both `null`, nothing says
  which page it came from: Kai applies the strictest rule configured, as for an opaque origin
  (§6.4).

**`focus`**: the focused element (through frames and shadow roots), when the page moves the focus
(`focusin`); not for the body, and not for a frame element (the frame's own document reports the
element in it). A newer focus replaces one still waiting in its document's batch. Firefox fires
focus events only while its window has the keyboard focus: a `focus()` while another application
has it moves the focus without an event. Kai speaks the newest focus it has not spoken yet and
drops older ones.

**`read_ended`**: a reading session (Reading aloud) ended and Kai did not make it end itself.

```json
{"t": "event", "seq": 52, "kind": "read_ended", "at": 1793685361020, "focused": false,
 "by_kai": false, "session": 1793685350114, "tab": 12, "why": "navigated"}
```

- `session`: the session's id (`read.open@1`); `tab`: its tab's id; `why`: how it ended, one of
  `"navigated"`, `"tab_closed"`, `"discarded"` and `"page_changed"`, as the table of how a
  session ends says (the same word `session_ended` and `read.close@1` give for it afterwards).
  `"replaced"` and `"closed"` are Kai's own doing (`read.open@1` in the tab, `read.close@1`) and
  come with no event; neither does the end of the link (every session is gone with it).
- **Sent while events are off too**, and for a session in any tab, not only the user's. It is no
  event of a page: it has `tab` (the id) but no `title`, `url`, `frame` or `origin`, since the tab
  may show another site now or be gone. Kai's site rules (§6.4) have nothing to judge in it: Kai
  does not drop it.
- Sent once, at the moment the extension learns of the end (not at the next call on the session),
  in the order of the other events (`seq`, `at`): when events are on and the tab is the watched
  one, it follows the `navigated` event of the same navigation. It is no part of a document's
  batch and waits for none.
- `by_kai`: `true` when Kai's other doing ended the session: a navigation Kai began (as
  `navigated`'s) or `tabs.close@1`; else `false`.
- A session that ends while no link is up says nothing to a later link (every session is gone
  when the link drops).

### `events.config@1`

| argument | type | |
|---|---|---|
| `on` | boolean | required |
| `quiet_ms` | integer from 0 to 2147483647 | required when `on` is `true`: the quiet period of `live` and `field_error` (Kai's `browser.announce_quiet_ms`) |

```json
{"on": true, "quiet_ms": 1000, "tab": 12}
{"on": false, "quiet_ms": null, "tab": null}
```

`tab`: the tab watched now (the user's tab); `null` while off or while the user is in a private
window. A call with another `quiet_ms` changes the wait for the changes that come after it.
`on: false` does not stop `read_ended`. Errors: `bad_args`.

## Reading aloud

Kai reads a page aloud (design §7.3): Kai holds the playback, one TTS request per sentence and
the voice for the paragraph's language; the extension holds the page side: the paragraphs, the
read position's mark, the scrolling. A session is `read.open@1`, `read.paragraph@1` and
`read.mark@1` for each paragraph as it is read, and `read.close@1`; `read_pause`, `read_resume`
and `read_skip` are Kai's, which keeps the index. A session that ends other than by Kai's own
`read.open@1` or `read.close@1` (its tab navigates, closes or is discarded) is reported at once as
a `read_ended` event (Events), whether or not events are on, so the reading need not go on until
the next call finds out.

**Paragraph**: one text block of `page.text_all@1` (Block), in reading order across frames (a
frame's paragraphs where its `<iframe>` is), with hidden content left out, Kai's own drawings
never in, and sensitive fields' values masked, also where the page's text repeats one (as Events
mask it: "Your code password field, filled (15 characters) opens the door"). A frame that cannot
be read has none (`frames` names it). The paragraphs are the page's text when `read.open@1` ran.

### `read.open@1`

| argument | type | |
|---|---|---|
| `tab` | integer | default: the user's tab |
| `ref` | integer from 1 | start at this element (`read_aloud_from`); it names its tab, so not with `tab` |

```json
{"session": 1793685361020, "tab": <Page>, "paragraphs": 11, "start": 0, "from": "view", "frames": <Frames>}
```

- `session`: the session's id, a whole number; ids rise across restarts of the extension, so an
  id from before a restart is `unknown_session`, never another session.
- `paragraphs`: how many there are, numbered from 0. `start`: the paragraph to read first, `null`
  when there are none. `from` says how it was found:

  | `from` | `start` is |
  |---|---|
  | `"ref"` | the paragraph that holds the text of `ref`'s element, or the first after it (a container's first paragraph; for an element without text, the next) |
  | `"focus"` | without `ref`: the same for the focused element (through frames and shadow roots), when the focus is on an element other than the body |
  | `"view"` | else the first paragraph in view (In view) |
  | `"below_view"` | none is in view: the first below the top of the view |
  | `"top"` | none is in view or below it: the first of the page |
  | `null` | the page has no paragraphs; `start` is `null` too |

  When the element of `ref`, or the focused one, has no paragraph in or after it in its frame (a
  field at the end of the page), the rules of the view decide: `start` is never a paragraph before
  the element.
- One session per tab: `read.open@1` in a tab that has one ends it (`replaced`).

Errors: `bad_args` (`tab` and `ref` both given), the ref errors, `stale_element`, and the errors
of reading a page.

### `read.paragraph@1`

| argument | type | |
|---|---|---|
| `session` | integer from 1 | required |
| `index` | integer from 0 | required: a paragraph of the session |
| `rules` | object | the speech clean-up rules switched on or off (below); a rule not named has its default |

```json
{"session": 1793685361020, "index": 1, "tab": <Page>,
 "text": "We left at dawn [1] and walked **north** along the ridge.",
 "spoken": "We left at dawn and walked north along the ridge.", "lang": "en", "ref": 215,
 "frame": 0, "origin": "https://journal.example"}
{"session": 1793685361020, "index": 0, "tab": <Page>, "text": "Three nights in the hills",
 "spoken": "Three nights in the hills", "lang": "en", "ref": 214, "heading": 1, "frame": 0,
 "origin": "https://journal.example"}
```

- `text`: the paragraph as `page.text_all@1` reads it. `spoken`: the same through the speech
  clean-up rules, for the TTS request; it may be `""` when the rules removed everything (a
  paragraph that is only a URL), which Kai skips.
- `lang`: the language of the paragraph: the nearest `lang` attribute at or around its element
  (`ref`'s, across shadow roots), else its document's `<html lang>`; `null` when none says. A
  `lang` inside the paragraph (a French greeting in an English sentence) is not the paragraph's.
  Kai reads it in the voice it has for that language, else in its own.
- `ref`: the element the paragraph's text belongs to (its block: a paragraph, a heading, a list
  item; for text directly in a container between its blocks, the container). `heading` (its
  level) and `item` as Block.
- `frame` and `origin` always, also for the top document (0 and its origin): **Kai does not read a
  paragraph whose site, or whose tab's site, is a `none` site** (§6.4). `tab`: the tab now.

The speech clean-up rules (the earlier extension's, lifted with their defaults; each removes marks and joins
what it broke, none drops a sentence or cuts the text). A paragraph is page text, not markdown,
and three of them differ there from its defaults: `markdown` keeps a line's leading number ("3.
Oktober", "1. FC Köln"), `symbols` keeps `§`, and `hyphens` joins two letters of any script
(the earlier rule joins ASCII letters, digits and `_`):

| rule | default | removes |
|---|---|---|
| `hyphens` | on | line breaks inside hyphenated words ("infor-\nmation"), soft hyphens, zero-width characters |
| `markdown` | on | `**bold**`, `_italic_`, `` `code` `` (the text stays), `#` headings, bullets, table pipes, `[text](url)` → text, stray HTML tags |
| `citations` | on | reference marks: `[23]`, `[12–15]`, `[^1]`, `[a]`, `[iv]`, `[citation needed]`, `[edit]` |
| `superscripts` | off | ¹²³ and the other superscript digits, which also carry meaning in units (m², cm³) |
| `urls` | on | URLs and e-mail addresses, which TTS spells out |
| `symbols` | on | emoji, ★ ▪ • bullets, arrows, box drawing, ¶ † ‡ |

Errors: `unknown_session`, `session_ended`, `bad_args` (an `index` past the last paragraph, a rule
that is none of these or a value that is not `true` or `false`).

### `read.mark@1`

| argument | type | |
|---|---|---|
| `session` | integer from 1 | required |
| `index` | integer from 0 | the paragraph to mark; without it the mark is cleared |

```json
{"session": 1793685361020, "index": 10, "marked": true, "scrolled": true}
{"session": 1793685361020, "index": 10, "marked": false, "scrolled": false, "why": "removed"}
{"session": 1793685361020, "index": null, "marked": false, "scrolled": false}
```

- Draws the **reading mark** around the paragraph's text: a box in Kai's accent colour over the
  page, out of the page's reach like the hint labels (`hints.show@1`), placed again at each frame
  the page draws, so it follows the text whatever moves it (a scroll, a resize, a reflow or a
  transform above it). A session has one mark: marking another paragraph moves
  it, also into another frame. It is never the page's text, and screenshots hide it like Kai's
  other drawings.
- Scrolls the paragraph into view first when it is not wholly in view: the scroll containers
  around it innermost first, then its document, then for a frame's paragraph each document around
  the frame up to the top; at once, also where the page asks for smooth scrolling. A paragraph that fits in the view is centred; a taller one comes with
  its top at the top. `scrolled`: anything scrolled.
- `marked: false` with an `index`: the paragraph's text is gone from the page (the page changed
  under it); an answer, never an error, and then nothing is drawn or scrolled and the session's
  earlier mark is gone. The session itself goes on: its other paragraphs can still be marked.
  `why` (only here) says which: `"removed"`: the page removed the paragraph's text (its first or
  last text node left the document); `"frame_left"`: the paragraph's frame went to another page or
  is gone, or its document no longer holds the session's paragraphs. Without an `index`,
  `marked: false` just says the mark is cleared, with no `why`.

Errors: `unknown_session`, `session_ended`, `bad_args` (an `index` past the last paragraph).

### `read.close@1`

| argument | type | |
|---|---|---|
| `session` | integer from 1 | required |

```json
{"session": 1793685361020, "closed": true}
{"session": 1793685361020, "closed": false, "why": "navigated"}
```

Ends the session: its mark goes and the frames forget its paragraphs. A session that had ended
answers `closed: false` with its `why`. Errors: `unknown_session`.

**A session ends** with the first of these; its calls then fail with `session_ended`, whose `why`
says which, and `read.close@1` answers it as above. Every end but the last two also reaches Kai as
a `read_ended` event when it happens (Events):

| `why` | the session's tab | `read_ended` |
|---|---|---|
| `"navigated"` | shows another document in its top frame (a navigation, Back and Forward included, a reload), or went to another path by a same-document navigation (`pushState`, `replaceState`); a query or fragment of its own keeps the session | yes |
| `"tab_closed"` | closed | yes |
| `"discarded"` | was discarded: Firefox unloaded its page (to free memory); the tab loads the page again when it is selected, which is another page than the session read | yes |
| `"page_changed"` | shows another top document than the one the session read, without a navigation the extension saw end it: the page changed while `read.open@1` was reading it, before the session existed, or Firefox swapped the document without telling the extension | yes |
| `"replaced"` | got another session from `read.open@1` | no |
| `"closed"` | `read.close@1` ended it | no |

Sessions belong to the link: when it drops, every session is gone and its id is
`unknown_session`.

## The sidebar's requests

The sidebar (design §8) is lmgw's Chat. It holds no credential and never reaches lmgw itself: every
HTTP request it makes goes from the sidebar page to the background over a `runtime.Port`, from the
background to Kai as a `req` frame, and from Kai to lmgw over Kai's device link with Kai's own
certificate (decision 9: lmgw sees the sidebar as Kai). Kai relays lmgw's answer as a `res` frame,
the body's `chunk` frames and an `end`. Built in WP8a: Kai's proxy (Kai `src/browser/sidebar/`,
`src/lmgw_link/proxy/relay.rs`) and the background's relay (`extension/background/sidebar.js`); the
sidebar page in WP8b (`sidebar/`, its transport `sidebar/src/transport.rs` with the frames in
`sidebar/src/wire.rs`), with the page's own calls for its site strip (below).

### Who may send them

- **In the extension**, the background takes requests only on a port named `kai-sidebar` whose
  sender is the extension's own sidebar page: `sender.id` is the extension's, `sender.url`
  without its query and fragment is `browser.runtime.getURL("sidebar/sidebar.html")`, and
  `sender.tab` is not set. Anything else that connects with that name (the same page in a tab,
  another page of the extension, a content script) gets `{"t":"refused","reason":"…"}` and the port
  is disconnected; nothing it sends reaches Kai. A web page cannot connect at all.
- **In Kai**, `req` frames come only on a link that passed the peer check and the hello (design
  §4.4); a link is one Firefox profile, and Kai keeps each link's requests apart.

### The frames on the link

| `t` | Direction | Fields |
|---|---|---|
| `req` | ext → Kai | `id`, `method`, `path`, `headers`, `body`, `read` |
| `res` | Kai → ext | `id`, `status`, `headers`, `body` (`"text"` or `"base64"`): the answer's head, once |
| `chunk` | Kai → ext | `id`, `seq` (from 0), `data`: a piece of the body |
| `end` | Kai → ext | `id`, `seq` (the number of pieces); `error` (`code`, `message`) only when the answer ends early: lmgw's stream broke off after its head (`lmgw_broke_off`), or Kai left the gateway (`gateway_left`, below) |
| `ack` | ext → Kai | `id`, `seq`: how many pieces of the body the page took |
| `abort` | ext → Kai | `id`: the page dropped the request |
| `error` | Kai → ext | `code` `duplicate_req` (with `id`: a request of that id is open on the link; the second was not sent), `bad_site` (with `id` where the question had one: a `site` question that does not read) or `id_too_long` (`size`, `limit`: an id that leaves no room for a piece beside it; it carries no `id`, since its id is what does not fit, and the background's ids never come near it) |
| `site` | ext → Kai | `id`, `urls`: the addresses whose site rule the sidebar asks (The page's own calls, below) |
| `site` | Kai → ext | `id`, `rules`: one `{site, rule}` per address, in their order |

`req`:
- `id`: a whole number, the background's own count for the link, never reused while the extension
  runs; unique among the link's open requests. (Kai answers any JSON number or string as it came.)
- `method`: `"GET"` or `"POST"`, the only methods lmgw's Chat plane has.
- `path`: lmgw's path with its query, as the Chat names it (`/chat/api/threads/12/send`,
  `/v1/audio/voices?model=tts-de`).
- `headers`: an object of names and texts, names in any case. Only `content-type` and
  `last-event-id` go; the request carries nothing else of the page's, and the certificate
  authenticates it. Absent or `{}`: none.
- `body`: absent or `null` (none), `{"text": "<UTF-8 text>"}` (JSON) or `{"base64": "<bytes>"}`
  (a file, a recording). A long `req` is split like any long frame (design §4.1); the body is never
  cut.
- `read`: `"whole"` (the default) or `"stream"` (lmgw-ui-kit's `Read::Stream`: the send stream and
  its relatives, the feed, read-aloud). A `Read::Blob` is `"whole"`.

The answer, in this order: one `res`, the body's `chunk` frames with `seq` from 0, and the `end`
whose `seq` is their count. Each frame is within Firefox's 1 048 576 bytes; a body of any length
goes in as many pieces as it takes.
- `res.status` is lmgw's, or Kai's own refusal's (below).
- `res.headers`: names in lower case; only `content-type`, `content-disposition` (a download's
  name), `retry-after` and every `x-lmgw-*` (`x-lmgw-fallback`: which model answered); a repeated
  one's values joined by `, `.
- `res.body` says how `data` reads. `"text"`: the pieces are text that joins to the body, each
  piece whole characters. `"base64"`: each piece's `data` decodes on its own to bytes, which join.
  Kai sends a whole JSON or `text/*` answer that is UTF-8 as text, and a streamed
  `text/event-stream` or JSON answer as text decoded the way SSE decodes (an invalid byte sequence
  becomes U+FFFD; a character lmgw's chunks split is kept whole); everything else as base64.
- Content types pass as lmgw sent them: the Chat shows proxied bytes only as an `<img>`, an
  `<audio>` or a download, never as a page.

```json
{"t":"req","id":41,"method":"GET","path":"/chat/api/feed","headers":{"last-event-id":"e1:9:bb"},"body":null,"read":"stream"}
{"t":"res","id":41,"status":200,"headers":{"content-type":"text/event-stream"},"body":"text"}
{"t":"chunk","id":41,"seq":0,"data":"id: e1:9:bc\nevent: thread.updated\ndata: {\"thread_id\":12}\n\n"}
{"t":"ack","id":41,"seq":1}
{"t":"chunk","id":41,"seq":1,"data":": keep-alive\n\n"}
{"t":"end","id":41,"seq":2,"error":{"code":"lmgw_broke_off","message":"lmgw's answer broke off: connection reset"}}
{"t":"req","id":42,"method":"POST","path":"/chat/api/threads/12/attachments?name=plan.pdf","headers":{"content-type":"application/pdf"},"body":{"base64":"JVBERi0xLjcK…"},"read":"whole"}
{"t":"res","id":42,"status":201,"headers":{"content-type":"application/json"},"body":"text"}
{"t":"chunk","id":42,"seq":0,"data":"{\"id\":91,\"name\":\"plan.pdf\"}"}
{"t":"end","id":42,"seq":1}
```

### Whole and streamed answers, and their bounds

- **Whole** (`read: "whole"`): Kai reads lmgw's whole answer first, then sends `res` and the body.
  Kai's setting `window.proxy_max_mb` (default 64 MB) bounds it: an answer known to be larger (by
  its `content-length`, else as it arrives) is refused 502 `answer_too_large`.
  `window.proxy_timeout_s` (default 0: lmgw's own timeouts) bounds the whole exchange.
- **Streamed** (`read: "stream"`): Kai sends `res` as soon as lmgw's head comes and each piece as
  lmgw sends it, with no bound on the stream's length or size: nothing holds it.
  `window.proxy_timeout_s` bounds only the head, so the feed stays open for hours. A link that goes
  silent is the page's to notice (lmgw's chat-plane design D23: two of `hello`'s keep-alive
  intervals), not the relay's.
- **The request's body** is bounded by `window.proxy_max_mb` too (413 `body_limit`).
- **The feed's cursor:** `last-event-id` goes to lmgw as it came, and the stream's `id:` lines come
  back unchanged in the text, so the page keeps the cursor and sends it when it reconnects (lmgw's
  chat-plane design §8.3).

### Flow control

Native messaging has no backpressure: Firefox reads whatever the host writes into the background's
queue, and a runtime port to the page has none either. So the page paces Kai:

- **The page acknowledges each piece as it takes it from its port**, for `read: "whole"` and
  `read: "stream"` alike: `{"t":"ack","id":…,"seq":n}`, `n` counted like `end`'s `seq` (the pieces
  taken, so the next piece's `seq`). Only a stream's consumer may pace, by acking a piece once it
  has handled it rather than as it arrives; a whole answer is acked as it comes in, never once it
  is complete, since a whole answer larger than the window would then wait forever for the ack
  that lets its next piece go. Acks are cumulative: the page may ack each piece or several at once,
  a smaller `n` than before changes nothing, and an ack for a request that ended is dropped. An
  `n` above the pieces Kai sent counts as the pieces sent (Kai logs it), so no ack takes the window
  away.
- Kai keeps the pieces not acknowledged yet within its setting `browser.sidebar_ahead_mb` (default
  4 MB; 0: no bound), counting each piece's frame; one piece always goes, so a piece of up to
  1 MiB never stalls. While the window is full Kai reads no more of a stream from lmgw, and lmgw's
  connection carries the pressure. The `res` and the `end` do not count and never wait.
- The background passes the page's acks on and acknowledges nothing itself.

Why: the window is the sender's, in bytes, and the acks are the consumer's and cumulative. The page
needs to know nothing of the window (it says what it took), a coalesced or late ack is made good by
the next, and memory at every hop (Kai, Firefox's queue, the port, the page) is bounded by the
window plus one piece. A window counted in pieces would bound nothing useful, since a piece is 30
bytes of SSE or 1 MiB of a picture; a stop-and-wait per piece would cost a round trip through
Firefox per event of the send stream.

### Cancel

- `{"t":"abort","id":…}` ends the request: Kai drops its connection to lmgw, which sees the client
  go (a send's turn stops, as the dashboard's Stop does), and sends nothing more for it. Frames
  already on their way may still come; the background drops frames of an id it no longer has.
- A page whose port disconnects (the sidebar closed, its page reloaded) aborts every request it had
  open.
- The link ending ends every open request: Kai drops them, and the background ends each at its
  page with `end` and `error.code` `no_link`.
- Kai leaving the gateway the requests went to (a pairing with another lmgw begins, or its device
  key was revoked) ends every open request with `end` and `error`
  `{"code": "gateway_left", "message": …}`, before its `res` or after it; Kai drops its connection
  to lmgw. The link stays, and the page asks again once Kai is linked to an lmgw.
- Kai's `error` frame about a request (`duplicate_req`) ends it too: the background sends the page
  `end` with that `error` (`code`, `message`), forgets the request and sends `abort` for its id, so
  the request Kai holds under it ends as well.

### Refusals

Kai's own refusals are a `res` with the status and a JSON body in lmgw's error shape `{code,
message}` (`content-type: application/json`), so the Chat shows them as it shows lmgw's; each
message names the request or the setting:

| status | `code` | when |
|---|---|---|
| 404 | `not_admitted` | the method and path are not one of the Chat's requests (below) |
| 400 | `header_not_admitted` | a header other than `content-type` and `last-event-id` |
| 400 | `bad_req` | a field that does not read: no text `method` or `path`; `headers` not an object of texts, a value a header cannot carry, a name twice; a `body` other than `{"text"}` or `{"base64"}`, or base64 that does not decode; a GET with a body; a `read` other than `"whole"` and `"stream"` |
| 413 | `body_limit` | the request's body is larger than `window.proxy_max_mb` |
| 503 | `not_paired` | Kai holds no working pairing (the message says what to do) |
| 502 | `lmgw_unreachable` | lmgw could not be reached (the message says why) |
| 504 | `timeout` | no answer (whole) or no head (streamed) within `window.proxy_timeout_s` |
| 502 | `answer_too_large` | a whole answer larger than `window.proxy_max_mb` |
| 502 | `lmgw_broke_off` | a whole answer broke off before its end |
| 503 | `kai_quitting` | Kai is quitting |
| 503 | `no_proxy` | the Kai serves no sidebar proxy (a test build's) |

A streamed answer that breaks off after its head ends with `end` and
`error: {"code": "lmgw_broke_off", "message": …}`; one Kai stops because it left the gateway, with
`gateway_left` (Cancel, above). lmgw's own refusals pass as they are: its status, the headers above
and its body.

### What Kai forwards

Exactly the requests lmgw's Chat makes (`lmgw-chat-ui` and the kit pieces it renders, as read at
lmgw's WP3b), by method and path: 51 routes. The query is passed on as it came (only its characters
are checked), and lmgw reads it. `{id}` is a whole number in lmgw's `i64` range, `{name}` one path
segment of URL characters. Every segment, percent-decoded, is not empty, `.` or `..`, and holds no
`/` or `\`: a URL library reads `%2e`, `%2E%2E`, `.%2e` and `%2e.` as dot segments too, so
`/chat/api/threads/7/tasks/%2e%2e/cancel` would reach `/chat/api/threads/7/cancel`; Kai refuses it.
The list is Kai's `src/browser/sidebar/admit.rs`.

| | |
|---|---|
| GET | `/chat/api/feed`, `/chat/api/settings`, `/chat/api/tools`, `/chat/api/tools/{name}`, `/chat/api/knowledge/bases`, `/chat/api/knowledge/files/{id}/text`, `…/original`, `/chat/api/media/defaults`, `/chat/api/profiles`, `/chat/api/search`, `/chat/api/export`, `/chat/api/threads`, `/chat/api/threads/rows`, `/chat/api/threads/{id}`, `…/export`, `…/tasks`, `/chat/api/folders/{id}/export`, `/chat/api/attachments/{id}`, `…/text`, `/v1/models`, `/v1/audio/voices` |
| POST | `/chat/api/threads`; a thread's `settings`, `delete`, `pin`, `title`, `archive`, `persist`, `move`, `attachments`, `transcribe`, `voice/warm`, `speech/stop`, `tasks/{name}/cancel`, `media/{name}/cancel`, `messages/{id}/delete`, `messages/{id}/speak`; the turns: `send`, `continue`, `approvals`, `answer`, `messages/{id}/edit`, `messages/{id}/regenerate`; `/chat/api/folders`, `/chat/api/folders/{id}`, `…/current`, `…/delete`; an attachment's `delete`, `mode`, `transcribe`, `media` |

Not forwarded: every `/api` route (the admin plane), the rest of `/v1`, `/v1/realtime` (a WebSocket
the sidebar does not proxy yet), the profile editor's writes (the Chat lists the profiles only),
and `GET /chat/api/folders` (the Chat reads the folders inside `GET /chat/api/threads`).

**The turns** (design §8.3): the sidebar is Kai, and lmgw names its turns as Kai's own; their tool
calls reach Kai as `Caller::Own` and count as the owner's act, and none of this changes that. Kai
tells the sidebar's turns from its own only for its voice: automatic listening holds back while one
runs (Kai's K16), and the approval card names the sidebar and keeps the turn's calls from the
talk key (K17). Whose a turn is follows the turn: `send`, `continue`, `answer`, a message's `edit`
and `regenerate` mark their thread before they go, and the thread's next own `turn.started` that is
no voice turn is the sidebar's (the mark waits for it after the request ended, and goes at once
when lmgw refused the request); a resumed turn (calls decided, by `approvals` from anywhere) is
read as the turn it resumes. An image card's action (`/chat/api/attachments/{id}/media`) starts no
turn: lmgw runs it with no model in the loop.

### The page's port

What the sidebar page and the background say over the `kai-sidebar` port:
- **Page → background:** `req` (the fields above; its `id` the page's own whole number, unique
  among its open requests), `ack`, `abort`, each with the page's ids.
- **Background → page:** `link` (`up`: whether Kai is linked; when the port opens and at every
  change), and Kai's `res`, `chunk` and `end` under the page's ids. An `end` without `seq`, with
  `error.code` `no_link`, ends a request the link's end left open, or one sent while there is no
  link; one with Kai's `duplicate_req` ends a request Kai refused that way.
  `{"t":"error","code":"bad_req","id":…}` answers a `req` whose `id` is not a whole number or
  is open on the port; `refused` (`reason`) answers a sender that is not the sidebar page.
- **Page → background, its own calls** (below): `site`, `page_text`, `hints`, each with the page's
  `id`; **background → page:** `answer` (`id`, and `ok` or `error` with `code` and `message`).
- **What lmgw-ui-kit's `Transport` for the sidebar must do (WP8b):** ack each `chunk` as it takes it
  from the port (`{"t":"ack","id":…,"seq":<its seq + 1>}`, or one ack for several), for a whole
  answer as for a stream; only a stream's consumer may hold its acks back to pace Kai, and a whole
  read never waits for its end before acking (Flow control). An `end` with an `error` before any
  `res` is `send`'s `Err` (no answer: `no_link`, `gateway_left`, `duplicate_req`); after the `res`
  it is the stream's `Err` (`lmgw_broke_off`, `gateway_left`, `no_link`). A refusal is a `res` like
  lmgw's. A request it drops is `abort`ed.
- **As built (WP8b, `sidebar/src/transport.rs`):** a whole answer's pieces are acknowledged as they
  come off the port, a stream's as the Chat takes them from the stream; the `AbortSignal`, a dropped
  `send` future and a stream dropped before its end each send `abort`; `link {up}` and the port
  itself drive the Chat's `locked`, and a port that drops is opened again after 1 s, doubling to
  30 s (a refused one is not). The page keeps the feed's cursor as the Chat takes its pieces (each
  record's `id:`, `hello`'s and `caught_up`'s `cursor`): the Chat closes its feed while locked and
  opens a new one without `Last-Event-ID` when the link is back, and that one is sent with the kept
  cursor; a `400` to it is asked again at once without it, and `gateway_left` drops it. Each feed
  stream reads its own records (a stream the lost link cut off half way through a record leaves
  nothing in the next one's); only the cursor is shared.

### The page's own calls

Besides lmgw's requests, the sidebar asks the background three things for its site strip (design
§8.1), each answered `{"t": "answer", "id": …, "ok": …}` or `{"t": "answer", "id": …, "error":
{"code", "message"}}`; a call without a whole-number `id` gets `{"t": "error", "code": "bad_req"}`.
The site rules are Kai's (`[browser.sites]`, the rules the browser tools apply), so the background
asks Kai with a `site` frame, which Kai answers itself (nothing goes to lmgw):

```json
{"t":"site","id":57,"urls":["https://news.example/today","https://consent.example",""]}
{"t":"site","id":57,"rules":[{"site":"news.example","rule":"read"},{"site":"consent.example","rule":"act"},{"site":"","rule":"none"}]}
```

Each address gets the rule Kai's tools give a frame (`SiteRules::frame_rule`): a page's URL its
site's (Reader view's and `view-source:`'s the page inside), a frame's origin its own site's, and
`""` or `"null"` (an opaque origin, as a browser serializes one) the strictest rule any entry
gives (`act` without entries); `site` is the host and port the rule was read for, `""` without
one.

**Rule words:** `act` and `read` are the only words that let anything through. The background and
the strip read every other word, or a missing `rule`, as `none` (a newer Kai's word this version
does not know fails closed); the `site` call answers it as `none`.

**A Kai too old for the question:** Kai's `welcome` lists the extension's frames it takes
(`takes`, design §4.2). The background sends `site` only to a Kai that lists it; to any other (a
Kai before the list) the call fails at once with `kai_too_old` ("Kai … does not answer the
sidebar's question about a site's rule yet: update Kai"), and the strip shows "update Kai". A Kai
that gets a frame it does not take with an `id` answers `{"t": "error", "code": "unknown_frame",
"id": …, "message": "Kai … does not take a … frame: update Kai"}`, which ends the question the same
way (the strip shows it alike).

| call | fields | `ok` |
|---|---|---|
| `site` | `url` | `{"site": "news.example", "rule": "read"}` |
| `page_text` | `tab` | `{"title", "url", "text", "article"}`: the tab's readable text as `page.text@1` reads it, as lines (a heading as `#`s, a list item after `- `, a frame that could not be read said where it is) |
| `hints` | `tab`, `on` | `{"shown": true, "labels": n}` or `{"shown": false, "removed": n}` (`hints.show@1`, `hints.hide@1`) |

- `page_text` and `hints` with `on: true` read only a web page or a local file (`http:`, `https:`,
  `file:`), judged by the URL of the tab's top document (`webNavigation.getFrame`, frame 0): any
  other page (Firefox's own, an extension's, `moz-extension:` included, `data:`) is `not_a_site`
  before Kai is asked. A page whose rule is `none` is `site_none` before it is read.
- **Pinned to the document whose rule was asked:** the background takes frame 0's `documentId`
  before it asks Kai, and every call of the read to the top frame goes to that document alone
  (`tabs.sendMessage` with `documentId`, an injection with `documentIds`). A document that is no
  longer the frame's when a call goes (a navigation, a meta refresh, a redirect, a script's
  `location =` committed before or during the read) fails it with `page_changed`; the page after it
  is never read. The read's answer says which document it came from (its `documentId`, URL and
  title, as the content script reads them), and the rule that counts is the one of that URL: a
  script may have moved it within the document (`history.pushState`), in which case Kai is asked
  again (`site_none`, or `page_changed` when it is no site). The header is that document's title
  and URL. The hints are pinned the same way (`page_changed`, and none drawn).
- `page_text` leaves out the blocks of each frame whose origin's rule is `none` (one line, "(a
  frame of a site Kai does not reach)", where they were); a frame's own answer names its origin.
- Labels a page turned on go when its port does. When the port went, or the page turned them off,
  while they were drawn, the background hides them again and the call fails with `hints_off`.
- Errors besides those: `no_link` (no Kai, or the link ended before Kai answered), `kai_too_old`
  and Kai's `unknown_frame` (above), `loading` (the tab shows no document yet), `no_tab`,
  `bad_args`, `bad_answer` (Kai answered another number of rules than addresses), and the
  operations' own (`page.text@1`'s, `hints.show@1`'s).

## Errors

| code | when |
|---|---|
| `bad_args` | an argument is unknown, missing, or of the wrong type or value; the message names it |
| `unknown_op` | the extension does not serve this operation (the message lists what it serves) |
| `cancelled` | Kai sent `cancel` for the call while it waited for a navigation (`reader.view@1`'s too), `pdf.bytes@1` or `page.source@1` fetched, a script's value was awaited, an acting operation's network gate (or `gate.result@1`) waited, or `input.end@1` waited |
| `internal` | the extension failed unexpectedly; the message carries the cause |
| `no_tab` | no tab with this id that Kai may use (closed, or in a private window) |
| `private_window` | the user's tab, or the named tab, is in a private window |
| `no_window` | Firefox has no normal window open |
| `tab_closed` | the tab closed while the operation waited for its load |
| `bad_url` | `url` is not an absolute URL (for `history.seen@1`: or has no origin a history could have seen) |
| `url_refused` | a scheme that loads no page in a tab (the message names it), or Firefox does not let extensions open this URL |
| `no_history` | `tabs.back`/`tabs.forward` on a tab whose history has one page |
| `no_navigation` | Back or Forward did not start a navigation within `nav_start_ms` |
| `nav_timeout` | the navigation did not answer as its `wait` says within `nav_load_ms`; the tab goes on loading |
| `unknown_ref` | the ref was never given out in this Firefox run, or is from before the extension restarted ("ref 214 is from before Kai for Firefox restarted …") |
| `stale_tab` | the ref's tab is closed |
| `stale_document` | the ref's page was left: "ref 214 is from the page before the last navigation in tab 12", also for a frame's page, a frame that is gone, a page that is being left, and a page Back or Forward brought back from the back-forward cache |
| `stale_element` | the ref's page is there, the element is not ("…no longer in the page of tab 12 (the page removed it)") |
| `content_timeout` | a page (the top document, or the ref's document) did not answer within the extension's setting `content_ms` (`element.fill@1`: `keys_ms` and then `content_ms`): "tab 12 did not answer within 15000 ms (Kai for Firefox's setting content_ms): its page is busy, or its script is stuck"; asking again once the page is free answers |
| `not_a_table` | `table.read@1`'s ref is no table and is in none |
| `not_pdf` | `pdf.bytes@1`'s tab shows a page the extension can read, or its URL now answers something that is no PDF |
| `fetch_failed` | `pdf.bytes@1` could not fetch the PDF, or the server answered an HTTP error; `page.source@1`'s fetch failed |
| `no_container` | `tabs.open@1` with `sandbox: true`: Firefox did not give the "Kai" container (its reason in the message) |
| `disabled` | the element (or the option named) is disabled: natively, by a disabled fieldset, or by `aria-disabled` on it or an ancestor |
| `inert` | the element is inert: inside `inert`, or outside the open modal dialog (the message says which) |
| `not_shown` | the element is not shown (`display: none`, `visibility: hidden`), nor, for a checkbox or radio, a label of it; `element.see@1` has nothing to see |
| `readonly` | `element.fill@1` on a read-only field |
| `not_fillable` | `element.fill@1` on an element that is no field it fills (the message names the operation that fits) |
| `bad_value` | the value does not fit the element: a number outside a slider's range or no number, `on: false` for a radio, several files for a single file input; or Firefox refused `page.zoom@1`'s zoom (its range in the message) |
| `no_option` | `element.choose@1` found no option of that label; `options` lists the labels |
| `not_choosable` | `element.choose@1` on an element that is no select, list box, radio group, combobox or input with a list |
| `not_checkable` | `element.check@1` on an element that is no checkbox, radio, switch or toggle button |
| `not_a_file_input` | `element.file@1` on an element that is no file input nor a label of one |
| `not_scrollable` | `element.scroll@1`: no scroll container at or around the element |
| `other_document` | `element.drag@1`'s two refs are in different documents |
| `unknown_gate` | `gate.result@1` for a gate that is not waiting to be read |
| `unknown_mark` | `element.unmark@1` for a mark that is not set |
| `unknown_span` | `input.end@1` for a span that is not open |
| `not_rendered` | `page.see@1`, `element.see@1`: Firefox unloaded the tab (a discarded background tab) |
| `not_in_view` | `element.see@1`: no part of the element can be brought into view |
| `no_article` | `reader.view@1` with `on: true`: Firefox finds no article in the page |
| `source_unknown` | `page.source@1`: the extension does not know how the page was requested (it loaded before the extension started, Back restored it without a record, it came from no request, or Firefox did not report its request within `content_ms`) |
| `not_get` | `page.source@1`: the page answered a `POST` or another method (`method`); fetching it again would send that again |
| `bad_css` | `page.css@1`, `page.css_check@1`: nothing of the style sheet was understood (`dropped`) |
| `css_var_url` | `page.css@1`, `page.css_check@1`: a `var( )` inside `url( )`, `image-set( )` or another function that takes a file (`uses`); nothing was added |
| `fetch_not_approved` | `page.css@1`: the sheet loads files from origins not in `fetch_origins` (`fetches`), the page's own included; nothing was added |
| `page_changed` | `page.css@1`, `page.script@1`, `page.script_main@1`: the tab's page is not of the `origin` Kai approved, has an opaque origin, or was left before Firefox added or ran it; `page.zoom@1`, `reader.view@1`: the tab's page is not of `origin` right before (nothing done) or right after (done, and the tab shows another origin now); `page.see@1`, `element.see@1`: the tab's URL or top document changed during the capture |
| `unknown_css` | `page.css_remove@1` for an id that is no sheet now |
| `no_user_scripts` | `page.script@1`, `page.script_main@1`: the `userScripts` permission is not granted (the options page's button grants it) |
| `script_error` | the script threw, its promise rejected, or it does not parse (`thrown`) |
| `not_cloneable` | the script's value cannot leave the page (a DOM node, a function, an object that refers to itself) |
| `not_json` | the script's value has no JSON form (a `BigInt`) |
| `unknown_session` | `read.paragraph@1`, `read.mark@1`, `read.close@1`: no reading session of that id was opened by this extension on this link (never, before the extension restarted, or before the link began again) |
| `session_ended` | `read.paragraph@1`, `read.mark@1`: the reading session has ended; the error carries `tab` and `why`, both always (`why`: `navigated`, `tab_closed`, `discarded`, `page_changed`, `replaced` or `closed`, as the table of how a session ends says) |

Pages the extension cannot read (design §3), as `context.get`'s `page_error` and as the error of
the reading operations:

| code | the tab shows |
|---|---|
| `loading` | no page yet: a new tab whose first page has not arrived (Firefox shows its blank page meanwhile, and calls it loaded for a moment right after `tabs.open@1`: while a navigation Kai asked for with `tabs.open@1` or `tabs.go@1` has not committed, its blank page counts as loading), or a tab between two documents; asking again once it has loaded reads it |
| `firefox_page` | one of Firefox's own pages: `about:`, `view-source:`, `chrome:`, another extension's page |
| `reader_view` | Reader view (the error's `page` is the page it shows) |
| `file_access` | a `file:` page while the user has not allowed "Access local files on your computer" (the message says where to allow it) |
| `pdf_viewer` | a PDF in Firefox's viewer |
| `error_page` | one of Firefox's error pages (its title is the error's `title`) |
| `site_permission` | a site the user withdrew the extension's access from (the message says where to grant it) |
| `restricted_domain` | a site on Firefox's restricted domains (`extensions.webextensions.restrictedDomains`: addons.mozilla.org and others) or quarantined domains |
| `no_content` | anything else the extension cannot run in; the message carries Firefox's words |

Messages are written for people and may change; the codes are the contract. Kai adds the advice
for the model (which tool to call instead), which the extension does not know.

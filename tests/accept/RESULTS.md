# WP10: acceptance runs, the guard's noise, hint numbers by voice

Measured 2026-11-03 with Firefox 159.0 (headless), kai-firefox `feat/accept`, Kai
`feat/browser-accept`; run again the same day after WP10b (the runs' design findings fixed:
kai-firefox `feat/handsfree`, Kai `feat/browser-handsfree`) and after WP10b's security review's fix
round. Design §6.4, §6.6, D4, §11.

## 1. The acceptance runs (§6.6)

How to run: in Kai, `just browser-accept <kai-firefox checkout>` (default `../kai-firefox`). Kai's
ignored test `browser::tests::accept` starts Kai's real browser server, provider and policy and runs
`tests/accept/launch.mjs` here, which starts the fixture site and a headless Firefox with the
extension (profile under `target/accept/<time>/`). The report is Kai's
`target/browser-accept/<time>/report.txt`. About a minute (57 s after the review's fix round).

What is real and what stands in:
- Real: Kai's browser server with the peer check at its default `browser.peer_scopes`. Firefox runs
  in a scope named as Plasma names one (`app-org.mozilla.firefox-<random>.scope`).
- Real: the provider's routes, the focus rule, the site rules, the commit guard and the network
  gate, the host's dispatch (K15 policy, preparation, confirmation, handler), the real
  `kai-browser-host` and the extension.
- Configuration: `[browser] hands_and_eyes = true`, the fixture's two origins in
  `[browser.sites] act`, defaults otherwise. Calls go in as Kai's own voice session's
  (`Caller::Own`) with lmgw's deadline.
- Stand-ins:
  - A scripted model.
  - The owner at Kai's dialog: answers yes only to questions the script expects, no to anything
    else, and an unexpected question fails the step.
  - A fake text-to-speech at Kai's speech seam (`voice::speak::Mouth`): runs each utterance's gate
    and keeps its text, nothing is played.
  - The owner's voice (WP10b): Kai's own questions go through Kai's real `VoiceConfirmer` beside
    the dialog and the real approvals bookkeeping (the arming once the question was spoken, the
    talk key's press, the speech check, the whole-answer match); the owner's microphone is a tone
    and the transcript the words the script says.
  - No desktop for the trusted path: it needs KWin's input and is not run headless.
- The starting page is loaded by BiDi navigate (the page the user had open). No mouse or key event
  is sent.

| Run | Step | Result |
|---|---|---|
| Eyes | where am I (`browser_context`) | pass |
| Eyes | find a product, read its description and price (`page_find`, `element_text`) | pass |
| Eyes | read a comparison table (`table_read`: "Price, Headlamp Pro: 59 €") | pass |
| Eyes | hear the error a form shows and the dialog that opens: spoken "After Kai's action: the page says, at the field “Postcode”: Enter a postcode of five digits." and "After Kai's action: a dialog opened, the page says: Delivery areas" | pass |
| Eyes | no screenshot tool used | pass |
| Hands | close the delivery dialog | pass |
| Hands | close a cookie banner in a cross-origin frame | pass |
| Hands | search, open the third result | pass |
| Hands | open the order form: the link "Order now" loads a page by GET, but its URL (`/accept/order.html`) holds the guard's word "order", so the guard asks (WP10b's review: a link's words stay where it may commit; WP10b alone: unasked) | pass, 1 question |
| Hands | fill a controlled input, a combobox, a rich editor (the page's own state took each) | pass |
| Hands | set a slider (its `<output>` spoken "After Kai's action: the page says, at “Tip for the courier”: 3"; before: "the page says: 3"), choose an option, check a box, attach a file (`element_file` is asked, as the design keeps it; answered by voice: Kai said "May Kai attach a file to the file field? Yes or no? The page calls the file field: Photo of your door. The file is named: door.txt", the scripted answer was "Ja."; before the review the file's name was inside Kai's own sentence) | pass, 1 question |
| Hands | submit through the commit guard: one question for the page side's verdicts (name and form action hold "order"), one for the POST; the server got every field and the file | pass, 2 questions |
| Free | press the confirmation's link to the partner shop (another site): the network gate's question about the GET (a site seen only through Kai) answered by voice; then fill the partner shop's search unasked | pass, 1 question |
| Free | `tab_go` back to the user's own store, then fill its search unasked | pass |
| Free | a tab Kai opened (`tab_open`), then fill its search unasked | pass |
| Free | the review's H1: `tab_go` to a deals page that navigates itself to the other origin's store on its first scroll; Kai's `page_scroll` (the network gate's question about the page's GET answered at the dialog), then filling the search where the page went is asked (a scroll is no navigation of the owner's) | pass, 2 questions |
| Free | lmgw's own run (a trusted caller, not the owner's turn): its `tab_go` to the partner shop is asked (seen only through Kai), and so is filling there (the tab's site is the owner's store) | pass, 2 questions |

The design findings of the first runs (WP10) and what WP10b made of them:
- The focus rule anchored on the user's own clicks and keys, which a hands-free user never makes:
  a `tab_go` back to the user's store and a tab Kai opened were asked about at every action,
  while a link Kai pressed to another site left Kai acting there unasked. Now, with the
  hands-and-eyes switch on, Kai's moves in a turn the owner started are the user's own act, and a
  press that left the page is Kai's navigation for every other caller (the "Free" rows).
- Kai's own questions (the focus rule's, `element_file`'s, the commit guard's and the network
  gate's) had no spoken answer: now Kai speaks them for a call of its own and takes a spoken yes
  or no as for lmgw's approval card.
- The guard asked about a link that only opens a form ("Order now"); a file input was listed as
  `generic` (now `file`); a slider's `<output>` was spoken as a bare "3".

WP10b's security review narrowed the first two: only the listed moves of the owner's turn are
theirs, each only where the tab landed on the origin it was meant for (a page that navigates
itself after a scroll stays asked: the new Free row), and a link keeps the guard's words where its
URL holds one or it may act by script (so "Order now", whose URL holds "order", is asked again).

## 2. The network gate's noise on real sites (§6.4)

How: `KAI_BROWSER_HOST=… node tests/accept/noise.mjs [--extension <dir>]` (the harness's fake
Kai, the real host, a throwaway profile under `target/t/`). Every action is the operation Kai
sends with Kai's default guard (its word list, `window_ms` 2000).
- Actions: typing "kettle example", pressing search, opening a result, toggling a menu, scrolling.
- Nothing is submitted with data, nobody logs in and no consent banner is touched.
- Writes the gate held were declined; GET navigations an action asked for would have been allowed
  (none were held).
- Two runs gave the same counts; the table is the second.

| Site | Actions | Questions | Actions asked about | Write | Unseen-origin GET | Origins written to (from the acted-on page) |
|---|---|---|---|---|---|---|
| en.wikipedia.org (encyclopedia) | 7 | 3 | 1 (opening a result) | 3 | 0 | intake-analytics.wikimedia.org (2 beacons), en.wikipedia.org (1 beacon) |
| developer.mozilla.org (documentation) | 8 | 5 | 5 (opening a menu, opening the search, typing, Enter, opening a result) | 5 | 0 | incoming.telemetry.mozilla.org (beacons) |
| docs.python.org (documentation) | 6 | 0 | 0 | 0 | 0 | – |
| www.tagesschau.de (news front page) | 8 | 4 | 3 (opening the menu: 2 XHR; opening an article; Enter in the search) | 4 | 0 | zagent7.h-cdn.com, zagent24.h-cdn.com (XHR POST), perr.h-cdn.com (beacons) |
| github.com/rust-lang/rust (code hosting) | 6 | 2 | 2 (opening README.md, the scroll after it) | 2 | 0 | collector.github.com (beacons) |
| www.ikea.com/de search (shop) | 7 | 0 | 0 | 0 | 0 | – |
| **All** | **42** | **14** | **11 (26 %)** | **14** | **0** | |

What this says:
- **Every question was a page's own telemetry**, not something the user did: analytics beacons and a
  CDN's XHR. None was a write the action caused.
- With the owner answering each question, a hands-and-eyes user would have seen a dialog after
  about one action in four. On MDN it was nearly every action (5 of 8).
- Kai asks an operation's questions one after the other and declines the rest unasked once one is
  declined, so Wikipedia's three would be one dialog for an owner who says no.
- No unseen-origin GET was held: every result opened was on the same site. The profile has no
  history, so on another site's link every origin would count as unseen; a user's own history makes
  that less frequent. The fixture's "partner shop" link shows that case (Kai's report, the Free run's first step).
- Not counted: the page side's word verdicts. None fired on these sites. On the fixture, a link
  named "Order now" that only opens a form was asked about (until WP10b, below).
- Not seen: a consent banner that blocks the page. www.bbc.com/news put a modal consent dialog over
  everything ("I agree" / "I do not agree", no close), so it was left out.

### After WP10b: beacons and pings never held

WP10b's gate no longer holds requests of type `beacon` or `ping`, as a trade-off against this
noise (mostly the pages' telemetry; a beacon a page sends because of Kai's action goes unasked too:
design §6.4), and the guard's words no longer apply to a link that loads a page by GET. Measured back to back on 2026-11-03, the same six sites and actions: first with the
extension of `ef47f9b` (`git archive ef47f9b extension | tar -x -C target/noise-before`, then
`--extension target/noise-before/extension`), then with this one. The sites' own telemetry varied
a little from the first measurement above (Wikipedia sent four beacons this time).

| Site | Actions | Before: questions | Before: actions asked about | After: questions | After: actions asked about | What was asked |
|---|---|---|---|---|---|---|
| en.wikipedia.org | 7 | 4 | 1 | 0 | 0 | before: 4 beacons (en.wikipedia.org, intake-analytics.wikimedia.org) |
| developer.mozilla.org | 8 | 5 | 5 | 0 | 0 | before: 5 beacons (incoming.telemetry.mozilla.org) |
| docs.python.org | 6 | 0 | 0 | 0 | 0 | – |
| www.tagesschau.de | 8 | 4 | 3 | 2 | 1 | both: 2 XHR POSTs (zagent7.h-cdn.com, zagent24.h-cdn.com) after opening the menu; before also 2 beacons (perr.h-cdn.com) |
| github.com/rust-lang/rust | 6 | 2 | 2 | 0 | 0 | before: 2 beacons (collector.github.com) |
| www.ikea.com/de search | 7 | 0 | 0 | 0 | 0 | – |
| **All** | **42** | **15** | **11 (26 %)** | **2** | **1 (2 %)** | |

- The page side's word verdicts: 1 before (a tagesschau.de headline link whose text held "order"
  inside "fordert"), 0 after (a link that loads a page). WP10b's review then kept the words on a
  link whose URL holds a guard word or that may act by script; the six sites were not measured
  again after it yet, so whether that headline link asks again (it would where its URL holds one
  of the words) is not known.
- What is left is one site's XHR to its CDN, a write the gate cannot tell from one Kai's action
  causes. A `fetch` with `keepalive` would be held too: webRequest does not say a fetch is one
  (design §6.4).
- No Firefox process of either run was left (the harness's teardown found none).

## 3. Hint numbers by voice (D4)

Not run: this pass starts no models, and no audio model was running. A live try by voice has not been done yet.

Facts for the question:
- Refs grow fast. In the WP10 survey of seven real pages, one `page.fields` and one in-view
  `page.controls` per page, the refs passed 370.
- On the fixture's acceptance run (two small pages' worth of listings, about 40 s), the refs reached
  53.
- An hour of browsing with Kai reading pages puts the numbers in the thousands, so "press 214" soon
  becomes "press 2 143".

Method for a live try (conversation mode, a speech-to-text row of your own):
1. Open the fixture's `/large` page (or a real page) in a Firefox that has run a while. Ask Kai
   "show the hints" (`hints_show`). Note ten labels with three or four digits.
2. For the same ten controls, write down their place in view (1 to the number in view, in the order
   `page_controls` lists them). These stand in for short per-view labels.
3. Say "press N" for each of the twenty, in random order, at a normal pace; ten in English, ten in
   German.
4. Count from the session's transcripts, per label kind:
   - how often the transcript holds exactly the number;
   - how it was written ("two hundred fourteen", "214", "2 14", "zweihundertvierzehn");
   - how long the utterance was;
   - how often Kai pressed the wrong element or had to ask again.
5. Optional, once lmgw's audio models are running anyway: the same phrases through two
   text-to-speech voices and the owner's speech-to-text row, as a proxy for how numbers are
   transcribed. It says nothing about the owner's own speech.

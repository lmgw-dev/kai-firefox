// Hints and pointing (design §5.4): numbered labels over the controls in view, the numbers being
// their refs (D4), redrawn for the new view after the page scrolled or resized, gone with a
// navigation; and element.point's fading ring.

import { define, OpError, about } from "./ops.js";
import { tabArg } from "./tabs.js";
import { allFrames, frameCall, elementCall } from "./pages.js";
import { controlsIn } from "./read.js";
import { tabRef } from "./compose.js";

// Tabs showing hints: tabId -> { busy, again, gen, document }; `document`: the top document they
// are pinned to (showHints'), or null.
const shown = new Map();
// Each hints.show and hints.hide starts a generation. A drawing checks that its generation is
// still the tab's before it sends its labels, and the content script drops labels of a generation
// older than the last hide it got, so a redraw that was under way when hints.hide came draws
// nothing. Clock-based, so the numbers keep rising when the background starts again.
let lastGen = 0;
const nextGen = () => (lastGen = Math.max(lastGen + 1, Date.now()));

// Labels for the controls in view of `tab`, in every frame (a frame without any gets none, but
// listens for its scrolling); the controls as page.controls answers them, with `undrawn` for the
// frames whose labels could not be drawn.
async function draw(tab, s) {
  const { pages, entries, result } = await controlsIn(tab, { top: s.document });
  if (s.document && pages.read.get(0)?.document !== s.document) {
    throw new OpError("page_changed", `tab ${tab.id} left the page its hints were asked for, so none were drawn`, about(tab));
  }
  if (shown.get(tab.id) !== s) return result;
  const byFrame = new Map([...pages.read.keys()].map((f) => [f, []]));
  for (const e of entries) byFrame.get(e.frameId)?.push({ local: e.item.local, ref: e.ref });
  const failed = await Promise.all(
    [...byFrame].map(([frameId, items]) =>
      frameCall(tab, frameId, { kai: "hints_draw", items, gen: s.gen }, frameId === 0 && s.document ? { document: s.document } : {}).then(
        () => null,
        (e) => (items.length ? { frame: frameId, origin: pages.read.get(frameId)?.origin ?? null, code: e.code ?? "no_content", labels: items.length } : null),
      ),
    ),
  );
  const undrawn = failed.filter(Boolean);
  for (const u of undrawn) console.warn(`Kai for Firefox: ${u.labels} hint labels in frame ${u.frame} of tab ${tab.id} not drawn: ${u.code}`);
  return undrawn.length ? { ...result, undrawn } : result;
}

// The page moved: draw again, one redraw at a time per tab, the last request winning.
async function redraw(tabId) {
  const s = shown.get(tabId);
  if (!s) return;
  if (s.busy) {
    s.again = true;
    return;
  }
  s.busy = true;
  try {
    do {
      s.again = false;
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab || shown.get(tabId) !== s) return;
      await draw(tab, s).catch((e) => console.warn(`Kai for Firefox: hints in tab ${tabId} not redrawn: ${e.message}`));
    } while (s.again && shown.get(tabId) === s);
  } finally {
    s.busy = false;
  }
}

browser.runtime.onMessage.addListener((m, sender) => {
  if (m?.kai !== "hints_view" || sender.id !== browser.runtime.id || !sender.tab) return undefined;
  const tabId = sender.tab.id;
  if (shown.has(tabId)) redraw(tabId);
  // Labels this background does not know of (it started again since): gone.
  else browser.tabs.sendMessage(tabId, { kai: "hints_clear", gen: nextGen() }, { frameId: sender.frameId }).catch(() => {});
  return undefined;
});
// A new page in the tab ends its hints; a frame's new page gets its labels.
browser.webNavigation.onCommitted.addListener((d) => {
  if (!shown.has(d.tabId)) return;
  if (d.frameId === 0) shown.delete(d.tabId);
  else redraw(d.tabId);
});
browser.tabs.onRemoved.addListener((tabId) => shown.delete(tabId));

define("hints.show@1", {
  args: { tab: { type: "integer" } },
  async run({ tab: id }) {
    return showHints(await tabArg(id));
  },
});

// hints.show@1 on `tab`. `document` (a documentId; the sidebar's hints switch, design §8.1) pins
// them to that top document: one that was left before its controls were read draws nothing and
// fails with page_changed, and a navigation later ends them as it ends any.
export async function showHints(tab, { document = null } = {}) {
  const s = { busy: true, again: false, gen: nextGen(), document };
  shown.set(tab.id, s);
  try {
    return await draw(tab, s);
  } catch (e) {
    if (shown.get(tab.id) === s) shown.delete(tab.id);
    throw e;
  } finally {
    s.busy = false;
    if (s.again) redraw(tab.id);
  }
}

define("hints.hide@1", {
  args: { tab: { type: "integer" } },
  async run({ tab: id }) {
    const tab = await tabArg(id);
    const was = shown.delete(tab.id);
    const answers = await allFrames(tab, { kai: "hints_clear", gen: nextGen() });
    const removed = answers.reduce((n, a) => n + (a.result?.removed ?? 0), 0);
    return { tab: tabRef(tab), shown: was, removed };
  },
});

// ms up to the longest timer a browser keeps (2^31 - 1 ms, about 24.8 days).
define("element.point@1", {
  args: { ref: { type: "ref", required: true }, ms: { type: "integer", required: true, min: 1, max: 2 ** 31 - 1 } },
  async run({ ref, ms }) {
    const { tab, r } = await elementCall(ref, { kai: "ring", ms });
    const out = { ref, tab: tabRef(tab), role: r.el.role, name: r.el.name };
    if (r.el.level !== undefined) out.level = r.el.level;
    Object.assign(out, { ms, scrolled: r.scrolled });
    if (r.hidden) out.hidden = true;
    return out;
  },
});

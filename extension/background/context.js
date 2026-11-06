// context.get (§5.1): where the user is. And element.describe: what a ref names now, which Kai
// uses to check a ref and to name the element in a confirmation (§6.3).

import { define, OpError, about } from "./ops.js";
import { userTab, tabInfo } from "./tabs.js";
import { focusedAt } from "./user.js";
import { allFrames, urlAccess, elementCall, frameCall } from "./pages.js";
import { frameReport } from "./compose.js";
import { refFor } from "./refs.js";

// A content script's element ({ local, role, name, ... }) of frame answer `f`, with its ref.
async function element(tab, f, d) {
  if (!d) return null;
  const { local, ...rest } = d;
  return { ref: await refFor(tab.id, f.frame, f.document, local), ...rest };
}

define("context.get@1", {
  args: {},
  async run() {
    const tab = await userTab();
    const all = await browser.tabs.query({});
    const zoom = await browser.tabs.getZoom(tab.id);
    const win = await browser.windows.get(tab.windowId);
    const out = {
      tab: {
        ...tabInfo(tab, tab.id),
        reader: { available: !!tab.isArticle, on: !!tab.isInReaderMode },
        zoom_percent: Math.round(zoom * 100),
      },
      window: { id: win.id, focused: !!win.focused, focused_at: focusedAt(win.id) },
      tabs_open: all.filter((t) => !t.incognito).length,
      focus: null,
      selection: null,
      pointer: null,
      view: null,
      dialog: null,
      frames: { read: 0, unread: 0, unread_frames: [] },
      page_error: null,
    };
    const refused = await urlAccess(tab);
    if (refused) {
      out.page_error = { code: refused.code, message: refused.message };
      return out;
    }
    const answers = await allFrames(tab, { kai: "context" });
    const top = answers.find((a) => a.frameId === 0);
    if (!top || top.error) {
      const e = top?.error ?? new OpError("no_content", `tab ${tab.id} has no top document to read`, about(tab));
      out.page_error = { code: e.code ?? "no_content", message: e.message };
      return out;
    }
    const read = new Map(answers.filter((a) => a.result).map((a) => [a.frameId, a.result]));
    out.frames = (await frameReport(tab, answers)).frames;

    // Focus: from the top document down through the focused frames.
    let focusFrame = null;
    for (let f = top.result, seen = new Set(); f && f.focus && !seen.has(f.frame); f = read.get(f.focus.frame)) {
      seen.add(f.frame);
      if (f.focus.el) {
        focusFrame = f;
        out.focus = await element(tab, f, f.focus.el);
        break;
      }
    }

    // Pointer: from the top document down through the frames it is in. A document answers null
    // (it saw no pointer), { left: true } (it saw the pointer leave), { el } or { frame, x, y }.
    // A frame that saw no pointer itself is asked what is at the point its parent saw; one that
    // saw the pointer leave is not.
    let p = top.result.pointer;
    for (let f = top.result, seen = new Set(); p && !p.left && !seen.has(f.frame); ) {
      seen.add(f.frame);
      if ("el" in p) {
        out.pointer = await element(tab, f, p.el);
        break;
      }
      f = read.get(p.frame);
      if (!f) break;
      p = f.pointer ?? (await frameCall(tab, f.frame, { kai: "point", x: p.x, y: p.y }).catch(() => null));
    }

    // Selection: in the focused frame first, else the first frame that has one.
    const withSelection = [focusFrame, ...read.values()].find((r) => r && r.selection);
    if (withSelection) {
      const { field, ...sel } = withSelection.selection;
      out.selection = { ...sel, field: await element(tab, withSelection, field) };
    }

    // An open modal dialog, the top document's first.
    const withDialog = [...read.values()].find((r) => r.dialog);
    if (withDialog) out.dialog = await element(tab, withDialog, withDialog.dialog);

    const v = top.result.view;
    out.view = { scrollable: v.scrollable, percent: v.percent, heading: await element(tab, top.result, v.heading) };
    return out;
  },
});

define("element.describe@1", {
  args: { ref: { type: "ref", required: true } },
  async run({ ref }) {
    const { tab, entry, r } = await elementCall(ref, { kai: "describe" });
    const { local, ...el } = r.el;
    void local;
    return { ref, tab: { id: tab.id, title: tab.title ?? "", url: tab.url ?? "" }, frame: entry.frame, origin: r.origin ?? null, ...el };
  },
});

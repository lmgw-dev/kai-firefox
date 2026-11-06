// Kai for Firefox's content script, part 8 (after listen.js): this frame's side of reading aloud
// (design §7.3). read.open asks every frame for its paragraphs (the text blocks of
// page.text_all, each with the element its text belongs to and its first and last text node);
// the frame keeps those nodes per session, so read.mark can draw the reading mark around a
// paragraph (overlay.js) and scroll it into view. Leaving the page drops the sessions.

(() => {
  const K = Object.hasOwn(globalThis, "kaiFirefoxContent") ? globalThis.kaiFirefoxContent : null;
  if (!K || K.off || K.aloud) return;
  K.aloud = true;
  const { textBlocks, self, viewport, rectOf, clipper, textParent, up, localOf, deepAll, childFrame, frameBox, FRAMES } = K;

  const sessions = new Map(); // session -> [anchor { el, start, end }] by paragraph index in this frame
  addEventListener("pagehide", () => {
    sessions.clear();
    K.clearMark();
  });

  // The language of an element's text: the nearest lang attribute, across shadow roots, else the
  // document's; null when none says.
  function langOf(el) {
    for (let e = el; e; e = up(e)) {
      if (e.hasAttribute?.("lang")) return e.getAttribute("lang").trim() || null;
    }
    return document.documentElement?.getAttribute("lang")?.trim() || null;
  }

  // This frame's paragraphs, kept for `session`. `at`: the local id of the element to start from
  // when it is in this document; `focus`: say where the focused element's paragraph is.
  function open({ session, at }) {
    const me = self();
    const track = { el: null, at: null };
    let gone = null;
    if (at && at.document === me.document) {
      const r = K.element(at.local);
      if (r.gone) gone = r.gone;
      else track.el = r.el;
    }
    const focused = K.focused();
    const focusTrack = { el: focused && focused !== document.body && focused !== document.documentElement && !FRAMES.has(focused.localName) ? focused : null, at: null };
    const focusFrame = focused && FRAMES.has(focused.localName) ? childFrame(focused) : null;
    const blocks = textBlocks(document, { anchors: true, tracks: [track, focusTrack].filter((t) => t.el) });
    const anchors = [];
    const shown = clipper();
    const items = blocks.map((b) => {
      if (!b.anchor) return b;
      const { anchor, local, ...rest } = b;
      void local;
      const bi = anchors.push(anchor) - 1;
      const box = K.anchorRange(anchor).getBoundingClientRect();
      const rect = rectOf(box);
      const host = anchor.start.nodeType === Node.TEXT_NODE ? textParent(anchor.start) : anchor.start;
      // The paragraph's language is its element's, not that of an inline part it begins with;
      // page text that echoes a sensitive value is masked as events mask it.
      return { ...rest, text: K.maskAll(rest.text), bi, el_local: localOf(anchor.el), lang: langOf(anchor.el), rect, vis: host ? shown(host, rect) : null };
    });
    sessions.set(session, anchors);
    const count = anchors.length;
    // The first paragraph at or after the element; null when it has none in this frame.
    const firstAt = (i) => (i === null || i >= count ? null : i);
    return {
      ...me,
      viewport: viewport(),
      blocks: items,
      gone,
      at: track.el ? firstAt(track.at) : null,
      focus: focusTrack.el ? { at: firstAt(focusTrack.at) } : focusFrame !== null ? { frame: focusFrame } : null,
    };
  }

  // Scrolls so that `rect()` (a box in this viewport) is in view, innermost scroll container
  // first (those around `el`), then the page: wholly when it fits, centred; its top at the top
  // when it is taller. Answers whether anything scrolled.
  function reveal(el, rect) {
    let scrolled = false;
    const delta = (y, h, size) => (y >= 0 && y + h <= size ? 0 : h <= size ? y + h / 2 - size / 2 : y);
    for (let c = el && up(el); c && c !== document.body && c !== document.documentElement; c = up(c)) {
      const cs = getComputedStyle(c);
      if (!/^(auto|scroll|overlay)$/.test(cs.overflowY) || c.scrollHeight <= c.clientHeight) continue;
      const r = rect();
      const top = c.getBoundingClientRect().top + c.clientTop;
      const d = delta(r.y - top, r.h, c.clientHeight);
      if (Math.abs(d) >= 1) {
        const before = c.scrollTop;
        // Instant whatever the page's scroll-behavior says: the next box is measured at once.
        c.scrollBy({ top: d, behavior: "instant" });
        scrolled ||= c.scrollTop !== before;
      }
    }
    const r = rect();
    const d = delta(r.y, r.h, viewport().h);
    if (Math.abs(d) >= 1) {
      const before = scrollY;
      scrollBy({ top: d, behavior: "instant" });
      scrolled ||= scrollY !== before;
    }
    return scrolled;
  }

  function mark({ session, bi }) {
    const anchor = sessions.get(session)?.[bi];
    // Nothing marked for a paragraph that is gone: `why` says whether the page removed its text
    // or this document no longer holds the session's paragraphs (the page was left and came back).
    if (!anchor) {
      K.clearMark();
      return { marked: false, scrolled: false, rect: null, why: "frame_left" };
    }
    if (!K.anchorThere(anchor)) {
      K.clearMark();
      return { marked: false, scrolled: false, rect: null, why: "removed" };
    }
    const range = K.anchorRange(anchor);
    const host = anchor.start.nodeType === Node.TEXT_NODE ? textParent(anchor.start) : anchor.start;
    const scrolled = reveal(host, () => rectOf(range.getBoundingClientRect()));
    const marked = K.drawMark(session, anchor);
    if (!marked) return { marked: false, scrolled: false, rect: null, why: "removed" };
    return { marked: true, scrolled, rect: rectOf(range.getBoundingClientRect()) };
  }

  // A child frame's part (`rect`, in that frame's viewport) brought into this frame's view;
  // answers its box here.
  function frameReveal({ frame, rect }) {
    const el = [...deepAll(document, "iframe, frame, embed, object")].find((e) => childFrame(e) === frame);
    if (!el) return { found: false, scrolled: false, rect: null };
    const at = () => {
      const b = frameBox(el);
      return { x: b.x + rect.x, y: b.y + rect.y, w: rect.w, h: rect.h };
    };
    const scrolled = reveal(el, at);
    return { found: true, scrolled, rect: at() };
  }

  Object.assign(K.handlers, {
    read_open: (m) => open(m),
    read_mark: (m) => mark(m),
    read_unmark: ({ session }) => ({ cleared: K.clearMark(session) }),
    read_drop: ({ session }) => {
      K.clearMark(session);
      return { dropped: sessions.delete(session) };
    },
    frame_reveal: (m) => frameReveal(m),
  });
})();

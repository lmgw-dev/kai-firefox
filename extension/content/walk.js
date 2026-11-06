// Kai for Firefox's content script, part 2 (after kai.js): where things are (this frame's
// viewport, its child frames' boxes, what is in view) and the page's text in reading order
// (design §5.3), as blocks. The background merges the frames: a child frame is a placeholder
// { frame, box } where its <iframe> is, `box` being the frame's content box in this frame's
// viewport.

(() => {
  const K = Object.hasOwn(globalThis, "kaiFirefoxContent") ? globalThis.kaiFirefoxContent : null;
  if (!K || K.off || K.walk) return;
  K.walk = true;
  const { sensitive, MASK, codePoints, frameIdOf, localOf, FRAMES } = K;

  // This frame's viewport without scrollbars (the body's box in quirks mode).
  function viewport() {
    const vp = document.compatMode === "BackCompat" ? document.body : document.documentElement;
    return { w: vp?.clientWidth || innerWidth, h: vp?.clientHeight || innerHeight };
  }
  // Rects are { x, y, w, h } in this frame's viewport.
  const rectOf = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  // Partly inside the clip; an empty box is not.
  const meets = (r, c) => !!c && (r.w > 0 || r.h > 0) && r.x + r.w > c.x && r.y + r.h > c.y && r.x < c.x + c.w && r.y < c.y + c.h;
  const inside = (r, c) => r.x >= c.x && r.y >= c.y && r.x + r.w <= c.x + c.w && r.y + r.h <= c.y + c.h;
  // The part of r inside c (a line of zero width stays), or null.
  function cut(r, c) {
    if (!meets(r, c)) return null;
    const x = Math.max(r.x, c.x);
    const y = Math.max(r.y, c.y);
    return { x, y, w: Math.max(0, Math.min(r.x + r.w, c.x + c.w) - x), h: Math.max(0, Math.min(r.y + r.h, c.y + c.h) - y) };
  }
  const union = (a, b) => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };

  // "In view" (design §5.3): partly inside this frame's viewport after the clipping of every
  // ancestor whose overflow is not visible (a scroll container, overflow: hidden or clip) on that
  // axis, its padding box without scroll bars. The root and the body scroll the viewport itself;
  // a fixed-position element is clipped by the viewport only. (The background clips each frame by
  // its parents.)
  // The clip an element's content shows in, from the clip its own box is in (null: none).
  function innerClip(el, outer, cs) {
    if (!outer || el === document.documentElement || el === document.body || cs.display === "inline" || cs.display === "contents") return outer;
    const ox = cs.overflowX !== "visible";
    const oy = cs.overflowY !== "visible";
    if (!ox && !oy) return outer;
    const r = el.getBoundingClientRect();
    const box = {
      x: ox ? r.left + el.clientLeft : outer.x,
      y: oy ? r.top + el.clientTop : outer.y,
      w: ox ? el.clientWidth : outer.w,
      h: oy ? el.clientHeight : outer.h,
    };
    const x = Math.max(box.x, outer.x);
    const y = Math.max(box.y, outer.y);
    const w = Math.min(box.x + box.w, outer.x + outer.w) - x;
    const h = Math.min(box.y + box.h, outer.y + outer.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  // An element's parent in the flat tree: its slot, its parent, or its shadow root's host.
  const flatParent = (el) => el.openOrClosedAssignedSlot ?? el.assignedSlot ?? el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
  // A function that tells the visible part of an element's box (rect, default its border box),
  // or null; the ancestors' clips are kept for the function's life (one answer, or one frame).
  function clipper() {
    const vp = viewport();
    const view = { x: 0, y: 0, w: vp.w, h: vp.h };
    const inner = new Map(); // element -> the clip its content shows in
    const contentClip = (el) => {
      const chain = [];
      let c = view;
      for (let e = el; e; e = flatParent(e)) {
        if (inner.has(e)) {
          c = inner.get(e);
          break;
        }
        chain.push(e);
      }
      for (let i = chain.length - 1; i >= 0; i--) {
        const cs = getComputedStyle(chain[i]);
        c = innerClip(chain[i], cs.position === "fixed" ? view : c, cs);
        inner.set(chain[i], c);
      }
      return c;
    };
    return (el, rect = rectOf(el.getBoundingClientRect())) => {
      const boxClip = getComputedStyle(el).position === "fixed" ? view : contentClip(flatParent(el));
      return cut(rect, boxClip);
    };
  }

  // A frame element's child frame id, or null (an <object> showing an image is no frame).
  function childFrame(el) {
    const id = frameIdOf(el);
    return typeof id === "number" && id > 0 ? id : null;
  }
  // A frame element's content box in this frame's viewport.
  function frameBox(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    return {
      x: r.left + el.clientLeft + pl,
      y: r.top + el.clientTop + pt,
      w: Math.max(0, el.clientWidth - pl - (parseFloat(cs.paddingRight) || 0)),
      h: Math.max(0, el.clientHeight - pt - (parseFloat(cs.paddingBottom) || 0)),
    };
  }
  // The placeholder for a frame element that is rendered and has a frame; null otherwise. With
  // `shown` (a clipper), `vis` is the part of its box in view, or null.
  function framePlaceholder(el, shown = null) {
    if (!el.checkVisibility()) return null;
    const id = childFrame(el);
    if (id === null) return null;
    const p = { frame: id, box: frameBox(el), title: el.getAttribute("title") || "" };
    if (shown) p.vis = shown(el, p.box);
    return p;
  }

  // The element a text node is in: its parent, or the host of the shadow root it is directly in.
  const textParent = (node) => node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);

  // Rendered: it has a box, or it is display: contents (its children may have boxes).
  const rendered = (el) => el.checkVisibility() || getComputedStyle(el).display === "contents";

  // The children as rendered: a shadow host's shadow tree, a slot's assigned nodes.
  function kids(el) {
    if (el.localName === "slot" && typeof el.assignedNodes === "function") {
      const a = el.assignedNodes({ flatten: true });
      if (a.length) return a;
    }
    const sr = el.openOrClosedShadowRoot;
    return sr ? sr.childNodes : el.childNodes;
  }

  const NOT_TEXT = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link", "base", "datalist", "option", "optgroup"]);
  const TEXTY = new Set(["text", "search", "email", "tel", "url", "number", "password", "date", "datetime-local", "month", "week", "time"]);
  const BUTTONY = new Set(["submit", "reset", "button"]);
  // Inline-level boxes flow within a line; every other display starts a block.
  const INLINE = /^(inline|inline-block|inline-flex|inline-grid|inline-table|ruby|ruby-base|ruby-text|ruby-base-container|ruby-text-container)$/;

  // A field's value as text: masked for a sensitive field (§5).
  const valueText = (el, v = el.value) => (!v ? "" : sensitive(el) ? MASK(codePoints(v)) : v);
  // What a form field shows as text; null for elements that are no field.
  function fieldText(el) {
    switch (el.localName) {
      case "textarea":
        return valueText(el);
      case "select":
        return [...el.selectedOptions].map((o) => o.label.trim()).filter(Boolean).join(", ");
      case "input":
        if (TEXTY.has(el.type)) return valueText(el);
        if (BUTTONY.has(el.type)) return el.value;
        return "";
      default:
        return null;
    }
  }

  // The text under `root` (a document or an element) in reading order: blocks
  //   { text, heading?: level, local?: the heading's local id, item?: true, rect? }
  // and frame placeholders { frame, box, title, vis? }. Through open and closed shadow roots,
  // slots at their place. Hidden content (display: none, visibility: hidden, closed <details>) is
  // left out; fields give their value (masked when sensitive). Options:
  // - inView (root: the document): only blocks with text in view (as clipper() decides), each
  //   whole, with `rect` the union of its parts in view; placeholders only of frames in view.
  // - from / headingLevel: start at element `from` and stop before the next shown heading of
  //   `headingLevel` or higher (a heading's section).
  // - anchors (reading aloud): each block gets `anchor` { el: the block element its text belongs
  //   to, start, end: its first and last text node (or field) }, and placeholders their `vis`.
  // - tracks [{ el }]: each one's `at` becomes the index among the text blocks of the block that
  //   holds el's text, or of the first one after el.
  // - a11y (events): elements with aria-hidden="true" are left out too, as assistive technology
  //   leaves them out.
  function textBlocks(root, { inView = false, from = null, headingLevel = null, anchors = false, tracks = [], a11y = false } = {}) {
    const out = [];
    // The text blocks pushed so far, the block element being filled, and the first and last
    // node of the text in buf.
    let nText = 0;
    let blockEl = root.nodeType === Node.DOCUMENT_NODE ? (root.body ?? root.documentElement) : root;
    let first = null;
    let last = null;
    const shownBy = anchors ? clipper() : null;
    const vp = viewport();
    const view = { x: 0, y: 0, w: vp.w, h: vp.h };
    const rects = new WeakMap(); // element -> its rect, for inView
    const hiddenNow = new Set(); // elements with visibility: hidden being walked
    let buf = "";
    let rect = null; // the union of the block's parts in view
    let meta = {};
    let on = !from;
    let done = false;

    const flush = () => {
      const text = buf.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
      if (text && on && (!inView || rect)) {
        const b = inView ? { text, ...meta, rect } : { text, ...meta };
        if (anchors) b.anchor = { el: blockEl, start: first ?? blockEl, end: last ?? first ?? blockEl };
        out.push(b);
        nText++;
      }
      buf = "";
      rect = null;
      first = last = null;
    };
    const add = (t, ws, r, node = null) => {
      if (!on || !t) return;
      if (ws === "collapse") {
        t = t.replace(/[ \t\n\r\f]+/g, " ");
        if (/[ \n\t]$/.test(buf) || !buf) t = t.replace(/^ /, "");
      } else if (ws === "lines") t = t.replace(/[ \t\r\f]+/g, " ").replace(/ ?\n ?/g, "\n");
      if (!t) return;
      buf += t;
      if (node && t.trim()) {
        first ??= node;
        last = node;
      }
      if (r) rect = rect ? union(rect, r) : r;
    };
    const elRect = (el) => {
      let r = rects.get(el);
      if (!r) rects.set(el, (r = rectOf(el.getBoundingClientRect())));
      return r;
    };
    // The part in view of a text node, or null. Its parent's box decides when it is wholly in the
    // clip or outside it; otherwise (a parent wider or taller than what shows of it, or without a
    // box) the text's own line boxes are measured.
    const textInView = (node, parent, clip) => {
      if (!clip) return null;
      const pr = elRect(parent);
      const boxless = pr.w === 0 && pr.h === 0;
      if (!boxless) {
        if (!meets(pr, clip)) return null;
        if (inside(pr, clip)) return pr;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      let part = null;
      for (const lr of range.getClientRects()) {
        const c = cut(rectOf(lr), clip);
        if (c) part = part ? union(part, c) : c;
      }
      return part;
    };

    function visit(node, ws, clip) {
      if (done) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = textParent(node);
        if (!parent || hiddenNow.has(parent)) return;
        add(node.data, ws, inView && on ? textInView(node, parent, clip) : null, node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) for (const c of node.childNodes) visit(c, ws, clip);
        return;
      }
      const el = node;
      const tag = el.localName;
      for (const t of tracks) if (el === t.el) t.at = nText;
      if (NOT_TEXT.has(tag) || K.own.has(el) || (a11y && el.getAttribute("aria-hidden") === "true")) return;
      const isStart = el === from;
      if (isStart) on = true;
      if (!rendered(el)) return;
      if (!isStart && on && headingLevel !== null && el.matches(K.HEADINGS) && el.checkVisibility({ visibilityProperty: true }) && K.levelOf(el) <= headingLevel) {
        flush();
        done = true;
        return;
      }
      const cs = getComputedStyle(el);
      const boxClip = cs.position === "fixed" ? view : clip;
      const partInView = (r) => (inView ? cut(r, boxClip) : null);
      if (FRAMES.has(tag)) {
        if (!on) return;
        const p = framePlaceholder(el, shownBy);
        if (!p) return;
        if (inView) {
          p.vis = cut(p.box, boxClip);
          if (!p.vis) return;
        }
        flush();
        out.push(p);
        return;
      }
      if (tag === "br") {
        add("\n", "keep", partInView(elRect(el)));
        return;
      }
      const hidden = cs.visibility !== "visible";
      const field = fieldText(el);
      if (field !== null) {
        if (!hidden && field && on) {
          if (buf && !/[ \n\t]$/.test(buf)) buf += " ";
          add(field, "keep", partInView(elRect(el)), el);
        }
        return;
      }
      const display = cs.display;
      const block = display !== "contents" && !INLINE.test(display) && display !== "table-cell";
      const space = cs.whiteSpace;
      const childWs = /^(pre|pre-wrap|break-spaces)$/.test(space) ? "keep" : space === "pre-line" ? "lines" : "collapse";
      if (display === "table-cell" && buf && !buf.endsWith("\t")) buf += "\t";
      let saved = null;
      if (block || isStart) {
        flush();
        saved = { meta, blockEl };
        meta = {};
        blockEl = el;
        if (el.matches(K.HEADINGS)) meta = { heading: K.levelOf(el), local: localOf(el) };
        else if (display === "list-item" || K.roleOf(el) === "listitem") meta = { item: true };
      }
      for (const t of tracks) if (el === t.el) t.at = nText;
      const childClip = inView ? innerClip(el, boxClip, cs) : null;
      // Text directly in a hidden element is skipped; its children decide for themselves.
      if (hidden) hiddenNow.add(el);
      for (const c of kids(el)) visit(c, childWs, childClip);
      hiddenNow.delete(el);
      if (saved) {
        flush();
        ({ meta, blockEl } = saved);
      }
    }

    // inView reads from the document, whose clip is the viewport.
    visit(root, "collapse", view);
    flush();
    return out;
  }

  Object.assign(K, { viewport, rectOf, clipper, childFrame, frameBox, framePlaceholder, rendered, textParent, textBlocks, NOT_TEXT, TEXTY });
})();

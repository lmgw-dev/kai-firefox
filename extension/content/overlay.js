// Kai for Firefox's content script, part 4 (after read.js): what Kai draws over the page (design
// §5.4): hint labels over the controls in view, numbered with their refs, the ring of
// element_point, and the reading mark around the paragraph read aloud (§7.3). One host element per
// document, after an earlier extension's recipe: every property set
// inline with !important (all: initial first, so no page rule reaches it), pointer-events: none,
// the highest z-index and, through the popover API, the top layer (above a modal dialog); the
// labels live in a closed shadow root that page CSS and scripts cannot reach. The host itself is
// in the page's DOM: when a page script removes it, changes its attributes or closes its popover,
// it is put back at the next animation frame. It carries K.marker, which page.css's rules exclude
// (a user-origin !important rule would beat the inline !important). Leaving the page removes it
// (pagehide, also into the back-forward cache). The walkers skip it (K.own).

(() => {
  const K = Object.hasOwn(globalThis, "kaiFirefoxContent") ? globalThis.kaiFirefoxContent : null;
  if (!K || K.off || K.overlay) return;
  K.overlay = true;

  // After the page stopped scrolling or resizing for this long, the background is asked to label
  // what came into view (new elements need refs, which only it gives out).
  const SETTLE_MS = 150;
  const LOOK = { fg: "#fcfcfc", bg: "#232629", accent: "#3daee9", halo: "rgba(252, 252, 252, 0.9)" };
  const HOST_STYLE = {
    display: "block",
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    margin: "0",
    padding: "0",
    border: "none",
    background: "transparent",
    overflow: "visible",
    "pointer-events": "none",
    "z-index": "2147483647",
    visibility: "visible",
    opacity: "1",
  };

  let host = null;
  let root = null;
  let hints = null; // { labels: [{ ref, el: WeakRef, node }] } while hints are shown
  let ring = null; // { el, node, timer, raf }
  // The paragraph being read aloud: { session, anchor { el, start, end }, node, raf, at }.
  let mark = null;
  // The newest generation of hints.hide the background sent (hints.js): a drawing of an older
  // generation that arrives after it is dropped.
  let clearedGen = 0;

  const important = (node, props) => {
    for (const [k, v] of Object.entries(props)) node.style.setProperty(k, v, "important");
  };
  const plain = (node, props) => {
    for (const [k, v] of Object.entries(props)) node.style.setProperty(k, v);
  };

  // While screenshots are taken (page.see, element.see) the host is hidden: each capture has its
  // token, which ends with its shot_show or at the latest when the timer the background set runs
  // out; the host shows again once no capture is under way.
  const shots = new Map(); // token -> timer

  // The host's attributes, as Kai sets them.
  function dress() {
    for (const a of [...host.attributes]) host.removeAttribute(a.name);
    host.setAttribute(K.marker, "");
    important(host, { all: "initial" });
    important(host, HOST_STYLE);
    if (shots.size) important(host, { display: "none" });
    host.popover = "manual";
  }
  // The page removed the host, changed its attributes or closed its popover: back at the next
  // frame. Kai's own changes are taken off the observer's records.
  let repairing = 0;
  function repair() {
    if (repairing || !host) return;
    repairing = requestAnimationFrame(() => {
      repairing = 0;
      if (!host || (!hints && !ring && !mark)) return;
      if (!host.isConnected) document.documentElement.append(host);
      dress();
      raise();
    });
  }
  const watcher = new MutationObserver((records) => {
    if (records.some((r) => r.target === host || [...r.removedNodes].includes(host))) repair();
  });
  const closed = (e) => {
    if (e.newState === "closed" && !host?.matches(":popover-open")) repair();
  };

  function ensureHost() {
    if (host?.isConnected) return;
    if (host) {
      document.documentElement.append(host);
      dress();
      raise();
      return;
    }
    host = document.createElement("div");
    K.own.add(host);
    dress();
    root = host.attachShadow({ mode: "closed" });
    document.documentElement.append(host);
    host.addEventListener("toggle", closed);
    watcher.observe(document.documentElement, { childList: true });
    watcher.observe(host, { attributes: true });
    raise();
  }
  // Into the top layer, above whatever is there (a modal dialog opened earlier).
  function raise() {
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      /* no popover: the z-index alone */
    }
    watcher.takeRecords();
  }
  function dropHost() {
    watcher.disconnect();
    cancelAnimationFrame(repairing);
    repairing = 0;
    host?.removeEventListener("toggle", closed);
    host?.remove();
    host = root = null;
  }
  function dropHostIfEmpty() {
    if (host && !hints && !ring && !mark) dropHost();
  }

  // Hints: one label per { local, ref }, at the top left corner of its element's part in view,
  // clamped into the view.
  function drawHints(items, gen) {
    if (gen < clearedGen) return { drawn: 0, stale: true };
    ensureHost();
    raise();
    for (const l of hints?.labels ?? []) l.node.remove();
    hints = { labels: [] };
    for (const { local, ref } of items) {
      const { el } = K.element(local);
      if (!el) continue;
      const node = document.createElement("div");
      node.textContent = String(ref);
      plain(node, {
        position: "fixed",
        font: "700 12px/1.25 monospace",
        color: LOOK.fg,
        background: LOOK.bg,
        border: `1px solid ${LOOK.accent}`,
        "border-radius": "3px",
        padding: "0 3px",
        "white-space": "nowrap",
        "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.5)",
      });
      root.append(node);
      hints.labels.push({ ref, el: new WeakRef(el), node });
    }
    placeHints();
    return { drawn: hints.labels.length };
  }
  function placeHints() {
    if (!hints) return;
    const vp = K.viewport();
    const shown = K.clipper();
    for (const l of hints.labels) {
      const el = l.el.deref();
      const vis = el?.isConnected ? shown(el) : null;
      if (!vis) {
        l.node.style.setProperty("display", "none");
        continue;
      }
      l.node.style.setProperty("display", "block");
      l.node.style.setProperty("left", `${Math.max(0, Math.min(vis.x - 4, vp.w - l.node.offsetWidth))}px`);
      l.node.style.setProperty("top", `${Math.max(0, Math.min(vis.y - 6, vp.h - l.node.offsetHeight))}px`);
    }
  }
  function clearHints(gen) {
    clearedGen = Math.max(clearedGen, gen ?? 0);
    const n = hints?.labels.length ?? 0;
    for (const l of hints?.labels ?? []) l.node.remove();
    hints = null;
    dropHostIfEmpty();
    return { removed: n };
  }

  // While hints are shown: labels follow the page at each frame; once it settles, the background
  // labels the new view.
  let frame = 0;
  let settle = null;
  const moved = () => {
    if (!hints && !ring && !mark) return;
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        placeHints();
        placeMark();
      });
    }
    if (!hints) return;
    clearTimeout(settle);
    settle = setTimeout(() => browser.runtime.sendMessage({ kai: "hints_view" }).catch(() => {}), SETTLE_MS);
  };
  addEventListener("scroll", moved, { capture: true, passive: true });
  addEventListener("resize", moved, { passive: true });
  addEventListener("pagehide", () => {
    clearTimeout(settle);
    hints = null;
    stopRing();
    stopMark();
    dropHost();
  });

  // The ring around an element for `ms`, fading over its last third; the element is scrolled
  // into view first when it is not in view. An element that is not shown gets none.
  function point(el, ms) {
    if (!el.checkVisibility({ visibilityProperty: true })) return { hidden: true, scrolled: false };
    ensureHost();
    raise();
    stopRing();
    let scrolled = false;
    if (!K.clipper()(el)) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      scrolled = true;
    }
    const node = document.createElement("div");
    plain(node, {
      position: "fixed",
      border: `3px solid ${LOOK.accent}`,
      "border-radius": "6px",
      "box-shadow": `0 0 0 2px ${LOOK.halo}, 0 0 8px rgba(0, 0, 0, 0.45)`,
    });
    root.append(node);
    ring = { el, node, raf: 0, timer: 0 };
    const follow = () => {
      if (!ring || ring.node !== node) return;
      const r = el.getBoundingClientRect();
      plain(node, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      ring.raf = requestAnimationFrame(follow);
    };
    follow();
    node.animate([{ opacity: 1 }, { opacity: 1, offset: 2 / 3 }, { opacity: 0 }], { duration: ms, fill: "forwards" });
    ring.timer = setTimeout(() => {
      stopRing();
      dropHostIfEmpty();
    }, ms);
    return { scrolled };
  }
  function stopRing() {
    if (!ring) return;
    cancelAnimationFrame(ring.raf);
    clearTimeout(ring.timer);
    ring.node.remove();
    ring = null;
  }

  // The reading mark: a box around the text of a paragraph (anchor: its first and last text node
  // or field), placed again at every animation frame while it is shown, so it follows the
  // paragraph whatever moves it (a scroll, a resize, the page reflowing above it). A document
  // that is not shown draws no frames and measures nothing.
  const anchorRange = (a) => {
    const r = document.createRange();
    if (a.start.nodeType === Node.TEXT_NODE) r.setStart(a.start, 0);
    else r.setStartBefore(a.start);
    if (a.end.nodeType === Node.TEXT_NODE) r.setEnd(a.end, a.end.length);
    else r.setEndAfter(a.end);
    return r;
  };
  // Whether the paragraph's text is still in the page.
  const anchorThere = (a) => a.start.isConnected && a.end.isConnected;
  function drawMark(session, anchor) {
    stopMark();
    if (!anchorThere(anchor)) {
      dropHostIfEmpty();
      return false;
    }
    ensureHost();
    raise();
    const node = document.createElement("div");
    plain(node, {
      position: "fixed",
      border: `2px solid ${LOOK.accent}`,
      "border-radius": "4px",
      background: "rgba(61, 174, 233, 0.12)",
      "box-shadow": `0 0 0 1px ${LOOK.halo}`,
    });
    root.append(node);
    mark = { session, anchor, node, raf: 0, at: "" };
    const follow = () => {
      if (!mark || mark.node !== node) return;
      placeMark();
      mark.raf = requestAnimationFrame(follow);
    };
    follow();
    return true;
  }
  function placeMark() {
    if (!mark) return;
    if (!anchorThere(mark.anchor)) {
      if (mark.at !== "gone") mark.node.style.setProperty("display", "none");
      mark.at = "gone";
      return;
    }
    const r = anchorRange(mark.anchor).getBoundingClientRect();
    const at = `${r.left} ${r.top} ${r.width} ${r.height}`;
    if (at === mark.at) return;
    mark.at = at;
    plain(mark.node, { display: "block", left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
  }
  function stopMark() {
    if (!mark) return;
    cancelAnimationFrame(mark.raf);
    mark.node.remove();
    mark = null;
  }

  // What is drawn now, as the page would see it: the tests' check and page_see's (WP7) way to
  // know what to hide.
  function state() {
    const hs = host?.isConnected ? getComputedStyle(host) : null;
    const top = (n) => {
      const r = n.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { x: r.left, y: r.top, w: r.width, h: r.height, shown: n.checkVisibility({ opacityProperty: true, visibilityProperty: true }), under: hit && hit !== host ? K.roleOf(hit) : null };
    };
    return {
      host: hs ? { display: hs.display, visibility: hs.visibility, opacity: hs.opacity, pointer_events: hs.pointerEvents, top_layer: host.matches(":popover-open") } : null,
      hints: hints ? hints.labels.map((l) => ({ ref: l.ref, text: l.node.textContent, ...top(l.node) })) : null,
      ring: ring ? top(ring.node) : null,
      mark: mark ? { session: mark.session, ...top(mark.node) } : null,
    };
  }

  // The labels' texts, which page.find does not count as the page's.
  K.ownTexts = () => (hints ? hints.labels.map((l) => l.node.textContent) : []);

  // Hides what Kai draws for the capture `token`; answers once the page has drawn a frame without
  // it (at once in a document that is not shown, which draws no frames: the capture paints it
  // anew), with this document's origin and URL (see.js lists the frames in the image).
  function shotHide(ms, token) {
    clearTimeout(shots.get(token));
    shots.set(token, setTimeout(() => shotShow(token), ms));
    const me = { origin: K.originNow(), url: location.href, document: browser.runtime.getDocumentId(window) };
    if (host) {
      important(host, { display: "none" });
      watcher.takeRecords();
    }
    if (!host || document.visibilityState === "hidden") return { hidden: !!host, ...me };
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ hidden: true, ...me }))));
  }
  function shotShow(token) {
    if (!shots.has(token)) return {};
    clearTimeout(shots.get(token));
    shots.delete(token);
    if (!shots.size && host && (hints || ring || mark)) {
      dress();
      raise();
    }
    return {};
  }

  Object.assign(K.handlers, {
    shot_hide: ({ ms, token }) => shotHide(ms, token),
    shot_show: ({ token }) => shotShow(token),
    hints_draw: ({ items, gen }) => drawHints(items, gen ?? 0),
    hints_clear: ({ gen }) => clearHints(gen),
    ring: ({ local, ms }) => {
      const r = K.element(local);
      if (r.gone) return { gone: r.gone };
      return { el: K.describe(r.el), ...point(r.el, ms) };
    },
    overlay_state: () => state(),
  });
  Object.assign(K, {
    anchorRange,
    anchorThere,
    drawMark,
    // Clears the reading mark of `session` (any session's when null).
    clearMark(session = null) {
      if (!mark || (session !== null && mark.session !== session)) return false;
      stopMark();
      dropHostIfEmpty();
      return true;
    },
  });
})();

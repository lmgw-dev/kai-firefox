// Kai for Firefox's content script, one per frame (classic scripts after the vendored
// dom-accessibility-api, which sets the global DomAccessibilityApi): this core, then walk.js,
// read.js and overlay.js, which add to the object it shares. It keeps the elements it has named
// (D4: Map<localId, WeakRef<Element>>; the background turns local ids into refs), tracks the last
// pointer position, and answers the background's questions about its document. Names and roles
// are computed as assistive technology does (D5). Nothing runs in private windows (§3).

(() => {
  // The static content scripts and the background's injection fallback share this world. An own
  // property only: a page's named element (<iframe name="kaiFirefoxContent">) must not count.
  if (Object.hasOwn(globalThis, "kaiFirefoxContent")) return;
  // What the other content files use; `handlers` answer the background's messages by `kai`.
  // `own`: the elements Kai draws into the page (overlay.js), which no walker reads. `marker`: an
  // attribute name, random per document, that Kai's overlay host carries, so page.css keeps its
  // rules off it (styles.js).
  const marker = `data-kai-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const K = { handlers: {}, off: browser.extension.inIncognitoContext, own: new WeakSet(), memo: null, marker };
  Object.defineProperty(globalThis, "kaiFirefoxContent", { value: K });
  if (K.off) return;

  const A = globalThis.DomAccessibilityApi;

  let nextLocal = 1;
  const elements = new Map(); // localId -> WeakRef<Element>
  const localIds = new WeakMap(); // Element -> localId
  // An element the garbage collector took leaves the map; its id (below nextLocal) still answers
  // "collected". While events are watched, listen.js hands the ids on to the background, which
  // drops their refs.
  const collected = { ids: [], keep: false };
  const reaper = new FinalizationRegistry((id) => {
    elements.delete(id);
    if (collected.keep) collected.ids.push(id);
  });
  function localOf(el) {
    let id = localIds.get(el);
    if (!id) {
      id = nextLocal++;
      localIds.set(el, id);
      elements.set(id, new WeakRef(el));
      reaper.register(el, id);
    }
    return id;
  }

  // Controls, as a screen reader's elements list counts them.
  const INTERACTIVE = [
    "a[href]",
    "area[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "video[controls]",
    "audio[controls]",
    "[contenteditable]:not([contenteditable=false])",
    "[tabindex]:not([tabindex='-1'])",
    ...["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "slider", "combobox", "textbox", "searchbox", "option", "spinbutton", "listbox", "treeitem", "gridcell"].map((r) => `[role=${r}]`),
  ].join(",");
  const PLAIN = new Set(["generic", "presentation"]);
  const FRAMES = new Set(["iframe", "frame", "embed", "object"]);
  // §5: fields whose value is never reported. A field that was one stays one for the document's
  // life: a "show password" button turns a password field into a text field with the same value.
  // Seen as sensitive: by any check, by typing into it or focusing it, and by the change of its
  // type or autocomplete attribute in the document (shadow roots' fields by the other ways).
  const SENSITIVE_AUTOCOMPLETE = /\b(cc-number|cc-csc|one-time-code|current-password|new-password)\b/i;
  const wasSensitive = new WeakSet();
  const sensitiveNow = (el) => (el.localName === "input" && el.type === "password") || SENSITIVE_AUTOCOMPLETE.test(el.getAttribute?.("autocomplete") || "");
  const sensitive = (el) => {
    if (wasSensitive.has(el)) return true;
    if (!sensitiveNow(el)) return false;
    wasSensitive.add(el);
    return true;
  };
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target;
      const was = r.attributeName === "type" ? el.localName === "input" && (r.oldValue ?? "").trim().toLowerCase() === "password" : SENSITIVE_AUTOCOMPLETE.test(r.oldValue ?? "");
      if (was) wasSensitive.add(el);
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["type", "autocomplete"], attributeOldValue: true });
  const noteSensitive = (e) => {
    const t = e.composedPath?.()[0] ?? e.target;
    if (t?.nodeType === Node.ELEMENT_NODE) sensitive(t);
  };
  addEventListener("input", noteSensitive, { capture: true, passive: true });
  addEventListener("focusin", noteSensitive, { capture: true, passive: true });

  // Roles by ARIA (the first role token Kai knows) and HTML-AAM. dom-accessibility-api's getRole
  // maps some elements without their conditions (a section or form without a name is a region or
  // form there, generic in HTML-AAM; header and footer inside sectioning content are generic) and
  // leaves out others (p, blockquote, code and the like), so the mapping is ours.
  const ARIA_ROLES = new Set(
    ("alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary " +
      "contentinfo definition deletion dialog document emphasis feed figure form generic grid gridcell group heading img insertion link " +
      "list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note " +
      "option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator " +
      "slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip " +
      "tree treegrid treeitem").split(" "),
  );
  const BY_TAG = {
    article: "article", aside: "complementary", blockquote: "blockquote", button: "button", caption: "caption", code: "code",
    datalist: "listbox", dd: "definition", del: "deletion", details: "group", dfn: "term", dialog: "dialog", dt: "term",
    em: "emphasis", fieldset: "group", figure: "figure", h1: "heading", h2: "heading", h3: "heading", h4: "heading",
    h5: "heading", h6: "heading", hgroup: "group", hr: "separator", html: "document", ins: "insertion", li: "listitem",
    main: "main", mark: "mark", math: "math", menu: "list", meter: "meter", nav: "navigation", ol: "list", optgroup: "group",
    option: "option", output: "status", p: "paragraph", progress: "progressbar", search: "search", strong: "strong",
    sub: "subscript", summary: "button", sup: "superscript", table: "table", tbody: "rowgroup", textarea: "textbox",
    tfoot: "rowgroup", thead: "rowgroup", time: "time", tr: "row", ul: "list",
  };
  // HTML-AAM gives the input types below "range" no ARIA role; screen readers name them by their
  // kind ("date picker", "file upload"), so Kai's role words do (the contract's Element: role
  // words for inputs). `<time>` keeps the ARIA role `time`, which is text-level and no field.
  const INPUT_ROLES = {
    button: "button", image: "button", reset: "button", submit: "button", checkbox: "checkbox", radio: "radio",
    range: "slider", number: "spinbutton", search: "searchbox", email: "textbox", tel: "textbox", text: "textbox",
    url: "textbox", password: "textbox", file: "file", date: "date", time: "time", "datetime-local": "datetime",
    month: "month", week: "week", color: "color",
  };
  const SECTIONING = "article, aside, main, nav, section";
  const labelled = (el) => el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || el.hasAttribute("title");
  function implicitRole(el) {
    const tag = el.localName;
    if (tag in BY_TAG) return BY_TAG[tag];
    switch (tag) {
      case "a":
      case "area":
        return el.hasAttribute("href") ? "link" : "generic";
      case "header":
        return el.parentElement?.closest(SECTIONING) ? "generic" : "banner";
      case "footer":
        return el.parentElement?.closest(SECTIONING) ? "generic" : "contentinfo";
      case "section":
        return labelled(el) ? "region" : "generic";
      case "form":
        return labelled(el) ? "form" : "generic";
      case "img":
        return el.getAttribute("alt") === "" ? "presentation" : "img";
      case "svg":
        return "img";
      case "input": {
        const role = INPUT_ROLES[el.type] ?? "generic";
        return el.hasAttribute("list") && (role === "textbox" || role === "searchbox") ? "combobox" : role;
      }
      case "select":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "td":
        return el.closest("table")?.getAttribute("role") === "grid" ? "gridcell" : "cell";
      case "th": {
        const scope = el.getAttribute("scope");
        if (scope === "row" || scope === "rowgroup") return "rowheader";
        if (scope === "col" || scope === "colgroup" || el.parentElement?.closest("thead")) return "columnheader";
        // Without a scope: a header row (header cells, and empty cells such as the corner) has
        // column headers; a header cell among data cells heads its row. A cell holding only a
        // field or an image is not empty.
        const row = el.parentElement;
        return row && [...row.children].every((c) => c.localName !== "td" || (!c.children.length && !c.textContent.trim())) ? "columnheader" : "rowheader";
      }
      default:
        return "generic";
    }
  }
  function roleOf(el) {
    for (const r of (el.getAttribute("role") || "").trim().split(/\s+/)) {
      if (ARIA_ROLES.has(r)) return r === "none" ? "presentation" : r;
    }
    return implicitRole(el);
  }

  function nameOf(el) {
    let name = "";
    try {
      // The library's default for pseudo-elements is jsdom's; a browser resolves ::before content.
      name = A.computeAccessibleName(el, { computedStyleSupportsPseudoElements: true });
    } catch {
      name = "";
    }
    // HTML-AAM's last fallback, which the library leaves out (WP0 (f)).
    if (!name && (el.localName === "input" || el.localName === "textarea")) name = el.getAttribute("placeholder") || "";
    return name ? masked(name, el).trim() : "";
  }

  // §5's words for a sensitive field's value.
  const MASK = (n) => `password field, filled (${n} characters)`;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A URL's origin; null when it has none or an opaque one.
  const originOf = (url) => {
    try {
      const o = new URL(url).origin;
      return o === "null" ? null : o;
    } catch {
      return null;
    }
  };
  const idRefs = (el, attr) =>
    (el.getAttribute(attr) || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => el.getRootNode().getElementById?.(id))
      .filter(Boolean);

  // A value kept for the rest of one answer's synchronous part, in which the page cannot change.
  // Outside it nothing is kept: after an acting handler awaits (act.js), the page has run.
  const memo = (key, make) => {
    const m = K.memo;
    if (!m) return make();
    if (!m.has(key)) m.set(key, make());
    return m.get(key);
  };
  // Runs fn with a memo of its own (a timer's or a page event's synchronous part), or within the
  // one under way.
  const scoped = (fn) => {
    if (K.memo) return fn();
    K.memo = new Map();
    try {
      return fn();
    } finally {
      K.memo = null;
    }
  };
  // The page's sensitive fields and aria-owns elements, each with its ancestors across shadow
  // roots (itself included).
  const withAncestors = (el) => {
    const anc = new Set();
    for (let e = el; e; e = up(e)) anc.add(e);
    return { el, anc };
  };
  const maskSources = () =>
    memo("mask", () => {
      const fields = [...deepAll(document, "input, textarea, [autocomplete]")].filter(sensitive).map(withAncestors);
      return { fields, owners: fields.length ? [...deepAll(document, "[aria-owns]")].map(withAncestors) : [] };
    });
  // A sensitive field's values: what it holds (an editable element's text) and its value
  // attribute.
  const fieldValues = (el) => [el.localName === "input" || el.localName === "textarea" ? el.value : el.innerText, el.getAttribute("value")].filter((v) => typeof v === "string" && v.trim());
  // Masks each value of `values` (value -> its length in code points) in text, longest first:
  // as typed, trimmed, and with its white space collapsed or broken otherwise (page text joins
  // and wraps lines its own way).
  function maskValues(text, values) {
    if (!text || !values.size) return text;
    const byPattern = new Map();
    for (const [v, n] of values) byPattern.set(v.trim().split(/\s+/).map(escapeRe).join("\\s+"), n);
    const patterns = [...byPattern.keys()].sort((a, b) => b.length - a.length);
    const re = new RegExp(patterns.map((p) => `(${p})`).join("|"), "g");
    return text.replace(re, (...m) => MASK(byPattern.get(patterns[m.slice(1, patterns.length + 1).findIndex((g) => g !== undefined)])));
  }
  // Page text with the value of every sensitive field of the document masked: page text can echo
  // what was typed (an error repeating the value, a "show password" text beside the field).
  const maskAll = (text) => {
    if (!text) return text;
    const values = memo("maskValues", () => {
      const out = new Map();
      for (const f of maskSources().fields) for (const v of fieldValues(f.el)) out.set(v, codePoints(v));
      return out;
    });
    return maskValues(text, values);
  };

  // A name with the values of sensitive fields masked. Accname puts an embedded field's value into
  // the name of what contains it or is labelled by it, so every sensitive field the name can draw
  // on counts: in the element, its labels and the elements it is labelled by, their subtrees
  // (open and closed shadow roots) and what they own (aria-owns). Masking is by text, so an equal
  // piece of other text in the name is masked too.
  function masked(name, el) {
    const { fields, owners } = maskSources();
    if (!fields.length) return name;
    const values = new Map(); // a value -> its length
    const seen = new Set();
    const todo = [el, ...(el.labels ?? []), ...idRefs(el, "aria-labelledby")];
    while (todo.length) {
      const r = todo.pop();
      if (seen.has(r)) continue;
      seen.add(r);
      for (const o of owners) if (o.anc.has(r)) todo.push(...idRefs(o.el, "aria-owns"));
      for (const f of fields) {
        if (!f.anc.has(r)) continue;
        for (const v of fieldValues(f.el)) values.set(v, codePoints(v));
      }
    }
    return maskValues(name, values);
  }

  // An element as the operations name it; a heading with its level.
  function describe(el) {
    const d = { local: localOf(el), role: roleOf(el), name: nameOf(el) };
    if (d.role === "heading") d.level = K.levelOf(el);
    return d;
  }

  // The element's parent across shadow boundaries.
  const up = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);

  // Every element under root matching sel, into open and closed shadow roots, in tree order;
  // Kai's own elements left out. The selector is matched once per root by the engine; the walk
  // only looks for shadow roots.
  function* deepAll(root, sel) {
    const hits = new Set(root.querySelectorAll(sel));
    for (const el of root.querySelectorAll("*")) {
      if (K.own.has(el)) continue;
      if (hits.has(el)) yield el;
      const sr = el.openOrClosedShadowRoot;
      if (sr) yield* deepAll(sr, sel);
    }
  }

  // The focused element, through shadow roots.
  function focused() {
    let el = document.activeElement;
    while (el?.openOrClosedShadowRoot?.activeElement) el = el.openOrClosedShadowRoot.activeElement;
    return el;
  }
  // The focus as context.get reports it; an <iframe> means the focus is in that frame.
  function focusInfo() {
    const el = focused();
    if (!el || el === document.body || el === document.documentElement) return null;
    if (FRAMES.has(el.localName)) {
      const id = frameIdOf(el);
      return id === null ? null : { frame: id };
    }
    return { el: describe(el) };
  }

  const codePoints = (s) => s.length - (s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
  const firstLine = (s) => s.split(/\r\n|\r|\n|\u2028|\u2029/).map((l) => l.trim()).find((l) => l) ?? "";

  // The selection: in the focused text field its selected part, else the document's; { text,
  // masked, field } or null. A focused sensitive field never lets the document's selection
  // through: its selection is masked, or null when it cannot be read (an input type without a
  // selection, or none made).
  function selected() {
    const el = focused();
    const textField = el && (el.localName === "input" || el.localName === "textarea");
    if (textField) {
      let start = null;
      let end = null;
      try {
        start = el.selectionStart;
        end = el.selectionEnd;
      } catch {
        /* an input type without a selection */
      }
      if (start !== null && end !== null && end > start) return { text: el.value.slice(start, end), masked: sensitive(el), field: el };
    }
    if (el && sensitive(el)) {
      if (textField) return null;
      // A sensitive editable element: its selection is the document's.
      const text = getSelection()?.toString() ?? "";
      return text ? { text, masked: true, field: el } : null;
    }
    const text = getSelection()?.toString() ?? "";
    return text ? { text, masked: false, field: null } : null;
  }
  function selectionInfo() {
    const s = selected();
    if (!s) return null;
    return { length: codePoints(s.text), first_line: s.masked ? null : firstLine(s.text), masked: s.masked, field: s.field ? describe(s.field) : null };
  }

  // The last pointer position this document saw, and whether the pointer is still over it. A
  // pointer that went on into a child frame is still over this document, at that frame.
  let pointer = null;
  const frameIdOf = (el) => {
    try {
      return browser.runtime.getFrameId(el);
    } catch {
      return null;
    }
  };
  // Trusted events only: a page's own dispatched events must not steer what Kai calls "that".
  const moved = (e) => {
    if (!e.isTrusted) return;
    pointer = { x: e.clientX, y: e.clientY, inside: true };
  };
  for (const type of ["pointermove", "pointerdown", "pointerover", "mouseover"]) addEventListener(type, moved, { capture: true, passive: true });
  addEventListener(
    "pointerout",
    (e) => {
      if (!e.isTrusted) return;
      if (!e.relatedTarget && pointer) pointer = { ...pointer, inside: FRAMES.has(e.target?.localName) };
    },
    { capture: true, passive: true },
  );

  // Trusted pointer and key input: someone acted in this tab, the user or Kai through the desktop
  // (design §6.3). The background keeps when, and the origin of the tab's page (user.js), for
  // Kai's focus rule (design §6.4), and tells Kai's input spans apart. While the network gate that
  // focus.check opened watches this document (`keyGates`, act.js), a trusted keydown also says
  // which key reached which element: gate.result's key_seen. A character is never named.
  const keyGates = new Set();
  const keyName = (k) => (k === " " ? "Space" : [...k].length > 1 ? k : "character");
  const userActed = (e) => {
    if (!e.isTrusted || e.repeat) return;
    const m = { kai: "user_input" };
    if (e.type === "keydown" && keyGates.size) {
      const el = focused();
      m.key = { gates: [...keyGates], key: keyName(e.key), el: el && el !== document.body && el !== document.documentElement ? describe(el) : null };
    }
    browser.runtime.sendMessage(m).catch(() => {});
  };
  addEventListener("pointerdown", userActed, { capture: true, passive: true });
  addEventListener("keydown", userActed, { capture: true, passive: true });

  // While a kept gate (gate.open, focus.check) watches this document, the first trusted click it
  // gets says which element it reached (gate.result's click_seen): Kai's press through
  // accessibility clicks without a pointerdown, so it is told by its click. The gate's own element
  // (`aimGates`, act.js) when the click is on it or inside it, else the nearest control. A click
  // is not the user's act here: what it means for the tab's facts is the pointer's and the key's
  // (above).
  const aimGates = new Map(); // gate id -> the local id of its element
  addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || !keyGates.size) return;
      const target = e.composedPath?.()[0] ?? e.target;
      const node = target instanceof Element ? target : target?.parentElement;
      // The nearest control, else the element itself (the body is none).
      let near = null;
      for (let x = node; x && x !== document.body && x !== document.documentElement; x = up(x)) {
        if (x.matches(INTERACTIVE)) {
          near = x;
          break;
        }
      }
      near ??= node && node !== document.body && node !== document.documentElement ? node : null;
      // Each gate its own element: its aim when the click was on it or inside it.
      const seen = [...keyGates].map((g) => {
        const aim = elements.get(aimGates.get(g))?.deref();
        const on = aim && node && (aim === node || aim.contains(node) || aim.shadowRoot?.contains(node));
        const el = on ? aim : near;
        return { gate: g, el: el ? describe(el) : null };
      });
      browser.runtime.sendMessage({ kai: "click_seen", seen }).catch(() => {});
    },
    { capture: true, passive: true },
  );

  function hitTest(x, y) {
    let el = document.elementFromPoint(x, y);
    for (;;) {
      const sr = el?.openOrClosedShadowRoot;
      const inner = sr?.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // What is at a point of the viewport: the nearest control, else the nearest element with a
  // role; or a child frame, with the point in that frame's viewport.
  function pointAt(x, y) {
    const hit = hitTest(x, y);
    if (!hit) return null;
    if (FRAMES.has(hit.localName)) {
      const id = frameIdOf(hit);
      if (id === null) return null;
      const r = hit.getBoundingClientRect();
      const cs = getComputedStyle(hit);
      return { frame: id, x: x - r.left - hit.clientLeft - parseFloat(cs.paddingLeft), y: y - r.top - hit.clientTop - parseFloat(cs.paddingTop) };
    }
    let el = null;
    for (let e = hit; e && e !== document.body && e !== document.documentElement; e = up(e)) {
      if (e.matches(INTERACTIVE)) {
        el = e;
        break;
      }
    }
    if (!el) {
      for (let e = hit; e && e !== document.body && e !== document.documentElement; e = up(e)) {
        if (!PLAIN.has(roleOf(e))) {
          el = e;
          break;
        }
      }
    }
    return el ? { el: describe(el) } : null;
  }

  // null: this document saw no pointer since it loaded; { left: true }: it saw the pointer leave;
  // else what is at the pointer ({ el: null } for nothing with a role).
  const pointerInfo = () => (!pointer ? null : !pointer.inside ? { left: true } : (pointAt(pointer.x, pointer.y) ?? { el: null }));

  // The open modal dialog: a <dialog> opened with showModal, or a visible aria-modal dialog. With
  // several, the innermost: the last in tree order (a nested one comes after its outer one), and
  // an aria-modal dialog only inside the modal <dialog> when there is one (outside it, it is
  // inert like the rest). Everything of the document outside it is inert.
  function modalElement() {
    return memo("modal", () => {
      const native = [...deepAll(document, "dialog")].filter((d) => d.matches(":modal")).at(-1) ?? null;
      let aria = null;
      for (const el of deepAll(native ?? document, "[aria-modal=true]")) if (ariaModalOpen(el)) aria = el;
      return aria ?? native;
    });
  }
  // Hidden from assistive technology: it or an element around it (across shadow roots) has
  // aria-hidden="true".
  const ariaHidden = (el) => {
    for (let e = el; e; e = up(e)) if (e.getAttribute("aria-hidden") === "true") return true;
    return false;
  };
  // An open aria-modal dialog: aria-modal="true", the role dialog or alertdialog, shown
  // (display and visibility) and not hidden from assistive technology (a11y-dialog closes its
  // dialogs with aria-hidden).
  const ariaModalOpen = (el) => {
    if (el.getAttribute("aria-modal") !== "true") return false;
    const role = roleOf(el);
    return (role === "dialog" || role === "alertdialog") && el.checkVisibility({ visibilityProperty: true }) && !ariaHidden(el);
  };

  const HEADINGS = "h1, h2, h3, h4, h5, h6, [role=heading]";
  // The part in view: the first heading in view and how far down the page the view is.
  function viewInfo() {
    const se = document.scrollingElement || document.documentElement;
    const max = se.scrollHeight - innerHeight;
    const view = { scrollable: max > 0, percent: max > 0 ? Math.round((100 * scrollY) / max) : 0, heading: null };
    const shown = K.clipper();
    for (const h of deepAll(document, HEADINGS)) {
      const r = h.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.width > 0 && h.checkVisibility() && shown(h, K.rectOf(r))) {
        view.heading = describe(h);
        break;
      }
    }
    return view;
  }

  // This document's origin: its URL's, else (about:blank, about:srcdoc) the one it inherited;
  // null when opaque.
  const originNow = () => {
    let o = "null";
    try {
      o = new URL(location.href).origin;
    } catch {
      /* no URL origin */
    }
    if (o === "null") o = globalThis.origin;
    return o && o !== "null" ? o : null;
  };
  const self = () => ({
    frame: browser.runtime.getFrameId(window),
    document: browser.runtime.getDocumentId(window),
    url: location.href,
    origin: originNow(),
  });

  Object.assign(K, {
    INTERACTIVE, FRAMES, HEADINGS, sensitive, roleOf, nameOf, masked, MASK, describe, localOf, up, deepAll, memo,
    codePoints, frameIdOf, self, idRefs, focused, selected, modalElement, hitTest, focusInfo, originNow, escapeRe, originOf,
    keyGates, aimGates, scoped, maskAll, ariaHidden, ariaModalOpen, collected,
    // The element of a local id, or why there is none (null: an id whose ref the background
    // dropped once the element was collected).
    element(local) {
      const el = elements.get(local)?.deref();
      if (!el) return { gone: local === null || elements.has(local) || (Number.isSafeInteger(local) && local >= 1 && local < nextLocal) ? "collected" : "unknown" };
      if (!el.isConnected) return { gone: "removed" };
      return { el };
    },
    // aria-level when it is a whole number from 1, else h1 to h6's number, else 2.
    levelOf: (h) => {
      const aria = Number(h.getAttribute("aria-level"));
      return Number.isInteger(aria) && aria >= 1 ? aria : Number(/^h([1-6])$/.exec(h.localName)?.[1] ?? 2);
    },
  });

  const HANDLERS = {
    // Who this frame is, and its history length (the top frame's, for tabs.back/forward).
    whoami: () => ({ ...self(), history_length: window === window.top ? history.length : null, marker, time_origin: performance.timeOrigin }),
    context: () => ({
      ...self(),
      focus: focusInfo(),
      selection: selectionInfo(),
      pointer: pointerInfo(),
      dialog: modalElement() ? describe(modalElement()) : null,
      view: window === window.top ? viewInfo() : null,
    }),
    // What is at a point, for a parent document that saw the pointer go into this frame while
    // this document saw no pointer event (WebDriver's synthetic pointer stays in the top document).
    point: ({ x, y }) => pointAt(x, y),
    describe: ({ local }) => {
      const { el, gone } = K.element(local);
      return gone ? { gone } : { el: describe(el), origin: originNow() };
    },
  };
  Object.assign(K.handlers, HANDLERS);

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.kai !== "string" || !Object.hasOwn(K.handlers, msg.kai)) return undefined;
    return Promise.resolve().then(() => {
      K.memo = new Map();
      try {
        return K.handlers[msg.kai](msg);
      } finally {
        K.memo = null;
      }
    });
  });
})();

// Kai for Firefox's content script, part 3 (after walk.js): this frame's answers for the reading
// operations (design §5.3): outline, controls, links and fields with their states, text, an
// element's text, tables, the selection, find matches, and the article (Readability, which the
// background runs in this world first). Sensitive fields' values are masked everywhere (§5).

(() => {
  const K = Object.hasOwn(globalThis, "kaiFirefoxContent") ? globalThis.kaiFirefoxContent : null;
  if (!K || K.off || K.read) return;
  K.read = true;
  const { describe, roleOf, nameOf, masked, sensitive, codePoints, up, deepAll, localOf, self, memo, viewport, rectOf, clipper, framePlaceholder, rendered, textParent, FRAMES, HEADINGS, NOT_TEXT, textBlocks, TEXTY } = K;
  const A = globalThis.DomAccessibilityApi;

  const FRAME_SEL = "iframe, frame, embed, object";
  const LINKS = "a[href], area[href], [role=link]";
  const FIELD_ROLES = ["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton"];
  const FIELDS = [
    "input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image])",
    "select",
    "textarea",
    "[contenteditable]:not([contenteditable=false])",
    ...FIELD_ROLES.map((r) => `[role=${r}]`),
  ].join(",");
  const LANDMARK_SEL = "header, footer, nav, main, aside, form, section, search, " + ["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"].map((r) => `[role=${r}]`).join(", ");
  const LANDMARKS = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"]);
  const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  const SELECTABLE = new Set(["option", "tab", "treeitem", "gridcell", "row"]);
  const VALUED = new Set(["slider", "spinbutton", "scrollbar", "progressbar", "meter"]);
  // Roles of text inside a sentence: a match's containing element is above them.
  const TEXT_LEVEL = new Set(["generic", "presentation", "emphasis", "strong", "mark", "code", "subscript", "superscript", "time", "deletion", "insertion", "term"]);
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const safeMatches = (el, sel) => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  };

  // What the ancestors (across shadow roots) say about an element: hidden from assistive
  // technology, inert, inside the modal, disabled by aria-disabled.
  function ancestry(el, modal = null) {
    const a = { ariaHidden: false, inert: false, inModal: !modal, ariaDisabled: false };
    for (let e = el; e; e = up(e)) {
      if (e.getAttribute("aria-hidden") === "true") a.ariaHidden = true;
      if (e.hasAttribute("inert")) a.inert = true;
      if (e.getAttribute("aria-disabled") === "true") a.ariaDisabled = true;
      if (e === modal) a.inModal = true;
    }
    return a;
  }
  const within = (outer, el) => {
    for (let e = el; e; e = up(e)) if (e === outer) return true;
    return false;
  };

  // The texts of the elements an id list names, masked like names.
  const textOfIds = (el, attr) =>
    K.idRefs(el, attr)
      .map((e) => clean(e.textContent))
      .filter(Boolean)
      .join(" ");

  // A control's value and states (design §5.3: value or state, checked, disabled, invalid,
  // expanded, the field's label and its error). Keys are present only where they apply.
  function stateOf(el, role, name, ariaDisabled) {
    const s = {};
    const tag = el.localName;
    const aria = (a) => el.getAttribute(a);
    if (tag === "input" || tag === "textarea") {
      const type = tag === "textarea" ? "textarea" : el.type;
      if (type === "textarea" || TEXTY.has(type)) {
        if (sensitive(el)) {
          s.masked = true;
          s.length = codePoints(el.value);
        } else s.value = el.value;
      } else if (type === "range") {
        s.value = el.value;
        s.min = el.min || "0";
        s.max = el.max || "100";
      } else if (type === "file") s.value = [...(el.files || [])].map((f) => f.name).join(", ");
      else if (type === "color") s.value = el.value;
      if (type === "checkbox" || type === "radio") s.checked = el.indeterminate ? "mixed" : el.checked;
    } else if (tag === "select") {
      s.value = [...el.selectedOptions].map((o) => o.label.trim()).join(", ");
    } else if (el.isContentEditable && (el.matches("[contenteditable]") || role === "textbox")) {
      const t = el.innerText.replace(/\n$/, "");
      if (sensitive(el)) {
        s.masked = true;
        s.length = codePoints(t);
      } else s.value = t;
    }
    if (!("value" in s) && !s.masked && VALUED.has(role)) {
      const v = aria("aria-valuetext") ?? aria("aria-valuenow");
      if (v !== null) s.value = v;
      if (aria("aria-valuemin") !== null) s.min = aria("aria-valuemin");
      if (aria("aria-valuemax") !== null) s.max = aria("aria-valuemax");
    }
    if (!("value" in s) && !s.masked && role === "combobox" && aria("aria-valuetext") !== null) s.value = aria("aria-valuetext");
    if (!("checked" in s) && CHECKABLE.has(role)) {
      const c = aria("aria-checked");
      s.checked = c === "mixed" ? "mixed" : c === "true";
    }
    if (SELECTABLE.has(role)) {
      if (tag === "option") s.selected = el.selected;
      else if (aria("aria-selected") !== null) s.selected = aria("aria-selected") === "true";
    }
    const pressed = aria("aria-pressed");
    if (pressed === "true" || pressed === "false") s.pressed = pressed === "true";
    else if (pressed === "mixed") s.pressed = "mixed";
    const expanded = aria("aria-expanded");
    if (expanded === "true" || expanded === "false") s.expanded = expanded === "true";
    else if (tag === "summary" && el.parentElement?.localName === "details") s.expanded = el.parentElement.open;
    if (safeMatches(el, ":disabled") || ariaDisabled) s.disabled = true;
    if (((tag === "input" || tag === "textarea") && el.readOnly) || aria("aria-readonly") === "true") s.readonly = true;
    if (el.required || aria("aria-required") === "true") s.required = true;
    const invalid = aria("aria-invalid");
    if ((invalid !== null && invalid !== "false") || safeMatches(el, ":user-invalid")) {
      s.invalid = true;
      const error = textOfIds(el, "aria-errormessage") || (safeMatches(el, ":user-invalid") ? el.validationMessage : "");
      if (error) s.error = masked(error, el);
    }
    let description = "";
    try {
      description = A.computeAccessibleDescription(el, { computedStyleSupportsPseudoElements: true });
    } catch {
      description = "";
    }
    description = clean(masked(description, el));
    if (description && description !== name && description !== s.error) s.description = description;
    const label = clean(masked([...(el.labels ?? [])].map((l) => l.textContent).join(" "), el));
    if (label && label !== name) s.label = label;
    if (role === "link" || ((tag === "a" || tag === "area") && el.hasAttribute("href"))) {
      const href = el.href;
      s.url = typeof href === "string" ? href : href?.baseVal ? new URL(href.baseVal, document.baseURI).href : null;
    }
    return s;
  }

  // Controls (in view) or every link or field of the page, frames as placeholders. Each item's
  // `rect` is its box, `vis` the part of it in view (null: none).
  function collect({ kind, view }) {
    const vp = viewport();
    const shown = clipper();
    const modal = K.modalElement();
    const sel = (kind === "links" ? LINKS : kind === "fields" ? FIELDS : K.INTERACTIVE) + ", " + FRAME_SEL;
    const items = [];
    for (const el of deepAll(document, sel)) {
      const rect = rectOf(el.getBoundingClientRect());
      // The viewport first: only what meets it needs its ancestors' clips.
      const vis = rect.x < vp.w && rect.y < vp.h && rect.x + rect.w > 0 && rect.y + rect.h > 0 ? shown(el, rect) : null;
      if (FRAMES.has(el.localName)) {
        const p = framePlaceholder(el, shown);
        if (!p || (view && !p.vis)) continue;
        if (modal && !within(modal, el)) {
          if (kind === "controls") continue;
          p.inert = true;
        }
        items.push(p);
        continue;
      }
      if (view && !vis) continue;
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      const a = ancestry(el, modal);
      if (a.ariaHidden) continue;
      const inert = a.inert || !a.inModal;
      if (kind === "controls" && inert) continue;
      const d = describe(el);
      const item = { ...d, ...stateOf(el, d.role, d.name, a.ariaDisabled), rect, vis };
      if (kind === "fields") {
        const group = groupOf(el);
        if (group) item.group = group;
      }
      if (kind !== "controls" && inert) item.inert = true;
      items.push(item);
    }
    return { ...self(), viewport: vp, modal: modal ? describe(modal) : null, items };
  }

  // The name of the group a field is in: its fieldset's legend, or a named radiogroup or group
  // (each group's name computed once per answer).
  function groupOf(el) {
    const names = memo("groups", () => new Map());
    for (let e = up(el); e && e !== document.body; e = up(e)) {
      if (e.localName === "fieldset" || e.getAttribute("role") === "radiogroup" || e.getAttribute("role") === "group") {
        if (!names.has(e)) names.set(e, nameOf(e));
        if (names.get(e)) return names.get(e);
      }
    }
    return null;
  }

  // Landmarks and headings of the document, frames as placeholders.
  function outline() {
    const vp = viewport();
    const shown = clipper();
    const items = [];
    for (const el of deepAll(document, `${HEADINGS}, ${LANDMARK_SEL}, ${FRAME_SEL}`)) {
      if (FRAMES.has(el.localName)) {
        const p = framePlaceholder(el, shown);
        if (p) items.push(p);
        continue;
      }
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      const role = roleOf(el);
      if (role !== "heading" && !LANDMARKS.has(role)) continue;
      if (ancestry(el).ariaHidden) continue;
      const d = describe(el);
      if ((role === "region" || role === "form") && !d.name) continue;
      const rect = rectOf(el.getBoundingClientRect());
      items.push({ ...d, rect, vis: rect.x < vp.w && rect.y < vp.h && rect.x + rect.w > 0 && rect.y + rect.h > 0 ? shown(el, rect) : null });
    }
    const modal = K.modalElement();
    return { ...self(), viewport: vp, modal: modal ? describe(modal) : null, items };
  }

  // The table an element is or is in: a <table>, or role table, grid or treegrid.
  const TABLEISH = new Set(["table", "grid", "treegrid"]);
  const isTable = (e) => e.localName === "table" || TABLEISH.has(e.getAttribute("role"));
  function tableOf(el) {
    for (let e = el; e; e = up(e)) if (isTable(e)) return e;
    return null;
  }
  const nearest = (el, pred) => {
    for (let e = el; e; e = up(e)) if (pred(e)) return e;
    return null;
  };
  // Rows of cells: a native table's rows (thead, then the bodies, then tfoot), or an ARIA
  // table's role=row elements and their cells. Rows and cells that are not rendered (display:
  // none, also through a hidden row group) are left out, as the table's layout leaves them out.
  function rowsOf(t) {
    if (t.localName === "table") {
      return [...t.rows].filter((tr) => tr.checkVisibility()).map((tr) => ({ section: tr.parentElement, cells: [...tr.cells].filter((c) => c.checkVisibility()) }));
    }
    const rows = [];
    for (const r of deepAll(t, "[role=row]")) {
      if (nearest(up(r), isTable) !== t || !rendered(r)) continue;
      const cells = [];
      for (const c of deepAll(r, "[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]")) {
        if (nearest(up(c), (e) => e.getAttribute("role") === "row") === r && rendered(c)) cells.push(c);
      }
      rows.push({ section: up(r), cells });
    }
    return rows;
  }
  const cellText = (c) =>
    textBlocks(c)
      .filter((b) => b.text)
      .map((b) => b.text)
      .join("\n");

  // A table as cells with their row and column headers (design §5.3, table_read): the HTML table
  // model with rowspan (0: to the end of its row group) and colspan, `headers` ids, and header
  // cells by scope, thead or a row of header cells. Without `headers`, a cell's headers are found
  // as HTML's algorithm for assigning header cells finds them: up its columns for column headers,
  // left along its rows for row headers; a header block nearer the cell hides a header further
  // away at the same position and of the same size (a repeated header row, the previous section's
  // header), and a header of the other kind takes part in a block without being reported.
  function tableModel(t) {
    const rows = rowsOf(t);
    const grid = [];
    const cells = [];
    let columns = 0;
    rows.forEach((row, r) => {
      grid[r] ??= [];
      let c = 0;
      for (const el of row.cells) {
        while (grid[r][c] !== undefined) c++;
        const native = el.localName === "td" || el.localName === "th";
        const colspan = Math.min(1000, Math.max(1, native ? el.colSpan : Number(el.getAttribute("aria-colspan")) || 1));
        let rowspan = native ? el.rowSpan : Number(el.getAttribute("aria-rowspan")) || 1;
        if (rowspan === 0) {
          rowspan = 0;
          for (let i = r; i < rows.length && rows[i].section === row.section; i++) rowspan++;
        }
        rowspan = Math.max(1, Math.min(rowspan, rows.length - r));
        const role = roleOf(el);
        const header = el.localName === "th" || role === "columnheader" || role === "rowheader";
        const cell = { el, row: r, col: c, rowspan, colspan, header, kind: role === "columnheader" ? "column" : role === "rowheader" ? "row" : null };
        const idx = cells.push(cell) - 1;
        for (let i = 0; i < rowspan; i++) {
          grid[r + i] ??= [];
          for (let j = 0; j < colspan; j++) grid[r + i][c + j] = idx;
        }
        c += colspan;
        columns = Math.max(columns, c);
      }
    });
    // Per column and per row, its cells in order, once each: { idx, block }, `block` counting the
    // runs of header cells that data cells separate.
    const lines = (count, at) =>
      Array.from({ length: count }, (_, k) => {
        const out = [];
        let block = 0;
        let last;
        let wasHeader = false;
        for (let i = 0; ; i++) {
          const idx = at(k, i);
          if (idx === null) break;
          if (idx === undefined || idx === last) continue;
          last = idx;
          if (cells[idx].header) {
            out.push({ idx, block });
            wasHeader = true;
          } else if (wasHeader) {
            block++;
            wasHeader = false;
          }
        }
        return out;
      });
    const byColumn = lines(columns, (c, r) => (r >= rows.length ? null : grid[r]?.[c]));
    const byRow = lines(rows.length, (r, c) => (c >= columns ? null : grid[r]?.[c]));
    // The headers of `line` before position `pos` (a row or column number), nearest first, as
    // HTML's internal algorithm scans them.
    const scan = (line, pos, startOf, sizeKey, kind, idx, into) => {
      // The last entry starting before `pos` (the line is in order of its entries' starts).
      let lo = 0;
      let hi = line.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (startOf(cells[line[mid].idx]) < pos) lo = mid + 1;
        else hi = mid;
      }
      let i = lo - 1;
      const opaque = new Set();
      let pending = [];
      let block = null;
      for (; i >= 0; i--) {
        const { idx: h, block: b } = line[i];
        if (block !== null && b !== block) {
          for (const p of pending) opaque.add(sizeKey(cells[p]));
          pending = [];
        }
        block = b;
        pending.push(h);
        if (h !== idx && cells[h].kind === kind && !opaque.has(sizeKey(cells[h]))) into.add(h);
      }
    };
    const order = (set) => [...set].sort((a, b) => cells[a].row - cells[b].row || cells[a].col - cells[b].col);
    const texts = cells.map((c) => cellText(c.el));
    const index = new Map(cells.map((c, i) => [c.el, i]));
    const root = t.getRootNode();
    const out = cells.map((cell, idx) => {
      const colHeads = new Set();
      const rowHeads = new Set();
      const ids = (cell.el.getAttribute("headers") || "").split(/\s+/).filter(Boolean);
      if (ids.length) {
        for (const id of ids) {
          const hi = index.get(root.getElementById?.(id));
          if (hi === undefined) continue;
          (cells[hi].kind === "row" ? rowHeads : colHeads).add(hi);
        }
      } else {
        for (let c = cell.col; c < cell.col + cell.colspan; c++) scan(byColumn[c], cell.row, (h) => h.row, (h) => `${h.col},${h.colspan}`, "column", idx, colHeads);
        for (let r = cell.row; r < cell.row + cell.rowspan; r++) scan(byRow[r], cell.col, (h) => h.col, (h) => `${h.row},${h.rowspan}`, "row", idx, rowHeads);
      }
      const o = { row: cell.row + 1, column: cell.col + 1, text: texts[idx] };
      if (cell.rowspan > 1) o.rowspan = cell.rowspan;
      if (cell.colspan > 1) o.colspan = cell.colspan;
      if (cell.kind) o.header = cell.kind;
      o.column_headers = order(colHeads).map((i) => texts[i]);
      o.row_headers = order(rowHeads).map((i) => texts[i]);
      return o;
    });
    const caption = t.localName === "table" && t.caption ? clean(t.caption.textContent) : null;
    return { rows: rows.length, columns, caption, cells: out };
  }

  // The selection, whole (kai.js's selected()), and the focused child frame.
  function selectionAnswer() {
    const el = K.focused();
    const focusFrame = el && FRAMES.has(el.localName) ? K.childFrame(el) : null;
    const s = K.selected();
    const selection = s && { text: s.masked ? null : s.text, length: codePoints(s.text), masked: s.masked, field: s.field ? describe(s.field) : null };
    return { ...self(), focus_frame: focusFrame, selection };
  }

  // The element a find match is in: the nearest ancestor with a role above text level (a
  // paragraph, a heading, a cell, a link, a button).
  function containing(el) {
    for (let e = el; e && e !== document.documentElement; e = up(e)) {
      if (!TEXT_LEVEL.has(roleOf(e))) return e;
    }
    return null;
  }
  // The nearest ancestor that is not inline: the text a sentence is taken from.
  function blockOf(el) {
    for (let e = el; e; e = up(e)) {
      const d = getComputedStyle(e).display;
      if (d !== "contents" && !/^inline/.test(d)) return e;
    }
    return document.body;
  }
  const segmenters = new Map();
  // The sentence of `text` around [start, start + len), extended over sentences the match spans.
  function sentenceIn(text, start, len, lang) {
    let seg = segmenters.get(lang);
    if (!seg) {
      try {
        seg = new Intl.Segmenter(lang, { granularity: "sentence" });
      } catch {
        seg = new Intl.Segmenter("en", { granularity: "sentence" });
      }
      segmenters.set(lang, seg);
    }
    let from = null;
    let to = null;
    for (const s of seg.segment(text)) {
      const end = s.index + s.segment.length;
      if (from === null && start < end) from = s.index;
      if (from !== null && start + len <= end) {
        to = end;
        break;
      }
    }
    if (from === null) return clean(text);
    return clean(text.slice(from, to ?? text.length));
  }
  const langOf = (el) => el.closest?.("[lang]")?.lang || document.documentElement.lang || "en";

  // Whether a text node's text shows: not in a script or style, not under an element without a
  // box (memoised per answer).
  const textShown = (node) => {
    const p = textParent(node);
    if (!p || NOT_TEXT.has(p.localName)) return false;
    const seen = memo("textShown", () => new Map());
    if (!seen.has(p)) seen.set(p, rendered(p) && getComputedStyle(p).visibility === "visible");
    return seen.get(p);
  };
  // In a sensitive field: the node is in one, or in an element whose autocomplete makes it one.
  const inSensitive = (node) => {
    for (let e = node.nodeType === Node.ELEMENT_NODE ? node : textParent(node); e; e = up(e)) if (sensitive(e)) return true;
    return false;
  };

  // A match in a text node: its containing element and the sentence around it, from the shown
  // text of its block; { masked: true } for a match in a sensitive field.
  function resolveInText(node, offset, len) {
    if (inSensitive(node)) return { masked: true };
    const parent = textParent(node);
    const host = containing(parent);
    const block = blockOf(parent);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n === node || textShown(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    let text = "";
    let start = -1;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === node) start = text.length + offset;
      text += n.data;
    }
    return { el: host ? describe(host) : null, sentence: start < 0 ? clean(node.data) : sentenceIn(text, start, len, langOf(parent)) };
  }

  // Text compared the way Firefox's find compares it: case and diacritics ignored.
  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const occurrences = (hay, needle) => {
    let n = 0;
    for (let i = hay.indexOf(needle); needle && i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
    return n;
  };

  // Firefox's find results for this document (find.find's rangeData), one group per document
  // Firefox found matches in: { groups: [{ verified, matches }], excluded }. `startTextNodePos`
  // counts the document's text nodes in tree order (a TreeWalker over SHOW_TEXT, light DOM only),
  // so a match in a shadow root or a field's value has no such position, and Firefox's count runs
  // off the end for every match after it in the document. Matches whose text node does not hold
  // their text are looked up by their text instead, in tree order (shadow roots at their host,
  // field values at their field; script, style and hidden text left out) from where the previous
  // match ended. A match in a sensitive field answers { masked: true }; `excluded` counts the
  // query's occurrences in this document's sensitive values and in Kai's own labels, which the
  // background takes off matches it could not place.
  function findResolve({ groups, text }) {
    const nodes = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    let spots = null; // text nodes and fields in tree order, shadow roots included
    let where = null; // node or field -> its index in spots
    const collectSpots = () => {
      spots = [];
      where = new Map();
      const visit = (root) => {
        for (const n of root.childNodes) {
          if (n.nodeType === Node.TEXT_NODE) {
            if (textShown(n)) where.set(n, spots.push({ node: n }) - 1);
            continue;
          }
          if (n.nodeType !== Node.ELEMENT_NODE || NOT_TEXT.has(n.localName) || K.own.has(n) || !rendered(n)) continue;
          if (n.localName === "textarea" || (n.localName === "input" && TEXTY.has(n.type))) {
            if (n.value) where.set(n, spots.push({ field: n }) - 1);
            continue;
          }
          const sr = n.openOrClosedShadowRoot;
          if (sr) visit(sr);
          visit(n);
        }
      };
      visit(document);
    };
    const resolveGroup = (ranges) => {
      const at = ranges.map((r) => {
        const node = nodes[r.startTextNodePos];
        const piece = node ? node.data.slice(r.startOffset, r.startOffset + r.text.length) : null;
        return node && piece && r.text.startsWith(piece) ? node : null;
      });
      let cursor = { spot: 0, offset: 0 };
      const matches = ranges.map((r, i) => {
        if (at[i]) {
          if (where) cursor = { spot: where.get(at[i]) ?? cursor.spot, offset: r.startOffset + r.text.length };
          else cursor = { node: at[i], offset: r.startOffset + r.text.length };
          return resolveInText(at[i], r.startOffset, r.text.length);
        }
        if (!spots) {
          collectSpots();
          cursor = cursor.node ? { spot: where.get(cursor.node) ?? 0, offset: cursor.offset } : cursor;
        }
        for (let s = cursor.spot; s < spots.length; s++) {
          const spot = spots[s];
          const hay = spot.field ? spot.field.value : spot.node.data;
          const found = hay.indexOf(r.text, s === cursor.spot ? cursor.offset : 0);
          if (found < 0) continue;
          cursor = { spot: s, offset: found + r.text.length };
          if (!spot.field) return resolveInText(spot.node, found, r.text.length);
          const f = spot.field;
          if (inSensitive(f)) return { masked: true };
          return { el: describe(f), sentence: sentenceIn(f.value, found, r.text.length, langOf(f)) };
        }
        return null;
      });
      return { verified: at.filter(Boolean).length, matches };
    };
    const q = fold(text);
    let excluded = 0;
    for (const el of deepAll(document, "input, textarea, [autocomplete]")) {
      if (!sensitive(el)) continue;
      excluded += occurrences(fold(el.localName === "input" || el.localName === "textarea" ? el.value : el.textContent), q);
    }
    for (const t of K.ownTexts?.() ?? []) excluded += occurrences(fold(t), q);
    return { ...self(), groups: groups.map(resolveGroup), excluded };
  }

  // Readability's article (vendor/readability.js, run in this world by the background first),
  // weighed against the page's headlines and links the way an earlier extension did: on an index page the
  // headlines are the content and outweigh the block Readability scrapes.
  const SHORT_ARTICLE = 250;
  const SOME_HEADLINES = 5;
  function article() {
    const lib = Object.hasOwn(globalThis, "ReadabilityLib") ? globalThis.ReadabilityLib : null;
    if (!lib) return { ...self(), error: "Readability is not loaded in this frame" };
    let art = null;
    try {
      art = new lib.Readability(shownCopy(), { serializer: (el) => el }).parse();
    } catch (e) {
      return { ...self(), article: false, why: `Readability failed: ${e.message}` };
    }
    const body = clean(art?.textContent);
    const seen = new Set();
    let headlines = 0;
    let chars = 0;
    for (const el of document.querySelectorAll("h1, h2, h3, h4, a[href]")) {
      const t = clean(el.textContent);
      if (t.length < 12 || t.length > 300 || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      headlines++;
      chars += t.length;
    }
    if (!body) return { ...self(), article: false, why: "Readability found no article" };
    if (body.length < SHORT_ARTICLE) return { ...self(), article: false, why: `the article Readability found has ${body.length} characters, fewer than ${SHORT_ARTICLE}` };
    if (body.length < chars && headlines >= SOME_HEADLINES) {
      return { ...self(), article: false, why: `the page's ${headlines} headlines and links (${chars} characters) outweigh the article Readability found (${body.length} characters)` };
    }
    return { ...self(), article: true, title: clean(art.title) || clean(document.title) || null, byline: clean(art.byline) || null, lang: art.lang || null, blocks: articleBlocks(art.content), left_out: leftOut(body) };
  }

  // A copy of the document for Readability without what the page does not show: Readability
  // judges visibility by inline styles and attributes only, so the body is walked with its copy
  // in lockstep and an element without a box (display: none by a stylesheet) goes, as does the
  // text directly in an element with visibility: hidden (its children decide for themselves).
  // The head, scripts and styles stay for Readability's metadata; Kai's own elements go.
  function shownCopy() {
    const copy = document.cloneNode(true);
    const prune = (live, twin) => {
      const lk = [...live.childNodes];
      const tk = [...twin.childNodes];
      const hidden = live.nodeType === Node.ELEMENT_NODE && getComputedStyle(live).visibility !== "visible";
      for (let i = 0; i < lk.length && i < tk.length; i++) {
        const l = lk[i];
        if (l.nodeType === Node.TEXT_NODE) {
          if (hidden) tk[i].remove();
          continue;
        }
        if (l.nodeType !== Node.ELEMENT_NODE || NOT_TEXT.has(l.localName)) continue;
        if (K.own.has(l) || !rendered(l)) tk[i].remove();
        else prune(l, tk[i]);
      }
    };
    prune(document.documentElement, copy.documentElement);
    return copy;
  }

  // The article's blocks, by tag (Readability's copy has no layout to ask): headings with the ref
  // of the live heading of the same text, list items, rows with their cells tab-separated.
  const BLOCK_TAGS = /^(address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p|pre|section|table|thead|tbody|tfoot|tr|ul|caption|summary)$/;
  function articleBlocks(root) {
    const out = [];
    // The page's headings by text, each a queue in tree order: an article heading takes the
    // first one of its text not taken yet.
    const live = new Map();
    for (const h of deepAll(document, HEADINGS)) {
      const t = clean(h.textContent);
      if (!live.has(t)) live.set(t, []);
      live.get(t).push(h);
    }
    let buf = "";
    let meta = {};
    const flush = () => {
      const text = buf.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
      if (text) out.push({ text, ...meta });
      buf = "";
    };
    const visit = (node, pre) => {
      if (node.nodeType === Node.TEXT_NODE) {
        let t = node.data;
        if (!pre) {
          t = t.replace(/[ \t\n\r\f]+/g, " ");
          if (!buf || /[ \n\t]$/.test(buf)) t = t.replace(/^ /, "");
        }
        buf += t;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.localName;
      if (tag === "br") {
        buf += "\n";
        return;
      }
      if ((tag === "td" || tag === "th") && buf && !buf.endsWith("\t")) buf += "\t";
      if (!BLOCK_TAGS.test(tag)) {
        for (const c of node.childNodes) visit(c, pre || tag === "pre");
        return;
      }
      flush();
      const saved = meta;
      meta = {};
      const h = /^h([1-6])$/.exec(tag);
      if (h) {
        // The page's heading gives the level (Readability turns an h1 into an h2).
        const match = live.get(clean(node.textContent))?.shift();
        meta = match ? { heading: K.levelOf(match), local: localOf(match) } : { heading: Number(h[1]) };
      } else if (tag === "li") meta = { item: true };
      for (const c of node.childNodes) visit(c, pre || tag === "pre");
      flush();
      meta = saved;
    };
    visit(root, false);
    flush();
    return out;
  }

  // What Readability left out of the live page, by kind: each element of a kind (the outermost)
  // that is shown and whose text the article does not contain; and the frames, whose text it
  // never reads.
  const LEFT_OUT = [
    ["navigation", "nav, [role=navigation]", "navigation"],
    ["banner", "header, [role=banner]", "banner"],
    ["contentinfo", "footer, [role=contentinfo]", "contentinfo"],
    ["complementary", "aside, [role=complementary]", "complementary"],
    ["comments", "[id*=comment i], [class*=comment i]", null],
    ["form", "form, [role=form], [role=search]", null],
  ];
  // Texts are compared without white space: the article's text and an element's innerText break
  // lines and space blocks differently.
  function leftOut(body) {
    const out = {};
    const bare = (t) => t.replace(/\s+/g, "");
    const article = bare(body);
    for (const [kind, sel, role] of LEFT_OUT) {
      let n = 0;
      for (const el of deepAll(document, sel)) {
        if (role && roleOf(el) !== role) continue;
        if (el.parentElement?.closest(sel) || !el.checkVisibility({ visibilityProperty: true })) continue;
        const t = bare(el.innerText);
        if (t && !article.includes(t)) n++;
      }
      if (n) out[kind] = n;
    }
    let frames = 0;
    for (const el of deepAll(document, FRAME_SEL)) if (framePlaceholder(el)) frames++;
    if (frames) out.frames = frames;
    return out;
  }

  const element = (local) => {
    const r = K.element(local);
    return r.gone ? { gone: r.gone } : null;
  };

  Object.assign(K, { stateOf, ancestry });

  Object.assign(K.handlers, {
    outline: () => outline(),
    controls: ({ view }) => collect({ kind: "controls", view }),
    links: () => collect({ kind: "links", view: false }),
    fields: () => collect({ kind: "fields", view: false }),
    // page_title: the document's title as it is read (the sidebar heads an attached page with it).
    text: ({ view }) => ({ ...self(), page_title: document.title, viewport: viewport(), blocks: textBlocks(document, { inView: !!view }) }),
    element_text: ({ local }) => {
      const gone = element(local);
      if (gone) return gone;
      const el = K.element(local).el;
      const heading = el.matches(HEADINGS);
      const blocks = heading ? textBlocks(document, { from: el, headingLevel: K.levelOf(el) }) : textBlocks(el);
      return { ...self(), el: describe(el), shown: el.checkVisibility({ visibilityProperty: true }), section: heading, blocks };
    },
    table: ({ local }) => {
      const gone = element(local);
      if (gone) return gone;
      const el = K.element(local).el;
      const t = tableOf(el);
      if (!t) return { ...self(), el: describe(el), table: null };
      return { ...self(), el: describe(el), table: { ...describe(t), ...tableModel(t) } };
    },
    selection: () => selectionAnswer(),
    find_resolve: (m) => findResolve(m),
    article: () => ({ ...article(), page_title: document.title }),
    // The `title` of every frame element with a child frame, rendered or not.
    frame_titles: () => ({ titles: [...deepAll(document, FRAME_SEL)].map((el) => [K.childFrame(el), el.getAttribute("title") || ""]).filter(([id]) => id !== null) }),
  });
})();

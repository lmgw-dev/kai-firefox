// Kai for Firefox's content script, part 7 (after page.js): the page's changes worth announcing
// (design §7.1), reported to the background while Kai has events on and this frame's tab is the
// user's tab (events.js tells it): a live region that spoke (`live`), a field that turned invalid
// or whose error text appeared (`field_error`), a modal dialog that opened or closed (`dialog`),
// and the focus moving (`focus`). Nothing is watched while events are off.
//
// - Watching starts once the document is parsed: changes while a page loads are not reported, as
//   screen readers stay quiet then.
// - A live region (aria-live polite or assertive, or the roles alert, status and log) is reported
//   once it has been quiet for quiet_ms: an atomic one (aria-atomic, or alert and status) with its
//   whole text, another with the text the page added or changed in it. aria-relevant decides
//   which changes count; aria-busy holds them until the region is no longer busy; aria-hidden
//   text says nothing. A region the page inserts is not reported, except an alert. A change of
//   attributes alone (hidden, a class) reports what it showed that was not shown before, and does
//   not put off a wait already under way. A region's event says what it is about (`name`): its
//   accessible name, an <output>'s controls' names, or the nearest labelled ancestor's name.
// - A field is reported quiet_ms after it turned invalid or its error text changed.
// - One timer settles every region and field that is due, and what they say goes out together.
//   One message is in flight at a time; what comes meanwhile waits and goes in the next: a
//   waiting focus is replaced by a newer one, and a dialog's opening and closing that both wait
//   cancel out.
// - Sensitive fields' values are masked in every text and name an event carries (§5).
// - Mutations are watched in the document and in every shadow root there is when watching starts
//   or when its host is added.
// - `by_kai`: a change the event reports came while Kai acted in this tab (events.js says when).

(() => {
  const K = Object.hasOwn(globalThis, "kaiFirefoxContent") ? globalThis.kaiFirefoxContent : null;
  if (!K || K.off || K.listen) return;
  K.listen = true;
  const { describe, roleOf, nameOf, up, deepAll, textBlocks, textParent, rendered, originNow, FRAMES, scoped, maskAll, ariaHidden, ariaModalOpen, idRefs } = K;
  const ELEMENT = Node.ELEMENT_NODE;

  let on = false;
  let quiet = 0;
  // Kai acts in this tab now (an acting operation runs, or an input span is open).
  let acting = false;
  let observer = null;
  // Watching waits for the document to be parsed.
  let pending = false;

  // Its parent across shadow boundaries, for any node.
  const parentOf = (n) => n.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
  const inside = (outer, node) => {
    for (let e = node; e; e = parentOf(e)) if (e === outer) return true;
    return false;
  };
  // An element as events name it: its name masked like page text.
  const named = (el) => {
    const d = describe(el);
    d.name = maskAll(d.name);
    return d;
  };
  // An ancestor whose name says what the region inside it is about: one its author labelled
  // (aria-label, aria-labelledby), a fieldset with its legend, a figure with its caption. Names
  // computed from content (a button's, a link's) would repeat the region's own text.
  const labelledBox = (e) =>
    !!(e.getAttribute("aria-label")?.trim() || e.getAttribute("aria-labelledby")?.trim()) ||
    (e.localName === "fieldset" && !!e.querySelector(":scope > legend")) ||
    (e.localName === "figure" && !!e.querySelector(":scope > figcaption"));
  // What a live event calls its region (the contract's live `name`): its accessible name; for an
  // <output> without one, the names of the controls its `for` lists; else the name of the nearest
  // labelled ancestor. A slider's <output> says "3"; this says where. null: none of them.
  function regionName(region) {
    const own = nameOf(region);
    if (own) return { name: maskAll(own), name_from: "region" };
    if (region.localName === "output") {
      const names = idRefs(region, "for").map(nameOf).filter(Boolean);
      if (names.length) return { name: maskAll(names.join(", ")), name_from: "for" };
    }
    for (let e = up(region); e && e !== document.documentElement; e = up(e)) {
      if (!labelledBox(e)) continue;
      const n = nameOf(e);
      if (n) return { name: maskAll(n), name_from: "ancestor" };
    }
    return null;
  }

  // ---- the outbox ----
  let outbox = [];
  let sending = false;
  let flushTimer = 0;
  function post(e) {
    if (e.kind === "focus") outbox = outbox.filter((x) => x.kind !== "focus");
    else if (e.kind === "dialog") {
      const i = outbox.findIndex((x) => x.kind === "dialog" && x.dialog.local === e.dialog.local);
      if (i >= 0) {
        outbox.splice(i, 1);
        return;
      }
    }
    outbox.push(e);
    // After the task: what the page does in one task goes in one message.
    if (!sending && !flushTimer) flushTimer = setTimeout(flush, 0);
  }
  function flush() {
    flushTimer = 0;
    if (sending || !on || !outbox.length) return;
    const events = outbox;
    outbox = [];
    sending = true;
    const msg = { kai: "events", document: browser.runtime.getDocumentId(window), origin: originNow(), events, forget: K.collected.ids.splice(0) };
    browser.runtime
      .sendMessage(msg)
      .catch(() => {})
      .finally(() => {
        sending = false;
        flush();
      });
  }

  // ---- the timer ----
  let timer = 0;
  let timerAt = Infinity;
  function arm(at) {
    if (timer && timerAt <= at) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(tick, Math.max(0, Math.ceil(at - performance.now())));
  }
  // The time of the batch of changes being looked at: every change of one batch waits from the
  // same moment, so the region and the field one change touched settle in the same tick.
  let batchAt = null;
  const wait = (d) => {
    d.due = (batchAt ?? performance.now()) + quiet;
    arm(d.due);
  };
  function tick() {
    timer = 0;
    timerAt = Infinity;
    if (!on) return;
    const now = performance.now();
    const fields = [...fieldDirty].filter(([, d]) => d.due <= now);
    const regions = [...dirty].filter(([, d]) => d.due <= now);
    scoped(() => {
      // Fields first: a field's error that is also a live region's text comes before that
      // region's event.
      for (const [f, d] of fields) {
        fieldDirty.delete(f);
        settleField(f, d);
      }
      for (const [r, d] of regions) {
        dirty.delete(r);
        settleRegion(r, d);
      }
    });
    let next = Infinity;
    for (const d of dirty.values()) next = Math.min(next, d.due);
    for (const d of fieldDirty.values()) next = Math.min(next, d.due);
    if (next < Infinity) arm(next);
  }

  // ---- live regions ----
  const LIVE_ROLES = { alert: "assertive", status: "polite", log: "polite" };
  const LIVE_SEL = "[aria-live], [role], output";
  function politeness(el) {
    const live = el.getAttribute?.("aria-live");
    if (live === "polite" || live === "assertive") return live;
    if (live === "off") return null;
    return LIVE_ROLES[roleOf(el)] ?? null;
  }
  const atomicOf = (el) => {
    const a = el.getAttribute("aria-atomic");
    if (a === "true" || a === "false") return a === "true";
    const role = roleOf(el);
    return role === "alert" || role === "status";
  };
  const RELEVANT = ["additions", "removals", "text"];
  const DEFAULT_RELEVANT = new Set(["additions", "text"]);
  const relevantOf = (el) => {
    const v = (el.getAttribute("aria-relevant") || "").trim().split(/\s+/);
    const set = new Set(v.includes("all") ? RELEVANT : v.filter((x) => RELEVANT.includes(x)));
    return set.size ? set : DEFAULT_RELEVANT;
  };
  const busy = (el) => {
    for (let e = el; e; e = up(e)) if (e.getAttribute("aria-busy") === "true") return true;
    return false;
  };
  // The nearest live region at or around a node, across shadow roots; `seen` keeps the answers
  // of one batch of changes by element.
  function regionOf(node, seen) {
    const path = [];
    let found = null;
    for (let e = node.nodeType === ELEMENT ? node : textParent(node); e; e = up(e)) {
      if (seen.has(e)) {
        found = seen.get(e);
        break;
      }
      path.push(e);
      if (politeness(e)) {
        found = e;
        break;
      }
    }
    for (const e of path) seen.set(e, found);
    return found;
  }

  // The lines of an element's shown text as page.text_all reads it (blocks joined by line
  // breaks), aria-hidden content left out.
  const linesOf = (el) =>
    ariaHidden(el)
      ? []
      : textBlocks(el, { a11y: true })
          .flatMap((b) => (b.text ? b.text.split("\n") : []))
          .filter(Boolean);
  // The shown text of a node: an element's lines; a text node's text when its parent shows.
  function shownText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const p = textParent(node);
      if (!p || !rendered(p) || getComputedStyle(p).visibility !== "visible" || ariaHidden(p)) return "";
      return node.data.replace(/\s+/g, " ").trim();
    }
    return node.nodeType === ELEMENT ? linesOf(node).join("\n") : "";
  }
  // The lines of `now` that `before` did not have, in order; a line there as often as before is
  // not new.
  function newLines(before, now) {
    const count = new Map();
    for (const l of before) count.set(l, (count.get(l) ?? 0) + 1);
    const out = [];
    for (const l of now) {
      const n = count.get(l) ?? 0;
      if (n > 0) count.set(l, n - 1);
      else out.push(l);
    }
    return out;
  }
  // The nodes of `nodes` still in `region` that no other of them holds, in the order they came.
  function outermost(region, nodes) {
    const out = new Set();
    for (const n of nodes) {
      if (!n.isConnected) continue;
      let within = n === region;
      let held = false;
      for (let e = parentOf(n); e && !within && !held; e = parentOf(e)) {
        if (e === region) within = true;
        else if (nodes.has(e)) held = true;
      }
      if (within && !held) out.add(n);
    }
    return out;
  }

  let known = new WeakSet(); // regions seen
  // region -> { lines: its shown lines when last read in full, with what it added since;
  // pushed: how many were added } (read in full again once more were added than were read).
  let last = new WeakMap();
  // region -> { due, added: Set<Node>, kept, structural, attrs, byKai }; due is Infinity while
  // the region is busy.
  const dirty = new Map();
  const seeRegion = (el) => {
    known.add(el);
    last.set(el, { lines: linesOf(el), pushed: 0 });
  };
  function regionChanged(region, node, kind) {
    if (kind !== "attrs" && !relevantOf(region).has(kind)) return;
    let d = dirty.get(region);
    if (d && kind === "attrs") {
      d.attrs = true;
      d.byKai ||= acting;
      return;
    }
    if (!d) dirty.set(region, (d = { due: 0, added: new Set(), kept: 0, structural: false, attrs: false, byKai: false }));
    if (kind === "attrs") d.attrs = true;
    else {
      d.structural = true;
      if (node) {
        d.added.add(node);
        // Nodes the page removed again, or that others hold, go once the set has doubled.
        if (d.added.size > 2 * Math.max(d.kept, 32)) {
          d.added = outermost(region, d.added);
          d.kept = d.added.size;
        }
      }
    }
    d.byKai ||= acting;
    wait(d);
  }
  function settleRegion(region, d) {
    if (!on || !region.isConnected) return;
    const level = politeness(region);
    if (!level) return;
    if (busy(region)) {
      d.due = Infinity;
      dirty.set(region, d);
      return;
    }
    const atomic = atomicOf(region);
    const before = last.get(region) ?? { lines: [], pushed: 0 };
    let text;
    if (atomic || d.attrs) {
      const whole = linesOf(region);
      last.set(region, { lines: whole, pushed: 0 });
      if (atomic) {
        text = whole.join("\n");
        if (!d.structural && text === before.lines.join("\n")) return;
      } else text = newLines(before.lines, whole).join("\n");
    } else {
      // What the page added; the whole region is not read.
      text = [...outermost(region, d.added)].map(shownText).filter(Boolean).join("\n");
      const lines = text ? text.split("\n") : [];
      before.lines.push(...lines);
      before.pushed += lines.length;
      last.set(region, before.pushed > before.lines.length - before.pushed ? { lines: linesOf(region), pushed: 0 } : before);
    }
    if (!text) return;
    post({ kind: "live", by_kai: d.byKai, region: named(region), ...regionName(region), politeness: level, atomic, text: maskAll(text) });
  }
  // An element that became a live region by its attributes is one from now on; one that became
  // an alert with text is announced, as an inserted alert is.
  function becameRegion(el) {
    if (known.has(el) || !politeness(el)) return;
    seeRegion(el);
    if (roleOf(el) === "alert" && last.get(el).lines.length) regionChanged(el, el, "additions");
  }
  // aria-busy went from `el`: the regions at or under it that it held say what changed meanwhile.
  function released(el) {
    if (el.getAttribute("aria-busy") === "true") return;
    for (const [r, d] of dirty) if (d.due === Infinity && inside(el, r)) wait(d);
  }

  // ---- fields ----
  const errorKey = new WeakMap(); // field -> what it last reported
  const fieldDirty = new Map(); // field -> { due, turned, native, byKai }
  const invalidNow = (el) => {
    const v = el.getAttribute("aria-invalid");
    return (v !== null && v !== "false") || el.matches?.(":user-invalid");
  };
  function fieldChanged(field, { turned = false, native = false } = {}) {
    let d = fieldDirty.get(field);
    if (!d) fieldDirty.set(field, (d = { due: 0, turned: false, native: false, byKai: false }));
    d.turned ||= turned;
    d.native ||= native;
    d.byKai ||= acting;
    wait(d);
  }
  function settleField(field, d) {
    if (!on || !field.isConnected) return;
    const nativeInvalid = d.native && field.validity && !field.validity.valid;
    const invalid = invalidNow(field) || nativeInvalid;
    const errorEls = idRefs(field, "aria-errormessage").filter((e) => shownText(e));
    const descEls = idRefs(field, "aria-describedby").filter((e) => shownText(e));
    let error = errorEls.map(shownText).join(" ");
    if (!error && (nativeInvalid || field.matches?.(":user-invalid"))) error = field.validationMessage || "";
    if (!invalid && !error) {
      errorKey.delete(field);
      return;
    }
    const description = descEls.map(shownText).join(" ");
    const key = `${error}\u0000${description}`;
    if (!d.turned && !d.native && errorKey.get(field) === key) return;
    errorKey.set(field, key);
    const out = { kind: "field_error", by_kai: d.byKai, field: named(field), error: error ? maskAll(error) : null };
    if (description && description !== error) out.description = maskAll(description);
    // The live regions the texts are in: Kai speaks such a region's own event and this one once.
    const seen = new Map();
    const regions = new Set();
    for (const e of [...errorEls, ...(out.description ? descEls : [])]) {
      const r = regionOf(e, seen);
      if (r) regions.add(r);
    }
    out.regions = [...regions].map(named);
    post(out);
  }
  // Which fields name an id in aria-errormessage or aria-describedby, per document or shadow
  // root: root -> id -> Set of fields; and field -> { root, ids } as indexed.
  const NAMING = "[aria-errormessage], [aria-describedby]";
  let byId = new Map();
  let idsOf = new WeakMap();
  function unindex(f) {
    const was = idsOf.get(f);
    if (!was) return;
    idsOf.delete(f);
    const m = byId.get(was.root);
    for (const id of was.ids) {
      const s = m?.get(id);
      s?.delete(f);
      if (s && !s.size) m.delete(id);
    }
    if (m && !m.size) byId.delete(was.root);
  }
  function index(f) {
    unindex(f);
    const ids = new Set(`${f.getAttribute("aria-errormessage") || ""} ${f.getAttribute("aria-describedby") || ""}`.split(/\s+/).filter(Boolean));
    if (!ids.size) return;
    const root = f.getRootNode();
    let m = byId.get(root);
    if (!m) byId.set(root, (m = new Map()));
    for (const id of ids) {
      let s = m.get(id);
      if (!s) m.set(id, (s = new Set()));
      s.add(f);
    }
    idsOf.set(f, { root, ids });
  }
  // The fields whose error or description is (in) the element `el`; `checked` keeps the elements
  // of one batch of changes already looked at, whose ancestors were too.
  function fieldsNaming(el, checked) {
    const out = [];
    const m = byId.get(el.getRootNode());
    if (!m) return out;
    for (let e = el; e && e.nodeType === ELEMENT && !checked.has(e); e = e.parentElement) {
      checked.add(e);
      if (!e.id) continue;
      for (const f of m.get(e.id) ?? []) {
        if (f.isConnected) out.push(f);
        else unindex(f);
      }
    }
    return out;
  }

  // ---- modal dialogs ----
  // Every <dialog> and element with aria-modal the document has had while watched; one that left
  // the page is dropped once it is not an open dialog of `modals`.
  const DIALOGISH = "dialog, [aria-modal]";
  let cands = new Set();
  let modals = new Map(); // open modal dialog -> its Element as it opened
  const modalNow = (el) => (el.localName === "dialog" && el.matches(":modal")) || ariaModalOpen(el);
  function openModals() {
    const out = [];
    for (const c of cands) {
      if (!c.isConnected) {
        if (!modals.has(c)) cands.delete(c);
      } else if (modalNow(c)) out.push(c);
    }
    return out;
  }
  let dialogCheck = false;
  function checkDialogs() {
    if (dialogCheck) return;
    dialogCheck = true;
    queueMicrotask(() => {
      dialogCheck = false;
      if (!on) return;
      scoped(() => {
        const next = new Map();
        for (const d of openModals()) next.set(d, modals.get(d) ?? null);
        for (const [d, el] of modals) if (!next.has(d)) post({ kind: "dialog", by_kai: acting, open: false, dialog: el });
        for (const [d, el] of next) {
          if (el) continue;
          const desc = named(d);
          next.set(d, desc);
          post({ kind: "dialog", by_kai: acting, open: true, dialog: desc });
        }
        modals = next;
      });
    });
  }

  // ---- mutations ----
  // The attributes that can open or close a dialog, show or hide a region's text or a field's
  // error, make a region, hold one, or name a field's error.
  const DIALOG_ATTRS = new Set(["open", "aria-modal", "role", "hidden", "style", "class", "inert", "aria-hidden"]);
  const SHOWING = new Set(["hidden", "style", "class", "aria-hidden"]);
  const WATCHED_ATTRS = [...DIALOG_ATTRS, "aria-live", "aria-busy", "aria-invalid", "aria-errormessage", "aria-describedby"];
  const WATCH_SEL = `${LIVE_SEL}, ${DIALOGISH}, ${NAMING}`;
  let observed = new WeakSet();
  function observe(root) {
    if (observed.has(root)) return;
    observed.add(root);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: WATCHED_ATTRS });
  }
  // Calls hit for every element at and under `root` (an element, a shadow root or the document)
  // that can be a region, a dialog or a field naming its error, into shadow roots, which get
  // observed; Kai's own elements left out.
  function scan(root, hit) {
    if (root.nodeType === ELEMENT) {
      if (K.own.has(root)) return;
      if (root.matches(WATCH_SEL)) hit(root);
      const own = root.openOrClosedShadowRoot;
      if (own) {
        observe(own);
        scan(own, hit);
      }
    }
    for (const el of root.querySelectorAll(WATCH_SEL)) if (!K.own.has(el)) hit(el);
    for (const el of root.querySelectorAll("*")) {
      const sr = el.openOrClosedShadowRoot;
      if (sr && !K.own.has(el)) {
        observe(sr);
        scan(sr, hit);
      }
    }
  }
  function onMutations(records) {
    if (!on) return;
    batchAt = performance.now();
    try {
      scoped(() => look(records));
    } finally {
      batchAt = null;
    }
  }
  function look(records) {
    // Regions the page added in this batch: seen now, reported only when they are alerts.
    const inserted = new Set();
    const seen = new Map();
    const checked = new Set();
    let dialogs = false;
    let removed = false;
    for (const r of records) {
      if (r.type !== "childList") continue;
      for (const n of r.removedNodes) {
        removed = true;
        if (n.nodeType !== ELEMENT || n.isConnected) continue;
        unindex(n);
        for (const f of deepAll(n, NAMING)) unindex(f);
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== ELEMENT || K.own.has(n) || !n.isConnected) continue;
        scan(n, (el) => {
          if (el.matches(DIALOGISH)) {
            cands.add(el);
            dialogs = true;
          }
          if (el.matches(NAMING)) index(el);
          if (!known.has(el) && politeness(el)) {
            inserted.add(el);
            seeRegion(el);
            if (roleOf(el) === "alert" && last.get(el).lines.length) regionChanged(el, el, "additions");
          }
        });
      }
    }
    // The dialogs' elements and every element around them, once per batch when needed.
    let around = null;
    const nearDialog = (t) => {
      if (!around) {
        around = new Set();
        for (const c of cands) if (c.isConnected) for (let e = c; e && !around.has(e); e = up(e)) around.add(e);
      }
      return around.has(t);
    };
    for (const r of records) {
      const target = r.target;
      if (target.nodeType === ELEMENT && K.own.has(target)) continue;
      if (r.type === "attributes") {
        const name = r.attributeName;
        if (name === "aria-modal" && target.hasAttribute("aria-modal") && !cands.has(target)) {
          cands.add(target);
          around = null;
          dialogs = true;
        } else if (DIALOG_ATTRS.has(name) && !dialogs && nearDialog(target)) dialogs = true;
        if (name === "aria-invalid") {
          if (invalidNow(target)) fieldChanged(target, { turned: r.oldValue === null || r.oldValue === "false" });
        } else if (name === "aria-errormessage" || name === "aria-describedby") {
          index(target);
          if (target.hasAttribute("aria-invalid")) fieldChanged(target);
        } else if (name === "aria-busy") released(target);
        if (name === "aria-live" || name === "role") becameRegion(target);
        if (SHOWING.has(name)) {
          const region = regionOf(target, seen);
          if (region && !inserted.has(region)) {
            if (!known.has(region)) seeRegion(region);
            regionChanged(region, target, "attrs");
          }
          for (const f of fieldsNaming(target, checked)) fieldChanged(f);
        }
        continue;
      }
      const region = regionOf(target, seen);
      if (region && !inserted.has(region)) {
        // A region not seen yet became one in this batch: its change counts.
        if (!known.has(region)) seeRegion(region);
        if (r.type === "characterData") regionChanged(region, target, "text");
        else {
          for (const n of r.addedNodes) if (n.nodeType !== ELEMENT || !K.own.has(n)) regionChanged(region, n, n.nodeType === ELEMENT ? "additions" : "text");
          if (r.removedNodes.length) regionChanged(region, null, "removals");
        }
      }
      const el = target.nodeType === ELEMENT ? target : textParent(target);
      if (el) for (const f of fieldsNaming(el, checked)) fieldChanged(f);
    }
    if (removed && !dialogs) for (const d of modals.keys()) if (!d.isConnected) dialogs = true;
    if (dialogs) checkDialogs();
  }

  // ---- events of the page ----
  const onInvalid = (e) => {
    if (on && e.target?.nodeType === ELEMENT) fieldChanged(e.target, { native: true });
  };
  const onLeave = (e) => {
    const el = e.composedPath?.()[0] ?? e.target;
    if (on && el?.nodeType === ELEMENT && el.matches?.(":user-invalid")) fieldChanged(el);
  };
  const onToggle = (e) => {
    if (on && e.target?.localName === "dialog") checkDialogs();
  };
  const onFocus = () => {
    if (!on) return;
    const el = K.focused();
    if (!el || el === document.body || el === document.documentElement || FRAMES.has(el.localName) || K.own.has(el)) return;
    scoped(() => post({ kind: "focus", by_kai: acting, element: named(el) }));
  };
  const PAGE_EVENTS = [
    ["invalid", onInvalid],
    ["focusout", onLeave],
    ["change", onLeave],
    ["toggle", onToggle],
    ["close", onToggle],
    ["focusin", onFocus],
  ];

  function begin() {
    pending = false;
    if (!on || observer) return;
    observer = new MutationObserver(onMutations);
    observed = new WeakSet();
    known = new WeakSet();
    last = new WeakMap();
    byId = new Map();
    idsOf = new WeakMap();
    cands = new Set();
    K.collected.keep = true;
    observe(document);
    scoped(() => {
      scan(document, (el) => {
        if (el.matches(DIALOGISH)) cands.add(el);
        if (el.matches(NAMING)) index(el);
        if (politeness(el)) seeRegion(el);
      });
      modals = new Map(openModals().map((d) => [d, named(d)]));
    });
    for (const [type, fn] of PAGE_EVENTS) addEventListener(type, fn, { capture: true, passive: true });
  }
  function end() {
    observer?.disconnect();
    observer = null;
    for (const [type, fn] of PAGE_EVENTS) removeEventListener(type, fn, { capture: true, passive: true });
    clearTimeout(timer);
    clearTimeout(flushTimer);
    timer = flushTimer = 0;
    timerAt = Infinity;
    dirty.clear();
    fieldDirty.clear();
    outbox = [];
    modals = new Map();
    cands = new Set();
    byId = new Map();
    K.collected.keep = false;
    K.collected.ids.length = 0;
  }
  function watch(next, ms, act) {
    const was = on;
    on = next;
    quiet = ms ?? quiet;
    acting = !!act;
    if (!on) {
      end();
      return { watching: false };
    }
    if (was && observer) return { watching: true };
    if (document.readyState === "loading") {
      if (!pending) {
        pending = true;
        document.addEventListener("DOMContentLoaded", begin, { once: true });
      }
    } else begin();
    return { watching: true };
  }

  // A page restored from the back-forward cache asks whether to watch: the tab may no longer be
  // the user's.
  addEventListener("pagehide", () => {
    if (!on) return;
    end();
    on = false;
  });
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    browser.runtime
      .sendMessage({ kai: "events_ask" })
      .then((a) => a && watch(!!a.on, a.quiet_ms, a.acting))
      .catch(() => {});
  });

  Object.assign(K.handlers, {
    events_watch: ({ on: next, quiet_ms, acting: act }) => watch(!!next, quiet_ms, act),
    events_acting: ({ acting: act }) => {
      acting = !!act;
      return {};
    },
  });
})();

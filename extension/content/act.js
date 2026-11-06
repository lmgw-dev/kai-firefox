// Kai for Firefox's content script, part 5 (after overlay.js): acting on this frame's document
// (design §5.4): press, fill, choose, check, file, focus, hover, drag, show, scroll and keys; the
// commit guard's page side (§6.4: the word list against what the target says, the submitter and
// the form's action, a form submit to another origin, an Enter in an editor); where the keyboard
// focus is, for the trusted path (§6.3); and masking the request bodies the network gate shows Kai.
//
// Its events are synthetic (isTrusted false): they grant no user activation, CSS :hover does not
// follow them, and they have no default actions besides the activation of a click (a link
// followed, a box checked, a form submitted). page.key carries out the defaults of a few keys
// itself (Enter, Space, Escape: below). Values are set through the native setters of this
// content script's view, which the page's own property overrides (React's value tracker) do not
// see, so the input events that follow read as a change.
//
// The handlers are async: between a press's button going down and up, before its click, between
// keys and before an answer reads the element again, the page runs a task, so state a framework
// commits in a microtask or a task is there when the guard looks again and when `took` is read.

(() => {
  const K = Object.hasOwn(globalThis, "kaiFirefoxContent") ? globalThis.kaiFirefoxContent : null;
  if (!K || K.off || K.act) return;
  K.act = true;
  const { describe, roleOf, nameOf, sensitive, focused, clipper, rectOf, viewport, up, deepAll, MASK, codePoints, stateOf, ancestry, hitTest, focusInfo, originNow, self, escapeRe, originOf, keyGates, aimGates } = K;

  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const fold = (s) => clean(s).toLowerCase();
  const fail = (code, message) => ({ error: { code, message } });
  // One task of the page's: what it queued meanwhile (a microtask, a timer) runs first.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  // An element with its value and states, as page.controls reports a control (a sensitive
  // field's value masked).
  function control(el) {
    const d = describe(el);
    return { ...d, ...stateOf(el, d.role, d.name, ancestry(el, K.modalElement()).ariaDisabled) };
  }

  // Why the user could not use the element now, or null: disabled, inert (inside `inert` or
  // outside an open modal dialog), or not shown.
  function refusal(el, ref, { shown = true } = {}) {
    const a = ancestry(el, K.modalElement());
    if (el.matches(":disabled") || a.ariaDisabled) return fail("disabled", `ref ${ref} is disabled`);
    if (a.inert || !a.inModal) return fail("inert", `ref ${ref} cannot be used now: it is inert${a.inModal ? "" : " (outside the open modal dialog)"}`);
    if (shown && !el.checkVisibility({ visibilityProperty: true })) return fail("not_shown", `ref ${ref} is not shown (display: none or visibility: hidden)`);
    return null;
  }
  const isShown = (el) => el.checkVisibility({ visibilityProperty: true });
  // A hidden native checkbox or radio is used through a <label> of it that is shown.
  const shownLabel = (el) => [...(el.labels ?? [])].find(isShown) ?? null;

  // Scrolls the element into view (centred) when no part of it is in view; whether it did.
  function intoView(el) {
    if (clipper()(el)) return false;
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    return true;
  }
  // The middle of the element's part in view (of its box when none is).
  function middle(el) {
    const r = clipper()(el) ?? rectOf(el.getBoundingClientRect());
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  const isActive = (el) => focused() === el;

  // Pointer and mouse events at point p of this frame's viewport.
  const NO_BUBBLE = new Set(["pointerenter", "pointerleave", "mouseenter", "mouseleave"]);
  function fire(el, type, p, extra = {}) {
    const init = { bubbles: !NO_BUBBLE.has(type), cancelable: !NO_BUBBLE.has(type), composed: true, view: window, clientX: p.x, clientY: p.y, button: 0, buttons: 0, detail: 0, ...extra };
    const pointer = type.startsWith("pointer") || type === "click";
    return el.dispatchEvent(pointer ? new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...init }) : new MouseEvent(type, init));
  }

  // The element the synthetic pointer is over, for the out and leave events of the next hover.
  let hovered = null; // WeakRef<Element>
  function hoverTo(el, p) {
    const last = hovered?.deref();
    const was = last?.isConnected ? last : null;
    if (was && was !== el) for (const t of ["pointerout", "pointerleave", "mouseout", "mouseleave"]) fire(was, t, p, { relatedTarget: el });
    if (was !== el) for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter"]) fire(el, t, p, { relatedTarget: was });
    fire(el, "pointermove", p);
    fire(el, "mousemove", p);
    hovered = new WeakRef(el);
  }
  // A press of the primary button: the pointer and mouse events, then the click, whose activation
  // follows a link, checks a box or submits a form. The page runs a task after the button goes
  // down and after it goes up. A press whose element a handler removed meanwhile stops: its
  // replacement is not pressed ({ stopped: "removed" }). `check` is the commit guard's second
  // look right before the click: verdicts stop the press ({ guard }). null: it clicked.
  async function click(el, p, check = () => []) {
    hoverTo(el, p);
    if (!el.isConnected) return { stopped: "removed" };
    fire(el, "pointerdown", p, { buttons: 1, detail: 1 });
    if (el.isConnected) fire(el, "mousedown", p, { buttons: 1, detail: 1 });
    await tick();
    if (!el.isConnected) return { stopped: "removed" };
    fire(el, "pointerup", p, { detail: 1 });
    if (el.isConnected) fire(el, "mouseup", p, { detail: 1 });
    await tick();
    if (!el.isConnected) return { stopped: "removed" };
    const v = check();
    if (v.length) return { guard: v };
    fire(el, "click", p, { detail: 1 });
    return null;
  }
  // The click a key gives (Enter on a link or button, Space on a button or box): no pointer.
  const keyClick = (el) => el.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, pointerType: "", pointerId: -1, detail: 0 }));

  const KEYS = {
    Enter: ["Enter", 13],
    Escape: ["Escape", 27],
    " ": ["Space", 32],
    ArrowRight: ["ArrowRight", 39],
    ArrowLeft: ["ArrowLeft", 37],
    ArrowUp: ["ArrowUp", 38],
    ArrowDown: ["ArrowDown", 40],
    PageUp: ["PageUp", 33],
    PageDown: ["PageDown", 34],
    Home: ["Home", 36],
    End: ["End", 35],
  };
  const keyInit = (key, mods = {}) => {
    const [code, keyCode] = KEYS[key] ?? (/^[a-z]$/i.test(key) ? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)] : /^[0-9]$/.test(key) ? [`Digit${key}`, key.charCodeAt(0)] : ["", 0]);
    return { key, code, keyCode, bubbles: true, cancelable: true, composed: true, view: window, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta };
  };
  const keyDownUp = (el, key) => {
    el.dispatchEvent(new KeyboardEvent("keydown", keyInit(key)));
    el.dispatchEvent(new KeyboardEvent("keyup", keyInit(key)));
  };

  // ---- the commit guard's page side -------------------------------------------------------

  const ACTIVATES = "button, input, a[href], area[href], label, summary";
  // The element a press activates: itself, or the nearest ancestor that is a button, an input, a
  // link, a label or a summary (a press on a button's icon presses the button).
  function activationTarget(el) {
    for (let e = el; e; e = up(e)) if (e.matches?.(ACTIVATES)) return e;
    return el;
  }
  const isSubmitButton = (b) => (b.localName === "button" && b.type === "submit") || (b.localName === "input" && (b.type === "submit" || b.type === "image"));
  const resolve = (u) => {
    try {
      return new URL(u ?? "", document.baseURI).href;
    } catch {
      return null;
    }
  };
  // What submitting `form` with `submitter` (null: implicit submission without a button) sends
  // where. Attributes, not the properties a field named "action" or "method" would shadow.
  function submission(form, submitter) {
    const fa = submitter?.hasAttribute("formaction") ? submitter.getAttribute("formaction") : form.getAttribute("action");
    const fm = (submitter?.hasAttribute("formmethod") ? submitter.getAttribute("formmethod") : form.getAttribute("method")) || "get";
    const method = ["get", "post", "dialog"].includes(fm.toLowerCase()) ? fm.toLowerCase() : "get";
    return { form, submitter, action: resolve(fa), method };
  }
  // The submission a press of `el` makes, or null.
  function submitOf(el) {
    let t = activationTarget(el);
    if (t.localName === "label" && t.control) t = t.control;
    return isSubmitButton(t) && t.form ? submission(t.form, t) : null;
  }

  // A word of `words` in `text`, or null. Both are NFKC-normalised without default-ignorable code
  // points (soft hyphens, zero-width spaces), case ignored. A word of four or more letters matches
  // anywhere ("kauf" in "Einkaufen", "bestell" in "Zahlungspflichtig bestellen"); a shorter one
  // where it starts a word: the character before is no letter or digit, or a lower-case letter
  // before a capital ("buy" in "QuickBuy", not in "Ebuy").
  const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
  const WORD_CHAR = /[\p{L}\p{N}]/u;
  function wordIn(text, words) {
    const t = norm(text)
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
      .toLowerCase();
    for (const w of words) {
      const lw = norm(w).trim().toLowerCase();
      if (!lw) continue;
      const inside = [...lw].length >= 4;
      for (let i = t.indexOf(lw); i >= 0; i = t.indexOf(lw, i + 1)) if (inside || i === 0 || !WORD_CHAR.test(t[i - 1])) return w.trim();
    }
    return null;
  }
  // The part of an action URL the words are matched against: its path, query and fragment,
  // decoded (its host is the cross-origin rule's).
  function actionText(url) {
    try {
      const u = new URL(url);
      const rest = u.pathname + u.search + u.hash;
      try {
        return decodeURIComponent(rest.replace(/\+/g, " "));
      } catch {
        return rest;
      }
    } catch {
      return url ?? "";
    }
  }

  const BUTTONS = new Set(["submit", "reset", "button", "image"]);
  // What an element says about itself, where the guard looks: its accessible name, the text it
  // shows (an aria-label can say one thing and the text another), a button's value and its title.
  function textsOf(x) {
    const out = [["name", nameOf(x)]];
    if (typeof x.innerText === "string") out.push(["text", K.masked(clean(x.innerText), x)]);
    if ((x.localName === "button" || (x.localName === "input" && BUTTONS.has(x.type))) && !sensitive(x)) out.push(["value", x.value ?? ""]);
    out.push(["title", x.getAttribute("title") ?? ""]);
    return out;
  }
  function wordVerdict(x, words, where = null) {
    for (const [w0, text] of textsOf(x)) {
      const word = wordIn(text, words);
      if (word) return { reason: "word", word, where: where ?? w0, text };
    }
    return null;
  }

  // A link whose activation loads another document by GET (an http, https or file URL that is
  // not this document with another fragment): it commits nothing by itself, so the guard's words
  // do not apply to it ("Order now" that opens the order form); what the page it loads sends goes
  // through the network gate, as does a GET to a site the user never visited. A link to a fragment
  // of this document, a javascript: URL, or an element that only plays a link's role acts through
  // the page's script, and the words apply.
  function loadsByGet(t) {
    if (!t || (t.localName !== "a" && t.localName !== "area") || !t.hasAttribute("href")) return false;
    let u;
    try {
      u = new URL(t.href);
    } catch {
      return false;
    }
    if (!/^(https?|file):$/.test(u.protocol)) return false;
    const here = new URL(document.URL);
    return !(u.origin === here.origin && u.pathname === here.pathname && u.search === here.search);
  }

  // Attributes by which a page's script or a framework acts on a link's click instead of (or
  // before) the browser loading its href: inline handlers, Rails' and Turbo's methods, Rails UJS's
  // remote links, htmx, Phoenix LiveView, AngularJS, Alpine and Vue.
  const SCRIPT_MARKERS = ["onclick", "onmousedown", "onmouseup", "onpointerdown", "onpointerup", "onauxclick", "data-method", "data-turbo-method", "data-remote", "phx-click", "ng-click", "@click", "v-on:click"];
  const HANDLER_PROPS = ["onclick", "onmousedown", "onmouseup", "onpointerdown", "onpointerup", "onauxclick"];
  const marked = (e) => SCRIPT_MARKERS.some((a) => e.hasAttribute(a)) || [...e.attributes].some((a) => a.name.startsWith("hx-"));
  // A press handler the page set as a property (el.onclick = …): visible through the page's own
  // view of the element. Listeners added by addEventListener are not: Firefox gives content
  // scripts no way to list them.
  function handlerSet(e) {
    try {
      const page = e.wrappedJSObject ?? e;
      return HANDLER_PROPS.some((p) => typeof page[p] === "function");
    } catch {
      return false;
    }
  }
  // Whether the words still apply to a link that loads another document by GET (design §6.4, item
  // 30 as narrowed): its href's path or query holds a word of the guard's, it carries a script
  // marker, or a press handler the extension can see is set on it or an ancestor up to the
  // document. A page that commits by script (preventDefault, then a beacon) and shows none of
  // these is not seen.
  function scripted(t, words) {
    let u;
    try {
      u = new URL(t.href);
    } catch {
      return true;
    }
    let rest = u.pathname + u.search;
    try {
      rest = decodeURIComponent(rest.replace(/\+/g, " "));
    } catch {
      /* kept as it is */
    }
    if (wordIn(rest, words)) return true;
    if (marked(t)) return true;
    for (let e = t; e; e = up(e)) if (handlerSet(e)) return true;
    return handlerSet(document);
  }
  // A link the words do not apply to: one that loads another document by GET and does not act by
  // script as far as the extension can see (`scripted`).
  const plainLink = (t, words) => loadsByGet(t) && !scripted(t, words);

  // Where a press of `el` takes the tab when it activates a link that loads another document by
  // GET (loadsByGet) or submits a form: { by: "link" | "submit", origin } with the link's or the
  // form action's origin (null when it has none), or null. Kai counts a press as the owner's move
  // only where the tab lands on this origin (design §6.4).
  const submitGoes = (sub) => (sub && sub.method !== "dialog" && sub.action && /^(https?|file):/i.test(sub.action) ? { by: "submit", origin: originOf(sub.action) } : null);
  function goesOf(el) {
    const sub = submitOf(el);
    if (sub) return submitGoes(sub);
    const t = activationTarget(el);
    return loadsByGet(t) ? { by: "link", origin: originOf(t.href) } : null;
  }

  // Why the commit guard asks, in this order, each at most once: a word in what the pressed
  // element or the element its press activates says (`where` "name", "text", "value" or
  // "title"), unless that is a plain link (plainLink); in what a submit's button says
  // ("submitter"), in its action URL ("form_action"); a submit to another origin; an Enter in an
  // editor.
  function verdictsOf({ pressed = null, sub = null, editor = null }, words) {
    const out = [];
    const t = pressed ? activationTarget(pressed) : null;
    if (pressed && !plainLink(t, words)) {
      const v = wordVerdict(pressed, words) ?? (t !== pressed ? wordVerdict(t, words) : null);
      if (v) out.push(v);
    }
    if (sub && sub.method !== "dialog" && sub.action) {
      if (sub.submitter && sub.submitter !== pressed && sub.submitter !== t) {
        const v = wordVerdict(sub.submitter, words, "submitter");
        if (v) out.push(v);
      }
      const w = wordIn(actionText(sub.action), words);
      if (w) out.push({ reason: "word", word: w, where: "form_action", text: sub.action });
      if (/^(https?|file):/i.test(sub.action) && originOf(sub.action) !== originNow()) {
        out.push({ reason: "cross_origin_submit", action: sub.action, origin: originOf(sub.action), method: sub.method });
      }
    }
    if (editor) out.push({ reason: "enter_in_editor", text: nameOf(editor) });
    return out;
  }
  // `confirmed`: the verdicts Kai asked the user about, as the guard answered them. A verdict is
  // confirmed when one of them has the same keys; those that are not, in order.
  const VERDICT_KEYS = ["reason", "word", "where", "text", "action", "origin", "method"];
  const same = (a, b) => VERDICT_KEYS.every((k) => (a[k] ?? null) === (b?.[k] ?? null));
  const unconfirmed = (verdicts, confirmed) => verdicts.filter((v) => !confirmed.some((c) => same(v, c)));

  // ---- press ------------------------------------------------------------------------------

  // A target name other than _self, _parent, _top or a frame of this document opens a window.
  function opensWindow(a) {
    const t = (a.getAttribute("target") ?? document.querySelector("base[target]")?.getAttribute("target") ?? "").trim().toLowerCase();
    if (!t || t === "_self" || t === "_parent" || t === "_top") return false;
    return t === "_blank" || ![...document.querySelectorAll("iframe[name], frame[name]")].some((f) => f.name.toLowerCase() === t);
  }
  // Elements that need a user gesture by their kind (design §6.3): a link that opens a window
  // (the popup blocker stops it otherwise), a file input (its picker), a media element (its
  // controls play sound or go full screen), a control named for full screen.
  function gestureKind(el) {
    const t = activationTarget(el);
    if ((t.localName === "a" || t.localName === "area") && t.hasAttribute("href") && opensWindow(t)) return "new_window";
    if (t.localName === "input" && t.type === "file") return "file_input";
    if (el.closest?.("video, audio")) return "media";
    if (/\b(full ?screen|vollbild)/i.test(nameOf(t))) return "fullscreen";
    return null;
  }
  const TRUSTED_SPACE = new Set(["checkbox", "radio", "switch"]);

  async function press(el, { ref, guard, confirmed, activate }) {
    const no = refusal(el, ref);
    if (no) return no;
    // The guard looks before anything reaches the page, and again right before the click: the
    // page's handlers of the pointer events may have renamed the element or changed its form.
    const check = () => (guard ? unconfirmed(verdictsOf({ pressed: el, sub: submitOf(el) }, guard.words), confirmed) : []);
    const first = check();
    if (first.length) return { guard: first, el: control(el) };
    const scrolled = intoView(el);
    el.focus({ preventScroll: true });
    // The key Kai's trusted press sends, and whether the element needs it by its kind.
    const kind = gestureKind(el);
    const key = TRUSTED_SPACE.has(roleOf(el)) || kind === "media" ? "Space" : "Enter";
    if (!activate || kind) {
      await tick();
      const result = { key, focused: isActive(el), scrolled };
      if (kind) result.needs_trusted = kind;
      const goes = goesOf(el);
      if (goes) result.goes = goes;
      return { acted: false, el: control(el), result };
    }
    const focusedNow = isActive(el);
    // Where the press goes, read with the guard's second look right before the click: a handler
    // of the pointer events may have changed the link or the form.
    let goes = null;
    const stop = await click(el, middle(el), () => {
      goes = goesOf(el);
      return check();
    });
    await tick();
    const result = { clicked: !stop, focused: focusedNow, scrolled };
    if (stop?.stopped) result.stopped = stop.stopped;
    if (!stop && goes) result.goes = goes;
    return { acted: true, el: control(el), result, ...(stop?.guard ? { guard: stop.guard } : {}) };
  }

  // ---- fill -------------------------------------------------------------------------------

  const NOT_FILLED = {
    checkbox: "a checkbox: element.check sets it",
    radio: "a radio button: element.choose picks it",
    file: "a file input: element.file gives it files",
    submit: "a button: element.press presses it",
    reset: "a button: element.press presses it",
    button: "a button: element.press presses it",
    image: "a button: element.press presses it",
    hidden: "a hidden input",
  };
  // Inputs whose value the browser takes as it is: no typing, an input and a change event.
  const AS_VALUE = new Set(["range", "number", "date", "time", "month", "week", "datetime-local", "color"]);
  const NUMERIC = new Set(["range", "number"]);
  const isCombo = (el) => roleOf(el) === "combobox" || /^(list|inline|both)$/.test((el.getAttribute("aria-autocomplete") || "").trim()) || el.hasAttribute("list");

  const input = (el, type, inputType, data) =>
    el.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: type === "beforeinput", composed: true, inputType, data }));

  // The value at once, through the native setter; `asText`: with beforeinput first (a page may
  // cancel it). A note when the page cancelled.
  function setValue(el, text, asText) {
    if (asText && !input(el, "beforeinput", "insertReplacementText", text)) return "the page cancelled the input (its beforeinput handler)";
    el.value = text;
    input(el, "input", "insertReplacementText", text);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return null;
  }

  // The bound of the keys element.fill presses: the call's start plus the setting keys_ms.
  const overTime = (keysMs) => `Kai for Firefox's setting keys_ms (${keysMs} ms)`;

  // One character at a time with the key events around each and a task of the page's between
  // them, so a combobox's suggestions follow; until `until`. A note when the time ran out.
  async function typeChars(el, text, until, keysMs) {
    if (el.value) {
      try {
        el.select();
      } catch {
        /* no selection in this input type */
      }
      if (input(el, "beforeinput", "deleteContentBackward", null)) {
        el.value = "";
        input(el, "input", "deleteContentBackward", null);
      }
      await tick();
    }
    let typed = 0;
    for (const ch of text) {
      if (Date.now() > until) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return `it typed ${typed} of ${codePoints(text)} characters within ${overTime(keysMs)}`;
      }
      const k = keyInit(ch);
      if (el.dispatchEvent(new KeyboardEvent("keydown", k)) && el.dispatchEvent(new KeyboardEvent("keypress", { ...k, charCode: ch.codePointAt(0) })) && input(el, "beforeinput", "insertText", ch)) {
        let done = false;
        try {
          const s = el.selectionStart;
          if (s !== null) {
            el.setRangeText(ch, s, el.selectionEnd, "end");
            done = true;
          }
        } catch {
          /* an input type without a caret: appended */
        }
        if (!done) el.value += ch;
        input(el, "input", "insertText", ch);
      }
      el.dispatchEvent(new KeyboardEvent("keyup", k));
      typed++;
      await tick();
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return null;
  }

  function editingHost(el) {
    let h = el;
    while (h.parentElement?.isContentEditable) h = h.parentElement;
    return h;
  }
  const editorText = (host) => host.innerText;

  // An ARIA slider or spin button: keys until aria-valuenow is the number, a task of the page's
  // after each (a widget may commit its value in a microtask). Home and End for a number at an
  // end; Page Up or Page Down while the number is at least one of their steps away (tried once it
  // is ten arrow steps away); the arrows for the rest. It stops when an arrow does not move the
  // value, moves it away or passes the number, or at `until` (`note` says which).
  async function arrows(el, ref, text, until, keysMs) {
    const num = (a) => {
      const v = el.getAttribute(a);
      return v === null || !v.trim() ? null : Number(v);
    };
    const min = num("aria-valuemin");
    const max = num("aria-valuemax");
    const span = min !== null || max !== null ? ` from ${min ?? "any"} to ${max ?? "any"}` : "";
    const target = Number(text.trim());
    if (!text.trim() || !Number.isFinite(target) || (min !== null && target < min) || (max !== null && target > max)) {
      return { error: fail("bad_value", `ref ${ref} is a ${roleOf(el)} and takes a number${span}, not '${text}'`).error };
    }
    el.focus({ preventScroll: true });
    const now = () => num("aria-valuenow");
    if (now() === null) return { note: "it has no aria-valuenow, so its value cannot be read" };
    const key = async (k) => {
      keyDownUp(el, k);
      await tick();
      return now();
    };
    if (target === min && now() !== target) await key("Home");
    else if (target === max && now() !== target) await key("End");
    let v = now();
    let arrowStep = null;
    let pageStep = null;
    let pages = true;
    while (v !== target) {
      if (Date.now() > until) return { note: `it did not reach ${target} within ${overTime(keysMs)}: it is at ${v}` };
      const upward = v < target;
      if (pages && arrowStep !== null && Math.abs(target - v) >= (pageStep ?? arrowStep * 10)) {
        const w = await key(upward ? "PageUp" : "PageDown");
        if (w === null || w === v || (upward ? w < v : w > v)) pages = false;
        else if (upward ? w > target : w < target) pages = false;
        else pageStep = Math.abs(w - v);
        if (w !== null) v = w;
        continue;
      }
      let w = await key(upward ? "ArrowRight" : "ArrowLeft");
      if (w === v) w = await key(upward ? "ArrowUp" : "ArrowDown");
      if (w === v || w === null) return { note: "its value did not change with the arrow keys" };
      if (upward ? w < v : w > v) return { note: "the arrow keys moved its value away from the number" };
      if (upward ? w > target : w < target) return { note: `its steps pass ${target}: one key took it from ${v} to ${w}` };
      arrowStep = Math.abs(w - v);
      v = w;
    }
    return {};
  }

  async function fill(el, { ref, text, until, keys_ms: keysMs }) {
    const no = refusal(el, ref);
    if (no) return no;
    const tag = el.localName;
    const role = roleOf(el);
    if (((tag === "input" || tag === "textarea") && el.readOnly) || el.getAttribute("aria-readonly") === "true") return fail("readonly", `ref ${ref} is read-only`);
    const field = tag === "input" || tag === "textarea";
    const type = tag === "textarea" ? "textarea" : el.type;
    if (field && NOT_FILLED[type]) return fail("not_fillable", `ref ${ref} is ${NOT_FILLED[type]}`);
    if (tag === "select") return fail("not_fillable", `ref ${ref} is a select: element.choose picks its option`);
    if (!field && !el.isContentEditable && role !== "slider" && role !== "spinbutton") return fail("not_fillable", `ref ${ref} is no field (its role is ${role})`);
    const scrolled = intoView(el);
    let how;
    let note = null;
    let took;
    if (field) {
      el.focus({ preventScroll: true });
      if (AS_VALUE.has(type)) {
        how = "value";
        note = setValue(el, text, false);
        await tick();
        took = NUMERIC.has(type) ? el.value !== "" && Number(el.value) === Number(text) : el.value === text;
      } else if (isCombo(el)) {
        how = "keys";
        note = await typeChars(el, text, until, keysMs);
        await tick();
        took = el.value === text;
      } else {
        how = "value";
        note = setValue(el, text, true);
        await tick();
        took = el.value === text;
      }
    } else if (el.isContentEditable) {
      how = "editor";
      const host = editingHost(el);
      host.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(host);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      const ran = text ? document.execCommand("insertText", false, text) : document.execCommand("delete", false);
      await tick();
      took = fold(editorText(host)) === fold(text);
      if (!took) note = `the editor did not take the text${ran ? "" : " (Firefox refused the edit)"}; element.focus and then Kai's type_text type it the trusted way`;
    } else {
      how = "keys";
      const r = await arrows(el, ref, text, until, keysMs);
      if (r.error) return { error: r.error };
      note = r.note ?? null;
      await tick();
      took = Number(el.getAttribute("aria-valuenow")) === Number(text.trim());
    }
    const result = { how, took, scrolled };
    if (note) result.note = note;
    return { acted: true, el: control(el), result };
  }

  // ---- choose, check, file ----------------------------------------------------------------

  const noOption = (ref, labels, extra = "") =>
    ({ error: { code: "no_option", message: `ref ${ref} has no option of that label${extra}; its options are: ${labels.map((l) => `'${l}'`).join(", ") || "none"}`, options: labels } });

  // The radio buttons of the group `el` is or is in, or null.
  function radiosOf(el) {
    const role = roleOf(el);
    if (el.localName === "input" && el.type === "radio") {
      if (!el.name) return [el];
      const pool = el.form ? [...el.form.elements] : [...el.getRootNode().querySelectorAll("input[type=radio]")];
      return pool.filter((r) => r.localName === "input" && r.type === "radio" && r.name === el.name && (r.form ?? null) === (el.form ?? null));
    }
    let group = null;
    if (role === "radio") for (let e = up(el); e && !group; e = up(e)) if (roleOf(e) === "radiogroup") group = e;
    if (role === "radio" && !group) return [el];
    group ??= role === "radiogroup" || role === "group" || el.localName === "fieldset" ? el : null;
    if (!group) return null;
    const list = [...deepAll(group, "input[type=radio], [role=radio]")];
    return list.length ? list : null;
  }
  const isChecked = (r) => (r.localName === "input" ? r.checked : r.getAttribute("aria-checked") === "true");

  // The list box a combobox shows its options in (aria-controls, aria-owns), or null.
  function popupOf(el) {
    for (const id of K.idRefs(el, "aria-controls").concat(K.idRefs(el, "aria-owns"))) if (roleOf(id) === "listbox") return id;
    return null;
  }
  const optionsIn = (box) => [...deepAll(box, "[role=option]"), ...K.idRefs(box, "aria-owns").filter((o) => roleOf(o) === "option")];

  // Presses `el`, or the shown label of a hidden native checkbox or radio; false when neither is
  // shown.
  async function pressShown(el) {
    const via = isShown(el) ? el : el.localName === "input" ? shownLabel(el) : null;
    if (!via) return false;
    intoView(via);
    await click(via, middle(via));
    return true;
  }

  async function choose(el, { ref, option }) {
    const no = refusal(el, ref, { shown: false });
    if (no) return no;
    const want = fold(option);
    const role = roleOf(el);
    if (el.localName === "select") {
      const opts = [...el.options];
      const labels = opts.map((o) => clean(o.label));
      const i = labels.findIndex((l) => l.toLowerCase() === want);
      if (i < 0) return noOption(ref, labels);
      const o = opts[i];
      if (o.disabled || (o.parentElement?.localName === "optgroup" && o.parentElement.disabled)) return fail("disabled", `the option '${labels[i]}' of ref ${ref} is disabled`);
      intoView(el);
      el.focus({ preventScroll: true });
      if (el.multiple) o.selected = true;
      else el.selectedIndex = i;
      input(el, "input", "insertReplacementText", null);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
      return { acted: true, el: control(el), result: { chosen: labels[i], took: o.selected } };
    }
    if (el.localName === "input" && el.list) {
      const opts = [...el.list.options];
      const labels = opts.map((o) => clean(o.label || o.value));
      const i = labels.findIndex((l) => l.toLowerCase() === want);
      if (i < 0) return noOption(ref, labels);
      intoView(el);
      el.focus({ preventScroll: true });
      setValue(el, opts[i].value, true);
      await tick();
      return { acted: true, el: control(el), result: { chosen: labels[i], took: el.value === opts[i].value } };
    }
    const radios = radiosOf(el);
    if (radios) {
      const labels = radios.map((r) => nameOf(r));
      const i = labels.findIndex((l) => fold(l) === want);
      if (i < 0) return noOption(ref, labels);
      const r = radios[i];
      if (r.matches(":disabled") || ancestry(r, K.modalElement()).ariaDisabled) return fail("disabled", `the option '${labels[i]}' of ref ${ref} is disabled`);
      if (!isChecked(r) && !(await pressShown(r))) return fail("not_shown", `the option '${labels[i]}' of ref ${ref} is not shown, nor a label of it`);
      await tick();
      return { acted: true, el: control(el), result: { chosen: labels[i], took: isChecked(r) } };
    }
    const box = role === "listbox" ? el : role === "combobox" ? popupOf(el) : null;
    if (box) {
      const opts = optionsIn(box).filter(isShown);
      const labels = opts.map((o) => nameOf(o));
      const i = labels.findIndex((l) => fold(l) === want);
      if (i < 0) return noOption(ref, labels, role === "combobox" && !opts.length ? " (it shows no options now: fill it with the start of the text first, or press it to open its list)" : "");
      const o = opts[i];
      if (o.getAttribute("aria-disabled") === "true") return fail("disabled", `the option '${labels[i]}' of ref ${ref} is disabled`);
      intoView(o);
      await click(o, middle(o));
      await tick();
      const took = o.getAttribute("aria-selected") === "true" || (role === "combobox" && "value" in el && fold(el.value) === want);
      return { acted: true, el: control(el), result: { chosen: labels[i], took } };
    }
    return fail("not_choosable", `ref ${ref} is no select, list box, radio group or combobox`);
  }

  const CHECKABLE = new Set(["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio"]);
  async function check(el, { ref, on }) {
    const no = refusal(el, ref, { shown: false });
    if (no) return no;
    const role = roleOf(el);
    const native = el.localName === "input" && (el.type === "checkbox" || el.type === "radio");
    const toggle = !native && !CHECKABLE.has(role) && el.getAttribute("aria-pressed") !== null;
    if (!native && !CHECKABLE.has(role) && !toggle) return fail("not_checkable", `ref ${ref} is no checkbox, switch or toggle button`);
    const state = () => (native ? el.checked && !el.indeterminate : el.getAttribute(toggle ? "aria-pressed" : "aria-checked") === "true");
    if (state() === on) return { acted: false, el: control(el), result: { changed: false, took: true } };
    if (!on && (role === "radio" || role === "menuitemradio")) return fail("bad_value", `ref ${ref} is a radio button; it goes off when another option of its group is chosen (element.choose)`);
    if (!(await pressShown(el))) return fail("not_shown", `ref ${ref} is not shown, nor a label of it`);
    await tick();
    return { acted: true, el: control(el), result: { changed: true, took: state() === on } };
  }

  function bytesOf(b64) {
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function file(el, { ref, files }) {
    const target = el.localName === "input" && el.type === "file" ? el : el.localName === "label" && el.control?.localName === "input" && el.control.type === "file" ? el.control : null;
    if (!target) return fail("not_a_file_input", `ref ${ref} is no file input (nor a label of one)`);
    const no = refusal(target, ref, { shown: false });
    if (no) return no;
    if (files.length > 1 && !target.multiple) return fail("bad_value", `ref ${ref} takes one file, not ${files.length}`);
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([bytesOf(f.base64)], f.name, { type: f.type }));
    target.files = dt.files;
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    return { acted: true, el: control(target), result: { files: [...target.files].map((f) => ({ name: f.name, type: f.type, bytes: f.size })) } };
  }

  // ---- focus, hover, drag, show, scroll ---------------------------------------------------

  async function focusIt(el, { ref }) {
    const no = refusal(el, ref);
    if (no) return no;
    const scrolled = intoView(el);
    el.focus({ preventScroll: true });
    // The caret to the end.
    if (typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        /* an input type without a caret */
      }
    } else if (el.isContentEditable) {
      const r = document.createRange();
      r.selectNodeContents(editingHost(el));
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
    await tick();
    return { acted: true, el: control(el), result: { focused: isActive(el), scrolled } };
  }

  async function hover(el, { ref }) {
    const no = refusal(el, ref);
    if (no) return no;
    const scrolled = intoView(el);
    hoverTo(el, middle(el));
    await tick();
    return { acted: true, el: control(el), result: { hovered: true, scrolled } };
  }

  // Steps of the pointer between the source and the target of a pointer drag: libraries that
  // follow the pointer see it move, not jump.
  const DRAG_STEPS = 8;
  async function drag(el, { ref, to_local, to_ref }) {
    const t = K.element(to_local);
    if (t.gone) return fail("stale_element", `ref ${to_ref}'s element is no longer in the page`);
    const target = t.el;
    const no = refusal(el, ref) ?? refusal(target, to_ref);
    if (no) return no;
    intoView(el);
    if (!clipper()(target)) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const s = middle(el);
    const d = middle(target);
    const to = describe(target);
    hoverTo(el, s);
    fire(el, "pointerdown", s, { buttons: 1, detail: 1 });
    fire(el, "mousedown", s, { buttons: 1, detail: 1 });
    if (el.draggable) {
      const dt = new DataTransfer();
      const init = (p) => ({ bubbles: true, cancelable: true, composed: true, view: window, clientX: p.x, clientY: p.y, dataTransfer: dt });
      fire(el, "pointermove", { x: s.x + 5, y: s.y + 5 }, { buttons: 1 });
      if (!el.dispatchEvent(new DragEvent("dragstart", init(s)))) {
        fire(el, "pointerup", s);
        fire(el, "mouseup", s);
        await tick();
        return { acted: true, el: control(el), result: { how: "html5", dropped: false, note: "the page cancelled the drag (its dragstart handler)", to } };
      }
      fire(el, "pointercancel", s);
      el.dispatchEvent(new DragEvent("drag", init(s)));
      target.dispatchEvent(new DragEvent("dragenter", init(d)));
      const accepted = !target.dispatchEvent(new DragEvent("dragover", init(d)));
      target.dispatchEvent(new DragEvent(accepted ? "drop" : "dragleave", init(d)));
      el.dispatchEvent(new DragEvent("dragend", init(d)));
      await tick();
      const result = { how: "html5", dropped: accepted, to };
      if (!accepted) result.note = "the target did not accept the drop (its dragover handler did not cancel the event)";
      return { acted: true, el: control(el), result };
    }
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const p = { x: s.x + ((d.x - s.x) * i) / DRAG_STEPS, y: s.y + ((d.y - s.y) * i) / DRAG_STEPS };
      const over = hitTest(p.x, p.y) ?? target;
      fire(over, "pointermove", p, { buttons: 1 });
      fire(over, "mousemove", p, { buttons: 1 });
    }
    const over = hitTest(d.x, d.y) ?? target;
    fire(over, "pointerup", d);
    fire(over, "mouseup", d);
    await tick();
    return { acted: true, el: control(el), result: { how: "pointer", to } };
  }

  function show(el) {
    if (!isShown(el)) return { acted: false, el: describe(el), result: { scrolled: false, hidden: true } };
    return { acted: false, el: describe(el), result: { scrolled: intoView(el) } };
  }

  // The scroll container at or around `el` that can scroll up and down; null for the page itself
  // (page.scroll's).
  function scrollerOf(el) {
    for (let e = el; e; e = e.assignedSlot ?? up(e)) {
      if (e === document.documentElement || e === document.body) return null;
      const cs = getComputedStyle(e);
      if (/^(auto|scroll|overlay)$/.test(cs.overflowY) && e.scrollHeight > e.clientHeight) return e;
    }
    return null;
  }
  // A screen is the box's height less a tenth, which stays in view as Firefox's Page Down keeps a
  // strip of the last screen.
  function scrollBox(c, to) {
    const page = c === null;
    const h = page ? viewport().h : c.clientHeight;
    const max = page ? (document.scrollingElement ?? document.documentElement).scrollHeight - h : c.scrollHeight - c.clientHeight;
    const pos = () => (page ? scrollY : c.scrollTop);
    const box = page ? window : c;
    const before = pos();
    if (to === "top") box.scrollTo({ top: 0, behavior: "instant" });
    else if (to === "bottom") box.scrollTo({ top: max, behavior: "instant" });
    else box.scrollBy({ top: (to === "down" ? 1 : -1) * Math.round(h * 0.9), behavior: "instant" });
    const now = pos();
    return { scrolled: Math.abs(now - before) >= 1, percent: max > 0 ? Math.round((100 * now) / max) : 0, at_top: now <= 0.5, at_bottom: now >= max - 1 };
  }
  function scrollEl(el, { ref, to }) {
    const c = scrollerOf(el);
    if (!c) return fail("not_scrollable", `ref ${ref} is in no scroll container (page.scroll scrolls the page)`);
    return { acted: true, el: describe(c), result: scrollBox(c, to) };
  }

  // page.scroll: the page when it scrolls (its root and body do not hide its overflow), else the
  // scroll container under the middle of the view, where a wheel would scroll.
  function pageScroll({ to }) {
    const se = document.scrollingElement ?? document.documentElement;
    const hides = (e) => e && /^(hidden|clip)$/.test(getComputedStyle(e).overflowY);
    const rootVisible = getComputedStyle(document.documentElement).overflowY === "visible";
    const pageScrolls = se.scrollHeight - viewport().h > 0 && !hides(document.documentElement) && !(rootVisible && hides(document.body));
    if (pageScrolls) return { acted: true, container: null, result: scrollBox(null, to) };
    const vp = viewport();
    const hit = hitTest(vp.w / 2, vp.h / 2);
    const c = hit ? scrollerOf(hit) : null;
    if (!c) return { acted: false, container: null, result: { scrolled: false, scrollable: false, percent: 0, at_top: true, at_bottom: true } };
    return { acted: true, container: describe(c), result: scrollBox(c, to) };
  }

  // ---- keys -------------------------------------------------------------------------------

  // Inputs that submit their form on Enter when it has no submit button and they are its only
  // such field (HTML's implicit submission).
  const BLOCKS_IMPLICIT = new Set(["text", "search", "url", "tel", "email", "password", "date", "month", "week", "time", "datetime-local", "number"]);

  // What a key's default would do on `el`, carried out by page.key since synthetic keys have
  // none: { kind: "submit" | "click" | "close", ... } or null.
  function defaultOf(el, k) {
    if (k.ctrl || k.alt || k.meta) return null;
    const tag = el.localName;
    if (k.key === "Enter") {
      if (tag === "input" && BLOCKS_IMPLICIT.has(el.type) && el.form) {
        const form = el.form;
        const def = [...form.elements].find(isSubmitButton);
        if (def) return def.matches(":disabled") ? null : { kind: "submit", button: def, sub: submission(form, def) };
        const blocking = [...form.elements].filter((f) => f.localName === "input" && BLOCKS_IMPLICIT.has(f.type));
        return blocking.length === 1 ? { kind: "submit", button: null, sub: submission(form, null) } : null;
      }
      if (((tag === "a" || tag === "area") && el.hasAttribute("href")) || tag === "button" || tag === "summary" || (tag === "input" && BUTTONS.has(el.type))) {
        return { kind: "click", el, onUp: false };
      }
      return null;
    }
    if (k.key === " ") {
      if (tag === "button" || tag === "summary" || (tag === "input" && (BUTTONS.has(el.type) || el.type === "checkbox" || el.type === "radio"))) return { kind: "click", el, onUp: true };
      return null;
    }
    if (k.key === "Escape") {
      const dialog = [...deepAll(document, "dialog")].filter((d) => d.matches(":modal")).at(-1);
      if (dialog) return { kind: "close", dialog };
      const pop = [...deepAll(document, "[popover]")].filter((p) => !K.own.has(p) && p.matches(":popover-open") && p.popover === "auto").at(-1);
      if (pop) return { kind: "close", popover: pop };
    }
    return null;
  }

  // An Enter a page's own script may take as "send" (a chat box, a comment field): any Enter in an
  // editable element, except a plain one (no ctrl, alt or meta) in a text-like input of a form,
  // whose submit the guard reads from the form itself.
  function editorEnter(el, k) {
    if (k.key !== "Enter" || el.localName === "select") return false;
    const textInput = el.localName === "input" && BLOCKS_IMPLICIT.has(el.type);
    const editable = el.isContentEditable || el.localName === "textarea" || textInput || /^(textbox|searchbox|combobox)$/.test(roleOf(el));
    if (!editable) return false;
    return !(textInput && el.form && !k.ctrl && !k.alt && !k.meta);
  }

  // The guard's verdicts for key `k` on `el` as the page is now.
  function keyVerdicts(el, k, words) {
    const plan = defaultOf(el, k);
    const parts = { editor: editorEnter(el, k) ? el : null };
    if (plan?.kind === "submit") parts.sub = plan.sub;
    else if (plan?.kind === "click") Object.assign(parts, { pressed: plan.el, sub: submitOf(plan.el) });
    return verdictsOf(parts, words);
  }

  async function key({ key: k, guard, confirmed }) {
    const active = focused();
    const el = active && active !== document.documentElement ? active : document.body;
    const target = el && el !== document.body ? describe(el) : null;
    if (!el) return { acted: false, target: null, result: { prevented: false, emulated: null } };
    const check = () => (guard ? unconfirmed(keyVerdicts(el, k, guard.words), confirmed) : []);
    const first = check();
    if (first.length) return { guard: first, target };
    const init = keyInit(k.key, k);
    Object.assign(init, { code: k.code, keyCode: k.keyCode });
    const down = el.dispatchEvent(new KeyboardEvent("keydown", init));
    let pressedOk = true;
    if (down && k.charCode) pressedOk = el.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: k.charCode, keyCode: k.key === "Enter" ? 13 : 0 }));
    const upOk = el.dispatchEvent(new KeyboardEvent("keyup", init));
    await tick();
    // The default as the page is after its key handlers, looked at by the guard again.
    const plan = el.isConnected ? defaultOf(el, k) : null;
    let emulated = null;
    let goes = null;
    let late = [];
    if (plan && down && pressedOk && (!plan.onUp || upOk)) {
      if (plan.kind !== "close") late = check();
      if (late.length) {
        /* the guard asks now: the default is not carried out */
      } else if (plan.kind === "click" && plan.el.isConnected) {
        goes = goesOf(plan.el);
        keyClick(plan.el);
        emulated = "click";
      } else if (plan.kind === "submit" && plan.sub.form.isConnected) {
        goes = submitGoes(plan.sub);
        if (plan.button) keyClick(plan.button);
        else plan.sub.form.requestSubmit();
        emulated = "submit";
      } else if (plan.kind === "close" && plan.dialog) {
        if (typeof plan.dialog.requestClose === "function") plan.dialog.requestClose();
        else if (plan.dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) plan.dialog.close();
        emulated = "close";
      } else if (plan.kind === "close" && plan.popover) {
        plan.popover.hidePopover();
        emulated = "close";
      }
    }
    if (emulated) await tick();
    const result = { prevented: !down || !pressedOk, emulated };
    if (goes) result.goes = goes;
    return { acted: true, target, result, ...(late.length ? { guard: late } : {}) };
  }

  // ---- masking the network gate's bodies --------------------------------------------------

  // The values the sensitive fields had while a gate watched this document (gate id -> Set):
  // those of when it opened and those typed into them since, so a field the page clears before
  // it sends is masked all the same.
  const watched = new Map();
  const valueOf = (f) => ("value" in f && typeof f.value === "string" ? f.value : f.innerText);
  const track = (e) => {
    if (!watched.size) return;
    const t = e.composedPath?.()[0] ?? e.target;
    if (!(t instanceof Element) || !sensitive(t)) return;
    const v = valueOf(t);
    if (v) for (const s of watched.values()) s.add(v);
  };
  addEventListener("input", track, { capture: true, passive: true });
  addEventListener("change", track, { capture: true, passive: true });

  // The sensitive fields of this document: their names and their non-empty values.
  function secrets() {
    const names = new Set();
    const values = [];
    for (const f of deepAll(document, "input, [autocomplete]")) {
      if (!sensitive(f)) continue;
      if (f.getAttribute("name")) names.add(f.getAttribute("name"));
      const v = valueOf(f);
      if (v) values.push(v);
    }
    return { names, values };
  }
  // Text with every sensitive value masked: as typed, trimmed, URL-encoded and as JSON writes it.
  function maskText(s, values) {
    if (typeof s !== "string" || !values.length) return s;
    const forms = new Map();
    for (const v of values) {
      for (const f of [v, v.trim(), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1)]) if (f.trim()) forms.set(f, codePoints(v));
    }
    if (!forms.size) return s;
    const keys = [...forms.keys()].sort((a, b) => b.length - a.length);
    return s.replace(new RegExp(keys.map(escapeRe).join("|"), "g"), (m) => MASK(forms.get(m)));
  }
  function mask({ gate, body, url }) {
    const { names, values } = secrets();
    const all = [...new Set([...values, ...(watched.get(gate) ?? [])])];
    let b = body;
    if (b?.kind === "form") b = { ...b, fields: b.fields.map(([k, v]) => [k, names.has(k) ? MASK(codePoints(v)) : maskText(v, all)]) };
    else if (b && typeof b.text === "string") b = { ...b, text: maskText(b.text, all) };
    return { body: b, url: maskText(url, all), origin: originNow() };
  }

  // Kai's mark for its press through accessibility (element.mark).
  const MARK = "aria-kai-mark";

  const KINDS = { press, fill, choose, check, file, focus: focusIt, hover, drag, show, scroll: scrollEl };

  Object.assign(K.handlers, {
    act: async (m) => {
      const r = K.element(m.local);
      if (r.gone) return { gone: r.gone };
      return { ...(await KINDS[m.kind](r.el, m)), origin: originNow() };
    },
    act_state: ({ local }) => {
      const r = K.element(local);
      return r.gone ? { gone: r.gone } : { el: control(r.el) };
    },
    act_key: (m) => key(m),
    act_page_scroll: (m) => pageScroll(m),
    focus_where: () => ({ ...self(), has_focus: document.hasFocus(), focus: focusInfo() }),
    // A network gate opened on this document: the sensitive values it starts from (the background
    // masks a URL with them when this document cannot answer), and for a kept gate (focus.check,
    // gate.open) the trusted keydown and click it gets (kai.js), `aim` the local id of its element.
    gate_open: ({ gate, keys, aim }) => {
      const { values } = secrets();
      watched.set(gate, new Set(values));
      if (keys) keyGates.add(gate);
      if (keys && aim !== undefined && aim !== null) aimGates.set(gate, aim);
      return { values, origin: originNow() };
    },
    gate_end: ({ gate }) => {
      watched.delete(gate);
      keyGates.delete(gate);
      aimGates.delete(gate);
      return {};
    },
    // element.mark (design §6.3, WP12): the element carries `value` in MARK, an aria- attribute
    // Firefox gives the accessibility bus as an object attribute without its aria- (kai-mark), so
    // Kai finds this element there and no other. It changes nothing a page or a reader shows. The
    // mark goes again by itself `ttl_ms` later (the contract's MARK_TTL_MS), from every element
    // that carries it, should element.unmark not come.
    mark: ({ local, value, ttl_ms }) => {
      const r = K.element(local);
      if (r.gone) return { gone: r.gone };
      r.el.setAttribute(MARK, value);
      setTimeout(() => {
        for (const el of deepAll(document, `[${MARK}]`)) if (el.getAttribute(MARK) === value) el.removeAttribute(MARK);
      }, ttl_ms);
      return { url: location.href, origin: originNow(), el: describe(r.el) };
    },
    // element.unmark: the mark is taken away again, from the element and from any other element of
    // the document that carries it (a page that copied it).
    unmark: ({ value }) => {
      let removed = 0;
      for (const el of deepAll(document, `[${MARK}]`)) {
        if (el.getAttribute(MARK) !== value) continue;
        el.removeAttribute(MARK);
        removed += 1;
      }
      return { removed };
    },
    mask: (m) => mask(m),
  });
})();

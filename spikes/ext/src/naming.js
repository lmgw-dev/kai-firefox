// WP0 (f) throwaway content script: walk every interactive element of this frame, open and
// closed shadow roots included (element.openOrClosedShadowRoot, extensions only), compute role
// and accessible name with dom-accessibility-api, keep refs in a Map<number, WeakRef>.
// Bundled by build.mjs into ext/naming.bundle.js (one IIFE).
import { computeAccessibleName, getRole } from "dom-accessibility-api";

const INTERACTIVE = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]:not([tabindex='-1'])",
  ...["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "slider", "combobox", "textbox", "searchbox", "option", "spinbutton", "listbox", "treeitem", "gridcell"].map((r) => `[role=${r}]`),
].join(",");

let nextLocal = 1;
const refs = new Map(); // localId -> WeakRef<Element>
const idOf = new WeakMap(); // Element -> localId
function refFor(el) {
  let id = idOf.get(el);
  if (!id) {
    id = nextLocal++;
    idOf.set(el, id);
    refs.set(id, new WeakRef(el));
  }
  return id;
}

// Every interactive element of the document and of every shadow root under it.
function collect() {
  const out = [];
  const roots = [document];
  let shadowOpen = 0;
  let shadowClosed = 0;
  while (roots.length) {
    const root = roots.pop();
    for (const el of root.querySelectorAll("*")) {
      const sr = el.openOrClosedShadowRoot;
      if (sr) {
        if (el.shadowRoot) shadowOpen++;
        else shadowClosed++;
        roots.push(sr);
      }
      if (el.matches(INTERACTIVE)) out.push(el);
    }
  }
  return { els: out, shadowOpen, shadowClosed };
}

function inView(el, vw, vh) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
}

function describe(el, pseudo) {
  let role, name, err;
  try {
    role = getRole(el) || el.localName;
    // computedStyleSupportsPseudoElements: the library's default (false) is for jsdom; a real
    // browser resolves ::before/::after content, which the accname spec includes.
    name = computeAccessibleName(el, { computedStyleSupportsPseudoElements: pseudo });
  } catch (e) {
    err = String(e);
  }
  return { ref: refFor(el), role, name, err, expect: el.getAttribute("data-expect"), inShadow: el.getRootNode() !== document };
}

function walk({ onlyInView = false, samples = 12, pseudo = false } = {}) {
  const t0 = performance.now();
  const { els, shadowOpen, shadowClosed } = collect();
  const t1 = performance.now();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const chosen = onlyInView ? els.filter((el) => inView(el, vw, vh)) : els;
  const t2 = performance.now();
  const lines = chosen.map((el) => describe(el, pseudo));
  const t3 = performance.now();
  const withExpect = lines.filter((l) => l.expect !== null);
  const wrong = withExpect.filter((l) => l.name !== l.expect);
  return {
    url: location.href,
    top: window === window.top,
    pseudo,
    controls_total: els.length,
    described: lines.length,
    shadow_roots: { open: shadowOpen, closed: shadowClosed },
    in_shadow: lines.filter((l) => l.inShadow).length,
    ms: { collect: +(t1 - t0).toFixed(1), filter: +(t2 - t1).toFixed(1), name_role: +(t3 - t2).toFixed(1), total: +(t3 - t0).toFixed(1) },
    per_control_ms: lines.length ? +((t3 - t2) / lines.length).toFixed(4) : 0,
    errors: lines.filter((l) => l.err).length,
    expect_checked: withExpect.length,
    expect_mismatch: wrong.length,
    mismatch_samples: wrong.slice(0, samples).map((l) => ({ role: l.role, name: l.name, expect: l.expect })),
    samples: lines.slice(0, samples).map((l) => `${l.ref} ${l.role} "${l.name}"`),
    refs_held: refs.size,
  };
}

// getHTML with the closed shadow roots passed in: are they serialised?
function getHtmlCheck() {
  const closed = [];
  const open = [];
  for (const el of document.querySelectorAll("*")) {
    const sr = el.openOrClosedShadowRoot;
    if (sr) (el.shadowRoot ? open : closed).push(sr);
  }
  const body = document.body;
  const plain = body.getHTML();
  const serializable = body.getHTML({ serializableShadowRoots: true });
  let given, givenErr;
  try {
    given = body.getHTML({ shadowRoots: [...open, ...closed] });
  } catch (e) {
    givenErr = String(e);
  }
  const count = (s, needle) => (s ? s.split(needle).length - 1 : 0);
  return {
    open_roots: open.length,
    closed_roots: closed.length,
    plain: { closed_templates: count(plain, 'shadowrootmode="closed"'), open_templates: count(plain, 'shadowrootmode="open"'), bytes: plain.length },
    serializable_only: { closed_templates: count(serializable, 'shadowrootmode="closed"'), open_templates: count(serializable, 'shadowrootmode="open"') },
    shadowRoots_given: given !== undefined ? { closed_templates: count(given, 'shadowrootmode="closed"'), open_templates: count(given, 'shadowrootmode="open"'), closed_marker: count(given, "closed-root-marker"), bytes: given.length } : { error: givenErr },
  };
}

// This frame's <iframe> elements: their rect and the frameId Firefox gives them.
function frameRects() {
  return [...document.querySelectorAll("iframe")].map((f) => {
    const r = f.getBoundingClientRect();
    let frameId = null;
    let err = null;
    try {
      frameId = browser.runtime.getFrameId(f);
    } catch (e) {
      err = String(e);
    }
    return { src: f.src, frameId, err, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
}

function resolve(localId) {
  const el = refs.get(localId)?.deref();
  return el ? { ok: true, tag: el.localName, connected: el.isConnected } : { ok: false };
}

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.op) {
    case "walk":
      return Promise.resolve(walk(msg));
    case "gethtml":
      return Promise.resolve(getHtmlCheck());
    case "frames":
      return Promise.resolve({ url: location.href, frames: frameRects() });
    case "resolve":
      return Promise.resolve(resolve(msg.id));
    case "whoami":
      return Promise.resolve({ url: location.href, top: window === window.top, origin: location.origin });
    default:
      return undefined;
  }
});

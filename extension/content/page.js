// Kai for Firefox's content script, part 6 (after act.js): the page as HTML (design §5.6), its
// source fetched again, and the boxes a screenshot is cropped to (§5.3).
//
// The DOM is serialized as HTML's fragment serialization does it, with every open and closed
// shadow root as a declarative <template shadowrootmode>. Firefox's getHTML({shadowRoots}) does
// the work wherever it can; the walk is by hand only along the ancestors of the elements it must
// not do alone: Kai's own (overlay.js), which are left out; child frames, whose URL attribute is
// written as its origin and after each of which the frame's own document goes, as a placeholder
// { frame, src } the background fills in; and sensitive fields, whose value attribute (pages such
// as React's keep it in step with what was typed) and content are written as the mask.

(() => {
  const K = Object.hasOwn(globalThis, "kaiFirefoxContent") ? globalThis.kaiFirefoxContent : null;
  if (!K || K.off || K.page) return;
  K.page = true;
  const { FRAMES, childFrame, up, clipper, rectOf, framePlaceholder, describe, originNow, frameIdOf, sensitive, MASK, codePoints } = K;

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const FOREIGN = new Set([HTML_NS, "http://www.w3.org/2000/svg", "http://www.w3.org/1998/Math/MathML"]);
  const XML_NS = "http://www.w3.org/XML/1998/namespace";
  const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
  const XLINK_NS = "http://www.w3.org/1999/xlink";
  const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
  // Parents whose text is serialized as it is.
  const RAW = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);

  const escText = (s) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tagOf = (el) => (FOREIGN.has(el.namespaceURI) ? el.localName : el.tagName);
  function attrName(a) {
    if (!a.namespaceURI) return a.localName;
    if (a.namespaceURI === XML_NS) return `xml:${a.localName}`;
    if (a.namespaceURI === XMLNS_NS) return a.localName === "xmlns" ? "xmlns" : `xmlns:${a.localName}`;
    if (a.namespaceURI === XLINK_NS) return `xlink:${a.localName}`;
    return a.name;
  }
  // A frame element's attribute that names its document's URL.
  const urlAttr = (el) => (el.localName === "object" ? "data" : "src");
  // A URL as its origin, or its scheme when it has none ("data:"), never more of it.
  function originForm(value, base) {
    try {
      const u = new URL(value, base);
      return u.origin !== "null" ? u.origin : u.protocol;
    } catch {
      return "";
    }
  }
  // `secret`: a sensitive field (its value attribute masked); `frame`: an element with a child
  // frame (its URL attribute as its origin).
  function startTag(el, { secret = false, frame = false } = {}) {
    const attrs = [...el.attributes].map((a) => {
      let v = a.value;
      if (secret && !a.namespaceURI && a.localName === "value" && v) v = MASK(codePoints(v));
      else if (frame && !a.namespaceURI && a.localName === urlAttr(el)) v = originForm(v, el.baseURI);
      return ` ${attrName(a)}="${escAttr(v)}"`;
    });
    return `<${tagOf(el)}${attrs.join("")}>`;
  }
  const isVoid = (el) => el.namespaceURI === HTML_NS && VOID.has(el.localName);
  function shadowStart(sr) {
    let s = `<template shadowrootmode="${sr.mode}"`;
    if (sr.delegatesFocus) s += ' shadowrootdelegatesfocus=""';
    if (sr.serializable) s += ' shadowrootserializable=""';
    if (sr.clonable) s += ' shadowrootclonable=""';
    return `${s}>`;
  }

  // Every shadow root of the document (open and closed, Kai's own left out); `path`: the
  // ancestors (across shadow roots) of Kai's own elements, of child frames and of sensitive
  // fields, which are walked by hand; `secrets`: the sensitive fields.
  function survey() {
    const roots = [];
    const path = new Set();
    const secrets = new Set();
    const mark = (el) => {
      for (let a = up(el); a && !path.has(a); a = up(a)) path.add(a);
    };
    const visit = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (K.own.has(el)) {
          mark(el);
          continue;
        }
        if (FRAMES.has(el.localName) && childFrame(el) !== null) mark(el);
        if (sensitive(el)) {
          secrets.add(el);
          mark(el);
        }
        const sr = el.openOrClosedShadowRoot;
        if (sr) {
          roots.push(sr);
          visit(sr);
        }
      }
    };
    visit(document);
    return { roots, path, secrets };
  }

  // The HTML of `node` (with itself) as parts: strings, and { frame, title, src } after each child
  // frame's element.
  function serialize(start) {
    const { roots, path, secrets } = survey();
    const out = [];
    let text = "";
    const put = (s) => (text += s);
    const frameAfter = (el) => {
      if (!FRAMES.has(el.localName)) return;
      const id = childFrame(el);
      if (id === null) return;
      out.push(text);
      text = "";
      const p = { frame: id, title: el.getAttribute("title") ?? "" };
      if (el.hasAttribute(urlAttr(el))) p.src = el.getAttribute(urlAttr(el));
      out.push(p);
    };
    const node = (n) => {
      switch (n.nodeType) {
        case Node.ELEMENT_NODE:
          return element(n);
        case Node.TEXT_NODE: {
          const p = n.parentNode;
          return put(p?.nodeType === Node.ELEMENT_NODE && p.namespaceURI === HTML_NS && RAW.has(p.localName) ? n.data : escText(n.data));
        }
        case Node.COMMENT_NODE:
          return put(`<!--${n.data}-->`);
        case Node.PROCESSING_INSTRUCTION_NODE:
          return put(`<?${n.target} ${n.data}>`);
        case Node.DOCUMENT_TYPE_NODE:
          return put(`<!DOCTYPE ${n.name}>`);
        default:
          return undefined;
      }
    };
    const children = (parent) => {
      for (let c = parent.firstChild; c; c = c.nextSibling) node(c);
    };
    const element = (el) => {
      if (K.own.has(el)) return;
      const secret = secrets.has(el);
      put(startTag(el, { secret, frame: FRAMES.has(el.localName) && childFrame(el) !== null }));
      if (isVoid(el)) return frameAfter(el);
      // A sensitive field's content (a text area's text, an editable element's) as the mask.
      if (secret) {
        if (el.textContent) put(escText(MASK(codePoints(el.textContent))));
      } else if (!path.has(el)) put(el.getHTML({ shadowRoots: roots }));
      else {
        const sr = el.openOrClosedShadowRoot;
        if (sr) {
          put(shadowStart(sr));
          children(sr);
          put("</template>");
        }
        children(el.localName === "template" && el.namespaceURI === HTML_NS ? el.content : el);
      }
      put(`</${tagOf(el)}>`);
      frameAfter(el);
    };
    if (start.nodeType === Node.DOCUMENT_NODE) children(start);
    else node(start);
    out.push(text);
    return out.filter((p) => p !== "");
  }

  // A document that is no HTML (XML, SVG) as XML: its shadow roots and frames are not in it yet.
  // Sensitive fields are masked in a copy, as in HTML.
  const isHtml = () => document.contentType === "text/html";
  function xml(n) {
    const all = (r) => [r, ...r.querySelectorAll("*")];
    const live = all(n);
    if (!live.some((el) => el.nodeType === Node.ELEMENT_NODE && sensitive(el))) return [new XMLSerializer().serializeToString(n)];
    const copy = n.cloneNode(true);
    const copied = all(copy);
    live.forEach((el, i) => {
      if (el.nodeType !== Node.ELEMENT_NODE || !sensitive(el)) return;
      const c = copied[i];
      const v = c.getAttribute("value");
      if (v) c.setAttribute("value", MASK(codePoints(v)));
      if (c.textContent) c.textContent = MASK(codePoints(c.textContent));
    });
    return [new XMLSerializer().serializeToString(copy)];
  }

  // Fetches of page.source under way, by token, for page.source's cancel.
  const fetching = new Map();

  Object.assign(K.handlers, {
    dom: () => ({ ...K.self(), html: isHtml() ? serialize(document) : xml(document) }),
    element_dom: ({ local }) => {
      const r = K.element(local);
      if (r.gone) return { gone: r.gone };
      return { el: describe(r.el), origin: originNow(), html: isHtml() ? serialize(r.el) : xml(r.el) };
    },
    // The document's URL fetched again from the page, so the page's cookies and its cache
    // partition are used: from the cache alone first (`only-if-cached`, stale or not), and only
    // when the cache has no copy from the server. Decoded with the charset the page was read with.
    source: async ({ url, token }) => {
      const ac = new AbortController();
      fetching.set(token, ac);
      try {
        let res;
        let cached = true;
        try {
          res = await fetch(url, { cache: "only-if-cached", mode: "same-origin", credentials: "include", signal: ac.signal });
        } catch (e) {
          if (e.name === "AbortError") throw e;
          cached = false;
          res = await fetch(url, { cache: "no-store", credentials: "include", signal: ac.signal });
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        let charset = document.characterSet;
        let text;
        try {
          text = new TextDecoder(charset).decode(bytes);
        } catch {
          charset = "UTF-8";
          text = new TextDecoder().decode(bytes);
        }
        return { ok: true, status: res.status, response_url: res.url, content_type: res.headers.get("content-type"), charset, bytes: bytes.length, text, cached };
      } catch (e) {
        return { ok: false, aborted: e.name === "AbortError", error: e.message };
      } finally {
        fetching.delete(token);
      }
    },
    source_abort: ({ token }) => {
      fetching.get(token)?.abort();
      return {};
    },
    // The viewport as a screenshot covers it: the window's inner size, scroll bars included.
    viewport_size: () => ({ w: innerWidth, h: innerHeight }),
    // An element for element.see: scrolled into view (centred) when no part of it is in view, then
    // its border box and the part of it in view, in this frame's viewport.
    see_box: ({ local }) => {
      const r = K.element(local);
      if (r.gone) return { gone: r.gone };
      const el = r.el;
      const d = { el: describe(el), origin: originNow() };
      if (!el.checkVisibility({ visibilityProperty: true })) return { ...d, shown: false };
      let scrolled = false;
      if (!clipper()(el)) {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        scrolled = true;
      }
      const rect = rectOf(el.getBoundingClientRect());
      return { ...d, shown: true, scrolled, rect, vis: clipper()(el, rect) };
    },
    // A child frame's content box and the part of it in view, in this frame's viewport.
    frame_box: ({ frame }) => {
      for (const el of K.deepAll(document, "iframe, frame, object, embed")) {
        if (frameIdOf(el) !== frame) continue;
        const p = framePlaceholder(el, clipper());
        return p ? { box: p.box, vis: p.vis } : { hidden: true };
      }
      return { missing: true };
    },
    // Every child frame of this document with its content box and the part of it in view, in
    // this frame's viewport; `box` null for a frame element that is not rendered.
    frame_boxes: () => {
      const shown = clipper();
      const frames = [];
      for (const el of K.deepAll(document, "iframe, frame, object, embed")) {
        const frame = childFrame(el);
        if (frame === null) continue;
        const p = framePlaceholder(el, shown);
        frames.push(p ? { frame, box: p.box, vis: p.vis } : { frame, box: null, vis: null });
      }
      return { frames };
    },
  });
})();

// URL helpers the background's modules share; no browser API, so Node's tests load it.

// A URL's origin (Origin in the operations contract); null when it has none or an opaque one.
export const originOf = (url) => {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
};

// The origin of the page a tab's URL shows, as Kai's site rules read it: Reader view's
// (about:reader?url=…) and view-source:'s are the page's inside them; null when opaque.
export const siteOf = (url) => {
  const u = url || "";
  if (/^view-source:/i.test(u)) return siteOf(u.slice("view-source:".length));
  if (/^about:reader\?/i.test(u)) {
    try {
      return originOf(new URL(u).searchParams.get("url") ?? "");
    } catch {
      return null;
    }
  }
  return originOf(u);
};

// The page's text as the sidebar attaches it (design §8.1, "Attach this page"): page.text@1's
// blocks as lines the way Kai's page_text writes them (Kai's src/browser/tools/lines.rs): a
// heading as #s, a list item after "- ", a frame that could not be read said where it is, and a
// frame of a site whose rule is `none` as one line in its place and nothing of it.

export const WITHHELD = "(a frame of a site Kai does not reach)";

const UNREAD = {
  content_timeout: "it did not answer within Kai for Firefox's setting content_ms",
  restricted_domain: "Firefox keeps extensions off its site",
  site_permission: "the user took Kai for Firefox's access to its site",
  firefox_page: "it shows one of Firefox's own pages",
  file_access: "it shows a local file, which Kai for Firefox may not read",
  no_content: "Kai for Firefox cannot run in it",
};

function frameName(origin, title) {
  let site = null;
  try {
    if (origin) {
      const u = new URL(origin);
      site = u.host || null;
    }
  } catch {
    /* no site */
  }
  const t = title && title.trim() ? `"${title}"` : null;
  if (site && t) return `${site} ${t}`;
  if (site) return site;
  if (t) return `frame ${t}`;
  return "a frame without a title";
}

// The lines of `blocks`; the blocks of a frame whose origin `withheld(origin)` says are left out.
export function pageTextLines(blocks, withheld = () => false) {
  const out = [];
  let held = null;
  for (const b of blocks) {
    if (b.frame !== undefined && b.frame !== null && withheld(b.origin ?? "")) {
      if (held !== b.frame) out.push(WITHHELD);
      held = b.frame;
      continue;
    }
    held = null;
    if (typeof b.text !== "string") {
      out.push(`(${frameName(b.origin, b.title)} could not be read here: ${UNREAD[b.unread] ?? `Kai for Firefox says ${b.unread}`})`);
      continue;
    }
    const lines = b.text.split("\n");
    if (b.heading) out.push(`${"#".repeat(Math.max(1, b.heading))} ${lines.join(" ")}`);
    else if (b.item) lines.forEach((l, i) => out.push(`${i === 0 ? "- " : "  "}${l}`));
    else out.push(...lines);
  }
  return out;
}

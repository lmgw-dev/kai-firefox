// Element refs (D4): numbers from one counter per Firefox run, each naming
// (tab, frameId, documentId, the content script's local id). An element keeps its ref while its
// document is shown; a ref is never reused within a Firefox run.
// - The counter's next value is kept in storage.local and set back to 1 only when Firefox starts
//   (runtime.onStartup), so a background that starts again (the extension reloaded, updated or
//   enabled again, or suspended by Firefox) continues it. Refs below the value it started from
//   are an earlier instance's, whose elements this one does not know.
// - Each document a ref was given out in has a record. While the document is shown the record
//   maps its refs to local ids; once Firefox replaces it (webNavigation.onCommitted, Back into the
//   back-forward cache included) or closes its tab, the record keeps only its tab and frame, which
//   the stale errors name. `runs` maps every ref of this instance to its record: refs are given
//   out in increasing order, so a run is the first ref of a stretch given to one document.
// frameIds exceed 32 bits (WP0 (f)) and stay JavaScript numbers, exact to 2^53; documentIds are
// Firefox's UUID strings.

let next = 1;
// The first ref this instance gave out; lower ones are an earlier instance's.
let base = 1;
// Firefox started: the counter begins at 1 whatever the stored value says.
let fresh = false;
const live = new Map(); // documentId -> record { tab, frame, document, byLocal, byRef, gone }
const runs = []; // [{ start, rec }], start increasing

const ready = browser.storage.local.get("ref_next").then(({ ref_next }) => {
  if (!fresh && Number.isSafeInteger(ref_next) && ref_next > next) next = base = ref_next;
});

// Writes the counter; each caller waits for the write that covers the refs it gave out, so a ref
// is in storage before an operation names it.
let chain = Promise.resolve();
let pending = null;
function persist() {
  if (!pending) {
    pending = chain.then(() => {
      pending = null;
      return browser.storage.local.set({ ref_next: next });
    });
    chain = pending.catch(() => {});
  }
  return pending;
}

// runtime.onStartup: Firefox started, and with it a new run of refs.
export function browserStarted() {
  fresh = true;
  next = base = 1;
  live.clear();
  runs.length = 0;
  return persist();
}

export async function refFor(tab, frame, document, local) {
  return (await refsFor(tab, frame, document, [local]))[0];
}

// The refs of several elements of one document, in the order of `locals`, with one write of the
// counter for all the new ones.
export async function refsFor(tab, frame, document, locals) {
  await ready;
  let rec = live.get(document);
  if (!rec) {
    rec = { tab, frame, document, byLocal: new Map(), byRef: new Map(), gone: false };
    live.set(document, rec);
  }
  let added = false;
  const out = locals.map((local) => {
    let ref = rec.byLocal.get(local);
    if (ref === undefined) {
      ref = next++;
      rec.byLocal.set(local, ref);
      rec.byRef.set(ref, local);
      if (runs.at(-1)?.rec !== rec) runs.push({ start: ref, rec });
      added = true;
    }
    return ref;
  });
  if (added) await persist();
  return out;
}

// The elements of local ids of a document that the garbage collector took (the content script
// says so): their refs stay given out and answer stale_element (local: null), and the record
// keeps only the shown elements' refs.
export function forget(document, locals) {
  const rec = live.get(document);
  if (!rec) return;
  for (const local of locals) {
    const ref = rec.byLocal.get(local);
    if (ref === undefined) continue;
    rec.byLocal.delete(local);
    rec.byRef.delete(ref);
  }
}

// The ref's { tab, frame, document, local }; { tab, frame, document, gone: true } when its
// document was replaced or its tab closed; { earlier: true } for an earlier instance's ref; null
// for a number never given out in this Firefox run.
export async function lookup(ref) {
  await ready;
  if (ref >= next) return null;
  if (ref < base) return { earlier: true };
  let lo = 0;
  let hi = runs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs[mid].start <= ref) lo = mid;
    else hi = mid - 1;
  }
  const rec = runs[lo].rec;
  if (rec.gone) return { tab: rec.tab, frame: rec.frame, document: rec.document, gone: true };
  return { tab: rec.tab, frame: rec.frame, document: rec.document, local: rec.byRef.get(ref) ?? null };
}

function drop(rec) {
  rec.gone = true;
  rec.byLocal = rec.byRef = null;
  live.delete(rec.document);
}

// After a commit in a tab: the records of its documents that it no longer shows.
async function prune(tabId) {
  let shown;
  try {
    shown = new Set(((await browser.webNavigation.getAllFrames({ tabId })) || []).map((f) => f.documentId));
  } catch {
    shown = new Set();
  }
  for (const rec of [...live.values()]) if (rec.tab === tabId && !shown.has(rec.document)) drop(rec);
}

// Registered at the top level, so they also start a suspended background (which has no records).
browser.webNavigation.onCommitted.addListener((d) => {
  for (const rec of live.values()) {
    if (rec.tab === d.tabId) return prune(d.tabId);
  }
  return undefined;
});
browser.tabs.onRemoved.addListener((tabId) => {
  for (const rec of [...live.values()]) if (rec.tab === tabId) drop(rec);
});

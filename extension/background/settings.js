// The extension's own settings (design §9), kept in storage.local and edited on the options page.
// Everything about policy is Kai's configuration, not here.

export const DEFAULTS = {
  // How often kai-browser-host tries Kai's socket while Kai is not running (§2), and the first
  // wait before the extension starts the helper again after it ended.
  retry_ms: 2000,
  // How long tabs.back and tabs.forward wait for Firefox to start the navigation before they say
  // that nothing happened (Firefox's Back does nothing, silently, at the end of the history).
  nav_start_ms: 1000,
  // How long a navigation (tabs.open, go, back, forward, reload) may take, from asking Firefox
  // until it answers as its `wait` says, before the call fails with nav_timeout.
  nav_load_ms: 60000,
  // How long the extension waits for a page's content script to answer (every reading and element
  // operation asks one per frame) before the call fails with content_timeout: a page whose own
  // script keeps its thread busy cannot answer.
  content_ms: 15000,
  // How long element.fill may press keys on one field: a slider or spin button stepped toward its
  // number, a combobox typed one character at a time. When the time is up it stops and says so;
  // the page then has content_ms to answer.
  keys_ms: 10000,
};

// The longest wait before the extension starts Kai's helper again (retry_ms doubles up to it).
export const HELPER_RETRY_MAX_MS = 60000;

// Each setting's rule, said by the options page and in the log when a stored value breaks it.
export const RULES = {
  retry_ms: { min: 1, says: "a whole number of milliseconds, at least 1" },
  nav_start_ms: { min: 1, says: "a whole number of milliseconds, at least 1" },
  nav_load_ms: { min: 1, says: "a whole number of milliseconds, at least 1" },
  content_ms: { min: 1, says: "a whole number of milliseconds, at least 1" },
  keys_ms: { min: 1, says: "a whole number of milliseconds, at least 1" },
};

export const valid = (key, v) => Number.isSafeInteger(v) && v >= RULES[key].min;

export const settings = { ...DEFAULTS };

// Loads the stored settings; a stored value that breaks its rule is logged and the default used.
export async function load() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = stored[k];
    if (v === undefined) settings[k] = def;
    else if (valid(k, v)) settings[k] = v;
    else {
      console.warn(`Kai for Firefox: the stored ${k} (${JSON.stringify(v)}) is not ${RULES[k].says}; using ${def}`);
      settings[k] = def;
    }
  }
}

// The random id of this Firefox profile, kept in storage.local (sent in the hello).
export async function profileId() {
  const { profile } = await browser.storage.local.get("profile");
  if (typeof profile === "string" && profile) return profile;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ profile: id });
  return id;
}

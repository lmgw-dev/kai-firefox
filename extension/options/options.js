// The options page (design §9): the link's status, the extension's own settings, and the
// permissions Firefox grants only on a user action.
import { DEFAULTS, RULES, valid, HELPER_RETRY_MAX_MS } from "../background/settings.js";

const $ = (id) => document.getElementById(id);

const WORDS = {
  starting: "Starting Kai's helper…",
  no_helper: "Kai's helper (kai-browser-host) cannot start.",
  kai_down: "Kai is not running.",
  linking: "Linking to Kai…",
  linked: "Linked to Kai.",
  refused: "Kai refused the link.",
};

function render(s) {
  if (!s) return;
  const state = $("state");
  state.textContent = WORDS[s.link] ?? s.link;
  state.className = s.link === "linked" ? "linked" : s.link === "refused" || s.link === "no_helper" ? "bad" : "";
  const rows = [];
  if (s.reason) rows.push([s.link === "refused" ? "Reason" : "Error", s.reason]);
  if (s.link === "no_helper" && s.helper_retry_at) {
    rows.push(["Next try", `in ${Math.max(0, Math.round((s.helper_retry_at - Date.now()) / 1000))} s (failure ${s.helper_failures} in a row; the wait doubles up to ${HELPER_RETRY_MAX_MS / 1000} s)`]);
  }
  if (s.kai_version) rows.push(["Kai", `${s.kai_version}, protocol ${s.protocol}`]);
  rows.push(["Extension", s.ext_version]);
  if (s.firefox) rows.push(["Firefox", s.firefox]);
  if (s.profile) rows.push(["Profile id", s.profile]);
  if (s.ops?.length) rows.push(["Operations", s.ops.join(", ")]);
  if (s.last_error) rows.push(["Last error", `${s.last_error.code}: ${s.last_error.message} (${new Date(s.last_error.at).toLocaleString()})`]);
  const dl = $("details");
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.status) render(changes.status.newValue);
});
// Asking the background also starts it when Firefox suspended it.
browser.runtime.sendMessage({ kai: "status" }).then(render, async () => render((await browser.storage.session.get("status")).status));

async function loadSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  for (const k of Object.keys(DEFAULTS)) $(k).value = String(valid(k, stored[k]) ? stored[k] : DEFAULTS[k]);
}

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = {};
  let ok = true;
  for (const k of Object.keys(DEFAULTS)) {
    const input = $(k);
    const v = Number(input.value.trim());
    const err = $(`${k}-error`);
    if (input.value.trim() === "" || !valid(k, v)) {
      err.textContent = `Must be ${RULES[k].says}.`;
      err.hidden = false;
      input.setAttribute("aria-invalid", "true");
      ok = false;
    } else {
      err.hidden = true;
      input.removeAttribute("aria-invalid");
      out[k] = v;
    }
  }
  $("saved").textContent = ok ? "Saved." : "Not saved: see the fields above.";
  if (ok) await browser.storage.local.set(out);
});

async function loadPermissions() {
  const all = await browser.permissions.contains({ origins: ["<all_urls>"] });
  $("sites").textContent = all ? "Kai for Firefox may read and act on all websites." : "Kai for Firefox may not read websites yet: Firefox has not granted access to all websites.";
  $("grant-sites").hidden = all;
  const files = await browser.extension.isAllowedFileSchemeAccess();
  $("files").textContent = files
    ? "Kai for Firefox may read local files (file:// pages)."
    : 'Kai for Firefox may not read local files (file:// pages). Firefox grants that in about:addons, Kai for Firefox, Permissions: "Access local files on your computer".';
  const scripts = await browser.permissions.contains({ permissions: ["userScripts"] });
  $("scripts").textContent = scripts
    ? "Kai may run scripts its model writes in pages (page_script, page_script_main), each confirmed as Kai's settings say. You can withdraw this in about:addons, Kai for Firefox, Permissions."
    : "Kai may not run scripts in pages yet (page_script, page_script_main). Firefox grants that only when you allow it here.";
  $("grant-scripts").hidden = scripts;
}
$("grant-scripts").addEventListener("click", async () => {
  try {
    await browser.permissions.request({ permissions: ["userScripts"] });
  } finally {
    loadPermissions();
  }
});
browser.permissions.onAdded.addListener(loadPermissions);
browser.permissions.onRemoved.addListener(loadPermissions);
$("grant-sites").addEventListener("click", async () => {
  await browser.permissions.request({ origins: ["<all_urls>"] });
  loadPermissions();
});

loadSettings();
loadPermissions();

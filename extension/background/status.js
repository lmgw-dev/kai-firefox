// The link's state as the user sees it: the toolbar button's badge and title, and the status
// block of the options page, which reads it from storage.session (it survives a suspended
// background, not a Firefox restart).

const state = {
  // "starting" | "no_helper" | "kai_down" | "linking" | "linked" | "refused"
  link: "starting",
  since: Date.now(),
  // Why: the refusal's reason, the helper's error.
  reason: null,
  kai_version: null,
  protocol: null,
  // When the helper is started again after it ended (ms since the epoch), and how often it failed.
  helper_retry_at: null,
  helper_failures: 0,
  // The last `error` frame (from the host or Kai) or join error, with when.
  last_error: null,
  ext_version: browser.runtime.getManifest().version,
  firefox: null,
  profile: null,
  ops: [],
};

const LOOK = {
  starting: { badge: "…", color: "#6d7680", title: () => "Kai for Firefox: starting" },
  no_helper: { badge: "!", color: "#da4453", title: (s) => `Kai for Firefox: Kai's helper (kai-browser-host) cannot start: ${s.reason}` },
  kai_down: { badge: "off", color: "#6d7680", title: () => "Kai for Firefox: Kai is not running" },
  linking: { badge: "…", color: "#6d7680", title: () => "Kai for Firefox: linking to Kai" },
  linked: { badge: "", color: "#3daee9", title: (s) => `Kai for Firefox: linked to Kai ${s.kai_version}` },
  refused: { badge: "!", color: "#da4453", title: (s) => `Kai for Firefox: Kai refused the link: ${s.reason}` },
};

export const get = () => ({ ...state });

export function set(patch) {
  if (patch.link && patch.link !== state.link) state.since = Date.now();
  Object.assign(state, patch);
  const look = LOOK[state.link];
  browser.action.setBadgeText({ text: look.badge });
  browser.action.setBadgeBackgroundColor({ color: look.color });
  browser.action.setTitle({ title: look.title(state) });
  browser.storage.session.set({ status: { ...state } });
}

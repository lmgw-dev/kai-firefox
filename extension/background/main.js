// Kai for Firefox's background: an MV3 event page that holds the native port to Kai (link.js)
// and serves Kai's operations (tabs.js, context.js, read.js, hints.js, act.js, gate.js,
// features.js, source.js, styles.js, scripts.js, see.js, aloud.js), its events (events.js) and
// the sidebar's requests (sidebar.js).
// Listeners are registered at the top level, so Firefox starts the page for them.

import * as link from "./link.js";
import * as status from "./status.js";
import { load, settings, DEFAULTS, valid } from "./settings.js";
import { browserStarted } from "./refs.js";
import { browserStarted as stylesStarted } from "./styles.js";
import * as user from "./user.js";
import { loadContainers } from "./tabs.js";
import "./context.js";
import "./read.js";
import "./hints.js";
import "./act.js";
import "./gate.js";
import "./features.js";
import "./source.js";
import "./scripts.js";
import "./see.js";
import "./events.js";
import "./aloud.js";
import "./sidebar.js";

// Firefox starts an event page at its own start only for a startup listener; a Firefox start is
// also where a new run of refs and of style sheet ids begins.
browser.runtime.onStartup.addListener(() => Promise.all([browserStarted(), stylesStarted()]));
// Switching tabs starts a suspended background, which then connects (link.js).
browser.tabs.onActivated.addListener(() => {});
// The toolbar button opens and closes Kai's sidebar (design §8.1): Firefox lets an extension open
// its sidebar only on a user action, which a click on the button is. The options page (the link's
// status) stays in about:addons, and the sidebar's strip opens it while Kai is not linked.
browser.action.onClicked.addListener(() => browser.sidebarAction.toggle());
// The options page asks for the status, which also starts a suspended background.
browser.runtime.onMessage.addListener((m, sender) => {
  if (m?.kai !== "status" || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return undefined;
  return Promise.resolve(status.get());
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (!(k in DEFAULTS)) continue;
    settings[k] = valid(k, newValue) ? newValue : DEFAULTS[k];
    if (k === "retry_ms") link.sendConfig();
  }
});

await Promise.all([load(), user.load(), loadContainers()]);
link.start();

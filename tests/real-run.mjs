#!/usr/bin/env node
// The sidebar page's run against a real lmgw (design §13, WP8b): the kai-firefox side of Kai's
// `just live-check-sidebar` (Kai's scripts/live-check-sidebar.sh), which serves Kai's real browser
// server and sidebar proxy on --socket, paired over lmgw's device link with a dev lmgw whose chat
// model is a mock. This starts the fixture site and a headless Firefox with the extension as it
// ships (the page built in extension/sidebar/), whose real kai-browser-host links to that socket,
// opens the real sidebar panel and drives the Chat: the thread --thread listed and open, a message
// --say sent and its reply streamed back, the site strip's rule, and Attach this page.
//
//   node tests/real-run.mjs --socket <path> --thread <title> --say <text> [--keep]
//
// - Firefox runs in a transient systemd scope named as Plasma names a Firefox it starts, so Kai's
//   peer check lets its host in with Kai's default browser.peer_scopes (tests/accept/launch.mjs).
// - stdout: one JSON object per line: each step as {"step": name, ...what it saw}, then {"done":
//   true} or {"failed": why}; the exit code says the same.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, EXT_ID, HOST_NAME, hostBinary, installExtension, ourHosts } from "./lib/env.mjs";
import { launchFirefox, sleep } from "./lib/firefox.mjs";
import { serveSite } from "./lib/site.mjs";
import { killChecked } from "./lib/proc.mjs";
import { openSidebar, inSidebar } from "./lib/sidebar.mjs";
import { built } from "./e2e/chat.test.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const socket = opt("--socket");
const threadTitle = opt("--thread");
const sayText = opt("--say");
if (!socket || !threadTitle || !sayText) throw new Error("usage: real-run.mjs --socket <path> --thread <title> --say <text> [--keep]");
const keep = argv.includes("--keep");
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const note = (s) => process.stderr.write(`real-run: ${s}\n`);

async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    if (Date.now() - t0 > ms) throw new Error(`${what} did not happen within ${ms} ms (last: ${JSON.stringify(last)})`);
    await sleep(200);
  }
}

if (!built()) throw new Error("the sidebar page is not built: scripts/sidebar.sh");
const host = hostBinary();
const stamp = `${Date.now()}`;
const dir = join(ROOT, "target", "real-run", stamp);
for (const d of ["profile", "home/.mozilla/native-messaging-hosts", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "tmp"]) await mkdir(join(dir, d), { recursive: true });
await writeFile(
  join(dir, "home/.mozilla/native-messaging-hosts", `${HOST_NAME}.json`),
  JSON.stringify({ name: HOST_NAME, description: "Kai (the sidebar's real run)", path: host.path, type: "stdio", allowed_extensions: [EXT_ID] }, null, 2),
);
note(host.note);

let site = null;
let ff = null;
const killSync = () => {
  ff?.killNow();
  for (const h of ourHosts(host.path, socket)) killChecked(h.pid, h.start, "SIGKILL");
};
process.on("exit", killSync);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

let failed = null;
try {
  site = await serveSite();
  ff = await launchFirefox({
    dir,
    env: { KAI_BROWSER_SOCKET: socket },
    wrap: ["systemd-run", "--user", "--scope", "--quiet", `--unit=app-org.mozilla.firefox-kaisidebar${stamp}x${process.pid}.scope`],
  });
  await installExtension(ff);
  await until(() => ourHosts(host.path, socket).length, "Firefox starting kai-browser-host", 20000);
  await ff.send("browsingContext.navigate", { context: ff.context, url: site.url("article.html"), wait: "complete" });
  say({ step: "firefox", page: site.url("article.html") });

  await openSidebar(ff, { ready: `!!document.querySelector(".chat-main") || !!document.querySelector(".chat-empty")`, what: "the Chat" });
  const linked = await until(
    () => inSidebar(ff, `(() => { const r = document.querySelector("[data-kai=rule]")?.textContent; return !document.querySelector("[data-kai=link]") && r && r !== "\\u2026" ? r : null; })()`),
    "the strip linked, with the page's rule from Kai",
  );
  say({ step: "strip", site: await inSidebar(ff, `document.querySelector("[data-kai=site]")?.textContent`), rule: linked });

  // The thread made on the dev lmgw, listed through Kai and opened (the newest is opened first).
  const titles = await until(
    () =>
      inSidebar(
        ff,
        `(() => {
          const t = [...document.querySelectorAll("[data-thread] .thread-title")].map((e) => e.textContent.trim());
          if (!t.length) document.querySelector("[data-drawer=Conversations][aria-expanded=false]")?.click();
          return t;
        })()`,
      ).then((t) => t.includes(threadTitle) && t),
    `the thread "${threadTitle}" listed`,
  );
  say({ step: "threads", titles });
  await inSidebar(ff, `([...document.querySelectorAll("[data-thread]")].find((e) => e.textContent.includes(${JSON.stringify(threadTitle)}))?.click(), 1)`);
  await until(() => inSidebar(ff, `!!document.querySelector("textarea.composer-input")`), "the thread open");

  // A message, its reply streamed from the mock through lmgw, Kai and the relay.
  await inSidebar(
    ff,
    `(() => { const t = document.querySelector("textarea.composer-input"); t.value = ${JSON.stringify(sayText)}; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`,
  );
  await until(() => inSidebar(ff, `document.querySelector(".composer-send")?.disabled === false`), "the Send button enabled");
  await inSidebar(ff, `(document.querySelector(".composer-send").click(), 1)`);
  const reply = await until(
    () => inSidebar(ff, `(() => { const r = [...document.querySelectorAll(".msg-assistant .md")].map((e) => e.innerText.trim()).filter(Boolean); return !document.querySelector("[aria-label=Stop]") && r.length ? r.at(-1) : null; })()`),
    "the reply, whole",
    60000,
  );
  say({ step: "reply", text: reply });

  // Attach this page: its text, headed with its title and URL, uploaded into the thread.
  await inSidebar(ff, `(document.querySelector("[data-kai=attach]").click(), 1)`);
  const chip = await until(
    () => inSidebar(ff, `[...document.querySelectorAll(".composer *")].map((e) => e.textContent).find((t) => /\\.txt/.test(t)) ?? null`),
    "the attached page's chip in the composer",
  );
  say({ step: "attached", chip });
  say({ step: "violations", count: Number(await inSidebar(ff, `document.documentElement.dataset.cspViolations ?? "0"`)) });
} catch (e) {
  failed = String(e.message || e);
  // What the page showed when it failed.
  const seen = await inSidebar(
    ff,
    `({ strip: document.querySelector("[data-kai=strip]")?.innerText ?? null, notices: [...document.querySelectorAll(".kai-notice")].map((e) => e.innerText), toasts: [...document.querySelectorAll(".toast")].map((e) => e.innerText), threads: [...document.querySelectorAll("[data-thread]")].map((e) => e.innerText.trim()), chat: (document.querySelector(".kai-chat")?.innerText ?? "").slice(0, 800) })`,
  ).catch((x) => ({ unreadable: String(x.message || x) }));
  say({ step: "page", ...seen });
}
if (ff) await ff.close().catch(() => ff.killNow());
for (let i = 0; i < 20 && ourHosts(host.path, socket).length; i++) await sleep(100);
for (const h of ourHosts(host.path, socket)) killChecked(h.pid, h.start, "SIGKILL");
if (site) await site.close();
if (!keep) await rm(dir, { recursive: true, force: true });
say(failed ? { failed } : { done: true });
process.exit(failed ? 1 : 0);

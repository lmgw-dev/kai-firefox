#!/usr/bin/env node
// WP0 (e): where does Firefox read a per-user native manifest from, with HOME and
// XDG_CONFIG_HOME both pointed at temporary folders?
//
//   node run-e.mjs            # all cases, one headless Firefox each (about 10 s per case)
//
// Each case places the spike host's manifest in some of: $HOME/.mozilla/native-messaging-hosts,
// $XDG_CONFIG_HOME/mozilla/native-messaging-hosts, $HOME/.config/mozilla/native-messaging-hosts
// (XDG_CONFIG_HOME unset), and optionally an empty $HOME/.mozilla. The background connects at
// startup; the host logs argv[1], the manifest path Firefox used. The chrome-scope value of
// XREUserNativeManifests is read too, and what Firefox created in HOME/XDG is listed after quit.
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { makeRun, launchFirefox, prepareExt, writeHostManifest, hostEvents, killHosts, listTree, sleep, EXT_ID } from "./lib/firefox.mjs";

const CASES = [
  { name: "home-only", desc: "manifest in $HOME/.mozilla only (so ~/.mozilla exists)", home: true },
  { name: "xdg-only", desc: "manifest in $XDG_CONFIG_HOME/mozilla only, no ~/.mozilla", xdg: true },
  { name: "xdg-with-empty-dotmozilla", desc: "manifest in $XDG_CONFIG_HOME/mozilla, empty ~/.mozilla exists", xdg: true, emptyDot: true },
  { name: "xdg-with-dotmozilla-firefox", desc: "manifest in $XDG_CONFIG_HOME/mozilla, ~/.mozilla/firefox exists (a legacy install)", xdg: true, dotFirefox: true },
  { name: "both", desc: "manifests in both (each names its own path)", home: true, xdg: true },
  { name: "xdg-unset-dotconfig", desc: "XDG_CONFIG_HOME unset, manifest in $HOME/.config/mozilla, no ~/.mozilla", dotconfig: true, unsetXdg: true },
  { name: "nothing", desc: "no manifest anywhere (the error the extension sees)" },
];

const results = [];
for (const c of CASES) {
  const run = await makeRun("e-" + c.name);
  if (c.home) await writeHostManifest(join(run.home, ".mozilla", "native-messaging-hosts"));
  if (c.xdg) await writeHostManifest(join(run.xdgConfig, "mozilla", "native-messaging-hosts"));
  if (c.dotconfig) await writeHostManifest(join(run.home, ".config", "mozilla", "native-messaging-hosts"));
  if (c.emptyDot) await mkdir(join(run.home, ".mozilla"), { recursive: true });
  if (c.dotFirefox) await mkdir(join(run.home, ".mozilla", "firefox"), { recursive: true });
  const before = { home: listTree(run.home), xdg: listTree(run.xdgConfig) };
  const extDir = await prepareExt(run, { connectNative: true });
  const env = { SPIKE_PING_S: "0", SPIKE_HOST_MODE: "eof-exit" };
  const ff = await launchFirefox({ run, env, unset: c.unsetXdg ? ["XDG_CONFIG_HOME"] : [] });
  const r = { case: c.name, desc: c.desc };
  try {
    r.dirsvc_user = await ff.chromeEval(`Services.dirsvc.get("XREUserNativeManifests", Ci.nsIFile).path`);
    r.dirsvc_sys = await ff.chromeEval(`Services.dirsvc.get("XRESysNativeManifests", Ci.nsIFile).path`);
    const inst = await ff.installExtension(extDir);
    if (inst.extension !== EXT_ID) throw new Error("installed " + JSON.stringify(inst));
    let starts = [];
    for (let i = 0; i < 50 && !starts.length; i++) {
      await sleep(100);
      starts = hostEvents(run.hostlog).filter((e) => e.ev === "start");
    }
    r.host_started = starts.length > 0;
    r.manifest_used = starts.map((s) => s.argv[1]?.replace(run.dir, "<run>"));
    r.host_argv2 = starts.map((s) => s.argv[2]);
    const page = await ff.openExtPage("harness.html");
    const st = await ff.evalIn(page, `bg({ op: "state" })`);
    r.ext_events = st.events.map((e) => e.ev + (e.error ? `: ${e.error}` : ""));
    const tq = await ff.quit();
    const ex = await Promise.race([ff.exited, sleep(30000).then(() => null)]);
    r.quit_ms = ex ? ex.t - tq : "timeout";
  } finally {
    r.killed_hosts = await killHosts(run.hostlog);
    await ff.close({ keep: true });
  }
  const strip = (l) => l.filter((x) => !before.home.includes(x));
  r.created_in_home = strip(listTree(run.home)).filter((x) => !x.startsWith(".cache") && !x.startsWith(".local"));
  r.created_in_xdg_config = listTree(run.xdgConfig).filter((x) => !before.xdg.includes(x));
  const { rm } = await import("node:fs/promises");
  await rm(run.dir, { recursive: true, force: true });
  for (const k of ["dirsvc_user", "dirsvc_sys"]) if (r[k]) r[k] = r[k].replace(run.dir, "<run>");
  results.push(r);
  console.log(JSON.stringify(r, null, 1));
}
console.log("\n== summary ==");
for (const r of results) {
  console.log(`${r.case.padEnd(28)} XREUserNativeManifests=${r.dirsvc_user}  manifest used=${JSON.stringify(r.manifest_used)}  ${r.ext_events?.find((e) => e.startsWith("disconnect")) || ""}`);
  console.log(`${"".padEnd(28)} Firefox created: HOME ${JSON.stringify(r.created_in_home)}  XDG_CONFIG_HOME ${JSON.stringify(r.created_in_xdg_config)}`);
}

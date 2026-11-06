#!/usr/bin/env node
// WP0 (b): granting the optional-only `userScripts` permission from a test harness, then
// userScripts.execute in the USER_SCRIPT and MAIN worlds and scripting.executeScript in MAIN.
//
//   node run-b.mjs
//
// Grant attempts, each from a revoked state:
//   A  permissions.request evaluated in an extension page (no user action)
//   B  BiDi input.performActions click on the options-page button (grant.html), prompts on;
//      the doorhanger is then accepted from chrome scope
//   C  the same click with extensions.webextOptionalPermissionPrompts = false (a second Firefox)
//   D  chrome scope ExtensionPermissions.add (no page involved)
import { join } from "node:path";
import { makeRun, launchFirefox, prepareExt, sleep, EXT_ID, SPIKE } from "./lib/firefox.mjs";
import { serve } from "./page/server.mjs";

const out = { grant: {}, userScripts: {}, executeScript: {} };
const srv = await serve(join(SPIKE, "page"));
const pageUrl = `http://127.0.0.1:${srv.port}/b.html`;

async function start(prefs = {}) {
  const run = await makeRun("b");
  const ext = await prepareExt(run, { connectNative: false });
  const ff = await launchFirefox({ run, prefs });
  const inst = await ff.installExtension(ext);
  if (inst.extension !== EXT_ID) throw new Error(JSON.stringify(inst));
  await ff.navigate(ff.context, pageUrl);
  const harness = await ff.openExtPage("harness.html");
  return { run, ff, harness };
}
const has = (ff, page) => ff.evalIn(page, `browser.permissions.contains({ permissions: ["userScripts"] })`);
const revoke = (ff, page) => ff.evalIn(page, `browser.permissions.remove({ permissions: ["userScripts"] })`);

async function clickGrant(ff) {
  const grant = await ff.openExtPage("grant.html");
  const t0 = Date.now();
  await ff.send("input.performActions", {
    context: grant,
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", x: 170, y: 60, origin: "viewport" },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ] }],
  });
  await sleep(500);
  return { grant, t0 };
}
const grantState = (ff, grant) => ff.evalIn(grant, `window.__grant`);

// The optional-permission doorhanger, as chrome sees it.
const promptInfo = (ff) => ff.chromeEval(`(() => {
  const n = PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser);
  if (!n) return null;
  const panel = PopupNotifications.panel;
  const el = panel && panel.querySelector("popupnotification");
  return { id: n.id, message: el ? (el.getAttribute("label") || "") + " | " + [...el.querySelectorAll("li, description, label")].map((x) => x.textContent.trim()).filter(Boolean).join(" | ") : null, mainAction: n.mainAction && n.mainAction.label };
})()`);
const acceptPrompt = (ff) => ff.chromeEval(`(() => {
  const n = PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser);
  if (!n) return "no prompt";
  n.mainAction.callback({});
  n.remove();
  return "accepted via mainAction.callback";
})()`);

try {
  // ---- grant A, B, D in one Firefox
  {
    const { run, ff, harness } = await start();
    try {
      out.grant.initially = await has(ff, harness);
      out.grant.namespace_before = await ff.evalIn(harness, `typeof browser.userScripts`);
      out.grant.A_no_user_action = await ff.evalIn(harness, `browser.permissions.request({ permissions: ["userScripts"] }).then((r) => ({ result: r }), (e) => ({ error: e.message }))`);

      const { grant } = await clickGrant(ff);
      const st = await grantState(ff, grant);
      out.grant.B_click = { page: st, prompt: await promptInfo(ff) };
      out.grant.B_click.accept = await acceptPrompt(ff);
      await sleep(500);
      out.grant.B_click.after_accept = { page: await grantState(ff, grant), contains: await has(ff, harness), namespace_in_open_page: await ff.evalIn(harness, `typeof browser.userScripts`) };
      const fresh = await ff.openExtPage("harness.html");
      out.grant.B_click.namespace_in_new_page = await ff.evalIn(fresh, `typeof browser.userScripts`);

      out.grant.revoke = await revoke(ff, harness);
      out.grant.after_revoke = await has(ff, harness);
      out.grant.D_chrome_scope = await ff.chromeEval(`ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs").ExtensionPermissions.add(${JSON.stringify(EXT_ID)}, { permissions: ["userScripts"], origins: [] }, WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)}).extension).then(() => "ok", (e) => "error " + e)`);
      out.grant.D_contains = await has(ff, harness);

      // ---- userScripts.execute and scripting.executeScript (permission granted through D)
      const page = await ff.openExtPage("harness.html");
      const tabId = await ff.evalIn(page, `browser.tabs.query({ url: "http://127.0.0.1/*" }).then((t) => t[0].id)`);
      const norm = `(rs) => rs.map((r) => ({ frameId: r.frameId, result: r.result === undefined ? "<undefined>" : r.result, error: r.error === undefined ? undefined : { type: typeof r.error, ctor: r.error && r.error.constructor && r.error.constructor.name, message: r.error && r.error.message, string: String(r.error) } }))`;
      const CASES = {
        expression: "1 + 1",
        statements_last_value: "let x = 5; x * 2",
        dom: "document.title",
        page_global: "typeof pageGlobal",
        page_var: "typeof pageVar",
        window_page_global: "window.pageGlobal",
        object: "({ a: 1, b: [1, 2], c: undefined, d: null })",
        promise: "new Promise((r) => setTimeout(() => r('late value'), 200))",
        async_iife: "(async () => { await null; return { ok: true }; })()",
        rejected_promise: "Promise.reject(new Error('async boom'))",
        throw: "throw new Error('boom')",
        throw_string: "throw 'plain string'",
        syntax_error: "1 +",
        dom_node: "document.body",
        function_value: "(() => 1)",
        return_statement: "return 5",
        two_mib_string: "'x'.repeat(2 * 1024 * 1024).length",
        two_mib_string_value: "'x'.repeat(2 * 1024 * 1024)",
      };
      for (const world of ["USER_SCRIPT", "MAIN"]) {
        out.userScripts[world] = {};
        for (const [name, code] of Object.entries(CASES)) {
          const t0 = Date.now();
          const r = await ff.evalIn(page, `browser.userScripts.execute({ js: [{ code: ${JSON.stringify(code)} }], target: { tabId: ${tabId} }, world: ${JSON.stringify(world)} }).then((rs) => ({ ok: (${norm})(rs) }), (e) => ({ rejected: e.message }))`);
          if (name === "two_mib_string_value" && r.ok) r.ok = r.ok.map((x) => ({ ...x, result: typeof x.result === "string" ? `<string of ${x.result.length}>` : x.result }));
          out.userScripts[world][name] = { ms: Date.now() - t0, ...r };
        }
      }
      // A page whose CSP is script-src 'self' (no unsafe-eval): is the injected code subject to it?
      out.userScripts.csp_page = {};
      await ff.navigate(ff.context, pageUrl.replace("b.html", "b-csp.html"));
      for (const world of ["USER_SCRIPT", "MAIN"]) {
        out.userScripts.csp_page[world] = {};
        for (const [name, code] of Object.entries({ expression: "1 + 1", page_global: "typeof pageGlobal", eval: "eval('2 + 2')", new_function: "new Function('return 3')()" })) {
          out.userScripts.csp_page[world][name] = await ff.evalIn(page, `browser.userScripts.execute({ js: [{ code: ${JSON.stringify(code)} }], target: { tabId: ${tabId} }, world: ${JSON.stringify(world)} }).then((rs) => ({ ok: (${norm})(rs) }), (e) => ({ rejected: e.message }))`);
        }
      }
      // configureWorld's csp: does it lift the page CSP for eval in the USER_SCRIPT world?
      out.userScripts.csp_page.configureWorld = await ff.evalIn(page, `browser.userScripts.configureWorld({ csp: "script-src 'self' 'unsafe-eval' 'unsafe-inline'" }).then(() => browser.userScripts.execute({ js: [{ code: "eval('2 + 2')" }], target: { tabId: ${tabId} }, world: "USER_SCRIPT" })).then((rs) => ({ ok: (${norm})(rs) }), (e) => ({ rejected: e.message }))`);
      await ff.evalIn(page, `browser.userScripts.resetWorldConfiguration()`);
      out.executeScript.csp_page_MAIN_eval = await ff.evalIn(page, `browser.scripting.executeScript({ target: { tabId: ${tabId} }, world: "MAIN", func: () => eval("2 + 2") }).then((rs) => ({ ok: (${norm})(rs) }), (e) => ({ rejected: e.message }))`);
      await ff.navigate(ff.context, pageUrl);
      // A user script writing a page global: visible to the page in MAIN only.
      out.userScripts.write_global = {};
      for (const world of ["USER_SCRIPT", "MAIN"]) {
        await ff.evalIn(page, `browser.userScripts.execute({ js: [{ code: "window.fromScript_${world} = 1" }], target: { tabId: ${tabId} }, world: ${JSON.stringify(world)} })`);
        out.userScripts.write_global[world] = await ff.evalIn(ff.context, `typeof window.fromScript_${world}`);
      }
      const FUNCS = {
        page_global: ["() => typeof pageGlobal", []],
        with_args: ["(a, b) => a + b", [2, 3]],
        promise: ["() => new Promise((r) => setTimeout(() => r('late'), 200))", []],
        throw: ["() => { throw new Error('func boom'); }", []],
        rejected: ["async () => { throw new Error('async func boom'); }", []],
        dom_node: ["() => document.body", []],
      };
      for (const world of ["ISOLATED", "MAIN"]) {
        out.executeScript[world] = {};
        for (const [name, [fn, args]] of Object.entries(FUNCS)) {
          out.executeScript[world][name] = await ff.evalIn(page, `browser.scripting.executeScript({ target: { tabId: ${tabId} }, world: ${JSON.stringify(world)}, func: ${fn}, args: ${JSON.stringify(args)} }).then((rs) => ({ ok: (${norm})(rs) }), (e) => ({ rejected: e.message }))`);
        }
      }
    } finally {
      await ff.close();
    }
  }
  // ---- grant C: the click with prompts off
  {
    const { ff, harness } = await start({ "extensions.webextOptionalPermissionPrompts": false });
    try {
      const { grant } = await clickGrant(ff);
      out.grant.C_click_prompts_off = { page: await grantState(ff, grant), prompt: await promptInfo(ff), contains: await has(ff, harness) };
      out.grant.C_no_user_action_prompts_off = await ff.evalIn(harness, `browser.permissions.remove({ permissions: ["userScripts"] }).then(() => browser.permissions.request({ permissions: ["userScripts"] })).then((r) => ({ result: r }), (e) => ({ error: e.message }))`);
    } finally {
      await ff.close();
    }
  }
} finally {
  await srv.close();
}
console.log(JSON.stringify(out, null, 1));

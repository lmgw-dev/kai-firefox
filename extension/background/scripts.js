// Scripts (design §5.8): code Kai's model wrote, run in a page's top document with
// userScripts.execute, in the isolated USER_SCRIPT world (page.script: the DOM, not the page's
// variables) or in the page's own MAIN world (page.script_main). The code runs as a script, never
// through eval (strict-CSP pages refuse eval in both worlds), inside a block ("{" + code + "\n}"),
// so its let, const and class end with the call; the block keeps the value of its last
// statement, and that value, or a returned promise's result, comes back as JSON. It runs only in
// the document Kai approved: the top document of the origin given, targeted by its document id,
// so a page left before Firefox injects is page_changed too.
//
// userScripts is an optional permission Firefox grants only on a user action: the options page
// has the button. Until then browser.userScripts does not exist here. The USER_SCRIPT world has
// no messaging (Firefox's default, configureWorld not called), and its fetches are the page's,
// bound by CORS (both tested).

import { define, OpError, about, cancellable } from "./ops.js";
import { tabArg } from "./tabs.js";
import { urlAccess, approvedTop, pageLeft } from "./pages.js";
import { tabRef } from "./compose.js";

export const NO_PERMISSION = "Kai for Firefox may not run scripts in pages yet: allow user scripts in Kai for Firefox's options (the button 'Allow user scripts')";

// The block around the code: what comes before it on line 1, whose length is taken off the
// columns Firefox reports there.
const OPEN = "{";
const wrap = (code) => `${OPEN}${code}\n}`;
// An error's name that may stand in a message: the page can throw anything, so only a name of
// the form of the built-in ones (TypeError, a DOMException's NotFoundError) is said there.
const NAME = /^[A-Z][A-Za-z]{0,40}Error$/;

// What the code threw, as plain data: an Error's name, message and place in the code; any other
// value as JSON, or its text.
function thrown(err) {
  if (err && typeof err === "object" && typeof err.message === "string") {
    const t = { name: typeof err.name === "string" ? err.name : "Error", message: err.message };
    if (Number.isSafeInteger(err.lineNumber)) t.line = err.lineNumber;
    if (Number.isSafeInteger(err.columnNumber)) t.column = t.line === 1 && err.columnNumber > OPEN.length ? err.columnNumber - OPEN.length : err.columnNumber;
    return t;
  }
  try {
    const json = JSON.stringify(err);
    if (json !== undefined) return { value: JSON.parse(json) };
  } catch {
    /* no JSON form */
  }
  return { value: String(err) };
}

function scriptOp(world) {
  return async ({ code, origin, tab: id }, { signal }) => {
    const tab = await tabArg(id);
    if (!browser.userScripts) throw new OpError("no_user_scripts", NO_PERMISSION, about(tab));
    const refused = await urlAccess(tab);
    if (refused) throw refused;
    const top = await approvedTop(tab, origin, "the script did not run");
    let results;
    try {
      results = await cancellable(signal, browser.userScripts.execute({ js: [{ code: wrap(code) }], target: { tabId: tab.id, documentIds: [top.document] }, world, injectImmediately: true }));
    } catch (e) {
      if (e instanceof OpError) throw e;
      if (/non-structured-clonable/i.test(e.message)) {
        throw new OpError("not_cloneable", `the script's value in tab ${tab.id} cannot be sent back: it is no plain data (a DOM node, a function, a window); end the code with plain data`, about(tab));
      }
      if (pageLeft(e)) throw new OpError("page_changed", `the page Kai approved in tab ${tab.id} was left before the script ran, so it did not run`, about(await browser.tabs.get(tab.id).catch(() => tab)));
      throw new OpError("no_content", `Firefox did not run the script in tab ${tab.id}: ${e.message}`, about(tab));
    }
    const r = results.find((x) => x.documentId === top.document) ?? results[0];
    if (!r) throw new OpError("no_content", `Firefox ran the script in no document of tab ${tab.id}`, about(tab));
    if (r.error !== undefined && r.error !== null) {
      const t = thrown(r.error);
      throw new OpError("script_error", `the script threw in tab ${tab.id}${NAME.test(t.name ?? "") ? ` (${t.name})` : ""}`, { ...about(tab), thrown: t });
    }
    let json;
    try {
      json = JSON.stringify(r.result);
    } catch (e) {
      throw new OpError("not_json", `the script's value in tab ${tab.id} has no JSON form: ${e.message}`, about(tab));
    }
    const out = { tab: tabRef(await browser.tabs.get(tab.id).catch(() => tab)), world };
    if (json !== undefined) out.value = JSON.parse(json);
    return out;
  };
}

const ARGS = { code: { type: "string", required: true, nonEmpty: true }, origin: { type: "string", required: true, nonEmpty: true }, tab: { type: "integer" } };
define("page.script@1", { args: ARGS, run: scriptOp("USER_SCRIPT") });
define("page.script_main@1", { args: ARGS, run: scriptOp("MAIN") });

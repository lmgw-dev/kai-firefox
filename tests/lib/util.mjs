// Small helpers for the end-to-end tests.

// The running test's signal (tests/run.mjs): aborted when the test ran over its time, so its
// waits end.
let signal = null;
export const useSignal = (s) => (signal = s);

// Waits ms; throws when the running test is stopped meanwhile.
export const sleep = (ms) =>
  new Promise((resolve, reject) => {
    const s = signal;
    if (s?.aborted) return reject(s.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(s.reason);
    };
    const timer = setTimeout(() => {
      s?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    s?.addEventListener("abort", onAbort, { once: true });
  });

// Polls fn until it returns a truthy value; that value. Fails after ms with `what`.
export async function waitFor(fn, { ms = 10000, every = 50, what = "the condition" } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    signal?.throwIfAborted();
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > ms) throw new Error(`${what} did not happen within ${ms} ms (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(every);
  }
}

// The link's status as the background keeps it.
export const status = (env) => env.ext(`browser.storage.session.get("status").then((s) => s.status)`);

// The toolbar button as the user sees it.
export const toolbar = async (env) => ({
  title: await env.ext(`browser.action.getTitle({})`),
  badge: await env.ext(`browser.action.getBadgeText({})`),
});

// Calls an operation on the current link; its `ok`, or throws with `code`.
export const call = (env, op, args = {}, opts) => env.conn().call(op, args, opts);

// Expects an operation to fail with `code`; the error.
export async function fails(env, op, args, code) {
  try {
    const ok = await call(env, op, args);
    throw new Error(`${op} ${JSON.stringify(args)} answered ${JSON.stringify(ok).slice(0, 300)}, not the error ${code}`);
  } catch (e) {
    if (e.code !== code) throw e;
    return e.error;
  }
}

// Evaluates in the user's tab (the first tab, BiDi's first context).
export const inPage = (env, expr) => env.ff.evalIn(env.ff.context, expr);

// The BiDi context of a frame of the first tab whose URL contains `part`.
export async function frameContext(env, part) {
  const tree = await env.ff.send("browsingContext.getTree", { root: env.ff.context });
  const walk = (c) => [c, ...(c.children || []).flatMap(walk)];
  const hit = walk(tree.contexts[0]).find((c) => c.url.includes(part));
  if (!hit) throw new Error(`no frame with ${part}`);
  return hit.context;
}

// Moves the pointer to (x, y) of the first tab's viewport, from a pixel beside it, so the page
// sees a move even when the pointer was there already.
export const pointTo = (env, x, y) =>
  env.ff.send("input.performActions", {
    context: env.ff.context,
    actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: Math.round(x) + 1, y: Math.round(y) }, { type: "pointerMove", x: Math.round(x), y: Math.round(y) }] }],
  });

// Presses a key (a WebDriver key value, "\uE004" is Tab) in the first tab.
export const press = (env, key) =>
  env.ff.send("input.performActions", { context: env.ff.context, actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: key }, { type: "keyUp", value: key }] }] });

// The fixture site's origin at `host`: the origin Kai approves for page.css and page.script.
export const siteOrigin = (env, host = "127.0.0.1") => new URL(env.site.url("", host)).origin;

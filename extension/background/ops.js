// The operations the extension serves (design §4.3), their arguments and their errors. Each
// operation is `area.verb@version`; docs/protocol/operations.md is the contract.

// An operation's failure: `code` for Kai's provider, `message` for the people reading it.
export class OpError extends Error {
  constructor(code, message, extra = undefined) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// The tab an error concerns, as the error's fields: its id, title and URL. Messages name a tab by
// its id only, so Kai can withhold a page's title and URL from them.
export const about = (tab) => ({ tab: tab.id, title: tab.title ?? "", url: tab.url ?? "" });

const REGISTRY = new Map();

// spec: { args: { name: { type: "integer"|"string"|"boolean"|"ref"|"value", required?, values?, min?, max?,
//                         check? } },
//         oneOf?: [names...] (exactly one of them must be given), run(args, ctx) }
// A "value" argument is any JSON value its `check(v)` accepts: check answers null, or what the
// value must be.
export function define(name, spec) {
  REGISTRY.set(name, spec);
}

// The operations with their versions, for the hello.
export const served = () => [...REGISTRY.keys()];

const kind = (v) => (Array.isArray(v) ? "a list" : typeof v === "string" ? (v.trim() ? "a string" : "an empty string") : typeof v === "number" ? `the number ${v}` : typeof v === "boolean" ? `${v}` : "an object");

function check(name, spec, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new OpError("bad_args", `${name} takes an object of arguments`);
  const decl = spec.args || {};
  for (const k of Object.keys(args)) {
    if (!Object.hasOwn(decl, k)) {
      const known = Object.keys(decl);
      throw new OpError("bad_args", `${name} has no argument '${k}'${known.length ? ` (it takes ${known.join(", ")})` : " (it takes none)"}`);
    }
  }
  for (const [k, d] of Object.entries(decl)) {
    const v = args[k];
    if (v === undefined || v === null) {
      if (d.required) throw new OpError("bad_args", `${name} needs '${k}'`);
      continue;
    }
    const bad = (what) => {
      throw new OpError("bad_args", `${name}'s '${k}' must be ${what}, not ${kind(v)}`);
    };
    switch (d.type) {
      case "integer":
        if (!Number.isSafeInteger(v)) bad("a whole number");
        if ((d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max)) {
          bad(d.max === undefined ? `a whole number from ${d.min}` : d.min === undefined ? `a whole number up to ${d.max}` : `a whole number from ${d.min} to ${d.max}`);
        }
        break;
      case "ref":
        if (!Number.isSafeInteger(v) || v < 1) bad("a ref (a whole number from 1)");
        break;
      case "string":
        if (typeof v !== "string") bad("a string");
        if (d.nonEmpty && !v.trim()) bad("a non-empty string");
        if (d.values && !d.values.includes(v)) bad(`one of ${d.values.map((x) => JSON.stringify(x)).join(", ")}`);
        break;
      case "boolean":
        if (typeof v !== "boolean") bad("true or false");
        break;
      case "value": {
        const must = d.check(v);
        if (must) throw new OpError("bad_args", `${name}'s '${k}' must be ${must}`);
        break;
      }
      default:
        throw new Error(`unknown argument type ${d.type}`);
    }
  }
  if (spec.oneOf) {
    const given = spec.oneOf.filter((k) => args[k] !== undefined && args[k] !== null);
    if (given.length !== 1) throw new OpError("bad_args", `${name} needs exactly one of ${spec.oneOf.map((k) => `'${k}'`).join(" and ")}${given.length ? ` (both were given)` : ""}`);
  }
  return args;
}

// Runs operation `name`; resolves to its result or rejects with an OpError.
export async function run(name, args, ctx) {
  const spec = REGISTRY.get(name);
  if (!spec) throw new OpError("unknown_op", `Kai for Firefox ${browser.runtime.getManifest().version} does not serve ${name}; it serves ${served().join(", ")}`);
  const checked = check(name, spec, args);
  ctx.signal.throwIfAborted();
  return spec.run(checked, ctx);
}

// An operation's waiting, ended by `cancel` (an aborted signal) with OpError("cancelled").
export function cancellable(signal, promise) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const cancelled = () => new OpError("cancelled", "Kai cancelled the call");

// What an operation's rejection becomes in `op_result.error`.
export function errorOf(e) {
  if (e instanceof OpError) return { code: e.code, message: e.message, ...(e.extra || {}) };
  if (e && e.name === "AbortError") return { code: "cancelled", message: "Kai cancelled the call" };
  return { code: "internal", message: `Kai for Firefox failed: ${e && e.message ? e.message : String(e)}` };
}

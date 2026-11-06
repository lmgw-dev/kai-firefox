// page.key's `keys`: one key with its modifiers, as "ctrl+k", "shift+Tab", "Escape" or "ä".
// Names are case-insensitive; a single character is the key itself. The answer is what a
// KeyboardEvent carries: key, code, the legacy keyCode and charCode, and the modifiers.

const NAMED = {
  enter: ["Enter", "Enter", 13],
  return: ["Enter", "Enter", 13],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  tab: ["Tab", "Tab", 9],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  del: ["Delete", "Delete", 46],
  insert: ["Insert", "Insert", 45],
  space: [" ", "Space", 32],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  down: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

const MODIFIERS = { ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", option: "alt", meta: "meta", super: "meta", cmd: "meta", command: "meta", win: "meta" };

const NAMES = "Enter, Escape, Tab, Backspace, Delete, Insert, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight (or Up, Down, Left, Right), Home, End, PageUp, PageDown, F1 to F12, or one character";

// { key, code, keyCode, charCode, ctrl, shift, alt, meta, text } or { error } (what is wrong);
// `text` is the chord written the one way ("Ctrl+Shift+K").
export function parseKeys(keys) {
  let mods;
  let name;
  if (keys === "+") {
    mods = [];
    name = "+";
  } else if (keys.endsWith("++")) {
    mods = keys.slice(0, -2).split("+");
    name = "+";
  } else {
    const parts = keys.split("+");
    name = parts.pop();
    mods = parts;
  }
  const m = { ctrl: false, shift: false, alt: false, meta: false };
  for (const raw of mods) {
    const k = MODIFIERS[raw.trim().toLowerCase()];
    if (!k) return { error: `'${raw}' in '${keys}' is no modifier (ctrl, shift, alt, meta)` };
    m[k] = true;
  }
  const trimmed = name === " " ? " " : name.trim();
  let key;
  let code;
  let keyCode;
  let charCode = 0;
  if ([...trimmed].length === 1) {
    key = trimmed;
    if (/^[a-z]$/i.test(key)) {
      code = `Key${key.toUpperCase()}`;
      keyCode = key.toUpperCase().charCodeAt(0);
      key = m.shift ? key.toUpperCase() : key.toLowerCase();
    } else if (/^[0-9]$/.test(key)) {
      code = `Digit${key}`;
      keyCode = key.charCodeAt(0);
    } else if (key === " ") {
      [key, code, keyCode] = NAMED.space;
    } else {
      code = "";
      keyCode = 0;
    }
    if (!m.ctrl && !m.alt && !m.meta) charCode = key.codePointAt(0);
  } else {
    const n = NAMED[trimmed.toLowerCase()];
    if (!n) return { error: `'${name}' is no key Kai for Firefox knows; keys are ${NAMES}` };
    [key, code, keyCode] = n;
    if ((key === "Enter" || key === " ") && !m.ctrl && !m.alt && !m.meta) charCode = keyCode;
  }
  const label = key === " " ? "Space" : key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key;
  const text = [m.ctrl && "Ctrl", m.alt && "Alt", m.shift && "Shift", m.meta && "Meta", label].filter(Boolean).join("+");
  return { key, code, keyCode, charCode, ...m, text };
}

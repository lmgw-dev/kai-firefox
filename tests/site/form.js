// The form page's widgets, each the kind of page code Kai's acting operations meet.
const $ = (id) => document.getElementById(id);

// A controlled input as React keeps it: rendered from state, with a tracker on the element's own
// `value` property. What page code sets through it is not a change; only a value set natively
// and then an input event updates the state.
const state = { name: "" };
const nameEl = $("name");
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let tracked = "";
Object.defineProperty(nameEl, "value", {
  configurable: true,
  get() {
    return native.get.call(this);
  },
  set(v) {
    tracked = String(v);
    native.set.call(this, v);
  },
});
function renderName() {
  nameEl.value = state.name;
  $("greeting").textContent = `Hello, ${state.name || "nobody"}`;
}
nameEl.addEventListener("input", () => {
  const v = native.get.call(nameEl);
  if (v === tracked) return;
  tracked = v;
  state.name = v;
  renderName();
});

// A combobox whose suggestions follow what is typed; it counts its key presses.
const CITIES = ["Berlin", "Bern", "Bergen", "Bremen", "Bonn"];
const city = $("city");
const cities = $("cities");
let cityKeys = 0;
city.addEventListener("keydown", () => ($("city-keys").textContent = String(++cityKeys)));
city.addEventListener("input", () => {
  const q = city.value.toLowerCase();
  const hits = q ? CITIES.filter((c) => c.toLowerCase().startsWith(q)) : [];
  cities.replaceChildren(
    ...hits.map((c) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.textContent = c;
      li.addEventListener("click", () => {
        city.value = c;
        cities.hidden = true;
        city.setAttribute("aria-expanded", "false");
      });
      return li;
    }),
  );
  cities.hidden = !hits.length;
  city.setAttribute("aria-expanded", String(!cities.hidden));
});

// A rich editor that keeps its own model and changes only through beforeinput, as editors built
// on it do; the DOM is rendered from the model.
const note = $("note");
let model = "Leave at the door";
function renderNote() {
  const p = document.createElement("p");
  p.textContent = model;
  note.replaceChildren(p);
  $("note-model").textContent = model;
}
const offsetIn = (node, offset) => {
  const r = document.createRange();
  r.selectNodeContents(note);
  r.setEnd(node, offset);
  return r.toString().length;
};
note.addEventListener("beforeinput", (e) => {
  e.preventDefault();
  const range = e.getTargetRanges()[0] ?? (getSelection().rangeCount ? getSelection().getRangeAt(0) : null);
  let s = model.length;
  let end = model.length;
  if (range) {
    s = offsetIn(range.startContainer, range.startOffset);
    end = offsetIn(range.endContainer, range.endOffset);
  }
  if (e.inputType.startsWith("insert")) model = model.slice(0, s) + (e.data ?? "") + model.slice(end);
  else if (e.inputType.startsWith("delete")) model = s === end ? model.slice(0, Math.max(0, s - 1)) + model.slice(end) : model.slice(0, s) + model.slice(end);
  renderNote();
});
// An editor that takes nothing.
$("stubborn").addEventListener("beforeinput", (e) => e.preventDefault());

$("volume").addEventListener("input", () => ($("volume-out").value = $("volume").value));

// ARIA sliders: arrows step, Home and End go to the ends. Warmth steps by 30.
function slider(el, step) {
  el.addEventListener("keydown", (e) => {
    const min = Number(el.getAttribute("aria-valuemin"));
    const max = Number(el.getAttribute("aria-valuemax"));
    let v = Number(el.getAttribute("aria-valuenow"));
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = Math.min(max, v + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = Math.max(min, v - step);
    else if (e.key === "Home") v = min;
    else if (e.key === "End") v = max;
    else return;
    e.preventDefault();
    el.setAttribute("aria-valuenow", String(v));
    el.textContent = String(v);
  });
}
slider($("bright"), 1);
slider($("warm"), 30);

// A list box whose options are chosen by a click.
for (const o of $("colours").querySelectorAll("[role=option]")) {
  o.addEventListener("click", () => {
    for (const x of $("colours").querySelectorAll("[role=option]")) x.setAttribute("aria-selected", String(x === o));
  });
}
// A switch.
$("news").addEventListener("click", () => {
  const on = $("news").getAttribute("aria-checked") !== "true";
  $("news").setAttribute("aria-checked", String(on));
  $("news").textContent = on ? "on" : "off";
});
// A file input that shows the chosen file's name and size.
$("receipt").addEventListener("change", () => {
  const f = $("receipt").files[0];
  $("receipt-name").textContent = f ? `${f.name} (${f.size} bytes, ${f.type || "no type"})` : "no file";
});

// A list sorted by HTML5 drag and drop: an item dropped on another goes after it.
const showPack = () => ($("pack-order").textContent = [...$("pack").children].map((li) => li.textContent).join(", "));
for (const li of $("pack").children) {
  li.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", li.id));
  li.addEventListener("dragover", (e) => e.preventDefault());
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    const src = $(e.dataTransfer.getData("text/plain"));
    if (src && src !== li) li.after(src);
    showPack();
  });
}
// A list sorted by pointer events, as libraries without HTML5 drag do it: an item released over
// another after the pointer moved goes after it.
let dragging = null;
$("sort").addEventListener("pointerdown", (e) => {
  dragging = e.target.closest("#sort li");
  if (dragging) dragging.dataset.moved = "";
});
document.addEventListener("pointermove", (e) => {
  if (dragging && e.buttons) dragging.dataset.moved = "1";
});
document.addEventListener("pointerup", (e) => {
  if (!dragging) return;
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("#sort li");
  if (over && over !== dragging && dragging.dataset.moved) over.after(dragging);
  dragging = null;
  $("sort-order").textContent = [...$("sort").children].map((li) => li.textContent).join(", ");
});

// A scroll pane.
for (let i = 1; i <= 40; i++) {
  const p = document.createElement("p");
  p.textContent = `Term ${i}: gear goes back within 30 days.`;
  $("pane").append(p);
}

// A menu that opens while the pointer is over its button.
$("account").addEventListener("mouseenter", () => {
  $("menu").hidden = false;
  $("account").setAttribute("aria-expanded", "true");
});
$("account").addEventListener("mouseleave", () => {
  $("menu").hidden = true;
  $("account").setAttribute("aria-expanded", "false");
});

$("open-dialog").addEventListener("click", () => $("address").showModal());
$("close-dialog").addEventListener("click", () => $("address").close());
$("full").addEventListener("click", () => document.documentElement.requestFullscreen().catch(() => {}));

document.addEventListener("keydown", (e) => {
  $("last-key").textContent = `${e.ctrlKey ? "ctrl+" : ""}${e.shiftKey ? "shift+" : ""}${e.key} (${e.keyCode})`;
});

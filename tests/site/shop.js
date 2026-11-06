// A button inside a closed shadow root, labelled from its host's attribute.
customElements.define("shadow-buy", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "closed" });
    const b = document.createElement("button");
    b.textContent = this.getAttribute("label");
    root.append(b);
  }
});
// The consent frame comes from the other origin (localhost vs 127.0.0.1), on the same port.
const other = location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
document.getElementById("consent").src = `http://${other}:${location.port}/consent.html`;

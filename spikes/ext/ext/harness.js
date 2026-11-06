// Helpers the BiDi harness calls in this extension page (it has the full extension API).
window.bg = (cmd) => browser.runtime.sendMessage(cmd);

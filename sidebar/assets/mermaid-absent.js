// Stands in for Mermaid in the sidebar (vendor/mermaid/mermaid.min.js, put here by Trunk.toml's
// post_build hook): lmgw vendors Mermaid as one 5.6 MB script, over the 5 MB a file may have for
// AMO's validator (addons-linter's FILE_TOO_LARGE is an error, and an error stops the signing). The
// Chat's code blocks load this file for a diagram and show what render() throws under the diagram's
// source, so a diagram in the sidebar is its source with this sentence until Mermaid comes in parts.
window.mermaid = {
  initialize() {},
  render() {
    return Promise.reject(new Error("diagrams are not drawn in Kai's sidebar yet; the diagram's source is above"));
  },
};

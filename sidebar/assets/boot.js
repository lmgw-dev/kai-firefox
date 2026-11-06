// Before first paint: light or dark as Firefox's colour scheme says (design §8.5, D8), and again
// whenever it changes. lmgw's kit picks its tokens by <html data-theme>. A classic script file, so
// it runs while <head> is parsed: the page runs no inline script.
// It also counts what the page's policy refused on <html data-csp-violations>, which the tests
// read (a Chat that needs what the policy does not allow shows there first).
(function () {
  "use strict";
  var q = window.matchMedia("(prefers-color-scheme: light)");
  var set = function () {
    document.documentElement.dataset.theme = q.matches ? "light" : "dark";
  };
  set();
  q.addEventListener("change", set);
  var refused = 0;
  document.addEventListener("securitypolicyviolation", function () {
    refused += 1;
    document.documentElement.dataset.cspViolations = String(refused);
  });
})();

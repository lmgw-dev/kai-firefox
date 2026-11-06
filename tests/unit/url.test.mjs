// The origins the background reads from URLs (extension/background/url.js), in Node.
import assert from "node:assert/strict";
import { originOf, siteOf } from "../../extension/background/url.js";

export default [
  {
    name: "url sites: a tab's page by its own origin, Reader view's and view-source's by the page inside; opaque ones none",
    fn() {
      assert.equal(siteOf("https://shop.example/a?b#c"), "https://shop.example");
      assert.equal(siteOf("about:reader?url=https%3A%2F%2Fnews.example%3A8443%2Fstory"), "https://news.example:8443");
      assert.equal(siteOf("view-source:http://127.0.0.1:8080/x"), "http://127.0.0.1:8080");
      assert.equal(siteOf("blob:https://shop.example/1f0c"), "https://shop.example");
      for (const opaque of ["about:blank", "about:reader?x=1", "about:reader?url=data%3Atext%2Fplain%2Cx", "data:text/html,x", "", undefined]) assert.equal(siteOf(opaque), null, String(opaque));
      assert.equal(originOf("about:reader?url=https%3A%2F%2Fnews.example"), null, "originOf reads the URL itself");
    },
  },
];

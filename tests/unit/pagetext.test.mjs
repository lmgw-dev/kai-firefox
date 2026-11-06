// The page's text as the sidebar attaches it (extension/background/pagetext.js), in Node.
import assert from "node:assert/strict";
import { WITHHELD, pageTextLines } from "../../extension/background/pagetext.js";

export default [
  {
    name: "page text for Attach this page: headings, items and frames as Kai's page_text writes them; a none frame's blocks left out",
    fn() {
      const blocks = [
        { text: "Lamps and tents", heading: 1, ref: 5 },
        { text: "Gear for long evenings outside.\nOpen daily." },
        { text: "Two people, three seasons.\nFolds small.", item: true },
        { text: "shop.example uses cookies.", frame: 17179869185, origin: "https://consent.example" },
        { text: "Card number", frame: 17179869186, origin: "https://pay.example" },
        { text: "Expiry", frame: 17179869186, origin: "https://pay.example" },
        { text: "Ads", frame: 17179869187, origin: "https://pay.example" },
        { frame: 17179869188, origin: "https://maps.example:8443", unread: "content_timeout", title: "Map" },
        { frame: 9, origin: null, unread: "restricted_domain", title: "" },
        { text: "Tent\t2.9 kg" },
      ];
      assert.deepEqual(pageTextLines(blocks, (o) => o === "https://pay.example"), [
        "# Lamps and tents",
        "Gear for long evenings outside.",
        "Open daily.",
        "- Two people, three seasons.",
        "  Folds small.",
        "shop.example uses cookies.",
        WITHHELD,
        WITHHELD,
        '(maps.example:8443 "Map" could not be read here: it did not answer within Kai for Firefox\'s setting content_ms)',
        "(a frame without a title could not be read here: Firefox keeps extensions off its site)",
        "Tent\t2.9 kg",
      ]);
      // An opaque frame's origin is "" to the rules.
      assert.deepEqual(pageTextLines([{ text: "x", frame: 3, origin: null }], (o) => o === ""), [WITHHELD]);
      assert.deepEqual(pageTextLines([{ text: "x", frame: 3, origin: null }]), ["x"]);
    },
  },
];

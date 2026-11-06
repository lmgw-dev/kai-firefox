// The speech clean-up rules for reading aloud (extension/background/speech.js), in Node.
import assert from "node:assert/strict";
import { cleanForSpeech, DEFAULT_RULES, RULES, rulesProblem } from "../../extension/background/speech.js";

export default [
  {
    name: "speech rules: the defaults are the read-aloud defaults, superscripts kept",
    fn() {
      assert.deepEqual(DEFAULT_RULES, { hyphens: true, markdown: true, citations: true, superscripts: false, urls: true, symbols: true });
      assert.deepEqual(
        RULES.map((r) => r.id),
        ["hyphens", "markdown", "citations", "superscripts", "urls", "symbols"],
      );
      assert.equal(cleanForSpeech("The hut sits on 1200 m² of meadow."), "The hut sits on 1200 m² of meadow.");
      assert.equal(cleanForSpeech("The hut sits on 1200 m² of meadow.", { superscripts: true }), "The hut sits on 1200 m of meadow.");
    },
  },
  {
    name: "speech rules: citations, markdown, URLs, emoji and hyphenation, each switchable",
    fn() {
      assert.equal(cleanForSpeech("We left at dawn [1] and walked on [12–15] past the hut [a] [iv] [^2] [citation needed]."), "We left at dawn and walked on past the hut.");
      assert.equal(cleanForSpeech("Words in brackets [sic] stay [was] words."), "Words in brackets stay [was] words.");
      assert.equal(cleanForSpeech("**Bold**, _italic_, `code` and [a link](https://shop.example/x)."), "Bold, italic, code and a link.");
      assert.equal(cleanForSpeech("## Packing\n- a lamp\n- a tent"), "Packing\na lamp\na tent");
      assert.equal(cleanForSpeech("Maps at https://maps.example/ridge or www.maps.example, mail trips@journal.example."), "Maps at or mail.");
      assert.equal(cleanForSpeech("It held 🙂 through the storm ★ → fine."), "It held through the storm fine.");
      assert.equal(cleanForSpeech("infor-\nmation and soft\u00ADhyphens"), "information and softhyphens");
      assert.equal(cleanForSpeech("Walked **north** [1].", { markdown: false }), "Walked **north**.");
      assert.equal(cleanForSpeech("Walked **north** [1].", { citations: false }), "Walked north [1].");
      assert.equal(cleanForSpeech("See https://maps.example 🙂", { urls: false, symbols: false }), "See https://maps.example 🙂");
      assert.equal(cleanForSpeech("infor-\nmation", { hyphens: false }), "infor-\nmation");
    },
  },
  {
    name: "speech rules for page text: list numbers and § stay, the hyphen join takes letters of any script; the defaults stay for other text",
    fn() {
      const page = { page: true };
      assert.equal(cleanForSpeech("3. Oktober was the opening day.", {}, page), "3. Oktober was the opening day.");
      assert.equal(cleanForSpeech("1. FC Köln played.\n2) Then the rest.", {}, page), "1. FC Köln played.\n2) Then the rest.");
      assert.equal(cleanForSpeech("Under § 5 of the rules ★.", {}, page), "Under § 5 of the rules.");
      assert.equal(cleanForSpeech("Stra-\nße and Ελλη-\nνικά, a-\n1", {}, page), "Straße and Ελληνικά, a-\n1");
      assert.equal(cleanForSpeech("- a bullet", {}, page), "a bullet");
      // The defaults, for other text.
      assert.equal(cleanForSpeech("3. Oktober was the opening day."), "Oktober was the opening day.");
      assert.equal(cleanForSpeech("Under § 5 of the rules."), "Under 5 of the rules.");
      assert.equal(cleanForSpeech("Stra-\nße"), "Stra-\nße");
    },
  },
  {
    name: "speech rules: nothing is cut, a text the rules empty is empty, `rules` is checked",
    fn() {
      const long = "A sentence that goes on. ".repeat(4000).trim();
      assert.equal(cleanForSpeech(long), long);
      assert.equal(cleanForSpeech("https://maps.example/ridge"), "");
      assert.equal(cleanForSpeech(""), "");
      assert.equal(rulesProblem({ citations: false, superscripts: true }), null);
      assert.equal(rulesProblem({}), null);
      assert.match(rulesProblem({ emoji: false }), /'emoji' is none of them/);
      assert.match(rulesProblem({ urls: "no" }), /'urls' is not/);
      assert.match(rulesProblem(["urls"]), /an object of rules/);
    },
  },
];

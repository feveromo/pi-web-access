import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatFullResults,
  formatSearchSummary,
  isProbablyBinarySearchText,
  sanitizeSearchText,
} from "../search-output.js";

const result = {
  title: "Useful\u0007 result",
  url: "https://example.test/source",
  snippet: "A source-backed snippet with the exact evidence an agent needs.",
  publishedDate: "2026-07-10",
};

test("search output includes sanitized snippets inline and in stored retrieval", () => {
  const inline = formatSearchSummary([result], "", "response-1", 0);
  const full = formatFullResults({
    query: "evidence query",
    answer: "",
    results: [result],
    error: null,
  });

  assert.equal(inline.truncated, false);
  assert.match(inline.text, /Useful result/);
  assert.match(inline.text, /source-backed snippet/);
  assert.match(inline.text, /Published: 2026-07-10/);
  assert.match(full, /source-backed snippet/);
  assert.doesNotMatch(inline.text, /\u0007/);
});

test("search output caps aggregate snippets with a retrieval hint", () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.test/${index}`,
    snippet: "relevant evidence ".repeat(100),
  }));
  const rendered = formatSearchSummary(results, "", "response-2", 3, 900);

  assert.equal(rendered.truncated, true);
  assert.ok(rendered.text.length <= 900);
  assert.match(rendered.text, /get_search_content/);
  assert.match(rendered.text, /response-2/);
});

test("search text sanitizer drops binary-like payloads and keeps unicode", () => {
  const binary = "heading " + "\u0000\u0001\uFFFD\u0002garbled ".repeat(80);
  assert.equal(isProbablyBinarySearchText(binary), true);
  assert.equal(sanitizeSearchText(binary), "");
  assert.match(sanitizeSearchText("Résumé café 日本語\n العربية"), /日本語 العربية/);
});

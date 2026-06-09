import assert from "node:assert/strict";
import { test } from "node:test";

import { isProbablyBinarySearchText, sanitizeSearchText } from "../search-text.ts";

test("search text sanitizer drops binary-like snippets", () => {
  const binaryLike = "Current Trading Halts " + "\u0000\u0001\uFFFD\u0002garbled ".repeat(80);

  assert.equal(isProbablyBinarySearchText(binaryLike), true);
  assert.equal(sanitizeSearchText(binaryLike), "");
});

test("search text sanitizer preserves normal unicode text", () => {
  const normal = "Résumé café 日本語 العربية market update".repeat(12);

  assert.equal(isProbablyBinarySearchText(normal), false);
  assert.match(sanitizeSearchText(normal), /日本語/);
  assert.match(sanitizeSearchText("Alpha\u0007 beta\n gamma"), /^Alpha beta gamma$/);
});

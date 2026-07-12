import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSuccessfulFetchHint } from "../fetch-output.js";

test("mixed fetch guidance recommends successful indexes, never failed index zero", () => {
  const hint = buildSuccessfulFetchHint("response", [
    { error: "HTTP 403" },
    { error: null },
    { error: null },
  ]);
  assert.deepEqual(hint.successfulIndexes, [1, 2]);
  assert.match(hint.text, /urlIndex: 1/);
  assert.match(hint.text, /urlIndexes: \[1, 2\]/);
  assert.doesNotMatch(hint.text, /urlIndex: 0/);
});

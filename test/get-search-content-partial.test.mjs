import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("get_search_content preserves partial retrieval details for single and batch results", () => {
  assert.match(source, /retrievalStatus: urlData\.retrievalStatus/);
  assert.match(source, /extractionWarning: urlData\.metadata\?\.extractionWarning/);
  assert.match(source, /partialIndexes\.push\(index\)/);
  assert.match(source, /partialCount: partialIndexes\.length, partialIndexes/);
});

test("get_search_content renderer uses warning semantics for partial retrievals", () => {
  assert.match(source, /details\?\.retrievalStatus === "partial" \? "warning" : "success"/);
  assert.match(source, /details\.partialCount \?\? 0\) > 0 \? "warning" : "success"/);
  assert.match(source, /\[partial static evidence\]/);
});

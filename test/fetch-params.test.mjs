import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeFetchContentParams } from "../fetch-params.js";

test("fetch params use non-empty unique urls array", () => {
  const normalized = normalizeFetchContentParams({
    url: "https://fallback.test",
    urls: [" https://one.test ", "", "https://one.test", "https://two.test"],
    objective: " focus ",
    queries: [" alpha ", "alpha", ""],
    mode: "highlights",
  });
  assert.deepEqual(normalized.urlList, ["https://one.test", "https://two.test"]);
  assert.equal(normalized.options.objective, "focus");
  assert.deepEqual(normalized.options.queries, ["alpha"]);
  assert.equal(normalized.options.mode, "highlights");
});

test("empty or invalid urls array falls back to singular url", () => {
  assert.deepEqual(normalizeFetchContentParams({ url: " https://fallback.test ", urls: [] }).urlList, ["https://fallback.test"]);
  assert.deepEqual(normalizeFetchContentParams({ url: "https://fallback.test", urls: [null, 3, " "] }).urlList, ["https://fallback.test"]);
});

test("invalid runtime option types are omitted", () => {
  const normalized = normalizeFetchContentParams({ url: 42, urls: "nope", mode: "invalid", maxChars: "10", returnMetadata: "yes" });
  assert.deepEqual(normalized.urlList, []);
  assert.equal(normalized.options.mode, undefined);
  assert.equal(normalized.options.maxChars, undefined);
  assert.equal(normalized.options.returnMetadata, undefined);
});

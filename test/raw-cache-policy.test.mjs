import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approximateRawResultBytes,
  buildRawExtractionCacheKey,
  shouldCacheRawExtraction,
} from "../raw-cache-policy.js";

test("raw cache key isolates extraction timeouts but excludes shaping fields", () => {
  const base = "https://example.test/article";
  const short = buildRawExtractionCacheKey(base, { timeoutMs: 1000, mode: "full", maxChars: 100 });
  const long = buildRawExtractionCacheKey(base, { timeoutMs: 2000, mode: "summary", maxChars: 900 });
  const reshaped = buildRawExtractionCacheKey(base, { timeoutMs: 1000, mode: "highlights", maxChars: 999 });
  assert.notEqual(short, long);
  assert.equal(short, reshaped);
});

test("raw cache policy excludes GitHub, allowRanges, credentials, and signed URLs", () => {
  assert.equal(buildRawExtractionCacheKey("https://github.com/owner/private"), null);
  assert.equal(buildRawExtractionCacheKey("https://raw.githubusercontent.com/owner/repo/main/file"), null);
  assert.equal(buildRawExtractionCacheKey("https://example.test/", {}, ["10.0.0.0/8"]), null);
  assert.equal(buildRawExtractionCacheKey("https://user:pass@example.test/"), null);
  assert.equal(buildRawExtractionCacheKey("https://example.test/?token=secret"), null);
});

test("raw cache admission rejects sensitive redirect destinations", () => {
  const publicResult = { url: "https://example.test/start", fetchedUrl: "https://cdn.example.test/final", content: "ok", error: null };
  assert.equal(shouldCacheRawExtraction(publicResult), true);
  assert.equal(shouldCacheRawExtraction({ ...publicResult, fetchedUrl: "https://cdn.example.test/final?signature=secret" }), false);
  assert.equal(shouldCacheRawExtraction({ ...publicResult, fetchedUrl: "http://127.0.0.1/private" }), false);
  assert.equal(shouldCacheRawExtraction(publicResult, ["10.0.0.0/8"]), false);
});

test("raw cache byte estimate includes retained metadata and provenance", () => {
  const result = { url: "https://example.test", content: "x", error: null, metadata: { large: "m".repeat(500) } };
  assert.ok(approximateRawResultBytes(result) > 500);
});

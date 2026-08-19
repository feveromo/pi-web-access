import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8");
}

test("manual regression checklist matches the lean fork", () => {
  const checklist = read("eval/web-access-checklist.md");

  for (const stale of [
    "workflow: \"none\"",
    "YouTube prompt/frame",
    "media binaries",
  ]) {
    assert.equal(checklist.includes(stale), false, `stale checklist text: ${stale}`);
  }

  assert.match(checklist, /Long content durability/);
  assert.match(checklist, /disk-backed/);
  assert.match(checklist, /Stored-content batch retrieval/);
  assert.match(checklist, /urlIndexes/);
  assert.match(checklist, /Current\/status search guardrail/);
});

test("package ships tools only, no bundled skills", () => {
  assert.equal(existsSync(new URL("../skills", import.meta.url)), false);
});

test("Pi widget clearing uses the current undefined API contract", () => {
  const index = read("index.ts");
  assert.match(index, /setWidget\("web-activity", undefined\)/);
  assert.doesNotMatch(index, /setWidget\("web-activity", null\)/);
});

test("raw extraction caching stays below local shaping and excludes sensitive URLs", () => {
  const extract = read("extract.ts");
  const persistent = read("raw-persistent-cache.js");
  assert.match(extract, /if \(!key\) return shapeExtractedContent\(await extractRawContent/);
  assert.match(extract, /decorateRawCacheResult\(cached\.value/);
  assert.match(extract, /buildRawExtractionCacheKey\(url/);
  assert.match(persistent, /shouldCacheRawExtraction\(result, allowRanges\(\)\)/);
  assert.match(persistent, /sizeOf: approximateRawResultBytes/);
  assert.match(persistent, /memoryMaxEntries: 50, memoryMaxBytes: 20 \* 1024 \* 1024/);
  assert.match(persistent, /namespace: "raw-fetch"/);
  assert.match(persistent, /staleMs: 24 \* 60 \* 60 \* 1000/);
  assert.match(extract, /const originCache = cacheFreshnessFromHeaders\(response\.headers\)/);
  assert.match(extract, /transportError:/);
});

test("fetch extraction uses bounded direct and strict third-party SSRF boundaries", () => {
  const extract = read("extract.ts");
  assert.match(extract, /if \(parseGitHubUrl\(url\)\)/);
  assert.match(extract, /await validateRemoteUrl\(parsedUrl/);
  assert.match(extract, /signal: requestSignal\(signal, normalizeTimeoutMs/);
  assert.match(extract, /await validateThirdPartySourceUrl\(url/);
  assert.match(extract, /const response = await fetchRemoteUrl\(url/);
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearResults, getAllResults, restoreFromSession } from "../storage.ts";

function entry(data) {
  return { type: "custom", customType: "web-search-results", data };
}

test("session restore accepts valid results and ignores malformed or future entries", () => {
  const now = Date.now();
  const valid = {
    id: "valid-search",
    type: "search",
    timestamp: now,
    queries: [{
      query: "test",
      answer: "",
      error: null,
      results: [{ title: "Result", url: "https://example.test", snippet: "Evidence" }],
    }],
  };
  const malformedFetch = {
    id: "bad-fetch",
    type: "fetch",
    timestamp: now,
    urls: [null],
  };
  const malformedSearch = {
    id: "bad-search",
    type: "search",
    timestamp: now,
    queries: [{ query: "oops", answer: "", error: null, results: [null] }],
  };
  const future = { ...valid, id: "future", timestamp: now + 120_000 };
  const unsafeId = { ...valid, id: "../valid-search" };
  const ctx = {
    sessionManager: {
      getBranch: () => [entry(malformedFetch), entry(malformedSearch), entry(future), entry(unsafeId), entry(valid)],
    },
  };

  restoreFromSession(ctx);
  assert.deepEqual(getAllResults().map(result => result.id), ["valid-search"]);
  clearResults();
});

test("deleting a stored result removes its externalized content", async () => {
  const originalDir = process.env.PI_WEB_ACCESS_CONTENT_DIR;
  const contentDir = mkdtempSync(join(tmpdir(), "pi-web-access-content-"));
  process.env.PI_WEB_ACCESS_CONTENT_DIR = contentDir;
  try {
    const storage = await import(`../storage.ts?delete=${Date.now()}-${Math.random()}`);
    const id = "delete-test";
    const data = {
      id,
      type: "fetch",
      timestamp: Date.now(),
      urls: [{ url: "https://example.test", title: "Large", content: "x".repeat(25_000), error: null }],
    };
    const stored = storage.prepareStoredDataForSession(id, data);
    const path = stored.urls[0].contentRef.path;
    storage.storeResult(id, stored);
    assert.equal(existsSync(path), true);
    assert.equal(storage.deleteResult(id), true);
    assert.equal(existsSync(path), false);
  } finally {
    if (originalDir === undefined) delete process.env.PI_WEB_ACCESS_CONTENT_DIR;
    else process.env.PI_WEB_ACCESS_CONTENT_DIR = originalDir;
    rmSync(contentDir, { recursive: true, force: true });
  }
});

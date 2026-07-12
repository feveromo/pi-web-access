import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const researchCacheDir = mkdtempSync(join(tmpdir(), "pi-web-access-storage-cache-"));
process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR = researchCacheDir;
const { clearResults, flushStoragePersistence, getAllResults, getStoredResult, restoreFromSession, storeResult } = await import("../storage.ts");
after(async () => {
  await flushStoragePersistence();
  rmSync(researchCacheDir, { recursive: true, force: true });
});

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

test("live stored results are bounded and stale entries are pruned", async () => {
  clearResults();
  for (let i = 0; i < 140; i++) {
    storeResult(`bounded-${i}`, {
      id: `bounded-${i}`,
      type: "search",
      timestamp: Date.now(),
      queries: [{ query: `q${i}`, answer: "", error: null, results: [] }],
    });
  }
  assert.ok(getAllResults().length <= 100);
  storeResult("stale", { id: "stale", type: "search", timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, queries: [] });
  assert.equal(await getStoredResult("stale"), null);
  clearResults();
  for (let i = 0; i < 20; i++) {
    storeResult(`bytes-${i}`, {
      id: `bytes-${i}`, type: "fetch", timestamp: Date.now(),
      urls: [{ url: `https://${i}.test`, title: "Large", content: "x".repeat(500_000), error: null }],
    });
  }
  assert.ok(getAllResults().length < 20, "approximate byte budget evicts oldest live entries");
  clearResults();
});

test("selected fetch hydration reads only the selected externalized item", async () => {
  const originalDir = process.env.PI_WEB_ACCESS_CONTENT_DIR;
  const contentDir = mkdtempSync(join(tmpdir(), "pi-web-access-lazy-"));
  process.env.PI_WEB_ACCESS_CONTENT_DIR = contentDir;
  try {
    const storage = await import(`../storage.ts?lazy=${Date.now()}-${Math.random()}`);
    const data = {
      id: "lazy-test", type: "fetch", timestamp: Date.now(),
      urls: [
        { url: "https://one.test", title: "One", content: "a".repeat(25_000), error: null },
        { url: "https://two.test", title: "Two", content: "b".repeat(25_000), error: null },
      ],
    };
    const stored = await storage.prepareStoredDataForSession(data.id, data);
    storage.storeResult(data.id, stored);
    const raw = await storage.getStoredResult(data.id);
    assert.match(raw.urls[0].content, /Full content stored outside/);
    const selected = await storage.hydrateStoredFetchItem(raw.urls[0]);
    assert.equal(selected.content.length, 25_000);
    assert.match(raw.urls[1].content, /Full content stored outside/, "unselected item remains unhydrated");
  } finally {
    if (originalDir === undefined) delete process.env.PI_WEB_ACCESS_CONTENT_DIR;
    else process.env.PI_WEB_ACCESS_CONTENT_DIR = originalDir;
    rmSync(contentDir, { recursive: true, force: true });
  }
});

test("responseId records persist across module reloads and explicit deletion removes the record", async () => {
  const id = `persist-${Date.now()}`;
  storeResult(id, { id, type: "search", timestamp: Date.now(), queries: [{ query: "durable", answer: "", error: null, results: [] }] });
  await flushStoragePersistence();
  const envelope = JSON.parse(readFileSync(join(researchCacheDir, readdirSync(researchCacheDir).find(name => name.startsWith("response-"))), "utf8"));
  assert.equal(envelope.freshUntil - envelope.storedAt, 7 * 24 * 60 * 60 * 1000);
  assert.equal(envelope.staleUntil, envelope.freshUntil);
  clearResults();
  const reloaded = await import(`../storage.ts?reload=${Date.now()}-${Math.random()}`);
  assert.equal((await reloaded.getStoredResult(id))?.queries?.[0]?.query, "durable");
  assert.equal(await reloaded.deleteResult(id), true);
  reloaded.clearResults();
  const afterDelete = await import(`../storage.ts?deleted=${Date.now()}-${Math.random()}`);
  assert.equal(await afterDelete.getStoredResult(id), null);
});

test("response cache rejects an envelope whose value id does not match the lookup key", async () => {
  const id = `bound-${Date.now()}`;
  storeResult(id, { id, type: "search", timestamp: Date.now(), queries: [] });
  await flushStoragePersistence();
  const file = readdirSync(researchCacheDir).find(name => name.startsWith("response-") && JSON.parse(readFileSync(join(researchCacheDir, name), "utf8")).value.id === id);
  const path = join(researchCacheDir, file);
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...envelope, value: { ...envelope.value, id: "different-id" } }));
  clearResults();
  const reloaded = await import(`../storage.ts?forged-id=${Date.now()}-${Math.random()}`);
  assert.equal(await reloaded.getStoredResult(id), null);
  await reloaded.deleteResult(id);
});

test("externalized batches prune once and protect every current reference", async () => {
  const original = process.env.PI_WEB_ACCESS_CONTENT_DIR;
  const contentRoot = mkdtempSync(join(tmpdir(), "pi-web-access-content-quota-"));
  process.env.PI_WEB_ACCESS_CONTENT_DIR = contentRoot;
  try {
    const storage = await import(`../storage.ts?batch-quota=${Date.now()}-${Math.random()}`);
    const urls = Array.from({ length: 1001 }, (_, index) => ({ url: `https://${index}.test`, title: String(index), content: `${index}:` + "x".repeat(24_500), error: null }));
    const current = await storage.prepareStoredDataForSession("protected-batch", { id: "protected-batch", type: "fetch", timestamp: Date.now(), urls });
    assert.equal(current.urls.filter(item => item.contentRef && existsSync(item.contentRef.path)).length, 1001);
    const next = await storage.prepareStoredDataForSession("next-batch", { id: "next-batch", type: "fetch", timestamp: Date.now(), urls: [{ url: "https://next.test", title: "next", content: "n".repeat(25_000), error: null }] });
    assert.equal(existsSync(next.urls[0].contentRef.path), true);
    const count = readdirSync(contentRoot).flatMap(dir => { try { return readdirSync(join(contentRoot, dir)); } catch { return []; } }).filter(name => /^\d+-[a-f0-9]{12}\.md$/.test(name)).length;
    assert.ok(count <= 1000);
  } finally {
    if (original === undefined) delete process.env.PI_WEB_ACCESS_CONTENT_DIR; else process.env.PI_WEB_ACCESS_CONTENT_DIR = original;
    rmSync(contentRoot, { recursive: true, force: true });
  }
});

test("content root and response-directory symlinks never touch external victims", async () => {
  const victim = mkdtempSync(join(tmpdir(), "pi-web-access-content-victim-"));
  const parent = mkdtempSync(join(tmpdir(), "pi-web-access-content-link-"));
  const linkedRoot = join(parent, "content");
  writeFileSync(join(victim, "sentinel"), "untouched");
  symlinkSync(victim, linkedRoot);
  const original = process.env.PI_WEB_ACCESS_CONTENT_DIR;
  process.env.PI_WEB_ACCESS_CONTENT_DIR = linkedRoot;
  try {
    const linked = await import(`../storage.ts?root-symlink=${Date.now()}-${Math.random()}`);
    const data = { id: "root-link", type: "fetch", timestamp: Date.now(), urls: [{ url: "https://example.test", title: "Large", content: "x".repeat(25_000), error: null }] };
    const stored = await linked.prepareStoredDataForSession(data.id, data);
    assert.equal(stored.urls[0].contentRef, undefined);
    assert.equal(readFileSync(join(victim, "sentinel"), "utf8"), "untouched");

    const realRoot = mkdtempSync(join(tmpdir(), "pi-web-access-content-real-"));
    process.env.PI_WEB_ACCESS_CONTENT_DIR = realRoot;
    symlinkSync(victim, join(realRoot, "child-link"));
    const childLinked = await import(`../storage.ts?child-symlink=${Date.now()}-${Math.random()}`);
    const childData = { ...data, id: "child-link" };
    const childStored = await childLinked.prepareStoredDataForSession(childData.id, childData);
    assert.equal(childStored.urls[0].contentRef, undefined);
    assert.equal(await childLinked.deleteResult(childData.id), false);
    assert.equal(readFileSync(join(victim, "sentinel"), "utf8"), "untouched");
    rmSync(realRoot, { recursive: true, force: true });
  } finally {
    if (original === undefined) delete process.env.PI_WEB_ACCESS_CONTENT_DIR; else process.env.PI_WEB_ACCESS_CONTENT_DIR = original;
    rmSync(parent, { recursive: true, force: true }); rmSync(victim, { recursive: true, force: true });
  }
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
    const stored = await storage.prepareStoredDataForSession(id, data);
    const path = stored.urls[0].contentRef.path;
    storage.storeResult(id, stored);
    assert.equal(existsSync(path), true);
    assert.equal(await storage.deleteResult(id), true);
    assert.equal(existsSync(path), false);
  } finally {
    if (originalDir === undefined) delete process.env.PI_WEB_ACCESS_CONTENT_DIR;
    else process.env.PI_WEB_ACCESS_CONTENT_DIR = originalDir;
    rmSync(contentDir, { recursive: true, force: true });
  }
});

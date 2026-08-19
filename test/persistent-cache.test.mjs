import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-web-access-persistent-cache-"));
process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR = root;
const module = await import(`../persistent-cache.js?test=${Date.now()}`);
const { cacheFreshnessFromHeaders, createPersistentCache, isTransientCacheError } = module;
after(() => rmSync(root, { recursive: true, force: true }));

function cache(namespace, options = {}) {
  return createPersistentCache({ namespace, root, freshMs: 1000, staleMs: 5000, maxEntries: 10, maxBytes: 100_000, validate: value => typeof value?.text === "string", ...options });
}

test("Cache-Control and transient classification are explicit", () => {
  const headers = value => new Headers({ "cache-control": value });
  assert.deepEqual(cacheFreshnessFromHeaders(headers("no-store")), { persist: false, freshMs: 0 });
  assert.deepEqual(cacheFreshnessFromHeaders(headers("private, max-age=100")), { persist: false, freshMs: 0 });
  assert.deepEqual(cacheFreshnessFromHeaders(headers("no-cache, max-age=100")), { persist: true, freshMs: 0 });
  assert.equal(cacheFreshnessFromHeaders(headers("s-maxage=999999")).freshMs, 24 * 60 * 60 * 1000);
  assert.equal(isTransientCacheError(Object.assign(new Error("socket words alone"), {})), false);
  assert.equal(isTransientCacheError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), true);
  assert.equal(isTransientCacheError(Object.assign(new Error("bad input"), { status: 400 })), false);
});

test("persistent cache serves deterministic memory and module-reload disk hits", async () => {
  const first = cache("fresh-hit");
  let calls = 0;
  const loaded = await first.get("key", async () => ({ text: `value-${++calls}` }));
  const memory = await first.get("key", async () => ({ text: `value-${++calls}` }));
  assert.equal(loaded.metadata.status, "miss");
  assert.equal(memory.metadata.storage, "memory");
  assert.equal(calls, 1);

  const reloadedModule = await import(`../persistent-cache.js?reload=${Date.now()}-${Math.random()}`);
  const reloaded = reloadedModule.createPersistentCache({ namespace: "fresh-hit", root, freshMs: 1000, staleMs: 5000, validate: value => typeof value?.text === "string" });
  const disk = await reloaded.get("key", async () => ({ text: `value-${++calls}` }));
  assert.equal(disk.metadata.storage, "disk");
  assert.equal(disk.value.text, "value-1");
  assert.equal(calls, 1);
});

test("stale entries refresh successfully or fall back only on transient errors with a warning", async () => {
  const c = cache("stale-flow");
  const old = Date.now() - 2000;
  await c.set("refresh", { text: "old" }, { now: old, freshMs: 1000, staleMs: 5000 });
  const refreshed = await c.get("refresh", async () => ({ text: "new" }));
  assert.equal(refreshed.value.text, "new");
  assert.equal(refreshed.metadata.status, "miss");

  await c.set("fallback", { text: "stale" }, { now: old, freshMs: 1000, staleMs: 5000 });
  const fallback = await c.get("fallback", async () => { throw Object.assign(new Error("upstream unavailable"), { status: 503 }); });
  assert.equal(fallback.metadata.status, "stale");
  assert.match(fallback.metadata.warning, /transient refresh failure/i);
  await assert.rejects(c.get("fallback", async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); }), /unauthorized/);
  await c.set("timeout", { text: "stale timeout" }, { now: old, freshMs: 1000, staleMs: 5000 });
  const timeoutFallback = await c.get("timeout", async () => { throw Object.assign(new Error("request expired"), { code: "ETIMEDOUT" }); });
  assert.equal(timeoutFallback.metadata.status, "stale");
});

test("hard expiry, corruption, and version mismatches miss without returning untrusted values", async () => {
  const c = cache("invalid-data");
  await c.set("expired", { text: "old" }, { now: Date.now() - 10_000, freshMs: 1000, staleMs: 2000 });
  assert.equal((await c.lookup("expired")).state, "miss");

  await c.set("corrupt", { text: "safe" });
  c.clearMemory();
  writeFileSync(c.pathForKey("corrupt"), "not json");
  assert.equal((await c.lookup("corrupt")).state, "miss");

  await c.set("version", { text: "safe" });
  c.clearMemory();
  const path = c.pathForKey("version");
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...envelope, version: 999 }));
  assert.equal((await c.lookup("version")).state, "miss");
  assert.equal(existsSync(path), false);
});

test("coalesced loaders isolate aborting waiters and replace orphaned tasks", async () => {
  const c = cache("abort-flow");
  let calls = 0;
  let release;
  const loader = signal => new Promise((resolve, reject) => {
    calls++;
    release = () => resolve({ text: "done" });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const controller = new AbortController();
  const abandoned = c.get("shared", loader, { signal: controller.signal });
  const survivor = c.get("shared", loader);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release();
  await assert.rejects(abandoned, error => error?.name === "AbortError");
  assert.equal((await survivor).value.text, "done");
  assert.equal(calls, 1);
});

test("a symlink cache root never reads, writes, prunes, or deletes the external victim", async () => {
  const victim = mkdtempSync(join(tmpdir(), "pi-web-access-cache-victim-"));
  const linkedRoot = join(root, "linked-root");
  symlinkSync(victim, linkedRoot);
  try {
    const c = createPersistentCache({ namespace: "symlink-root", root: linkedRoot, freshMs: 1000, staleMs: 5000, validate: value => typeof value?.text === "string" });
    assert.equal(await c.set("key", { text: "memory only" }), false);
    assert.equal(readdirSync(victim).length, 0);
    assert.equal((await c.lookup("key")).value.text, "memory only");
    await c.delete("key");
    await c.prune();
    assert.equal(readdirSync(victim).length, 0);
  } finally { rmSync(victim, { recursive: true, force: true }); }
});

test("count/byte pruning removes only exact owned regular files", async () => {
  const c = cache("quota", { maxEntries: 2, maxBytes: 5000, pruneCadence: 1000 });
  const unrelated = join(root, "user-settings.json");
  const lookalike = join(root, `quota-${"a".repeat(64)}.cache.json.backup`);
  const symlink = join(root, `quota-${"b".repeat(64)}.cache.json`);
  writeFileSync(unrelated, "keep");
  writeFileSync(lookalike, "keep");
  symlinkSync(unrelated, symlink);
  for (let i = 0; i < 4; i++) await c.set(`key-${i}`, { text: `value-${i}` });
  assert.equal(readdirSync(root).filter(name => /^quota-[a-f0-9]{64}\.cache\.json$/.test(name) && name !== symlink.split("/").pop()).length, 2, "successful writes await automatic quota enforcement");
  assert.equal(readFileSync(unrelated, "utf8"), "keep");
  assert.equal(readFileSync(lookalike, "utf8"), "keep");
  assert.equal(existsSync(symlink), true);
});

test("multiple cache instances converge to namespace quota after concurrent writes", async () => {
  const a = cache("multi-instance", { maxEntries: 3, pruneCadence: 1000 });
  const b = cache("multi-instance", { maxEntries: 3, pruneCadence: 1000 });
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).set(`key-${index}`, { text: `value-${index}` })));
  const owned = readdirSync(root).filter(name => /^multi-instance-[a-f0-9]{64}\.cache\.json$/.test(name));
  assert.ok(owned.length <= 3);
});

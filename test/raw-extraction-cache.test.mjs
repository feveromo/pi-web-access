import assert from "node:assert/strict";
import { test } from "node:test";
import { createRawExtractionCache } from "../raw-extraction-cache.js";

function cache(options = {}) {
  return createRawExtractionCache({ ttlMs: 1000, maxEntries: 3, maxBytes: 100, sizeOf: value => value.length, ...options });
}

test("raw extraction cache reuses values and reports age", async () => {
  const c = cache();
  let calls = 0;
  const load = async () => { calls++; return "raw source"; };
  const first = await c.get("url", load);
  const second = await c.get("url", load);
  assert.equal(calls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.value, "raw source");
});

test("raw extraction cache collapses concurrent loads with abort-isolated waiters", async () => {
  const c = cache();
  let calls = 0;
  let release;
  const load = signal => new Promise((resolve, reject) => {
    calls++;
    release = () => resolve("raw");
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const aborted = new AbortController();
  const first = c.get("url", load, aborted.signal);
  const second = c.get("url", load);
  await new Promise(resolve => setImmediate(resolve));
  aborted.abort();
  release();
  await assert.rejects(first, err => err?.name === "AbortError");
  assert.equal((await second).value, "raw");
  assert.equal(calls, 1);
});

test("raw extraction cache does not retain a result after every waiter aborts", async () => {
  const c = cache();
  const controller = new AbortController();
  const pending = c.get("url", async () => {
    await new Promise(resolve => setImmediate(resolve));
    return "late";
  }, controller.signal);
  controller.abort();
  await assert.rejects(pending, err => err?.name === "AbortError");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.stats().entries, 0);
});

test("raw extraction cache returns but does not retain values rejected by admission policy", async () => {
  let calls = 0;
  const c = cache({ shouldCache: value => value !== "sensitive" });
  assert.equal((await c.get("url", async () => { calls++; return "sensitive"; })).value, "sensitive");
  assert.equal((await c.get("url", async () => { calls++; return "sensitive"; })).value, "sensitive");
  assert.equal(calls, 2);
  assert.equal(c.stats().entries, 0);
});

test("raw extraction cache returns successful values when admission checks fail", async () => {
  const c = cache({ shouldCache: () => { throw new Error("config changed"); } });
  assert.equal((await c.get("url", async () => "success")).value, "success");
  assert.equal(c.stats().entries, 0);
});

test("raw extraction cache byte eviction uses the supplied whole-value size", async () => {
  const c = createRawExtractionCache({
    ttlMs: 1000, maxEntries: 10, maxBytes: 30,
    sizeOf: value => Buffer.byteLength(JSON.stringify(value)),
  });
  await c.get("a", async () => ({ content: "x", metadata: "m".repeat(20) }));
  assert.equal(c.stats().entries, 0, "whole retained object exceeds the byte budget even though content is tiny");
});

test("raw extraction cache evicts by count and bytes and never caches failures", async () => {
  const c = cache({ maxEntries: 2, maxBytes: 5 });
  await c.get("a", async () => "aa");
  await c.get("b", async () => "bb");
  await c.get("c", async () => "cc");
  assert.equal(c.stats().entries, 2);
  let calls = 0;
  await assert.rejects(c.get("bad", async () => { calls++; throw new Error("bad"); }), /bad/);
  await assert.rejects(c.get("bad", async () => { calls++; throw new Error("bad"); }), /bad/);
  assert.equal(calls, 2);
});

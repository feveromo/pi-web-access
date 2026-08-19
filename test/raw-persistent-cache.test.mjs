import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cacheFreshnessFromHeaders } from "../persistent-cache.js";
import { createRawPersistentCache, decorateRawCacheResult } from "../raw-persistent-cache.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-access-raw-integration-"));
after(() => rmSync(root, { recursive: true, force: true }));
const result = (url, policy) => ({ url, fetchedUrl: url, title: "Public", content: "public extracted content", error: null, method: "readability", metadata: { originCache: policy } });
const policy = value => cacheFreshnessFromHeaders(new Headers(value ? { "cache-control": value } : {}));

async function load(cache, key, url, directive) {
  const origin = policy(directive);
  return cache.get(key, async () => ({ value: result(url, origin), persist: origin.persist, freshMs: origin.freshMs, staleMs: 24 * 60 * 60 * 1000 }));
}

test("raw cache applies origin freshness, default TTL, persistence reload, and exclusions", async () => {
  const cache = createRawPersistentCache({ root });
  await load(cache, "max-age", "https://example.test/max", "max-age=120");
  await load(cache, "default", "https://example.test/default", "");
  const envelopes = readdirSync(root).map(name => JSON.parse(readFileSync(join(root, name), "utf8")));
  const maxAge = envelopes.find(envelope => envelope.value.url.endsWith("/max"));
  const defaulted = envelopes.find(envelope => envelope.value.url.endsWith("/default"));
  assert.equal(maxAge.freshUntil - maxAge.storedAt, 120_000);
  assert.equal(defaulted.freshUntil - defaulted.storedAt, 6 * 60 * 60 * 1000);

  const reloaded = createRawPersistentCache({ root });
  const disk = await reloaded.get("max-age", async () => { throw new Error("must not reload"); });
  assert.equal(disk.metadata.storage, "disk");
  assert.equal(disk.metadata.status, "fresh");
  assert.ok(disk.metadata.ageMs >= 0);

  await load(cache, "no-store", "https://example.test/no-store", "no-store");
  await load(cache, "private", "https://example.test/private", "private");
  await load(cache, "signed", "https://example.test/file?X-Amz-Signature=secret", "max-age=600");
  const files = readdirSync(root).map(name => JSON.parse(readFileSync(join(root, name), "utf8")).value.url);
  assert.equal(files.some(url => url.includes("no-store") || url.includes("private") || url.includes("X-Amz-Signature")), false);
});

test("no-cache is stale-only and timeout fallback is visibly warned while non-transient errors reject", async () => {
  const cache = createRawPersistentCache({ root });
  const url = "https://example.test/no-cache";
  const warm = await load(cache, "no-cache", url, "no-cache");
  assert.equal(warm.metadata.freshUntil, warm.metadata.staleUntil - 24 * 60 * 60 * 1000);
  const timeout = await cache.get("no-cache", async () => { throw Object.assign(new Error("request expired"), { code: "ETIMEDOUT" }); });
  assert.equal(timeout.metadata.status, "stale");
  assert.ok(timeout.metadata.ageMs >= 0);
  const decorated = decorateRawCacheResult(timeout.value, timeout.metadata);
  assert.match(decorated.content, /WARNING: STALE CACHE/);
  await assert.rejects(cache.get("no-cache", async () => { throw Object.assign(new Error("bad request"), { status: 400 }); }), /bad request/);
});

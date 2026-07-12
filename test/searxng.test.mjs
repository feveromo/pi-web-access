import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatSearchCacheWarning } from "../search-output.js";

const cacheDir = mkdtempSync(join(tmpdir(), "pi-web-access-searxng-"));
process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR = cacheDir;
after(() => rmSync(cacheDir, { recursive: true, force: true }));

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SEARXNG_URL;
const originalHelper = process.env.SEARXNG_START_HELPER;

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = originalUrl;
  if (originalHelper === undefined) delete process.env.SEARXNG_START_HELPER;
  else process.env.SEARXNG_START_HELPER = originalHelper;
}

async function loadSearx(label) {
  process.env.SEARXNG_URL = `http://${label}.test:8888`;
  delete process.env.SEARXNG_START_HELPER;
  return import(`../searxng.ts?${label}-${Date.now()}-${Math.random()}`);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("web search adaptive freshness policy matches each recency window", async () => {
  const { webSearchFreshnessMs } = await loadSearx("ttl-policy");
  assert.equal(webSearchFreshnessMs(undefined), 24 * 60 * 60 * 1000);
  assert.equal(webSearchFreshnessMs("day"), 10 * 60 * 1000);
  assert.equal(webSearchFreshnessMs("week"), 60 * 60 * 1000);
  assert.equal(webSearchFreshnessMs("month"), 6 * 60 * 60 * 1000);
  assert.equal(webSearchFreshnessMs("year"), 24 * 60 * 60 * 1000);
});

test("web search persists across reloads and stale-falls back only on transient HTTP errors", async () => {
  const original = globalThis.fetch;
  const label = `persistent-${Date.now()}`;
  const query = `durable query ${Date.now()}`;
  const payload = { results: [{ title: "Durable", url: "https://example.test/durable", content: "Persistent result" }] };
  try {
    let calls = 0;
    globalThis.fetch = async url => { calls++; return String(url).endsWith("/") ? new Response("ok") : jsonResponse(payload); };
    const warmModule = await loadSearx(label);
    const warm = await warmModule.searxngSearch(query);
    assert.equal(warm.metadata.cache.status, "miss");
    const file = readdirSync(cacheDir).find(name => name.startsWith("web-search-") && name.endsWith(".cache.json"));
    const path = join(cacheDir, file);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(envelope.staleUntil - envelope.storedAt, 7 * 24 * 60 * 60 * 1000);

    globalThis.fetch = async () => { throw new Error("disk reload must not fetch"); };
    const diskModule = await loadSearx(label);
    const disk = await diskModule.searxngSearch(query);
    assert.equal(disk.metadata.cache.storage, "disk");
    assert.equal(disk.metadata.cache.status, "fresh");

    const storedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const staleEnvelope = { ...envelope, storedAt, freshUntil: storedAt + 24 * 60 * 60 * 1000, staleUntil: storedAt + 7 * 24 * 60 * 60 * 1000 };
    writeFileSync(path, JSON.stringify(staleEnvelope));
    globalThis.fetch = async url => String(url).endsWith("/") ? new Response("ok") : new Response("unavailable", { status: 503 });
    const staleModule = await loadSearx(label);
    const stale = await staleModule.searxngSearch(query);
    assert.equal(stale.metadata.cache.status, "stale");
    assert.ok(stale.metadata.cache.ageMs >= 2 * 24 * 60 * 60 * 1000);
    assert.match(formatSearchCacheWarning(stale.metadata), /WARNING: stale cached search results/);

    writeFileSync(path, JSON.stringify(staleEnvelope));
    globalThis.fetch = async url => String(url).endsWith("/") ? new Response("ok") : new Response("bad request", { status: 400 });
    const rejectedModule = await loadSearx(label);
    await assert.rejects(rejectedModule.searxngSearch(query), /HTTP 400/);
  } finally { globalThis.fetch = original; }
});

test("SearXNG maps, sanitizes, deduplicates, filters, and caches results", async () => {
  const calls = [];
  try {
    globalThis.fetch = async url => {
      const requested = new URL(String(url));
      calls.push(requested);
      if (requested.pathname === "/") return new Response("ok");
      assert.equal(requested.pathname, "/search");
      return jsonResponse({
        results: [
          { title: "Primary\u0007 source", url: "https://Example.test/Path/?utm_source=test#part", content: "Exact snippet.", engines: ["duckduckgo"] },
          { title: "Duplicate", url: "https://example.test/Path", content: "duplicate" },
          { title: "Case-sensitive path", url: "https://example.test/path", content: "Distinct path.", engine: "startpage", publishedDate: "2026-07-10" },
          { title: "Unsafe", url: "ftp://example.test/file", content: "ignore" },
        ],
        unresponsive_engines: [["google", "timeout"]],
      });
    };

    const { searxngSearch } = await loadSearx("mapping");
    const options = {
      numResults: 20,
      recencyFilter: "month",
      domainFilter: ["example.test", "https://docs.test/path", "EXAMPLE.TEST", "-noise.test", "bad domain query"],
    };
    const first = await searxngSearch("  useful query  ", options);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].searchParams.get("q"), "useful query (site:example.test OR site:docs.test) -site:noise.test");
    assert.equal(calls[1].searchParams.get("time_range"), "month");
    assert.equal(calls[1].searchParams.get("categories"), "general,news");
    assert.equal(first.results.length, 2);
    assert.equal(first.results[0].publishedDate, "2026-07-10", "dated result should be surfaced first for recency searches");
    assert.equal(first.results[1].title, "Primary source");
    assert.equal(first.results[1].snippet, "Exact snippet.");
    assert.deepEqual(first.metadata.engines, ["duckduckgo", "startpage"]);
    assert.equal(first.metadata.unresponsiveEngines, 1);

    const second = await searxngSearch("useful query", options);
    assert.equal(calls.length, 2, "warm identical search should use the short-lived cache");
    assert.equal(second.metadata.cacheHit, true);
  } finally {
    restoreEnvironment();
  }
});

test("a single positive domain filter keeps the compact site query", async () => {
  const calls = [];
  try {
    globalThis.fetch = async url => {
      const requested = new URL(String(url));
      calls.push(requested);
      if (requested.pathname === "/") return new Response("ok");
      return jsonResponse({ results: [{ title: "One", url: "https://docs.test/one", content: "snippet" }] });
    };
    const { searxngSearch } = await loadSearx("single-domain");
    await searxngSearch("query", { domainFilter: ["docs.test"] });
    assert.equal(calls[1].searchParams.get("q"), "query site:docs.test");
  } finally {
    restoreEnvironment();
  }
});

test("SearXNG collapses concurrent identical cold searches", async () => {
  let calls = 0;
  try {
    globalThis.fetch = async url => {
      calls++;
      const requested = new URL(String(url));
      await new Promise(resolve => setTimeout(resolve, 10));
      if (requested.pathname === "/") return new Response("ok");
      return jsonResponse({ results: [{ title: "One", url: "https://example.test/one", content: "snippet" }] });
    };

    const { searxngSearch } = await loadSearx("collapse");
    const [a, b] = await Promise.all([searxngSearch("same query"), searxngSearch("same query")]);
    assert.equal(calls, 2, "one readiness probe and one search request expected");
    assert.equal(a.results[0].url, b.results[0].url);
  } finally {
    restoreEnvironment();
  }
});

test("an unavailable configured endpoint fails without running a local helper", async () => {
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      throw new Error("offline");
    };
    const { searxngSearch } = await loadSearx("configured-offline");
    await assert.rejects(searxngSearch("query"), /Configured SearXNG endpoint .* is unavailable/);
    assert.equal(calls, 1);
  } finally {
    restoreEnvironment();
  }
});

test("SearXNG rejects pre-aborted and malformed requests", async () => {
  let calls = 0;
  try {
    globalThis.fetch = async url => {
      calls++;
      const requested = new URL(String(url));
      if (requested.pathname === "/") return new Response("ok");
      return jsonResponse({ unexpected: true });
    };

    const { searxngSearch } = await loadSearx("errors");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(searxngSearch("cancelled", { signal: controller.signal }), err => err?.name === "AbortError");
    assert.equal(calls, 0, "an already-aborted call must not probe or start SearXNG");

    await assert.rejects(searxngSearch("malformed"), /missing results array/);
    assert.equal(calls, 2);
  } finally {
    restoreEnvironment();
  }
});

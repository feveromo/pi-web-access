import assert from "node:assert/strict";
import { test } from "node:test";

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
      domainFilter: ["example.test", "-noise.test"],
    };
    const first = await searxngSearch("  useful query  ", options);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].searchParams.get("q"), "useful query site:example.test -site:noise.test");
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

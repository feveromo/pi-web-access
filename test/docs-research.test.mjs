import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const sharedDocsCacheDir = mkdtempSync(join(tmpdir(), "pi-web-access-docs-shared-"));
const originalDocsCacheDir = process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
const originalResearchCacheDir = process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR;
const originalDocsLookup = globalThis.__PI_WEB_ACCESS_DOCS_LOOKUP__;
process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = sharedDocsCacheDir;
process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR = sharedDocsCacheDir;
globalThis.__PI_WEB_ACCESS_DOCS_LOOKUP__ = async () => [{ address: "93.184.216.34", family: 4 }];

after(() => {
  if (originalDocsCacheDir === undefined) delete process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
  else process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = originalDocsCacheDir;
  if (originalResearchCacheDir === undefined) delete process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR;
  else process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR = originalResearchCacheDir;
  if (originalDocsLookup === undefined) delete globalThis.__PI_WEB_ACCESS_DOCS_LOOKUP__;
  else globalThis.__PI_WEB_ACCESS_DOCS_LOOKUP__ = originalDocsLookup;
  rmSync(sharedDocsCacheDir, { recursive: true, force: true });
});

function textResponse(body, contentType = "text/markdown") {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("docs_search indexes llms.txt links and ranks docs pages", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "https://docs.test/llms.txt") {
        return textResponse(`# Docs\n\n- [Install Guide](/guide)\n- [API Reference](/api)`);
      }
      if (href === "https://docs.test/guide") {
        return textResponse(`# Install Guide\n\nInstall the client with npm and configure the token.`);
      }
      if (href === "https://docs.test/api") {
        return textResponse(`# API Reference\n\nCreate widgets and list resources.`);
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?docs=${Date.now()}`);
    const result = await executeDocsSearch({ source: "https://docs.test", query: "install client", maxResults: 2 });
    const text = result.content[0].text;

    assert.equal(result.details.pagesIndexed, 3);
    assert.equal(result.details.count, 2);
    assert.match(text, /Install Guide/);
    assert.match(text, /Install the client/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("docs_search extracts HTML pages with Readability", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      const href = String(url);
      if (href === "https://docs.html/") {
        return textResponse(`<html><body><nav><a href="/guide">Guide</a></nav><main><h1>Docs Home</h1><p>Documentation landing page content.</p></main></body></html>`, "text/html");
      }
      if (href === "https://docs.html/guide") {
        return textResponse(`<html><head><title>HTML Guide</title></head><body><article><h1>HTML Guide</h1><p>Configure the HTML client with a bounded timeout and cleanup handler.</p></article></body></html>`, "text/html");
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?html=${Date.now()}`);
    const result = await executeDocsSearch({ source: "https://docs.html/", mode: "crawl", query: "bounded timeout", maxPages: 2 });
    assert.match(result.content[0].text, /HTML Guide/);
    assert.match(result.content[0].text, /bounded timeout/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("docs_search defaults to compact result counts and snippets", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "https://docs.compact/llms.txt") {
        return textResponse(`# Docs\n\n${Array.from({ length: 10 }, (_, i) => `- [Page ${i + 1}](/page-${i + 1})`).join("\n")}`);
      }
      const match = href.match(/^https:\/\/docs\.compact\/page-(\d+)$/);
      if (match) {
        const i = Number(match[1]);
        return textResponse(`# Page ${i}\n\nCompact token repeated content for page ${i}. ${"x".repeat(1200)}`);
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?compact=${Date.now()}`);
    const result = await executeDocsSearch({ source: "https://docs.compact", query: "compact token" });

    assert.equal(result.details.count, 6);
    assert.ok(result.content[0].text.length < 7000, `unexpectedly large docs output: ${result.content[0].text.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("docs_search cache does not reuse query-biased page sets", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "https://docs.cache/llms.txt") {
        return textResponse(`# Docs\n\n- [Alpha Page](/alpha)\n- [Beta Page](/beta)`);
      }
      if (href === "https://docs.cache/alpha") {
        return textResponse(`# Alpha Page\n\nAlpha-only content.`);
      }
      if (href === "https://docs.cache/beta") {
        return textResponse(`# Beta Page\n\nBeta-only content.`);
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?cache=${Date.now()}`);
    await executeDocsSearch({ source: "https://docs.cache", query: "alpha", maxPages: 2, maxResults: 2 });
    const second = await executeDocsSearch({ source: "https://docs.cache", query: "beta", maxPages: 2, maxResults: 2 });

    assert.ok(second.details.results.some(result => result.url === "https://docs.cache/beta"));
    assert.match(second.content[0].text, /Beta-only content/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("docs_search reuses fresh disk cache after module reload", async () => {
  const originalFetch = globalThis.fetch;
  const cacheDir = sharedDocsCacheDir;
  const source = `https://docs-persist-${process.pid}-${Date.now()}.test`;

  try {
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount++;
      const href = String(url);
      if (href === `${source}/llms.txt`) {
        return textResponse(`# Docs\n\n- [Cache Token](/cache-token)`);
      }
      if (href === `${source}/cache-token`) {
        return textResponse(`# Cache Token\n\nStored docs survive a module reload while the TTL is fresh.`);
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const firstModule = await import(`../docs-research.ts?disk1=${Date.now()}-${Math.random()}`);
    const first = await firstModule.executeDocsSearch({ source, query: "cache token", maxPages: 2, maxResults: 1 });
    assert.equal(first.details.cacheHit, false);
    assert.equal(first.details.cacheStorage, "fresh");
    assert.ok(readdirSync(cacheDir).some(file => file.startsWith("docs-discovery-") && file.endsWith(".cache.json")));
    assert.ok(readdirSync(cacheDir).some(file => file.startsWith("docs-page-") && file.endsWith(".cache.json")));
    const discoveryFile = readdirSync(cacheDir).find(file => file.startsWith("docs-discovery-") && file.endsWith(".cache.json"));
    const discoveryEnvelope = JSON.parse(readFileSync(join(cacheDir, discoveryFile), "utf8"));
    assert.equal(discoveryEnvelope.freshUntil - discoveryEnvelope.storedAt, 7 * 24 * 60 * 60 * 1000);
    assert.equal(discoveryEnvelope.staleUntil - discoveryEnvelope.storedAt, 30 * 24 * 60 * 60 * 1000);
    assert.ok(fetchCount >= 2);

    globalThis.fetch = async (url) => {
      throw new Error(`unexpected fetch ${String(url)}`);
    };

    const secondModule = await import(`../docs-research.ts?disk2=${Date.now()}-${Math.random()}`);
    const second = await secondModule.executeDocsSearch({ source, query: "cache token", maxPages: 2, maxResults: 1 });
    assert.equal(second.details.cacheHit, true);
    assert.equal(second.details.cacheStorage, "disk");
    assert.equal(second.details.cacheDiscovery.storage, "disk");
    assert.equal(second.details.cachePages.diskHits, 2);
    assert.match(second.content[0].text, /Cache Token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("distinct concurrent docs queries share discovery and overlapping page fetches", async () => {
  const originalFetch = globalThis.fetch;
  const releaseDiscovery = deferred();
  const fetchCounts = new Map();
  try {
    globalThis.fetch = async url => {
      const href = String(url);
      fetchCounts.set(href, (fetchCounts.get(href) ?? 0) + 1);
      if (href === "https://docs.concurrent/llms.txt") {
        await releaseDiscovery.promise;
        return textResponse("# Docs\n\n- [Shared Alpha Beta](/shared)\n- [Alpha Only](/alpha)\n- [Beta Only](/beta)");
      }
      if (href === "https://docs.concurrent/shared") return textResponse("# Shared Alpha Beta\n\nCommon shared page content for both searches.");
      if (href === "https://docs.concurrent/alpha") return textResponse("# Alpha Only\n\nAlpha page content for this search.");
      if (href === "https://docs.concurrent/beta") return textResponse("# Beta Only\n\nBeta page content for this search.");
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?concurrent=${Date.now()}-${Math.random()}`);
    const alphaPromise = executeDocsSearch({ source: "https://docs.concurrent", query: "alpha", maxPages: 2 });
    const sharedAlphaPromise = executeDocsSearch({ source: "https://docs.concurrent", query: "alpha", maxPages: 2 });
    const betaPromise = executeDocsSearch({ source: "https://docs.concurrent", query: "beta", maxPages: 2 });
    releaseDiscovery.resolve();
    const [alpha, sharedAlpha, beta] = await Promise.all([alphaPromise, sharedAlphaPromise, betaPromise]);

    assert.equal(fetchCounts.get("https://docs.concurrent/llms.txt"), 1);
    assert.equal(fetchCounts.get("https://docs.concurrent/shared"), 1);
    const discoveryStates = [alpha, sharedAlpha, beta].map(result => result.details.cacheDiscovery.shared);
    assert.equal(discoveryStates.filter(shared => !shared).length, 1);
    assert.equal(discoveryStates.filter(Boolean).length, 2);
    const results = [alpha, sharedAlpha, beta];
    assert.equal(results.filter(result => result.details.cacheDiscovery.hit).length, 2);
    assert.equal(results.reduce((sum, result) => sum + result.details.cachePages.misses, 0), 3);
    assert.equal(results.reduce((sum, result) => sum + result.details.cachePages.sharedHits, 0), 3);
    assert.ok(results.every(result => result.details.cacheStorage === "fresh"), "shared and fetched work must not be labeled as memory");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aborting one docs cache waiter does not cancel another", async () => {
  const originalFetch = globalThis.fetch;
  const releaseDiscovery = deferred();
  let underlyingAborted = false;
  try {
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href === "https://docs.abort/llms.txt") {
        init.signal.addEventListener("abort", () => { underlyingAborted = true; }, { once: true });
        await releaseDiscovery.promise;
        return textResponse("# Docs\n\n- [Survivor](/survivor)");
      }
      if (href === "https://docs.abort/survivor") return textResponse("# Survivor\n\nThe independent waiter completed successfully.");
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?abort=${Date.now()}-${Math.random()}`);
    const controller = new AbortController();
    const abortedPromise = executeDocsSearch({ source: "https://docs.abort", query: "survivor", maxPages: 1 }, controller.signal);
    const survivorPromise = executeDocsSearch({ source: "https://docs.abort", query: "survivor", maxPages: 1 });
    controller.abort();
    releaseDiscovery.resolve();
    const [aborted, survivor] = await Promise.all([abortedPromise, survivorPromise]);

    assert.match(aborted.content[0].text, /Docs search failed:.*abort/i);
    assert.equal(survivor.details.count, 1);
    assert.equal(survivor.details.results[0].url, "https://docs.abort/survivor");
    assert.equal(underlyingAborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a replacement caller starts fresh before an aborted discovery task settles", async () => {
  const originalFetch = globalThis.fetch;
  const firstStarted = deferred();
  const firstResponse = deferred();
  let discoveryFetches = 0;
  let firstUnderlyingAborted = false;
  try {
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href === "https://docs.replace/llms.txt") {
        discoveryFetches++;
        if (discoveryFetches === 1) {
          init.signal.addEventListener("abort", () => { firstUnderlyingAborted = true; }, { once: true });
          firstStarted.resolve();
          return firstResponse.promise;
        }
        return textResponse("# Docs\n\n- [Replacement Page](/replacement)");
      }
      if (href === "https://docs.replace/replacement") return textResponse("# Replacement Page\n\nThe replacement discovery completed independently.");
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?replace=${Date.now()}-${Math.random()}`);
    const controller = new AbortController();
    const abandoned = executeDocsSearch({ source: "https://docs.replace", query: "replacement", maxPages: 1 }, controller.signal);
    await firstStarted.promise;
    controller.abort();
    const abandonedResult = await abandoned;
    const replacement = await executeDocsSearch({ source: "https://docs.replace", query: "replacement", maxPages: 1 });

    assert.match(abandonedResult.content[0].text, /Docs search failed:.*abort/i);
    assert.equal(firstUnderlyingAborted, true);
    assert.equal(discoveryFetches, 2, "the replacement must not join the orphaned task");
    assert.equal(replacement.details.count, 1);
    assert.match(replacement.content[0].text, /Replacement Page/);
    firstResponse.resolve(textResponse("# Stale Docs\n\n- [Stale Page](/stale)"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed docs pages are not cached", async () => {
  const originalFetch = globalThis.fetch;
  let failedFetches = 0;
  try {
    globalThis.fetch = async url => {
      const href = String(url);
      if (href === "https://docs.failure/llms.txt") return textResponse("# Docs\n\n- [Broken Page](/broken)");
      if (href === "https://docs.failure/broken") {
        failedFetches++;
        return new Response("temporary failure", { status: 503 });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?failure=${Date.now()}-${Math.random()}`);
    const first = await executeDocsSearch({ source: "https://docs.failure", query: "broken", maxPages: 1 });
    const second = await executeDocsSearch({ source: "https://docs.failure", query: "broken", maxPages: 1 });
    assert.equal(failedFetches, 2);
    assert.deepEqual(first.details.cachePages, { memoryHits: 0, diskHits: 0, sharedHits: 0, misses: 1, failures: 1 });
    assert.deepEqual(second.details.cachePages, { memoryHits: 0, diskHits: 0, sharedHits: 0, misses: 1, failures: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("crawl normalization keeps links within the source origin and path", async () => {
  const originalFetch = globalThis.fetch;
  const fetched = [];
  try {
    globalThis.fetch = async url => {
      const href = String(url);
      fetched.push(href);
      if (href === "https://docs.scope/docs") throw new Error("slash required");
      if (href === "https://docs.scope/docs/") {
        return textResponse('<main><a href="guide">Guide</a><a href="/outside">Outside</a><a href="https://other.scope/docs/external">External</a></main>', "text/html");
      }
      if (href === "https://docs.scope/docs/guide") return textResponse("# Scoped Guide\n\nScoped crawl content remains available.");
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?scope=${Date.now()}-${Math.random()}`);
    const result = await executeDocsSearch({ source: "https://docs.scope/docs/", mode: "crawl", query: "guide", maxPages: 1 });
    assert.match(result.content[0].text, /Scoped Guide/);
    assert.equal(result.details.source, "https://docs.scope/docs");
    assert.equal(fetched.includes("https://docs.scope/outside"), false);
    assert.equal(fetched.some(url => url.startsWith("https://other.scope")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("docs page memory cache evicts least-recently-used entries at its count bound", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      const href = String(url);
      if (href === "https://docs.memory-bound/llms.txt") {
        return textResponse(`# Docs\n\n${Array.from({ length: 202 }, (_, i) => `- [Unique ${String(i).padStart(3, "0")}](/page-${i})`).join("\n")}`);
      }
      const match = href.match(/^https:\/\/docs\.memory-bound\/page-(\d+)$/);
      if (match) return textResponse(`# Unique ${String(Number(match[1])).padStart(3, "0")}\n\nBounded page cache content for entry ${match[1]}.`);
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?memory-bound=${Date.now()}-${Math.random()}`);
    for (let i = 0; i < 202; i++) {
      const result = await executeDocsSearch({ source: "https://docs.memory-bound", query: `unique ${String(i).padStart(3, "0")}`, maxPages: 1 });
      assert.equal(result.details.cachePages.misses, 1);
    }
    const oldest = await executeDocsSearch({ source: "https://docs.memory-bound", query: "unique 000", maxPages: 1 });
    const newest = await executeDocsSearch({ source: "https://docs.memory-bound", query: "unique 201", maxPages: 1 });
    assert.equal(oldest.details.cachePages.diskHits, 1, "the oldest page should have been evicted from memory");
    assert.equal(newest.details.cachePages.memoryHits, 1, "the newest page should remain in memory");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a symlinked legacy docs root leaves its external victim untouched", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheDir = process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
  const victim = mkdtempSync(join(tmpdir(), "pi-web-access-legacy-docs-victim-"));
  const parent = mkdtempSync(join(tmpdir(), "pi-web-access-legacy-docs-link-"));
  const linkedRoot = join(parent, "docs-cache");
  const ownedLooking = join(victim, `discovery-${"a".repeat(64)}.json`);
  writeFileSync(ownedLooking, "external victim");
  symlinkSync(victim, linkedRoot);
  process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = linkedRoot;
  try {
    globalThis.fetch = async url => String(url).endsWith("/llms.txt")
      ? textResponse("# Docs\n\n- [Safe](/safe)")
      : textResponse("# Safe\n\nSafe documentation content.");
    const module = await import(`../docs-research.ts?legacy-root-symlink=${Date.now()}-${Math.random()}`);
    const result = await module.executeDocsSearch({ source: `https://legacy-safe-${Date.now()}.test`, query: "safe" });
    assert.equal(result.details.count > 0, true);
    assert.equal(readFileSync(ownedLooking, "utf8"), "external victim");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCacheDir === undefined) delete process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR; else process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = originalCacheDir;
    rmSync(parent, { recursive: true, force: true }); rmSync(victim, { recursive: true, force: true });
  }
});

test("docs disk cache ignores legacy split entries without touching them", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheDir = process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
  const cacheDir = mkdtempSync(join(tmpdir(), "pi-web-access-docs-bounds-"));
  const source = "https://docs.bounds";
  try {
    process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = cacheDir;
    const oldKey = `${source}/|auto`;
    const oldFile = join(cacheDir, `discovery-${createHash("sha256").update(`discovery:${oldKey}`).digest("hex")}.json`);
    writeFileSync(oldFile, JSON.stringify({
      version: 2,
      kind: "discovery",
      savedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      source: `${source}/`,
      mode: "auto",
      links: [{ title: "Unsafe cached page", url: `${source}/unsafe` }],
    }));

    let fetchCount = 0;
    globalThis.fetch = async url => {
      fetchCount++;
      const href = String(url);
      if (href === `${source}/llms.txt`) return textResponse("# Docs\n\n- [Bounded Page](/bounded)");
      if (href === `${source}/bounded`) return textResponse("# Bounded Page\n\nFresh version three cache content.");
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?bounds=${Date.now()}-${Math.random()}`);
    const result = await executeDocsSearch({ source, query: "bounded", maxPages: 1 });
    assert.equal(fetchCount, 2, "a v2 split entry must not satisfy the DNS-pinned cache");
    assert.equal(result.details.cacheHit, false);
    assert.equal(JSON.parse(readFileSync(oldFile, "utf8")).version, 2, "legacy entries are ignored rather than touched");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCacheDir === undefined) delete process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
    else process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = originalCacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("docs disk pruning leaves unrelated JSON and temp files untouched", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheDir = process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
  const cacheDir = mkdtempSync(join(tmpdir(), "pi-web-access-docs-owned-prune-"));
  const source = `https://docs-owned-${process.pid}-${Date.now()}.test`;
  const unrelatedJson = join(cacheDir, "user-settings.json");
  const unrelatedTmp = join(cacheDir, "notes.tmp");
  const lookalikeTmp = join(cacheDir, `page-${"a".repeat(64)}.json.not-ours.tmp`);
  const ownedTmp = join(cacheDir, `page-${"b".repeat(64)}.json.123.abc123.tmp`);
  try {
    process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = cacheDir;
    for (const path of [unrelatedJson, unrelatedTmp, lookalikeTmp, ownedTmp]) writeFileSync(path, "preserve-check");
    globalThis.fetch = async url => {
      const href = String(url);
      if (href === `${source}/llms.txt`) {
        return textResponse(`# Docs\n\n${Array.from({ length: 100 }, (_, i) => `- [Owned ${i}](/page-${i})`).join("\n")}`);
      }
      if (href.startsWith(`${source}/page-`)) return textResponse(`# Page\n\nOwned cache pruning fixture content.`);
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeDocsSearch } = await import(`../docs-research.ts?owned-prune=${Date.now()}-${Math.random()}`);
    const result = await executeDocsSearch({ source, query: "owned", maxPages: 100 });
    assert.equal(result.details.pagesIndexed, 100);
    assert.equal(readFileSync(unrelatedJson, "utf8"), "preserve-check");
    assert.equal(readFileSync(unrelatedTmp, "utf8"), "preserve-check");
    assert.equal(readFileSync(lookalikeTmp, "utf8"), "preserve-check");
    assert.equal(readdirSync(cacheDir).includes(ownedTmp.split("/").pop()), true, "obsolete legacy cleanup is not invoked");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCacheDir === undefined) delete process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
    else process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = originalCacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("docs 7d-fresh entries use clearly labeled stale data on transient refresh through 30d", async () => {
  const originalFetch = globalThis.fetch;
  const source = `https://docs-stale-${Date.now()}.test`;
  try {
    const before = new Set(readdirSync(sharedDocsCacheDir));
    globalThis.fetch = async url => String(url).endsWith("/llms.txt")
      ? textResponse("# Docs\n\n- [Stale Page](/page)")
      : textResponse("# Stale Page\n\nRetained documentation content.");
    const warm = await import(`../docs-research.ts?docs-stale-warm=${Date.now()}-${Math.random()}`);
    await warm.executeDocsSearch({ source, query: "retained", maxPages: 2 });
    for (const name of readdirSync(sharedDocsCacheDir).filter(name => !before.has(name) && /^docs-(?:discovery|page)-/.test(name))) {
      const path = join(sharedDocsCacheDir, name);
      const envelope = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...envelope, freshUntil: Date.now() - 1, staleUntil: envelope.storedAt + 30 * 24 * 60 * 60 * 1000 }));
    }
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    const staleModule = await import(`../docs-research.ts?docs-stale-reload=${Date.now()}-${Math.random()}`);
    const stale = await staleModule.executeDocsSearch({ source, query: "retained", maxPages: 2 });
    assert.match(stale.content[0].text, /WARNING: stale cached documentation/);
    assert.ok(stale.details.cache.staleWarnings.length > 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("docs_search blocks localhost before any cache lookup or fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  try {
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("must not fetch");
    };
    const { executeDocsSearch } = await import(`../docs-research.ts?localhost=${Date.now()}-${Math.random()}`);
    const result = await executeDocsSearch({ source: "http://localhost/docs", mode: "crawl" });
    assert.match(result.content[0].text, /Blocked internal hostname: localhost/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("docs_search blocks a public-to-private redirect", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, {
      status: 302,
      headers: { location: "http://private.docs.test/secret" },
    });
    const lookup = async hostname => [{ address: hostname === "private.docs.test" ? "127.0.0.1" : "93.184.216.34", family: 4 }];
    const { executeDocsSearch } = await import(`../docs-research.ts?redirect=${Date.now()}-${Math.random()}`);
    const result = await executeDocsSearch({ source: "https://public.docs.test", mode: "crawl" }, undefined, { lookup });
    assert.match(result.content[0].text, /Blocked internal address for private\.docs\.test: 127\.0\.0\.1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openapi_search blocks localhost and public-to-private redirects", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response(null, { status: 302, headers: { location: "http://private.api.test/spec" } });
    };
    const { executeOpenApiSearch } = await import(`../docs-research.ts?openapi-ssrf=${Date.now()}-${Math.random()}`);
    const local = await executeOpenApiSearch({ url: "http://localhost/openapi.json", query: "users" });
    assert.match(local.content[0].text, /Blocked internal hostname: localhost/);
    assert.equal(fetched, false);

    const lookup = async hostname => [{ address: hostname === "private.api.test" ? "10.0.0.8" : "93.184.216.34", family: 4 }];
    const redirected = await executeOpenApiSearch({ url: "https://public.api.test/openapi.json", query: "users" }, undefined, { lookup });
    assert.match(redirected.content[0].text, /Blocked internal address for private\.api\.test: 10\.0\.0\.8/);
    assert.equal(fetched, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openapi stale fallback accepts 503 but rejects 4xx refresh failures", async () => {
  const originalFetch = globalThis.fetch;
  const source = `https://openapi-stale-${Date.now()}.test/spec.json`;
  const spec = { paths: { "/items": { get: { summary: "List items", responses: { 200: { description: "ok" } } } } } };
  try {
    globalThis.fetch = async () => jsonResponse(spec);
    const firstModule = await import(`../docs-research.ts?openapi-stale-warm=${Date.now()}-${Math.random()}`);
    await firstModule.executeOpenApiSearch({ url: source, query: "items" });
    const file = readdirSync(sharedDocsCacheDir).find(name => name.startsWith("openapi-") && name.endsWith(".cache.json"));
    assert.ok(file);
    const path = join(sharedDocsCacheDir, file);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(envelope.freshUntil - envelope.storedAt, 24 * 60 * 60 * 1000);
    assert.equal(envelope.staleUntil - envelope.storedAt, 7 * 24 * 60 * 60 * 1000);
    writeFileSync(path, JSON.stringify({ ...envelope, freshUntil: Date.now() - 1, staleUntil: Date.now() + 60_000 }));

    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    const staleModule = await import(`../docs-research.ts?openapi-stale-503=${Date.now()}-${Math.random()}`);
    const stale = await staleModule.executeOpenApiSearch({ url: source, query: "items" });
    assert.equal(stale.details.cache.status, "stale");
    assert.match(stale.content[0].text, /WARNING: stale cached OpenAPI/);

    writeFileSync(path, JSON.stringify({ ...envelope, freshUntil: Date.now() - 1, staleUntil: Date.now() + 60_000 }));
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    const authModule = await import(`../docs-research.ts?openapi-stale-401=${Date.now()}-${Math.random()}`);
    const auth = await authModule.executeOpenApiSearch({ url: source, query: "items" });
    assert.match(auth.content[0].text, /HTTP 401/);
    assert.equal(auth.details.cache, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("forged OpenAPI envelopes with excessive schema recursion are rejected before use", async () => {
  const originalFetch = globalThis.fetch;
  const source = `https://openapi-forged-${Date.now()}.test/spec.json`;
  const spec = { paths: { "/safe": { get: { summary: "Safe endpoint" } } } };
  try {
    const before = new Set(readdirSync(sharedDocsCacheDir));
    globalThis.fetch = async () => jsonResponse(spec);
    const warmModule = await import(`../docs-research.ts?openapi-forge-warm=${Date.now()}-${Math.random()}`);
    await warmModule.executeOpenApiSearch({ url: source, query: "safe" });
    const file = readdirSync(sharedDocsCacheDir).find(name => name.startsWith("openapi-") && !before.has(name));
    const path = join(sharedDocsCacheDir, file);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    let schema = { type: "string" };
    for (let i = 0; i < 30; i++) schema = { items: schema };
    envelope.value.endpoints[0].parameters = [{ name: "bad", schema }];
    writeFileSync(path, JSON.stringify(envelope));
    let refreshes = 0;
    globalThis.fetch = async () => { refreshes++; return jsonResponse(spec); };
    const reloaded = await import(`../docs-research.ts?openapi-forge-reload=${Date.now()}-${Math.random()}`);
    const result = await reloaded.executeOpenApiSearch({ url: source, query: "safe" });
    assert.equal(refreshes, 1);
    assert.equal(result.details.count, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("openapi_search returns endpoint details and curl example", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://api.test/openapi.json");
      return jsonResponse({
        servers: [{ url: "https://api.test" }],
        paths: {
          "/files/{repo}": {
            parameters: [
              { name: "repo", in: "path", required: true, description: "Repository id" },
            ],
            post: {
              operationId: "uploadFile",
              summary: "Upload file",
              description: "Upload a file to a repository.",
              tags: ["files"],
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { path: { type: "string" } } },
                  },
                },
              },
              responses: { 200: { description: "ok" } },
            },
          },
        },
      });
    };

    const { executeOpenApiSearch } = await import(`../docs-research.ts?openapi=${Date.now()}`);
    const result = await executeOpenApiSearch({ url: "https://api.test/openapi.json", query: "upload file" });
    const text = result.content[0].text;

    assert.equal(result.details.count, 1);
    assert.match(text, /POST \/files\/\{repo\}/);
    assert.match(text, /curl -X POST 'https:\/\/api\.test\/files\/<repo>'/);
    assert.match(text, /"path": "<path>"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

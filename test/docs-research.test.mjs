import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const sharedDocsCacheDir = mkdtempSync(join(tmpdir(), "pi-web-access-docs-shared-"));
const originalDocsCacheDir = process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = sharedDocsCacheDir;

after(() => {
  if (originalDocsCacheDir === undefined) delete process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
  else process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = originalDocsCacheDir;
  rmSync(sharedDocsCacheDir, { recursive: true, force: true });
});

function textResponse(body, contentType = "text/markdown") {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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
  const originalCacheDir = process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
  const cacheDir = mkdtempSync(join(tmpdir(), "pi-web-access-docs-"));
  const source = `https://docs-persist-${process.pid}-${Date.now()}.test`;

  try {
    process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = cacheDir;
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
    assert.ok(fetchCount >= 2);

    globalThis.fetch = async (url) => {
      throw new Error(`unexpected fetch ${String(url)}`);
    };

    const secondModule = await import(`../docs-research.ts?disk2=${Date.now()}-${Math.random()}`);
    const second = await secondModule.executeDocsSearch({ source, query: "cache token", maxPages: 2, maxResults: 1 });
    assert.equal(second.details.cacheHit, true);
    assert.equal(second.details.cacheStorage, "disk");
    assert.match(second.content[0].text, /Cache Token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCacheDir === undefined) delete process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR;
    else process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR = originalCacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
  }
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

import assert from "node:assert/strict";
import { test } from "node:test";

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

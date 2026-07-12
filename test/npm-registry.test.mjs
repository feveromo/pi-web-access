import assert from "node:assert/strict";
import { test } from "node:test";

import { extractNpmPackage, parseNpmPackageUrl } from "../npm-registry.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function options(signal) {
  return { signal, timeoutMs: 5_000, lookup: publicLookup };
}

test("npm package URL parser handles scoped, unscoped, and common version suffixes", () => {
  assert.deepEqual(parseNpmPackageUrl("https://www.npmjs.com/package/lodash"), { name: "lodash" });
  assert.deepEqual(parseNpmPackageUrl("https://npmjs.com/package/lodash/v/4.17.21?activeTab=readme"), { name: "lodash", version: "4.17.21" });
  assert.deepEqual(parseNpmPackageUrl("https://www.npmjs.com/package/lodash/version/4.17.20"), { name: "lodash", version: "4.17.20" });
  assert.deepEqual(parseNpmPackageUrl("https://www.npmjs.com/package/@types/node"), { name: "@types/node" });
  assert.deepEqual(parseNpmPackageUrl("https://www.npmjs.com/package/@types/node/v/22.0.0"), { name: "@types/node", version: "22.0.0" });
  assert.deepEqual(parseNpmPackageUrl("https://www.npmjs.com/package/@types/node@22.0.0"), { name: "@types/node", version: "22.0.0" });
  assert.deepEqual(parseNpmPackageUrl("https://www.npmjs.com/package/lodash@4.17.21"), { name: "lodash", version: "4.17.21" });
  assert.equal(parseNpmPackageUrl("https://example.com/package/lodash"), null);
  assert.equal(parseNpmPackageUrl("https://user:secret@npmjs.com/package/lodash"), null);
});

test("npm registry adapter resolves latest metadata and returns a bounded README", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ "dist-tags": { latest: "1.2.3" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          name: "demo-package",
          version: "1.2.3",
          description: "A demo",
          homepage: "https://demo.example/docs",
          repository: { type: "git", url: "git+https://github.com/example/demo.git" },
          license: "MIT",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ readme: `Usage\n=====\n\nHello registry.\n${"x".repeat(100_100)}` }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await extractNpmPackage("https://www.npmjs.com/package/demo-package", { name: "demo-package" }, options());
    assert.equal(result.error, null);
    assert.equal(result.method, "npm-registry");
    assert.equal(result.title, "demo-package@1.2.3");
    assert.match(result.content, /Description: A demo/);
    assert.match(result.content, /https:\/\/github.com\/example\/demo/);
    assert.match(result.content, /Hello registry/);
    assert.match(result.content, /README truncated by npm registry adapter/);
    assert.equal(result.metadata.npm.readmeAvailable, true);
    assert.equal(result.metadata.npm.readmeTruncated, true);
    assert.equal(requests.length, 3);
    assert.match(requests[0].headers.get("accept"), /npm\.install/);
    assert.equal(requests.every(request => !request.headers.has("authorization") && !request.headers.has("cookie")), true);
    assert.equal(requests.every(request => request.url.startsWith("https://registry.npmjs.org/")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("npm registry adapter gives useful links without a README and a precise missing-package error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => String(url).includes("missing-package")
      ? new Response('{"error":"Not found"}', { status: 404, statusText: "Not Found" })
      : new Response(JSON.stringify({ name: "no-readme", version: "2.0.0", repository: "https://github.com/example/no-readme.git" }), { status: 200 });
    const withoutReadme = await extractNpmPackage("https://npmjs.com/package/no-readme/v/2.0.0", { name: "no-readme", version: "2.0.0" }, options());
    assert.equal(withoutReadme.error, null);
    assert.match(withoutReadme.content, /README unavailable/);
    assert.match(withoutReadme.content, /Registry: https:\/\/www\.npmjs\.com\/package\/no-readme\/v\/2\.0\.0/);

    const missing = await extractNpmPackage("https://npmjs.com/package/missing-package/v/9.9.9", { name: "missing-package", version: "9.9.9" }, options());
    assert.equal(missing.error, "npm package version not found: missing-package@9.9.9");
    assert.equal(missing.httpStatus, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("npm registry adapter preserves caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await extractNpmPackage("https://npmjs.com/package/demo", { name: "demo" }, options(controller.signal));
  assert.equal(result.error, "Aborted");
});

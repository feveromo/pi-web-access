import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ResponseTooLargeError,
  isSafeForThirdPartyFetch,
  readErrorSnippet,
  readResponseJson,
  readResponseText,
} from "../http-response.js";

test("bounded response reader cancels a chunked body that exceeds its limit", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5678"));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readResponseText(new Response(body), 6),
    err => err instanceof ResponseTooLargeError && err.limitBytes === 6,
  );
  assert.equal(cancelled, true);
});

test("bounded response reader rejects oversized Content-Length before buffering", async () => {
  const response = new Response("small", { headers: { "content-length": "1000" } });
  await assert.rejects(readResponseText(response, 100), /Response too large/);
  assert.equal(response.bodyUsed, true);
});

test("third-party fallback rejects private or credential-bearing URLs", () => {
  assert.equal(isSafeForThirdPartyFetch("https://example.test/article?id=1"), true);
  assert.equal(isSafeForThirdPartyFetch("https://fcc.gov/article"), true);
  assert.equal(isSafeForThirdPartyFetch("https://fda.gov/article"), true);
  assert.equal(isSafeForThirdPartyFetch("http://127.0.0.1/private"), false);
  assert.equal(isSafeForThirdPartyFetch("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(isSafeForThirdPartyFetch("http://[::ffff:127.0.0.1]/private"), false);
  assert.equal(isSafeForThirdPartyFetch("https://user:pass@example.test/private"), false);
  assert.equal(isSafeForThirdPartyFetch("https://example.test/file?X-Amz-Signature=value"), false);
  assert.equal(isSafeForThirdPartyFetch("https://example.test/file?client_secret=value"), false);
  assert.equal(isSafeForThirdPartyFetch("https://example.test/file?oauth_token=value"), false);
});

test("bounded response helpers parse JSON and cap error bodies", async () => {
  const parsed = await readResponseJson(new Response('{"ok":true}'), 100);
  assert.deepEqual(parsed, { ok: true });

  const snippet = await readErrorSnippet(new Response("failure details " + "x".repeat(100)), 20, 256);
  assert.equal(snippet.length, 20);
  assert.match(snippet, /^failure details/);
});

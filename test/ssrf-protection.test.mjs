import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRemoteUrl, validateRemoteUrl, validateThirdPartySourceUrl } from "../ssrf-protection.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

async function rejectsInternal(url) {
  await assert.rejects(validateRemoteUrl(url, { lookup: publicLookup }), /internal|Blocked/);
}

test("SSRF guard blocks internal, private, metadata, and mapped addresses", async () => {
  for (const url of [
    "http://localhost/", "http://127.0.0.1/", "http://10.0.0.1/",
    "http://172.16.0.1/", "http://192.168.1.1/", "http://169.254.169.254/",
    "http://[::1]/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/",
  ]) await rejectsInternal(url);
});

test("SSRF guard validates every DNS answer and allows public targets", async () => {
  await assert.rejects(validateRemoteUrl("https://example.test/", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
  }), /Blocked internal address/);
  assert.equal((await validateRemoteUrl("https://example.test/path", { lookup: publicLookup })).hostname, "example.test");
});

test("remote fetch blocks an internal redirect before requesting it", async () => {
  const requested = [];
  const fetchImpl = async url => {
    requested.push(url.toString());
    return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  };
  await assert.rejects(fetchRemoteUrl("https://example.test/", {}, { lookup: publicLookup, fetch: fetchImpl }), /Blocked internal address/);
  assert.deepEqual(requested, ["https://example.test/"]);
});

test("remote fetch follows validated public redirects", async () => {
  const requested = [];
  const fetchImpl = async url => {
    requested.push(url.toString());
    return requested.length === 1
      ? new Response("", { status: 301, headers: { location: "/next" } })
      : new Response("ok");
  };
  const response = await fetchRemoteUrl("https://example.test/start", {}, { lookup: publicLookup, fetch: fetchImpl });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(requested, ["https://example.test/start", "https://example.test/next"]);
});

test("strict allowRanges restores explicit private and fake-IP access", async () => {
  const fakeLookup = async () => [{ address: "198.18.0.56", family: 4 }];
  await assert.rejects(validateRemoteUrl("https://example.test/", { lookup: fakeLookup }), /Blocked/);
  assert.equal((await validateRemoteUrl("https://example.test/", {
    lookup: fakeLookup, allowRanges: ["198.18.0.0/15"],
  })).hostname, "example.test");
  assert.equal((await validateRemoteUrl("http://10.1.2.3/", { allowRanges: ["10.0.0.0/8"] })).hostname, "10.1.2.3");
});

test("direct allowRanges never authorizes disclosure to a third-party fetch service", async () => {
  const privateLookup = async () => [{ address: "10.1.2.3", family: 4 }];
  assert.equal((await validateRemoteUrl("https://private.test/", {
    lookup: privateLookup, allowRanges: ["10.0.0.0/8"],
  })).hostname, "private.test");
  await assert.rejects(
    validateThirdPartySourceUrl("https://private.test/", { lookup: privateLookup }),
    /Blocked internal address/,
  );
});

test("DNS validation returns promptly when the caller aborts a hanging lookup", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let lookupStarted = false;
  await assert.rejects(validateRemoteUrl("https://cancelled.test/", {
    lookup: async () => { lookupStarted = true; return publicLookup(); },
    signal: preAborted.signal,
  }), error => error?.name === "AbortError");
  assert.equal(lookupStarted, false);

  const controller = new AbortController();
  const pendingLookup = new Promise(() => {});
  const started = performance.now();
  const validation = validateRemoteUrl("https://hanging.test/", {
    lookup: async () => pendingLookup,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), 10);
  await assert.rejects(validation, error => error?.name === "TimeoutError");
  assert.ok(performance.now() - started < 250, "abort should not wait for DNS completion");
});

test("allowRanges rejects malformed and all-address CIDRs", async () => {
  for (const cidr of ["198.18.0.0/", "10.0.0.0/abc", "0.0.0.0/0", "::/0", "198.18.0.0/33"]) {
    await assert.rejects(validateRemoteUrl("http://198.18.0.5/", { allowRanges: [cidr] }), /Invalid CIDR notation/);
  }
  await assert.rejects(validateRemoteUrl("http://198.18.0.5/", { allowRanges: "198.18.0.0/15" }), /must be an array/);
});

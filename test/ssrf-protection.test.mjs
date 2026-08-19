import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { createPinnedLookup, fetchRemoteUrl, validateRemoteUrl, validateThirdPartySourceUrl } from "../ssrf-protection.ts";

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

test("pinned lookup returns only validated addresses in all and single forms", async () => {
  const lookup = createPinnedLookup({
    hostname: "Example.Test",
    addresses: [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ],
  });
  const call = options => new Promise((resolve, reject) => {
    lookup("example.test", options, (error, ...values) => error ? reject(error) : resolve(values));
  });
  assert.deepEqual(await call({ all: true }), [[
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]]);
  assert.deepEqual(await call({ family: 6 }), ["2606:2800:220:1:248:1893:25c8:1946", 6]);
  await assert.rejects(new Promise((resolve, reject) => {
    lookup("attacker.test", {}, error => error ? reject(error) : resolve());
  }), /unexpected hostname/);
});

test("each redirect gets independent DNS pins and strips cross-origin secrets", async () => {
  const dnsAnswers = new Map([
    ["first.test", [{ address: "93.184.216.34", family: 4 }]],
    ["second.test", [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]],
  ]);
  const lookupCalls = [];
  const dispatchers = [];
  const seen = [];
  const response = await fetchRemoteUrl("https://first.test/start", {
    headers: { Authorization: "Bearer secret", Cookie: "session=x", "Proxy-Authorization": "Basic x", "X-Safe": "yes" },
  }, {
    lookup: async hostname => {
      lookupCalls.push(hostname);
      return dnsAnswers.get(hostname);
    },
    fetch: async (url, init) => {
      dispatchers.push(init.dispatcher);
      seen.push({ url: url.toString(), headers: new Headers(init.headers) });
      return seen.length === 1
        ? new Response("redirect", { status: 302, headers: { location: "https://second.test/end" } })
        : new Response("ok");
    },
  });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(lookupCalls, ["first.test", "second.test"]);
  assert.notEqual(dispatchers[0], dispatchers[1]);
  assert.deepEqual(seen.map(item => item.url), ["https://first.test/start", "https://second.test/end"]);
  assert.equal(seen[1].headers.get("authorization"), null);
  assert.equal(seen[1].headers.get("cookie"), null);
  assert.equal(seen[1].headers.get("proxy-authorization"), null);
  assert.equal(seen[1].headers.get("x-safe"), "yes");
});

test("connection uses the validated pin while retaining the original hostname identity", async t => {
  let hostHeader;
  const server = http.createServer((request, response) => {
    hostHeader = request.headers.host;
    response.end("pinned");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  let validationLookups = 0;
  const response = await fetchRemoteUrl(`http://identity.test:${port}/path`, {}, {
    allowRanges: ["127.0.0.1/32"],
    lookup: async hostname => {
      validationLookups++;
      assert.equal(hostname, "identity.test");
      return validationLookups === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "10.0.0.1", family: 4 }];
    },
  });
  assert.equal(await response.text(), "pinned");
  assert.equal(validationLookups, 1, "the connection must not invoke the validation resolver again");
  assert.equal(hostHeader, `identity.test:${port}`);

  const numericResponse = await fetchRemoteUrl(`http://127.0.0.1:${port}/numeric`, {}, {
    allowRanges: ["127.0.0.1/32"],
    lookup: async () => { throw new Error("numeric targets must not fall back to DNS"); },
  });
  assert.equal(await numericResponse.text(), "pinned");
  assert.equal(hostHeader, `127.0.0.1:${port}`);
});

test("hop Agent closes after body completion, cancellation, abort, and fetch failure", async () => {
  async function run(bodyAction) {
    let closes = 0;
    const controller = new AbortController();
    const response = await fetchRemoteUrl("https://cleanup.test/", { signal: controller.signal }, {
      lookup: publicLookup,
      fetch: async (_url, init) => {
        init.dispatcher.close = async () => { closes++; };
        return new Response(new ReadableStream({ pull() {} }));
      },
    });
    assert.equal(closes, 0, "Agent must stay open while the response body is live");
    await bodyAction(response, controller);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(closes, 1);
  }
  await run(response => response.body.cancel());
  await run((_response, controller) => controller.abort());

  let completionCloses = 0;
  const complete = await fetchRemoteUrl("https://cleanup.test/", {}, {
    lookup: publicLookup,
    fetch: async (_url, init) => {
      init.dispatcher.close = async () => { completionCloses++; };
      return new Response("done");
    },
  });
  assert.equal(await complete.text(), "done");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(completionCloses, 1);

  let streamErrorCloses = 0;
  const streamError = await fetchRemoteUrl("https://cleanup.test/", {}, {
    lookup: publicLookup,
    fetch: async (_url, init) => {
      init.dispatcher.close = async () => { streamErrorCloses++; };
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("stream failed")); } }));
    },
  });
  await assert.rejects(streamError.text(), /stream failed/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(streamErrorCloses, 1);

  let failureCloses = 0;
  await assert.rejects(fetchRemoteUrl("https://cleanup.test/", {}, {
    lookup: publicLookup,
    fetch: async (_url, init) => {
      init.dispatcher.close = async () => { failureCloses++; };
      throw new Error("network failed");
    },
  }), /network failed/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(failureCloses, 1);
});

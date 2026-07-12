import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearSsrfConfigCache, loadSsrfAllowRanges } from "../ssrf-config.js";

function withConfig(value, fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-ssrf-"));
  const path = join(dir, "web-search.json");
  if (value !== undefined) writeFileSync(path, value, "utf8");
  try { return fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("SSRF allowRanges config returns strict trimmed CIDRs", () => {
  withConfig(JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15", " fd00::/8 ", ""] } }), path => {
    assert.deepEqual(loadSsrfAllowRanges(path), ["198.18.0.0/15", "fd00::/8"]);
  });
});

test("SSRF allowRanges config fails loudly on wrong shapes", () => {
  withConfig(JSON.stringify({ ssrf: { allowRanges: "10.0.0.0/8" } }), path => {
    assert.throws(() => loadSsrfAllowRanges(path), /must be an array/);
  });
  withConfig(JSON.stringify({ ssrf: { allowRanges: [42] } }), path => {
    assert.throws(() => loadSsrfAllowRanges(path), /entry 1 is number/);
  });
});

test("SSRF config cache invalidates on allowRanges changes and removal", () => {
  clearSsrfConfigCache();
  withConfig(JSON.stringify({ ssrf: { allowRanges: ["10.0.0.0/8"] } }), path => {
    assert.deepEqual(loadSsrfAllowRanges(path), ["10.0.0.0/8"]);
    assert.deepEqual(loadSsrfAllowRanges(path), ["10.0.0.0/8"], "unchanged config reuses parsed state");
    writeFileSync(path, JSON.stringify({ ssrf: { allowRanges: [] }, changed: true }), "utf8");
    assert.deepEqual(loadSsrfAllowRanges(path), [], "allowRanges removal is observed immediately");
  });
});

test("SSRF allowRanges config fails safe when absent or invalid JSON", () => {
  withConfig(undefined, path => assert.deepEqual(loadSsrfAllowRanges(path), []));
  withConfig("{ invalid", path => assert.deepEqual(loadSsrfAllowRanges(path), []));
});

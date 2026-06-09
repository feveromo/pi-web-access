import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8");
}

test("manual regression checklist matches the lean fork", () => {
  const checklist = read("eval/web-access-checklist.md");

  for (const stale of [
    "workflow: \"none\"",
    "YouTube prompt/frame",
    "media binaries",
  ]) {
    assert.equal(checklist.includes(stale), false, `stale checklist text: ${stale}`);
  }

  assert.match(checklist, /Long content durability/);
  assert.match(checklist, /disk-backed/);
  assert.match(checklist, /Stored-content batch retrieval/);
  assert.match(checklist, /urlIndexes/);
  assert.match(checklist, /Current\/status search guardrail/);
});

test("package ships tools only, no bundled skills", () => {
  assert.equal(existsSync(new URL("../skills", import.meta.url)), false);
});

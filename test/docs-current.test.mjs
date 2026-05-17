import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8");
}

test("manual regression checklist matches the lean fork", () => {
  const checklist = read("eval/web-access-checklist.md");

  for (const stale of [
    "workflow: \"none\"",
    "provider: \"gemini\"",
    "YouTube prompt/frame",
    "media binaries",
  ]) {
    assert.equal(checklist.includes(stale), false, `stale checklist text: ${stale}`);
  }

  assert.match(checklist, /Long content durability/);
  assert.match(checklist, /disk-backed/);
});

test("librarian skill points at native web_search and fetch_content flow", () => {
  const skill = read("skills/librarian/SKILL.md");

  assert.match(skill, /web_search\(\{ queries: \[\.\.\.\] \}\)/);
  assert.match(skill, /fetch_content/);
  assert.equal(skill.includes("code_search"), false);
});

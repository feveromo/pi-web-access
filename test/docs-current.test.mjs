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
    "YouTube prompt/frame",
    "media binaries",
  ]) {
    assert.equal(checklist.includes(stale), false, `stale checklist text: ${stale}`);
  }

  assert.match(checklist, /Long content durability/);
  assert.match(checklist, /disk-backed/);
});

test("librarian skill points at native research and source-reading flows", () => {
  const skill = read("skills/librarian/SKILL.md");

  assert.match(skill, /web_search\(\{ queries: \[\.\.\.\] \}\)/);
  assert.match(skill, /docs_search/);
  assert.match(skill, /github_examples/);
  assert.match(skill, /paper_research/);
  assert.match(skill, /fetch_content/);
  assert.equal(skill.includes("code_search"), false);
});

test("internet-research skill is packaged and references native tools", () => {
  const skill = read("skills/internet-research/SKILL.md");

  assert.match(skill, /^name: internet-research$/m);
  assert.match(skill, /^description: Evidence-first internet research workflow/m);
  for (const tool of ["web_search", "paper_research", "docs_search", "openapi_search", "github_examples", "fetch_content", "get_search_content"]) {
    assert.match(skill, new RegExp(tool));
  }
});

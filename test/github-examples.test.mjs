import assert from "node:assert/strict";
import { test } from "node:test";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("github_examples finds ranked example files", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "https://api.github.com/repos/owner/repo") {
        return jsonResponse({ full_name: "owner/repo", default_branch: "main", description: "Example repo" });
      }
      if (href === "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1") {
        return jsonResponse({ truncated: true, tree: [
          { type: "blob", path: "src/core.py", sha: "aaa", size: 10 },
          { type: "blob", path: "examples/scripts/sft.py", sha: "bbb", size: 1200 },
          { type: "blob", path: "docs/tutorial.ipynb", sha: "ccc", size: 2000 },
          { type: "blob", path: "assets/logo.png", sha: "ddd", size: 999 },
        ] });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeGitHubExamples } = await import(`../github-examples.ts?find=${Date.now()}`);
    const result = await executeGitHubExamples({ operation: "find", repo: "owner/repo", keyword: "sft", maxResults: 3 });
    const text = result.content[0].text;

    assert.equal(result.details.count, 1);
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.results[0].ref, "main");
    assert.equal(result.details.results[0].sha, "bbb");
    assert.match(text, /examples\/scripts\/sft\.py/);
    assert.match(text, /tree as truncated/);
    assert.doesNotMatch(text, /assets\/logo\.png/);
    assert.match(text, /github_examples\(\{ operation: "read"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("github_examples falls back to raw content for large files", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "https://api.github.com/repos/owner/repo/contents/examples/large.py?ref=main") {
        calls++;
        if (calls === 1) return jsonResponse({ type: "file", encoding: "none", content: "" });
        return new Response("big1\nbig2", { status: 200, headers: { "content-type": "text/plain" } });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeGitHubExamples } = await import(`../github-examples.ts?large=${Date.now()}`);
    const result = await executeGitHubExamples({ operation: "read", repo: "owner/repo", path: "examples/large.py", ref: "main" });
    const text = result.content[0].text;

    assert.equal(calls, 2);
    assert.equal(result.details.totalLines, 2);
    assert.match(text, /big1\nbig2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("github_examples reads file ranges", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const source = "line1\nline2\nline3\nline4";
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "https://api.github.com/repos/owner/repo/contents/examples/sft.py?ref=main") {
        return jsonResponse({ type: "file", encoding: "base64", content: Buffer.from(source, "utf8").toString("base64") });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const { executeGitHubExamples } = await import(`../github-examples.ts?read=${Date.now()}`);
    const result = await executeGitHubExamples({ operation: "read", repo: "owner/repo", path: "examples/sft.py", ref: "main", lineStart: 2, lineEnd: 3 });
    const text = result.content[0].text;

    assert.equal(result.details.lineStart, 2);
    assert.equal(result.details.lineEnd, 3);
    assert.match(text, /line2\nline3/);
    assert.doesNotMatch(text, /line1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

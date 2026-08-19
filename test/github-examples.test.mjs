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
      if (href.includes("/contents/examples/scripts/sft.py?ref=main")) return new Response("run supervised sft training", { status: 200 });
      if (href.includes("/contents/docs/tutorial.ipynb?ref=main")) return new Response("generic tutorial", { status: 200 });
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
    assert.deepEqual(result.details.contentScan, { attempted: 2, succeeded: 2, failed: 0, errors: [] });
    assert.deepEqual(result.details.results[0].matchedTerms, ["sft"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("github_examples finds terms that occur only in bounded candidate content", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      const href = String(url);
      if (href === "https://api.github.com/repos/owner/content-repo") return jsonResponse({ default_branch: "main" });
      if (href.includes("/git/trees/main?recursive=1")) return jsonResponse({ tree: [
        { type: "blob", path: "examples/basic.py", sha: "a", size: 100 },
        { type: "blob", path: "examples/advanced.py", sha: "b", size: 100 },
      ] });
      if (href.includes("/contents/examples/basic.py?ref=main")) return new Response("hello world", { status: 200 });
      if (href.includes("/contents/examples/advanced.py?ref=main")) return new Response("enable ultra mode with reasoning effort", { status: 200 });
      throw new Error(`unexpected fetch ${href}`);
    };
    const { executeGitHubExamples } = await import(`../github-examples.ts?content=${Date.now()}`);
    const result = await executeGitHubExamples({ repo: "owner/content-repo", keyword: "ultra mode" });
    assert.equal(result.details.count, 1);
    assert.equal(result.details.results[0].path, "examples/advanced.py");
    assert.deepEqual(result.details.results[0].matchedTerms, ["ultra", "mode"]);
    assert.match(result.content[0].text, /enable ultra mode/);

    const strict = await executeGitHubExamples({ repo: "owner/content-repo", keyword: "ultra mode", minScore: 100 });
    assert.equal(strict.details.count, 1);
    assert.equal(strict.details.results[0].path, "examples/advanced.py");
    assert.ok(strict.details.results[0].score >= 100);
    assert.ok(strict.details.results.every(file => file.score >= strict.details.minScore));

    const whitespace = await executeGitHubExamples({ repo: "owner/content-repo", keyword: "   " });
    assert.equal(whitespace.details.contentScan.attempted, 0);
    assert.match(whitespace.content[0].text, /No keyword/);
  } finally { globalThis.fetch = originalFetch; }
});

test("github_examples reports partial bounded content-scan failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      const href = String(url);
      if (href === "https://api.github.com/repos/owner/partial") return jsonResponse({ default_branch: "main" });
      if (href.includes("/git/trees/main?recursive=1")) return jsonResponse({ tree: [
        { type: "blob", path: "examples/good.py", sha: "a", size: 100 },
        { type: "blob", path: "examples/limited.py", sha: "b", size: 100 },
      ] });
      if (href.includes("/contents/examples/good.py?ref=main")) return new Response("target example", { status: 200 });
      if (href.includes("/contents/examples/limited.py?ref=main")) return new Response("rate limited", { status: 403 });
      throw new Error(`unexpected fetch ${href}`);
    };
    const { executeGitHubExamples } = await import(`../github-examples.ts?partial=${Date.now()}`);
    const result = await executeGitHubExamples({ repo: "owner/partial", keyword: "target" });
    assert.deepEqual(result.details.contentScan, {
      attempted: 2, succeeded: 1, failed: 1, errors: ["GitHub API 403: rate limited"],
    });
    assert.match(result.content[0].text, /Content scan: 1\/2 succeeded; 1 failed/);
  } finally { globalThis.fetch = originalFetch; }
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
    assert.match(text, /Next: github_examples\(\{ operation: "read".*lineStart: 4, lineEnd: 4/);

    const tail = await executeGitHubExamples({ operation: "read", repo: "owner/repo", path: "examples/sft.py", ref: "main", lineStart: 3, lineEnd: 4 });
    assert.doesNotMatch(tail.content[0].text, /Next:/);
    assert.match(tail.content[0].text, /Earlier: github_examples\(\{ operation: "read".*lineStart: 1, lineEnd: 2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

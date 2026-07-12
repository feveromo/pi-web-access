import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";

import { extractStaticHtmlPartial, isLikelyJSRendered, preferJinaResult } from "../static-html-partial.ts";

const projectRoot = new URL("..", import.meta.url).pathname;
const runtimeMirror = mkdtempSync(join(tmpdir(), "pi-web-access-runtime-"));
for (const name of readdirSync(projectRoot).filter(name => /\.(?:ts|js)$/.test(name))) {
  if (name.endsWith(".ts")) {
    copyFileSync(join(projectRoot, name), join(runtimeMirror, name));
    const runtimeName = `${basename(name, ".ts")}.js`;
    try { symlinkSync(join(runtimeMirror, name), join(runtimeMirror, runtimeName)); } catch {}
  } else {
    symlinkSync(join(projectRoot, name), join(runtimeMirror, name));
  }
}
symlinkSync(join(projectRoot, "node_modules"), join(runtimeMirror, "node_modules"));
const extractModule = import(`${new URL(`file://${runtimeMirror}/extract.ts`).href}?test=${Date.now()}`);
after(() => rmSync(runtimeMirror, { recursive: true, force: true }));

function spaHtml(anchorCount = 2) {
  const anchors = [
    '<a href="/docs/getting-started">Docs</a>',
    '<a href="https://evil.example/steal">External</a>',
    ...Array.from({ length: Math.max(0, anchorCount - 2) }, (_, index) => `<a href="/route-${index}">Route ${index}</a>`),
  ].join("");
  return `<!doctype html><html><head>
    <title>Widget API</title>
    <meta name="description" content="Static description for the widget API.">
    <link rel="canonical" href="/home">
    <meta property="og:title" content="Widget OpenGraph">
    <meta property="og:description" content="OpenGraph description">
    <meta property="og:url" content="https://example.test/og-home">
    <link rel="manifest" href="/manifest.webmanifest">
    <script type="module" src="/assets/app.js"></script>
  </head><body><div id="root"></div>${anchors}</body></html>`;
}

test("JS shell extraction returns bounded static metadata and same-origin route evidence", () => {
  const html = spaHtml(80);
  assert.equal(isLikelyJSRendered(html), true);
  const result = extractStaticHtmlPartial(html, "https://example.test/app", "Page appears to be JavaScript-rendered");
  assert.equal(result.title, "Widget API");
  assert.match(result.content, /Partial extraction: JavaScript was not executed/);
  assert.match(result.content, /Static description/);
  assert.match(result.content, /Canonical URL: https:\/\/example\.test\/home/);
  assert.match(result.content, /Widget OpenGraph/);
  assert.match(result.content, /https:\/\/example\.test\/docs\/getting-started/);
  assert.match(result.content, /manifest\.webmanifest/);
  assert.match(result.content, /assets\/app\.js/);
  assert.doesNotMatch(result.content, /evil\.example/);
  assert.equal(result.metadata.staticEvidence.anchors.length, 40);
  assert.equal(result.metadata.staticHtmlPartial, true);
  assert.match(result.metadata.extractionWarning, /JavaScript-rendered/);
});

test("Jina result takes precedence over a static partial candidate", () => {
  const partial = extractStaticHtmlPartial(spaHtml(), "https://example.test/app", "incomplete");
  const jina = { method: "jina", content: "Rendered documentation" };
  assert.equal(preferJinaResult(jina, partial), jina);
  assert.equal(preferJinaResult(null, partial), partial);
});

async function withFailedJina(html, run) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => String(url).startsWith("https://r.jina.ai/")
      ? new Response("upstream unavailable", { status: 503 })
      : new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("failed Readability promotes a JS shell to explicit partial evidence after Jina fails", async () => {
  await withFailedJina(spaHtml(), async () => {
    const { extractContent } = await extractModule;
    const result = await extractContent(`https://shell-${Date.now()}.example.test/app`, undefined, { lookup: publicLookup });
    assert.equal(result.error, null);
    assert.equal(result.retrievalStatus, "partial");
    assert.equal(result.method, "static-html-partial");
    assert.match(result.metadata.extractionWarning, /JavaScript-rendered/);
  });
});

test("failed Readability keeps a short server-rendered page as an incomplete extraction after Jina fails", async () => {
  const html = "<!doctype html><html><head><title>Short Notice</title></head><body><main><p>Brief server-rendered notice.</p></main></body></html>";
  await withFailedJina(html, async () => {
    const { extractContent } = await extractModule;
    const result = await extractContent(`https://short-${Date.now()}.example.test/notice`, undefined, { lookup: publicLookup });
    assert.match(result.error, /Extracted content appears incomplete|Could not extract readable content/);
    assert.notEqual(result.retrievalStatus, "partial");
    assert.notEqual(result.method, "static-html-partial");
  });
});

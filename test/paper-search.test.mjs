import assert from "node:assert/strict";
import { test } from "node:test";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

test("paper_search parses compact OpenAlex records and abstracts", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requestedUrl = null;
    globalThis.fetch = async (url) => {
      requestedUrl = new URL(String(url));
      return jsonResponse({
        results: [{
          id: "https://openalex.org/W1",
          title: "Useful Paper",
          publication_year: 2024,
          doi: "https://doi.org/10.1234/example",
          cited_by_count: 42,
          authorships: [
            { author: { display_name: "Ada Lovelace" } },
            { author: { display_name: "Grace Hopper" } },
          ],
          primary_location: {
            landing_page_url: "https://example.test/paper",
            pdf_url: "https://example.test/paper.pdf",
            source: { display_name: "TestConf" },
          },
          open_access: { is_oa: true },
          abstract_inverted_index: { This: [0], works: [1], nicely: [2] },
        }],
      });
    };

    const { executePaperSearch } = await import(`../paper-search.ts?openalex=${Date.now()}`);
    const result = await executePaperSearch({ query: "test query", source: "openalex", includeAbstracts: true, maxResults: 1 });
    const text = result.content[0].text;

    assert.equal(result.details.count, 1);
    assert.match(requestedUrl.searchParams.get("select"), /abstract_inverted_index/);
    assert.match(text, /Useful Paper/);
    assert.match(text, /Ada Lovelace, Grace Hopper/);
    assert.match(text, /2024 · TestConf · 42 citations · open access/);
    assert.match(text, /PDF: https:\/\/example\.test\/paper\.pdf/);
    assert.match(text, /Abstract: This works nicely/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_search parses arXiv Atom records and PDF links", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => textResponse(`<?xml version="1.0"?>
      <feed>
        <entry>
          <id>http://arxiv.org/abs/2401.00001v1</id>
          <published>2024-01-02T00:00:00Z</published>
          <title><![CDATA[ Fast Sampling for Diffusion Models ]]></title>
          <summary><![CDATA[ A concise abstract. ]]></summary>
          <author><name>First Author</name></author>
          <author><name>Second Author</name></author>
          <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" />
        </entry>
      </feed>`);

    const { executePaperSearch } = await import(`../paper-search.ts?arxiv=${Date.now()}`);
    const result = await executePaperSearch({ query: "diffusion", source: "arxiv", includeAbstracts: true, maxResults: 1 });
    const text = result.content[0].text;

    assert.equal(result.details.count, 1);
    assert.match(text, /Fast Sampling for Diffusion Models/);
    assert.match(text, /Authors: First Author, Second Author/);
    assert.match(text, /2024 · arXiv · open access/);
    assert.match(text, /PDF: http:\/\/arxiv\.org\/pdf\/2401\.00001v1/);
    assert.match(text, /Abstract: A concise abstract\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_search failure details expose an error for collapsed UI", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("Rate exceeded.", { status: 429 });
    const { executePaperSearch } = await import(`../paper-search.ts?failure=${Date.now()}`);
    const result = await executePaperSearch({ query: "diffusion", source: "arxiv", maxResults: 1 });

    assert.equal(result.details.count, 0);
    assert.match(result.details.error, /arXiv error 429/);
    assert.match(result.content[0].text, /Paper search failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

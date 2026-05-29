import assert from "node:assert/strict";
import { test } from "node:test";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

test("paper_research searches OpenAlex with filters and abstracts", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requestedUrl;
    globalThis.fetch = async (url) => {
      requestedUrl = new URL(String(url));
      return jsonResponse({
        results: [{
          id: "https://openalex.org/W123",
          doi: "https://doi.org/10.1234/rag",
          title: "Grounded RAG Evaluation",
          publication_year: 2024,
          cited_by_count: 123,
          authorships: [{ author: { display_name: "Ada Lovelace" } }],
          primary_location: { landing_page_url: "https://example.test/paper", pdf_url: "https://example.test/paper.pdf", source: { display_name: "TestConf" } },
          open_access: { is_oa: true },
          abstract_inverted_index: { Evaluates: [0], RAG: [1], systems: [2] },
          topics: [{ display_name: "Retrieval Augmented Generation" }],
        }],
      });
    };

    const { executePaperResearch } = await import(`../paper-research.ts?search=${Date.now()}`);
    const result = await executePaperResearch({ operation: "search", query: "rag evaluation", minCitations: 10, sortBy: "citationCount", maxResults: 3 });
    const text = result.content[0].text;

    assert.equal(requestedUrl.pathname, "/works");
    assert.equal(requestedUrl.searchParams.get("search"), "rag evaluation");
    assert.equal(requestedUrl.searchParams.get("sort"), null);
    assert.match(text, /Grounded RAG Evaluation/);
    assert.match(text, /OpenAlex:\*\* W123/);
    assert.match(text, /2024 · TestConf · 123 citations · open access/);
    assert.match(text, /\*\*Abstract:\*\* Evaluates RAG systems/);
    assert.equal(result.details.provider, "openalex");
    assert.equal(result.details.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_research verifies arXiv IDs before binding OpenAlex works", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const requested = new URL(String(url));
      if (requested.hostname === "huggingface.co" && requested.pathname === "/api/papers/2401.00001") {
        return jsonResponse({ id: "2401.00001", title: "Exact arXiv Paper" });
      }
      if (requested.hostname === "api.openalex.org" && requested.pathname === "/works") {
        return jsonResponse({ results: [
          { id: "https://openalex.org/WWRONG", title: "Wrong Candidate", ids: { arxiv: "2401.99999" } },
          { id: "https://openalex.org/WRIGHT", title: "Exact arXiv Paper", ids: { arxiv: "https://arxiv.org/abs/2401.00001" } },
        ] });
      }
      throw new Error(`unexpected fetch ${requested}`);
    };

    const { executePaperResearch } = await import(`../paper-research.ts?arxiv=${Date.now()}`);
    const result = await executePaperResearch({ operation: "details", arxivId: "2401.00001" });
    const text = result.content[0].text;

    assert.equal(result.details.paper.id, "https://openalex.org/WRIGHT");
    assert.match(text, /Exact arXiv Paper/);
    assert.doesNotMatch(text, /Wrong Candidate/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_research builds OpenAlex citation graphs", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const requested = new URL(String(url));
      if (requested.pathname === "/works/W1") {
        return jsonResponse({
          id: "https://openalex.org/W1",
          title: "Anchor Paper",
          cited_by_count: 50,
          referenced_works: ["https://openalex.org/W2"],
        });
      }
      if (requested.pathname === "/works/W2") {
        return jsonResponse({ id: "https://openalex.org/W2", title: "Reference Paper", publication_year: 2020, cited_by_count: 12 });
      }
      if (requested.pathname === "/works" && requested.searchParams.get("filter") === "cites:W1") {
        return jsonResponse({ results: [{ id: "https://openalex.org/W3", title: "Downstream Paper", publication_year: 2025, cited_by_count: 7 }] });
      }
      throw new Error(`unexpected fetch ${requested}`);
    };

    const { executePaperResearch } = await import(`../paper-research.ts?graph=${Date.now()}`);
    const result = await executePaperResearch({ operation: "citation_graph", openAlexId: "W1", maxResults: 2 });
    const text = result.content[0].text;

    assert.equal(result.details.referencesCount, 1);
    assert.equal(result.details.citationsCount, 1);
    assert.match(text, /Reference Paper/);
    assert.match(text, /Downstream Paper/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_research linked_resources does not count failed categories as results", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse({ message: "nope" }, 500);

    const { executePaperResearch } = await import(`../paper-research.ts?linked-errors=${Date.now()}`);
    const result = await executePaperResearch({ operation: "linked_resources", arxivId: "2401.00001" });
    const text = result.content[0].text;

    assert.equal(result.details.count, 0);
    assert.match(text, /Error: HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_research reads specific arXiv HTML sections", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://arxiv.org/html/2401.00001");
      return textResponse(`
        <html><body>
          <h1 class="ltx_title">Title: Useful Paper</h1>
          <div class="ltx_abstract"><p>Abstract text.</p></div>
          <h2 class="ltx_title">1 Introduction</h2><p>Intro.</p>
          <h2 class="ltx_title">3 Method</h2><p>Exact recipe and hyperparameters.</p>
          <h2 class="ltx_title">4 Results</h2><p>Scores.</p>
        </body></html>
      `);
    };

    const { executePaperResearch } = await import(`../paper-research.ts?read=${Date.now()}`);
    const result = await executePaperResearch({ operation: "read_paper", arxivId: "2401.00001", section: "3" });
    const text = result.content[0].text;

    assert.match(text, /# 3 Method/);
    assert.match(text, /Exact recipe and hyperparameters/);
    assert.equal(result.details.section, "3 Method");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

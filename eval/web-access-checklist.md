# Web Access Manual Regression Checklist

Run from a Pi session after reloading the extension/tool schemas. These checks exercise the lean Exa/OpenAlex/arXiv/Hugging Face/docs/OpenAPI/GitHub/HTTP/PDF paths that this fork intentionally keeps.

## Before manual runs

- [ ] Run `npm run check` from the repo root.
  - Expect: syntax checks, Node tests, and `npm pack --dry-run` all pass.
- [ ] Reload the Pi extension/tool schemas before testing live tool behavior.
  - Expect: the loaded tools reflect the current checkout, not a previous session's extension code.

## Search

- [ ] Basic search: `web_search({ query: "OpenAI official web search docs", numResults: 3 })`
  - Expect: sources in content, `searchId` in details, no noisy metadata by default.
- [ ] Multi-query search: `web_search({ queries: ["OpenAI web search official docs", "OpenAI responses API web search examples"], numResults: 3 })`
  - Expect: two query sections, `queryCount: 2`, partial failures do not hide successful queries.
- [ ] Metadata: `web_search({ query: "Exa search API contents highlights", provider: "exa", returnMetadata: true })`
  - Expect: details/stored query metadata with provider API, source URLs, search type, and content mode.
- [ ] Source text: `web_search({ query: "Pi coding agent extension docs", includeContent: true, numResults: 3 })`
  - Expect: a `fetchId`, content fetch stats, and bounded source content retrievable via `get_search_content({ responseId: fetchId, urlIndex: 0 })`.
- [ ] Stored-content batch retrieval: use the `fetchId`/`responseId` from a multi-source search or fetch with `get_search_content({ responseId: fetchId, urlIndexes: [0, 1], maxChars: 2000 })`.
  - Expect: both requested sources in one response, per-item truncation markers only when the cap is hit, and accurate batch details.
- [ ] Current/status search guardrail: `web_search({ queries: ["official trading halt codes", "trading halt suspension official update"], recencyFilter: "month", livecrawl: "fallback", numResults: 3 })`
  - Expect: fresh/official-leaning sources when available; provider publication dates are shown when supplied; stale/conflicting snippets are obvious enough to trigger `fetch_content` on primary sources.

## Fetch

- [ ] Basic HTML fetch: `fetch_content({ url: "https://example.com", returnMetadata: true })`
  - Expect: `responseId`, `details.perUrl[0]`, `httpStatus`, `contentType`, `fetchedAt`, `method`, and stored content.
- [ ] Focused highlights: `fetch_content({ url: "https://example.com", mode: "highlights", objective: "domain ownership example", maxChars: 800, timeoutMs: 10000, returnMetadata: true })`
  - Expect: bounded content, `originalContentLength`, `truncated` if shaped/capped, `metadata.mode: "highlights"`.
- [ ] Multi-URL partial failure: `fetch_content({ urls: ["https://example.com", "https://example.com/definitely-404-web-access-test"], returnMetadata: true })`
  - Expect: one success and one error in `details.perUrl`; successful URL is still stored.
- [ ] 404 handling: `fetch_content({ url: "https://example.com/definitely-404-web-access-test", returnMetadata: true })`
  - Expect: error content, `responseId`, `details.perUrl[0].httpStatus` near 404.
- [ ] Long content durability: fetch a page large enough to exceed 24K chars with `returnMetadata: true`.
  - Expect: session entry remains compact; `details.perUrl[0].contentRef` appears when metadata is requested; `get_search_content` returns hydrated content while the disk cache exists.
- [ ] PDF URL: fetch a known public PDF URL.
  - Expect: method `pdf`, content points to saved markdown, no binary dump.
- [ ] GitHub URL: `fetch_content({ url: "https://github.com/owner/repo" })` and a `/blob/` file URL.
  - Expect: repo/tree/file content and `fallbackPath` including `github` when metadata is requested.
- [ ] JS-heavy fallback: fetch a known SPA or blocked page with `returnMetadata: true`.
  - Expect: `fallbackPath` showing HTTP/Jina attempts; final method indicates the successful fallback or clear error guidance.

## Paper Search / Research

- [ ] OpenAlex: `paper_search({ query: "retrieval augmented generation evaluation", includeAbstracts: true, maxResults: 5 })`
  - Expect: titles, authors, years, citations/open-access metadata when available.
- [ ] arXiv: `paper_search({ query: "diffusion model sampling", source: "arxiv", maxResults: 5 })`
  - Expect: arXiv records with PDF links when available.
- [ ] OpenAlex deep search: `paper_research({ operation: "search", query: "retrieval augmented generation evaluation", minCitations: 25, sortBy: "citationCount", maxResults: 5 })`
  - Expect: citation counts, OpenAlex IDs, DOI/PDF/arXiv metadata when available, abstracts, and next-step guidance.
- [ ] Topic map: `paper_research({ operation: "map_topic", query: "retrieval augmented generation evaluation", maxResults: 3 })`
  - Expect: anchor papers plus compact downstream/related branches.
- [ ] Citation graph: call `paper_research({ operation: "citation_graph", openAlexId: "<OpenAlex id from previous result>", direction: "citations", maxResults: 5 })`.
  - Expect: references and/or downstream citations from OpenAlex.
- [ ] Paper section: call `paper_research({ operation: "read_paper", arxivId: "<id>", section: "3" })`.
  - Expect: methodology/section text or clear fallback if arXiv HTML is unavailable.

## Docs / API / GitHub Examples

- [ ] Docs search: `docs_search({ source: "react.dev/reference/react", query: "useEffect cleanup", maxResults: 5 })`
  - Expect: indexed page count, ranked docs URLs, and concise snippets.
- [ ] OpenAPI search: `openapi_search({ query: "upload file", maxResults: 5 })`
  - Expect: endpoint method/path, parameters, and curl examples from the HF OpenAPI spec.
- [ ] GitHub examples: `github_examples({ operation: "find", repo: "huggingface/trl", keyword: "sft", maxResults: 5 })`
  - Expect: example paths and copyable `github_examples({ operation: "read", ... })` calls.
- [ ] GitHub read: use one returned file with `github_examples({ operation: "read", repo: "huggingface/trl", path: "<path>", lineStart: 1, lineEnd: 120 })`.
  - Expect: bounded file content with line range metadata.

## General expectations

- Every fetch result includes a `responseId`.
- Search calls include `searchId`; `includeContent` search calls also include a `fetchId` when source text is available.
- Fetch details include `perUrl`/`results` status entries for single and multi-URL calls.
- Partial failures do not hide successful URLs or queries.
- Metadata is absent from normal search/fetch output unless `returnMetadata` is true.
- Large source bodies are disk-backed instead of fully embedded in Pi's session log.

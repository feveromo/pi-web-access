# Web Access Manual Regression Checklist

Run from a Pi session after reloading the extension/tool schemas. These checks exercise the lean Exa/OpenAlex/GitHub/HTTP/PDF paths that this fork intentionally keeps.

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

## Paper Search

- [ ] OpenAlex: `paper_search({ query: "retrieval augmented generation evaluation", includeAbstracts: true, maxResults: 5 })`
  - Expect: titles, authors, years, citations/open-access metadata when available.
- [ ] arXiv: `paper_search({ query: "diffusion model sampling", source: "arxiv", maxResults: 5 })`
  - Expect: arXiv records with PDF links when available.

## General expectations

- Every fetch result includes a `responseId`.
- Search calls include `searchId`; `includeContent` search calls also include a `fetchId` when source text is available.
- Fetch details include `perUrl`/`results` status entries for single and multi-URL calls.
- Partial failures do not hide successful URLs or queries.
- Metadata is absent from normal search/fetch output unless `returnMetadata` is true.
- Large source bodies are disk-backed instead of fully embedded in Pi's session log.

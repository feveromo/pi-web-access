# Web Access Manual Regression Checklist

Run from a Pi session after reloading the extension/tool schemas. Tests marked optional need a configured provider key, browser login, or media binaries.

## Search

- [ ] Basic search: `web_search({ query: "OpenAI official web search docs", workflow: "none", numResults: 3 })`
  - Expect: `responseId`/`searchId` in details, sources in content, no noisy metadata by default.
- [ ] Multi-query search: `web_search({ queries: ["OpenAI web search official docs", "Gemini URL Context retrieval metadata"], workflow: "none", numResults: 3 })`
  - Expect: two query sections, `queryCount: 2`, `successfulQueries` reflects partial failures.
- [ ] Provider metadata (optional provider): `web_search({ queries: ["Gemini URL Context docs"], workflow: "none", provider: "gemini", returnMetadata: true })`
  - Expect: details/stored query metadata with provider API, source URLs, and Gemini grounding/search-query metadata when available.

## Fetch

- [ ] Basic HTML fetch: `fetch_content({ url: "https://example.com", returnMetadata: true })`
  - Expect: `responseId`, `details.perUrl[0]`, `httpStatus`, `contentType`, `fetchedAt`, `method`, and stored content.
- [ ] Focused highlights: `fetch_content({ url: "https://example.com", mode: "highlights", objective: "domain ownership example", maxChars: 800, timeoutMs: 10000, returnMetadata: true })`
  - Expect: bounded content, `originalContentLength`, `truncated` if shaped/capped, `metadata.mode: "highlights"`.
- [ ] Multi-URL partial failure: `fetch_content({ urls: ["https://example.com", "https://example.com/definitely-404-web-access-test"], returnMetadata: true })`
  - Expect: one success and one error in `details.perUrl`; successful URL is still stored.
- [ ] 404 handling: `fetch_content({ url: "https://example.com/definitely-404-web-access-test", returnMetadata: true })`
  - Expect: error content, `responseId`, `details.perUrl[0].httpStatus` near 404.
- [ ] PDF URL: fetch a known public PDF URL.
  - Expect: method `pdf`, content points to saved markdown, no binary dump.
- [ ] GitHub URL: `fetch_content({ url: "https://github.com/owner/repo" })` and a `/blob/` file URL.
  - Expect: repo/tree/file content and `fallbackPath` including `github` when metadata is requested.
- [ ] YouTube prompt/frame (optional `yt-dlp`/`ffmpeg`/Gemini): fetch with `prompt`, then with `timestamp`/`frames`.
  - Expect: prompt-aware text or image frames; frame content includes image items.
- [ ] JS-heavy fallback: fetch a known SPA or blocked page with `returnMetadata: true`.
  - Expect: `fallbackPath` showing HTTP/Jina/Gemini attempts; final method indicates the successful fallback or clear error guidance.

## General expectations

- Every fetch result includes a `responseId`.
- Fetch details include `perUrl`/`results` status entries for single and multi-URL calls.
- Partial failures do not hide successful URLs.
- `metadata` is absent from normal search output unless `returnMetadata` is true.
- Document any provider/browser/API-key path actually exercised when reporting validation.

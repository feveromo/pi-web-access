# Pi Web Access — Lean Fork

A slimmed-down fork of [`pi-web-access`](https://github.com/nicobailon/pi-web-access) for Pi, selectively synced with applicable retained upstream fixes through `v0.24.0`. This version is intentionally focused on one thing: fast, predictable research and content extraction without interactive review UIs, media analysis, or extra provider layers. It is designed to behave like close-to-the-metal Pi software: small API surface, bounded output, cancellable work, session-safe storage, and native TUI rendering.

## What is different in this fork?

This fork removes the heavier/less predictable parts of the original extension:

- **No curator UI** — `web_search` returns results directly. No browser page, no summary-review workflow, no `/curator`, no `/websearch`.
- **No background follow-up turns** — `fetch_content` stores content before the tool returns; `web_search` returns snippets and stores full result text for later retrieval.
- **Keyless local web search** — uses a self-hosted SearXNG meta-search instance (Google, Bing, DuckDuckGo, Brave, and more). There is no extension-enforced API quota, though upstream engines can throttle. Set `SEARXNG_URL` for an existing instance; the default local endpoint is `127.0.0.1:8888` and can be started on demand when a `start-web-search` (or `SEARXNG_START_HELPER`) executable is installed.
- **No legacy multi-provider paths** — fewer auth modes, fewer fallbacks, less latency variance.
- **No video / YouTube / frame extraction** — this is research/content extraction only.
- **No opaque `code_search` wrapper** — use explicit `docs_search`, `openapi_search`, `github_examples`, and `fetch_content` flows for docs/API/code evidence.
- **No RSC custom parser** — Readability first, then Jina Reader fallback for difficult pages.

The goal is a clean baseline: small surface area, fewer surprises, and easier quality measurement.

## Tools

### `web_search`

Keyless web research via SearXNG. Returns bounded source titles, URLs, and snippets; use `fetch_content` for full page text. Repeated searches use a bounded persistent cache, and concurrent duplicates collapse into one backend request. Ordinary searches stay fresh for 24 hours; recency searches use 10 minutes (`day`), 1 hour (`week`), 6 hours (`month`), or 24 hours (`year`). Transient refresh failures may return clearly labeled stale data up to seven days total age.

```ts
web_search({ query: "TypeScript generics official docs" })
web_search({ queries: ["React useEffect cleanup", "React effect cleanup fetch ignore"] })
web_search({ query: "latest Node.js release", recencyFilter: "month" })
web_search({ query: "site-specific docs", domainFilter: ["react.dev"] })
web_search({ query: "exclude noisy domain", domainFilter: ["-pinterest.com"] })
```

| Parameter | Description |
| --- | --- |
| `query` / `queries` | Single query or up to 8 varied queries; duplicates are removed and active requests are limited to 3 |
| `numResults` | Results per query, default 5, max 20 |
| `recencyFilter` | `day`, `week`, `month`, `year` (mapped to SearXNG `time_range`); when set, also pulls SearXNG's news engines and surfaces `publishedDate` next to dated sources, since news engines are the ones that reliably return dates |
| `domainFilter` | Include/exclude domains; multiple includes are ORed, while exclusions (prefixed with `-`) are applied together |
| `returnMetadata` | Include raw SearXNG engine/debug metadata; compact timing/count signals are always in `details.metrics` |

`details.metrics` reports result counts, unique domains, timing, cache, engine, and partial-failure signals. For full source text, follow `web_search` with `fetch_content` on the official/source URLs. The instance aggregates many engines; when one engine is upstream-rate-limited, the rest can keep contributing. General web engines do not reliably return publication dates; dates show up mainly when `recencyFilter` enables news results.

### `fetch_content`

Fetch URL(s) and extract readable markdown. Supports normal web pages, canonical npm package pages, GitHub repos/files, PDFs, text/JSON/Markdown, Readability extraction, and Jina fallback.

```ts
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["https://example.com", "https://www.iana.org/domains/example"] })
fetch_content({ url: "https://www.npmjs.com/package/@types/node" })
fetch_content({ url: "https://github.com/octocat/Hello-World" })
fetch_content({ url: "https://github.com/owner/repo/blob/main/README.md" })
fetch_content({ url: "https://example.com/article", mode: "highlights", objective: "license terms", maxChars: 1500 })
```

| Parameter | Description |
| --- | --- |
| `url` / `urls` | Single URL or up to 20 URLs; duplicates are removed and active requests are limited to 3 |
| `forceClone` | Force clone GitHub repos over the size threshold |
| `objective` | Focus objective for `highlights` / `summary` extraction |
| `queries` | Related terms used for focused extraction |
| `mode` | `full`, `highlights`, `summary` |
| `maxChars` | Character cap for shaped/stored content, max 1,000,000 |
| `timeoutMs` | Per-attempt timeout, 100–120,000 ms; default 30,000 |
| `returnMetadata` | Include content references and nested extraction/shaping metadata; compact status fields are always returned |

HTTP/text bodies are stream-limited to 5 MiB and PDFs to 20 MiB even when a server omits or lies about `Content-Length`. Canonical `npmjs.com/package/...` URLs use bounded public `registry.npmjs.org` metadata and report method `npm-registry`, including the selected version, package links, and a bounded README when published; registry 404s return directly without Jina. Direct fetches resolve and block private, loopback, link-local, cloud-metadata, and selected special-use targets by default, and every redirect hop is revalidated. Jina fallback validates the original target under stricter rules: `ssrf.allowRanges` never authorizes forwarding a private/internal source URL to that third party. Credential-bearing and signed URLs are also kept away from Jina.

When direct HTML is an incomplete SPA shell, Jina still gets precedence. If Jina fails or is unsafe to call, `fetch_content` stores a clearly marked partial result with `retrievalStatus: "partial"`, the original extraction warning, bounded title/meta/OpenGraph evidence, and same-origin documentation/API/manifest/module route candidates. It never executes page JavaScript or adds a browser runtime.

### `get_search_content`

Retrieve stored content from prior `web_search` or `fetch_content` calls. Single-item retrieval is full by default; batches default to 12,000 characters per item and a 60,000-character total response cap.

```ts
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", urlIndexes: [0, 1, 2] })
get_search_content({ responseId: "abc123", allUrls: true, maxChars: 3000 })
get_search_content({ responseId: "abc123", url: "https://example.com" })
get_search_content({ responseId: "abc123", queryIndex: 0 })
get_search_content({ responseId: "abc123", queryIndexes: [0, 2] })
```

### `paper_search`

Structured scholarly search via OpenAlex with arXiv fallback.

```ts
paper_search({ query: "retrieval augmented generation evaluation", includeAbstracts: true })
paper_search({ query: "diffusion models", source: "arxiv", maxResults: 5 })
```

| Parameter | Description |
| --- | --- |
| `query` | Scholarly search query |
| `source` | `auto`, `openalex`, `arxiv` |
| `maxResults` | Default 8, max 25 |
| `yearFrom` | Only include papers from this year onward |
| `openAccessOnly` | Limit OpenAlex results to open-access papers |
| `includeAbstracts` | Include abstracts when available |

### `paper_research`

No-key literature navigation via OpenAlex, arXiv/ar5iv HTML, and Hugging Face paper resources.

```ts
paper_research({ operation: "search", query: "RAG evaluation", minCitations: 25, sortBy: "citationCount" })
paper_research({ operation: "map_topic", query: "RAG evaluation", maxResults: 3 })
paper_research({ operation: "citation_graph", openAlexId: "W1234567890", direction: "citations" })
paper_research({ operation: "read_paper", arxivId: "2401.00001", section: "3" })
paper_research({ operation: "read_paper", arxivId: "2401.00001", section: "abstract" })
paper_research({ operation: "read_paper", arxivId: "2401.00001", section: "toc" })
paper_research({ operation: "abstract_search", query: "RAG faithfulness benchmark" })
paper_research({ operation: "linked_resources", arxivId: "2401.00001" })
```

Key operations: `search`, `map_topic`, `trending`, `details`, `read_paper`, `citation_graph`, `abstract_search`, `related`, `linked_resources`. For `read_paper`, `section` accepts an exact number/name plus the aliases `abstract` and `toc`.

### `docs_search`

Search official documentation roots and `llms.txt` indexes with a lightweight cached page index. Results use compact snippets by default; fetch only the selected full page when needed.

```ts
docs_search({ source: "react.dev/reference/react", query: "useEffect cleanup" })
docs_search({ source: "https://docs.example.com/llms.txt", query: "authentication", maxPages: 80 })
```

Use `fetch_content` on a result URL when you need the full docs page.

`docs_search` caches discovery indexes and individual pages separately for seven fresh days under the shared research cache. Concurrent searches share discovery and overlapping page fetches, while per-call cache metrics distinguish memory, disk, shared, fresh, stale, and failed page work. A transient refresh failure may use clearly labeled stale docs up to 30 days total age. OpenAPI specs stay fresh for 24 hours and have a seven-day hard-retention bound.

### `openapi_search`

Search OpenAPI JSON specs and return endpoint details with curl examples. Defaults to the Hugging Face OpenAPI spec when `url` is omitted.

```ts
openapi_search({ query: "upload file" })
openapi_search({ url: "https://api.example.com/openapi.json", query: "create webhook" })
```

### `github_examples`

Find and read current examples/tutorials/notebooks/cookbook files in GitHub repos without cloning first. Keyword searches use path scoring plus a bounded content scan of up to 8 likely small text/example files, returning matched terms and snippets without unbounded API traffic. `minScore` is the minimum final combined path/content score; whitespace-only keywords are treated as absent.

```ts
github_examples({ operation: "find", repo: "huggingface/trl", keyword: "sft" })
github_examples({ operation: "read", repo: "huggingface/trl", path: "examples/scripts/sft.py", lineStart: 1, lineEnd: 180 })
```

## Recommended workflow

1. Use `web_search` with 2–4 meaningfully different queries for broad discovery; full result text is stored for later `get_search_content` retrieval.
2. Prefer compact `docs_search` / `openapi_search` for official API details, then `fetch_content` the exact docs pages you need.
3. Prefer `github_examples` before writing code against fast-moving libraries; read the exact example file/range that matches the task.
4. Prefer `paper_search` for quick scholarly discovery and `paper_research` when you need OpenAlex citation graphs/topic maps, paper sections, abstract snippets, related works, or linked HF resources.
5. For current/news/market/status topics, set an appropriate `recencyFilter` (`day`/`week`/`month`/`year`) and include at least one risk/status query (`halt`, `suspension`, `outage`, `recall`, `official update`, `latest filing`, etc.).
6. Use `fetch_content` (not `web_search`) when you need full source text from a known URL.
7. Use `fetch_content` for selected pages, GitHub repos/files, and PDFs; one `urls: [...]` call is better than several one-at-a-time calls.
8. Use `get_search_content` when inline output was truncated or content was stored; prefer `urlIndexes`/`queryIndexes` batch retrieval over many one-at-a-time calls.

For code questions, the baseline approach is explicit:

```ts
docs_search({ source: "react.dev/reference/react", query: "useEffect cleanup" })
github_examples({ operation: "find", repo: "reactjs/react.dev", keyword: "useEffect" })
fetch_content({ url: "https://react.dev/reference/react/useEffect" })
```

Then inspect fetched repos/pages with normal Pi file tools (`read`, `rg`, `bash`) or `github_examples({ operation: "read" })` for remote file ranges instead of relying on an opaque code-search wrapper.

## Local validation

Use these checks before handing off or publishing changes:

```bash
npm run check
```

That wraps:

- `npm run syntax` — parses every root `*.ts` and `*.js` file with Node.
- `npm test` — runs the regression tests.
- `npm run scan:sensitive -- --all` — scans tracked files plus untracked package candidates for common credential patterns, private local paths, and accidental personal identifiers.
- `npm run pack:dry-run` — verifies the packed extension stays small and only ships intended files.

For Pi-runtime confidence after reloading tool schemas, also run the manual regression checklist in `eval/web-access-checklist.md`. If `npm ls` reports missing `@earendil-works/*` or `typebox` peer dependencies in a plain checkout, that is expected: Pi supplies those packages when loading the extension.

## Long research durability

Long research sessions should stay useful without stuffing giant blobs into Pi's session log.

- Search/fetch metadata is still persisted with `pi.appendEntry()` so `/search` and `get_search_content` survive reloads and tree navigation.
- Research caches live under `PI_WEB_ACCESS_RESEARCH_CACHE_DIR` or `~/.pi/web-access/research-cache/`. They use bounded, schema-validated entries and only prune exact files owned by this extension. Writes await coalesced quota maintenance; separate processes don't share a lock, so simultaneous cross-process writes can briefly exceed a limit until either process's final prune completes.
- Successful public `fetch_content` extractions persist below content shaping. Origin `s-maxage`/`max-age` is honored up to 24 hours; otherwise freshness is six hours, with a 24-hour hard-retention bound for transient refresh failures. GitHub, private/signed/credentialed URLs, errors, Jina fallbacks, `no-store`/`private` responses, and custom-network fetches are excluded.
- Large fetched source bodies are stored outside the session under `~/.pi/web-access/content/`; the session entry keeps a compact preview plus a content reference.
- `get_search_content` hydrates large bodies from that disk cache on demand, keeping the in-memory/session representation compact.
- ResponseId records and externalized content persist for seven days across sessions and reloads. Live and disk storage have count/byte bounds, and explicit deletion removes both the record and its owned externalized files. A single externalized batch is written and protected before pruning, so every returned reference remains valid; a batch larger than the 1,000-file/192 MiB quota may temporarily exceed it until the next batch triggers pruning.
- Paper query/list results have 24-hour hard freshness; immutable paper details and resolved HTML/sections have 30-day hard freshness, with no invented stale fallback window.
- Tool outputs are intentionally compact: `web_search` returns snippets and stores full result text, and `fetch_content` previews large single pages, while full stored results remain available through `get_search_content`.
- For tight context work, prefer `mode: "highlights"` / `"summary"` and set `maxChars` explicitly.

## GitHub behavior

- GitHub repo URLs are cloned locally when under the size threshold.
- Large repos use a lightweight GitHub API view unless `forceClone: true` is set.
- Blob URLs return file content.
- Tree URLs return directory context.
- The in-memory clone cache is reset on session changes, but temp clone directories stay useful across reloads/tree navigation. Before and after clone insertion, the default managed cache prunes entries older than 7 days and evicts the oldest entries above 20 repos or 2,000 MiB; active/current clones are protected. A custom `clonePath` is treated as user-owned and is never quota-pruned automatically.

## PDF behavior

PDF URLs are text-extracted, returned/stored as markdown, and saved in the managed `~/.pi/web-access/pdf-cache/` by default. Identical output is reused; differing existing files are never overwritten and receive a numeric suffix. The managed cache keeps files for 7 days and evicts the oldest files above 100 outputs or 250 MiB while protecting the current output. Set `PI_WEB_ACCESS_PDF_OUTPUT_DIR` to use an explicitly user-owned output directory; custom paths are never pruned. Existing files in `~/Downloads/` are not touched or migrated. Extraction defaults to at most 100 pages and 2,000,000 markdown characters, cleans up pdf.js resources, and honors cancellation before persistence and between pages. No OCR is performed.

## Configuration

Config uses `$PI_CODING_AGENT_DIR/web-search.json` when set, then `$XDG_CONFIG_HOME/pi/web-search.json`, and otherwise `~/.pi/web-search.json`. Every field is optional.

```json
{
  "githubToken": "github_pat_...",
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos",
    "maxCachedRepos": 20,
    "maxCacheSizeMB": 2000
  },
  "shortcuts": {
    "activity": "ctrl+shift+w"
  },
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

`web_search` is keyless, so no search API key is configured here. By default it targets `http://127.0.0.1:8888` (override the port with `SEARXNG_PORT`). Set `SEARXNG_URL` to use another HTTP(S) instance and `SEARXNG_START_HELPER` to choose the executable used when the default endpoint is down. The package does not install SearXNG itself; if no helper is available, start the configured instance separately and the tool returns a precise setup error. `GITHUB_TOKEN` takes precedence over `githubToken`; either one raises GitHub API limits for `github_examples`. No scholarly API key is required.

Keep the resolved `web-search.json` private (`chmod 600`) and never commit it. `ssrf.allowRanges` is an explicit escape hatch for trusted private networks or TUN/fake-IP proxy ranges; entries must be strict IPv4/IPv6 CIDRs (or single IPs), and broad `/0` exemptions are rejected. The guard validates DNS before each request/redirect and pins that hop's connection to the complete validated address set, while retaining the original hostname for HTTP Host, TLS SNI, and certificate verification. This closes the validate-then-fetch DNS-rebinding gap; it does not replace network-sandbox isolation. If a key is pasted into chat, shell history, logs, or a public issue, rotate it with the provider even if the repository scan is clean.

## Commands and UI

- `/search` — browse stored search/fetch results for the current session.
- `Ctrl+Shift+W` by default — toggle the activity widget.

There is intentionally no curator/browser UI in this fork.

## Current limitations

- No legacy multi-provider search stack, video, YouTube, or media analysis.
- No opaque dedicated code-search endpoint. Use `docs_search`, `openapi_search`, `github_examples`, `web_search`, and GitHub `fetch_content` explicitly.
- No custom RSC parser. Readability and Jina handle the baseline extraction path.
- PDF extraction is text-only; scanned PDFs need OCR elsewhere.
- Some sites block HTTP/Jina extraction; use `web_search` to find alternate sources or fetch raw/official URLs.
- `docs_search` discovery is intentionally shallow and bounded: `auto` prefers `llms.txt`, while `crawl` follows same-site links from the source page rather than recursively spidering an entire docs site.

## Active source files

| File | Purpose |
| --- | --- |
| `index.ts` | Extension entry, tool definitions, `/search`, activity widget |
| `searxng.ts` | Local SearXNG client + auto-start and self-check |
| `extract.ts` | URL routing and HTTP/Jina extraction orchestration |
| `github-extract.ts` | GitHub URL parsing, clone cache, repo/file extraction |
| `clone-process.js` | Non-interactive, timeout-safe GitHub clone process handling |
| `github-api.ts` | GitHub API fallback for large repos and commit/blob views |
| `pdf-extract.ts` | PDF text extraction to markdown |
| `paper-search.ts` | OpenAlex/arXiv scholarly search |
| `paper-research.ts` | OpenAlex topic maps/citation graphs/related works, arXiv section reading, and HF paper resources |
| `docs-research.ts` | Documentation/llms.txt indexing and OpenAPI endpoint search |
| `github-examples.ts` | GitHub API example discovery and remote file-range reads |
| `storage.ts` | Session-aware result storage with disk-backed large-content references |
| `activity.ts` | Request activity tracking widget |
| `search-types.ts` | Shared `SearchResult` type |
| `search-output.js` | Bounded, sanitized search snippet formatting |
| `http-response.js` | Shared timeout/body-size/error-response guards |

## Attribution

This fork is based on the original `pi-web-access` project. The main difference is intentional subtraction: fewer providers, fewer workflows, no media paths, no curator, and a smaller baseline designed for fast research and analysis inside Pi.

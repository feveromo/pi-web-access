# Pi Web Access — Lean Fork

A slimmed-down fork of [`pi-web-access`](https://github.com/nicobailon/pi-web-access) for Pi, synced with the useful upstream baseline fixes through `v0.10.7`. This version is intentionally focused on one thing: fast, predictable research and content extraction without interactive review UIs, media analysis, or extra provider layers. It is designed to behave like close-to-the-metal Pi software: small API surface, bounded output, cancellable work, session-safe storage, and native TUI rendering.

## What is different in this fork?

This fork removes the heavier/less predictable parts of the original extension:

- **No curator UI** — `web_search` returns results directly. No browser page, no summary-review workflow, no `/curator`, no `/websearch`.
- **No background follow-up turns** — if `includeContent` is requested, content is fetched/stored before the tool returns.
- **Exa-only web search** — direct Exa API when configured, otherwise Exa MCP fallback.
- **No legacy multi-provider paths** — fewer auth modes, fewer fallbacks, less latency variance.
- **No video / YouTube / frame extraction** — this is research/content extraction only.
- **No opaque `code_search` wrapper** — use explicit `docs_search`, `openapi_search`, `github_examples`, and `fetch_content` flows for docs/API/code evidence.
- **No RSC custom parser** — Readability first, then Jina Reader fallback for difficult pages.

The goal is a clean baseline: small surface area, fewer surprises, and easier quality measurement.

## Tools

### `web_search`

Exa-powered web research with source snippets/citations.

```ts
web_search({ query: "TypeScript generics official docs" })
web_search({ queries: ["React useEffect cleanup", "React effect cleanup fetch ignore"] })
web_search({ query: "latest Node.js release", recencyFilter: "month" })
web_search({ query: "site-specific docs", domainFilter: ["react.dev"] })
web_search({ query: "deep topic", researchDepth: "deep" })
web_search({ query: "need full source text", includeContent: true, contentMode: "text" })
web_search({ query: "synthesize this", synthesize: true })
```

| Parameter | Description |
| --- | --- |
| `query` / `queries` | Single query or multiple varied queries |
| `numResults` | Results per query, default 5, max 20 |
| `includeContent` | Fetch/store bounded source text before returning; fallback fetches default to 12K chars per source unless `maxCharacters` is set |
| `recencyFilter` | `day`, `week`, `month`, `year` |
| `domainFilter` | Include/exclude domains; prefix exclusions with `-` |
| `researchDepth` | `quick`, `standard`, `deep` |
| `searchType` | Exa type override: `fast`, `auto`, `deep-lite`, `deep`, `deep-reasoning` |
| `contentMode` | `none`, `highlights`, `summary`, `text` |
| `maxCharacters` | Per-result source text cap when requesting text content or `includeContent` fallback fetching |
| `livecrawl` | `never`, `fallback`, `always` |
| `synthesize` | Use Exa answer synthesis instead of source-passage output |
| `returnMetadata` | Include provider/source metadata in `details` |
| `provider` | `auto` or `exa` |

`details.metrics` reports useful quality signals: result counts, unique domains, answer chars, and snippet chars per query. When the provider supplies publication dates they are shown next to sources, which helps spot stale current-event results. When `includeContent` is enabled, `details.contentFetch` reports provider-inline vs fallback fetch coverage and timing.

### `fetch_content`

Fetch URL(s) and extract readable markdown. Supports normal web pages, GitHub repos/files, PDFs, text/JSON/Markdown, Readability extraction, and Jina fallback.

```ts
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["https://example.com", "https://www.iana.org/domains/example"] })
fetch_content({ url: "https://github.com/octocat/Hello-World" })
fetch_content({ url: "https://github.com/owner/repo/blob/main/README.md" })
fetch_content({ url: "https://example.com/article", mode: "highlights", objective: "license terms", maxChars: 1500 })
```

| Parameter | Description |
| --- | --- |
| `url` / `urls` | Single URL/path or multiple URLs |
| `forceClone` | Force clone GitHub repos over the size threshold |
| `objective` | Focus objective for `highlights` / `summary` extraction |
| `queries` | Related terms used for focused extraction |
| `mode` | `full`, `highlights`, `summary` |
| `maxChars` | Character cap for returned/stored content |
| `timeoutMs` | Per-request timeout |
| `returnMetadata` | Include method, fallback path, HTTP status/type, truncation info |

### `get_search_content`

Retrieve stored full content from prior `web_search(includeContent: true)` or `fetch_content` calls.

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
paper_research({ operation: "abstract_search", query: "RAG faithfulness benchmark" })
paper_research({ operation: "linked_resources", arxivId: "2401.00001" })
```

Key operations: `search`, `map_topic`, `trending`, `details`, `read_paper`, `citation_graph`, `abstract_search`, `related`, `linked_resources`.

### `docs_search`

Search official documentation roots and `llms.txt` indexes with a lightweight in-memory page index.

```ts
docs_search({ source: "react.dev/reference/react", query: "useEffect cleanup" })
docs_search({ source: "https://docs.example.com/llms.txt", query: "authentication", maxPages: 80 })
```

Use `fetch_content` on a result URL when you need the full docs page.

### `openapi_search`

Search OpenAPI JSON specs and return endpoint details with curl examples. Defaults to the Hugging Face OpenAPI spec when `url` is omitted.

```ts
openapi_search({ query: "upload file" })
openapi_search({ url: "https://api.example.com/openapi.json", query: "create webhook" })
```

### `github_examples`

Find and read current examples/tutorials/notebooks/cookbook files in GitHub repos without cloning first.

```ts
github_examples({ operation: "find", repo: "huggingface/trl", keyword: "sft" })
github_examples({ operation: "read", repo: "huggingface/trl", path: "examples/scripts/sft.py", lineStart: 1, lineEnd: 180 })
```

## Recommended workflow

1. Use `web_search` with 2–4 meaningfully different queries for broad discovery. Independent query searches run with small bounded concurrency for speed without API stampedes.
2. Prefer `docs_search` / `openapi_search` for official API details, then `fetch_content` the exact docs pages you need.
3. Prefer `github_examples` before writing code against fast-moving libraries; read the exact example file/range that matches the task.
4. Prefer `paper_search` for quick scholarly discovery and `paper_research` when you need OpenAlex citation graphs/topic maps, paper sections, abstract snippets, related works, or linked HF resources.
5. For current/news/market/status topics, use `livecrawl: "fallback"` or `"always"`, set an appropriate `recencyFilter`, and include at least one risk/status query (`halt`, `suspension`, `outage`, `recall`, `official update`, `latest filing`, etc.).
6. Use `includeContent: true` only when source text matters immediately.
7. Use `fetch_content` for selected pages, GitHub repos/files, and PDFs.
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

- `npm run syntax` — parses every root `*.ts` file with Node.
- `npm test` — runs the regression tests.
- `npm run scan:sensitive` — scans changed/untracked files for common credential patterns, private local paths, and accidental personal identifiers.
- `npm run pack:dry-run` — verifies the packed extension stays small and only ships intended files.

For Pi-runtime confidence after reloading tool schemas, also run the manual regression checklist in `eval/web-access-checklist.md`. If `npm ls` reports missing `@earendil-works/*` or `typebox` peer dependencies in a plain checkout, that is expected: Pi supplies those packages when loading the extension.

## Long research durability

Long research sessions should stay useful without stuffing giant blobs into Pi's session log.

- Search/fetch metadata is still persisted with `pi.appendEntry()` so `/search` and `get_search_content` survive reloads and tree navigation.
- Large fetched source bodies are stored outside the session under `~/.pi/web-access/content/`; the session entry keeps a compact preview plus a content reference.
- `get_search_content` hydrates from that disk cache when available, while current-session calls also keep full content in memory.
- Session restore keeps recent web-access entries for 24 hours; disk-backed large content is pruned after about 7 days.
- For tight context work, prefer `mode: "highlights"` / `"summary"` and set `maxChars` explicitly.

## GitHub behavior

- GitHub repo URLs are cloned locally when under the size threshold.
- Large repos use a lightweight GitHub API view unless `forceClone: true` is set.
- Blob URLs return file content.
- Tree URLs return directory context.
- The in-memory clone cache is reset on session changes, but temp clone directories are not eagerly deleted; stored repo paths stay useful across reloads/tree navigation. Old temp clones in the default cache are pruned after about 7 days or replaced by a later refresh.

## PDF behavior

PDF URLs are text-extracted and saved as markdown in `~/Downloads/`. No OCR is performed.

## Configuration

Config lives at `~/.pi/web-search.json` and every field is optional.

```json
{
  "exaApiKey": "exa-...",
  "githubToken": "github_pat_...",
  "provider": "exa",
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "shortcuts": {
    "activity": "ctrl+shift+w"
  }
}
```

`EXA_API_KEY` env var takes precedence over `exaApiKey`. If no Exa key is configured, the extension uses Exa MCP fallback. `GITHUB_TOKEN` takes precedence over `githubToken`; either one raises GitHub API limits for `github_examples`. No scholarly API key is required: `paper_research` uses OpenAlex, arXiv/ar5iv, and Hugging Face public endpoints.

Keep `~/.pi/web-search.json` private (`chmod 600 ~/.pi/web-search.json`) and never commit it. If a key is pasted into chat, shell history, logs, or a public issue, rotate it with the provider even if the repository scan is clean.

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
| `search.ts` | Lean Exa search routing and cache |
| `exa.ts` | Exa direct API and MCP fallback |
| `extract.ts` | URL routing and HTTP/Jina extraction orchestration |
| `github-extract.ts` | GitHub URL parsing, clone cache, repo/file extraction |
| `github-api.ts` | GitHub API fallback for large repos and commit/blob views |
| `pdf-extract.ts` | PDF text extraction to markdown |
| `paper-search.ts` | OpenAlex/arXiv scholarly search |
| `paper-research.ts` | OpenAlex topic maps/citation graphs/related works, arXiv section reading, and HF paper resources |
| `docs-research.ts` | Documentation/llms.txt indexing and OpenAPI endpoint search |
| `github-examples.ts` | GitHub API example discovery and remote file-range reads |
| `storage.ts` | Session-aware result storage with disk-backed large-content references |
| `activity.ts` | Request activity tracking widget |
| `search-types.ts` | Shared search option/result types |
| `search-text.ts` | Search snippet sanitization helpers |

## Attribution

This fork is based on the original `pi-web-access` project. The main difference is intentional subtraction: fewer providers, fewer workflows, no media paths, no curator, and a smaller baseline designed for fast research and analysis inside Pi.

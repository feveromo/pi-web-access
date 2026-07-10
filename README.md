# Pi Web Access — Lean Fork

A slimmed-down fork of [`pi-web-access`](https://github.com/nicobailon/pi-web-access) for Pi, synced with the useful upstream baseline fixes through `v0.10.7`. This version is intentionally focused on one thing: fast, predictable research and content extraction without interactive review UIs, media analysis, or extra provider layers. It is designed to behave like close-to-the-metal Pi software: small API surface, bounded output, cancellable work, session-safe storage, and native TUI rendering.

## What is different in this fork?

This fork removes the heavier/less predictable parts of the original extension:

- **No curator UI** — `web_search` returns results directly. No browser page, no summary-review workflow, no `/curator`, no `/websearch`.
- **No background follow-up turns** — `fetch_content` stores content before the tool returns; `web_search` returns snippets and stores full result text for later retrieval.
- **Keyless local web search** — runs a self-hosted SearXNG meta-search instance (Google, Bing, DuckDuckGo, Brave, and more) on `127.0.0.1:8888`. No API key, no quota, unlimited calls; the instance auto-starts on first use via `start-web-search` / `stop-web-search` helpers.
- **No legacy multi-provider paths** — fewer auth modes, fewer fallbacks, less latency variance.
- **No video / YouTube / frame extraction** — this is research/content extraction only.
- **No opaque `code_search` wrapper** — use explicit `docs_search`, `openapi_search`, `github_examples`, and `fetch_content` flows for docs/API/code evidence.
- **No RSC custom parser** — Readability first, then Jina Reader fallback for difficult pages.

The goal is a clean baseline: small surface area, fewer surprises, and easier quality measurement.

## Tools

### `web_search`

Keyless web research via the local SearXNG meta-search instance. Returns source titles, URLs, and snippets; use `fetch_content` for full page text. The instance auto-starts on first use (`start-web-search` / `stop-web-search`).

```ts
web_search({ query: "TypeScript generics official docs" })
web_search({ queries: ["React useEffect cleanup", "React effect cleanup fetch ignore"] })
web_search({ query: "latest Node.js release", recencyFilter: "month" })
web_search({ query: "site-specific docs", domainFilter: ["react.dev"] })
web_search({ query: "exclude noisy domain", domainFilter: ["-pinterest.com"] })
```

| Parameter | Description |
| --- | --- |
| `query` / `queries` | Single query or multiple varied queries |
| `numResults` | Results per query, default 5, max 20 |
| `recencyFilter` | `day`, `week`, `month`, `year` (mapped to SearXNG `time_range`); when set, also pulls SearXNG's news engines and surfaces `publishedDate` next to dated sources, since news engines are the ones that reliably return dates |
| `domainFilter` | Include/exclude domains; prefix exclusions with `-` (mapped to `site:` / `-site:`) |

`details.metrics` reports result counts, unique domains, and per-query signals. For full source text, follow `web_search` with `fetch_content` on the official/source URLs. The instance aggregates many engines; when one engine is upstream-rate-limited, the rest keep contributing, so results stay useful even under load. General web engines (Google/DuckDuckGo/Startpage) do not return publication dates; dates appear only for `news`-category results, so they show up mainly when `recencyFilter` is set.

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

Retrieve stored full content from prior `web_search` or `fetch_content` calls.

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

Search official documentation roots and `llms.txt` indexes with a lightweight cached page index. Results use compact snippets by default; fetch only the selected full page when needed.

```ts
docs_search({ source: "react.dev/reference/react", query: "useEffect cleanup" })
docs_search({ source: "https://docs.example.com/llms.txt", query: "authentication", maxPages: 80 })
```

Use `fetch_content` on a result URL when you need the full docs page.

`docs_search` keeps a small query-aware docs index in memory and on disk under `~/.pi/web-access/docs-cache/` for about 30 minutes. This survives quick Pi reloads without becoming a stale long-term docs mirror.

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

- `npm run syntax` — parses every root `*.ts` file with Node.
- `npm test` — runs the regression tests.
- `npm run scan:sensitive` — scans changed/untracked files for common credential patterns, private local paths, and accidental personal identifiers.
- `npm run pack:dry-run` — verifies the packed extension stays small and only ships intended files.

For Pi-runtime confidence after reloading tool schemas, also run the manual regression checklist in `eval/web-access-checklist.md`. If `npm ls` reports missing `@earendil-works/*` or `typebox` peer dependencies in a plain checkout, that is expected: Pi supplies those packages when loading the extension.

## Long research durability

Long research sessions should stay useful without stuffing giant blobs into Pi's session log.

- Search/fetch metadata is still persisted with `pi.appendEntry()` so `/search` and `get_search_content` survive reloads and tree navigation.
- `docs_search` stores short-lived docs indexes under `~/.pi/web-access/docs-cache/` for quick reuse across reloads; the TTL is about 30 minutes to limit staleness.
- Large fetched source bodies are stored outside the session under `~/.pi/web-access/content/`; the session entry keeps a compact preview plus a content reference.
- `get_search_content` hydrates from that disk cache when available, while current-session calls also keep full content in memory.
- Session restore keeps recent web-access entries for 24 hours; disk-backed large content is pruned after about 7 days.
- Tool outputs are intentionally compact: `web_search` returns snippets and stores full result text, and `fetch_content` previews large single pages, while full stored results remain available through `get_search_content`.
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
  "githubToken": "github_pat_...",
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

`web_search` is keyless: it talks to the local SearXNG instance (see `start-web-search` / `stop-web-search`), so no search API key is configured here. `GITHUB_TOKEN` takes precedence over `githubToken`; either one raises GitHub API limits for `github_examples`. No scholarly API key is required: `paper_research` uses OpenAlex, arXiv/ar5iv, and Hugging Face public endpoints.

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
| `searxng.ts` | Local SearXNG client + auto-start and self-check |
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
| `search-types.ts` | Shared `SearchResult` type |

## Attribution

This fork is based on the original `pi-web-access` project. The main difference is intentional subtraction: fewer providers, fewer workflows, no media paths, no curator, and a smaller baseline designed for fast research and analysis inside Pi.

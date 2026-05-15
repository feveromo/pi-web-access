# Pi Web Access — Lean Fork

A slimmed-down fork of [`pi-web-access`](https://github.com/nicobailon/pi-web-access) for Pi, synced with the useful upstream baseline fixes through `v0.10.7`. This version is intentionally focused on one thing: fast, predictable research and content extraction without interactive review UIs, media analysis, or extra provider layers.

## What is different in this fork?

This fork removes the heavier/less predictable parts of the original extension:

- **No curator UI** — `web_search` returns results directly. No browser page, no summary-review workflow, no `/curator`, no `/websearch`.
- **No background follow-up turns** — if `includeContent` is requested, content is fetched/stored before the tool returns.
- **Exa-only web search** — direct Exa API when configured, otherwise Exa MCP fallback.
- **No Gemini / Perplexity paths** — fewer auth modes, fewer fallbacks, less latency variance.
- **No video / YouTube / frame extraction** — this is research/content extraction only.
- **No `code_search` wrapper** — use `web_search` for docs/examples and `fetch_content` for GitHub repos/files.
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
| `includeContent` | Fetch/store bounded source text before returning |
| `recencyFilter` | `day`, `week`, `month`, `year` |
| `domainFilter` | Include/exclude domains; prefix exclusions with `-` |
| `researchDepth` | `quick`, `standard`, `deep` |
| `searchType` | Exa type override: `fast`, `auto`, `deep-lite`, `deep`, `deep-reasoning` |
| `contentMode` | `none`, `highlights`, `summary`, `text` |
| `maxCharacters` | Per-result text cap when requesting text content |
| `livecrawl` | `never`, `fallback`, `always` |
| `synthesize` | Use Exa answer synthesis instead of source-passage output |
| `returnMetadata` | Include provider/source metadata in `details` |
| `provider` | `auto` or `exa` |

`details.metrics` reports useful quality signals: result counts, unique domains, answer chars, and snippet chars per query. When `includeContent` is enabled, `details.contentFetch` reports provider-inline vs fallback fetch coverage and timing.

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
get_search_content({ responseId: "abc123", url: "https://example.com" })
get_search_content({ responseId: "abc123", queryIndex: 0 })
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

## Recommended workflow

1. Use `web_search` with 2–4 meaningfully different queries.
2. Prefer official docs/source domains with `domainFilter` when accuracy matters.
3. Use `includeContent: true` only when source text matters immediately.
4. Use `fetch_content` for selected pages, GitHub repos/files, and PDFs.
5. Use `get_search_content` when inline output was truncated or content was stored.

For code questions, the baseline approach is explicit:

```ts
web_search({ queries: [
  "React useEffect cleanup official docs",
  "React useEffect cleanup fetch ignore example"
] })
fetch_content({ url: "https://github.com/reactjs/react.dev" })
```

Then inspect fetched repos with normal Pi file tools (`read`, `rg`, `bash`) instead of relying on a separate opaque code-search wrapper.

## GitHub behavior

- GitHub repo URLs are cloned locally when under the size threshold.
- Large repos use a lightweight GitHub API view unless `forceClone: true` is set.
- Blob URLs return file content.
- Tree URLs return directory context.
- Clone cache is session-scoped and cleared on session changes.

## PDF behavior

PDF URLs are text-extracted and saved as markdown in `~/Downloads/`. No OCR is performed.

## Configuration

Config lives at `~/.pi/web-search.json` and every field is optional.

```json
{
  "exaApiKey": "exa-...",
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

`EXA_API_KEY` env var takes precedence over `exaApiKey`. If no Exa key is configured, the extension uses Exa MCP fallback.

## Commands and UI

- `/search` — browse stored search/fetch results for the current session.
- `Ctrl+Shift+W` by default — toggle the activity widget.

There is intentionally no curator/browser UI in this fork.

## Current limitations

- No Gemini, Perplexity, video, YouTube, or media analysis.
- No dedicated code-search endpoint. Use `web_search` + GitHub `fetch_content` instead.
- No custom RSC parser. Readability and Jina handle the baseline extraction path.
- PDF extraction is text-only; scanned PDFs need OCR elsewhere.
- Some sites block HTTP/Jina extraction; use `web_search` to find alternate sources or fetch raw/official URLs.

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
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Request activity tracking widget |
| `search-types.ts` | Shared search option/result types |

## Attribution

This fork is based on the original `pi-web-access` project. The main difference is intentional subtraction: fewer providers, fewer workflows, no media paths, no curator, and a smaller baseline designed for fast research and analysis inside Pi.

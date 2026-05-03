<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Lean Exa-powered web research, content extraction, GitHub/PDF fetching, and scholarly search for Pi agent. Zero config with Exa MCP, or bring your own Exa API key.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). Add an Exa API key only when you want direct API access.

**Lean Research Core** — Exa search returns useful source snippets fast. URL fetching uses deterministic extraction paths only: GitHub clone, PDF/text parsing, Readability/RSC, then Jina Reader fallback.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-web-access
```

Works immediately with no API keys — Exa MCP provides zero-config search. For direct API access, add an Exa key to `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-..."
}
```

In `auto` mode (default), `web_search` uses Exa direct API when keyed, otherwise the zero-config Exa MCP path.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Search scholarly papers
paper_search({ query: "retrieval augmented generation evaluation", includeAbstracts: true })
```

## Tools

### web_search

Search the web via Exa. Defaults to fast Exa source-passages with citations; set `synthesize: true` for Exa answer synthesis.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "exa" })
web_search({ query: "...", researchDepth: "deep", contentMode: "highlights" })
web_search({ query: "...", contentMode: "text", maxCharacters: 12000 })
web_search({ query: "...", synthesize: true })
web_search({ queries: ["query 1", "query 2"], returnMetadata: true })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | `auto` (default) or `exa` |
| `includeContent` | Include bounded full text from Exa when available |
| `researchDepth` | `quick` (default fast), `standard`, or `deep` Exa retrieval profile |
| `searchType` | Explicit Exa type: `fast`, `auto`, `deep-lite`, `deep`, or `deep-reasoning` |
| `contentMode` | Exa result content: `none`, `highlights` (default), `summary`, or `text` |
| `maxCharacters` | Character cap per Exa text result when using `contentMode: "text"` |
| `livecrawl` | Exa livecrawl mode: `never`, `fallback`, or `always` |
| `synthesize` | Use Exa answer synthesis instead of fast source-passage search |
| `returnMetadata` | Include provider/debug metadata (citations and Exa source data) in `details` and stored search results |

`web_search` also returns lightweight `details.metrics` (result counts, unique domains, answer/snippet character counts) and, when `includeContent` is true, `details.contentFetch` coverage/timing for measuring retrieval quality without another turn.

### code_search

Search for code examples, documentation, and API references via Exa MCP. No API key required.

```typescript
code_search({ query: "React useEffect cleanup pattern" })
code_search({ query: "Express middleware error handling", maxTokens: 10000 })
```

| Parameter | Description |
|-----------|-------------|
| `query` | Programming question, API, library, or debugging topic |
| `maxTokens` | Maximum tokens of context to return (default: 5000, max: 50000) |

### paper_search

Search scholarly papers via OpenAlex, with arXiv support/fallback. No API key required.

```typescript
paper_search({ query: "transformer mechanistic interpretability", includeAbstracts: true })
paper_search({ query: "graph neural networks molecules", yearFrom: 2022, openAccessOnly: true })
paper_search({ query: "diffusion models", source: "arxiv", maxResults: 5 })
```

| Parameter | Description |
|-----------|-------------|
| `query` | Scholarly literature query |
| `source` | `auto` (default), `openalex`, or `arxiv` |
| `maxResults` | Maximum papers (default 8, max 25) |
| `yearFrom` | Only include papers from this year onward |
| `openAccessOnly` | Limit OpenAlex results to open-access papers |
| `includeAbstracts` | Include abstracts when available |

### fetch_content

Fetch URL(s) and extract readable content as markdown. Handles regular web pages, GitHub repos, PDFs, and text/JSON/Markdown.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ url: "https://example.com/article", mode: "highlights", objective: "ownership and usage rights", maxChars: 1200, returnMetadata: true })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://example.com/blocked" })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |
| `objective` | Focus objective used to rank `highlights`/`summary` excerpts |
| `queries` | Related search queries used as relevance terms for focused extraction |
| `mode` | `full` (default), `highlights`, or `summary` content shaping |
| `maxChars` | Maximum characters to return/store after content shaping; sets `truncated`/`originalContentLength` metadata |
| `timeoutMs` | Per-request timeout in milliseconds for HTTP/Jina fetch paths |
| `returnMetadata` | Include extraction metadata in `details.perUrl` (method, `fallbackPath`, HTTP status/type, fetched URL/time, retrieval status) |

### get_search_content

Retrieve stored content from previous searches or fetches. Content over 30,000 chars is truncated in tool responses but stored in full for retrieval here.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://..." })
get_search_content({ responseId: "abc123", query: "original query" })
```

## Recommended agent workflow

1. Search with `queries` containing 2–4 varied angles; prefer official docs or `domainFilter` when source quality matters.
2. Fetch only the most relevant sources from search results. Use `mode: "highlights"` plus an `objective` for token-efficient fact gathering, and `mode: "full"` when auditing exact wording.
3. Inspect `details.perUrl` before citing fetched content. It reports success/error, extraction `method`, `fallbackPath`, HTTP status/type, fetched URL/time, and truncation fields.
4. Use `returnMetadata: true` when debugging provider behavior or source quality; leave it off for normal concise output.
5. Retrieve stored full results with `get_search_content({ responseId, urlIndex })` when inline output is truncated.

## Current limits

Extraction is intentionally lossy for many web pages: Readability removes navigation/ads and may omit app-rendered content. This tool does not bypass paywalls or access controls. JavaScript-heavy sites may need Jina or a more specific/raw source URL. Raw HTML output, robots.txt enforcement, and cache-only/max-age policies are not implemented in this pass; HTTP/Jina fetches are live requests.

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI.

### PDFs

PDF URLs are extracted as text and saved to `~/Downloads/` as markdown. The agent can then `read` specific sections without loading the full document into context. Text-based extraction only — no OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension retries via Jina Reader (handles many JS-rendered pages server-side, no API key needed). It also parses Next.js RSC flight data when present.

## How It Works

```
web_search(query)
  → Exa (direct API with key, MCP without)

fetch_content(url)
  → GitHub URL?  Clone repo, return file contents + local path
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Jina Reader
               → Text/JSON/Markdown? Return directly
```

## Skills

### librarian

Bundled research workflow for investigating open-source libraries. Combines GitHub cloning, web search, and git operations (blame, log, show) to produce evidence-backed answers with permalinks. Pi loads it automatically based on your prompt. Also available via `/skill:librarian` with [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette).

## Commands

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

All config lives in `~/.pi/web-search.json`. Every field is optional.

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
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

`EXA_API_KEY` env var takes precedence over the config file value. `provider` sets the default search provider (`"exa"`; `"auto"` also resolves to Exa).

### Shortcuts

The activity shortcut is configurable via `~/.pi/web-search.json`:

```json
{
  "shortcuts": {
    "activity": "ctrl+shift+w"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`). Changes take effect on next pi restart.

Config changes require a Pi restart.

Rate limits: Exa direct API requests are tracked against the monthly free tier. Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy, budget tracking |
| `code-search.ts` | Code/docs search via Exa MCP |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `search.ts` | Lean Exa search routing and cache |
| `paper-search.ts` | Scholarly paper search via OpenAlex/arXiv |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |
| `skills/librarian/` | Bundled skill for library research |

</details>

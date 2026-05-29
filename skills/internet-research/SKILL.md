---
name: internet-research
description: Evidence-first internet research workflow for Pi Web Access. Use when researching current facts, papers, APIs, libraries, examples, docs, or implementation approaches with web_search, paper_research, docs_search, openapi_search, github_examples, fetch_content, and get_search_content.
license: MIT
---

# Internet Research Workflow

Use this skill when a task needs current external evidence, library/API accuracy, or literature-backed implementation choices.

## Tool choice

- `web_search`: broad current web discovery. Prefer 2-4 varied `queries` for broad topics.
- `paper_search`: quick scholarly search via OpenAlex/arXiv.
- `paper_research`: no-key deep literature work: `search`, `map_topic`, `citation_graph`, `read_paper`, `abstract_search`, `related`, `linked_resources`.
- `docs_search`: official docs/`llms.txt` discovery. Follow promising results with `fetch_content`.
- `openapi_search`: REST endpoint lookup from OpenAPI specs, with curl examples.
- `github_examples`: find/read current example scripts, notebooks, tutorials, and cookbook files.
- `fetch_content`: fetch selected pages, docs, PDFs, and GitHub URLs; use `mode: "highlights"` or `"summary"` for tight context.
- `get_search_content`: retrieve stored full content after `web_search(includeContent: true)` or `fetch_content`.

## Evidence-first loops

### Papers / science / ML

1. Start with `paper_search` or `paper_research({ operation: "search" })`.
2. Use `paper_research({ operation: "map_topic" })` to build a compact anchor → downstream/related map for a topic.
3. For anchor papers, call `paper_research({ operation: "citation_graph", direction: "citations" })` to find recent downstream work.
4. Read the actual methodology/results sections with `paper_research({ operation: "read_paper", section: "3" })` and nearby sections when an arXiv ID exists.
5. Use `paper_research({ operation: "abstract_search" })` for claim searches across OpenAlex titles/abstracts; fetch PDFs or use `read_paper` for full text.
6. Use `paper_research({ operation: "linked_resources" })` to find HF datasets/models attached to arXiv papers.
7. Attribute conclusions to a result and method, not just a title or abstract.

### Library/API implementation

1. Use `docs_search` against official docs or `llms.txt` first.
2. Fetch exact docs pages with `fetch_content`.
3. Use `github_examples({ operation: "find" })` to locate working examples in official repos.
4. Use `github_examples({ operation: "read" })` with line ranges to inspect concrete imports, config names, and call patterns.
5. Use `openapi_search` for REST endpoints and required parameters.

### Broad web research

1. Use `web_search` with varied queries and domain filters where possible.
2. Fetch only the most authoritative or directly relevant sources.
3. Prefer primary sources over summaries.
4. Keep notes compact: answer, evidence, uncertainty, source URLs.

## Output discipline

- Cite source URLs directly.
- Distinguish confirmed facts from plausible inferences.
- Flag stale, conflicting, or low-confidence evidence.
- For implementation recommendations, include exact file paths, docs URLs, endpoint paths, and code patterns read from sources.

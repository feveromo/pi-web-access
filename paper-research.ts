import { parseHTML } from "linkedom";
import pLimit from "p-limit";

export type PaperResearchOperation =
	| "search"
	| "map_topic"
	| "trending"
	| "details"
	| "read_paper"
	| "citation_graph"
	| "abstract_search"
	| "related"
	| "linked_resources";

export interface PaperResearchParams {
	operation: PaperResearchOperation;
	query?: string;
	arxivId?: string;
	doi?: string;
	openAlexId?: string;
	paperId?: string;
	section?: string;
	direction?: "citations" | "references" | "both";
	date?: string;
	yearFrom?: number;
	yearTo?: number;
	openAccessOnly?: boolean;
	minCitations?: number;
	sortBy?: "relevance" | "citationCount" | "publicationDate";
	maxResults?: number;
	resourceSort?: "downloads" | "likes" | "trending";
	includeAbstracts?: boolean;
}

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

interface OpenAlexWork {
	id?: string;
	doi?: string;
	title?: string;
	display_name?: string;
	publication_year?: number;
	publication_date?: string;
	cited_by_count?: number;
	authorships?: Array<{ author?: { display_name?: string } }>;
	primary_location?: {
		landing_page_url?: string;
		pdf_url?: string;
		source?: { display_name?: string };
	};
	open_access?: { is_oa?: boolean; oa_url?: string };
	abstract_inverted_index?: Record<string, number[]>;
	referenced_works?: string[];
	related_works?: string[];
	concepts?: Array<{ display_name?: string; score?: number }>;
	topics?: Array<{ display_name?: string; score?: number }>;
	ids?: Record<string, string>;
}

interface HfPaper {
	id?: string;
	title?: string;
	summary?: string;
	ai_summary?: string;
	ai_keywords?: string[];
	githubRepo?: string;
	githubStars?: number;
	upvotes?: number;
}

interface ParsedSection {
	id: string;
	title: string;
	level: number;
	text: string;
}

interface ParsedPaperHtml {
	title: string;
	abstract: string;
	sections: ParsedSection[];
}

const OPENALEX_API = "https://api.openalex.org";
const HF_API = "https://huggingface.co/api";
const ARXIV_HTML = "https://arxiv.org/html";
const AR5IV_HTML = "https://ar5iv.labs.arxiv.org/html";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESULTS = 50;
const MAX_SECTION_CHARS = 12000;
const FETCH_CONCURRENCY = 5;

const OPENALEX_FIELDS = [
	"id",
	"doi",
	"title",
	"display_name",
	"publication_year",
	"publication_date",
	"cited_by_count",
	"authorships",
	"primary_location",
	"open_access",
	"abstract_inverted_index",
	"referenced_works",
	"related_works",
	"concepts",
	"topics",
	"ids",
].join(",");

const fetchLimit = pLimit(FETCH_CONCURRENCY);
const jsonCache = new Map<string, unknown>();

function clampInt(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

function requestSignal(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error && err.name === "TimeoutError") return `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
	return err instanceof Error ? err.message : String(err);
}

function truncate(text: string | undefined, max = 500): string {
	if (!text) return "";
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized;
}

function normalizeArxivId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let id = value.trim();
	if (!id) return null;
	id = id
		.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|html|pdf)\//i, "")
		.replace(/^arxiv:/i, "")
		.replace(/\.pdf$/i, "")
		.replace(/[?#].*$/, "")
		.trim();
	id = id.replace(/v\d+$/i, "");
	return id || null;
}

function normalizeDoi(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let doi = value.trim();
	if (!doi) return null;
	doi = doi
		.replace(/^doi:/i, "")
		.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
		.trim();
	return doi || null;
}

function normalizeOpenAlexId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
	return match ? match[1].toUpperCase() : null;
}

function candidateArxivId(params: PaperResearchParams): string | null {
	return normalizeArxivId(params.arxivId) ?? normalizeArxivId(params.paperId);
}

function candidateDoi(params: PaperResearchParams): string | null {
	return normalizeDoi(params.doi) ?? normalizeDoi(params.paperId);
}

function candidateOpenAlexId(params: PaperResearchParams): string | null {
	return normalizeOpenAlexId(params.openAlexId) ?? normalizeOpenAlexId(params.paperId);
}

function openAlexShortId(workOrId: OpenAlexWork | string | undefined): string | null {
	const raw = typeof workOrId === "string" ? workOrId : workOrId?.id;
	return normalizeOpenAlexId(raw);
}

function workTitle(work: OpenAlexWork): string {
	return work.display_name || work.title || "Untitled";
}

function reconstructAbstract(index: Record<string, number[]> | undefined): string {
	if (!index) return "";
	const words: Array<{ word: string; pos: number }> = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const pos of positions) {
			if (typeof pos === "number") words.push({ word, pos });
		}
	}
	return words.sort((a, b) => a.pos - b.pos).map(item => item.word).join(" ");
}

function authors(work: OpenAlexWork): string[] {
	return work.authorships?.map(a => a.author?.display_name).filter((name): name is string => !!name) ?? [];
}

function formatAuthors(names: string[]): string {
	if (names.length <= 4) return names.join(", ");
	return `${names.slice(0, 4).join(", ")} et al.`;
}

function workUrl(work: OpenAlexWork): string {
	if (work.doi) return `https://doi.org/${normalizeDoi(work.doi) ?? work.doi}`;
	return work.primary_location?.landing_page_url || work.id || "";
}

function pdfUrl(work: OpenAlexWork): string {
	return work.primary_location?.pdf_url || work.open_access?.oa_url || "";
}

function arxivIdFromWork(work: OpenAlexWork): string | null {
	const values = [work.ids?.arxiv, work.primary_location?.landing_page_url, work.primary_location?.pdf_url, work.open_access?.oa_url].filter(Boolean) as string[];
	for (const value of values) {
		const arxiv = normalizeArxivId(value);
		if (arxiv && /^\d{4}\.\d{4,5}/.test(arxiv)) return arxiv;
	}
	return null;
}

function workMatchesArxivId(work: OpenAlexWork, arxivId: string): boolean {
	const expected = normalizeArxivId(arxivId)?.toLowerCase();
	const actual = arxivIdFromWork(work)?.toLowerCase();
	return !!expected && !!actual && expected === actual;
}

function metadataBits(work: OpenAlexWork): string {
	return [
		work.publication_year ? String(work.publication_year) : null,
		work.primary_location?.source?.display_name,
		work.cited_by_count != null ? `${work.cited_by_count} citations` : null,
		work.open_access?.is_oa ? "open access" : null,
	].filter(Boolean).join(" · ");
}

function topicNames(work: OpenAlexWork): string[] {
	const topics = work.topics?.map(t => t.display_name).filter((name): name is string => !!name) ?? [];
	const concepts = work.concepts?.map(c => c.display_name).filter((name): name is string => !!name) ?? [];
	return [...topics, ...concepts].slice(0, 6);
}

async function fetchJson<T>(url: URL, signal?: AbortSignal, useCache = true): Promise<T> {
	const key = url.toString();
	if (useCache && jsonCache.has(key)) return jsonCache.get(key) as T;
	const res = await fetch(url, {
		headers: { "User-Agent": "pi-web-access/0.10 (https://github.com/feveromo/pi-web-access)" },
		signal: requestSignal(signal),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 250)}`);
	const data = await res.json() as T;
	if (useCache && jsonCache.size < 500) jsonCache.set(key, data);
	return data;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; url: string }> {
	const res = await fetch(url, {
		headers: { "Accept": "text/html,text/markdown,text/plain,*/*", "User-Agent": "pi-web-access/0.10" },
		signal: requestSignal(signal, 30000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return { text: await res.text(), url: res.url || url };
}

function addOpenAlexFilters(url: URL, params: PaperResearchParams): void {
	const filters: string[] = [];
	if (params.yearFrom) filters.push(`from_publication_date:${Math.floor(params.yearFrom)}-01-01`);
	if (params.yearTo) filters.push(`to_publication_date:${Math.floor(params.yearTo)}-12-31`);
	if (params.openAccessOnly) filters.push("is_oa:true");
	if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
}

function queryFitScore(work: OpenAlexWork, query: string): number {
	const tokens = tokenize(query);
	if (tokens.length === 0) return 0;
	const title = workTitle(work).toLowerCase();
	const abstract = reconstructAbstract(work.abstract_inverted_index).toLowerCase();
	const topics = topicNames(work).join(" ").toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (title.includes(token)) score += 5;
		if (topics.includes(token)) score += 3;
		if (abstract.includes(token)) score += 1;
	}
	return score;
}

function sortRelevantWorks(works: OpenAlexWork[], sortBy: PaperResearchParams["sortBy"], query: string): OpenAlexWork[] {
	if (sortBy === "citationCount") {
		return [...works].sort((a, b) => queryFitScore(b, query) - queryFitScore(a, query) || (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
	}
	if (sortBy === "publicationDate") {
		return [...works].sort((a, b) => queryFitScore(b, query) - queryFitScore(a, query) || String(b.publication_date ?? "").localeCompare(String(a.publication_date ?? "")));
	}
	return works;
}

async function searchOpenAlex(params: PaperResearchParams, signal?: AbortSignal, oversample = false): Promise<OpenAlexWork[]> {
	const query = params.query?.trim();
	if (!query) return [];
	const requested = clampInt(params.maxResults, 10, MAX_RESULTS);
	const perPage = oversample || params.minCitations ? Math.min(50, Math.max(requested * 3, requested)) : requested;
	const url = new URL(`${OPENALEX_API}/works`);
	url.searchParams.set("search", query);
	url.searchParams.set("per-page", String(perPage));
	url.searchParams.set("select", OPENALEX_FIELDS);
	// Keep OpenAlex's search relevance as the first-stage ranker, then sort the
	// relevant candidate set client-side. Asking OpenAlex to sort the whole index
	// by citations can surface famous but off-topic papers.
	addOpenAlexFilters(url, params);
	const data = await fetchJson<{ results?: OpenAlexWork[] }>(url, signal);
	let works = data.results ?? [];
	if (params.minCitations) works = works.filter(work => (work.cited_by_count ?? 0) >= params.minCitations!);
	works = sortRelevantWorks(works, params.sortBy, query);
	return works.slice(0, requested);
}

async function fetchOpenAlexWork(id: string, signal?: AbortSignal): Promise<OpenAlexWork | null> {
	const shortId = normalizeOpenAlexId(id);
	if (!shortId) return null;
	const url = new URL(`${OPENALEX_API}/works/${shortId}`);
	url.searchParams.set("select", OPENALEX_FIELDS);
	try {
		return await fetchJson<OpenAlexWork>(url, signal);
	} catch {
		return null;
	}
}

async function fetchOpenAlexByDoi(doi: string, signal?: AbortSignal): Promise<OpenAlexWork | null> {
	const url = new URL(`${OPENALEX_API}/works/https://doi.org/${doi}`);
	url.searchParams.set("select", OPENALEX_FIELDS);
	try {
		return await fetchJson<OpenAlexWork>(url, signal);
	} catch {
		const searchUrl = new URL(`${OPENALEX_API}/works`);
		searchUrl.searchParams.set("filter", `doi:${doi}`);
		searchUrl.searchParams.set("per-page", "1");
		searchUrl.searchParams.set("select", OPENALEX_FIELDS);
		const data = await fetchJson<{ results?: OpenAlexWork[] }>(searchUrl, signal).catch(() => null);
		return data?.results?.[0] ?? null;
	}
}

async function fetchHfPaper(arxivId: string, signal?: AbortSignal): Promise<HfPaper | null> {
	try {
		const url = new URL(`${HF_API}/papers/${arxivId}`);
		return await fetchJson<HfPaper>(url, signal, false);
	} catch {
		return null;
	}
}

async function resolveWork(params: PaperResearchParams, signal?: AbortSignal): Promise<{ work: OpenAlexWork | null; hfPaper?: HfPaper | null; warnings: string[] }> {
	const warnings: string[] = [];
	const openAlexId = candidateOpenAlexId(params);
	if (openAlexId) return { work: await fetchOpenAlexWork(openAlexId, signal), warnings };

	const doi = candidateDoi(params);
	if (doi) return { work: await fetchOpenAlexByDoi(doi, signal), warnings };

	const arxivId = candidateArxivId(params);
	if (arxivId) {
		const hfPaper = await fetchHfPaper(arxivId, signal);
		const query = hfPaper?.title || arxivId;
		const works = await searchOpenAlex({ ...params, query, maxResults: 5, includeAbstracts: true }, signal, true).catch(err => {
			warnings.push(`OpenAlex lookup by arXiv title failed: ${errorMessage(err)}`);
			return [];
		});
		const exact = works.find(work => workMatchesArxivId(work, arxivId));
		if (!exact && works.length > 0) warnings.push(`OpenAlex title search found candidates, but none verified arXiv ID ${arxivId}; not auto-binding to avoid wrong citation metadata.`);
		return { work: exact ?? null, hfPaper, warnings };
	}

	if (params.query?.trim()) {
		const works = await searchOpenAlex({ ...params, maxResults: 1 }, signal, true);
		return { work: works[0] ?? null, warnings };
	}

	return { work: null, warnings };
}

function formatWorkList(works: OpenAlexWork[], title: string, options: { includeAbstracts?: boolean; query?: string } = {}): string {
	if (works.length === 0) return `No papers found${options.query ? ` for "${options.query}"` : ""}.`;
	const lines = [`# ${title}`, `Showing ${works.length} paper(s)`, ""];
	for (let i = 0; i < works.length; i++) {
		const work = works[i];
		const id = openAlexShortId(work);
		const url = workUrl(work);
		const abstract = reconstructAbstract(work.abstract_inverted_index);
		lines.push(`## ${i + 1}. ${workTitle(work)}`);
		const bits = metadataBits(work);
		if (id || bits) lines.push([id ? `**OpenAlex:** ${id}` : null, bits].filter(Boolean).join(" | "));
		if (url) lines.push(url);
		if (work.doi) lines.push(`**DOI:** ${normalizeDoi(work.doi)}`);
		const arxiv = arxivIdFromWork(work);
		if (arxiv) lines.push(`**arXiv:** ${arxiv}`);
		const names = authors(work);
		if (names.length) lines.push(`**Authors:** ${formatAuthors(names)}`);
		const topics = topicNames(work);
		if (topics.length) lines.push(`**Topics:** ${topics.join(", ")}`);
		const pdf = pdfUrl(work);
		if (pdf) lines.push(`**PDF:** ${pdf}`);
		if (options.includeAbstracts && abstract) lines.push(`**Abstract:** ${truncate(abstract, 650)}`);
		lines.push("");
	}
	lines.push("Next: use `paper_research` with `details`, `citation_graph`, `related`, `read_paper` (for arXiv IDs), or `linked_resources`.");
	return lines.join("\n");
}

async function opSearch(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const query = params.query?.trim();
	if (!query) return failure("search", "Missing `query`.", params);
	const works = await searchOpenAlex(params, signal, true);
	return {
		content: [{ type: "text", text: formatWorkList(works, `OpenAlex papers for "${query}"`, { includeAbstracts: params.includeAbstracts ?? true, query }) }],
		details: { operation: "search", provider: "openalex", query, count: works.length, papers: works },
	};
}

async function opMapTopic(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const query = params.query?.trim();
	if (!query) return failure("map_topic", "Missing `query`.", params);
	const anchorCount = Math.min(clampInt(params.maxResults, 3, 8), 8);
	const anchors = await searchOpenAlex({ ...params, maxResults: anchorCount, sortBy: params.sortBy ?? "citationCount" }, signal, true);
	const lines = [`# Research map: "${query}"`, "", "This is a compact evidence graph: anchors → downstream citations / nearby related work. Treat it as a starting map, not a final survey.", ""];
	const graph: Array<Record<string, unknown>> = [];
	for (const anchor of anchors) {
		const id = openAlexShortId(anchor);
		lines.push(`## Anchor: ${workTitle(anchor)}`);
		lines.push([id ? `OpenAlex ${id}` : null, metadataBits(anchor)].filter(Boolean).join(" | "));
		const citations = id ? await searchCitedBy(id, 3, signal).catch(() => []) : [];
		const related = (anchor.related_works ?? []).slice(0, 3);
		const relatedWorks = (await Promise.all(related.map(r => fetchLimit(() => fetchOpenAlexWork(r, signal))))).filter((work): work is OpenAlexWork => !!work);
		if (citations.length) {
			lines.push("**Downstream citing work:**");
			for (const work of citations) lines.push(`- ${workTitle(work)} (${metadataBits(work)})${openAlexShortId(work) ? ` — ${openAlexShortId(work)}` : ""}`);
		}
		if (relatedWorks.length) {
			lines.push("**Related branches:**");
			for (const work of relatedWorks) lines.push(`- ${workTitle(work)} (${metadataBits(work)})${openAlexShortId(work) ? ` — ${openAlexShortId(work)}` : ""}`);
		}
		lines.push("");
		graph.push({ anchor, citations, related: relatedWorks });
	}
	lines.push("Suggested loop: pick an anchor, inspect `citation_graph`, read methodology sections with `read_paper` when an arXiv ID exists, then fetch PDFs/project pages for missing full text.");
	return { content: [{ type: "text", text: lines.join("\n") }], details: { operation: "map_topic", query, count: anchors.length, graph } };
}

async function opTrending(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const limit = clampInt(params.maxResults, 10, MAX_RESULTS);
	const url = new URL(`${HF_API}/daily_papers`);
	url.searchParams.set("limit", String(params.query ? Math.max(limit * 3, 30) : limit));
	if (params.date) url.searchParams.set("date", params.date);
	const data = await fetchJson<unknown[]>(url, signal, false);
	let items = Array.isArray(data) ? data : [];
	if (params.query) {
		const q = params.query.toLowerCase();
		items = items.filter(item => JSON.stringify(item).toLowerCase().includes(q));
	}
	items = items.slice(0, limit);
	const lines = ["# Hugging Face trending papers", `Showing ${items.length} paper(s)`, ""];
	for (let i = 0; i < items.length; i++) {
		const paper = (((items[i] as { paper?: unknown })?.paper ?? items[i]) || {}) as HfPaper;
		lines.push(`## ${i + 1}. ${paper.title || "Untitled"}`);
		if (paper.id) lines.push(`**arXiv:** ${paper.id}`, `https://huggingface.co/papers/${paper.id}`);
		if (paper.ai_keywords?.length) lines.push(`**Keywords:** ${paper.ai_keywords.slice(0, 6).join(", ")}`);
		if (paper.githubRepo) lines.push(`**GitHub:** ${paper.githubRepo}${paper.githubStars ? ` (${paper.githubStars} stars)` : ""}`);
		if (paper.ai_summary || paper.summary) lines.push(`**Summary:** ${truncate(paper.ai_summary || paper.summary, 500)}`);
		lines.push("");
	}
	return { content: [{ type: "text", text: lines.join("\n") }], details: { operation: "trending", provider: "huggingface", count: items.length, papers: items } };
}

async function opDetails(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const { work, hfPaper, warnings } = await resolveWork(params, signal);
	if (!work && hfPaper) {
		const text = [`# ${hfPaper.title || hfPaper.id}`, hfPaper.id ? `https://huggingface.co/papers/${hfPaper.id}` : "", hfPaper.githubRepo ? `**GitHub:** ${hfPaper.githubRepo}` : "", hfPaper.ai_summary || hfPaper.summary || "", "", "OpenAlex metadata was not found for this arXiv ID."].filter(Boolean).join("\n");
		return { content: [{ type: "text", text }], details: { operation: "details", provider: "huggingface", count: 1, paper: hfPaper, warnings } };
	}
	if (!work) return failure("details", "Could not resolve paper. Provide `openAlexId`, `doi`, `arxivId`, `paperId`, or a query.", params);
	const abstract = reconstructAbstract(work.abstract_inverted_index);
	const lines = [formatWorkList([work], `Paper details: ${workTitle(work)}`, { includeAbstracts: true })];
	if (abstract) lines.push("## Abstract", abstract);
	if (work.referenced_works?.length) lines.push(`\nReferences indexed by OpenAlex: ${work.referenced_works.length}`);
	if (work.related_works?.length) lines.push(`Related works indexed by OpenAlex: ${work.related_works.length}`);
	if (hfPaper?.githubRepo) lines.push(`HF paper GitHub: ${hfPaper.githubRepo}${hfPaper.githubStars ? ` (${hfPaper.githubStars} stars)` : ""}`);
	if (warnings.length) lines.push(`\nWarnings: ${warnings.join("; ")}`);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { operation: "details", provider: "openalex", count: 1, paper: work, hfPaper, warnings } };
}

async function searchCitedBy(openAlexId: string, limit: number, signal?: AbortSignal): Promise<OpenAlexWork[]> {
	const url = new URL(`${OPENALEX_API}/works`);
	url.searchParams.set("filter", `cites:${openAlexId}`);
	url.searchParams.set("sort", "cited_by_count:desc");
	url.searchParams.set("per-page", String(limit));
	url.searchParams.set("select", OPENALEX_FIELDS);
	const data = await fetchJson<{ results?: OpenAlexWork[] }>(url, signal);
	return data.results ?? [];
}

function formatCitationWork(work: OpenAlexWork): string {
	const id = openAlexShortId(work);
	return `- **${workTitle(work)}** (${metadataBits(work) || "metadata unavailable"})${id ? ` — ${id}` : ""}${workUrl(work) ? `\n  ${workUrl(work)}` : ""}`;
}

async function opCitationGraph(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const { work, warnings } = await resolveWork(params, signal);
	if (!work) return failure("citation_graph", "Could not resolve paper for citation graph.", params);
	const id = openAlexShortId(work);
	if (!id) return failure("citation_graph", "Resolved paper has no OpenAlex ID.", params);
	const limit = clampInt(params.maxResults, 10, MAX_RESULTS);
	const direction = params.direction ?? "both";
	let references: OpenAlexWork[] = [];
	let citations: OpenAlexWork[] = [];
	if (direction === "references" || direction === "both") {
		const refIds = (work.referenced_works ?? []).slice(0, limit);
		references = (await Promise.all(refIds.map(ref => fetchLimit(() => fetchOpenAlexWork(ref, signal))))).filter((w): w is OpenAlexWork => !!w);
	}
	if (direction === "citations" || direction === "both") {
		citations = await searchCitedBy(id, limit, signal).catch(err => {
			warnings.push(`cited-by lookup failed: ${errorMessage(err)}`);
			return [];
		});
	}
	const lines = [`# Citation graph for ${workTitle(work)}`, `OpenAlex: ${id}`, workUrl(work), ""];
	if (references.length || direction !== "citations") {
		lines.push(`## References (${references.length}${work.referenced_works ? ` of ${work.referenced_works.length}` : ""})`);
		lines.push(...(references.length ? references.map(formatCitationWork) : ["No references found in OpenAlex for this paper."]));
		lines.push("");
	}
	if (citations.length || direction !== "references") {
		lines.push(`## Downstream citations (${citations.length})`);
		lines.push(...(citations.length ? citations.map(formatCitationWork) : ["No citing works found in OpenAlex for this paper."]));
		lines.push("");
	}
	if (warnings.length) lines.push(`Warnings: ${warnings.join("; ")}`);
	lines.push("Tip: use `related` for nearby papers, or `read_paper` on arXiv IDs to inspect methods/results.");
	return { content: [{ type: "text", text: lines.join("\n") }], details: { operation: "citation_graph", provider: "openalex", paper: work, references, citations, referencesCount: references.length, citationsCount: citations.length, warnings } };
}

function tokenize(value: string): string[] {
	const stop = new Set(["about", "after", "also", "and", "are", "can", "for", "from", "how", "into", "not", "that", "the", "this", "with", "your"]);
	return (value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(t => !stop.has(t));
}

function abstractSnippet(work: OpenAlexWork, query: string): string {
	const abstract = reconstructAbstract(work.abstract_inverted_index);
	if (!abstract) return "";
	const tokens = tokenize(query);
	const sentences = abstract.match(/[^.!?]+[.!?]+/g) ?? [abstract];
	let best = sentences[0];
	let bestScore = -1;
	for (const sentence of sentences) {
		const lower = sentence.toLowerCase();
		const score = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
		if (score > bestScore) {
			best = sentence;
			bestScore = score;
		}
	}
	return truncate(best, 600);
}

async function opAbstractSearch(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const query = params.query?.trim();
	if (!query) return failure("abstract_search", "Missing `query`.", params);
	const works = await searchOpenAlex({ ...params, includeAbstracts: true }, signal, true);
	const lines = [`# OpenAlex abstract/title search: "${query}"`, `Showing ${works.length} paper(s)`, ""];
	for (let i = 0; i < works.length; i++) {
		const work = works[i];
		lines.push(`## ${i + 1}. ${workTitle(work)}`);
		lines.push([openAlexShortId(work), metadataBits(work)].filter(Boolean).join(" | "));
		if (workUrl(work)) lines.push(workUrl(work));
		const snippet = abstractSnippet(work, query);
		if (snippet) lines.push(`> ${snippet}`);
		else lines.push("(No OpenAlex abstract available.)");
		lines.push("");
	}
	lines.push("Note: this searches OpenAlex metadata/title/abstracts, not a full-text corpus. Use `read_paper` or `fetch_content` on PDFs for full-text inspection.");
	return { content: [{ type: "text", text: lines.join("\n") }], details: { operation: "abstract_search", provider: "openalex", query, count: works.length, papers: works } };
}

async function opRelated(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const { work, warnings } = await resolveWork(params, signal);
	if (!work) return failure("related", "Could not resolve paper for related works.", params);
	const limit = clampInt(params.maxResults, 10, MAX_RESULTS);
	const relatedIds = (work.related_works ?? []).slice(0, limit);
	let works = (await Promise.all(relatedIds.map(id => fetchLimit(() => fetchOpenAlexWork(id, signal))))).filter((w): w is OpenAlexWork => !!w);
	if (works.length === 0 && workTitle(work)) {
		warnings.push("OpenAlex related_works was empty; falling back to title search.");
		works = await searchOpenAlex({ ...params, query: workTitle(work), maxResults: limit }, signal, true);
	}
	return { content: [{ type: "text", text: formatWorkList(works, `Related works for ${workTitle(work)}`, { includeAbstracts: params.includeAbstracts ?? false }) }], details: { operation: "related", provider: "openalex", count: works.length, sourcePaper: work, papers: works, warnings } };
}

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function elementText(el: Element | null | undefined): string {
	return cleanText(el?.textContent ?? "");
}

function headingLevel(el: Element): number {
	return el.localName?.toLowerCase() === "h3" ? 3 : 2;
}

function isSectionHeading(el: Element): boolean {
	const tag = el.localName?.toLowerCase();
	return (tag === "h2" || tag === "h3") && String(el.getAttribute("class") ?? "").includes("ltx_title");
}

export function parsePaperHtml(html: string): ParsedPaperHtml {
	const { document } = parseHTML(html);
	const title = elementText(document.querySelector("h1.ltx_title"))
		.replace(/^Title:\s*/i, "")
		|| elementText(document.querySelector("title"));
	const abstract = elementText(document.querySelector("div.ltx_abstract p")) || elementText(document.querySelector("div.ltx_abstract"));
	const headings = Array.from(document.querySelectorAll("h2.ltx_title, h3.ltx_title"));
	const sections: ParsedSection[] = [];
	for (const heading of headings) {
		const level = headingLevel(heading);
		const titleText = elementText(heading);
		const parts: string[] = [];
		let sibling = heading.nextElementSibling;
		while (sibling) {
			if (isSectionHeading(sibling) && headingLevel(sibling) <= level) break;
			const text = elementText(sibling);
			if (text) parts.push(text);
			sibling = sibling.nextElementSibling;
		}
		if (parts.length === 0) {
			const parent = heading.parentElement;
			if (parent) {
				for (const child of Array.from(parent.children)) {
					if (child === heading || isSectionHeading(child)) continue;
					const text = elementText(child);
					if (text) parts.push(text);
				}
			}
		}
		const idMatch = titleText.match(/^([A-Z]?\d+(?:\.\d+)*)\s+/);
		sections.push({ id: idMatch?.[1] ?? "", title: titleText, level, text: parts.join("\n\n") });
	}
	return { title, abstract, sections };
}

function findSection(sections: ParsedSection[], query: string): ParsedSection | null {
	const q = query.trim().toLowerCase();
	return sections.find(s => s.id.toLowerCase() === q)
		?? sections.find(s => s.title.toLowerCase() === q)
		?? sections.find(s => s.title.toLowerCase().includes(q))
		?? sections.find(s => s.id.toLowerCase().startsWith(`${q}.`))
		?? null;
}

function formatPaperToc(parsed: ParsedPaperHtml, arxivId: string): string {
	const lines = [`# ${parsed.title || arxivId}`, `https://arxiv.org/abs/${arxivId}`, ""];
	if (parsed.abstract) lines.push("## Abstract", parsed.abstract, "");
	lines.push("## Sections");
	for (const section of parsed.sections) {
		const prefix = section.level === 3 ? "  " : "";
		lines.push(`${prefix}- **${section.title}**${section.text ? `: ${truncate(section.text, 260)}` : ""}`);
	}
	lines.push("", "Call `paper_research({ operation: \"read_paper\", arxivId, section: \"3\" })` to read a specific section.");
	return lines.join("\n");
}

function formatPaperSection(section: ParsedSection, arxivId: string): string {
	const text = section.text.length > MAX_SECTION_CHARS ? `${section.text.slice(0, MAX_SECTION_CHARS)}\n\n[Section truncated at ${MAX_SECTION_CHARS} chars]` : section.text;
	return [`# ${section.title}`, `https://arxiv.org/abs/${arxivId}`, "", text || "(No extractable text in this section.)"].join("\n");
}

async function opReadPaper(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	let arxivId = candidateArxivId(params);
	if (!arxivId) {
		const { work } = await resolveWork(params, signal);
		arxivId = work ? arxivIdFromWork(work) : null;
	}
	if (!arxivId) return failure("read_paper", "Provide an arXiv ID, arXiv URL, or a resolvable paper with arXiv metadata.", params);
	let parsed: ParsedPaperHtml | null = null;
	const errors: string[] = [];
	for (const base of [ARXIV_HTML, AR5IV_HTML]) {
		try {
			const { text } = await fetchText(`${base}/${arxivId}`, signal);
			const candidate = parsePaperHtml(text);
			if (candidate.sections.length > 0) {
				parsed = candidate;
				break;
			}
			errors.push(`${base}: no sections found`);
		} catch (err) {
			errors.push(`${base}: ${errorMessage(err)}`);
		}
	}
	if (!parsed) {
		const hfPaper = await fetchHfPaper(arxivId, signal);
		const text = [`# ${hfPaper?.title || arxivId}`, `https://arxiv.org/abs/${arxivId}`, "", hfPaper?.summary || "HTML extraction was unavailable.", "", `PDF: https://arxiv.org/pdf/${arxivId}`, `HTML extraction errors: ${errors.join("; ")}`].join("\n");
		return { content: [{ type: "text", text }], details: { operation: "read_paper", arxivId, count: 0, errors } };
	}
	if (params.section) {
		const section = findSection(parsed.sections, params.section);
		if (!section) {
			const available = parsed.sections.map(s => `- ${s.title}`).join("\n");
			return failure("read_paper", `Section "${params.section}" not found. Available sections:\n${available}`, params);
		}
		return { content: [{ type: "text", text: formatPaperSection(section, arxivId) }], details: { operation: "read_paper", arxivId, section: section.title, count: 1 } };
	}
	return { content: [{ type: "text", text: formatPaperToc(parsed, arxivId) }], details: { operation: "read_paper", arxivId, sectionCount: parsed.sections.length, title: parsed.title } };
}

function sortToHF(value: string | undefined): string {
	if (value === "likes") return "likes";
	if (value === "trending") return "trendingScore";
	return "downloads";
}

async function fetchHfList(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown[]> {
	const url = new URL(`${HF_API}/${path}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const data = await fetchJson<unknown>(url, signal, false);
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object" && Array.isArray((data as { items?: unknown[] }).items)) return (data as { items: unknown[] }).items;
	return [];
}

function hfItemId(item: unknown): string {
	if (!item || typeof item !== "object") return "?";
	const raw = item as Record<string, unknown>;
	return typeof raw.id === "string" ? raw.id : typeof raw._id === "string" ? raw._id : "?";
}

function countHfResults(items: unknown[]): number {
	return items.filter(item => !(typeof item === "string" && item.startsWith("Error: "))).length;
}

function compactHfList(title: string, items: unknown[], kind: "datasets" | "models" | "collections"): string {
	if (items.length === 0) return `## ${title}\nNone found`;
	const lines = [`## ${title} (${items.length})`];
	for (const item of items) {
		if (typeof item === "string") {
			lines.push(`- ${item}`);
			continue;
		}
		const raw = item as Record<string, unknown>;
		const id = hfItemId(item);
		const slug = typeof raw.slug === "string" ? raw.slug : "";
		const title = typeof raw.title === "string" ? raw.title : "";
		const display = kind === "collections" ? (title && slug ? `${title} (${slug})` : title || slug || id) : id;
		const downloads = typeof raw.downloads === "number" ? ` · ${raw.downloads.toLocaleString()} downloads` : "";
		const likes = typeof raw.likes === "number" ? ` · ${raw.likes} likes` : "";
		const urlId = kind === "collections" ? (slug || id) : id;
		const url = kind === "datasets" ? `https://huggingface.co/datasets/${id}` : kind === "models" ? `https://huggingface.co/${id}` : `https://huggingface.co/collections/${urlId}`;
		lines.push(`- **${display}**${downloads}${likes} — ${url}`);
	}
	return lines.join("\n");
}

async function opLinkedResources(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	let arxivId = candidateArxivId(params);
	if (!arxivId) {
		const { work } = await resolveWork(params, signal);
		arxivId = work ? arxivIdFromWork(work) : null;
	}
	if (!arxivId) return failure("linked_resources", "Provide an arXiv ID or a resolvable paper with arXiv metadata.", params);
	const limit = String(clampInt(params.maxResults, 10, 25));
	const sort = sortToHF(params.resourceSort);
	const [datasets, models, collections] = await Promise.all([
		fetchHfList("datasets", { filter: `arxiv:${arxivId}`, limit, sort, direction: "-1" }, signal).catch(err => [`Error: ${errorMessage(err)}`]),
		fetchHfList("models", { filter: `arxiv:${arxivId}`, limit, sort, direction: "-1" }, signal).catch(err => [`Error: ${errorMessage(err)}`]),
		fetchHfList("collections", { paper: arxivId, limit }, signal).catch(err => [`Error: ${errorMessage(err)}`]),
	]);
	const text = [`# Hugging Face resources linked to ${arxivId}`, `https://huggingface.co/papers/${arxivId}`, "", compactHfList("Datasets", datasets, "datasets"), "", compactHfList("Models", models, "models"), "", compactHfList("Collections", collections, "collections")].join("\n");
	return { content: [{ type: "text", text }], details: { operation: "linked_resources", provider: "huggingface", arxivId, count: countHfResults(datasets) + countHfResults(models) + countHfResults(collections), datasets, models, collections } };
}

function failure(operation: string, message: string, params: PaperResearchParams): ToolReturn {
	return { content: [{ type: "text", text: `Paper research failed: ${message}` }], details: { operation, error: message, params } };
}

export async function executePaperResearch(params: PaperResearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	const operation = params.operation;
	try {
		switch (operation) {
			case "search": return await opSearch(params, signal);
			case "map_topic": return await opMapTopic(params, signal);
			case "trending": return await opTrending(params, signal);
			case "details": return await opDetails(params, signal);
			case "read_paper": return await opReadPaper(params, signal);
			case "citation_graph": return await opCitationGraph(params, signal);
			case "abstract_search": return await opAbstractSearch(params, signal);
			case "related": return await opRelated(params, signal);
			case "linked_resources": return await opLinkedResources(params, signal);
			default: return failure("unknown", `Unknown operation: ${String(operation)}`, params);
		}
	} catch (err) {
		return failure(operation ?? "unknown", errorMessage(err), params);
	}
}

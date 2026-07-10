import { readErrorSnippet, readResponseJson, readResponseText } from "./http-response.js";

export type PaperSearchSource = "auto" | "openalex" | "arxiv";

export interface PaperSearchParams {
	query: string;
	source?: PaperSearchSource;
	maxResults?: number;
	yearFrom?: number;
	openAccessOnly?: boolean;
	includeAbstracts?: boolean;
}

interface PaperRecord {
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	doi?: string;
	url?: string;
	pdfUrl?: string;
	citationCount?: number;
	openAccess?: boolean;
	source: "openalex" | "arxiv";
	abstract?: string;
}

interface OpenAlexWork {
	title?: string;
	display_name?: string;
	publication_year?: number;
	doi?: string;
	id?: string;
	cited_by_count?: number;
	authorships?: Array<{ author?: { display_name?: string } }>;
	primary_location?: {
		landing_page_url?: string;
		pdf_url?: string;
		source?: { display_name?: string };
	};
	open_access?: { is_oa?: boolean; oa_url?: string };
	abstract_inverted_index?: Record<string, number[]>;
}

function clampMaxResults(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 8;
	return Math.min(25, Math.max(1, Math.floor(value)));
}

const REQUEST_TIMEOUT_MS = 20000;
const MAX_PAPER_SEARCH_BYTES = 5 * 1024 * 1024;
const OPENALEX_BASE_SELECT_FIELDS = [
	"id",
	"title",
	"display_name",
	"publication_year",
	"doi",
	"cited_by_count",
	"authorships",
	"primary_location",
	"open_access",
];

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isAbortError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

function shouldRethrowAbort(err: unknown, signal?: AbortSignal): boolean {
	return isAbortError(err) && signal?.aborted === true;
}

function formatSearchError(err: unknown): string {
	if (err instanceof Error && err.name === "TimeoutError") return `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
	return err instanceof Error ? err.message : String(err);
}

function formatSourceError(source: "OpenAlex" | "arXiv", err: unknown): string {
	return `${source}: ${formatSearchError(err)}`;
}

function isArxivRateLimit(error: string): boolean {
	return /arxiv/i.test(error) && (/\b429\b/.test(error) || /rate/i.test(error));
}

function formatFailureMarkdown(params: PaperSearchParams, errors: string[]): string {
	if (params.source === "auto") {
		const primary = errors.find(error => !isArxivRateLimit(error)) ?? errors[0];
		const lines = [`Paper search temporarily unavailable for "${params.query}".`, `- ${primary}`];
		if (errors.some(isArxivRateLimit)) {
			lines.push("", "arXiv fallback was rate-limited; try again later or pass `source: \"openalex\"` to avoid the fallback.");
		}
		return lines.join("\n");
	}
	return `Paper search failed:\n- ${errors.join("\n- ")}`;
}

function reconstructAbstract(index: Record<string, number[]> | undefined): string | undefined {
	if (!index) return undefined;
	const words: Array<{ word: string; pos: number }> = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const pos of positions) {
			if (typeof pos === "number") words.push({ word, pos });
		}
	}
	if (words.length === 0) return undefined;
	return words.sort((a, b) => a.pos - b.pos).map(item => item.word).join(" ");
}

function paperUrl(record: PaperRecord): string {
	if (record.doi) return `https://doi.org/${record.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
	return record.url || record.pdfUrl || "";
}

function formatAuthors(authors: string[]): string {
	if (authors.length <= 3) return authors.join(", ");
	return `${authors.slice(0, 3).join(", ")} et al.`;
}

function formatPaperMarkdown(records: PaperRecord[], params: PaperSearchParams): string {
	if (records.length === 0) return `No papers found for "${params.query}".`;
	const lines = [`## Papers for "${params.query}"`, ""];
	for (let i = 0; i < records.length; i++) {
		const paper = records[i];
		const bits = [paper.year ? String(paper.year) : null, paper.venue, paper.citationCount != null ? `${paper.citationCount} citations` : null, paper.openAccess ? "open access" : null]
			.filter(Boolean)
			.join(" · ");
		const url = paperUrl(paper);
		lines.push(`${i + 1}. **${paper.title || "Untitled"}**${url ? ` — ${url}` : ""}`);
		if (paper.authors.length) lines.push(`   - Authors: ${formatAuthors(paper.authors)}`);
		if (bits) lines.push(`   - ${bits}`);
		if (paper.pdfUrl) lines.push(`   - PDF: ${paper.pdfUrl}`);
		if (params.includeAbstracts && paper.abstract) lines.push(`   - Abstract: ${paper.abstract.slice(0, 800)}${paper.abstract.length > 800 ? "…" : ""}`);
	}
	return lines.join("\n");
}

function openAlexFilters(params: PaperSearchParams): string | null {
	const filters: string[] = [];
	if (typeof params.yearFrom === "number" && Number.isFinite(params.yearFrom)) {
		filters.push(`from_publication_date:${Math.floor(params.yearFrom)}-01-01`);
	}
	if (params.openAccessOnly) filters.push("is_oa:true");
	return filters.length ? filters.join(",") : null;
}

async function searchOpenAlex(params: PaperSearchParams, signal?: AbortSignal): Promise<PaperRecord[]> {
	const maxResults = clampMaxResults(params.maxResults);
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("search", params.query);
	url.searchParams.set("per-page", String(maxResults));
	url.searchParams.set("select", [
		...OPENALEX_BASE_SELECT_FIELDS,
		...(params.includeAbstracts ? ["abstract_inverted_index"] : []),
	].join(","));
	const filters = openAlexFilters(params);
	if (filters) url.searchParams.set("filter", filters);

	const res = await fetch(url, {
		headers: { "User-Agent": "pi-web-access/0.10 (mailto:openalex@example.com)" },
		signal: requestSignal(signal),
	});
	if (!res.ok) throw new Error(`OpenAlex error ${res.status}: ${await readErrorSnippet(res, 200)}`);
	const data = await readResponseJson<{ results?: OpenAlexWork[] }>(res, MAX_PAPER_SEARCH_BYTES);
	return (data.results ?? []).map(work => {
		const doi = typeof work.doi === "string" ? work.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") : undefined;
		const abstract = params.includeAbstracts ? reconstructAbstract(work.abstract_inverted_index) : undefined;
		return {
			title: work.title || work.display_name || "Untitled",
			authors: work.authorships?.map(a => a.author?.display_name).filter((name): name is string => !!name) ?? [],
			year: work.publication_year,
			venue: work.primary_location?.source?.display_name,
			doi,
			url: work.primary_location?.landing_page_url || work.id,
			pdfUrl: work.primary_location?.pdf_url || work.open_access?.oa_url,
			citationCount: work.cited_by_count,
			openAccess: work.open_access?.is_oa,
			source: "openalex" as const,
			...(abstract ? { abstract } : {}),
		};
	});
}

function decodeXml(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function tagText(block: string, tag: string): string | undefined {
	const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
	return match ? decodeXml(match[1]) : undefined;
}

function tagTexts(block: string, tag: string): string[] {
	const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
	return Array.from(block.matchAll(regex)).map(match => decodeXml(match[1])).filter(Boolean);
}

async function searchArxiv(params: PaperSearchParams, signal?: AbortSignal): Promise<PaperRecord[]> {
	const maxResults = clampMaxResults(params.maxResults);
	const url = new URL("https://export.arxiv.org/api/query");
	url.searchParams.set("search_query", `all:${params.query}`);
	url.searchParams.set("start", "0");
	url.searchParams.set("max_results", String(maxResults));
	url.searchParams.set("sortBy", "relevance");
	url.searchParams.set("sortOrder", "descending");

	const res = await fetch(url, { signal: requestSignal(signal) });
	if (!res.ok) throw new Error(`arXiv error ${res.status}: ${await readErrorSnippet(res, 200)}`);
	const xml = await readResponseText(res, MAX_PAPER_SEARCH_BYTES);
	const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)).map(match => match[1]);
	const records: PaperRecord[] = [];
	for (const entry of entries) {
		const published = tagText(entry, "published");
		const year = published ? Number.parseInt(published.slice(0, 4), 10) : undefined;
		if (params.yearFrom && year && year < params.yearFrom) continue;
		const id = tagText(entry, "id");
		const pdfMatch = entry.match(/<link[^>]+title=["']pdf["'][^>]+href=["']([^"']+)["']/i)
			|| entry.match(/<link[^>]+href=["']([^"']+\.pdf)["']/i);
		records.push({
			title: tagText(entry, "title") || "Untitled",
			authors: tagTexts(entry, "name"),
			year: Number.isFinite(year) ? year : undefined,
			venue: "arXiv",
			url: id,
			pdfUrl: pdfMatch ? decodeXml(pdfMatch[1]) : undefined,
			openAccess: true,
			source: "arxiv",
			...(params.includeAbstracts ? { abstract: tagText(entry, "summary") } : {}),
		});
	}
	return records;
}

export async function executePaperSearch(params: PaperSearchParams, signal?: AbortSignal): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}> {
	const query = typeof params.query === "string" ? params.query.trim() : "";
	if (!query) {
		return { content: [{ type: "text", text: "Error: No paper search query provided." }], details: { error: "No query provided" } };
	}
	const source: PaperSearchSource = params.source === "openalex" || params.source === "arxiv" ? params.source : "auto";
	const normalized: PaperSearchParams = { ...params, query, source, maxResults: clampMaxResults(params.maxResults) };

	try {
		let records: PaperRecord[] = [];
		const errors: string[] = [];
		const warnings: string[] = [];
		if (source === "openalex" || source === "auto") {
			try {
				records = await searchOpenAlex(normalized, signal);
			} catch (err) {
				if (shouldRethrowAbort(err, signal)) throw err;
				const message = formatSourceError("OpenAlex", err);
				if (source === "openalex") errors.push(message);
				else warnings.push(message);
			}
		}
		if (source === "arxiv" || (source === "auto" && records.length === 0 && !normalized.openAccessOnly)) {
			try {
				records = await searchArxiv(normalized, signal);
			} catch (err) {
				if (shouldRethrowAbort(err, signal)) throw err;
				const message = formatSourceError("arXiv", err);
				if (source === "arxiv") errors.push(message);
				else warnings.push(message);
			}
		}
		const allErrors = [...errors, ...warnings];
		if (records.length === 0 && allErrors.length > 0) {
			const error = allErrors.join("; ");
			return { content: [{ type: "text", text: formatFailureMarkdown(normalized, allErrors) }], details: { query, source, count: 0, error, errors: allErrors, warnings } };
		}

		const warningText = warnings.length > 0
			? `\n\n_Note: ${warnings.join("; ")}_`
			: "";
		return {
			content: [{ type: "text", text: formatPaperMarkdown(records, normalized) + warningText }],
			details: { query, source, count: records.length, papers: records, errors: allErrors, warnings },
		};
	} catch (err) {
		if (shouldRethrowAbort(err, signal)) throw err;
		const message = formatSearchError(err);
		return { content: [{ type: "text", text: `Paper search failed: ${message}` }], details: { query, source, error: message } };
	}
}

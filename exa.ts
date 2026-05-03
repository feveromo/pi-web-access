import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { ExtractedContent } from "./extract.js";
import type { SearchOptions, SearchResponse } from "./search-types.js";

const EXA_ANSWER_URL = "https://api.exa.ai/answer";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const USAGE_PATH = join(homedir(), ".pi", "exa-usage.json");

const MONTHLY_LIMIT = 1000;
const WARNING_THRESHOLD = 800;

interface WebSearchConfig {
	exaApiKey?: unknown;
}

interface ExaUsage {
	month: string;
	count: number;
}

interface ExaAnswerResponse {
	answer?: string;
	citations?: Array<{ url?: string; title?: string; text?: string; summary?: string; publishedDate?: string }>;
}

interface ExaSearchResponse {
	results?: Array<{
		title?: string;
		url?: string;
		publishedDate?: string;
		author?: string;
		text?: string;
		summary?: string;
		highlights?: unknown;
		highlightScores?: number[];
	}>;
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

export type ExaSearchResult = SearchResponse | { exhausted: true } | null;

export interface ExaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

type McpParsedResult = { title: string; url: string; content: string };

let cachedConfig: WebSearchConfig | null = null;
let warnedMonth: string | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function getApiKey(): string | null {
	return normalizeApiKey(process.env.EXA_API_KEY) ?? normalizeApiKey(loadConfig().exaApiKey);
}

function getCurrentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

function normalizeUsage(raw: unknown): ExaUsage {
	const month = getCurrentMonth();
	if (!raw || typeof raw !== "object") return { month, count: 0 };
	const data = raw as { month?: unknown; count?: unknown };
	const parsedMonth = typeof data.month === "string" ? data.month : month;
	const parsedCount = typeof data.count === "number" && Number.isFinite(data.count) ? data.count : 0;
	if (parsedMonth !== month) return { month, count: 0 };
	return { month: parsedMonth, count: Math.max(0, Math.floor(parsedCount)) };
}

function readUsage(): ExaUsage {
	if (!existsSync(USAGE_PATH)) return { month: getCurrentMonth(), count: 0 };
	const raw = readFileSync(USAGE_PATH, "utf-8");
	try {
		return normalizeUsage(JSON.parse(raw));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${USAGE_PATH}: ${message}`);
	}
}

function writeUsage(usage: ExaUsage): void {
	const dir = join(homedir(), ".pi");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2) + "\n");
}

function reserveRequestBudget(): { exhausted: true } | null {
	const usage = readUsage();

	if (usage.count >= MONTHLY_LIMIT) {
		return { exhausted: true };
	}

	const nextCount = usage.count + 1;
	if (nextCount >= WARNING_THRESHOLD && warnedMonth !== usage.month) {
		warnedMonth = usage.month;
		console.error(`Exa usage warning: ${nextCount}/${MONTHLY_LIMIT} monthly requests used.`);
	}

	writeUsage({ month: usage.month, count: nextCount });
	return null;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(60000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToStartDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	};
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
	if (!domainFilter?.length) return {};
	const includeDomains = domainFilter
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domainFilter
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(includeDomains.length ? { includeDomains } : {}),
		...(excludeDomains.length ? { excludeDomains } : {}),
	};
}

function normalizeHighlights(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

type ExaResultItem = NonNullable<ExaSearchResponse["results"]>[number];
type ExaCitationItem = NonNullable<ExaAnswerResponse["citations"]>[number];

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const normalized = Math.floor(value);
	if (normalized < 1) return fallback;
	return Math.min(normalized, max);
}

function normalizeResearchDepth(value: unknown): "quick" | "standard" | "deep" {
	return value === "standard" || value === "deep" ? value : "quick";
}

function normalizeSearchType(options: ExaSearchOptions): "fast" | "auto" | "deep-lite" | "deep" | "deep-reasoning" {
	if (options.searchType === "fast" || options.searchType === "auto" || options.searchType === "deep-lite" || options.searchType === "deep" || options.searchType === "deep-reasoning") {
		return options.searchType;
	}
	const depth = normalizeResearchDepth(options.researchDepth);
	if (depth === "deep") return "deep-lite";
	if (depth === "standard") return "auto";
	return "fast";
}

function normalizeContentMode(options: ExaSearchOptions): "none" | "highlights" | "summary" | "text" {
	// includeContent is a stronger request than contentMode: callers expect stored full text
	// before the tool returns. Force Exa/MCP to return bounded text when possible.
	if (options.includeContent === true) return "text";
	if (options.contentMode === "none" || options.contentMode === "highlights" || options.contentMode === "summary" || options.contentMode === "text") {
		return options.contentMode;
	}
	return "highlights";
}

function normalizeLivecrawl(value: unknown): "never" | "fallback" | "always" | undefined {
	return value === "never" || value === "fallback" || value === "always" ? value : undefined;
}

function buildSearchContents(options: ExaSearchOptions, safeFallback = false): Record<string, unknown> | undefined {
	const mode = safeFallback && normalizeContentMode(options) === "summary" ? "highlights" : normalizeContentMode(options);
	if (mode === "none") return undefined;
	const maxCharacters = clampPositiveInt(options.maxCharacters, options.includeContent || mode === "text" ? 12000 : 1000, 50000);
	if (mode === "text") {
		return {
			highlights: true,
			text: { maxCharacters },
		};
	}
	if (mode === "summary") {
		return {
			highlights: true,
			summary: true,
		};
	}
	return { highlights: true };
}

function buildSearchBody(query: string, options: ExaSearchOptions, safeFallback = false): Record<string, unknown> {
	const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : null;
	const domainFilters = mapDomainFilter(options.domainFilter);
	const contents = buildSearchContents(options, safeFallback);
	const livecrawl = normalizeLivecrawl(options.livecrawl);
	return {
		query,
		type: safeFallback ? "auto" : normalizeSearchType(options),
		numResults: Math.min(options.numResults ?? 5, 20),
		...domainFilters,
		...(startDate ? { startPublishedDate: startDate } : {}),
		...(livecrawl ? { livecrawl } : {}),
		...(contents ? { contents } : {}),
	};
}

function normalizeResultUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		for (const key of Array.from(parsed.searchParams.keys())) {
			if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) parsed.searchParams.delete(key);
		}
		let normalized = parsed.toString();
		if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
		return normalized;
	} catch {
		return url.trim();
	}
}

function dedupeResults<T extends { url?: string }>(results: T[] | undefined): T[] {
	if (!Array.isArray(results)) return [];
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const item of results) {
		if (!item?.url) continue;
		const key = normalizeResultUrl(item.url);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}

function cleanSnippet(value: string, maxLength = 1000): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}…` : normalized;
}

function resultSnippet(item: ExaResultItem | ExaCitationItem): string {
	if (typeof item.summary === "string" && item.summary.trim()) return cleanSnippet(item.summary);
	const highlights = "highlights" in item ? normalizeHighlights(item.highlights) : [];
	if (highlights.length > 0) return cleanSnippet(highlights.join(" "));
	if (typeof item.text === "string" && item.text.trim()) return cleanSnippet(item.text);
	return "";
}

function buildAnswerFromSearchResults(results: ExaSearchResponse["results"]): string {
	const deduped = dedupeResults(results);
	if (!deduped.length) return "";
	const parts: string[] = [];
	for (let i = 0; i < deduped.length; i++) {
		const item = deduped[i];
		if (!item.url) continue;
		const snippet = resultSnippet(item);
		if (!snippet) continue;
		const sourceTitle = item.title || `Source ${i + 1}`;
		parts.push(`${snippet}\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapResults(results: ExaSearchResponse["results"] | ExaAnswerResponse["citations"]): SearchResponse["results"] {
	const deduped = dedupeResults(results);
	return deduped.map((item, index) => ({
		title: item.title || `Source ${index + 1}`,
		url: item.url!,
		snippet: resultSnippet(item),
	}));
}

function mapInlineContent(results: ExaSearchResponse["results"], options: ExaSearchOptions): ExtractedContent[] {
	if (!options.includeContent && normalizeContentMode(options) !== "text") return [];
	const maxCharacters = clampPositiveInt(options.maxCharacters, 12000, 50000);
	return dedupeResults(results)
		.filter((r): r is ExaResultItem & { url: string; text: string } =>
			!!r.url && typeof r.text === "string" && r.text.trim().length > 0)
		.map(r => ({
			url: r.url,
			title: r.title || "",
			content: r.text.length > maxCharacters ? `${r.text.slice(0, maxCharacters).trimEnd()}\n\n[Truncated by Exa maxCharacters]` : r.text,
			error: null,
		}));
}

export async function callExaMcp(
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const body = await response.text();
	const dataLines = body.split("\n").filter(line => line.startsWith("data:"));

	let parsed: ExaMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
		}
	}

	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
			}
		} catch {
		}
	}

	if (!parsed) {
		throw new Error("Exa MCP returned an empty response");
	}

	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		const message = parsed.error.message || "Unknown error";
		throw new Error(`Exa MCP error${code}: ${message}`);
	}

	if (parsed.result?.isError) {
		const message = parsed.result.content
			?.find(item => item.type === "text" && typeof item.text === "string")
			?.text?.trim();
		throw new Error(message || "Exa MCP returned an error");
	}

	const text = parsed.result?.content
		?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
		?.text;

	if (!text) {
		throw new Error("Exa MCP returned empty content");
	}

	return text;
}

function parseMcpResults(text: string): McpParsedResult[] | null {
	const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim().length > 0);
	const parsed = blocks.map(block => {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) {
			content = block.slice(textStart + 7).trim();
		} else {
			const hlMatch = block.match(/\nHighlights:\s*\n/);
			if (hlMatch?.index != null) {
				content = block.slice(hlMatch.index + hlMatch[0].length).trim();
			}
		}
		content = content.replace(/\n---\s*$/, "").trim();
		return { title, url, content };
	}).filter(result => result.url.length > 0);
	return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
	if (results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 500);
		if (!snippet) continue;
		const sourceTitle = result.title || `Source ${i + 1}`;
		parts.push(`${snippet}\nSource: ${sourceTitle} (${result.url})`);
	}
	return parts.join("\n\n");
}

function mapMcpInlineContent(results: McpParsedResult[]): ExtractedContent[] {
	return results
		.filter(result => result.content.length > 0)
		.map(result => ({
			url: result.url,
			title: result.title,
			content: result.content,
			error: null,
		}));
}

function buildMcpQuery(query: string, options: ExaSearchOptions): string {
	const parts = [query];
	if (options.domainFilter?.length) {
		for (const d of options.domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (options.recencyFilter) {
		const now = new Date();
		switch (options.recencyFilter) {
			case "day": parts.push("past 24 hours"); break;
			case "week": parts.push("past week"); break;
			case "month": parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`); break;
			case "year": parts.push(String(now.getFullYear())); break;
		}
	}
	return parts.join(" ");
}

async function searchWithExaMcp(query: string, options: ExaSearchOptions = {}): Promise<SearchResponse | null> {
	const enrichedQuery = buildMcpQuery(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query: enrichedQuery });

	try {
		const contentMode = normalizeContentMode(options);
		const text = await callExaMcp(
			"web_search_exa",
			{
				query: enrichedQuery,
				numResults: Math.min(options.numResults ?? 5, 20),
				livecrawl: normalizeLivecrawl(options.livecrawl) ?? "fallback",
				type: normalizeSearchType(options),
				contextMaxCharacters: contentMode === "text" || options.includeContent ? clampPositiveInt(options.maxCharacters, 12000, 50000) : 3000,
			},
			options.signal,
		);
		const parsedResults = dedupeResults(parseMcpResults(text) ?? undefined);
		activityMonitor.logComplete(activityId, 200);

		if (parsedResults.length === 0) return null;

		const response: SearchResponse = {
			answer: buildAnswerFromMcpResults(parsedResults),
			results: parsedResults.map((result, index) => ({
				title: result.title || `Source ${index + 1}`,
				url: result.url,
				snippet: cleanSnippet(result.content),
			})),
			...(options.returnMetadata ? {
				metadata: {
					providerApi: "exa-mcp",
					fetchedAt: new Date().toISOString(),
					directApi: false,
					recencyFilter: options.recencyFilter,
					domainFilter: options.domainFilter,
					researchDepth: options.researchDepth,
					searchType: normalizeSearchType(options),
					contentMode,
					enrichedQuery,
					sources: parsedResults.map(r => ({ title: r.title, url: r.url })),
				},
			} : {}),
		};

		if (options.includeContent || contentMode === "text") {
			const inlineContent = mapMcpInlineContent(parsedResults);
			if (inlineContent.length > 0) response.inlineContent = inlineContent;
		}

		return response;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

export function isExaAvailable(): boolean {
	if (getApiKey()) {
		const usage = readUsage();
		return usage.count < MONTHLY_LIMIT;
	}
	return true;
}

export function hasExaApiKey(): boolean {
	return !!getApiKey();
}

export async function searchWithExa(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResult> {
	const apiKey = getApiKey();
	if (!apiKey) {
		return searchWithExaMcp(query, options);
	}

	const budget = reserveRequestBudget();
	if (budget) return budget;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		if (options.synthesize === true) {
			const response = await fetch(EXA_ANSWER_URL, {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query, text: true }),
				signal: requestSignal(options.signal),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
			}

			const data = await response.json() as ExaAnswerResponse;
			activityMonitor.logComplete(activityId, response.status);
			return {
				answer: data.answer || "",
				results: mapResults(data.citations),
				...(options.returnMetadata ? {
					metadata: {
						providerApi: "exa-answer",
						fetchedAt: new Date().toISOString(),
						directApi: true,
						synthesize: true,
						recencyFilter: options.recencyFilter,
						domainFilter: options.domainFilter,
						sources: dedupeResults(data.citations).map(c => ({ url: c.url, title: c.title, publishedDate: c.publishedDate, textLength: c.text?.length })),
					},
				} : {}),
			};
		}

		let response = await fetch(EXA_SEARCH_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(buildSearchBody(query, options)),
			signal: requestSignal(options.signal),
		});
		let retriedSafeFallback = false;

		if (!response.ok && response.status >= 400 && response.status < 500) {
			response = await fetch(EXA_SEARCH_URL, {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(buildSearchBody(query, { ...options, searchType: "auto", contentMode: normalizeContentMode(options) === "text" ? "text" : "highlights" }, true)),
				signal: requestSignal(options.signal),
			});
			retriedSafeFallback = true;
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as ExaSearchResponse;
		activityMonitor.logComplete(activityId, response.status);
		const dedupedResults = dedupeResults(data.results);
		const contentMode = normalizeContentMode(options);

		const mapped: SearchResponse = {
			answer: buildAnswerFromSearchResults(dedupedResults),
			results: mapResults(dedupedResults),
			...(options.returnMetadata ? {
				metadata: {
					providerApi: "exa-search",
					fetchedAt: new Date().toISOString(),
					directApi: true,
					retriedSafeFallback,
					researchDepth: normalizeResearchDepth(options.researchDepth),
					searchType: retriedSafeFallback ? "auto" : normalizeSearchType(options),
					contentMode,
					maxCharacters: options.maxCharacters,
					livecrawl: normalizeLivecrawl(options.livecrawl),
					recencyFilter: options.recencyFilter,
					domainFilter: options.domainFilter,
					sources: dedupedResults.map(r => ({
						url: r.url,
						title: r.title,
						publishedDate: r.publishedDate,
						summary: r.summary,
						highlights: normalizeHighlights(r.highlights),
						highlightScores: r.highlightScores,
						textLength: r.text?.length,
					})) ?? [],
				},
			} : {}),
		};
		const inlineContent = mapInlineContent(dedupedResults, options);
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
		return mapped;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

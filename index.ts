import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import pLimit from "p-limit";
import { fetchAllContent, type ExtractedContent, type ExtractOptions } from "./extract.js";
import { clearCloneCache } from "./github-extract.js";
import { search, type SearchProvider } from "./search.js";
import { executePaperSearch } from "./paper-search.js";
import { executePaperResearch } from "./paper-research.js";
import { executeDocsSearch, executeOpenApiSearch } from "./docs-research.js";
import { executeGitHubExamples } from "./github-examples.js";
import type { SearchResult } from "./search-types.js";
import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	getResult,
	prepareStoredDataForSession,
	restoreFromSession,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.js";
import { activityMonitor, type ActivityEntry } from "./activity.js";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB_SEARCH_CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const MAX_INLINE_CONTENT = 30000;
const DEFAULT_SEARCH_CONTENT_MAX_CHARS = 12000;
const SEARCH_QUERY_CONCURRENCY = 3;
const DEFAULT_SHORTCUTS = { activity: "ctrl+shift+w" };

interface WebSearchConfig {
	provider?: string;
	shortcuts?: { activity?: string };
}

interface ContentFetchStats {
	totalUrls: number;
	providerInlineUrls: number;
	fallbackFetchedUrls: number;
	successfulUrls: number;
	failedUrls: number;
	durationMs: number;
}

interface SearchReturnOptions {
	queryList: string[];
	results: QueryResultData[];
	urls: string[];
	includeContent: boolean;
	inlineContent?: ExtractedContent[];
	contentFetch?: ContentFetchStats;
	contentFetchOptions?: ExtractOptions;
}

let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;

function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	const raw = readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8");
	try {
		return JSON.parse(raw) as WebSearchConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
}

function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-web-access] ${message}`);
		return {};
	}
}

function normalizeProviderInput(value: unknown): SearchProvider | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return "auto";
	const normalized = value.trim().toLowerCase();
	return normalized === "auto" || normalized === "exa" ? normalized : "auto";
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

function extractDomain(url: string): string {
	try { return new URL(url).hostname; }
	catch { return url; }
}

function buildFetchDetail(result: ExtractedContent, index: number, includeMetadata = false): Record<string, unknown> {
	return {
		index,
		url: result.url,
		status: result.error ? "error" : "success",
		error: result.error,
		title: result.title,
		contentLength: result.content.length,
		method: result.method,
		fetchedAt: result.fetchedAt,
		fetchedUrl: result.fetchedUrl,
		contentType: result.contentType,
		httpStatus: result.httpStatus,
		fallbackPath: result.fallbackPath,
		truncated: result.truncated,
		originalContentLength: result.originalContentLength,
		retrievalStatus: result.retrievalStatus,
		contentRef: includeMetadata ? result.contentRef : undefined,
		metadata: includeMetadata ? result.metadata : undefined,
	};
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

function normalizeHeadingText(value: string): string {
	return value
		.replace(/^#{1,6}\s+/, "")
		.replace(/[\*_`]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function firstNonEmptyLine(lines: string[], start = 0): { index: number; text: string } | null {
	for (let i = start; i < lines.length; i++) {
		const text = lines[i].trim();
		if (text) return { index: i, text };
	}
	return null;
}

function stripDuplicateLeadingTitle(content: string, title: string): string {
	const expected = normalizeHeadingText(title);
	if (!expected || !content.trim()) return content;

	const lines = content.split(/\r?\n/);
	const first = firstNonEmptyLine(lines);
	if (!first || normalizeHeadingText(first.text) !== expected) return content;

	const second = firstNonEmptyLine(lines, first.index + 1);
	const firstIsHeading = /^#{1,6}\s+/.test(first.text);
	const secondIsSameHeading = !!second && /^#{1,6}\s+/.test(second.text) && normalizeHeadingText(second.text) === expected;

	if (!firstIsHeading && secondIsSameHeading) {
		return lines.slice(second.index).join("\n").trimStart();
	}

	return content;
}

function contentStartsWithTitle(content: string, title: string): boolean {
	const first = firstNonEmptyLine(content.split(/\r?\n/));
	return !!first && normalizeHeadingText(first.text) === normalizeHeadingText(title);
}

function formatFetchedContentForDisplay(item: ExtractedContent): string {
	const title = item.title?.trim() || "Content";
	const content = stripDuplicateLeadingTitle(item.content, title);
	if (!title || contentStartsWithTitle(content, title)) return content;
	return `# ${title}\n\n${content}`;
}

function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

function dedupeExtractedContent(contents: ExtractedContent[]): ExtractedContent[] {
	const byUrl = new Map<string, ExtractedContent>();
	for (const item of contents) {
		const previous = byUrl.get(item.url);
		if (!previous) {
			byUrl.set(item.url, item);
			continue;
		}
		if (previous.error && !item.error) {
			byUrl.set(item.url, item);
			continue;
		}
		if ((previous.error === null) === (item.error === null) && item.content.length > previous.content.length) {
			byUrl.set(item.url, item);
		}
	}
	return [...byUrl.values()];
}

async function ensureRequestedContent(
	opts: SearchReturnOptions,
	signal?: AbortSignal,
	onUpdate?: (update: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }) => void,
): Promise<SearchReturnOptions> {
	if (!opts.includeContent || opts.urls.length === 0) return opts;

	const startedAt = Date.now();
	const providerInline = dedupeExtractedContent(opts.inlineContent ?? []);
	const covered = new Set(providerInline.map(c => c.url));
	const missingUrls = opts.urls.filter(url => !covered.has(url));
	let fallbackFetched: ExtractedContent[] = [];

	if (missingUrls.length > 0) {
		onUpdate?.({
			content: [{ type: "text", text: `Fetching full content for ${missingUrls.length}/${opts.urls.length} source(s)...` }],
			details: { phase: "fetching-content", progress: 0.95, urlCount: missingUrls.length },
		});
		fallbackFetched = await fetchAllContent(missingUrls, signal, opts.contentFetchOptions);
	}

	const inlineContent = dedupeExtractedContent([...providerInline, ...fallbackFetched]);
	return {
		...opts,
		inlineContent: inlineContent.length > 0 ? inlineContent : undefined,
		contentFetch: {
			totalUrls: opts.urls.length,
			providerInlineUrls: providerInline.length,
			fallbackFetchedUrls: fallbackFetched.length,
			successfulUrls: inlineContent.filter(c => !c.error).length,
			failedUrls: inlineContent.filter(c => c.error).length,
			durationMs: Date.now() - startedAt,
		},
	};
}

function updateWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines: string[] = [];

	lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));

	if (entries.length === 0) {
		lines.push(theme.fg("muted", "  No activity yet"));
	} else {
		for (const e of entries) {
			lines.push("  " + formatEntryLine(e, theme));
		}
	}

	lines.push(theme.fg("accent", "─".repeat(60)));

	const rateInfo = activityMonitor.getRateLimitInfo();
	const resetMs = rateInfo.oldestTimestamp ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now()) : 0;
	const resetSec = Math.ceil(resetMs / 1000);
	lines.push(
		theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) +
			(resetMs > 0 ? theme.fg("dim", ` (resets in ${resetSec}s)`) : ""),
	);

	ctx.ui.setWidget("web-activity", new Text(lines.join("\n"), 0, 0));
}

function formatEntryLine(
	entry: ActivityEntry,
	theme: { fg: (color: string, text: string) => string },
): string {
	const typeStr = entry.type === "api" ? "API" : "GET";
	const target =
		entry.type === "api"
			? `"${truncateToWidth(entry.query || "", 28, "")}"`
			: truncateToWidth(entry.url?.replace(/^https?:\/\//, "") || "", 30, "");

	const duration = entry.endTime
		? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
		: `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

	let statusStr: string;
	let indicator: string;
	if (entry.error) {
		statusStr = "err";
		indicator = theme.fg("error", "✗");
	} else if (entry.status === null) {
		statusStr = "...";
		indicator = theme.fg("warning", "⋯");
	} else if (entry.status === 0) {
		statusStr = "abort";
		indicator = theme.fg("muted", "○");
	} else {
		statusStr = String(entry.status);
		indicator = entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	}

	return `${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}

function handleSessionChange(ctx: ExtensionContext): void {
	clearCloneCache();
	restoreFromSession(ctx);
	widgetUnsubscribe?.();
	widgetUnsubscribe = null;
	activityMonitor.clear();
	if (widgetVisible) {
		widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
		updateWidget(ctx);
	}
}

export default function (pi: ExtensionAPI) {
	const initConfig = loadConfigForExtensionInit();
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", prepareStoredDataForSession(id, data));
		return id;
	}

	function storeAndPublishFetch(results: ExtractedContent[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "fetch", timestamp: Date.now(), urls: results,
		};
		const sessionData = prepareStoredDataForSession(id, data);
		if (sessionData.urls) {
			for (let i = 0; i < sessionData.urls.length; i++) {
				const sessionItem = sessionData.urls[i];
				if (sessionItem?.contentRef && results[i]) {
					results[i].contentRef = sessionItem.contentRef;
					results[i].metadata = sessionItem.metadata;
				}
			}
		}
		storeResult(id, sessionData);
		pi.appendEntry("web-search-results", sessionData);
		return id;
	}

	function buildSearchReturn(opts: SearchReturnOptions) {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);
		const allDomains = new Set<string>();
		const perQueryMetrics = opts.results.map(r => {
			const domains = new Set(r.results.map(source => extractDomain(source.url)));
			for (const domain of domains) allDomains.add(domain);
			return {
				query: r.query,
				provider: r.provider ?? null,
				resultCount: r.results.length,
				uniqueDomains: domains.size,
				answerChars: r.answer.length,
				snippetChars: r.results.reduce((sum, source) => sum + (source.snippet?.length ?? 0), 0),
				error: r.error,
			};
		});

		let output = "";
		for (const { query, answer, results, error } of opts.results) {
			if (opts.queryList.length > 1) output += `## Query: "${query}"\n\n`;
			if (error) output += `Error: ${error}\n\n`;
			else if (results.length === 0) output += "No results found.\n\n";
			else output += formatSearchSummary(results, answer) + "\n\n";
		}

		let fetchId: string | null = null;
		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		if (hasInlineReady && opts.inlineContent) {
			fetchId = storeAndPublishFetch(opts.inlineContent);
			output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
		} else if (opts.includeContent && opts.urls.length > 0) {
			output += "---\nFull content was requested, but no source content was available.";
		}

		const searchId = storeAndPublishSearch(opts.results);
		const queryMetadata = opts.results.some(r => r.metadata)
			? opts.results.map(r => ({ query: r.query, provider: r.provider, metadata: r.metadata }))
			: undefined;

		return {
			content: [{ type: "text", text: output.trim() }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				searchId,
				metrics: {
					uniqueDomains: allDomains.size,
					perQuery: perQueryMetrics,
				},
				...(opts.contentFetch ? { contentFetch: opts.contentFetch } : {}),
				...(queryMetadata ? { metadata: queryMetadata } : {}),
			},
		};
	}

	pi.registerShortcut(activityKey, {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			if (widgetVisible) {
				widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
			} else {
				widgetUnsubscribe?.();
				widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", null);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		clearCloneCache();
		clearResults();
		widgetUnsubscribe?.();
		widgetUnsubscribe = null;
		activityMonitor.clear();
		widgetVisible = false;
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Lean Exa-powered web research with source snippets/citations. Use researchDepth: "deep" or contentMode: "text" only when needed; use synthesize: true for Exa answer synthesis.`,
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own source-backed result set. Prefer varied angles, scope, and phrasing." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch and store bounded full text before returning" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			researchDepth: Type.Optional(StringEnum(["quick", "standard", "deep"], { description: "Exa retrieval depth: quick=fast default, standard=auto, deep=deeper retrieval" })),
			searchType: Type.Optional(StringEnum(["fast", "auto", "deep-lite", "deep", "deep-reasoning"], { description: "Explicit Exa search type override" })),
			contentMode: Type.Optional(StringEnum(["none", "highlights", "summary", "text"], { description: "Exa content returned with results (default highlights; text is larger)" })),
			maxCharacters: Type.Optional(Type.Number({ description: "Maximum source text characters per result for Exa text/includeContent fallback" })),
			livecrawl: Type.Optional(StringEnum(["never", "fallback", "always"], { description: "Exa livecrawl mode for fresher pages" })),
			synthesize: Type.Optional(Type.Boolean({ description: "Use Exa answer synthesis instead of source-passage search" })),
			returnMetadata: Type.Optional(Type.Boolean({ description: "Include provider/debug metadata in details and stored results" })),
			provider: Type.Optional(
				StringEnum(["auto", "exa"], { description: "Search provider (default: auto)" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? [params.query] : []);
			const queryList = normalizeQueryList(rawQueryList);

			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = normalizeProviderInput(params.provider ?? loadConfig().provider);
			const queryLimit = pLimit(SEARCH_QUERY_CONCURRENCY);
			let completedQueries = 0;

			const queryOutcomes = await Promise.all(queryList.map((query, index) => queryLimit(async () => {
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${index + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: Math.min(0.9, completedQueries / queryList.length * 0.9), currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider, metadata } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						researchDepth: params.researchDepth,
						searchType: params.searchType,
						contentMode: params.contentMode,
						maxCharacters: params.maxCharacters,
						livecrawl: params.livecrawl,
						synthesize: params.synthesize,
						returnMetadata: params.returnMetadata,
						signal,
					});

					return {
						data: { query, answer, results, error: null, provider, metadata } satisfies QueryResultData,
						urls: results.map(r => r.url),
						inlineContent: inlineContent ?? [],
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const requestedProvider = typeof resolvedProvider === "string" && resolvedProvider !== "auto"
						? resolvedProvider
						: undefined;
					return {
						data: { query, answer: "", results: [], error: message, provider: requestedProvider } satisfies QueryResultData,
						urls: [],
						inlineContent: [],
					};
				} finally {
					completedQueries++;
					onUpdate?.({
						content: [{ type: "text", text: `Completed ${completedQueries}/${queryList.length} search(es)...` }],
						details: { phase: "search", progress: Math.min(0.9, completedQueries / queryList.length * 0.9) },
					});
				}
			})));

			const searchResults = queryOutcomes.map(outcome => outcome.data);
			for (const outcome of queryOutcomes) {
				for (const url of outcome.urls) {
					if (!allUrls.includes(url)) allUrls.push(url);
				}
				allInlineContent.push(...outcome.inlineContent);
			}

			const searchContentMaxChars = typeof params.maxCharacters === "number" && Number.isFinite(params.maxCharacters) && params.maxCharacters > 0
				? Math.floor(params.maxCharacters)
				: DEFAULT_SEARCH_CONTENT_MAX_CHARS;
			const returnOptions = await ensureRequestedContent({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
				contentFetchOptions: { maxChars: searchContentMaxChars, queries: queryList },
			}, signal, onUpdate as Parameters<typeof ensureRequestedContent>[2]);

			return buildSearchReturn(returnOptions);
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? [input.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				phase?: string;
				progress?: number;
				currentQuery?: string;
				metrics?: { uniqueDomains?: number };
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				const query = details?.currentQuery || details?.phase || "searching";
				const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
				return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			let statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.metrics?.uniqueDomains) {
				statusLine += theme.fg("muted", ` · ${details.metrics.uniqueDomains} domains`);
			}
			if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			if (!expanded) {
				const firstContentLine = textContent.split("\n").find(l => {
					const t = l.trim();
					return t && !t.startsWith("#") && !t.startsWith("---");
				});
				const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
				if (!fallbackLine) return new Text(statusLine, 0, 0);
				const preview = fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine;
				const box = new Box(1, 0, (t) => theme.bg("toolSuccessBg", t));
				box.addChild(new Text(statusLine, 0, 0));
				box.addChild(new Text(theme.fg("dim", preview), 0, 0));
				return box;
			}

			const preview = textContent.length > 1000 ? textContent.slice(0, 1000) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "paper_search",
		label: "Paper Search",
		description: "Search scholarly papers with structured metadata via OpenAlex, with arXiv support/fallback. Use for scientific papers, academic literature, citations, and open-access PDFs before broad web search.",
		promptSnippet:
			"Use for scholarly/scientific literature searches; returns titles, authors, years, citations, DOI/PDF links, and optional abstracts.",
		parameters: Type.Object({
			query: Type.String({ description: "Paper/literature search query" }),
			source: Type.Optional(StringEnum(["auto", "openalex", "arxiv"], { description: "Scholarly source (default auto)" })),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Maximum papers to return (default 8, max 25)" })),
			yearFrom: Type.Optional(Type.Integer({ description: "Only include papers from this year onward" })),
			openAccessOnly: Type.Optional(Type.Boolean({ description: "Limit OpenAlex results to open-access papers" })),
			includeAbstracts: Type.Optional(Type.Boolean({ description: "Include abstracts when available" })),
		}),

		async execute(_toolCallId, params, signal) {
			return executePaperSearch(params, signal);
		},

		renderCall(args, theme) {
			const { query } = args as { query?: string };
			const display = !query ? "(no query)" : query.length > 70 ? query.slice(0, 67) + "..." : query;
			return new Text(theme.fg("toolTitle", theme.bold("paper_search ")) + theme.fg("accent", display), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { count?: number; error?: string; errors?: string[] };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const summary = theme.fg("success", `${details?.count ?? 0} papers returned`);
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 700 ? textContent.slice(0, 700) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "paper_research",
		label: "Paper Research",
		description: "No-key deep scholarly research via OpenAlex, arXiv/ar5iv HTML, and Hugging Face paper resources. Use after paper_search when you need citation graphs, methodology sections, abstract claim search, related works, topic maps, or linked HF datasets/models.",
		promptSnippet:
			"Use for deep no-key scholarly research: OpenAlex citation graphs/topic maps, arXiv paper sections, abstract search, related works, and HF-linked resources.",
		promptGuidelines: [
			"Use paper_research for literature-backed research after paper_search finds candidate papers; prefer citation_graph, map_topic, related, and read_paper over broad web search when methodology/results matter.",
		],
		parameters: Type.Object({
			operation: StringEnum(["search", "map_topic", "trending", "details", "read_paper", "citation_graph", "abstract_search", "related", "linked_resources"], { description: "Research operation to run" }),
			query: Type.Optional(Type.String({ description: "Search/topic/abstract query. Required for search, map_topic, and abstract_search; optional topic filter for trending." })),
			arxivId: Type.Optional(Type.String({ description: "arXiv ID or URL for read_paper/linked_resources/details/citation_graph/related when available" })),
			doi: Type.Optional(Type.String({ description: "DOI for details/citation_graph/related" })),
			openAlexId: Type.Optional(Type.String({ description: "OpenAlex work ID such as W1234567890 or https://openalex.org/W1234567890" })),
			paperId: Type.Optional(Type.String({ description: "Convenience paper identifier: OpenAlex ID/URL, DOI/doi URL, or arXiv ID/URL" })),
			section: Type.Optional(Type.String({ description: "Section name or number for read_paper, e.g. '3', 'Method', '4.2'" })),
			direction: Type.Optional(StringEnum(["citations", "references", "both"], { description: "OpenAlex citation graph direction (default both)" })),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD for Hugging Face trending papers" })),
			yearFrom: Type.Optional(Type.Integer({ description: "Minimum publication year for OpenAlex search/abstract_search" })),
			yearTo: Type.Optional(Type.Integer({ description: "Maximum publication year for OpenAlex search/abstract_search" })),
			openAccessOnly: Type.Optional(Type.Boolean({ description: "Limit OpenAlex search to open-access works" })),
			minCitations: Type.Optional(Type.Integer({ description: "Client-side minimum citation count for OpenAlex search/abstract_search" })),
			sortBy: Type.Optional(StringEnum(["relevance", "citationCount", "publicationDate"], { description: "OpenAlex search sort" })),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum returned papers/resources (default 10, max 50)" })),
			resourceSort: Type.Optional(StringEnum(["downloads", "likes", "trending"], { description: "Sort for linked_resources datasets/models" })),
			includeAbstracts: Type.Optional(Type.Boolean({ description: "Include OpenAlex abstracts where available" })),
		}),

		async execute(_toolCallId, params, signal) {
			return executePaperResearch(params, signal);
		},

		renderCall(args, theme) {
			const input = args as { operation?: string; query?: string; arxivId?: string; paperId?: string };
			const target = input.query || input.arxivId || input.paperId || "";
			const display = target.length > 54 ? target.slice(0, 51) + "..." : target;
			return new Text(theme.fg("toolTitle", theme.bold("paper_research ")) + theme.fg("accent", input.operation || "?") + (display ? theme.fg("muted", ` ${display}`) : ""), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { count?: number; error?: string; operation?: string; sectionCount?: number; referencesCount?: number; citationsCount?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			let summary = theme.fg("success", `${details?.operation ?? "paper_research"}`);
			if (details?.count != null) summary += theme.fg("muted", ` · ${details.count} result(s)`);
			if (details?.sectionCount != null) summary += theme.fg("muted", ` · ${details.sectionCount} sections`);
			if (details?.referencesCount != null || details?.citationsCount != null) summary += theme.fg("muted", ` · ${details.referencesCount ?? 0} refs/${details.citationsCount ?? 0} cites`);
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 900 ? textContent.slice(0, 900) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "docs_search",
		label: "Docs Search",
		description: "Discover and search documentation sites, llms.txt indexes, and markdown docs pages with a lightweight in-memory index. Use for current API/library docs before fetching full pages.",
		promptSnippet:
			"Use to search official docs/llms.txt indexes before broad web search; follow with fetch_content on selected URLs.",
		promptGuidelines: [
			"Use docs_search for official documentation lookups; use fetch_content on a docs_search result URL when exact API details or examples are needed.",
		],
		parameters: Type.Object({
			source: Type.String({ description: "Docs root URL/domain or llms.txt URL, e.g. react.dev/reference/react or https://docs.example.com/llms.txt" }),
			query: Type.Optional(Type.String({ description: "Keyword query to rank docs pages. Omit to list discovered pages." })),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Max results to return (default 10, max 25)" })),
			maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max docs pages to fetch/index (default 40, max 100)" })),
			mode: Type.Optional(StringEnum(["auto", "llms", "crawl"], { description: "Discovery mode: auto tries llms.txt then root-page links; llms only uses llms.txt; crawl follows same-site links from the source page" })),
			maxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 3000, description: "Max snippet characters per result" })),
			returnMetadata: Type.Optional(Type.Boolean({ description: "Include indexed page metadata in details" })),
		}),

		async execute(_toolCallId, params, signal) {
			return executeDocsSearch(params, signal);
		},

		renderCall(args, theme) {
			const input = args as { source?: string; query?: string };
			const source = input.source || "(no source)";
			const display = source.length > 52 ? source.slice(0, 49) + "..." : source;
			return new Text(theme.fg("toolTitle", theme.bold("docs_search ")) + theme.fg("accent", display) + (input.query ? theme.fg("muted", ` · ${input.query}`) : ""), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { count?: number; error?: string; pagesIndexed?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const summary = theme.fg("success", `${details?.count ?? 0} docs result(s)`) + theme.fg("muted", ` · ${details?.pagesIndexed ?? 0} pages indexed`);
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 900 ? textContent.slice(0, 900) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "openapi_search",
		label: "OpenAPI Search",
		description: "Search an OpenAPI JSON spec for REST endpoints and return endpoint details plus curl examples. Defaults to the Hugging Face OpenAPI spec when url is omitted.",
		promptSnippet:
			"Use to find REST API endpoints in an OpenAPI spec with parameters and curl examples.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "OpenAPI JSON URL. Defaults to https://huggingface.co/.well-known/openapi.json" })),
			query: Type.Optional(Type.String({ description: "Keyword search across summaries, descriptions, operation IDs, paths, tags, and parameters" })),
			tag: Type.Optional(Type.String({ description: "Filter by exact OpenAPI tag" })),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Max endpoints to return (default 10, max 25)" })),
		}),

		async execute(_toolCallId, params, signal) {
			return executeOpenApiSearch(params, signal);
		},

		renderCall(args, theme) {
			const input = args as { query?: string; tag?: string; url?: string };
			const target = input.query || input.tag || input.url || "huggingface openapi";
			const display = target.length > 60 ? target.slice(0, 57) + "..." : target;
			return new Text(theme.fg("toolTitle", theme.bold("openapi_search ")) + theme.fg("accent", display), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { count?: number; error?: string; totalEndpoints?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const summary = theme.fg("success", `${details?.count ?? 0} endpoint(s)`) + theme.fg("muted", ` · ${details?.totalEndpoints ?? 0} indexed`);
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 900 ? textContent.slice(0, 900) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "github_examples",
		label: "GitHub Examples",
		description: "Find and read working example scripts, notebooks, tutorials, cookbook files, and guides in GitHub repositories using the GitHub API. Use before implementing against a fast-moving library API.",
		promptSnippet:
			"Use to discover and read current GitHub example files with fuzzy keyword/path ranking and line ranges.",
		promptGuidelines: [
			"Use github_examples before writing code against a library whose current API matters: find examples first, then read selected files with operation='read'.",
		],
		parameters: Type.Object({
			operation: Type.Optional(StringEnum(["find", "read"], { description: "find example files (default) or read a specific file" })),
			repo: Type.String({ description: "Repository as owner/name or GitHub URL" }),
			keyword: Type.Optional(Type.String({ description: "Keyword to rank paths, e.g. sft, auth, streaming, websocket" })),
			path: Type.Optional(Type.String({ description: "File path to read when operation='read'" })),
			ref: Type.Optional(Type.String({ description: "Branch, tag, or commit/ref. Defaults to repo default branch for find and HEAD for read." })),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max results for find (default 12, max 50)" })),
			minScore: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Minimum path score for find" })),
			lineStart: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read (1-indexed)" })),
			lineEnd: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to read (inclusive)" })),
		}),

		async execute(_toolCallId, params, signal) {
			return executeGitHubExamples(params, signal);
		},

		renderCall(args, theme) {
			const input = args as { operation?: string; repo?: string; keyword?: string; path?: string };
			const target = input.path || input.keyword || input.repo || "";
			const display = target.length > 58 ? target.slice(0, 55) + "..." : target;
			return new Text(theme.fg("toolTitle", theme.bold("github_examples ")) + theme.fg("accent", input.operation || "find") + (display ? theme.fg("muted", ` ${display}`) : ""), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { count?: number; error?: string; operation?: string; totalCandidates?: number; totalLines?: number; truncated?: boolean };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			let summary = theme.fg("success", details?.operation === "read" ? `${details.totalLines ?? 0} lines` : `${details?.count ?? 0} example(s)`);
			if (details?.totalCandidates != null) summary += theme.fg("muted", ` · ${details.totalCandidates} candidates`);
			if (details?.truncated) summary += theme.fg("warning", " · truncated");
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 900 ? textContent.slice(0, 900) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch URL(s) and extract readable markdown via HTTP/Readability, GitHub cloning, PDF extraction, and Jina fallback. Content is stored for get_search_content.",
		promptSnippet:
			"Use to extract readable content from URLs, docs, PDFs, and GitHub repos.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			objective: Type.Optional(Type.String({ description: "Focus objective for highlights/summary extraction" })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Related search queries/objectives used to rank highlights" })),
			mode: Type.Optional(StringEnum(["full", "highlights", "summary"], { description: "Content shaping mode: full (default), highlights, or summary" })),
			maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return/store after content shaping" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds" })),
			returnMetadata: Type.Optional(Type.Boolean({ description: "Include extraction metadata/status in details.perUrl" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const urlList = params.urls ?? (params.url ? [params.url] : []);
			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			const fetchResults = await fetchAllContent(urlList, signal, {
				forceClone: params.forceClone,
				objective: params.objective,
				queries: params.queries,
				mode: params.mode,
				maxChars: params.maxChars,
				timeoutMs: params.timeoutMs,
				returnMetadata: params.returnMetadata,
			});
			const successful = fetchResults.filter((r) => !r.error).length;
			const totalChars = fetchResults.reduce((sum, r) => sum + r.content.length, 0);
			const responseId = storeAndPublishFetch(fetchResults);
			const perUrl = fetchResults.map((result, index) => buildFetchDetail(result, index, params.returnMetadata === true));

			if (urlList.length === 1) {
				const result = fetchResults[0];
				if (result.error) {
					return {
						content: [{ type: "text", text: `Error: ${result.error}` }],
						details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, responseId, perUrl, results: perUrl },
					};
				}

				const fullLength = result.content.length;
				const truncated = fullLength > MAX_INLINE_CONTENT;
				let output = truncated
					? result.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated...]"
					: result.content;

				if (truncated) {
					output += `\n\n---\nShowing ${MAX_INLINE_CONTENT} of ${fullLength} chars. ` +
						`Use get_search_content({ responseId: "${responseId}", urlIndex: 0 }) for full content.`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: result.title,
						responseId,
						truncated,
						method: result.method,
						fetchedAt: result.fetchedAt,
						fetchedUrl: result.fetchedUrl,
						contentType: result.contentType,
						httpStatus: result.httpStatus,
						fallbackPath: result.fallbackPath,
						originalContentLength: result.originalContentLength,
						contentRef: params.returnMetadata ? result.contentRef : undefined,
						metadata: params.returnMetadata ? result.metadata : undefined,
						perUrl,
						results: perUrl,
					},
				};
			}

			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of fetchResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			output += `\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to retrieve full content.`;

			return {
				content: [{ type: "text", text: output }],
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars, responseId, perUrl, results: perUrl },
			};
		},

		renderCall(args, theme) {
			const { url, urls } = args as { url?: string; urls?: string[] };
			const urlList = urls ?? (url ? [url] : []);
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`);
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", " (content stored)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		promptSnippet:
			"Use after web_search/fetch_content when full stored content is needed via responseId plus query/url selectors.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Number({ description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
		}),

		async execute(_toolCallId, params) {
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for "${params.responseId}"` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query "${params.query}" not found. Available: ${available}` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						return {
							content: [{ type: "text", text: `Index ${params.queryIndex} out of range (0-${data.queries.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex. Available: ${available}` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error for "${queryData.query}": ${queryData.error}` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				return {
					content: [{ type: "text", text: formatFullResults(queryData) }],
					details: { query: queryData.query, resultCount: queryData.results.length },
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;

				if (params.url !== undefined) {
					urlData = data.urls.find((u) => u.url === params.url);
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL not found. Available:\n  ${available}` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					urlData = data.urls[params.urlIndex];
					if (!urlData) {
						return {
							content: [{ type: "text", text: `Index ${params.urlIndex} out of range (0-${data.urls.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex. Available:\n  ${available}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error for ${urlData.url}: ${urlData.error}` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				const output = formatFetchedContentForDisplay(urlData);
				return {
					content: [{ type: "text", text: output }],
					details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length },
				};
			}

			return {
				content: [{ type: "text", text: "Invalid stored data format" }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
			};

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (details?.query) {
				statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
			} else {
				statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars)`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerCommand("search", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && r.urls) {
					return `[${r.id.slice(0, 6)}] ${r.urls.length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && selected.urls) {
					info += "URLs:\n";
					const urls = selected.urls.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						info += `- ${urlDisplay} (${u.error || `${u.content.length} chars`})\n`;
					}
					if (selected.urls.length > 10) {
						info += `... and ${selected.urls.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}

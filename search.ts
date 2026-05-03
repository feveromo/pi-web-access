import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchResponse, SearchOptions } from "./search-types.js";
import { hasExaApiKey, searchWithExa } from "./exa.js";

export type SearchProvider = "auto" | "exa";
export type ResolvedSearchProvider = "exa";

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SEARCH_CACHE_ENTRIES = 100;

let cachedSearchConfig: { searchProvider: SearchProvider } | null = null;
const searchCache = new Map<string, { expiresAt: number; response: AttributedSearchResponse }>();

function getSearchConfig(): { searchProvider: SearchProvider } {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto" };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { searchProvider?: unknown; provider?: unknown };
	try {
		raw = JSON.parse(rawText) as { searchProvider?: unknown; provider?: unknown };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	cachedSearchConfig = {
		searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider),
	};
	return cachedSearchConfig;
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "exa" ? normalized : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}

function normalizeCacheDomainFilter(value: string[] | undefined): string[] | undefined {
	if (!value?.length) return undefined;
	return value.map(v => v.trim()).filter(Boolean).sort();
}

function searchCacheKey(query: string, provider: SearchProvider, options: FullSearchOptions): string {
	return JSON.stringify({
		query: query.trim().replace(/\s+/g, " ").toLowerCase(),
		provider,
		numResults: options.numResults,
		recencyFilter: options.recencyFilter,
		domainFilter: normalizeCacheDomainFilter(options.domainFilter),
		includeContent: options.includeContent === true,
		researchDepth: options.researchDepth,
		searchType: options.searchType,
		contentMode: options.contentMode,
		maxCharacters: options.maxCharacters,
		livecrawl: options.livecrawl,
		synthesize: options.synthesize === true,
	});
}

function cloneSearchResponse(response: AttributedSearchResponse, cacheHit = false): AttributedSearchResponse {
	return {
		...response,
		results: response.results.map(result => ({ ...result })),
		inlineContent: response.inlineContent?.map(item => ({ ...item })),
		metadata: response.metadata || cacheHit
			? { ...(response.metadata ?? {}), ...(cacheHit ? { cacheHit: true } : {}) }
			: undefined,
	};
}

function getCachedSearchResult(key: string, includeMetadata: boolean | undefined): AttributedSearchResponse | null {
	const entry = searchCache.get(key);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		searchCache.delete(key);
		return null;
	}
	const cloned = cloneSearchResponse(entry.response, includeMetadata === true);
	if (!includeMetadata) {
		delete cloned.metadata;
	}
	return cloned;
}

function storeCachedSearchResult(key: string, response: AttributedSearchResponse): AttributedSearchResponse {
	if (searchCache.size >= MAX_SEARCH_CACHE_ENTRIES) {
		const firstKey = searchCache.keys().next().value;
		if (firstKey) searchCache.delete(firstKey);
	}
	searchCache.set(key, {
		expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
		response: cloneSearchResponse(response),
	});
	return response;
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider ?? config.searchProvider;
	const cacheKey = searchCacheKey(query, provider, options);
	const cached = getCachedSearchResult(cacheKey, options.returnMetadata);
	if (cached) return cached;

	try {
		const result = await searchWithExa(query, options);
		if (result && "exhausted" in result) {
			throw new Error(
				"Exa monthly free tier exhausted (1,000 requests). Resets next month. " +
				"Upgrade at exa.ai/pricing or remove the configured Exa API key to use the zero-config Exa MCP path."
			);
		}
		if (result && "answer" in result) {
			return storeCachedSearchResult(cacheKey, { ...result, provider: "exa" });
		}
		throw new Error(hasExaApiKey() ? "Exa search returned no results." : "Exa MCP search returned no results.");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) throw err;
		throw new Error(`Exa search failed: ${message}`);
	}
}

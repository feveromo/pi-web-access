import type { ExtractedContent } from "./extract.js";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
	metadata?: Record<string, unknown>;
}

export type ResearchDepth = "quick" | "standard" | "deep";
export type ExaSearchType = "fast" | "auto" | "deep-lite" | "deep" | "deep-reasoning";
export type SearchContentMode = "none" | "highlights" | "summary" | "text";
export type LivecrawlMode = "never" | "fallback" | "always";

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	researchDepth?: ResearchDepth;
	searchType?: ExaSearchType;
	contentMode?: SearchContentMode;
	maxCharacters?: number;
	livecrawl?: LivecrawlMode;
	synthesize?: boolean;
	signal?: AbortSignal;
	returnMetadata?: boolean;
}

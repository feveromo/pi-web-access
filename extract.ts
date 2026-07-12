import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.js";
import { extractPDFToMarkdown, isPDF } from "./pdf-extract.js";
import { extractGitHub, parseGitHubUrl } from "./github-extract.js";
import {
	ResponseTooLargeError,
	isSafeForThirdPartyFetch,
	readErrorSnippet,
	readResponseBytes,
	readResponseText,
	requestSignal,
	uint8ArrayToArrayBuffer,
} from "./http-response.js";
import { fetchRemoteUrl, validateRemoteUrl, validateThirdPartySourceUrl, type Lookup } from "./ssrf-protection.js";
import { loadSsrfAllowRanges } from "./ssrf-config.js";
import { buildRawExtractionCacheKey } from "./raw-cache-policy.js";
import { cacheFreshnessFromHeaders } from "./persistent-cache.js";
import { createRawPersistentCache, decorateRawCacheResult } from "./raw-persistent-cache.js";
import { extractNpmPackage, parseNpmPackageUrl } from "./npm-registry.js";
import { extractStaticHtmlPartial, isLikelyJSRendered, preferJinaResult } from "./static-html-partial.js";

const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const MAX_HTML_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_RESPONSE_BYTES = 20 * 1024 * 1024;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string, fallbackPath?: string[]): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted", status: "error", method: "aborted", fetchedAt: new Date().toISOString(), fallbackPath };
}

function normalizeMode(mode: unknown): ExtractMode {
	return mode === "highlights" || mode === "summary" ? mode : "full";
}

function normalizeMaxChars(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const rounded = Math.floor(value);
	return rounded > 0 ? Math.min(rounded, 1_000_000) : null;
}

function normalizeTimeoutMs(value: unknown, fallback = DEFAULT_TIMEOUT_MS): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function objectiveTokens(options?: ExtractOptions): Set<string> {
	const raw = [options?.objective, ...(options?.queries ?? [])].filter((v): v is string => typeof v === "string").join(" ").toLowerCase();
	const stop = new Set(["about", "after", "also", "and", "are", "because", "but", "can", "for", "from", "has", "have", "how", "into", "its", "not", "our", "that", "the", "their", "this", "was", "what", "when", "where", "which", "with", "you", "your"]);
	return new Set((raw.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(t => !stop.has(t)));
}

function splitMarkdownBlocks(markdown: string): string[] {
	return markdown
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(block => block.length > 0);
}

function scoreBlock(block: string, tokens: Set<string>, index: number): number {
	let score = Math.max(0, 8 - index * 0.05);
	if (/^#{1,3}\s/.test(block)) score += 2;
	const lower = block.toLowerCase();
	for (const token of tokens) {
		const matches = lower.match(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"));
		if (matches) score += matches.length * 6;
	}
	return score;
}

function buildHighlights(markdown: string, tokens: Set<string>): string {
	const blocks = splitMarkdownBlocks(markdown);
	if (blocks.length === 0 || tokens.size === 0) return blocks.slice(0, 6).join("\n\n");
	const selected = blocks
		.map((block, index) => ({ block, index, score: scoreBlock(block, tokens, index) }))
		.filter(item => item.score > Math.max(1, 8 - item.index * 0.05))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, 8)
		.sort((a, b) => a.index - b.index)
		.map(item => item.block);
	return (selected.length > 0 ? selected : blocks.slice(0, 6)).join("\n\n");
}

function buildSummary(markdown: string, tokens: Set<string>): string {
	const blocks = splitMarkdownBlocks(markdown);
	if (blocks.length === 0) return markdown;
	const headings = blocks.filter(block => /^#{1,3}\s/.test(block)).slice(0, 12);
	const paragraphs = tokens.size > 0
		? blocks
			.map((block, index) => ({ block, index, score: scoreBlock(block, tokens, index) }))
			.filter(item => !/^#{1,3}\s/.test(item.block))
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, 5)
			.sort((a, b) => a.index - b.index)
			.map(item => item.block)
		: blocks.filter(block => !/^#{1,3}\s/.test(block)).slice(0, 5);
	return [...headings, ...paragraphs].join("\n\n") || blocks.slice(0, 6).join("\n\n");
}

function capContent(content: string, maxChars: number | null): { content: string; truncated: boolean } {
	if (!maxChars || content.length <= maxChars) return { content, truncated: false };
	const marker = "\n\n[Truncated by fetch_content maxChars]";
	const bodyLimit = Math.max(0, maxChars - marker.length);
	const slice = content.slice(0, bodyLimit);
	const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
	const capped = (breakAt > Math.floor(bodyLimit * 0.5) ? slice.slice(0, breakAt + 1) : slice).trimEnd();
	const output = `${capped}${marker}`;
	return { content: output.length > maxChars ? output.slice(0, maxChars) : output, truncated: true };
}

function shapeExtractedContent(result: ExtractedContent, options?: ExtractOptions): ExtractedContent {
	if (result.error || !result.content) return { ...result, status: "error", originalContentLength: result.content.length, truncated: false };
	const originalContentLength = result.content.length;
	const mode = normalizeMode(options?.mode);
	const tokens = objectiveTokens(options);
	let shaped = result.content;
	if (mode === "highlights") shaped = buildHighlights(shaped, tokens);
	else if (mode === "summary") shaped = buildSummary(shaped, tokens);
	if (result.retrievalStatus === "partial" && !shaped.includes("[Partial extraction:")) {
		shaped = `[Partial extraction: JavaScript was not executed. Only static HTML evidence is available.]\n\n${shaped}`;
	}
	const capped = capContent(shaped, normalizeMaxChars(options?.maxChars));
	return {
		...result,
		content: capped.content,
		status: "success",
		originalContentLength,
		truncated: capped.truncated || shaped.length < originalContentLength,
		metadata: {
			...(result.metadata ?? {}),
			mode,
			objective: options?.objective,
			queries: options?.queries,
		},
	};
}

function finalizeRawResult(
	result: ExtractedContent,
	method: string,
	fallbackPath: string[],
	extra?: Partial<ExtractedContent>,
): ExtractedContent {
	return {
		...result,
		...extra,
		method: result.method ?? extra?.method ?? method,
		status: result.error ? "error" : "success",
		fetchedAt: result.fetchedAt ?? extra?.fetchedAt ?? new Date().toISOString(),
		fallbackPath: result.fallbackPath ?? fallbackPath,
	};
}

const rawExtractionCache = createRawPersistentCache({ allowRanges: loadSsrfAllowRanges });

function rawCacheKey(url: string, options?: ExtractOptions): string | null {
	return buildRawExtractionCacheKey(url, {
		forceClone: options?.forceClone,
		timeoutMs: options?.timeoutMs,
		hasLookup: !!options?.lookup,
	}, loadSsrfAllowRanges());
}



const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export type ExtractMode = "full" | "highlights" | "summary";

export interface StoredContentRef {
	version: number;
	kind: "file";
	path: string;
	chars: number;
	sha256: string;
	savedAt: number;
	previewChars: number;
}

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	status?: "success" | "error";
	method?: string;
	fetchedAt?: string;
	fetchedUrl?: string;
	contentType?: string;
	httpStatus?: number;
	contentLength?: number;
	originalContentLength?: number;
	truncated?: boolean;
	fallbackPath?: string[];
	retrievalStatus?: string;
	contentRef?: StoredContentRef;
	metadata?: Record<string, unknown>;
}

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	/** Internal test hook; not exposed by the Pi tool schema. */
	lookup?: Lookup;
	objective?: string;
	queries?: string[];
	mode?: ExtractMode;
	maxChars?: number;
	returnMetadata?: boolean;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

async function extractWithJinaReader(
	url: string,
	signal?: AbortSignal,
	timeoutMs = JINA_TIMEOUT_MS,
	lookup?: Lookup,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });
	const operationSignal = requestSignal(signal, normalizeTimeoutMs(timeoutMs, JINA_TIMEOUT_MS));

	try {
		await validateThirdPartySourceUrl(url, { lookup, signal: operationSignal });
		const res = await fetch(jinaUrl, {
			headers: {
				"Accept": "text/markdown",
				"X-No-Cache": "true",
			},
			signal: operationSignal,
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			await readErrorSnippet(res);
			return null;
		}

		const content = await readResponseText(res, MAX_HTML_RESPONSE_BYTES);
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null, method: "jina", fetchedAt: new Date().toISOString(), fetchedUrl: jinaUrl, httpStatus: res.status, contentType: res.headers.get("content-type") || undefined };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

async function extractRawContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const fallbackPath: string[] = [];
	if (signal?.aborted) {
		return abortedResult(url, fallbackPath);
	}


	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		return { url, title: "", content: "", error: `Unsupported URL protocol: ${parsedUrl.protocol}` };
	}
	const npmTarget = parseNpmPackageUrl(url);
	if (npmTarget) {
		fallbackPath.push("npm-registry");
		const npmResult = await extractNpmPackage(url, npmTarget, {
			signal,
			timeoutMs: normalizeTimeoutMs(options?.timeoutMs),
			lookup: options?.lookup,
			allowRanges: loadSsrfAllowRanges(),
		});
		return finalizeRawResult(npmResult, "npm-registry", fallbackPath);
	}
	if (parseGitHubUrl(url)) {
		try {
			await validateRemoteUrl(parsedUrl, {
				allowRanges: loadSsrfAllowRanges(),
				lookup: options?.lookup,
				signal: requestSignal(signal, normalizeTimeoutMs(options?.timeoutMs)),
			});
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err), status: "error", method: "blocked-url" };
		}
	}

	fallbackPath.push("github");
	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone);
		if (ghResult) return finalizeRawResult(ghResult, "github", fallbackPath);
		if (signal?.aborted) return abortedResult(url, fallbackPath);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url, fallbackPath);
		if (isConfigParseError(err)) {
			return finalizeRawResult({ url, title: "", content: "", error: message }, "github", fallbackPath);
		}
	}

	if (signal?.aborted) return abortedResult(url, fallbackPath);

	fallbackPath.push("http");
	const httpResult = await extractViaHttp(url, signal, options);

	if (signal?.aborted) return abortedResult(url, fallbackPath);
	if (!httpResult.error) return finalizeRawResult(httpResult, httpResult.method ?? "http", fallbackPath);
	if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult.error!.startsWith(prefix))) return finalizeRawResult(httpResult, httpResult.method ?? "http", fallbackPath);
	if (httpResult.httpStatus && httpResult.httpStatus >= 400 && httpResult.httpStatus < 500 && httpResult.httpStatus !== 403 && httpResult.httpStatus !== 429) {
		return finalizeRawResult(httpResult, httpResult.method ?? "http", fallbackPath);
	}

	if (isSafeForThirdPartyFetch(url)) {
		fallbackPath.push("jina");
		const jinaResult = await extractWithJinaReader(url, signal, options?.timeoutMs, options?.lookup);
		const preferredResult = preferJinaResult(jinaResult, httpResult);
		if (!preferredResult.error) return finalizeRawResult(preferredResult, "jina", fallbackPath);
		if (signal?.aborted) return abortedResult(url, fallbackPath);
	} else {
		fallbackPath.push("jina-skipped-sensitive-url");
	}

	if (httpResult.content && httpResult.method === "js-rendered" && httpResult.metadata?.staticHtmlPartial === true) {
		return finalizeRawResult({
			...httpResult,
			error: null,
			retrievalStatus: "partial",
			method: "static-html-partial",
			metadata: {
				...(httpResult.metadata ?? {}),
				extractionWarning: httpResult.error,
				provenance: "Static HTML metadata and same-origin route evidence; JavaScript was not executed",
			},
		}, "static-html-partial", fallbackPath);
	}

	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		"  \u2022 Use web_search to find content about this topic",
		"  \u2022 Fetch a more specific source URL, raw file, PDF, or official docs page",
		...(fallbackPath.includes("jina-skipped-sensitive-url")
			? ["  \u2022 Jina fallback was skipped to avoid sending a private or credential-bearing URL to a third party"]
			: []),
	].join("\n");
	return finalizeRawResult({ ...httpResult, error: guidance }, httpResult.method ?? "http", fallbackPath);
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const key = rawCacheKey(url, options);
	if (!key) return shapeExtractedContent(await extractRawContent(url, signal, options), options);
	// DNS/SSRF validation deliberately precedes memory and disk lookup; a warm entry
	// must never bypass a changed resolver or allow-range policy.
	try {
		await validateRemoteUrl(url, { allowRanges: loadSsrfAllowRanges(), lookup: options?.lookup, signal: requestSignal(signal, normalizeTimeoutMs(options?.timeoutMs)) });
	} catch (err) {
		if (signal?.aborted || isAbortError(err)) return shapeExtractedContent(abortedResult(url), options);
		return shapeExtractedContent(finalizeRawResult({ url, title: "", content: "", error: errorMessage(err) }, "http", ["http"]), options);
	}
	const cached = await rawExtractionCache.get(key, async (sharedSignal: AbortSignal) => {
		const result = await extractRawContent(url, sharedSignal, options);
		if (result.error || sharedSignal.aborted) {
			const transport = result.metadata?.transportError as { code?: string; name?: string; timeout?: boolean } | undefined;
			const error = Object.assign(new Error(result.error || "Aborted"), { rawResult: result, status: result.httpStatus, code: transport?.code, name: transport?.name ?? "Error", timeout: transport?.timeout });
			throw error;
		}
		const origin = result.metadata?.originCache as { persist?: boolean; freshMs?: number } | undefined;
		return { value: result, persist: origin?.persist !== false, freshMs: origin?.freshMs ?? 6 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 };
	}, { signal, staleMs: 24 * 60 * 60 * 1000 }).catch((err: Error & { rawResult?: ExtractedContent }) => {
		if (err.rawResult) return { value: err.rawResult, metadata: { status: "miss", ageMs: 0, storage: "none", freshUntil: null, staleUntil: null, shared: false } };
		if (isAbortError(err)) return { value: abortedResult(url), metadata: { status: "miss", ageMs: 0, storage: "none", freshUntil: null, staleUntil: null, shared: false } };
		throw err;
	});
	return shapeExtractedContent(decorateRawCacheResult(cached.value, cached.metadata) as ExtractedContent, options);
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const timeoutMs = normalizeTimeoutMs(options?.timeoutMs);
	const operationSignal = requestSignal(signal, timeoutMs);
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	try {
		const response = await fetchRemoteUrl(url, {
			signal: operationSignal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		}, { allowRanges: loadSsrfAllowRanges(), lookup: options?.lookup });

		const fetchedAt = new Date().toISOString();
		const fetchedUrl = response.url || url;
		const contentType = response.headers.get("content-type") || "";
		const contentLengthHeader = response.headers.get("content-length");
		const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
		const originCache = cacheFreshnessFromHeaders(response.headers);
		const httpMeta: Partial<ExtractedContent> = {
			method: "http",
			fetchedAt,
			fetchedUrl,
			contentType: contentType || undefined,
			httpStatus: response.status,
			contentLength: contentLength !== undefined && Number.isFinite(contentLength) ? contentLength : undefined,
			metadata: { originCache },
		};

		if (!response.ok) {
			const snippet = await readErrorSnippet(response, 200);
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}${snippet ? ` — ${snippet}` : ""}`,
				...httpMeta,
			};
		}

		const isPDFContent = isPDF(url, contentType);
		if (isPDFContent) {
			try {
				const bytes = await readResponseBytes(response, MAX_PDF_RESPONSE_BYTES);
				const result = await extractPDFToMarkdown(uint8ArrayToArrayBuffer(bytes), url, { signal: operationSignal });
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: result.content,
					error: null,
					...httpMeta,
					method: "pdf",
					metadata: { pdf: { outputPath: result.outputPath, pages: result.pages, chars: result.chars } },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (err instanceof ResponseTooLargeError) {
					activityMonitor.logComplete(activityId, response.status);
					return { url, title: "", content: "", error: message, ...httpMeta, method: "http-size-limit" };
				}
				if (operationSignal.aborted) activityMonitor.logComplete(activityId, 0);
				else activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}`, ...httpMeta, method: "pdf" };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			await response.body?.cancel().catch(() => {});
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
				...httpMeta,
				method: "unsupported-content",
			};
		}

		let text: string;
		try {
			text = await readResponseText(response, MAX_HTML_RESPONSE_BYTES);
		} catch (err) {
			if (err instanceof ResponseTooLargeError) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: err.message, ...httpMeta, method: "http-size-limit" };
			}
			throw err;
		}
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: extractTextTitle(text, url), content: text, error: null, ...httpMeta, method: "text" };
		}

		const { document } = parseHTML(text);
		const article = new Readability(document as unknown as Document).parse();
		if (!article) {
			activityMonitor.logComplete(activityId, response.status);
			const jsRendered = isLikelyJSRendered(text);
			const warning = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";
			const partial = extractStaticHtmlPartial(text, fetchedUrl, warning);
			return {
				url,
				title: partial.title,
				content: partial.content,
				error: warning,
				...httpMeta,
				metadata: partial.metadata,
				method: jsRendered ? "js-rendered" : "readability-failed",
			};
		}

		const markdown = turndown.turndown(article.content);
		activityMonitor.logComplete(activityId, response.status);
		if (markdown.length < MIN_USEFUL_CONTENT) {
			const incompleteJsRendered = isLikelyJSRendered(text);
			const warning = incompleteJsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Extracted content appears incomplete";
			const partial = extractStaticHtmlPartial(text, fetchedUrl, warning);
			return {
				url,
				title: partial.title || article.title || "",
				content: partial.content,
				error: warning,
				...httpMeta,
				metadata: partial.metadata,
				method: incompleteJsRendered ? "js-rendered" : "readability-incomplete",
			};
		}
		return { url, title: article.title || "", content: markdown, error: null, ...httpMeta, method: "readability" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (operationSignal.aborted || message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		const source = err as { code?: unknown; name?: unknown };
		return { url, title: "", content: "", error: message, method: "http", fetchedAt: new Date().toISOString(),
			metadata: { transportError: { code: typeof source?.code === "string" ? source.code : undefined, name: typeof source?.name === "string" ? source.name : undefined, timeout: source?.name === "TimeoutError" } } };
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
}

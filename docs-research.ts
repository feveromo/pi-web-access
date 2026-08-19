import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import TurndownService from "turndown";
import { readErrorSnippet, readResponseJson, readResponseText } from "./http-response.js";
import { loadSsrfAllowRanges } from "./ssrf-config.js";
import { fetchRemoteUrl, validateRemoteUrl, type Lookup } from "./ssrf-protection.ts";
import { createPersistentCache } from "./persistent-cache.js";

export type DocsSearchMode = "auto" | "llms" | "crawl";

export interface DocsSearchParams {
	source: string;
	query?: string;
	maxResults?: number;
	maxPages?: number;
	mode?: DocsSearchMode;
	maxCharacters?: number;
	returnMetadata?: boolean;
}

export interface OpenApiSearchParams {
	url?: string;
	query?: string;
	tag?: string;
	maxResults?: number;
}

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

interface DocsPage {
	title: string;
	url: string;
	fetchUrl: string;
	content: string;
	glimpse: string;
	contentType: string;
}

interface DiscoveredDoc {
	title: string;
	url: string;
}

interface CachedDiscovery {
	expiresAt: number;
	source: string;
	mode: DocsSearchMode;
	links: DiscoveredDoc[];
}

interface DocsCacheInfo {
	hit: boolean;
	storage: "memory" | "disk" | "fresh";
	expiresAt: number;
	discovery: { hit: boolean; shared: boolean; storage: "memory" | "disk" | "fresh" };
	pages: { memoryHits: number; diskHits: number; sharedHits: number; misses: number; failures: number };
	staleWarnings: string[];
}

interface OpenApiEndpoint {
	method: string;
	path: string;
	operationId: string;
	summary: string;
	description: string;
	tags: string[];
	parameters: Array<Record<string, unknown>>;
	requestBody?: Record<string, unknown>;
	responses?: Record<string, unknown>;
	baseUrl: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DOCS_CACHE_TTL_MS = 7 * DAY_MS;
const DOCS_CACHE_HARD_RETAIN_MS = 30 * DAY_MS;
const OPENAPI_CACHE_TTL_MS = DAY_MS;
const OPENAPI_CACHE_HARD_RETAIN_MS = 7 * DAY_MS;
const DEFAULT_MAX_PAGES = 40;
const MAX_PAGES_CAP = 100;
const DEFAULT_MAX_RESULTS = 6;
const MAX_RESULTS_CAP = 25;
const DEFAULT_MAX_CHARS = 450;
const MAX_SNIPPET_CHARS = 1500;
const MAX_DOCS_OUTPUT_CHARS = 50_000;
const MAX_DOCS_ERROR_CHARS = 4_000;
const DISCOVERY_LINK_CAP = 300;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_DOCS_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_OPENAPI_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAPI_URL = "https://huggingface.co/.well-known/openapi.json";

const persistentDiscoveryCache = createPersistentCache({
	namespace: "docs-discovery", freshMs: DOCS_CACHE_TTL_MS, staleMs: DOCS_CACHE_HARD_RETAIN_MS,
	maxEntries: 100, maxBytes: 8 * 1024 * 1024, maxValueBytes: 1024 * 1024,
	validate: (value: unknown) => !!value && typeof value === "object"
		&& typeof (value as CachedDiscovery).source === "string"
		&& Array.isArray((value as CachedDiscovery).links)
		&& (value as CachedDiscovery).links.length <= DISCOVERY_LINK_CAP
		&& (value as CachedDiscovery).links.every(isDiscoveredDoc),
});
const persistentPageCache = createPersistentCache({
	namespace: "docs-page", freshMs: DOCS_CACHE_TTL_MS, staleMs: DOCS_CACHE_HARD_RETAIN_MS,
	maxEntries: 500, maxBytes: 64 * 1024 * 1024, maxValueBytes: MAX_DOCS_PAGE_BYTES + 64 * 1024,
	validate: isDocsPage,
});
const persistentOpenApiCache = createPersistentCache({
	namespace: "openapi", freshMs: OPENAPI_CACHE_TTL_MS, staleMs: OPENAPI_CACHE_HARD_RETAIN_MS,
	maxEntries: 50, maxBytes: 64 * 1024 * 1024, maxValueBytes: MAX_OPENAPI_BYTES,
	validate: isCachedOpenApi,
});
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const fetchLimit = pLimit(5);

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

function normalizeSource(input: string): URL {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("No docs source provided.");
	let source: URL;
	try {
		source = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		throw new Error("Invalid docs source URL.");
	}
	if (source.protocol !== "http:" && source.protocol !== "https:") throw new Error("Docs source must use HTTP or HTTPS.");
	source.hash = "";
	if (source.pathname !== "/" && !/\/llms(?:-full)?\.txt$/i.test(source.pathname)) {
		source.pathname = source.pathname.replace(/\/+$/, "");
	}
	return source;
}

function normalizeMode(value: unknown): DocsSearchMode {
	return value === "llms" || value === "crawl" ? value : "auto";
}

function textContent(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function titleFromMarkdown(markdown: string, fallback: string): string {
	const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return textContent(heading);
	return fallback;
}

function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const tail = parsed.pathname.split("/").filter(Boolean).pop();
		return tail ? decodeURIComponent(tail).replace(/[-_]/g, " ") : parsed.hostname;
	} catch {
		return url;
	}
}

function truncate(text: string, max = DEFAULT_MAX_CHARS): string {
	const normalized = textContent(text);
	return normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized;
}

function capDocsOutput(text: string): { text: string; truncated: boolean; originalChars: number } {
	if (text.length <= MAX_DOCS_OUTPUT_CHARS) return { text, truncated: false, originalChars: text.length };
	const marker = "\n\n[Docs search output capped; use a narrower query or fetch_content on a selected result URL.]";
	const bodyLimit = Math.max(0, MAX_DOCS_OUTPUT_CHARS - marker.length);
	return {
		text: `${text.slice(0, bodyLimit).trimEnd()}${marker}`,
		truncated: true,
		originalChars: text.length,
	};
}

function isDocsPage(value: unknown): value is DocsPage {
	if (!value || typeof value !== "object") return false;
	const page = value as Record<string, unknown>;
	return typeof page.title === "string"
		&& typeof page.url === "string"
		&& typeof page.fetchUrl === "string"
		&& typeof page.content === "string"
		&& typeof page.glimpse === "string"
		&& typeof page.contentType === "string";
}

function isDiscoveredDoc(value: unknown): value is DiscoveredDoc {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.title === "string" && item.title.length <= 10_000 && typeof item.url === "string" && item.url.length <= 16_384;
}

function isBoundedJson(value: unknown, budget: { nodes: number }, depth = 0): boolean {
	if (++budget.nodes > 100_000 || depth > 16) return false;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "string") return value.length <= 100_000;
	if (Array.isArray(value)) return value.length <= 10_000 && value.every(item => isBoundedJson(item, budget, depth + 1));
	if (!value || typeof value !== "object") return false;
	const entries = Object.entries(value);
	return entries.length <= 10_000 && entries.every(([key, item]) => key.length <= 10_000 && isBoundedJson(item, budget, depth + 1));
}

function isCachedOpenApi(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const item = value as { endpoints?: unknown; tags?: unknown };
	if (!Array.isArray(item.tags) || item.tags.length > 10_000 || !item.tags.every(tag => typeof tag === "string" && tag.length <= 1000)) return false;
	if (!Array.isArray(item.endpoints) || item.endpoints.length > 100_000) return false;
	const budget = { nodes: 0 };
	return item.endpoints.every(raw => {
		if (!raw || typeof raw !== "object") return false;
		const endpoint = raw as Record<string, unknown>;
		return ["method", "path", "operationId", "summary", "description", "baseUrl"].every(key => typeof endpoint[key] === "string" && (endpoint[key] as string).length <= 100_000)
			&& Array.isArray(endpoint.tags) && endpoint.tags.length <= 1000 && endpoint.tags.every(tag => typeof tag === "string" && tag.length <= 1000)
			&& Array.isArray(endpoint.parameters) && endpoint.parameters.length <= 10_000 && endpoint.parameters.every(parameter => isBoundedJson(parameter, budget))
			&& (endpoint.requestBody === undefined || isBoundedJson(endpoint.requestBody, budget))
			&& (endpoint.responses === undefined || isBoundedJson(endpoint.responses, budget));
	});
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Aborted", "AbortError");
}

interface DocsRequestOptions {
	/** Internal deterministic-test hook; this is not exposed by either tool schema. */
	lookup?: Lookup;
}

function remoteOptions(options?: DocsRequestOptions) {
	const testLookup = (globalThis as typeof globalThis & { __PI_WEB_ACCESS_DOCS_LOOKUP__?: Lookup }).__PI_WEB_ACCESS_DOCS_LOOKUP__;
	return { allowRanges: loadSsrfAllowRanges(), lookup: options?.lookup ?? testLookup };
}

async function fetchText(url: string, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ text: string; url: string; contentType: string; status: number }> {
	const res = await fetchRemoteUrl(url, {
		headers: {
			"Accept": "text/markdown,text/plain,text/html,application/json,*/*",
			"User-Agent": "pi-web-access/0.10",
		},
		signal: requestSignal(signal),
	}, remoteOptions(options));
	if (!res.ok) {
		const error = new Error(`HTTP ${res.status}: ${await readErrorSnippet(res, 200)}`) as Error & { status: number };
		error.status = res.status;
		throw error;
	}
	return { text: await readResponseText(res, MAX_DOCS_PAGE_BYTES), url: res.url || url, contentType: res.headers.get("content-type") || "", status: res.status };
}

function isLikelyMarkdown(url: string, contentType: string, text: string): boolean {
	if (/markdown|text\/plain/i.test(contentType)) return true;
	try {
		if (/\.(md|mdx|txt)$/i.test(new URL(url).pathname)) return true;
	} catch {
		// A malformed final response URL does not change the content-based fallback.
	}
	return /^#\s|\n#{1,3}\s|\[[^\]]+\]\([^)]+\)/.test(text.slice(0, 2000));
}

function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document, { keepClasses: false });
	const article = reader.parse();
	const title = textContent(article?.title || document.querySelector("h1")?.textContent || document.querySelector("title")?.textContent || titleFromUrl(url));
	const htmlBody = article?.content || document.querySelector("main")?.innerHTML || document.body?.innerHTML || html;
	const markdown = turndown.turndown(htmlBody);
	return { title, markdown };
}

function markdownLinks(markdown: string, base: URL): Array<{ title: string; url: string }> {
	const links: Array<{ title: string; url: string }> = [];
	const seen = new Set<string>();
	const add = (title: string, href: string) => {
		try {
			const resolved = new URL(href, base);
			if (!/^https?:$/i.test(resolved.protocol)) return;
			resolved.hash = "";
			const key = resolved.toString();
			if (seen.has(key)) return;
			seen.add(key);
			links.push({ title: textContent(title) || titleFromUrl(key), url: key });
		} catch {
			return;
		}
	};
	for (const match of markdown.matchAll(/\[([^\]]{1,160})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		add(match[1], match[2]);
	}
	for (const match of markdown.matchAll(/https?:\/\/[^\s)>'"]+/g)) {
		add(titleFromUrl(match[0]), match[0]);
	}
	return links;
}

function htmlLinks(html: string, base: URL, source: URL): Array<{ title: string; url: string }> {
	const { document } = parseHTML(html);
	const links: Array<{ title: string; url: string }> = [];
	const seen = new Set<string>();
	const sourcePath = source.pathname === "/" ? "/" : `${source.pathname.replace(/\/+$/, "")}/`;
	for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
		const href = anchor.getAttribute("href") || "";
		try {
			const resolved = new URL(href, base);
			if (resolved.origin !== source.origin) continue;
			if (sourcePath !== "/" && resolved.pathname !== source.pathname && !resolved.pathname.startsWith(sourcePath)) continue;
			if (/\.(png|jpe?g|gif|svg|webp|zip|tar|gz|pdf)$/i.test(resolved.pathname)) continue;
			resolved.hash = "";
			const key = resolved.toString();
			if (seen.has(key)) continue;
			seen.add(key);
			links.push({ title: textContent(anchor.textContent || "") || titleFromUrl(key), url: key });
		} catch {
		}
	}
	return links;
}

async function tryLlmsTxt(source: URL, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ root: URL; text: string } | null> {
	const candidates: URL[] = [];
	if (/\/llms(?:-full)?\.txt$/i.test(source.pathname)) candidates.push(source);
	else candidates.push(new URL("/llms.txt", source.origin), new URL(`${source.pathname.replace(/\/$/, "")}/llms.txt`, source));
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate.toString())) continue;
		seen.add(candidate.toString());
		try {
			const fetched = await fetchText(candidate.toString(), signal, options);
			if (fetched.text.length > 20 && markdownLinks(fetched.text, candidate).length > 0) {
				return { root: candidate, text: fetched.text };
			}
		} catch (err) {
			if (signal?.aborted) throw abortReason(signal);
		}
	}
	return null;
}

function markdownCandidate(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname === "huggingface.co" && parsed.pathname.startsWith("/docs/") && !/\.[a-z0-9]+$/i.test(parsed.pathname)) {
			return `${parsed.toString().replace(/\/$/, "")}.md`;
		}
	} catch {
		return null;
	}
	return null;
}

async function fetchDocsPage(item: { title: string; url: string }, signal?: AbortSignal, options?: DocsRequestOptions): Promise<DocsPage | null> {
	const candidates = [markdownCandidate(item.url), item.url].filter((v): v is string => !!v);
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const fetched = await fetchText(candidate, signal, options);
			let title = item.title || titleFromUrl(item.url);
			let content = fetched.text;
			if (isLikelyMarkdown(fetched.url, fetched.contentType, fetched.text)) {
				title = titleFromMarkdown(fetched.text, title);
			} else {
				const converted = htmlToMarkdown(fetched.text, fetched.url);
				title = converted.title || title;
				content = converted.markdown;
			}
			content = content.trim();
			if (content.length < 20) continue;
			return { title, url: item.url, fetchUrl: fetched.url, content, contentType: fetched.contentType, glimpse: truncate(content, 220) };
		} catch (err) {
			if (signal?.aborted) throw abortReason(signal);
			lastError = err;
		}
	}
	if (lastError) throw lastError;
	return null;
}

function scoreDiscoveredLink(item: { title: string; url: string }, query: string): number {
	if (!query.trim()) return 1;
	const haystack = `${item.title} ${item.url}`.toLowerCase();
	let score = 0;
	for (const token of tokenize(query)) {
		if (haystack.includes(token)) score += item.title.toLowerCase().includes(token) ? 10 : 4;
	}
	return score;
}

function selectDiscoveredLinks(items: Array<{ title: string; url: string }>, query: string | undefined, maxPages: number): Array<{ title: string; url: string }> {
	return items
		.map((item, index) => ({ item, index, score: scoreDiscoveredLink(item, query ?? "") }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, maxPages)
		.map(entry => entry.item);
}

async function fetchRoot(source: URL, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ text: string; root: URL }> {
	const candidates = [source.toString()];
	if (source.pathname !== "/" && !source.pathname.endsWith("/")) {
		try {
			const withSlash = new URL(source);
			withSlash.pathname += "/";
			candidates.push(withSlash.toString());
		} catch {
			throw new Error(`Invalid docs root ${source.toString()}`);
		}
	}
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const fetched = await fetchText(candidate, signal, options);
			return { text: fetched.text, root: new URL(fetched.url || candidate) };
		} catch (err) {
			if (signal?.aborted) throw abortReason(signal);
			lastError = err;
		}
	}
	throw lastError ?? new Error(`Could not fetch docs root ${source.toString()}`);
}

async function discoverDocsPages(source: URL, mode: DocsSearchMode, signal?: AbortSignal, options?: DocsRequestOptions): Promise<DiscoveredDoc[]> {
	const discovered: DiscoveredDoc[] = [];
	const seen = new Set<string>();
	const add = (item: DiscoveredDoc) => {
		if (discovered.length >= DISCOVERY_LINK_CAP) return;
		const url = canonicalPageKey(item.url);
		if (!url || seen.has(url)) return;
		seen.add(url);
		discovered.push({ ...item, url });
	};

	if (mode !== "crawl") {
		const llms = await tryLlmsTxt(source, signal, options);
		if (llms) {
			add({ title: "llms.txt", url: llms.root.toString() });
			for (const link of markdownLinks(llms.text, llms.root)) add(link);
			return discovered;
		}
		if (mode === "llms") return discovered;
	}

	const root = await fetchRoot(source, signal, options);
	if (root.root.origin !== source.origin) throw new Error("Docs root redirected to a different origin.");
	add({ title: titleFromUrl(root.root.toString()), url: root.root.toString() });
	for (const link of htmlLinks(root.text, root.root, source)) add(link);
	return discovered;
}

function discoveryKey(source: URL, mode: DocsSearchMode): string {
	return `${source.toString()}|${mode}`;
}

function canonicalPageKey(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.toString();
	} catch {
		return null;
	}
}

async function getDiscovery(source: URL, mode: DocsSearchMode, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ value: CachedDiscovery; storage: "memory" | "disk" | "fresh"; shared: boolean; warning?: string }> {
	await validateRemoteUrl(source, { ...remoteOptions(options), signal: requestSignal(signal) });
	const key = discoveryKey(source, mode);
	// Legacy docs-cache files are ignored. No operation touches the legacy root.
	const cached = await persistentDiscoveryCache.get(key, async (sharedSignal: AbortSignal) => ({
		value: { expiresAt: Date.now() + DOCS_CACHE_TTL_MS, source: source.toString(), mode, links: await discoverDocsPages(source, mode, sharedSignal, options) },
		freshMs: DOCS_CACHE_TTL_MS, staleMs: DOCS_CACHE_HARD_RETAIN_MS,
	}), { signal, freshMs: DOCS_CACHE_TTL_MS, staleMs: DOCS_CACHE_HARD_RETAIN_MS });
	const storage = cached.metadata.storage === "memory" ? "memory" : cached.metadata.storage === "disk" ? "disk" : "fresh";
	return { value: cached.value, storage, shared: cached.metadata.shared, ...(cached.metadata.warning ? { warning: cached.metadata.warning } : {}) };
}

async function getCachedPage(item: DiscoveredDoc, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ page: DocsPage | null; storage: "memory" | "disk" | "fresh" | "shared"; warning?: string }> {
	await validateRemoteUrl(item.url, { ...remoteOptions(options), signal: requestSignal(signal) });
	const key = canonicalPageKey(item.url);
	if (!key) return { page: null, storage: "fresh" };
	try {
		const cached = await persistentPageCache.get(key, async (sharedSignal: AbortSignal) => {
			const page = await fetchLimit(() => fetchDocsPage(item, sharedSignal, options));
			if (!page) throw new Error("Documentation page contained no usable content");
			return { value: page, freshMs: DOCS_CACHE_TTL_MS, staleMs: DOCS_CACHE_HARD_RETAIN_MS };
		}, { signal, freshMs: DOCS_CACHE_TTL_MS, staleMs: DOCS_CACHE_HARD_RETAIN_MS });
		const storage = cached.metadata.shared ? "shared" : cached.metadata.storage === "memory" ? "memory" : cached.metadata.storage === "disk" ? "disk" : "fresh";
		return { page: cached.value, storage, ...(cached.metadata.warning ? { warning: cached.metadata.warning } : {}) };
	} catch (err) {
		if (signal?.aborted) throw err;
		return { page: null, storage: "fresh" };
	}
}

async function getDocsPages(params: DocsSearchParams, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ pages: DocsPage[]; source: URL; mode: DocsSearchMode; cache: DocsCacheInfo }> {
	const source = normalizeSource(params.source);
	const mode = normalizeMode(params.mode);
	const maxPages = clampInt(params.maxPages, DEFAULT_MAX_PAGES, MAX_PAGES_CAP);
	const discovery = await getDiscovery(source, mode, signal, options);
	const selected = selectDiscoveredLinks(discovery.value.links, params.query, maxPages);
	const fetched = await Promise.all(selected.map(item => getCachedPage(item, signal, options)));
	const pages = fetched.flatMap(result => result.page ? [result.page] : []);
	const pageMetrics = { memoryHits: 0, diskHits: 0, sharedHits: 0, misses: 0, failures: 0 };
	const staleWarnings = [discovery.warning, ...fetched.map(result => result.warning)].filter((warning): warning is string => !!warning);
	for (const result of fetched) {
		if (!result.page) pageMetrics.failures++;
		if (result.storage === "memory") pageMetrics.memoryHits++;
		else if (result.storage === "disk") pageMetrics.diskHits++;
		else if (result.storage === "shared") pageMetrics.sharedHits++;
		else pageMetrics.misses++;
	}
	const discoveryHit = discovery.storage !== "fresh" || discovery.shared;
	const hit = discoveryHit && pageMetrics.misses === 0 && pageMetrics.failures === 0;
	const hasFreshOrSharedWork = discovery.storage === "fresh" || pageMetrics.sharedHits > 0 || pageMetrics.misses > 0;
	const storage: DocsCacheInfo["storage"] = hasFreshOrSharedWork
		? "fresh"
		: pageMetrics.diskHits > 0 || discovery.storage === "disk" ? "disk" : "memory";
	return {
		pages,
		source,
		mode,
		cache: {
			hit, storage, expiresAt: discovery.value.expiresAt,
			discovery: { hit: discoveryHit, shared: discovery.shared, storage: discovery.storage },
			pages: pageMetrics,
			staleWarnings,
		},
	};
}

function tokenize(value: string): string[] {
	const stop = new Set(["about", "after", "also", "and", "are", "can", "for", "from", "how", "into", "not", "that", "the", "this", "with", "your"]);
	const tokens = (value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
		.filter(token => !stop.has(token))
		.map(token => token.slice(0, 128));
	return [...new Set(tokens)].slice(0, 64);
}

function scorePage(page: DocsPage, query: string): number {
	const tokens = tokenize(query);
	if (tokens.length === 0) return 1;
	const title = page.title.toLowerCase();
	const content = page.content.toLowerCase();
	let score = 0;
	if (content.includes(query.toLowerCase())) score += 30;
	for (const token of tokens) {
		const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const titleCount = title.match(new RegExp(`\\b${escaped}\\b`, "g"))?.length ?? 0;
		const contentCount = content.match(new RegExp(`\\b${escaped}\\b`, "g"))?.length ?? 0;
		score += titleCount * 20 + Math.min(contentCount, 12) * 3;
	}
	return score;
}

function snippetForPage(page: DocsPage, query: string, maxChars: number): string {
	const tokens = tokenize(query);
	const blocks = page.content.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
	if (tokens.length === 0) return truncate(blocks.slice(0, 3).join("\n\n"), maxChars);
	let best = blocks[0] ?? page.content;
	let bestScore = -1;
	for (const block of blocks) {
		const lower = block.toLowerCase();
		const headingOnly = /^#{1,3}\s/.test(block) && !block.includes("\n");
		const score = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0) - (headingOnly ? 0.25 : 0);
		if (score > bestScore) {
			best = block;
			bestScore = score;
		}
	}
	return truncate(best, maxChars);
}

export async function executeDocsSearch(params: DocsSearchParams, signal?: AbortSignal, options?: DocsRequestOptions): Promise<ToolReturn> {
	try {
		const query = params.query?.trim() ?? "";
		const maxResults = clampInt(params.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
		const maxCharacters = clampInt(params.maxCharacters, DEFAULT_MAX_CHARS, MAX_SNIPPET_CHARS);
		const { pages, source, mode, cache } = await getDocsPages(params, signal, options);
		const ranked = pages
			.map((page, index) => ({ page, index, score: query ? scorePage(page, query) : Math.max(1, pages.length - index) }))
			.filter(item => !query || item.score > 0)
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, maxResults);

		const pageCacheSummary = `${cache.pages.memoryHits} memory, ${cache.pages.diskHits} disk, ${cache.pages.sharedHits} shared, ${cache.pages.misses} fetched, ${cache.pages.failures} failed`;
		const discoveryCacheSummary = cache.discovery.shared ? "shared in-flight" : cache.discovery.hit ? cache.discovery.storage : "fetched";
		const cacheSummary = `Cache: discovery ${discoveryCacheSummary}; pages ${pageCacheSummary}; expires ${new Date(cache.expiresAt).toISOString()}.`;
		const staleWarning = cache.staleWarnings.length ? `WARNING: stale cached documentation is shown because refresh failed (${cache.staleWarnings.join("; ")}).` : "";
		const lines = [`# Docs search: ${source.toString()}`, query ? `Query: "${query}"` : "No query provided — showing discovered pages.", `Indexed ${pages.length} page(s); showing ${ranked.length}.`, cacheSummary, staleWarning, ""].filter(Boolean);
		for (let i = 0; i < ranked.length; i++) {
			const { page, score } = ranked[i];
			lines.push(`## ${i + 1}. ${page.title}`);
			lines.push(page.url);
			if (page.fetchUrl !== page.url) lines.push(`Fetched as: ${page.fetchUrl}`);
			if (query) lines.push(`Relevance: ${score.toFixed(1)}`);
			lines.push(snippetForPage(page, query, maxCharacters), "");
		}
		if (ranked.length > 0) lines.push("Use `fetch_content` on a result URL for the full page, or call `docs_search` with a narrower query.");
		const output = capDocsOutput(lines.join("\n"));
		return {
			content: [{ type: "text", text: output.text }],
			details: {
				source: source.toString(), mode, query, pagesIndexed: pages.length, count: ranked.length,
				outputTruncated: output.truncated,
				originalOutputChars: output.originalChars,
				cacheHit: cache.hit,
				cacheStorage: cache.storage,
				cacheExpiresAt: new Date(cache.expiresAt).toISOString(),
				cache: { ...cache, expiresAt: new Date(cache.expiresAt).toISOString() },
				cacheDiscovery: cache.discovery,
				cachePages: cache.pages,
				results: ranked.map(({ page, score }) => ({ title: page.title, url: page.url, fetchUrl: page.fetchUrl, score, contentLength: page.content.length })),
				...(params.returnMetadata ? { pages: pages.map(p => ({ title: p.title, url: p.url, fetchUrl: p.fetchUrl, contentType: p.contentType, contentLength: p.content.length })) } : {}),
			},
		};
	} catch (err) {
		const message = truncate(errorMessage(err), MAX_DOCS_ERROR_CHARS);
		return { content: [{ type: "text", text: `Docs search failed: ${message}` }], details: { error: message, source: params.source } };
	}
}

async function loadOpenApiFresh(url: string, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ endpoints: OpenApiEndpoint[]; tags: string[] }> {
	const normalizedSource = normalizeSource(url);
	const normalized = normalizedSource.toString();
	await validateRemoteUrl(normalized, { ...remoteOptions(options), signal: requestSignal(signal) });
	const res = await fetchRemoteUrl(normalized, { headers: { "Accept": "application/json", "User-Agent": "pi-web-access/0.10" }, signal: requestSignal(signal) }, remoteOptions(options));
	if (!res.ok) {
		const error = new Error(`HTTP ${res.status}: ${await readErrorSnippet(res, 200)}`) as Error & { status: number };
		error.status = res.status;
		throw error;
	}
	const spec = await readResponseJson(res, MAX_OPENAPI_BYTES) as Record<string, unknown>;
	const servers = Array.isArray(spec.servers) ? spec.servers as Array<Record<string, unknown>> : [];
	const baseUrl = typeof servers[0]?.url === "string" ? servers[0].url : normalizedSource.origin;
	const endpoints: OpenApiEndpoint[] = [];
	const paths = spec.paths && typeof spec.paths === "object" ? spec.paths as Record<string, Record<string, unknown>> : {};
	for (const [path, pathItem] of Object.entries(paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;
		const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters as Array<Record<string, unknown>> : [];
		for (const [method, opRaw] of Object.entries(pathItem)) {
			if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
			const op = opRaw as Record<string, unknown>;
			const tags = Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string") : [];
			endpoints.push({
				method: method.toUpperCase(),
				path,
				operationId: typeof op.operationId === "string" ? op.operationId : "",
				summary: typeof op.summary === "string" ? op.summary : "",
				description: typeof op.description === "string" ? op.description : "",
				tags,
				parameters: [...pathParameters, ...(Array.isArray(op.parameters) ? op.parameters as Array<Record<string, unknown>> : [])],
				requestBody: op.requestBody as Record<string, unknown> | undefined,
				responses: op.responses as Record<string, unknown> | undefined,
				baseUrl,
			});
		}
	}
	const tags = [...new Set(endpoints.flatMap(ep => ep.tags))].sort();
	return { endpoints, tags };
}

async function fetchOpenApi(url: string, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ endpoints: OpenApiEndpoint[]; tags: string[]; cache: Record<string, unknown> }> {
	const normalized = normalizeSource(url).toString();
	// Validate the current DNS answer before any warm disk or memory lookup.
	await validateRemoteUrl(normalized, { ...remoteOptions(options), signal: requestSignal(signal) });
	const cached = await persistentOpenApiCache.get(normalized, async (sharedSignal: AbortSignal) => ({
		value: await loadOpenApiFresh(normalized, sharedSignal, options),
		freshMs: OPENAPI_CACHE_TTL_MS,
		staleMs: OPENAPI_CACHE_HARD_RETAIN_MS,
	}), { signal, freshMs: OPENAPI_CACHE_TTL_MS, staleMs: OPENAPI_CACHE_HARD_RETAIN_MS });
	return { ...cached.value, cache: cached.metadata };
}

function endpointText(ep: OpenApiEndpoint): string {
	const paramNames = ep.parameters.map(p => typeof p.name === "string" ? p.name : "").join(" ");
	return [ep.method, ep.path, ep.operationId, ep.summary, ep.description, ep.tags.join(" "), paramNames].join(" ").toLowerCase();
}

function scoreEndpoint(ep: OpenApiEndpoint, query: string): number {
	const tokens = tokenize(query);
	if (tokens.length === 0) return 1;
	const title = `${ep.operationId} ${ep.summary}`.toLowerCase();
	const all = endpointText(ep);
	let score = 0;
	if (all.includes(query.toLowerCase())) score += 25;
	for (const token of tokens) {
		if (title.includes(token)) score += 12;
		if (ep.path.toLowerCase().includes(token)) score += 8;
		if (all.includes(token)) score += 3;
	}
	return score;
}

function schemaExample(schema: Record<string, unknown> | undefined): unknown {
	if (!schema) return {};
	if (schema.example !== undefined) return schema.example;
	if (schema.type === "array") return [schemaExample(schema.items as Record<string, unknown> | undefined)];
	if (schema.type === "object" || schema.properties) {
		const props = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
		const obj: Record<string, unknown> = {};
		for (const [key, prop] of Object.entries(props).slice(0, 8)) {
			if (prop.example !== undefined) obj[key] = prop.example;
			else if (prop.type === "number" || prop.type === "integer") obj[key] = 0;
			else if (prop.type === "boolean") obj[key] = false;
			else if (prop.type === "array") obj[key] = [];
			else obj[key] = `<${key}>`;
		}
		return obj;
	}
	if (schema.type === "number" || schema.type === "integer") return 0;
	if (schema.type === "boolean") return false;
	return "value";
}

function requestBodyExample(ep: OpenApiEndpoint): unknown | null {
	const body = ep.requestBody;
	if (!body || typeof body !== "object") return null;
	const content = body.content && typeof body.content === "object" ? body.content as Record<string, Record<string, unknown>> : {};
	const json = content["application/json"];
	if (!json) return null;
	return schemaExample(json.schema as Record<string, unknown> | undefined);
}

function curlForEndpoint(ep: OpenApiEndpoint): string {
	let path = ep.path;
	for (const param of ep.parameters) {
		if (param.in === "path" && typeof param.name === "string") path = path.replace(`{${param.name}}`, `<${param.name}>`);
	}
	const queryParams = ep.parameters.filter(p => p.in === "query" && p.required === true && typeof p.name === "string");
	const query = queryParams.length ? `?${queryParams.map(p => `${p.name}=<${p.name}>`).join("&")}` : "";
	const tokenVar = /huggingface\.co/i.test(ep.baseUrl) ? "HF_TOKEN" : "TOKEN";
	let curl = `curl -X ${ep.method} '${ep.baseUrl}${path}${query}' \\\n  -H 'Authorization: Bearer $${tokenVar}'`;
	const body = requestBodyExample(ep);
	if (body && ["POST", "PUT", "PATCH"].includes(ep.method)) {
		curl += ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(body, null, 2).replace(/'/g, "'\\''")}'`;
	}
	return curl;
}

function formatParams(params: Array<Record<string, unknown>>): string {
	const rows = params.slice(0, 12).map(p => {
		const name = typeof p.name === "string" ? p.name : "?";
		const where = typeof p.in === "string" ? p.in : "param";
		const required = p.required ? " required" : " optional";
		const desc = typeof p.description === "string" ? ` — ${truncate(p.description, 140)}` : "";
		return `- \`${name}\` (${where},${required})${desc}`;
	});
	return rows.join("\n");
}

export async function executeOpenApiSearch(params: OpenApiSearchParams, signal?: AbortSignal, options?: DocsRequestOptions): Promise<ToolReturn> {
	try {
		const url = params.url?.trim() || DEFAULT_OPENAPI_URL;
		const query = params.query?.trim() || "";
		const tag = params.tag?.trim() || "";
		if (!query && !tag) throw new Error("Provide `query` and/or `tag`.");
		const maxResults = clampInt(params.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
		const { endpoints, tags, cache } = await fetchOpenApi(url, signal, options);
		const ranked = endpoints
			.filter(ep => !tag || ep.tags.includes(tag))
			.map((endpoint, index) => ({ endpoint, index, score: query ? scoreEndpoint(endpoint, query) : 1 }))
			.filter(item => !query || item.score > 0)
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, maxResults);

		const staleWarning = cache.warning ? `WARNING: stale cached OpenAPI data is shown because refresh failed (${cache.warning}).` : "";
		const lines = [`# OpenAPI search: ${url}`, query ? `Query: "${query}"` : `Tag: ${tag}`, `Indexed ${endpoints.length} endpoint(s); showing ${ranked.length}.`, staleWarning, ""].filter(Boolean);
		for (let i = 0; i < ranked.length; i++) {
			const { endpoint, score } = ranked[i];
			lines.push(`## ${i + 1}. ${endpoint.method} ${endpoint.path}`);
			if (query) lines.push(`Relevance: ${score.toFixed(1)}`);
			if (endpoint.summary) lines.push(`**Summary:** ${endpoint.summary}`);
			if (endpoint.description) lines.push(`**Description:** ${truncate(endpoint.description, 350)}`);
			if (endpoint.tags.length) lines.push(`**Tags:** ${endpoint.tags.join(", ")}`);
			const paramText = formatParams(endpoint.parameters);
			if (paramText) lines.push("**Parameters:**", paramText);
			lines.push("**Usage:**", "```bash", curlForEndpoint(endpoint), "```", "");
		}
		if (ranked.length === 0 && tags.length > 0) lines.push(`Available tags: ${tags.slice(0, 80).join(", ")}`);
		return { content: [{ type: "text", text: lines.join("\n") }], details: { url, query, tag, count: ranked.length, totalEndpoints: endpoints.length, tags, cache, results: ranked.map(({ endpoint, score }) => ({ ...endpoint, score })) } };
	} catch (err) {
		const message = errorMessage(err);
		return { content: [{ type: "text", text: `OpenAPI search failed: ${message}` }], details: { error: message } };
	}
}

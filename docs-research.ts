import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import TurndownService from "turndown";
import { readErrorSnippet, readResponseJson, readResponseText } from "./http-response.js";
import { loadSsrfAllowRanges } from "./ssrf-config.js";
import { fetchRemoteUrl, validateRemoteUrl, type Lookup } from "./ssrf-protection.ts";

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

interface CachedPage {
	expiresAt: number;
	page: DocsPage;
	bytes: number;
}

interface SharedTask<T> {
	controller: AbortController;
	promise: Promise<T>;
	waiters: number;
	settled: boolean;
}

interface DocsCacheInfo {
	hit: boolean;
	storage: "memory" | "disk" | "fresh";
	expiresAt: number;
	discovery: { hit: boolean; shared: boolean; storage: "memory" | "disk" | "fresh" };
	pages: { memoryHits: number; diskHits: number; sharedHits: number; misses: number; failures: number };
}

interface DiskDiscovery extends CachedDiscovery {
	version: number;
	kind: "discovery";
	savedAt: number;
}

interface DiskPage {
	version: number;
	kind: "page";
	savedAt: number;
	expiresAt: number;
	page: DocsPage;
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

const DOCS_CACHE_TTL_MS = 30 * 60 * 1000;
const DISCOVERY_CACHE_MAX = 30;
const DISCOVERY_CACHE_MAX_BYTES = 1024 * 1024;
const PAGE_CACHE_MAX = 200;
const PAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DOCS_CACHE_VERSION = 3;
const DOCS_DISK_CACHE_MAX_FILES = 300;
const DOCS_DISK_CACHE_MAX_BYTES = 40 * 1024 * 1024;
// Disk quotas are eventual; avoid a synchronous directory scan on every docs request.
const DOCS_DISK_PRUNE_WRITE_CADENCE = 100;
const DOCS_CACHE_DIR = process.env.PI_WEB_ACCESS_DOCS_CACHE_DIR?.trim() || join(homedir(), ".pi", "web-access", "docs-cache");
const DEFAULT_MAX_PAGES = 40;
const MAX_PAGES_CAP = 100;
const DEFAULT_MAX_RESULTS = 6;
const MAX_RESULTS_CAP = 25;
const DEFAULT_MAX_CHARS = 450;
const MAX_SNIPPET_CHARS = 1500;
const DISCOVERY_LINK_CAP = 300;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_DOCS_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_OPENAPI_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAPI_URL = "https://huggingface.co/.well-known/openapi.json";

const discoveryCache = new Map<string, CachedDiscovery>();
const pageCache = new Map<string, CachedPage>();
const inFlightDiscovery = new Map<string, SharedTask<CachedDiscovery>>();
const inFlightPages = new Map<string, SharedTask<DocsPage | null>>();
const openApiCache = new Map<string, { expiresAt: number; endpoints: OpenApiEndpoint[]; tags: string[] }>();
let discoveryCacheBytes = 0;
let pageCacheBytes = 0;
let lastDocsCachePrune = 0;
let docsDiskWritesSincePrune = 0;
let docsCachePrunePromise: Promise<void> | null = null;

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
	const source = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
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

function docsDiskCacheFile(kind: "discovery" | "page", key: string): string {
	const digest = createHash("sha256").update(`${kind}:${key}`).digest("hex");
	return join(DOCS_CACHE_DIR, `${kind}-${digest}.json`);
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
	return typeof item.title === "string" && typeof item.url === "string";
}

function isDiskDiscovery(value: unknown): value is DiskDiscovery {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return data.version === DOCS_CACHE_VERSION && data.kind === "discovery"
		&& typeof data.expiresAt === "number" && typeof data.savedAt === "number"
		&& typeof data.source === "string"
		&& (data.mode === "auto" || data.mode === "llms" || data.mode === "crawl")
		&& Array.isArray(data.links) && data.links.every(isDiscoveredDoc);
}

function isDiskPage(value: unknown): value is DiskPage {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return data.version === DOCS_CACHE_VERSION && data.kind === "page"
		&& typeof data.expiresAt === "number" && typeof data.savedAt === "number"
		&& isDocsPage(data.page);
}

function byteLength(value: unknown): number {
	try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
	catch { return 0; }
}

function pruneMemoryCaches(now = Date.now()): void {
	for (const [key, value] of discoveryCache) {
		if (value.expiresAt > now) continue;
		discoveryCache.delete(key);
		discoveryCacheBytes -= byteLength(value);
	}
	while (discoveryCache.size > DISCOVERY_CACHE_MAX || discoveryCacheBytes > DISCOVERY_CACHE_MAX_BYTES) {
		const key = discoveryCache.keys().next().value as string | undefined;
		if (!key) break;
		const value = discoveryCache.get(key);
		discoveryCache.delete(key);
		discoveryCacheBytes -= value ? byteLength(value) : 0;
	}
	for (const [key, value] of pageCache) {
		if (value.expiresAt > now) continue;
		pageCache.delete(key);
		pageCacheBytes -= value.bytes;
	}
	while (pageCache.size > PAGE_CACHE_MAX || pageCacheBytes > PAGE_CACHE_MAX_BYTES) {
		const key = pageCache.keys().next().value as string | undefined;
		if (!key) break;
		const value = pageCache.get(key);
		pageCache.delete(key);
		pageCacheBytes -= value?.bytes ?? 0;
	}
}

const OWNED_DOCS_CACHE_FILE = /^(?:discovery|page)-[a-f0-9]{64}\.json$/;
const OWNED_DOCS_TEMP_FILE = /^(?:discovery|page)-[a-f0-9]{64}\.json\.\d+\.[a-z0-9]+\.tmp$/;

async function runDocsDiskPrune(now: number): Promise<void> {
	try {
		const entries: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
		for (const file of await readdir(DOCS_CACHE_DIR)) {
			const path = join(DOCS_CACHE_DIR, file);
			if (OWNED_DOCS_TEMP_FILE.test(file)) {
				await rm(path, { force: true }).catch(() => {});
				continue;
			}
			if (!OWNED_DOCS_CACHE_FILE.test(file)) continue;
			try {
				const fileStat = await stat(path);
				if (fileStat.isFile()) entries.push({ path, bytes: fileStat.size, mtimeMs: fileStat.mtimeMs });
			} catch {
			}
		}
		entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
		let files = 0;
		let bytes = 0;
		for (const entry of entries) {
			const expired = now - entry.mtimeMs > DOCS_CACHE_TTL_MS * 2;
			if (expired || files >= DOCS_DISK_CACHE_MAX_FILES || bytes + entry.bytes > DOCS_DISK_CACHE_MAX_BYTES) {
				await rm(entry.path, { force: true }).catch(() => {});
				continue;
			}
			files++;
			bytes += entry.bytes;
		}
	} catch {
		// Cache maintenance is failure-open, including a missing cache directory.
	}
}

async function pruneDocsDiskCache(force = false): Promise<void> {
	const now = Date.now();
	if (!force && now - lastDocsCachePrune < 60 * 60 * 1000) return;
	if (docsCachePrunePromise) return docsCachePrunePromise;
	lastDocsCachePrune = now;
	docsDiskWritesSincePrune = 0;
	docsCachePrunePromise = runDocsDiskPrune(now).finally(() => { docsCachePrunePromise = null; });
	return docsCachePrunePromise;
}

async function removeDiskValue(kind: "discovery" | "page", key: string): Promise<void> {
	await rm(docsDiskCacheFile(kind, key), { force: true }).catch(() => {});
}

async function readDiskValue(kind: "discovery" | "page", key: string): Promise<unknown | null> {
	try {
		const path = docsDiskCacheFile(kind, key);
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		const expiresAt = (value as { expiresAt?: unknown })?.expiresAt;
		if (typeof expiresAt !== "number" || expiresAt <= Date.now()) {
			await rm(path, { force: true }).catch(() => {});
			return null;
		}
		const now = new Date();
		await utimes(path, now, now).catch(() => {});
		return value;
	} catch {
		return null;
	}
}

async function writeDiskValue(kind: "discovery" | "page", key: string, value: DiskDiscovery | DiskPage): Promise<void> {
	let temp: string | undefined;
	try {
		const body = JSON.stringify(value);
		if (Buffer.byteLength(body, "utf8") > MAX_DOCS_PAGE_BYTES + 64 * 1024) return;
		await mkdir(DOCS_CACHE_DIR, { recursive: true });
		const path = docsDiskCacheFile(kind, key);
		temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(temp, body, "utf8");
		await rename(temp, path);
		temp = undefined;
		docsDiskWritesSincePrune++;
		if (docsDiskWritesSincePrune >= DOCS_DISK_PRUNE_WRITE_CADENCE) await pruneDocsDiskCache(true);
	} catch {
		if (temp) await rm(temp, { force: true }).catch(() => {});
	}
}

function putDiscovery(key: string, value: CachedDiscovery): void {
	const existing = discoveryCache.get(key);
	if (existing) discoveryCacheBytes -= byteLength(existing);
	discoveryCache.delete(key);
	discoveryCache.set(key, value);
	discoveryCacheBytes += byteLength(value);
	pruneMemoryCaches();
}

function putPage(key: string, page: DocsPage, expiresAt: number): void {
	let bytes = byteLength({ expiresAt, page, bytes: 0 });
	bytes = byteLength({ expiresAt, page, bytes });
	if (bytes > PAGE_CACHE_MAX_BYTES) return;
	const existing = pageCache.get(key);
	if (existing) pageCacheBytes -= existing.bytes;
	pageCache.delete(key);
	pageCache.set(key, { expiresAt, page, bytes });
	pageCacheBytes += bytes;
	pruneMemoryCaches();
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function waitForTask<T>(task: SharedTask<T>, signal: AbortSignal | undefined, removeIfCurrent: () => void): Promise<T> {
	signal?.throwIfAborted();
	task.waiters++;
	try {
		if (!signal) return await task.promise;
		return await new Promise<T>((resolve, reject) => {
			const onAbort = () => reject(abortReason(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			task.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	} finally {
		task.waiters--;
		if (task.waiters === 0 && !task.settled) {
			removeIfCurrent();
			task.controller.abort();
		}
	}
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
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await readErrorSnippet(res, 200)}`);
	return { text: await readResponseText(res, MAX_DOCS_PAGE_BYTES), url: res.url || url, contentType: res.headers.get("content-type") || "", status: res.status };
}

function isLikelyMarkdown(url: string, contentType: string, text: string): boolean {
	if (/markdown|text\/plain/i.test(contentType)) return true;
	if (/\.(md|mdx|txt)$/i.test(new URL(url).pathname)) return true;
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
	}
	return null;
}

async function fetchDocsPage(item: { title: string; url: string }, signal?: AbortSignal, options?: DocsRequestOptions): Promise<DocsPage | null> {
	const candidates = [markdownCandidate(item.url), item.url].filter((v): v is string => !!v);
	let lastError = "";
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
			lastError = errorMessage(err);
		}
	}
	if (lastError) return null;
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
		const withSlash = new URL(source);
		withSlash.pathname += "/";
		candidates.push(withSlash.toString());
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

async function getDiscovery(source: URL, mode: DocsSearchMode, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ value: CachedDiscovery; storage: "memory" | "disk" | "fresh"; shared: boolean }> {
	await validateRemoteUrl(source, { ...remoteOptions(options), signal: requestSignal(signal) });
	pruneMemoryCaches();
	const key = discoveryKey(source, mode);
	const memory = discoveryCache.get(key);
	if (memory && memory.expiresAt > Date.now()) {
		discoveryCache.delete(key);
		discoveryCache.set(key, memory);
		return { value: memory, storage: "memory", shared: false };
	}
	const disk = await readDiskValue("discovery", key);
	if (isDiskDiscovery(disk)) {
		const value: CachedDiscovery = { expiresAt: disk.expiresAt, source: disk.source, mode: disk.mode, links: disk.links };
		putDiscovery(key, value);
		return { value, storage: "disk", shared: false };
	}
	if (disk !== null) await removeDiskValue("discovery", key);
	let task = inFlightDiscovery.get(key);
	const shared = !!task;
	if (!task) {
		const controller = new AbortController();
		task = { controller, waiters: 0, settled: false, promise: Promise.resolve(null as never) };
		const current = task;
		task.promise = discoverDocsPages(source, mode, controller.signal, options)
			.then(async links => {
				controller.signal.throwIfAborted();
				const value: CachedDiscovery = { expiresAt: Date.now() + DOCS_CACHE_TTL_MS, source: source.toString(), mode, links };
				putDiscovery(key, value);
				await writeDiskValue("discovery", key, { version: DOCS_CACHE_VERSION, kind: "discovery", savedAt: Date.now(), ...value });
				return value;
			})
			.finally(() => {
				current.settled = true;
				if (inFlightDiscovery.get(key) === current) inFlightDiscovery.delete(key);
			});
		task.promise.catch(() => {});
		inFlightDiscovery.set(key, task);
	}
	const current = task;
	return {
		value: await waitForTask(task, signal, () => {
			if (inFlightDiscovery.get(key) === current) inFlightDiscovery.delete(key);
		}),
		storage: "fresh",
		shared,
	};
}

async function getCachedPage(item: DiscoveredDoc, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ page: DocsPage | null; storage: "memory" | "disk" | "fresh" | "shared" }> {
	await validateRemoteUrl(item.url, { ...remoteOptions(options), signal: requestSignal(signal) });
	pruneMemoryCaches();
	const key = canonicalPageKey(item.url);
	if (!key) return { page: null, storage: "fresh" };
	const memory = pageCache.get(key);
	if (memory && memory.expiresAt > Date.now()) {
		pageCache.delete(key);
		pageCache.set(key, memory);
		return { page: memory.page, storage: "memory" };
	}
	const disk = await readDiskValue("page", key);
	if (isDiskPage(disk)) {
		putPage(key, disk.page, disk.expiresAt);
		return { page: disk.page, storage: "disk" };
	}
	if (disk !== null) await removeDiskValue("page", key);
	let task = inFlightPages.get(key);
	const shared = !!task;
	if (!task) {
		const controller = new AbortController();
		task = { controller, waiters: 0, settled: false, promise: Promise.resolve(null) };
		const current = task;
		task.promise = fetchLimit(() => fetchDocsPage(item, controller.signal, options))
			.then(async page => {
				controller.signal.throwIfAborted();
				if (!page) return null;
				const expiresAt = Date.now() + DOCS_CACHE_TTL_MS;
				putPage(key, page, expiresAt);
				await writeDiskValue("page", key, { version: DOCS_CACHE_VERSION, kind: "page", savedAt: Date.now(), expiresAt, page });
				return page;
			})
			.finally(() => {
				current.settled = true;
				if (inFlightPages.get(key) === current) inFlightPages.delete(key);
			});
		task.promise.catch(() => {});
		inFlightPages.set(key, task);
	}
	const current = task;
	return {
		page: await waitForTask(task, signal, () => {
			if (inFlightPages.get(key) === current) inFlightPages.delete(key);
		}),
		storage: shared ? "shared" : "fresh",
	};
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
		},
	};
}

function tokenize(value: string): string[] {
	const stop = new Set(["about", "after", "also", "and", "are", "can", "for", "from", "how", "into", "not", "that", "the", "this", "with", "your"]);
	return (value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(t => !stop.has(t));
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
		const lines = [`# Docs search: ${source.toString()}`, query ? `Query: "${query}"` : "No query provided — showing discovered pages.", `Indexed ${pages.length} page(s); showing ${ranked.length}.`, cacheSummary, ""];
		for (let i = 0; i < ranked.length; i++) {
			const { page, score } = ranked[i];
			lines.push(`## ${i + 1}. ${page.title}`);
			lines.push(page.url);
			if (page.fetchUrl !== page.url) lines.push(`Fetched as: ${page.fetchUrl}`);
			if (query) lines.push(`Relevance: ${score.toFixed(1)}`);
			lines.push(snippetForPage(page, query, maxCharacters), "");
		}
		if (ranked.length > 0) lines.push("Use `fetch_content` on a result URL for the full page, or call `docs_search` with a narrower query.");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				source: source.toString(), mode, query, pagesIndexed: pages.length, count: ranked.length,
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
		const message = errorMessage(err);
		return { content: [{ type: "text", text: `Docs search failed: ${message}` }], details: { error: message, source: params.source } };
	}
}

async function fetchOpenApi(url: string, signal?: AbortSignal, options?: DocsRequestOptions): Promise<{ endpoints: OpenApiEndpoint[]; tags: string[] }> {
	const normalized = normalizeSource(url).toString();
	await validateRemoteUrl(normalized, { ...remoteOptions(options), signal: requestSignal(signal) });
	const cached = openApiCache.get(normalized);
	if (cached && cached.expiresAt > Date.now()) return cached;
	const res = await fetchRemoteUrl(normalized, { headers: { "Accept": "application/json", "User-Agent": "pi-web-access/0.10" }, signal: requestSignal(signal) }, remoteOptions(options));
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await readErrorSnippet(res, 200)}`);
	const spec = await readResponseJson<Record<string, unknown>>(res, MAX_OPENAPI_BYTES);
	const servers = Array.isArray(spec.servers) ? spec.servers as Array<Record<string, unknown>> : [];
	const baseUrl = typeof servers[0]?.url === "string" ? servers[0].url : new URL(normalized).origin;
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
	const value = { endpoints, tags };
	openApiCache.set(normalized, { expiresAt: Date.now() + DOCS_CACHE_TTL_MS, ...value });
	return value;
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
		const { endpoints, tags } = await fetchOpenApi(url, signal, options);
		const ranked = endpoints
			.filter(ep => !tag || ep.tags.includes(tag))
			.map((endpoint, index) => ({ endpoint, index, score: query ? scoreEndpoint(endpoint, query) : 1 }))
			.filter(item => !query || item.score > 0)
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, maxResults);

		const lines = [`# OpenAPI search: ${url}`, query ? `Query: "${query}"` : `Tag: ${tag}`, `Indexed ${endpoints.length} endpoint(s); showing ${ranked.length}.`, ""];
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
		return { content: [{ type: "text", text: lines.join("\n") }], details: { url, query, tag, count: ranked.length, totalEndpoints: endpoints.length, tags, results: ranked.map(({ endpoint, score }) => ({ ...endpoint, score })) } };
	} catch (err) {
		const message = errorMessage(err);
		return { content: [{ type: "text", text: `OpenAPI search failed: ${message}` }], details: { error: message } };
	}
}

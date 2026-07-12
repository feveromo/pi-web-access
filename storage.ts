import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath, sep as pathSep } from "node:path";
import type { ExtractedContent, StoredContentRef } from "./extract.js";
import type { SearchResult } from "./search-types.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONTENT_STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_CONTENT_CHARS = 24_000;
const CONTENT_STORE_PATH = process.env.PI_WEB_ACCESS_CONTENT_DIR?.trim() || join(homedir(), ".pi", "web-access", "content");
const CONTENT_REF_VERSION = 1;
const MAX_LIVE_RESULTS = 100;
const MAX_LIVE_RESULT_BYTES = 8 * 1024 * 1024;

let lastContentPrune = 0;
let storedResultBytes = 0;

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
	metadata?: Record<string, unknown>;
}

export interface StoredSearchData {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
}

const storedResults = new Map<string, StoredSearchData>();
const storedSizes = new Map<string, number>();

function approximateStoredBytes(data: StoredSearchData): number {
	try { return Buffer.byteLength(JSON.stringify(data), "utf8"); }
	catch { return 0; }
}

function removeStoredResult(id: string): boolean {
	const deleted = storedResults.delete(id);
	storedResultBytes -= storedSizes.get(id) ?? 0;
	storedSizes.delete(id);
	return deleted;
}

function pruneStoredResults(now = Date.now()): void {
	for (const [id, data] of storedResults) {
		if (now - data.timestamp < CACHE_TTL_MS && data.timestamp <= now + 60_000) continue;
		removeStoredResult(id);
	}
	while (storedResults.size > MAX_LIVE_RESULTS || storedResultBytes > MAX_LIVE_RESULT_BYTES) {
		const oldest = storedResults.keys().next().value as string | undefined;
		if (!oldest) break;
		removeStoredResult(oldest);
	}
}

function safeId(id: string): string {
	return id.replace(/[^a-z0-9_-]/gi, "_");
}

function resultDir(id: string): string {
	return join(CONTENT_STORE_PATH, safeId(id));
}

function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function pruneContentStore(): void {
	const now = Date.now();
	if (now - lastContentPrune < 60 * 60 * 1000) return;
	lastContentPrune = now;
	if (!existsSync(CONTENT_STORE_PATH)) return;

	let dirs: string[];
	try {
		dirs = readdirSync(CONTENT_STORE_PATH);
	} catch {
		return;
	}

	for (const dir of dirs) {
		const path = join(CONTENT_STORE_PATH, dir);
		try {
			const stat = statSync(path);
			if (now - stat.mtimeMs > CONTENT_STORE_TTL_MS) {
				rmSync(path, { recursive: true, force: true });
			}
		} catch {
		}
	}
}

function previewContent(content: string): string {
	if (content.length <= MAX_SESSION_CONTENT_CHARS) return content;
	const marker = "\n\n[Full content stored outside this Pi session entry]";
	const bodyLimit = Math.max(0, MAX_SESSION_CONTENT_CHARS - marker.length);
	const slice = content.slice(0, bodyLimit);
	const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
	const preview = (breakAt > Math.floor(bodyLimit * 0.5) ? slice.slice(0, breakAt + 1) : slice).trimEnd();
	return `${preview}${marker}`;
}

function externalizeContent(id: string, index: number, item: ExtractedContent): ExtractedContent {
	if (!item.content || item.content.length <= MAX_SESSION_CONTENT_CHARS) return item;

	pruneContentStore();
	const hash = contentHash(item.content);
	const dir = resultDir(id);
	const path = join(dir, `${index}-${hash.slice(0, 12)}.md`);

	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, item.content, "utf-8");
	} catch {
		return item;
	}

	const ref: StoredContentRef = {
		version: CONTENT_REF_VERSION,
		kind: "file",
		path,
		chars: item.content.length,
		sha256: hash,
		savedAt: Date.now(),
		previewChars: Math.min(item.content.length, MAX_SESSION_CONTENT_CHARS),
	};

	return {
		...item,
		content: previewContent(item.content),
		contentRef: ref,
		originalContentLength: item.originalContentLength ?? item.content.length,
		truncated: true,
		metadata: {
			...(item.metadata ?? {}),
			sessionStorage: {
				externalized: true,
				chars: ref.chars,
				previewChars: ref.previewChars,
			},
		},
	};
}

function isValidContentRef(ref: StoredContentRef): boolean {
	return ref.version === CONTENT_REF_VERSION
		&& ref.kind === "file"
		&& typeof ref.path === "string"
		&& ref.path.length > 0
		&& typeof ref.sha256 === "string"
		&& /^[a-f0-9]{64}$/i.test(ref.sha256);
}

function isPathInContentStore(filePath: string): boolean {
	try {
		const storeRoot = existsSync(CONTENT_STORE_PATH)
			? realpathSync(CONTENT_STORE_PATH)
			: resolvePath(CONTENT_STORE_PATH);
		const candidate = realpathSync(filePath);
		if (candidate === storeRoot) return true;
		const prefix = storeRoot.endsWith(pathSep) ? storeRoot : storeRoot + pathSep;
		return candidate.startsWith(prefix);
	} catch {
		return false;
	}
}

export function hydrateStoredFetchItem(item: ExtractedContent): ExtractedContent {
	const ref = item.contentRef;
	if (!ref || !isValidContentRef(ref) || !isPathInContentStore(ref.path)) return item;

	try {
		const content = readFileSync(ref.path, "utf-8");
		if (contentHash(content) !== ref.sha256) return item;
		return { ...item, content };
	} catch {
		return item;
	}
}

export function prepareStoredDataForSession(id: string, data: StoredSearchData): StoredSearchData {
	if (data.type !== "fetch" || !data.urls) return data;
	return {
		...data,
		urls: data.urls.map((item, index) => externalizeContent(id, index, item)),
	};
}

function hydrateStoredData(data: StoredSearchData): StoredSearchData {
	if (data.type !== "fetch" || !data.urls) return data;
	return {
		...data,
		urls: data.urls.map(hydrateStoredFetchItem),
	};
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
	if (storedResults.has(id)) removeStoredResult(id);
	const bytes = approximateStoredBytes(data);
	storedResults.set(id, data);
	storedSizes.set(id, bytes);
	storedResultBytes += bytes;
	pruneStoredResults();
}

export function getStoredResult(id: string): StoredSearchData | null {
	pruneStoredResults();
	return storedResults.get(id) ?? null;
}

export function getResult(id: string): StoredSearchData | null {
	const data = getStoredResult(id);
	return data ? hydrateStoredData(data) : null;
}

export function getAllResults(): StoredSearchData[] {
	pruneStoredResults();
	return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
	if (!storedResults.has(id)) return false;
	try {
		rmSync(resultDir(id), { recursive: true, force: true });
	} catch {
		return false;
	}
	return removeStoredResult(id);
}

export function clearResults(): void {
	storedResults.clear();
	storedSizes.clear();
	storedResultBytes = 0;
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const stored = data as Record<string, unknown>;
	if (typeof stored.id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(stored.id)) return false;
	if (stored.type !== "search" && stored.type !== "fetch") return false;
	if (typeof stored.timestamp !== "number" || !Number.isFinite(stored.timestamp)) return false;
	if (stored.type === "search") {
		if (!Array.isArray(stored.queries)) return false;
		return stored.queries.every(query => {
			if (!query || typeof query !== "object") return false;
			const item = query as Record<string, unknown>;
			if (typeof item.query !== "string" || typeof item.answer !== "string" || !Array.isArray(item.results)) return false;
			if (item.error !== null && typeof item.error !== "string") return false;
			return item.results.every(result => {
				if (!result || typeof result !== "object") return false;
				const source = result as Record<string, unknown>;
				return typeof source.title === "string" && typeof source.url === "string" && typeof source.snippet === "string";
			});
		});
	}
	if (!Array.isArray(stored.urls)) return false;
	return stored.urls.every(url => {
		if (!url || typeof url !== "object") return false;
		const item = url as Record<string, unknown>;
		return typeof item.url === "string"
			&& typeof item.title === "string"
			&& typeof item.content === "string"
			&& (item.error === null || typeof item.error === "string");
	});
}

export function restoreFromSession(ctx: ExtensionContext): void {
	clearResults();
	const now = Date.now();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "web-search-results") {
			const data = entry.data;
			if (isValidStoredData(data) && data.timestamp <= now + 60_000 && now - data.timestamp < CACHE_TTL_MS) {
				storeResult(data.id, data);
			}
		}
	}
}

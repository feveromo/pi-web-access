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
const CONTENT_STORE_PATH = join(homedir(), ".pi", "web-access", "content");
const CONTENT_REF_VERSION = 1;

let lastContentPrune = 0;

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

function hydrateContent(item: ExtractedContent): ExtractedContent {
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
		urls: data.urls.map(hydrateContent),
	};
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
	storedResults.set(id, data);
}

export function getResult(id: string): StoredSearchData | null {
	const data = storedResults.get(id);
	return data ? hydrateStoredData(data) : null;
}

export function getAllResults(): StoredSearchData[] {
	return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
	return storedResults.delete(id);
}

export function clearResults(): void {
	storedResults.clear();
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id) return false;
	if (d.type !== "search" && d.type !== "fetch") return false;
	if (typeof d.timestamp !== "number") return false;
	if (d.type === "search" && !Array.isArray(d.queries)) return false;
	if (d.type === "fetch" && !Array.isArray(d.urls)) return false;
	return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
	storedResults.clear();
	const now = Date.now();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "web-search-results") {
			const data = entry.data;
			if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
				storedResults.set(data.id, data);
			}
		}
	}
}

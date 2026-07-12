import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { ExtractedContent, StoredContentRef } from "./extract.js";
import type { SearchResult } from "./search-types.js";
import { createPersistentCache } from "./persistent-cache.js";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTENT_STORE_TTL_MS = CACHE_TTL_MS;
const MAX_SESSION_CONTENT_CHARS = 24_000;
const CONTENT_STORE_PATH = resolvePath(process.env.PI_WEB_ACCESS_CONTENT_DIR?.trim() || join(homedir(), ".pi", "web-access", "content"));
const CONTENT_REF_VERSION = 1;
const MAX_LIVE_RESULTS = 100;
const MAX_LIVE_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_FILES = 1000;
const MAX_CONTENT_BYTES = 192 * 1024 * 1024;

let storedResultBytes = 0;
const pendingPersistence = new Set<Promise<unknown>>();

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
const persistentResults = createPersistentCache({
	namespace: "response", freshMs: CACHE_TTL_MS, staleMs: CACHE_TTL_MS,
	maxEntries: 500, maxBytes: 64 * 1024 * 1024, maxValueBytes: 8 * 1024 * 1024,
	validate: isValidStoredData,
});

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

async function readRegularNoFollow(path: string): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try { const info = await handle.stat(); if (!info.isFile()) throw new Error("Not a regular file"); return await handle.readFile("utf8"); }
	finally { await handle.close(); }
}

async function safeContentRoot(create = false): Promise<boolean> {
	try {
		if (create) {
			let ancestor = CONTENT_STORE_PATH;
			while (true) {
				try { await lstat(ancestor); break; } catch {
					const parent = dirname(ancestor);
					if (parent === ancestor) return false;
					ancestor = parent;
				}
			}
			const ancestorStat = await lstat(ancestor);
			if (ancestorStat.isSymbolicLink() || await realpath(ancestor) !== resolvePath(ancestor)) return false;
			await mkdir(CONTENT_STORE_PATH, { recursive: true, mode: 0o700 });
		}
		const rootStat = await lstat(CONTENT_STORE_PATH);
		return rootStat.isDirectory() && !rootStat.isSymbolicLink() && await realpath(CONTENT_STORE_PATH) === CONTENT_STORE_PATH;
	} catch { return false; }
}

async function safeResultDirectory(id: string, create = false): Promise<boolean> {
	if (!/^[a-z0-9_-]{1,128}$/i.test(id) || !await safeContentRoot(create)) return false;
	const dir = resultDir(id);
	try {
		if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
		const info = await lstat(dir);
		return info.isDirectory() && !info.isSymbolicLink() && await realpath(dir) === dir;
	} catch { return false; }
}

async function pruneContentStore(protectedPaths = new Set<string>(), now = Date.now()): Promise<void> {
	if (!await safeContentRoot(false)) return;
	const entries: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
	for (const dir of await readdir(CONTENT_STORE_PATH).catch(() => [])) {
		if (!/^[a-z0-9_-]{1,128}$/i.test(dir) || !await safeResultDirectory(dir, false)) continue;
		const dirPath = join(CONTENT_STORE_PATH, dir);
		for (const file of await readdir(dirPath).catch(() => [])) {
			if (!/^\d+-[a-f0-9]{12}\.md$/.test(file)) continue;
			const path = join(dirPath, file);
			try { const info = await lstat(path); if (info.isFile() && !info.isSymbolicLink()) entries.push({ path, bytes: info.size, mtimeMs: info.mtimeMs }); } catch {}
		}
	}
	entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
	let count = entries.length;
	let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	for (const entry of entries) {
		if (protectedPaths.has(entry.path)) continue;
		if (now - entry.mtimeMs <= CONTENT_STORE_TTL_MS && count <= MAX_CONTENT_FILES && bytes <= MAX_CONTENT_BYTES) continue;
		try { await rm(entry.path, { force: true }); count--; bytes -= entry.bytes; } catch {}
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

function isValidContentRef(ref: StoredContentRef): boolean {
	return ref.version === CONTENT_REF_VERSION && ref.kind === "file" && typeof ref.path === "string" && ref.path.length > 0
		&& typeof ref.sha256 === "string" && /^[a-f0-9]{64}$/i.test(ref.sha256);
}

async function isSafeContentFile(id: string, filePath: string): Promise<boolean> {
	if (!await safeResultDirectory(id, false)) return false;
	const name = filePath.split("/").pop() ?? "";
	if (!/^\d+-[a-f0-9]{12}\.md$/.test(name) || resolvePath(filePath) !== join(resultDir(id), name)) return false;
	try { const info = await lstat(filePath); return info.isFile() && !info.isSymbolicLink() && await realpath(filePath) === resolvePath(filePath); } catch { return false; }
}

export async function hydrateStoredFetchItem(item: ExtractedContent): Promise<ExtractedContent> {
	const ref = item.contentRef;
	const id = ref?.path ? resolvePath(ref.path).split("/").at(-2) ?? "" : "";
	if (!ref || !isValidContentRef(ref) || !await isSafeContentFile(id, ref.path)) return item;
	try { const content = await readRegularNoFollow(ref.path); return contentHash(content) === ref.sha256 ? { ...item, content } : item; } catch { return item; }
}

export async function prepareStoredDataForSession(id: string, data: StoredSearchData): Promise<StoredSearchData> {
	if (data.type !== "fetch" || !data.urls || !await safeResultDirectory(id, true)) return data;
	const protectedPaths = new Set<string>();
	const urls: ExtractedContent[] = [];
	for (let index = 0; index < data.urls.length; index++) {
		const item = data.urls[index];
		if (!item.content || item.content.length <= MAX_SESSION_CONTENT_CHARS) { urls.push(item); continue; }
		const hash = contentHash(item.content);
		const path = join(resultDir(id), `${index}-${hash.slice(0, 12)}.md`);
		try {
			const existing = await lstat(path).catch(() => null);
			if (existing) {
				if (existing.isSymbolicLink() || !existing.isFile() || await realpath(path) !== path || contentHash(await readRegularNoFollow(path)) !== hash) { urls.push(item); continue; }
			} else {
				await writeFile(path, item.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			}
			protectedPaths.add(path);
			const ref: StoredContentRef = { version: CONTENT_REF_VERSION, kind: "file", path, chars: item.content.length, sha256: hash, savedAt: Date.now(), previewChars: Math.min(item.content.length, MAX_SESSION_CONTENT_CHARS) };
			urls.push({ ...item, content: previewContent(item.content), contentRef: ref, originalContentLength: item.originalContentLength ?? item.content.length, truncated: true,
				metadata: { ...(item.metadata ?? {}), sessionStorage: { externalized: true, chars: ref.chars, previewChars: ref.previewChars } } });
		} catch { urls.push(item); }
	}
	await pruneContentStore(protectedPaths);
	return { ...data, urls };
}

async function hydrateStoredData(data: StoredSearchData): Promise<StoredSearchData> {
	if (data.type !== "fetch" || !data.urls) return data;
	return { ...data, urls: await Promise.all(data.urls.map(hydrateStoredFetchItem)) };
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
	if (id !== data.id || !/^[a-z0-9_-]{1,128}$/i.test(id)) return;
	if (storedResults.has(id)) removeStoredResult(id);
	const bytes = approximateStoredBytes(data);
	storedResults.set(id, data);
	storedSizes.set(id, bytes);
	storedResultBytes += bytes;
	pruneStoredResults();
	const now = Date.now();
	if (data.timestamp > now + 60_000 || now - data.timestamp >= CACHE_TTL_MS) return;
	const pending = persistentResults.set(id, data, { now: data.timestamp, freshMs: CACHE_TTL_MS, staleMs: CACHE_TTL_MS });
	pendingPersistence.add(pending);
	void pending.finally(() => pendingPersistence.delete(pending));
}

export async function flushStoragePersistence(): Promise<void> {
	await Promise.allSettled([...pendingPersistence]);
}

export async function getStoredResult(id: string): Promise<StoredSearchData | null> {
	pruneStoredResults();
	const live = storedResults.get(id);
	if (live) return live;
	if (!/^[a-z0-9_-]{1,128}$/i.test(id)) return null;
	const cached = await persistentResults.lookup(id);
	if (cached.state === "miss" || !cached.value) return null;
	const data = cached.value as StoredSearchData;
	if (data.id !== id) return null;
	const bytes = approximateStoredBytes(data);
	storedResults.set(id, data);
	storedSizes.set(id, bytes);
	storedResultBytes += bytes;
	pruneStoredResults();
	return storedResults.get(id) ?? null;
}

export async function getResult(id: string): Promise<StoredSearchData | null> {
	const data = await getStoredResult(id);
	return data ? await hydrateStoredData(data) : null;
}

export function getAllResults(): StoredSearchData[] {
	pruneStoredResults();
	return Array.from(storedResults.values());
}

export async function deleteResult(id: string): Promise<boolean> {
	const data = storedResults.get(id) ?? await getStoredResult(id);
	if (!data) return false;
	if (data.type === "fetch" && await safeResultDirectory(id, false)) {
		for (const item of data.urls ?? []) {
			const ref = item.contentRef;
			if (!ref || !isValidContentRef(ref) || !await isSafeContentFile(id, ref.path)) continue;
			try { await rm(ref.path, { force: true }); } catch {}
		}
		try { await rmdir(resultDir(id)); } catch {}
	}
	removeStoredResult(id);
	await flushStoragePersistence();
	await persistentResults.delete(id);
	return true;
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

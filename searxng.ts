// Keyless local web search via a self-hosted SearXNG JSON API.
// The extension can use an already-running SEARXNG_URL and, for the default
// local endpoint, attempts the configurable SEARXNG_START_HELPER when needed.
import { spawn } from "node:child_process";
import { isAbortError, readErrorSnippet, readResponseJson, requestSignal } from "./http-response.js";
import { sanitizeSearchText } from "./search-output.js";
import type { SearchResult } from "./search-types.js";
import { createPersistentCache } from "./persistent-cache.js";

const HOST = "127.0.0.1";
const rawPort = Number(process.env.SEARXNG_PORT ?? "8888");
const PORT = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8888;
const CONFIGURED_URL = process.env.SEARXNG_URL?.trim() || "";
const CONFIGURED_START_HELPER = process.env.SEARXNG_START_HELPER?.trim() || "";
const BASE = normalizeBaseUrl(CONFIGURED_URL || `http://${HOST}:${PORT}`);
const START_HELPER = CONFIGURED_START_HELPER || "start-web-search";
const BROWSER_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEALTH_TIMEOUT_MS = 2500;
const HEALTH_TTL_MS = 15_000;
const START_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_FRESH_MS = { day: 10 * 60 * 1000, week: 60 * 60 * 1000, month: 6 * 60 * 60 * 1000, year: DAY_MS } as const;
const SEARCH_HARD_RETAIN_MS = 7 * DAY_MS;
const MAX_SEARCH_CACHE_ENTRIES = 500;

export interface SearxngSearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

export interface SearxngSearchResponse {
	answer: string;
	results: SearchResult[];
	metadata?: Record<string, unknown>;
}

interface SharedTask<T> {
	controller: AbortController;
	promise: Promise<T>;
	waiters: number;
}

interface SearxngRawResult {
	url?: string;
	title?: string;
	content?: string;
	engines?: string[];
	engine?: string;
	publishedDate?: string;
}

function isSearchResponse(value: unknown): value is SearxngSearchResponse {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.answer === "string" && Array.isArray(item.results) && item.results.length <= 20
		&& item.results.every(result => !!result && typeof result === "object"
			&& typeof (result as Record<string, unknown>).title === "string"
			&& typeof (result as Record<string, unknown>).url === "string"
			&& typeof (result as Record<string, unknown>).snippet === "string");
}

const searchCache = createPersistentCache({
	namespace: "web-search",
	freshMs: DAY_MS,
	staleMs: SEARCH_HARD_RETAIN_MS,
	maxEntries: MAX_SEARCH_CACHE_ENTRIES,
	maxBytes: 32 * 1024 * 1024,
	maxValueBytes: 2 * 1024 * 1024,
	validate: isSearchResponse,
});
let readinessTask: SharedTask<void> | null = null;
let healthyUntil = 0;

function normalizeBaseUrl(value: string): string {
	const parsed = new URL(value);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`SEARXNG_URL must use http or https, got ${parsed.protocol}`);
	}
	return parsed.toString().replace(/\/+$/, "");
}

function normalizeNumResults(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.min(20, Math.max(1, Math.floor(value)));
}

function normalizeDomainFilter(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) return [];
	const domains: string[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		const excluded = trimmed.startsWith("-");
		let candidate = (excluded ? trimmed.slice(1) : trimmed).trim().toLowerCase();
		if (!candidate) continue;
		try {
			const parsed = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
			candidate = parsed.hostname.toLowerCase().replace(/\.$/, "");
		} catch {
			continue;
		}
		if (!candidate || !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate)) continue;
		const domain = `${excluded ? "-" : ""}${candidate}`;
		if (seen.has(domain)) continue;
		seen.add(domain);
		domains.push(domain);
		if (domains.length >= 20) break;
	}
	return domains;
}

function buildQuery(rawQuery: string, domainFilter?: string[]): string {
	const domains = normalizeDomainFilter(domainFilter);
	const included = domains.filter(domain => !domain.startsWith("-")).map(domain => `site:${domain}`);
	const excluded = domains.filter(domain => domain.startsWith("-")).map(domain => `-site:${domain.slice(1)}`);
	const includeTerm = included.length > 1 ? `(${included.join(" OR ")})` : included[0];
	return [rawQuery.trim(), includeTerm, ...excluded].filter(Boolean).join(" ");
}

export function webSearchFreshnessMs(recencyFilter: SearxngSearchOptions["recencyFilter"]): number {
	return recencyFilter ? SEARCH_FRESH_MS[recencyFilter] : DAY_MS;
}

function searchCacheKey(query: string, opts: SearxngSearchOptions): string {
	return JSON.stringify({
		baseUrl: BASE,
		query: query.trim().replace(/\s+/g, " ").toLowerCase(),
		numResults: normalizeNumResults(opts.numResults),
		recencyFilter: opts.recencyFilter,
		domainFilter: normalizeDomainFilter(opts.domainFilter).sort(),
	});
}

function cloneResponse(response: SearxngSearchResponse, cache?: Record<string, unknown>): SearxngSearchResponse {
	return {
		...response,
		results: response.results.map(result => ({ ...result })),
		metadata: response.metadata || cache
			? { ...(response.metadata ?? {}), ...(cache ? { cacheHit: cache.status !== "miss", cache } : {}) }
			: undefined,
	};
}

async function waitForTask<T>(task: SharedTask<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	task.waiters++;
	try {
		return await abortable(task.promise, signal);
	} finally {
		task.waiters--;
		if (task.waiters === 0) task.controller.abort();
	}
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function isUp(signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted();
	try {
		const response = await fetch(`${BASE}/`, {
			method: "GET",
			signal: requestSignal(signal, HEALTH_TIMEOUT_MS),
			headers: { "User-Agent": BROWSER_UA },
		});
		await response.body?.cancel().catch(() => {});
		return response.ok;
	} catch (err) {
		if (signal?.aborted) throw signal.reason ?? err;
		return false;
	}
}

function startLocalSearxng(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		let settled = false;
		let stderr = "";
		let terminationError: Error | null = null;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const detached = process.platform !== "win32";
		const child = spawn(START_HELPER, [], {
			stdio: ["ignore", "ignore", "pipe"],
			detached,
		});
		const killChild = (killSignal: NodeJS.Signals) => {
			try {
				if (detached && child.pid) process.kill(-child.pid, killSignal);
				else child.kill(killSignal);
			} catch {
			}
		};
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(startTimer);
			if (forceTimer) clearTimeout(forceTimer);
			if (settleTimer) clearTimeout(settleTimer);
			signal.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve();
		};
		const terminate = (err: Error) => {
			if (terminationError || settled) return;
			terminationError = err;
			killChild("SIGTERM");
			forceTimer = setTimeout(() => killChild("SIGKILL"), 1000);
			settleTimer = setTimeout(() => finish(err), 2500);
		};
		const onAbort = () => terminate(
			signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
		);
		const startTimer = setTimeout(() => {
			terminate(new Error(`SearXNG start helper timed out after ${START_TIMEOUT_MS / 1000}s`));
		}, START_TIMEOUT_MS);
		signal.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", chunk => {
			if (stderr.length < 4000) stderr += String(chunk).slice(0, 4000 - stderr.length);
		});
		child.once("error", err => {
			const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
			finish(new Error(missing
				? `SearXNG is unavailable at ${BASE}, and start helper "${START_HELPER}" was not found. Start SearXNG yourself or set SEARXNG_URL/SEARXNG_START_HELPER.`
				: `Failed to run SearXNG start helper: ${err.message}`));
		});
		child.once("exit", (code, childSignal) => {
			if (terminationError) {
				finish(terminationError);
			} else if (code === 0) {
				finish();
			} else {
				const detail = stderr.trim() ? `: ${stderr.trim().replace(/\s+/g, " ").slice(0, 500)}` : "";
				finish(new Error(`SearXNG start helper exited with ${code ?? childSignal ?? "unknown status"}${detail}`));
			}
		});
	});
}

async function establishReadiness(signal: AbortSignal): Promise<void> {
	if (await isUp(signal)) {
		healthyUntil = Date.now() + HEALTH_TTL_MS;
		return;
	}
	signal.throwIfAborted();
	if (CONFIGURED_URL && !CONFIGURED_START_HELPER) {
		throw new Error(`Configured SearXNG endpoint ${BASE} is unavailable. Start it or set SEARXNG_START_HELPER.`);
	}
	await startLocalSearxng(signal);
	if (!(await isUp(signal))) {
		throw new Error(`SearXNG did not respond at ${BASE} after the start helper completed.`);
	}
	healthyUntil = Date.now() + HEALTH_TTL_MS;
}

/** Ensure SearXNG is reachable. Concurrent callers share one cancellable startup task. */
export async function ensureSearxngRunning(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (healthyUntil > Date.now()) return;
	if (!readinessTask) {
		const controller = new AbortController();
		const task = { controller, waiters: 0, promise: Promise.resolve() } as SharedTask<void>;
		task.promise = establishReadiness(controller.signal).finally(() => {
			if (readinessTask === task) readinessTask = null;
		});
		task.promise.catch(() => {});
		readinessTask = task;
	}
	await waitForTask(readinessTask, signal);
}

function resultKey(rawUrl: string): string | null {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		parsed.hash = "";
		for (const key of [...parsed.searchParams.keys()]) {
			if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) parsed.searchParams.delete(key);
		}
		if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		return parsed.toString();
	} catch {
		return null;
	}
}

function dedupeAndLimit(results: SearchResult[], limit: number): SearchResult[] {
	const seen = new Set<string>();
	const output: SearchResult[] = [];
	for (const result of results) {
		const key = resultKey(result.url);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		output.push(result);
		if (output.length >= limit) break;
	}
	return output;
}

async function performSearch(query: string, opts: SearxngSearchOptions, signal: AbortSignal): Promise<SearxngSearchResponse> {
	await ensureSearxngRunning(signal);
	const fullQuery = buildQuery(query, opts.domainFilter);
	const numResults = normalizeNumResults(opts.numResults);
	const params = new URLSearchParams({ q: fullQuery, format: "json", safesearch: "0" });
	if (opts.recencyFilter) {
		params.set("time_range", opts.recencyFilter);
		params.set("categories", "general,news");
	}

	const started = Date.now();
	let response: Response;
	try {
		response = await fetch(`${BASE}/search?${params.toString()}`, {
			method: "GET",
			signal: requestSignal(signal, SEARCH_TIMEOUT_MS),
			headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
		});
	} catch (err) {
		healthyUntil = 0;
		throw err;
	}
	if (!response.ok) {
		const body = await readErrorSnippet(response, 200);
		const error = new Error(`SearXNG search failed: HTTP ${response.status}${body ? ` ${body}` : ""}`) as Error & { status: number };
		error.status = response.status;
		throw error;
	}
	const data = await readResponseJson<{ results?: SearxngRawResult[]; unresponsive_engines?: unknown[] }>(response, MAX_RESPONSE_BYTES);
	if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
		throw new Error("SearXNG returned malformed JSON: missing results array");
	}
	healthyUntil = Date.now() + HEALTH_TTL_MS;

	const engineSet = new Set<string>();
	const results: SearchResult[] = [];
	for (const raw of data.results) {
		if (!raw || typeof raw.url !== "string" || typeof raw.title !== "string") continue;
		if (!resultKey(raw.url)) continue;
		for (const engine of raw.engines ?? (typeof raw.engine === "string" ? [raw.engine] : [])) {
			if (typeof engine === "string" && engine) engineSet.add(engine);
		}
		results.push({
			title: sanitizeSearchText(raw.title),
			url: raw.url.trim(),
			snippet: sanitizeSearchText(typeof raw.content === "string" ? raw.content : ""),
			...(typeof raw.publishedDate === "string" && raw.publishedDate.trim() ? { publishedDate: raw.publishedDate.trim() } : {}),
		});
	}
	const pool = opts.recencyFilter
		? [...results].sort((a, b) => Number(!a.publishedDate) - Number(!b.publishedDate))
		: results;
	return {
		answer: "",
		results: dedupeAndLimit(pool, numResults),
		metadata: {
			provider: "searxng",
			engines: [...engineSet].sort(),
			tookMs: Date.now() - started,
			fullQuery,
			unresponsiveEngines: Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.length : 0,
		},
	};
}

export async function searxngSearch(query: string, opts: SearxngSearchOptions = {}): Promise<SearxngSearchResponse> {
	const normalizedQuery = typeof query === "string" ? query.trim() : "";
	if (!normalizedQuery) throw new Error("No SearXNG query provided");
	opts.signal?.throwIfAborted();
	const key = searchCacheKey(normalizedQuery, opts);
	const freshMs = webSearchFreshnessMs(opts.recencyFilter);
	const cached = await searchCache.get(key, signal => performSearch(normalizedQuery, opts, signal), {
		signal: opts.signal,
		freshMs,
		staleMs: SEARCH_HARD_RETAIN_MS,
	});
	return cloneResponse(cached.value, cached.metadata);
}

async function main() {
	const query = process.argv[2] ?? "rust async runtime";
	console.log(`searxng self-check: "${query}"`);
	try {
		const response = await searxngSearch(query, { numResults: 5 });
		console.log(`results: ${response.results.length}`);
		console.log(`engines: ${(response.metadata?.engines as string[])?.join(", ") ?? "?"} (${response.metadata?.tookMs}ms)`);
		for (const result of response.results) {
			console.log(`  - ${result.title.slice(0, 64)}`);
			console.log(`    ${result.url}`);
		}
		assert(response.results.length > 0, "search must return at least one result");
		assert(response.results.every(result => /^https?:\/\//.test(result.url)), "all results must use HTTP(S)");
		console.log("OK");
	} catch (err) {
		if (isAbortError(err)) throw err;
		console.error(err);
		process.exitCode = 1;
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	void main();
}

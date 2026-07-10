// ponytail: keyless local web search via a self-hosted SearXNG instance.
// Hits the JSON API on 127.0.0.1:8888 (see start-web-search / stop-web-search).
// Auto-starts the instance on first use; one HTTP call per query. The power
// (Google/Bing/DDG/70+ engines, maintained by the SearXNG project) lives in the
// running instance, not this file.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchResult } from "./search-types.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SEARXNG_PORT ?? "8888");
const BASE = `http://${HOST}:${PORT}`;
const BROWSER_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const START_HELPER = join(homedir(), ".local", "bin", "start-web-search");

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

let startPromise: Promise<void> | null = null;

async function isUp(signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/`, {
			method: "GET",
			signal,
			headers: { "User-Agent": BROWSER_UA },
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Ensure the local SearXNG instance is reachable; start it if not. Idempotent + dedup'd. */
export async function ensureSearxngRunning(signal?: AbortSignal): Promise<void> {
	if (await isUp(signal)) return;
	if (!startPromise) {
		startPromise = (async () => {
			await new Promise<void>((resolve, reject) => {
				const child = spawn(START_HELPER, [], {
					stdio: ["ignore", "inherit", "inherit"],
					detached: false,
				});
				child.on("exit", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`start-web-search exited with code ${code}`));
				});
				child.on("error", reject);
			});
			// start-web-search blocks until its own readiness curl succeeds, so one
			// confirm here is enough; no separate poll loop needed.
			if (!(await isUp(signal))) {
				throw new Error(
					"SearXNG did not respond after start-web-search. Run it manually or check ~/.local/share/searxng/run.log.",
			);
			}
		})().finally(() => {
			startPromise = null;
		});
	}
	await startPromise;
}

function buildQuery(rawQuery: string, domainFilter?: string[]): string {
	let q = rawQuery.trim();
	if (domainFilter && domainFilter.length > 0) {
		const terms = domainFilter
			.map((d) => d.trim())
			.filter(Boolean)
			.map((d) => {
				if (d.startsWith("-")) return `-site:${d.slice(1)}`;
				return `site:${d}`;
			});
		if (terms.length > 0) q = `${q} ${terms.join(" ")}`.trim();
	}
	return q;
}

interface SearxngRawResult {
	url?: string;
	title?: string;
	content?: string;
	engines?: string[];
	engine?: string;
	publishedDate?: string;
}

function dedupAndLimit(results: SearchResult[], limit: number): SearchResult[] {
	const seen = new Set<string>();
	const out: SearchResult[] = [];
	for (const r of results) {
		const key = r.url.replace(/\/+$/, "").toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(r);
		if (out.length >= limit) break;
	}
	return out;
}

export async function searxngSearch(
	query: string,
	opts: SearxngSearchOptions = {},
): Promise<SearxngSearchResponse> {
	await ensureSearxngRunning(opts.signal);
	const fullQuery = buildQuery(query, opts.domainFilter);
	const numResults = Math.min(Math.max(opts.numResults ?? 5, 1), 20);

	const params = new URLSearchParams({
		q: fullQuery,
		format: "json",
		safesearch: "0",
	});
	if (opts.recencyFilter) {
		// Recency = the user wants fresh results, so also pull SearXNG's news
		// engines alongside general. News engines (duckduckgo/startpage/reuters)
		// are the only sources that reliably return publishedDate for display.
		params.set("time_range", opts.recencyFilter);
		params.set("categories", "general,news");
	}

	const started = Date.now();
	const res = await fetch(`${BASE}/search?${params.toString()}`, {
		method: "GET",
		signal: opts.signal,
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`SearXNG search failed: HTTP ${res.status} ${body.slice(0, 200)}`);
	}
	const data = (await res.json()) as { results?: SearxngRawResult[]; unresponsive_engines?: unknown[] };
	const took = Date.now() - started;

	const engineSet = new Set<string>();
	const results: SearchResult[] = (data.results ?? [])
		.filter((r) => r && r.url && r.title)
		.map((r) => {
			for (const e of r.engines ?? (r.engine ? [r.engine] : [])) engineSet.add(e);
			return {
				title: r.title!.trim(),
				url: r.url!,
				snippet: (r.content ?? "").trim(),
				...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
			};
		});

	// When the user filtered by recency, time matters: stable-sort so dated
	// results survive the limit (SearXNG otherwise ranks undated general/news
	// items above the dated ones, cutting them off before display).
	const pool = opts.recencyFilter
		? [...results].sort((a, b) => (a.publishedDate ? 0 : 1) - (b.publishedDate ? 0 : 1))
		: results;

	return {
		answer: "",
		results: dedupAndLimit(pool, numResults),
		metadata: {
			provider: "searxng",
			engines: Array.from(engineSet).sort(),
			tookMs: took,
			fullQuery,
			unresponsiveEngines: Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.length : 0,
		},
	};
}

// --- self-check: node --experimental-vm-modules n/a; run directly ---
// ponytail: one runnable check that fails if the parser/instance breaks.
// Skips gracefully if SearXNG is down OR all engines are upstream-rate-limited
// (e.g. after a big research run / stress test), so syntax checks don't false-fail.
async function main() {
	const q = process.argv[2] ?? "rust async runtime";
	console.log(`searxng self-check: "${q}"`);
	try {
		await ensureSearxngRunning();
	} catch (e) {
		console.log(`SKIP (instance not running): ${(e as Error).message}`);
		return;
	}
	const r = await searxngSearch(q, { numResults: 5 });
	console.log(`results: ${r.results.length}`);
	console.log(`engines: ${(r.metadata?.engines as string[])?.join(", ") ?? "?"} (${r.metadata?.tookMs}ms)`);
	for (const s of r.results) {
		console.log(`  - ${s.title.slice(0, 64)}`);
		console.log(`    ${s.url}`);
	}
	// synthetic parser invariant (does not depend on live results)
	assert(dedupAndLimit([{ title: "a", url: "http://x.com/", snippet: "" }, { title: "b", url: "http://x.com", snippet: "" }], 5).length === 1, "dedup must collapse trailing-slash variants");
	if (r.results.length === 0) {
		// 0 results with engines unresponsive = upstream rate-limit/ban from bulk use
		// (stress tests, large research runs). Instance + plumbing are fine; skip.
		const unresponsive = (r.metadata?.unresponsiveEngines as number) ?? 0;
		if (unresponsive > 0) {
			console.log(`SKIP: 0 results, ${unresponsive} engine(s) unresponsive (upstream rate-limited). HTTP + parser OK.`);
			return;
		}
		console.error("FAIL: 0 results and no engine reported unresponsive — possible parser breakage");
		process.exit(1);
	}
	assert(r.results.every((s) => s.url.startsWith("http")), "all results must have absolute URLs");
	console.log("OK");
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		console.error(`ASSERT FAIL: ${msg}`);
		process.exit(1);
	}
}

// Run self-check when executed directly (not when imported).
// node treats this as ESM ("type": "module"); import.meta.url is defined.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}

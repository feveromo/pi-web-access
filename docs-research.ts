import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import TurndownService from "turndown";

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

interface CachedDocs {
	expiresAt: number;
	pages: DocsPage[];
	source: string;
	mode: DocsSearchMode;
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
const DOCS_CACHE_MAX = 30;
const DEFAULT_MAX_PAGES = 40;
const MAX_PAGES_CAP = 100;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 25;
const DEFAULT_MAX_CHARS = 700;
const DISCOVERY_LINK_CAP = 300;
const REQUEST_TIMEOUT_MS = 25000;
const DEFAULT_OPENAPI_URL = "https://huggingface.co/.well-known/openapi.json";

const docsCache = new Map<string, CachedDocs>();
const openApiCache = new Map<string, { expiresAt: number; endpoints: OpenApiEndpoint[]; tags: string[] }>();

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
	return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
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

async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; url: string; contentType: string; status: number }> {
	const res = await fetch(url, {
		headers: {
			"Accept": "text/markdown,text/plain,text/html,application/json,*/*",
			"User-Agent": "pi-web-access/0.10",
		},
		signal: requestSignal(signal),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return { text: await res.text(), url: res.url || url, contentType: res.headers.get("content-type") || "", status: res.status };
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

function htmlLinks(html: string, base: URL): Array<{ title: string; url: string }> {
	const { document } = parseHTML(html);
	const links: Array<{ title: string; url: string }> = [];
	const seen = new Set<string>();
	const basePath = base.pathname.endsWith("/") ? base.pathname : base.pathname.replace(/\/[^/]*$/, "/");
	for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
		const href = anchor.getAttribute("href") || "";
		try {
			const resolved = new URL(href, base);
			if (resolved.origin !== base.origin) continue;
			if (!resolved.pathname.startsWith(basePath) && !resolved.pathname.startsWith(`${basePath.replace(/\/$/, "")}/`)) continue;
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

async function tryLlmsTxt(source: URL, signal?: AbortSignal): Promise<{ root: URL; text: string } | null> {
	const candidates: URL[] = [];
	if (/\/llms(?:-full)?\.txt$/i.test(source.pathname)) candidates.push(source);
	else candidates.push(new URL("/llms.txt", source.origin), new URL(`${source.pathname.replace(/\/$/, "")}/llms.txt`, source));
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate.toString())) continue;
		seen.add(candidate.toString());
		try {
			const fetched = await fetchText(candidate.toString(), signal);
			if (fetched.text.length > 20 && markdownLinks(fetched.text, candidate).length > 0) {
				return { root: candidate, text: fetched.text };
			}
		} catch {
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

async function fetchDocsPage(item: { title: string; url: string }, signal?: AbortSignal): Promise<DocsPage | null> {
	const candidates = [markdownCandidate(item.url), item.url].filter((v): v is string => !!v);
	let lastError = "";
	for (const candidate of candidates) {
		try {
			const fetched = await fetchText(candidate, signal);
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

async function discoverDocsPages(source: URL, mode: DocsSearchMode, maxPages: number, signal?: AbortSignal, query?: string): Promise<Array<{ title: string; url: string }>> {
	const discovered: Array<{ title: string; url: string }> = [];
	const add = (item: { title: string; url: string }) => {
		if (discovered.length >= DISCOVERY_LINK_CAP) return;
		if (discovered.some(existing => existing.url === item.url)) return;
		discovered.push(item);
	};

	if (mode !== "crawl") {
		const llms = await tryLlmsTxt(source, signal);
		if (llms) {
			add({ title: "llms.txt", url: llms.root.toString() });
			for (const link of markdownLinks(llms.text, llms.root)) add(link);
			return selectDiscoveredLinks(discovered, query, maxPages);
		}
		if (mode === "llms") return selectDiscoveredLinks(discovered, query, maxPages);
	}

	const root = await fetchText(source.toString(), signal);
	add({ title: titleFromUrl(source.toString()), url: source.toString() });
	for (const link of htmlLinks(root.text, source)) add(link);
	return selectDiscoveredLinks(discovered, query, maxPages);
}

function cacheKeyForDocs(source: URL, mode: DocsSearchMode, maxPages: number, query: string | undefined): string {
	// Discovery is query-biased before fetching pages, so cache entries must not
	// be reused across different queries for the same docs root/maxPages.
	return `${source.toString()}|${mode}|${maxPages}|${query?.trim().toLowerCase() ?? ""}`;
}

async function getDocsPages(params: DocsSearchParams, signal?: AbortSignal): Promise<{ pages: DocsPage[]; source: URL; mode: DocsSearchMode }> {
	const source = normalizeSource(params.source);
	const mode = normalizeMode(params.mode);
	const maxPages = clampInt(params.maxPages, DEFAULT_MAX_PAGES, MAX_PAGES_CAP);
	const key = cacheKeyForDocs(source, mode, maxPages, params.query);
	const cached = docsCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return { pages: cached.pages, source, mode };

	const discovered = await discoverDocsPages(source, mode, maxPages, signal, params.query);
	const pages = (await Promise.all(discovered.map(item => fetchLimit(() => fetchDocsPage(item, signal))))).filter((page): page is DocsPage => !!page);
	if (docsCache.size >= DOCS_CACHE_MAX) docsCache.delete(docsCache.keys().next().value as string);
	docsCache.set(key, { expiresAt: Date.now() + DOCS_CACHE_TTL_MS, pages, source: source.toString(), mode });
	return { pages, source, mode };
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

export async function executeDocsSearch(params: DocsSearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	try {
		const query = params.query?.trim() ?? "";
		const maxResults = clampInt(params.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
		const maxCharacters = clampInt(params.maxCharacters, DEFAULT_MAX_CHARS, 3000);
		const { pages, source, mode } = await getDocsPages(params, signal);
		const ranked = pages
			.map((page, index) => ({ page, index, score: query ? scorePage(page, query) : Math.max(1, pages.length - index) }))
			.filter(item => !query || item.score > 0)
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, maxResults);

		const lines = [`# Docs search: ${source.toString()}`, query ? `Query: "${query}"` : "No query provided — showing discovered pages.", `Indexed ${pages.length} page(s); showing ${ranked.length}.`, ""];
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
				results: ranked.map(({ page, score }) => ({ title: page.title, url: page.url, fetchUrl: page.fetchUrl, score, contentLength: page.content.length })),
				...(params.returnMetadata ? { pages: pages.map(p => ({ title: p.title, url: p.url, fetchUrl: p.fetchUrl, contentType: p.contentType, contentLength: p.content.length })) } : {}),
			},
		};
	} catch (err) {
		const message = errorMessage(err);
		return { content: [{ type: "text", text: `Docs search failed: ${message}` }], details: { error: message, source: params.source } };
	}
}

async function fetchOpenApi(url: string, signal?: AbortSignal): Promise<{ endpoints: OpenApiEndpoint[]; tags: string[] }> {
	const normalized = normalizeSource(url).toString();
	const cached = openApiCache.get(normalized);
	if (cached && cached.expiresAt > Date.now()) return cached;
	const res = await fetch(normalized, { headers: { "Accept": "application/json", "User-Agent": "pi-web-access/0.10" }, signal: requestSignal(signal) });
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const spec = await res.json() as Record<string, unknown>;
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

export async function executeOpenApiSearch(params: OpenApiSearchParams, signal?: AbortSignal): Promise<ToolReturn> {
	try {
		const url = params.url?.trim() || DEFAULT_OPENAPI_URL;
		const query = params.query?.trim() || "";
		const tag = params.tag?.trim() || "";
		if (!query && !tag) throw new Error("Provide `query` and/or `tag`.");
		const maxResults = clampInt(params.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
		const { endpoints, tags } = await fetchOpenApi(url, signal);
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

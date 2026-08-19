import { existsSync, readFileSync } from "node:fs";
import pLimit from "p-limit";
import { readErrorSnippet, readResponseJson, readResponseText } from "./http-response.js";
import { getWebSearchConfigPath } from "./utils.js";

export type GitHubExamplesOperation = "find" | "read";

export interface GitHubExamplesParams {
	operation?: GitHubExamplesOperation;
	repo: string;
	keyword?: string;
	path?: string;
	ref?: string;
	maxResults?: number;
	minScore?: number;
	lineStart?: number;
	lineEnd?: number;
}

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

interface GitHubRepoInfo {
	default_branch?: string;
	full_name?: string;
	description?: string;
	stargazers_count?: number;
}

interface GitHubTreeItem {
	path?: string;
	type?: string;
	sha?: string;
	size?: number;
}

interface ContentScanResult {
	file: ExampleFile;
	status: "succeeded" | "failed";
	error?: string;
}

interface ExampleFile {
	path: string;
	url: string;
	ref: string;
	sha: string;
	size: number;
	exampleScore: number;
	keywordScore: number;
	contentScore?: number;
	matchedTerms?: string[];
	matchSnippet?: string;
	score: number;
	priority: number;
}

const GITHUB_API = "https://api.github.com";
const CONFIG_PATH = getWebSearchConfigPath();
const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS = 12;
const MAX_RESULTS = 50;
const MAX_GITHUB_JSON_BYTES = 20 * 1024 * 1024;
const MAX_GITHUB_FILE_BYTES = 5 * 1024 * 1024;
const CONTENT_SCAN_LIMIT = 8;
const CONTENT_SCAN_MAX_BYTES = 256 * 1024;
const contentScanLimit = pLimit(3);

const EXAMPLE_PATTERNS = [
	"scripts", "script", "examples", "example", "notebooks", "notebook",
	"tutorials", "tutorial", "quickstart", "walkthrough", "cookbook", "recipes",
	"recipe", "demos", "demo", "samples", "sample", "guides", "guide",
	"getting-started", "getting_started", "howto", "how-to", "use-cases", "usecases",
	"playground", "showcase", "templates", "template",
];

const TEXT_EXTENSIONS = new Set([
	".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".kt", ".scala", ".rb", ".php",
	".c", ".h", ".cc", ".cpp", ".cs", ".swift", ".m", ".mm", ".sh", ".bash", ".zsh", ".fish",
	".md", ".mdx", ".rst", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg",
	".ipynb", ".html", ".css", ".scss", ".sql", ".dockerfile",
]);

interface WebSearchConfig {
	githubToken?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeToken(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function getGitHubToken(): string | null {
	return normalizeToken(process.env.GITHUB_TOKEN) ?? normalizeToken(loadConfig().githubToken);
}

function clampInt(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error && err.name === "TimeoutError") return `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
	return err instanceof Error ? err.message : String(err);
}

function githubHeaders(raw = false): Record<string, string> {
	const headers: Record<string, string> = {
		"Accept": raw ? "application/vnd.github.raw" : "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "pi-web-access/0.10",
	};
	const token = getGitHubToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function normalizeRepo(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 2) return null;
		return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
	} catch {
		if (/^[^\s/]+\/[^\s/]+$/.test(trimmed)) return trimmed.replace(/\.git$/i, "");
		return null;
	}
}

function repoParts(repo: string): { owner: string; name: string } {
	const [owner, ...rest] = repo.split("/");
	return { owner, name: rest.join("/") };
}

async function fetchGitHubJson<T>(path: string, signal?: AbortSignal): Promise<T> {
	const res = await fetch(`${GITHUB_API}${path}`, { headers: githubHeaders(), signal: requestSignal(signal) });
	if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await readErrorSnippet(res, 250)}`);
	return await readResponseJson<T>(res, MAX_GITHUB_JSON_BYTES);
}

async function fetchGitHubText(path: string, signal?: AbortSignal, maxBytes = MAX_GITHUB_FILE_BYTES): Promise<string> {
	const res = await fetch(`${GITHUB_API}${path}`, { headers: githubHeaders(true), signal: requestSignal(signal) });
	if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await readErrorSnippet(res, 250)}`);
	return await readResponseText(res, maxBytes);
}

async function findSimilarRepos(repo: string, signal?: AbortSignal): Promise<Array<{ full_name?: string; description?: string; stargazers_count?: number; html_url?: string }>> {
	const { owner, name } = repoParts(repo);
	const q = owner && name ? `org:${owner} ${name} in:name` : `${repo} in:name`;
	const url = `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`;
	try {
		const data = await fetchGitHubJson<{ items?: Array<{ full_name?: string; description?: string; stargazers_count?: number; html_url?: string }> }>(url, signal);
		return data.items ?? [];
	} catch {
		return [];
	}
}

function pathParts(path: string): string[] {
	return path.toLowerCase().split(/[\\/]+/).filter(Boolean);
}

function extname(path: string): string {
	const match = path.toLowerCase().match(/\.[a-z0-9]+$/);
	return match?.[0] ?? "";
}

function isLikelyTextPath(path: string): boolean {
	const ext = extname(path);
	if (!ext) return /(^|\/)dockerfile$/i.test(path) || /(^|\/)(makefile|justfile)$/i.test(path);
	return TEXT_EXTENSIONS.has(ext);
}

function tokenize(value: string): string[] {
	return value.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
}

function tokenScore(haystack: string, needle: string): number {
	const h = haystack.toLowerCase();
	const n = needle.toLowerCase().trim();
	if (!n) return 0;
	if (h === n) return 100;
	if (h.includes(n)) return 95;
	const hayTokens = new Set(tokenize(h));
	const needleTokens = tokenize(n);
	if (needleTokens.length === 0) return 0;
	let matched = 0;
	for (const token of needleTokens) {
		if (hayTokens.has(token) || [...hayTokens].some(ht => ht.includes(token) || token.includes(ht))) matched++;
	}
	const overlap = matched / needleTokens.length;
	return Math.round(overlap * 85);
}

function exampleScore(path: string): { score: number; priority: number } {
	const parts = pathParts(path);
	let score = 0;
	let priority = 999;
	for (let i = 0; i < EXAMPLE_PATTERNS.length; i++) {
		const pattern = EXAMPLE_PATTERNS[i];
		const exactIndex = parts.indexOf(pattern);
		if (exactIndex >= 0) {
			score = Math.max(score, 95 - Math.min(20, exactIndex * 3));
			priority = Math.min(priority, i);
			continue;
		}
		if (parts.some(part => part.includes(pattern))) {
			score = Math.max(score, 75);
			priority = Math.min(priority, i + 30);
		}
	}
	return { score, priority };
}

function combinedScore(path: string, keyword: string | undefined): { exampleScore: number; keywordScore: number; score: number; priority: number } {
	const ex = exampleScore(path);
	const kw = keyword ? Math.max(tokenScore(path, keyword), tokenScore(path.split("/").pop() || path, keyword)) : 0;
	const codeBonus = isLikelyTextPath(path) ? 5 : -15;
	const score = keyword ? Math.round(ex.score * 0.45 + kw * 0.6 + codeBonus) : ex.score + codeBonus;
	return { exampleScore: ex.score, keywordScore: kw, score, priority: ex.priority };
}

function contentMatch(content: string, keyword: string): { score: number; matchedTerms: string[]; snippet?: string } {
	const terms = [...new Set(tokenize(keyword))];
	if (terms.length === 0) return { score: 0, matchedTerms: [] };
	const lower = content.toLowerCase();
	const contentTokens = new Set(tokenize(content));
	const matchedTerms = terms.filter(term => contentTokens.has(term));
	if (matchedTerms.length === 0) return { score: 0, matchedTerms };
	const phrase = lower.includes(keyword.trim().toLowerCase());
	const score = Math.min(100, Math.round((matchedTerms.length / terms.length) * 85 + (phrase ? 15 : 0)));
	const first = Math.min(...matchedTerms.map(term => lower.indexOf(term)).filter(index => index >= 0));
	const start = Math.max(0, first - 100);
	const snippet = content.slice(start, Math.min(content.length, first + 220)).replace(/\s+/g, " ").trim();
	return { score, matchedTerms, snippet };
}

async function scanCandidateContent(repo: string, file: ExampleFile, keyword: string, signal?: AbortSignal): Promise<ContentScanResult> {
	try {
		const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
		const refQuery = file.ref ? `?ref=${encodeURIComponent(file.ref)}` : "";
		const content = await fetchGitHubText(`/repos/${repo}/contents/${encodedPath}${refQuery}`, signal, CONTENT_SCAN_MAX_BYTES);
		const match = contentMatch(content, keyword);
		return {
			status: "succeeded",
			file: {
				...file,
				contentScore: match.score,
				matchedTerms: match.matchedTerms,
				matchSnippet: match.snippet,
				score: Math.round(file.exampleScore * 0.35 + file.keywordScore * 0.35 + match.score * 0.65 + 5),
			},
		};
	} catch (err) {
		if (signal?.aborted) throw signal.reason ?? err;
		return { status: "failed", file, error: errorMessage(err) };
	}
}

async function getRepoInfo(repo: string, signal?: AbortSignal): Promise<GitHubRepoInfo> {
	return fetchGitHubJson<GitHubRepoInfo>(`/repos/${repo}`, signal);
}

async function getRepoTree(repo: string, ref: string, signal?: AbortSignal): Promise<{ tree: GitHubTreeItem[]; truncated: boolean }> {
	const data = await fetchGitHubJson<{ tree?: GitHubTreeItem[]; truncated?: boolean }>(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal);
	return {
		tree: (data.tree ?? []).filter(item => item.type === "blob" && typeof item.path === "string"),
		truncated: data.truncated === true,
	};
}

async function executeFind(params: GitHubExamplesParams, signal?: AbortSignal): Promise<ToolReturn> {
	const repo = normalizeRepo(params.repo);
	if (!repo) return failure("find", "`repo` must be owner/name or a GitHub URL.", params);
	const maxResults = clampInt(params.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS);
	const keyword = normalizeToken(params.keyword) ?? undefined;
	const minScore = clampInt(params.minScore, keyword ? 45 : 55, 100);
	let info: GitHubRepoInfo;
	try {
		info = await getRepoInfo(repo, signal);
	} catch (err) {
		const similar = await findSimilarRepos(repo, signal);
		const lines = [`GitHub examples failed: ${errorMessage(err)}`];
		if (similar.length) {
			lines.push("", "Similar repositories:");
			for (const item of similar) lines.push(`- **${item.full_name}** (${item.stargazers_count ?? 0} stars) — ${item.html_url}${item.description ? `\n  ${item.description}` : ""}`);
		}
		return { content: [{ type: "text", text: lines.join("\n") }], details: { operation: "find", error: errorMessage(err), similar } };
	}
	const ref = params.ref?.trim() || info.default_branch || "main";
	const { tree, truncated } = await getRepoTree(repo, ref, signal);
	let examples: ExampleFile[] = [];
	for (const item of tree) {
		const path = item.path!;
		if (!isLikelyTextPath(path)) continue;
		const scored = combinedScore(path, keyword);
		if (keyword) {
			if (scored.exampleScore < 55 && scored.keywordScore < 30) continue;
		} else if (scored.score < minScore && scored.exampleScore < 60) continue;
		examples.push({
			path,
			ref,
			sha: item.sha || "",
			size: item.size || 0,
			url: `https://github.com/${repo}/blob/${ref}/${path}`,
			...scored,
		});
	}
	examples.sort((a, b) => b.score - a.score || a.priority - b.priority || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
	let scanAttempted = 0;
	let scanSucceeded = 0;
	let scanFailed = 0;
	let scanErrors: string[] = [];
	if (keyword) {
		const scanCandidates = examples.filter(file => file.size <= CONTENT_SCAN_MAX_BYTES).slice(0, CONTENT_SCAN_LIMIT);
		scanAttempted = scanCandidates.length;
		const scanned = await Promise.all(scanCandidates.map(file => contentScanLimit(() => scanCandidateContent(repo, file, keyword, signal))));
		scanSucceeded = scanned.filter(result => result.status === "succeeded").length;
		scanFailed = scanned.length - scanSucceeded;
		scanErrors = [...new Set(scanned.flatMap(result => result.error ? [result.error] : []))].slice(0, 3);
		const scannedByPath = new Map(scanned.map(result => [result.file.path, result.file]));
		examples = examples
			.map(file => scannedByPath.get(file.path) ?? file)
			.filter(file => ((file.contentScore ?? 0) > 0 || file.keywordScore > 0) && file.score >= minScore);
		examples.sort((a, b) => b.score - a.score || (b.contentScore ?? 0) - (a.contentScore ?? 0) || a.priority - b.priority || a.path.localeCompare(b.path));
	} else {
		examples = examples.filter(file => file.score >= minScore);
	}
	const results = examples.slice(0, maxResults);
	const lines = [`# GitHub examples in ${repo}`, info.description ? info.description : "", `Branch/ref: ${ref}`, keyword ? `Keyword: "${keyword}"` : "No keyword — showing likely example/tutorial files.", `Showing ${results.length} of ${examples.length} candidate file(s).`, scanFailed > 0 ? `Content scan: ${scanSucceeded}/${scanAttempted} succeeded; ${scanFailed} failed${scanErrors[0] ? ` (${scanErrors[0]})` : ""}.` : "", truncated ? "Warning: GitHub reported the repository tree as truncated, so example discovery may be incomplete. Try a narrower ref/path or fetch the repository with `fetch_content`." : "", ""].filter(Boolean);
	for (let i = 0; i < results.length; i++) {
		const file = results[i];
		lines.push(`## ${i + 1}. ${file.path}`);
		lines.push(`${file.url}`);
		lines.push(`Score: ${file.score} (example ${file.exampleScore}, path ${file.keywordScore}${file.contentScore != null ? `, content ${file.contentScore}` : ""}) · Size: ${file.size.toLocaleString()} bytes`);
		if (file.matchedTerms?.length) lines.push(`Matched terms: ${file.matchedTerms.join(", ")}`);
		if (file.matchSnippet) lines.push(`> ${file.matchSnippet}`);
		lines.push(`Read: github_examples({ operation: "read", repo: "${repo}", path: "${file.path}", ref: "${ref}" })`, "");
	}
	if (results.length === 0) {
		lines.push(`No bounded path/content matches were found. Try fetch_content({ url: "https://github.com/${repo}" }) to inspect or clone the repository, or retry with a path-oriented keyword.`);
	}
	return { content: [{ type: "text", text: lines.join("\n") }], details: { operation: "find", repo, ref, truncated, count: results.length, totalCandidates: examples.length, contentScan: { attempted: scanAttempted, succeeded: scanSucceeded, failed: scanFailed, errors: scanErrors }, contentScanLimit: CONTENT_SCAN_LIMIT, contentScanMaxBytes: CONTENT_SCAN_MAX_BYTES, minScore, results } };
}

function decodeContentResponse(data: Record<string, unknown>): string | null {
	if (data.encoding !== "base64" || typeof data.content !== "string" || data.content.trim().length === 0) return null;
	try {
		return Buffer.from(data.content.replace(/\s+/g, ""), "base64").toString("utf8");
	} catch {
		return null;
	}
}

function notebookToMarkdown(content: string): string {
	try {
		const nb = JSON.parse(content) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
		if (!Array.isArray(nb.cells)) return content;
		const parts: string[] = [];
		for (const cell of nb.cells) {
			const source = Array.isArray(cell.source) ? cell.source.join("") : typeof cell.source === "string" ? cell.source : "";
			if (!source.trim()) continue;
			if (cell.cell_type === "markdown") parts.push(source.trim());
			else if (cell.cell_type === "code") parts.push("```python\n" + source.trimEnd() + "\n```");
		}
		return parts.join("\n\n");
	} catch {
		return content;
	}
}

function selectLines(content: string, lineStart?: number, lineEnd?: number): { text: string; lineStart: number; lineEnd: number; totalLines: number; truncated: boolean } {
	const lines = content.split(/\r?\n/);
	const totalLines = lines.length;
	let start = typeof lineStart === "number" && Number.isFinite(lineStart) ? Math.max(1, Math.floor(lineStart)) : 1;
	let end = typeof lineEnd === "number" && Number.isFinite(lineEnd) ? Math.max(start, Math.floor(lineEnd)) : Math.min(totalLines, start + 299);
	end = Math.min(end, totalLines);
	start = Math.min(start, end);
	return { text: lines.slice(start - 1, end).join("\n"), lineStart: start, lineEnd: end, totalLines, truncated: start > 1 || end < totalLines };
}

async function executeRead(params: GitHubExamplesParams, signal?: AbortSignal): Promise<ToolReturn> {
	const repo = normalizeRepo(params.repo);
	if (!repo) return failure("read", "`repo` must be owner/name or a GitHub URL.", params);
	const path = params.path?.trim();
	if (!path) return failure("read", "`path` is required for operation=read.", params);
	const ref = params.ref?.trim() || "HEAD";
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	const refQuery = ref && ref !== "HEAD" ? `?ref=${encodeURIComponent(ref)}` : "";
	let content: string | null = null;
	try {
		const data = await fetchGitHubJson<Record<string, unknown>>(`/repos/${repo}/contents/${encodedPath}${refQuery}`, signal);
		if (data.type !== "file") return failure("read", `${path} is not a file.`, params);
		content = decodeContentResponse(data);
		if (content === null) content = await fetchGitHubText(`/repos/${repo}/contents/${encodedPath}${refQuery}`, signal);
	} catch (err) {
		return failure("read", errorMessage(err), params);
	}
	if (path.toLowerCase().endsWith(".ipynb")) content = notebookToMarkdown(content);
	const selected = selectLines(content, params.lineStart, params.lineEnd);
	let text = `# ${repo}/${path}\nhttps://github.com/${repo}/blob/${ref}/${path}\n\n`;
	text += `Showing lines ${selected.lineStart}-${selected.lineEnd} of ${selected.totalLines}${selected.truncated ? " (truncated)" : ""}.\n\n`;
	text += "```\n" + selected.text + "\n```";
	if (selected.lineEnd < selected.totalLines) {
		const nextStart = selected.lineEnd + 1;
		const nextEnd = Math.min(selected.totalLines, nextStart + 299);
		text += `\n\nNext: github_examples({ operation: "read", repo: "${repo}", path: "${path}", ref: "${ref}", lineStart: ${nextStart}, lineEnd: ${nextEnd} })`;
	} else if (selected.lineStart > 1) {
		const earlierEnd = selected.lineStart - 1;
		const earlierStart = Math.max(1, earlierEnd - 299);
		text += `\n\nEarlier: github_examples({ operation: "read", repo: "${repo}", path: "${path}", ref: "${ref}", lineStart: ${earlierStart}, lineEnd: ${earlierEnd} })`;
	}
	return { content: [{ type: "text", text }], details: { operation: "read", repo, path, ref, lineStart: selected.lineStart, lineEnd: selected.lineEnd, totalLines: selected.totalLines, truncated: selected.truncated } };
}

function failure(operation: string, message: string, params: GitHubExamplesParams): ToolReturn {
	return { content: [{ type: "text", text: `GitHub examples failed: ${message}` }], details: { operation, error: message, params } };
}

export async function executeGitHubExamples(params: GitHubExamplesParams, signal?: AbortSignal): Promise<ToolReturn> {
	try {
		const operation = params.operation ?? "find";
		if (operation === "read") return await executeRead(params, signal);
		return await executeFind(params, signal);
	} catch (err) {
		return failure(params.operation ?? "find", errorMessage(err), params);
	}
}

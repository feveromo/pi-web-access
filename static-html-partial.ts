import { parseHTML } from "linkedom";

const MAX_LINKS = 40;
const MAX_CANDIDATES = 30;
const FIELD_CHARS = 500;

export interface StaticHtmlPartial {
	title: string;
	content: string;
	metadata: Record<string, unknown>;
}

export function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const bodyHtml = bodyMatch[1];
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	const hasModuleShell = /<script[^>]+type=["']module["']/i.test(html) && /<(?:div|main)[^>]+id=["'](?:root|app|__next|__nuxt)["']/i.test(bodyHtml);
	return (textContent.length < 500 && scriptCount > 3) || (textContent.length < 2_000 && hasModuleShell);
}

function cleanText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim().slice(0, FIELD_CHARS);
}

function safeUrl(value: string | null | undefined, baseUrl: URL): string | null {
	if (!value) return null;
	try {
		const resolved = new URL(value, baseUrl);
		return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : null;
	} catch { return null; }
}

function markdownText(value: string): string {
	return value.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
}

export function extractStaticHtmlPartial(html: string, sourceUrl: string, warning: string): StaticHtmlPartial {
	const baseUrl = new URL(sourceUrl);
	const { document } = parseHTML(html);
	const meta = (selector: string) => cleanText(document.querySelector(selector)?.getAttribute("content"));
	const title = cleanText(document.querySelector("title")?.textContent) || meta('meta[property="og:title"]') || baseUrl.hostname;
	const description = meta('meta[name="description"]');
	const canonical = safeUrl(document.querySelector('link[rel="canonical"]')?.getAttribute("href"), baseUrl);
	const openGraph = {
		title: meta('meta[property="og:title"]'),
		description: meta('meta[property="og:description"]'),
		url: safeUrl(document.querySelector('meta[property="og:url"]')?.getAttribute("content"), baseUrl),
	};
	const anchors: Array<{ title: string; url: string }> = [];
	const candidates = new Set<string>();
	for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
		const resolved = safeUrl(anchor.getAttribute("href"), baseUrl);
		if (!resolved || new URL(resolved).origin !== baseUrl.origin) continue;
		if (anchors.length < MAX_LINKS) anchors.push({ title: cleanText(anchor.textContent) || new URL(resolved).pathname, url: resolved });
		if (/(?:^|[/_.-])(?:docs?|api|openapi|swagger|llms(?:-full)?\.txt|manifest)(?:[/_.-]|$)/i.test(new URL(resolved).pathname)) candidates.add(resolved);
	}
	for (const node of Array.from(document.querySelectorAll('link[rel="manifest"][href], script[type="module"][src]'))) {
		const attribute = node.tagName.toLowerCase() === "script" ? "src" : "href";
		const resolved = safeUrl(node.getAttribute(attribute), baseUrl);
		if (resolved && new URL(resolved).origin === baseUrl.origin) candidates.add(resolved);
	}
	const boundedCandidates = [...candidates].slice(0, MAX_CANDIDATES);
	const lines = [
		"[Partial extraction: JavaScript was not executed. Only static HTML metadata and route evidence are available.]",
		"",
		`# ${markdownText(title)}`,
	];
	if (description) lines.push("", description);
	lines.push("", "## Static metadata");
	if (canonical) lines.push(`- Canonical URL: ${canonical}`);
	if (openGraph.title) lines.push(`- OpenGraph title: ${markdownText(openGraph.title)}`);
	if (openGraph.description) lines.push(`- OpenGraph description: ${markdownText(openGraph.description)}`);
	if (openGraph.url) lines.push(`- OpenGraph URL: ${openGraph.url}`);
	if (!canonical && !openGraph.title && !openGraph.description && !openGraph.url) lines.push("- No canonical or OpenGraph metadata found.");
	if (boundedCandidates.length) lines.push("", "## Likely documentation/API assets", ...boundedCandidates.map(value => `- ${value}`));
	if (anchors.length) lines.push("", "## Same-origin links", ...anchors.map(anchor => `- [${markdownText(anchor.title)}](${anchor.url.replace(/[()]/g, char => encodeURIComponent(char))})`));
	return {
		title,
		content: lines.join("\n"),
		metadata: {
			staticHtmlPartial: true,
			extractionWarning: warning,
			staticEvidence: { title, description: description || undefined, canonical: canonical || undefined, openGraph, anchors, candidates: boundedCandidates },
		},
	};
}

export function preferJinaResult<T>(jinaResult: T | null, staticPartial: T): T {
	return jinaResult ?? staticPartial;
}

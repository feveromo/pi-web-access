import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.js";
import { extractRSCContent } from "./rsc-extract.js";
import { extractPDFToMarkdown, isPDF } from "./pdf-extract.js";
import { extractGitHub } from "./github-extract.js";
import { isYouTubeURL, isYouTubeEnabled, extractYouTube, extractYouTubeFrame, extractYouTubeFrames, getYouTubeStreamInfo } from "./youtube-extract.js";
import { extractWithUrlContext, extractWithGeminiWeb } from "./gemini-url-context.js";
import { isVideoFile, extractVideo, extractVideoFrame, getLocalVideoDuration } from "./video-extract.js";
import { formatSeconds } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string, fallbackPath?: string[]): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted", status: "error", method: "aborted", fetchedAt: new Date().toISOString(), fallbackPath };
}

function normalizeMode(mode: unknown): ExtractMode {
	return mode === "highlights" || mode === "summary" ? mode : "full";
}

function normalizeMaxChars(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const rounded = Math.floor(value);
	return rounded > 0 ? rounded : null;
}

function objectiveTokens(options?: ExtractOptions): Set<string> {
	const raw = [options?.objective, ...(options?.queries ?? [])].filter((v): v is string => typeof v === "string").join(" ").toLowerCase();
	const stop = new Set(["about", "after", "also", "and", "are", "because", "but", "can", "for", "from", "has", "have", "how", "into", "its", "not", "our", "that", "the", "their", "this", "was", "what", "when", "where", "which", "with", "you", "your"]);
	return new Set((raw.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(t => !stop.has(t)));
}

function splitMarkdownBlocks(markdown: string): string[] {
	return markdown
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(block => block.length > 0);
}

function scoreBlock(block: string, tokens: Set<string>, index: number): number {
	let score = Math.max(0, 8 - index * 0.05);
	if (/^#{1,3}\s/.test(block)) score += 2;
	const lower = block.toLowerCase();
	for (const token of tokens) {
		const matches = lower.match(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"));
		if (matches) score += matches.length * 6;
	}
	return score;
}

function buildHighlights(markdown: string, tokens: Set<string>): string {
	const blocks = splitMarkdownBlocks(markdown);
	if (blocks.length === 0 || tokens.size === 0) return blocks.slice(0, 6).join("\n\n");
	const selected = blocks
		.map((block, index) => ({ block, index, score: scoreBlock(block, tokens, index) }))
		.filter(item => item.score > Math.max(1, 8 - item.index * 0.05))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, 8)
		.sort((a, b) => a.index - b.index)
		.map(item => item.block);
	return (selected.length > 0 ? selected : blocks.slice(0, 6)).join("\n\n");
}

function buildSummary(markdown: string, tokens: Set<string>): string {
	const blocks = splitMarkdownBlocks(markdown);
	if (blocks.length === 0) return markdown;
	const headings = blocks.filter(block => /^#{1,3}\s/.test(block)).slice(0, 12);
	const paragraphs = tokens.size > 0
		? blocks
			.map((block, index) => ({ block, index, score: scoreBlock(block, tokens, index) }))
			.filter(item => !/^#{1,3}\s/.test(item.block))
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, 5)
			.sort((a, b) => a.index - b.index)
			.map(item => item.block)
		: blocks.filter(block => !/^#{1,3}\s/.test(block)).slice(0, 5);
	return [...headings, ...paragraphs].join("\n\n") || blocks.slice(0, 6).join("\n\n");
}

function capContent(content: string, maxChars: number | null): { content: string; truncated: boolean } {
	if (!maxChars || content.length <= maxChars) return { content, truncated: false };
	const marker = "\n\n[Truncated by fetch_content maxChars]";
	const bodyLimit = Math.max(0, maxChars - marker.length);
	const slice = content.slice(0, bodyLimit);
	const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
	const capped = (breakAt > Math.floor(bodyLimit * 0.5) ? slice.slice(0, breakAt + 1) : slice).trimEnd();
	const output = `${capped}${marker}`;
	return { content: output.length > maxChars ? output.slice(0, maxChars) : output, truncated: true };
}

function shapeExtractedContent(result: ExtractedContent, options?: ExtractOptions): ExtractedContent {
	if (result.error || !result.content) return { ...result, status: "error", originalContentLength: result.content.length, truncated: false };
	const originalContentLength = result.content.length;
	const mode = normalizeMode(options?.mode);
	const tokens = objectiveTokens(options);
	let shaped = result.content;
	if (mode === "highlights") shaped = buildHighlights(shaped, tokens);
	else if (mode === "summary") shaped = buildSummary(shaped, tokens);
	const capped = capContent(shaped, normalizeMaxChars(options?.maxChars));
	return {
		...result,
		content: capped.content,
		status: "success",
		originalContentLength,
		truncated: capped.truncated || shaped.length < originalContentLength,
		metadata: {
			...(result.metadata ?? {}),
			mode,
			objective: options?.objective,
			queries: options?.queries,
		},
	};
}

function finalizeResult(
	result: ExtractedContent,
	options: ExtractOptions | undefined,
	method: string,
	fallbackPath: string[],
	extra?: Partial<ExtractedContent>,
): ExtractedContent {
	const merged: ExtractedContent = {
		...result,
		...extra,
		method: result.method ?? extra?.method ?? method,
		status: result.error ? "error" : "success",
		fetchedAt: result.fetchedAt ?? extra?.fetchedAt ?? new Date().toISOString(),
		fallbackPath: result.fallbackPath ?? fallbackPath,
	};
	return shapeExtractedContent(merged, options);
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export type ExtractMode = "full" | "highlights" | "summary";

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
	status?: "success" | "error";
	method?: string;
	fetchedAt?: string;
	fetchedUrl?: string;
	contentType?: string;
	httpStatus?: number;
	contentLength?: number;
	originalContentLength?: number;
	truncated?: boolean;
	fallbackPath?: string[];
	retrievalStatus?: string;
	metadata?: Record<string, unknown>;
}

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
	objective?: string;
	queries?: string[];
	mode?: ExtractMode;
	maxChars?: number;
	returnMetadata?: boolean;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

async function extractWithJinaReader(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const res = await fetch(jinaUrl, {
			headers: {
				"Accept": "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(JINA_TIMEOUT_MS),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await res.text();
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null, method: "jina", fetchedAt: new Date().toISOString(), fetchedUrl: jinaUrl, httpStatus: res.status, contentType: res.headers.get("content-type") || undefined };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (!isNaN(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some(p => isNaN(p) || p < 0)) return null;
	if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
	if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
	return null;
}

type TimestampSpec = { type: "single"; seconds: number } | { type: "range"; start: number; end: number };

function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL = 5;

function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}

function buildFrameResult(
	url: string, label: string, requestedCount: number,
	frames: VideoFrame[], error: string | null, duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		duration,
	};
}

async function extractLocalFrames(
	filePath: string, timestamps: number[],
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(timestamps.map(async (t) => {
		const frame = await extractVideoFrame(filePath, t);
		if ("error" in frame) return { error: frame.error };
		return { ...frame, timestamp: formatSeconds(t) };
	}));
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

function safeVideoInfo(url: string): { info: ReturnType<typeof isVideoFile>; error?: string } {
	try {
		return { info: isVideoFile(url) };
	} catch (err) {
		return { info: null, error: errorMessage(err) };
	}
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const fallbackPath: string[] = [];
	if (signal?.aborted) {
		return abortedResult(url, fallbackPath);
	}

	if (options?.frames && !options.timestamp) {
		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				return { url, title: "Frames", content: streamInfo.error, error: streamInfo.error };
			}
			if (streamInfo.duration === null) {
				const error = "Cannot determine video duration. Use a timestamp range instead.";
				return { url, title: "Frames", content: error, error };
			}
			const dur = Math.floor(streamInfo.duration);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, streamInfo.duration);
		}

		const localVideo = safeVideoInfo(url);
		if (localVideo.error) {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.info) {
			const durationResult = await getLocalVideoDuration(localVideo.info.absolutePath);
			if (typeof durationResult !== "number") {
				return { url, title: "Frames", content: durationResult.error, error: durationResult.error };
			}
			const dur = Math.floor(durationResult);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, durationResult);
		}

		return { url, title: "", content: "", error: "Frame extraction only works with YouTube and local video files" };
	}

	if (options?.timestamp) {
		const spec = parseTimestampSpec(options.timestamp);
		if (!spec) {
			return {
				url,
				title: "",
				content: "",
				error: `Invalid timestamp format: "${options.timestamp}". Use "H:MM:SS", "MM:SS", "85", or "start-end".`,
			};
		}

		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				if (spec.type === "range") {
					const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				if (frameCount) {
					const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
					const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				return { url, title: `Frame at ${options.timestamp}`, content: streamInfo.error, error: streamInfo.error };
			}

			if (spec.type === "range") {
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				if (streamInfo.duration !== null && spec.end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(spec.end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				if (streamInfo.duration !== null && end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
			}

			if (streamInfo.duration !== null && spec.seconds > streamInfo.duration) {
				const error = `Timestamp ${formatSeconds(spec.seconds)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
				return { url, title: `Frame at ${options.timestamp}`, content: error, error };
			}
			const frame = await extractYouTubeFrame(ytInfo.videoId, spec.seconds, streamInfo);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame };
		}

		const localVideo = safeVideoInfo(url);
		if (localVideo.error) {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.info) {
			if (spec.type === "range") {
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			const frame = await extractVideoFrame(localVideo.info.absolutePath, spec.seconds);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame };
		}

		return { url, title: "", content: "", error: "Timestamp extraction only works with YouTube and local video files" };
	}

	const localVideo = safeVideoInfo(url);
	if (localVideo.error) {
		return { url, title: "", content: "", error: localVideo.error };
	}
	if (localVideo.info) {
		try {
			const result = await extractVideo(localVideo.info, signal, options);
			if (signal?.aborted) return abortedResult(url);
			return result ?? { url, title: "", content: "", error: "Video analysis requires Gemini access. Either:\n  1. Sign into gemini.google.com in Chrome (free, uses cookies)\n  2. Set GEMINI_API_KEY in ~/.pi/web-search.json" };
		} catch (err) {
			if (isAbortError(err)) return abortedResult(url);
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	fallbackPath.push("github");
	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone);
		if (ghResult) return finalizeResult(ghResult, options, "github", fallbackPath);
		if (signal?.aborted) return abortedResult(url, fallbackPath);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url, fallbackPath);
		if (isConfigParseError(err)) {
			return finalizeResult({ url, title: "", content: "", error: message }, options, "github", fallbackPath);
		}
	}

	const ytInfo = isYouTubeURL(url);
	let youtubeEnabled = false;
	try {
		youtubeEnabled = isYouTubeEnabled();
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	if (ytInfo.isYouTube && youtubeEnabled) {
		fallbackPath.push("youtube");
		try {
			const ytResult = await extractYouTube(url, signal, options?.prompt, options?.model);
			if (ytResult) return finalizeResult(ytResult, options, "youtube", fallbackPath);
			if (signal?.aborted) return abortedResult(url, fallbackPath);
		} catch (err) {
			const message = errorMessage(err);
			if (isAbortError(err)) return abortedResult(url, fallbackPath);
			if (isConfigParseError(err)) {
				return finalizeResult({ url, title: "", content: "", error: message }, options, "youtube", fallbackPath);
			}
		}
		return finalizeResult({
			url,
			title: "",
			content: "",
			error: "Could not extract YouTube video content. Sign into Google in Chrome for automatic access, or set GEMINI_API_KEY.",
		}, options, "youtube", fallbackPath);
	}

	if (signal?.aborted) return abortedResult(url, fallbackPath);

	fallbackPath.push("http");
	const httpResult = await extractViaHttp(url, signal, options);

	if (signal?.aborted) return abortedResult(url, fallbackPath);
	if (!httpResult.error) return finalizeResult(httpResult, options, httpResult.method ?? "http", fallbackPath);
	if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult.error!.startsWith(prefix))) return finalizeResult(httpResult, options, httpResult.method ?? "http", fallbackPath);
	if (httpResult.httpStatus && httpResult.httpStatus >= 400 && httpResult.httpStatus < 500 && httpResult.httpStatus !== 403 && httpResult.httpStatus !== 429) {
		return finalizeResult(httpResult, options, httpResult.method ?? "http", fallbackPath);
	}

	fallbackPath.push("jina");
	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return finalizeResult(jinaResult, options, "jina", fallbackPath);
	if (signal?.aborted) return abortedResult(url, fallbackPath);

	let geminiResult: ExtractedContent | null = null;
	try {
		fallbackPath.push("gemini-url-context");
		geminiResult = await extractWithUrlContext(url, signal, options);
		if (!geminiResult) {
			fallbackPath.push("gemini-web");
			geminiResult = await extractWithGeminiWeb(url, signal, options);
		}
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url, fallbackPath);
		if (isConfigParseError(err)) {
			return finalizeResult({ ...httpResult, error: errorMessage(err) }, options, httpResult.method ?? "http", fallbackPath);
		}
	}

	if (geminiResult) return finalizeResult(geminiResult, options, geminiResult.method ?? "gemini", fallbackPath);
	if (signal?.aborted) return abortedResult(url, fallbackPath);

	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		"  \u2022 Set GEMINI_API_KEY in ~/.pi/web-search.json",
		"  \u2022 Sign into gemini.google.com in Chrome",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
	return finalizeResult({ ...httpResult, error: guidance }, options, httpResult.method ?? "http", fallbackPath);
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];

	// Strip tags to get text content
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Count scripts
	const scriptCount = (html.match(/<script/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		const fetchedAt = new Date().toISOString();
		const fetchedUrl = response.url || url;
		const contentType = response.headers.get("content-type") || "";
		const contentLengthHeader = response.headers.get("content-length");
		const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
		const httpMeta: Partial<ExtractedContent> = {
			method: "http",
			fetchedAt,
			fetchedUrl,
			contentType: contentType || undefined,
			httpStatus: response.status,
			contentLength: contentLength !== undefined && Number.isFinite(contentLength) ? contentLength : undefined,
		};

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
				...httpMeta,
			};
		}
		const isPDFContent = isPDF(url, contentType);
		const maxResponseSize = isPDFContent ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
					...httpMeta,
					method: "http-size-limit",
				};
			}
		}

		if (isPDFContent) {
			try {
				const buffer = await response.arrayBuffer();
				const result = await extractPDFToMarkdown(buffer, url);
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
					error: null,
					...httpMeta,
					method: "pdf",
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}`, ...httpMeta, method: "pdf" };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
				...httpMeta,
				method: "unsupported-content",
			};
		}

		const text = await response.text();
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null, ...httpMeta, method: "text" };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: rscResult.title, content: rscResult.content, error: null, ...httpMeta, method: "rsc" };
			}

			activityMonitor.logComplete(activityId, response.status);

			// Provide more specific error message
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: "",
				content: "",
				error: errorMsg,
				...httpMeta,
				method: jsRendered ? "js-rendered" : "readability-failed",
			};
		}

		const markdown = turndown.turndown(article.content);
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			const incompleteJsRendered = isLikelyJSRendered(text);
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: incompleteJsRendered
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
				...httpMeta,
				method: incompleteJsRendered ? "js-rendered" : "readability-incomplete",
			};
		}

		return { url, title: article.title || "", content: markdown, error: null, ...httpMeta, method: "readability" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message, method: "http", fetchedAt: new Date().toISOString() };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
}

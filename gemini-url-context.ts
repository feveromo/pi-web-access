import { activityMonitor } from "./activity.js";
import { getApiKey, API_BASE, DEFAULT_MODEL } from "./gemini-api.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { extractHeadingTitle, type ExtractedContent, type ExtractOptions, type ExtractMode } from "./extract.js";

function normalizeMode(mode: ExtractOptions["mode"]): ExtractMode {
	return mode === "highlights" || mode === "summary" ? mode : "full";
}

function buildExtractionPrompt(url: string, options?: ExtractOptions): string {
	const mode = normalizeMode(options?.mode);
	let prompt = "Extract readable content from this URL as clean markdown. Include the page title, important text, code blocks, and tables when present.";
	if (mode === "full") {
		prompt += " Do not summarize; preserve as much source content as possible.";
	} else if (mode === "highlights") {
		prompt += " Return only concise excerpts most relevant to the objective/search queries; preserve source wording where possible.";
	} else {
		prompt += " Return a concise structured summary with headings and the first most relevant paragraphs.";
	}
	if (options?.objective) prompt += `\nObjective: ${options.objective}`;
	if (options?.queries?.length) prompt += `\nRelated queries: ${options.queries.join(" | ")}`;
	prompt += `\n\nURL: ${url}`;
	return prompt;
}

function shouldRethrow(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.startsWith("Failed to parse ");
}

export async function extractWithUrlContext(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `url_context: ${url}` });

	try {
		const model = DEFAULT_MODEL;
		const body = {
			contents: [{ parts: [{ text: buildExtractionPrompt(url, options) }] }],
			tools: [{ url_context: {} }],
		};

		const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.any([
				AbortSignal.timeout(options?.timeoutMs ?? 60000),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const data = await res.json() as UrlContextResponse;
		activityMonitor.logComplete(activityId, res.status);

		const metadata = data.candidates?.[0]?.url_context_metadata;
		const urlMetadata = metadata?.url_metadata?.[0];
		const retrievalStatus = urlMetadata?.url_retrieval_status;
		if (retrievalStatus === "URL_RETRIEVAL_STATUS_UNSAFE" || retrievalStatus === "URL_RETRIEVAL_STATUS_ERROR") {
			return null;
		}

		const content = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		if (!content || content.length < 50) return null;

		const title = extractTitleFromContent(content, url);
		return {
			url,
			title,
			content,
			error: null,
			method: "gemini-url-context",
			fetchedAt: new Date().toISOString(),
			fetchedUrl: urlMetadata?.retrieved_url || url,
			retrievalStatus,
			metadata: {
				providerApi: "gemini-url-context",
				model,
				urlContextMetadata: metadata,
			},
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

export async function extractWithGeminiWeb(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `gemini_web: ${url}` });

	try {
		const model = options?.model ?? "gemini-3-flash-preview";
		const text = await queryWithCookies(buildExtractionPrompt(url, options), cookies, {
			model,
			signal,
			timeoutMs: options?.timeoutMs ?? 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		if (!text || text.length < 50) return null;

		const title = extractTitleFromContent(text, url);
		return {
			url,
			title,
			content: text,
			error: null,
			method: "gemini-web",
			fetchedAt: new Date().toISOString(),
			metadata: { providerApi: "gemini-web", model },
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function extractTitleFromContent(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

interface UrlContextResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		url_context_metadata?: {
			url_metadata?: Array<{
				retrieved_url?: string;
				url_retrieval_status?: string;
			}>;
		};
	}>;
}

import { isSafeForThirdPartyFetch } from "./http-response.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;

export function normalizedExtractionTimeout(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

export function isGitHubLikeUrl(rawUrl) {
	try {
		const hostname = new URL(rawUrl).hostname.toLowerCase();
		return hostname === "github.com" || hostname.endsWith(".github.com") || hostname === "githubusercontent.com" || hostname.endsWith(".githubusercontent.com");
	} catch {
		return false;
	}
}

export function buildRawExtractionCacheKey(url, options = {}, allowRanges = []) {
	if (options.hasLookup || allowRanges.length > 0 || isGitHubLikeUrl(url) || !isSafeForThirdPartyFetch(url)) return null;
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return JSON.stringify({
			url: parsed.toString(),
			forceClone: options.forceClone === true,
			timeoutMs: normalizedExtractionTimeout(options.timeoutMs),
		});
	} catch {
		return null;
	}
}

export function shouldCacheRawExtraction(result, allowRanges = []) {
	if (!result || result.error || allowRanges.length > 0) return false;
	const urls = [result.url, result.fetchedUrl].filter(value => typeof value === "string" && value.length > 0);
	return urls.length > 0 && urls.every(url => !isGitHubLikeUrl(url) && isSafeForThirdPartyFetch(url));
}

export function approximateRawResultBytes(result) {
	try { return Buffer.byteLength(JSON.stringify(result), "utf8"); }
	catch { return Number.POSITIVE_INFINITY; }
}

import { approximateRawResultBytes, shouldCacheRawExtraction } from "./raw-cache-policy.js";
import { createPersistentCache } from "./persistent-cache.js";

function isCachedExtraction(value) {
	return !!value && typeof value === "object"
		&& typeof value.url === "string" && value.url.length <= 16_384
		&& typeof value.title === "string" && value.title.length <= 100_000
		&& typeof value.content === "string" && value.content.length <= 5 * 1024 * 1024
		&& value.error === null && typeof value.method === "string";
}

export function createRawPersistentCache({ allowRanges = () => [], root } = {}) {
	return createPersistentCache({
		namespace: "raw-fetch", root,
		freshMs: 6 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000,
		maxEntries: 500, maxBytes: 96 * 1024 * 1024, maxValueBytes: 6 * 1024 * 1024,
		memoryMaxEntries: 50, memoryMaxBytes: 20 * 1024 * 1024,
		sizeOf: approximateRawResultBytes,
		validate: isCachedExtraction,
		admit: result => shouldCacheRawExtraction(result, allowRanges())
			&& ["readability", "text"].includes(result.method ?? "")
			&& result.metadata?.originCache?.persist !== false,
	});
}

export function decorateRawCacheResult(result, cache) {
	const warning = typeof cache.warning === "string" ? cache.warning : "";
	return {
		...result,
		...(warning ? { content: `[WARNING: STALE CACHE] ${warning}\n\n${result.content}` } : {}),
		metadata: { ...(result.metadata ?? {}), rawCache: {
			cacheHit: cache.status !== "miss", cacheAgeMs: cache.ageMs, shared: cache.shared,
			status: cache.status, storage: cache.storage, freshUntil: cache.freshUntil, staleUntil: cache.staleUntil,
			...(warning ? { warning } : {}),
		} },
	};
}

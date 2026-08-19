export function normalizeFetchContentParams(params) {
	const urls = uniqueStrings(normalizeStringArray(params.urls));
	const urlList = urls.length > 0 ? urls : normalizeSingleString(params.url);
	return {
		urlList,
		options: {
			forceClone: typeof params.forceClone === "boolean" ? params.forceClone : undefined,
			objective: normalizeOptionalString(params.objective),
			queries: optionalStringArray(params.queries),
			mode: normalizeMode(params.mode),
			maxChars: typeof params.maxChars === "number" ? params.maxChars : undefined,
			timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
			returnMetadata: typeof params.returnMetadata === "boolean" ? params.returnMetadata : undefined,
		},
	};
}

function normalizeStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap(normalizeSingleString);
}

function normalizeSingleString(value) {
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	return trimmed ? [trimmed] : [];
}

function optionalStringArray(value) {
	const normalized = uniqueStrings(normalizeStringArray(value));
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalString(value) {
	return normalizeSingleString(value)[0];
}

function normalizeMode(value) {
	return value === "full" || value === "highlights" || value === "summary" ? value : undefined;
}

function uniqueStrings(values) {
	return [...new Set(values)];
}

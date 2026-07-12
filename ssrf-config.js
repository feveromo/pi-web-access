import { readFileSync, statSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.js";

const configCache = new Map();

function fingerprint(stat) {
	return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
}

function parseAllowRanges(value, configPath) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new Error(`ssrf.allowRanges in ${configPath} must be an array of CIDR strings`);
	}
	const ranges = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "string") {
			throw new Error(`ssrf.allowRanges in ${configPath} must contain only CIDR strings; entry ${index + 1} is ${typeof entry}`);
		}
		const trimmed = entry.trim();
		if (trimmed) ranges.push(trimmed);
	}
	return ranges;
}

export function loadSsrfAllowRanges(configPath = getWebSearchConfigPath()) {
	let stat;
	try {
		stat = statSync(configPath, { bigint: true });
	} catch {
		configCache.delete(configPath);
		return [];
	}
	const version = fingerprint(stat);
	const cached = configCache.get(configPath);
	if (cached?.version === version) {
		if (cached.error) throw new Error(cached.error);
		return [...cached.ranges];
	}

	let ranges = [];
	let error = null;
	try {
		const value = JSON.parse(readFileSync(configPath, "utf8"))?.ssrf?.allowRanges;
		ranges = parseAllowRanges(value, configPath);
	} catch (err) {
		// Invalid JSON/unreadable files fail safe with no exemptions. Valid JSON
		// with a malformed allowRanges shape remains a loud configuration error.
		const message = err instanceof Error ? err.message : String(err);
		if (message.startsWith("ssrf.allowRanges in ")) error = message;
	}
	configCache.set(configPath, { version, ranges, error });
	if (error) throw new Error(error);
	return [...ranges];
}

export function clearSsrfConfigCache() {
	configCache.clear();
}

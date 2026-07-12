import { readErrorSnippet, readResponseJson, requestSignal } from "./http-response.js";
import { fetchRemoteUrl, type Lookup } from "./ssrf-protection.ts";

const REGISTRY_BASE = "https://registry.npmjs.org/";
const MAX_REGISTRY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_README_CHARS = 100_000;

export interface NpmPackageTarget {
	name: string;
	version?: string;
}

export interface NpmRegistryOptions {
	signal?: AbortSignal;
	timeoutMs: number;
	lookup?: Lookup;
	allowRanges?: string[];
}

export interface NpmRegistryResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
	method: "npm-registry";
	fetchedAt: string;
	fetchedUrl?: string;
	contentType?: string;
	httpStatus?: number;
	metadata?: Record<string, unknown>;
}

function safeDecode(value: string): string | null {
	try { return decodeURIComponent(value); }
	catch { return null; }
}

function splitVersionSuffix(name: string): { name: string; version?: string } {
	const separator = name.lastIndexOf("@");
	if (separator <= 0) return { name };
	return { name: name.slice(0, separator), version: name.slice(separator + 1) || undefined };
}

export function parseNpmPackageUrl(rawUrl: string): NpmPackageTarget | null {
	let url: URL;
	try { url = new URL(rawUrl); }
	catch { return null; }
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
	if (url.hostname.toLowerCase() !== "npmjs.com" && url.hostname.toLowerCase() !== "www.npmjs.com") return null;

	const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
	if (segments.some(segment => segment === null) || segments[0] !== "package") return null;
	const decoded = segments as string[];
	let target: NpmPackageTarget;
	let suffixIndex: number;
	if (decoded[1]?.startsWith("@")) {
		const withVersion = splitVersionSuffix(decoded[2] ?? "");
		if (!/^@[a-z0-9._~-]+$/i.test(decoded[1]) || !/^[a-z0-9._~-]+$/i.test(withVersion.name)) return null;
		target = withVersion.version
			? { name: `${decoded[1]}/${withVersion.name}`, version: withVersion.version }
			: { name: `${decoded[1]}/${withVersion.name}` };
		suffixIndex = 3;
	} else {
		if (!/^[a-z0-9._~-]+(?:@[^/]+)?$/i.test(decoded[1] ?? "")) return null;
		target = splitVersionSuffix(decoded[1]);
		suffixIndex = 2;
	}

	const suffix = decoded.slice(suffixIndex);
	if (suffix.length === 0) return target;
	if (suffix.length === 2 && (suffix[0] === "v" || suffix[0] === "version") && suffix[1]) {
		return { name: target.name, version: suffix[1] };
	}
	return null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function repositoryUrl(value: unknown): string | undefined {
	const raw = stringValue(value) ?? (value && typeof value === "object" ? stringValue((value as { url?: unknown }).url) : undefined);
	if (!raw) return undefined;
	return raw.replace(/^git\+/, "").replace(/^git:\/\/github\.com\//, "https://github.com/").replace(/\.git$/, "");
}

function markdownText(value: string): string {
	return value.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>])/g, "\\$1").trim();
}

function markdownUrl(value: string): string {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/[()]/g, char => encodeURIComponent(char)) : "";
	} catch { return ""; }
}

async function registryRequest(url: string, options: NpmRegistryOptions, abbreviated = false): Promise<Response> {
	return fetchRemoteUrl(url, {
		signal: requestSignal(options.signal, options.timeoutMs),
		headers: {
			"Accept": abbreviated ? "application/vnd.npm.install-v1+json" : "application/json",
			"User-Agent": "pi-web-access",
		},
	}, { allowRanges: options.allowRanges, lookup: options.lookup });
}

function errorResult(sourceUrl: string, message: string, response?: Response): NpmRegistryResult {
	return {
		url: sourceUrl,
		title: "",
		content: "",
		error: message,
		method: "npm-registry",
		fetchedAt: new Date().toISOString(),
		fetchedUrl: response?.url,
		contentType: response?.headers.get("content-type") || undefined,
		httpStatus: response?.status,
	};
}

export async function extractNpmPackage(sourceUrl: string, target: NpmPackageTarget, options: NpmRegistryOptions): Promise<NpmRegistryResult> {
	const packageEndpoint = `${REGISTRY_BASE}${encodeURIComponent(target.name)}`;
	try {
		options.signal?.throwIfAborted();
		let version = target.version;
		if (!version) {
			const metadataResponse = await registryRequest(packageEndpoint, options, true);
			if (metadataResponse.status === 404) {
				await readErrorSnippet(metadataResponse);
				return errorResult(sourceUrl, `npm package not found: ${target.name}`, metadataResponse);
			}
			if (!metadataResponse.ok) {
				const snippet = await readErrorSnippet(metadataResponse);
				return errorResult(sourceUrl, `npm registry HTTP ${metadataResponse.status}${snippet ? `: ${snippet}` : ""}`, metadataResponse);
			}
			const metadata = await readResponseJson(metadataResponse, MAX_REGISTRY_RESPONSE_BYTES) as { "dist-tags"?: Record<string, unknown> };
			version = stringValue(metadata["dist-tags"]?.latest);
			if (!version) return errorResult(sourceUrl, `npm registry metadata has no latest version for ${target.name}`, metadataResponse);
		}

		const versionEndpoint = `${packageEndpoint}/${encodeURIComponent(version)}`;
		const response = await registryRequest(versionEndpoint, options);
		if (response.status === 404) {
			await readErrorSnippet(response);
			return errorResult(sourceUrl, target.version ? `npm package version not found: ${target.name}@${version}` : `npm package not found: ${target.name}`, response);
		}
		if (!response.ok) {
			const snippet = await readErrorSnippet(response);
			return errorResult(sourceUrl, `npm registry HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`, response);
		}
		const data = await readResponseJson(response, MAX_REGISTRY_RESPONSE_BYTES) as Record<string, unknown>;
		const name = stringValue(data.name) ?? target.name;
		const resolvedVersion = stringValue(data.version) ?? version;
		const description = stringValue(data.description);
		const homepage = stringValue(data.homepage);
		const repository = repositoryUrl(data.repository);
		const license = stringValue(data.license) ?? (data.license && typeof data.license === "object" ? stringValue((data.license as { type?: unknown }).type) : undefined);
		let readme = stringValue(data.readme);
		if (!readme) {
			try {
				const packageResponse = await registryRequest(packageEndpoint, options);
				if (packageResponse.ok) {
					const packageData = await readResponseJson(packageResponse, MAX_REGISTRY_RESPONSE_BYTES) as { readme?: unknown };
					readme = stringValue(packageData.readme);
				} else {
					await packageResponse.body?.cancel().catch(() => {});
				}
			} catch (err) {
				if (options.signal?.aborted) throw err;
				// README enrichment is best-effort; bounded metadata above remains useful.
			}
		}
		const registryUrl = `https://www.npmjs.com/package/${name}${resolvedVersion ? `/v/${resolvedVersion}` : ""}`;
		const lines = [`# ${markdownText(name)}`, "", `- Version: ${markdownText(resolvedVersion)}`];
		if (description) lines.push(`- Description: ${markdownText(description)}`);
		if (license) lines.push(`- License: ${markdownText(license)}`);
		if (homepage && markdownUrl(homepage)) lines.push(`- Homepage: ${markdownUrl(homepage)}`);
		if (repository && markdownUrl(repository)) lines.push(`- Repository: ${markdownUrl(repository)}`);
		lines.push(`- Registry: ${registryUrl}`, "");
		let readmeTruncated = false;
		if (readme) {
			const boundedReadme = readme.length > MAX_README_CHARS ? `${readme.slice(0, MAX_README_CHARS)}\n\n[README truncated by npm registry adapter]` : readme;
			readmeTruncated = boundedReadme.length !== readme.length;
			lines.push("## README", "", boundedReadme);
		} else {
			lines.push("README unavailable in registry metadata. Use the registry or repository link above for package documentation.");
		}
		return {
			url: sourceUrl,
			title: `${name}@${resolvedVersion}`,
			content: lines.join("\n"),
			error: null,
			method: "npm-registry",
			fetchedAt: new Date().toISOString(),
			fetchedUrl: response.url || versionEndpoint,
			contentType: response.headers.get("content-type") || undefined,
			httpStatus: response.status,
			metadata: { npm: { name, version: resolvedVersion, description, homepage, repository, license, registryUrl, readmeAvailable: !!readme, readmeTruncated } },
		};
	} catch (err) {
		const message = options.signal?.aborted ? "Aborted" : (err instanceof Error ? err.message : String(err));
		return errorResult(sourceUrl, message);
	}
}

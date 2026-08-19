import { lookup as dnsLookup } from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import { Agent } from "undici";

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = ["authorization", "cookie", "proxy-authorization"];

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;
type Fetch = typeof fetch;

interface ValidationOptions {
	lookup?: Lookup;
	signal?: AbortSignal;
	/** Strict CIDRs exempted from private/special-use-address blocking. */
	allowRanges?: string[];
}

interface ValidatedTarget {
	url: URL;
	hostname: string;
	addresses: LookupAddress[];
}

interface ParsedCidr {
	bytes: Uint8Array;
	prefix: number;
}

interface FetchRemoteOptions extends ValidationOptions {
	fetch?: Fetch;
	maxRedirects?: number;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
	return dnsLookup(hostname, { all: true, verbatim: true });
}

function waitForLookup(promise: Promise<LookupAddress[]>, signal?: AbortSignal): Promise<LookupAddress[]> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function validateTarget(rawUrl: string | URL, options: ValidationOptions = {}): Promise<ValidatedTarget> {
	const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
	}

	const hostname = normalizeHostname(url.hostname);
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error(`Blocked internal hostname: ${hostname}`);
	}

	const allowRanges = parseAllowRanges(options.allowRanges);
	const ipVersion = net.isIP(hostname);
	if (ipVersion) {
		assertPublicAddress(hostname, hostname, allowRanges);
		return { url, hostname, addresses: [{ address: hostname, family: ipVersion }] };
	}

	let resolved: LookupAddress[];
	try {
		options.signal?.throwIfAborted();
		const lookupPromise = (options.lookup ?? defaultLookup)(hostname);
		resolved = await waitForLookup(lookupPromise, options.signal);
	} catch (err) {
		if (options.signal?.aborted) throw options.signal.reason ?? err;
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve ${hostname}: ${message}`);
	}
	if (resolved.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);

	const addresses: LookupAddress[] = [];
	const seen = new Set<string>();
	for (const { address } of resolved) {
		assertPublicAddress(address, hostname, allowRanges);
		const normalized = normalizeHostname(address);
		const family = net.isIP(normalized);
		const key = `${family}:${normalized}`;
		if (!seen.has(key)) {
			seen.add(key);
			addresses.push({ address: normalized, family });
		}
	}
	return { url, hostname, addresses };
}

export async function validateRemoteUrl(rawUrl: string | URL, options: ValidationOptions = {}): Promise<URL> {
	return (await validateTarget(rawUrl, options)).url;
}

/** Validate an original URL before disclosing it to a third-party fetch service. */
export function validateThirdPartySourceUrl(
	rawUrl: string | URL,
	options: { lookup?: Lookup; signal?: AbortSignal } = {},
): Promise<URL> {
	return validateRemoteUrl(rawUrl, { lookup: options.lookup, signal: options.signal });
}

/** A Node-compatible lookup that can return only the addresses validated for this request hop. */
export function createPinnedLookup(target: { hostname: string; addresses: LookupAddress[] }): LookupFunction {
	const expectedHostname = normalizeHostname(target.hostname);
	const addresses = target.addresses.map(({ address, family }) => ({ address, family }));
	return (hostname, options, callback): void => {
		if (normalizeHostname(hostname) !== expectedHostname) {
			callback(new Error(`Pinned DNS lookup rejected unexpected hostname: ${hostname}`), options.all ? [] : "");
			return;
		}
		const requestedFamily = Number(options.family ?? 0);
		const matching = requestedFamily === 4 || requestedFamily === 6
			? addresses.filter(item => item.family === requestedFamily)
			: addresses;
		if (matching.length === 0) {
			callback(Object.assign(new Error(`No pinned address for ${hostname} with family ${requestedFamily}`), { code: "ENOTFOUND" }), options.all ? [] : "");
			return;
		}
		if (options.all) callback(null, matching.map(item => ({ ...item })));
		else callback(null, matching[0].address, matching[0].family);
	};
}

export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
	options: FetchRemoteOptions = {},
): Promise<Response> {
	const fetchImpl = options.fetch ?? fetch;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const validationOptions = { ...options, signal: init.signal ?? options.signal };
	let target = await validateTarget(url, validationOptions);
	let requestInit = init;

	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const agent = new Agent({ connect: { lookup: createPinnedLookup(target) } });
		let closed = false;
		const closeAgent = () => {
			if (closed) return;
			closed = true;
			void agent.close().catch(() => {});
		};
		const signal = requestInit.signal ?? options.signal;
		const onAbort = () => closeAgent();
		signal?.addEventListener("abort", onAbort, { once: true });

		let response: Response;
		try {
			response = await fetchImpl(target.url, { ...requestInit, redirect: "manual", dispatcher: agent } as RequestInit);
		} catch (error) {
			signal?.removeEventListener("abort", onAbort);
			closeAgent();
			throw error;
		}

		if (!REDIRECT_STATUSES.has(response.status) || !response.headers.get("location")) {
			return responseWithAgentLifecycle(response, closeAgent, () => signal?.removeEventListener("abort", onAbort));
		}

		const location = response.headers.get("location")!;
		await response.body?.cancel().catch(() => {});
		signal?.removeEventListener("abort", onAbort);
		closeAgent();
		if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${target.url.toString()}`);

		const nextTarget = await validateTarget(new URL(location, target.url), validationOptions);
		if (nextTarget.url.origin !== target.url.origin) requestInit = stripSensitiveHeaders(requestInit);
		target = nextTarget;
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}
	throw new Error(`Too many redirects fetching ${target.url.toString()}`);
}

function stripSensitiveHeaders(init: RequestInit): RequestInit {
	if (!init.headers) return init;
	const headers = new Headers(init.headers);
	for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
	return { ...init, headers };
}

function responseWithAgentLifecycle(response: Response, close: () => void, cleanup: () => void): Response {
	if (!response.body) {
		cleanup();
		close();
		return response;
	}
	const reader = response.body.getReader();
	let finalized = false;
	const finalize = () => {
		if (finalized) return;
		finalized = true;
		cleanup();
		close();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					controller.close();
					finalize();
				} else controller.enqueue(result.value);
			} catch (error) {
				controller.error(error);
				finalize();
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				finalize();
			}
		},
	});
	const wrapped = new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
	for (const property of ["url", "redirected", "type"] as const) {
		Object.defineProperty(wrapped, property, { configurable: true, value: response[property] });
	}
	return wrapped;
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function assertPublicAddress(address: string, hostname: string, allowRanges: ParsedCidr[] = []): void {
	const normalized = normalizeHostname(address);
	const ipVersion = net.isIP(normalized);
	if (ipVersion === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
	if (isInAllowedRange(normalized, ipVersion, allowRanges)) return;
	if (ipVersion === 4 && isBlockedIPv4(normalized)) throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
	if (ipVersion === 6 && isBlockedIPv6(normalized)) throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
}

function isBlockedIPv4(address: string): boolean {
	const parts = address.split(".").map(part => Number(part));
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return a === 0 || a === 10 || a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224;
}

function isBlockedIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;
	const first = groups[0];
	if (groups.every(group => group === 0)) return true;
	if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true;
	if ((first & 0xfe00) === 0xfc00) return true;
	if ((first & 0xffc0) === 0xfe80) return true;
	const isMappedIPv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
	if (isMappedIPv4) {
		const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
		return isBlockedIPv4(ipv4);
	}
	return false;
}

function parseIPv6(input: string): number[] | null {
	let address = input;
	if (address.includes(".")) {
		const lastColon = address.lastIndexOf(":");
		const ipv4 = address.slice(lastColon + 1);
		if (net.isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map(part => Number(part));
		address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const pieces = address.split("::");
	if (pieces.length > 2) return null;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 0) return null;
	const groups = [...left, ...Array(missing).fill("0"), ...right].map(part => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return parseInt(part, 16);
	});
	return groups.length === 8 && groups.every(group => group >= 0 && group <= 0xffff) ? groups : null;
}

function parseAllowRanges(input: unknown): ParsedCidr[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) throw new Error("ssrf.allowRanges must be an array of CIDR strings");
	const rules: ParsedCidr[] = [];
	for (const entry of input) {
		if (typeof entry !== "string") throw new Error(`ssrf.allowRanges entries must be strings, got ${typeof entry}`);
		const rule = parseCidr(entry.trim());
		if (!rule) throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
		rules.push(rule);
	}
	return rules;
}

function parseCidr(raw: string): ParsedCidr | null {
	if (!raw) return null;
	const slash = raw.lastIndexOf("/");
	const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
	const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
	if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;
	const version = net.isIP(addrPart);
	if (version === 4) {
		const bytes = ipv4ToBytes(addrPart);
		if (!bytes) return null;
		const prefix = prefixPart === null ? 32 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
		return { bytes, prefix };
	}
	if (version === 6) {
		const groups = parseIPv6(addrPart);
		if (!groups) return null;
		const prefix = prefixPart === null ? 128 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
		return { bytes: ipv6GroupsToBytes(groups), prefix };
	}
	return null;
}

function ipv4ToBytes(address: string): Uint8Array | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const octet = Number(parts[i]);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
		bytes[i] = octet;
	}
	return bytes;
}

function ipv6GroupsToBytes(groups: number[]): Uint8Array {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		bytes[i * 2] = groups[i] >> 8;
		bytes[i * 2 + 1] = groups[i] & 0xff;
	}
	return bytes;
}

function ipToBytes(address: string, version: number): Uint8Array | null {
	if (version === 4) return ipv4ToBytes(address);
	if (version === 6) {
		const groups = parseIPv6(address);
		return groups ? ipv6GroupsToBytes(groups) : null;
	}
	return null;
}

function isInAllowedRange(address: string, ipVersion: number, allowRanges: ParsedCidr[]): boolean {
	if (allowRanges.length === 0) return false;
	const addrBytes = ipToBytes(address, ipVersion);
	if (!addrBytes) return false;
	for (const rule of allowRanges) {
		if (rule.bytes.length !== addrBytes.length) continue;
		if (bytesMatchPrefix(addrBytes, rule.bytes, rule.prefix)) return true;
	}
	return false;
}

function bytesMatchPrefix(addr: Uint8Array, network: Uint8Array, prefix: number): boolean {
	const fullBytes = prefix >> 3;
	const remBits = prefix & 7;
	for (let i = 0; i < fullBytes; i++) if (addr[i] !== network[i]) return false;
	if (remBits > 0 && fullBytes < addr.length) {
		const mask = (0xff << (8 - remBits)) & 0xff;
		if ((addr[fullBytes] & mask) !== (network[fullBytes] & mask)) return false;
	}
	return true;
}

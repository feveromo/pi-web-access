import { isIP } from "node:net";

export class ResponseTooLargeError extends Error {
	constructor(limitBytes, receivedBytes) {
		const received = receivedBytes == null ? "" : ` after ${formatBytes(receivedBytes)}`;
		super(`Response too large (limit ${formatBytes(limitBytes)}${received})`);
		this.name = "ResponseTooLargeError";
		this.limitBytes = limitBytes;
		this.receivedBytes = receivedBytes;
	}
}

export function requestSignal(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function isAbortError(err) {
	if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

export async function readResponseBytes(response, maxBytes) {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive finite number");
	const limit = Math.floor(maxBytes);
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel().catch(() => {});
		throw new ResponseTooLargeError(limit, declared);
	}
	if (!response.body) return new Uint8Array();

	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				throw new ResponseTooLargeError(limit, total);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

export async function readResponseText(response, maxBytes) {
	return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
}

export async function readResponseJson(response, maxBytes) {
	return JSON.parse(await readResponseText(response, maxBytes));
}

export async function readErrorSnippet(response, maxChars = 250, maxBytes = 16 * 1024) {
	try {
		return (await readResponseText(response, maxBytes)).replace(/\s+/g, " ").trim().slice(0, maxChars);
	} catch {
		return "";
	}
}

export function uint8ArrayToArrayBuffer(bytes) {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function isSafeForThirdPartyFetch(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (url.username || url.password) return false;
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (isPrivateHostname(hostname)) return false;
	for (const key of url.searchParams.keys()) {
		if (/^(?:auth|key|sig)$/i.test(key)
			|| /(?:token|secret|signature|credential|password|api[_-]?key|authorization|oauth|jwt|x-amz-|x-goog-)/i.test(key)) return false;
	}
	return true;
}

function isPrivateHostname(hostname) {
	if (!hostname) return true;
	if (hostname === "localhost" || /\.(?:localhost|local|internal|lan|home)$/.test(hostname)) return true;
	const version = isIP(hostname);
	if (version === 4) return isPrivateIpv4(hostname);
	if (version !== 6) return false;
	if (hostname === "::" || hostname === "::1" || /^(?:fc|fd|fe[89ab])/.test(hostname)) return true;
	const mapped = mappedIpv4(hostname);
	return mapped ? isPrivateIpv4(mapped) : false;
}

function isPrivateIpv4(hostname) {
	const [a, b] = hostname.split(".").map(Number);
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function mappedIpv4(hostname) {
	if (!hostname.startsWith("::ffff:")) return null;
	const tail = hostname.slice("::ffff:".length);
	if (isIP(tail) === 4) return tail;
	const parts = tail.split(":");
	if (parts.length !== 2 || !parts.every(part => /^[0-9a-f]{1,4}$/i.test(part))) return null;
	const high = Number.parseInt(parts[0], 16);
	const low = Number.parseInt(parts[1], 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
	return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

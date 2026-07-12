import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ENVELOPE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MEMORY_ENTRIES = 100;
const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const OWNED_FILE = /^([a-z][a-z0-9-]{0,47})-([a-f0-9]{64})\.cache\.json$/;
const OWNED_TEMP = /^([a-z][a-z0-9-]{0,47})-([a-f0-9]{64})\.cache\.json\.tmp-([0-9]+)-([a-f0-9]{12})$/;

export const RESEARCH_CACHE_DIR = process.env.PI_WEB_ACCESS_RESEARCH_CACHE_DIR?.trim()
	|| join(homedir(), ".pi", "web-access", "research-cache");

function abortReason(signal) {
	return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

export function isTransientCacheError(error) {
	let current = error;
	for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
		if (current.name === "AbortError" && current.timeout !== true) return false;
		if (current.name === "SSRFError") return false;
		const status = Number(current.status ?? current.statusCode);
		if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
		if (current.name === "TimeoutError" || current.timeout === true || TRANSIENT_CODES.has(String(current.code ?? ""))) return true;
		current = current.cause;
	}
	return false;
}

export function cacheFreshnessFromHeaders(headers, fallbackMs = 6 * 60 * 60 * 1000, capMs = 24 * 60 * 60 * 1000) {
	const control = headers?.get?.("cache-control") ?? "";
	const directives = new Map(String(control).split(",").map(item => {
		const [name, raw] = item.trim().toLowerCase().split("=", 2);
		return [name, raw?.replace(/^"|"$/g, "")];
	}));
	if (directives.has("no-store") || directives.has("private")) return { persist: false, freshMs: 0 };
	if (directives.has("no-cache")) return { persist: true, freshMs: 0 };
	const raw = directives.get("s-maxage") ?? directives.get("max-age");
	const seconds = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
	return { persist: true, freshMs: Math.min(capMs, seconds === null ? fallbackMs : seconds * 1000) };
}

function byteSize(value) {
	try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
	catch { return Number.POSITIVE_INFINITY; }
}

function validEnvelope(value, namespace, keyHash, maxValueBytes, validate) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (value.version !== ENVELOPE_VERSION || value.namespace !== namespace || value.keyHash !== keyHash) return false;
	if (!Number.isFinite(value.storedAt) || !Number.isFinite(value.freshUntil) || !Number.isFinite(value.staleUntil)) return false;
	if (value.storedAt > value.freshUntil || value.freshUntil > value.staleUntil || value.storedAt > Date.now() + 60_000) return false;
	if (byteSize(value.value) > maxValueBytes) return false;
	try { return validate(value.value) === true; } catch { return false; }
}

function metadata(status, storage, envelope, shared = false, now = Date.now()) {
	return {
		status,
		ageMs: envelope ? Math.max(0, now - envelope.storedAt) : 0,
		storage,
		freshUntil: envelope?.freshUntil ?? null,
		staleUntil: envelope?.staleUntil ?? null,
		shared,
	};
}

export function createPersistentCache(options) {
	const namespace = String(options?.namespace ?? "");
	if (!/^[a-z][a-z0-9-]{0,47}$/.test(namespace)) throw new TypeError("Invalid persistent cache namespace");
	const root = resolve(options.root || RESEARCH_CACHE_DIR);
	const defaultFreshMs = Math.max(0, Number(options.freshMs) || 0);
	const defaultStaleMs = Math.max(defaultFreshMs, Number(options.staleMs ?? options.freshMs) || 0);
	const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
	const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
	const globalMaxEntries = Math.min(DEFAULT_MAX_ENTRIES, Math.max(maxEntries, Number(options.globalMaxEntries) || DEFAULT_MAX_ENTRIES));
	const globalMaxBytes = Math.min(DEFAULT_MAX_BYTES, Math.max(maxBytes, Number(options.globalMaxBytes) || DEFAULT_MAX_BYTES));
	const memoryMaxEntries = Math.max(1, Number(options.memoryMaxEntries) || Math.min(DEFAULT_MEMORY_ENTRIES, maxEntries));
	const memoryMaxBytes = Math.max(1024, Number(options.memoryMaxBytes) || Math.min(DEFAULT_MEMORY_BYTES, maxBytes));
	const maxValueBytes = Math.max(1024, Number(options.maxValueBytes) || maxBytes);
	const validate = options.validate || (() => true);
	const sizeOf = options.sizeOf || byteSize;
	const admit = options.admit || (() => true);
	const transient = options.isTransient || isTransientCacheError;
	const memory = new Map();
	const inFlight = new Map();
	let memoryBytes = 0;
	let prunePromise = null;
	let pruneDirty = false;

	async function safeRoot(create = false) {
		try {
			if (create) {
				let ancestor = root;
				while (true) {
					try { await lstat(ancestor); break; } catch {
						const parent = dirname(ancestor);
						if (parent === ancestor) return false;
						ancestor = parent;
					}
				}
				const ancestorStat = await lstat(ancestor);
				if (ancestorStat.isSymbolicLink() || await realpath(ancestor) !== resolve(ancestor)) return false;
				await mkdir(root, { recursive: true, mode: 0o700 });
			}
			const info = await lstat(root);
			return info.isDirectory() && !info.isSymbolicLink() && await realpath(root) === root;
		} catch { return false; }
	}

	const digest = key => createHash("sha256").update(`${namespace}\0${key}`).digest("hex");
	const pathForHash = hash => join(root, `${namespace}-${hash}.cache.json`);

	function removeMemory(key) {
		const old = memory.get(key);
		if (!old) return;
		memory.delete(key);
		memoryBytes -= old.bytes;
	}

	function putMemory(key, envelope) {
		let bytes;
		try { bytes = Math.max(0, Number(sizeOf(envelope.value)) || 0); } catch { return; }
		if (bytes > memoryMaxBytes) return;
		removeMemory(key);
		memory.set(key, { envelope, bytes });
		memoryBytes += bytes;
		while (memory.size > memoryMaxEntries || memoryBytes > memoryMaxBytes) removeMemory(memory.keys().next().value);
	}

	async function safeRead(key) {
		if (!await safeRoot(false)) return null;
		const hash = digest(key);
		const path = pathForHash(hash);
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > maxValueBytes + 4096) return null;
			const envelope = JSON.parse(await readFile(path, "utf8"));
			if (!validEnvelope(envelope, namespace, hash, maxValueBytes, validate)) {
				await rm(path, { force: true }).catch(() => {});
				return null;
			}
			return envelope;
		} catch { return null; }
	}

	async function safeWrite(key, envelope) {
		const hash = digest(key);
		const path = pathForHash(hash);
		let body;
		try { body = JSON.stringify(envelope); } catch { return false; }
		if (Buffer.byteLength(body) > maxValueBytes + 4096) return false;
		let temp;
		try {
			if (!await safeRoot(true)) return false;
			temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
			await writeFile(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temp, path);
			temp = null;
			await prune();
			return true;
		} catch {
			if (temp) await rm(temp, { force: true }).catch(() => {});
			return false;
		}
	}

	async function lookup(key, now = Date.now()) {
		let envelope = memory.get(key)?.envelope;
		let storage = "memory";
		if (envelope && envelope.staleUntil <= now) {
			removeMemory(key);
			envelope = null;
		}
		if (!envelope) {
			envelope = await safeRead(key);
			storage = "disk";
			if (envelope) putMemory(key, envelope);
		}
		if (!envelope) return { state: "miss", value: null, metadata: metadata("miss", "none", null) };
		if (envelope.staleUntil <= now) {
			removeMemory(key);
			if (await safeRoot(false)) await rm(pathForHash(digest(key)), { force: true }).catch(() => {});
			return { state: "miss", value: null, metadata: metadata("miss", "none", null) };
		}
		const state = envelope.freshUntil > now ? "fresh" : "stale";
		if (storage === "memory") { removeMemory(key); putMemory(key, envelope); }
		return { state, value: envelope.value, envelope, metadata: metadata(state, storage, envelope) };
	}

	async function wait(task, signal, onEmpty) {
		signal?.throwIfAborted();
		task.waiters++;
		try {
			if (!signal) return await task.promise;
			return await new Promise((resolve, reject) => {
				const onAbort = () => reject(abortReason(signal));
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
				task.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
			});
		} finally {
			task.waiters--;
			if (!task.settled && task.waiters === 0) {
				onEmpty?.();
				task.controller.abort();
			}
		}
	}

	async function set(key, value, policy = {}) {
		if (typeof key !== "string" || !key || key.length > 16_384) return false;
		let allowed = false;
		try { allowed = validate(value) === true && admit(value, policy) === true; } catch {}
		if (!allowed || byteSize(value) > maxValueBytes) return false;
		const now = Number(policy.now) || Date.now();
		const freshMs = Math.max(0, Number(policy.freshMs ?? defaultFreshMs) || 0);
		const staleMs = Math.max(freshMs, Number(policy.staleMs ?? defaultStaleMs) || 0);
		const envelope = { version: ENVELOPE_VERSION, namespace, keyHash: digest(key), storedAt: now, freshUntil: now + freshMs, staleUntil: now + staleMs, value };
		putMemory(key, envelope);
		return safeWrite(key, envelope);
	}

	async function get(key, loader, request = {}) {
		request.signal?.throwIfAborted();
		if (typeof key !== "string" || !key || key.length > 16_384) throw new TypeError("Invalid persistent cache key");
		const cached = await lookup(key);
		if (cached.state === "fresh" || typeof loader !== "function") return cached;
		let task = inFlight.get(key);
		const shared = !!task;
		if (!task) {
			const controller = new AbortController();
			task = { controller, waiters: 0, settled: false, promise: null };
			const current = task;
			task.promise = Promise.resolve().then(() => loader(controller.signal)).then(async loaded => {
				controller.signal.throwIfAborted();
				const value = loaded && typeof loaded === "object" && Object.hasOwn(loaded, "value") ? loaded.value : loaded;
				const loadedPolicy = loaded && typeof loaded === "object" && Object.hasOwn(loaded, "value") ? loaded : {};
				const policy = { freshMs: request.freshMs, staleMs: request.staleMs, ...loadedPolicy };
				const persisted = policy.persist !== false && await set(key, value, policy);
				const now = Date.now();
				const envelope = memory.get(key)?.envelope;
				return { state: "miss", value, metadata: metadata("miss", persisted ? "network" : "none", envelope, false, now) };
			}).catch(error => {
				if (cached.state === "stale" && request.staleOnError !== false && transient(error)) {
					return { state: "stale", value: cached.value, metadata: { ...cached.metadata, status: "stale", shared: false, warning: `Using stale cached data after transient refresh failure: ${error instanceof Error ? error.message : String(error)}` } };
				}
				throw error;
			}).finally(() => {
				current.settled = true;
				if (inFlight.get(key) === current) inFlight.delete(key);
			});
			task.promise.catch(() => {});
			inFlight.set(key, task);
		}
		const current = task;
		const result = await wait(task, request.signal, () => {
			if (inFlight.get(key) === current) inFlight.delete(key);
		});
		return { ...result, metadata: { ...result.metadata, shared } };
	}

	async function deleteKey(key) {
		removeMemory(key);
		if (await safeRoot(false)) await rm(pathForHash(digest(key)), { force: true }).catch(() => {});
	}

	async function runPrune(now = Date.now()) {
		if (!await safeRoot(false)) return { removed: 0, entries: 0, bytes: 0 };
		let names;
		try { names = await readdir(root); } catch { return { removed: 0, entries: 0, bytes: 0 }; }
		const entries = [];
		let removed = 0;
		for (const name of names) {
			const tempMatch = OWNED_TEMP.exec(name);
			if (tempMatch) {
				const path = join(root, name);
				try { const info = await lstat(path); if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs > 60 * 60 * 1000) { await rm(path, { force: true }); removed++; } } catch {}
				continue;
			}
			const match = OWNED_FILE.exec(name);
			if (!match) continue;
			const path = join(root, name);
			try {
				const info = await lstat(path);
				if (!info.isFile() || info.isSymbolicLink()) continue;
				let staleUntil = Number.POSITIVE_INFINITY;
				if (info.size <= 32 * 1024 * 1024) {
					try { staleUntil = Number(JSON.parse(await readFile(path, "utf8"))?.staleUntil) || 0; } catch { staleUntil = 0; }
				}
				if (staleUntil <= now) { await rm(path, { force: true }); removed++; continue; }
				entries.push({ path, namespace: match[1], bytes: info.size, mtimeMs: info.mtimeMs });
			} catch {}
		}
		const remove = async entry => { await rm(entry.path, { force: true }).catch(() => {}); const at = entries.indexOf(entry); if (at >= 0) entries.splice(at, 1); removed++; };
		const own = entries.filter(entry => entry.namespace === namespace).sort((a, b) => a.mtimeMs - b.mtimeMs);
		let ownBytes = own.reduce((sum, entry) => sum + entry.bytes, 0);
		while (own.length > maxEntries || ownBytes > maxBytes) { const entry = own.shift(); ownBytes -= entry.bytes; await remove(entry); }
		entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
		let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
		while (entries.length > globalMaxEntries || bytes > globalMaxBytes) { const entry = entries[0]; bytes -= entry.bytes; await remove(entry); }
		return { removed, entries: entries.length, bytes };
	}

	function prune(now) {
		pruneDirty = true;
		if (!prunePromise) prunePromise = (async () => {
			let result = { removed: 0, entries: 0, bytes: 0 };
			do { pruneDirty = false; result = await runPrune(now); } while (pruneDirty);
			return result;
		})().finally(() => { prunePromise = null; });
		return prunePromise;
	}

	queueMicrotask(() => { void prune(); });

	return {
		get, lookup, set, delete: deleteKey, prune,
		clearMemory() { memory.clear(); memoryBytes = 0; },
		stats() { return { entries: memory.size, bytes: memoryBytes, inFlight: inFlight.size }; },
		pathForKey(key) { return pathForHash(digest(key)); },
	};
}

function abortReason(signal) {
	return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

export function createRawExtractionCache({ ttlMs, maxEntries, maxBytes, sizeOf, shouldCache = () => true }) {
	const cache = new Map();
	const inFlight = new Map();
	let totalBytes = 0;

	function prune(now = Date.now()) {
		for (const [key, entry] of cache) {
			if (now - entry.storedAt < ttlMs) continue;
			cache.delete(key);
			totalBytes -= entry.bytes;
		}
		while (cache.size > maxEntries || totalBytes > maxBytes) {
			const key = cache.keys().next().value;
			if (key === undefined) break;
			const entry = cache.get(key);
			cache.delete(key);
			totalBytes -= entry?.bytes ?? 0;
		}
	}

	async function waitFor(task, signal) {
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
			if (task.waiters === 0) task.controller.abort();
		}
	}

	async function get(key, loader, signal) {
		signal?.throwIfAborted();
		const now = Date.now();
		prune(now);
		const cached = cache.get(key);
		if (cached) {
			cache.delete(key);
			cache.set(key, cached);
			return { value: cached.value, cacheHit: true, cacheAgeMs: now - cached.storedAt, shared: false };
		}

		let task = inFlight.get(key);
		const shared = !!task;
		if (!task) {
			const controller = new AbortController();
			task = { controller, waiters: 0, promise: null };
			const current = task;
			task.promise = Promise.resolve()
				.then(() => loader(controller.signal))
				.then(value => {
					controller.signal.throwIfAborted();
					let admitted = false;
					try { admitted = shouldCache(value) === true; }
					catch { admitted = false; }
					let bytes = 0;
					if (admitted) {
						try { bytes = Math.max(0, Number(sizeOf(value)) || 0); }
						catch { admitted = false; }
					}
					if (admitted && bytes <= maxBytes) {
						cache.set(key, { value, bytes, storedAt: Date.now() });
						totalBytes += bytes;
						prune();
					}
					return value;
				})
				.finally(() => { if (inFlight.get(key) === current) inFlight.delete(key); });
			task.promise.catch(() => {});
			inFlight.set(key, task);
		}
		const value = await waitFor(task, signal);
		return { value, cacheHit: shared, cacheAgeMs: 0, shared };
	}

	return {
		get,
		clear() { cache.clear(); inFlight.clear(); totalBytes = 0; },
		stats() { prune(); return { entries: cache.size, bytes: totalBytes, inFlight: inFlight.size }; },
	};
}

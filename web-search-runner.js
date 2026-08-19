function abortReason(signal) {
	return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

export function createSearchScheduler(concurrency) {
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer");
	let active = 0;
	const queue = [];

	const pump = () => {
		while (active < concurrency && queue.length > 0) {
			const entry = queue.shift();
			if (entry.aborted) continue;
			entry.started = true;
			active++;
			Promise.resolve()
				.then(entry.task)
				.then(
					value => { if (!entry.aborted) entry.resolve(value); },
					err => { if (!entry.aborted) entry.reject(err); },
				)
				.finally(() => {
					active--;
					entry.signal?.removeEventListener("abort", entry.onAbort);
					pump();
				});
		}
	};

	return (task, signal) => {
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		return new Promise((resolve, reject) => {
			const entry = { task, signal, resolve, reject, started: false, aborted: false, onAbort: null };
			entry.onAbort = () => {
				entry.aborted = true;
				reject(abortReason(signal));
				if (!entry.started) {
					const index = queue.indexOf(entry);
					if (index >= 0) queue.splice(index, 1);
					signal.removeEventListener("abort", entry.onAbort);
				}
			};
			signal?.addEventListener("abort", entry.onAbort, { once: true });
			queue.push(entry);
			pump();
		});
	};
}

function scheduleWithAbort(schedule, task, signal) {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	const scheduled = Promise.resolve().then(() => schedule(task, signal));
	if (!signal) return scheduled;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		scheduled.then(
			value => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			err => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

export async function runSearchQueries({
	queries,
	search,
	schedule,
	signal,
	onUpdate,
	provider = "searxng",
}) {
	let completed = 0;
	return Promise.all(queries.map((query, index) => scheduleWithAbort(schedule, async () => {
		signal?.throwIfAborted();
		onUpdate?.({
			content: [{ type: "text", text: `Searching ${index + 1}/${queries.length}: "${query}"...` }],
			details: { phase: "search", progress: completed / queries.length, currentQuery: query },
		});
		try {
			const response = await search(query);
			return {
				query,
				answer: response.answer,
				results: response.results,
				error: null,
				provider,
				metadata: response.metadata,
			};
		} catch (err) {
			if (signal?.aborted) throw err;
			return {
				query,
				answer: "",
				results: [],
				error: err instanceof Error ? err.message : String(err),
				provider,
			};
		} finally {
			completed++;
			onUpdate?.({
				content: [{ type: "text", text: `Completed ${completed}/${queries.length} search(es)...` }],
				details: { phase: "search", progress: completed / queries.length },
			});
		}
	}, signal)));
}

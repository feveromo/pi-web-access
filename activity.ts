// Types
export interface ActivityEntry {
	id: string;
	type: "api" | "fetch" | "search";
	startTime: number;
	endTime?: number;

	// For API calls
	query?: string;

	// For URL fetches
	url?: string;

	// Result - status is number (HTTP code) or null (pending/network error)
	status: number | null;
	error?: string;
}

export class ActivityMonitor {
	private entries: ActivityEntry[] = [];
	private readonly maxEntries = 10;
	private listeners = new Set<() => void>();
	private nextId = 1;

	logStart(partial: Omit<ActivityEntry, "id" | "startTime" | "status">): string {
		const id = `act-${this.nextId++}`;
		const entry: ActivityEntry = {
			...partial,
			id,
			startTime: Date.now(),
			status: null,
		};
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.shift();
		}
		this.notify();
		return id;
	}

	logComplete(id: string, status: number): void {
		const entry = this.entries.find((e) => e.id === id);
		if (entry) {
			entry.endTime = Date.now();
			entry.status = status;
			this.notify();
		}
	}

	logError(id: string, error: string): void {
		const entry = this.entries.find((e) => e.id === id);
		if (entry) {
			entry.endTime = Date.now();
			entry.error = error;
			this.notify();
		}
	}

	getEntries(): readonly ActivityEntry[] {
		return this.entries;
	}

	onUpdate(callback: () => void): () => void {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	clear(): void {
		this.entries = [];
		this.notify();
	}

	private notify(): void {
		for (const cb of this.listeners) {
			try {
				cb();
			} catch {
			}
		}
	}
}

export const activityMonitor = new ActivityMonitor();

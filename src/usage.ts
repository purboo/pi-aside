// Accounting (docs/design.md §4.6): Pi usage entries for aside requests and tool results, written only while the
// main agent is idle, because a usage entry advances the session leaf.

export interface QueuedUsage {
	sessionId: string;
	provider: string;
	model: string;
	usage: unknown;
	note: string;
}

export interface UsageHost {
	/** Whether the main agent is idle, and the current session id; undefined when unavailable. */
	state(): { idle: boolean; sessionId: string } | undefined;
	append(entry: QueuedUsage): void;
}

export class UsageQueue {
	private queue: QueuedUsage[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	dropped = 0;

	constructor(private readonly host: UsageHost) {}

	get size(): number {
		return this.queue.length;
	}

	push(entry: QueuedUsage): void {
		this.queue.push(entry);
		this.drain();
		if (this.queue.length > 0 && !this.timer) {
			this.timer = setInterval(() => this.drain(), 250);
			this.timer.unref?.();
		}
	}

	/** Append every queued entry if the agent is idle in the entries' session. */
	drain(): void {
		if (this.queue.length === 0) {
			this.stop();
			return;
		}
		let state: { idle: boolean; sessionId: string } | undefined;
		try {
			state = this.host.state();
		} catch {
			state = undefined;
		}
		if (!state?.idle) return;
		const keep: QueuedUsage[] = [];
		for (const entry of this.queue) {
			if (entry.sessionId !== state.sessionId) {
				keep.push(entry);
				continue;
			}
			try {
				this.host.append(entry);
			} catch {
				keep.push(entry);
			}
		}
		this.queue = keep;
		if (this.queue.length === 0) this.stop();
	}

	/**
	 * Before a session switch, fork or shutdown: write the entries if the session is idle, otherwise drop and count
	 * them. Returns the number dropped.
	 */
	flushOrDrop(): number {
		this.drain();
		const dropped = this.queue.length;
		this.dropped += dropped;
		this.queue = [];
		this.stop();
		return dropped;
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

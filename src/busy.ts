// "Waiting" (docs/ux.md §3.1): Pi is idle, but an extension reports background work that will wake the agent.
// Convention on `pi.events`: an emitter sends `background-work` with `{ source, pending }` whenever its count changes,
// and again in reply to `background-work:query`.

export const BACKGROUND_WORK = "background-work";
export const BACKGROUND_WORK_QUERY = "background-work:query";

interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export class BackgroundWork {
	private counts = new Map<string, number>();
	private off: (() => void) | undefined;

	constructor(
		private readonly events: EventBus,
		private readonly onChange: () => void,
	) {
		this.off = events.on(BACKGROUND_WORK, (data) => this.receive(data));
	}

	private receive(data: unknown): void {
		if (!data || typeof data !== "object") return;
		const { source, pending } = data as { source?: unknown; pending?: unknown };
		if (typeof source !== "string" || source.length === 0) return;
		const count = typeof pending === "number" && Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0;
		const before = this.counts.get(source) ?? 0;
		if (count === 0) this.counts.delete(source);
		else this.counts.set(source, count);
		if (before !== count) this.onChange();
	}

	/** Pending work across all sources. */
	get pending(): number {
		let total = 0;
		for (const count of this.counts.values()) total += count;
		return total;
	}

	/** Clear every count (a session switch) and ask the emitters to report again. */
	reset(): void {
		const had = this.counts.size > 0;
		this.counts.clear();
		if (had) this.onChange();
		this.events.emit(BACKGROUND_WORK_QUERY, {});
	}

	dispose(): void {
		this.off?.();
		this.off = undefined;
	}
}

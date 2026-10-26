// The observation (docs/design.md §4.1): the request the main session actually sent (P), the transcript it was
// converted from (T), the frozen recipe, readiness and usage. One logical agent request L at a time.

import type { Payload } from "./payload.ts";

/** The frozen conversion inputs of one main request. */
export interface Recipe {
	provider: string;
	modelId: string;
	api: string;
	/** Effective reasoning level, undefined when thinking is off. */
	reasoning: string | undefined;
	sessionId: string;
	transport: string | undefined;
	thinkingBudgets: unknown;
	blockImages: boolean;
	/** The selection was a virtual model: the physical model comes from the provider stream. */
	virtual: boolean;
}

export type ObservationState = "open" | "promoted" | "ambiguous" | "failed";

export interface ObservedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export class Observation {
	readonly seq: number;
	/** T: the transcript as it reached conversion (after the handlers before pi-aside). */
	readonly transcript: unknown[];
	/** The session leaf when the request was prepared: G is what the branch gained after it. */
	readonly leafId: string | null;
	readonly recipe: Recipe;
	readonly openedAt = Date.now();
	state: ObservationState = "open";
	reason: string | undefined;
	/** H, R and S are ignored after L closes (on S, an error, the end of the run or a session event). */
	closed = false;
	/** The main assistant message ended, or the run did: readiness can no longer change. */
	ended = false;
	headerRef: Record<string, unknown> | undefined;
	headerCount = 0;
	attempts: unknown[] = [];
	/** P is the payload the handler chain returned (the tap), not the R event's object. */
	tapped = false;
	/** P, cloned on promotion. */
	payload: Payload | undefined;
	/** Header names observed on the promoted call (values are never kept). */
	headerNames: string[] = [];
	ready = false;
	usage: ObservedUsage | undefined;
	/** When the provider last read or wrote P's prefix: the main response, then every exact aside request. */
	lastUse: number | undefined;
	/** A compaction followed this request: it stays usable only while its cache is warm (`warm`). */
	compacted = false;
	private ttl: number | undefined;
	private listeners = new Set<() => void>();

	constructor(seq: number, transcript: unknown[], leafId: string | null, recipe: Recipe) {
		this.seq = seq;
		this.transcript = transcript;
		this.leafId = leafId;
		this.recipe = recipe;
	}

	/**
	 * Cacheable prefix the main response reported: cache read plus cache write. OpenAI APIs report no cache writes
	 * (the provider caches the prompt itself), so there it is the whole prompt.
	 */
	get cacheablePrefix(): number | undefined {
		if (!this.usage) return undefined;
		if (this.recipe.api.startsWith("openai-")) return this.usage.input + this.usage.cacheRead;
		return this.usage.cacheRead + this.usage.cacheWrite;
	}

	/** Whether waiting can still change this observation's usability. */
	get pending(): boolean {
		if (this.state === "open") return !this.closed;
		if (this.state === "promoted") return !this.ready && !this.ended;
		return false;
	}

	get usable(): boolean {
		return this.state === "promoted" && this.ready && this.payload !== undefined;
	}

	/** An exact aside request sent at `at` read P's prefix again, which renews its cache. */
	touch(at: number): void {
		if (this.lastUse === undefined || at > this.lastUse) this.lastUse = at;
	}

	/** Whether P's prefix is likely still cached: last used within its lifetime, less a margin for the request. */
	warm(now: number): boolean {
		if (this.lastUse === undefined || !this.payload) return false;
		this.ttl ??= cacheTtlMs(this.payload);
		return now - this.lastUse < this.ttl - WARM_MARGIN_MS;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(): void {
		for (const listener of [...this.listeners]) listener();
	}

	fail(state: "ambiguous" | "failed", reason: string): void {
		if (this.state === "open") {
			this.state = state;
			this.reason = reason;
		}
		this.closed = true;
		this.ended = true;
		this.changed();
	}
}

const MINUTE = 60_000;
const WARM_MARGIN_MS = 30_000;

/**
 * How long the provider keeps a prompt cached after its last use: 1 hour for Anthropic `ttl: "1h"` markers, 24
 * hours for OpenAI `prompt_cache_retention: "24h"`, otherwise 5 minutes (Anthropic's default, and the low end of
 * OpenAI's automatic caching).
 */
export function cacheTtlMs(payload: unknown): number {
	if ((payload as Record<string, unknown> | undefined)?.prompt_cache_retention === "24h") return 24 * 60 * MINUTE;
	return hasHourMarker(payload, 0) ? 60 * MINUTE : 5 * MINUTE;
}

function hasHourMarker(value: unknown, depth: number): boolean {
	if (depth > 6 || !value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => hasHourMarker(item, depth + 1));
	const marker = (value as Record<string, unknown>).cache_control as Record<string, unknown> | undefined;
	if (marker?.ttl === "1h") return true;
	return Object.values(value).some((item) => hasHourMarker(item, depth + 1));
}

export const NO_MAIN_REQUEST = "no main request observed yet";
export const COMPACTED = "the context was compacted and the agent has not sent it since";
export const COMPACTED_COLD = "the context was compacted and the main cache has expired";
export const COMPACTED_OVERFLOW = "the context was compacted because it no longer fit";

/** Tracks the latest logical request and the latest usable observation. */
export class Observer {
	private seq = 0;
	latest: Observation | undefined;
	/** The latest observation that became usable. */
	lastUsable: Observation | undefined;
	/** Why there is no observation since the last reset. */
	private missing: string | undefined;
	private generation = 0;
	private listeners = new Set<() => void>();

	/** Bumped on every reset; asides started before a reset are discarded. */
	get epoch(): number {
		return this.generation;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}

	reset(reason?: string): void {
		this.latest?.fail("failed", "session changed");
		this.latest = undefined;
		this.lastUsable = undefined;
		this.missing = reason;
		this.generation++;
		this.notify();
	}

	/**
	 * `session_compact`. The request sent before it is still a correct fork: P is what the provider saw, and G skips the
	 * compaction entry. It is kept while its cache is warm, so an aside reads it instead of writing the compacted context
	 * afresh. It is dropped after an overflow (the old context no longer fits), when it is cold (writing the smaller
	 * compacted context costs less), and when a request is still open.
	 */
	compacted(overflow: boolean, now = Date.now()): void {
		const kept = this.choose(now);
		if (overflow || !kept || this.latest?.pending || !kept.warm(now)) {
			this.reset(overflow ? COMPACTED_OVERFLOW : kept ? COMPACTED_COLD : COMPACTED);
			return;
		}
		kept.compacted = true;
		this.latest = kept;
		this.lastUsable = kept;
		this.notify();
	}

	/** `context_with_system`: opens L. */
	open(transcript: unknown[], leafId: string | null, recipe: Recipe): Observation {
		const previous = this.latest;
		if (previous && previous.pending) previous.fail("failed", "superseded by a newer request");
		const observation = new Observation(++this.seq, transcript, leafId, recipe);
		observation.onChange(() => this.notify());
		this.latest = observation;
		this.notify();
		return observation;
	}

	/** `before_provider_headers`. */
	headers(headers: Record<string, unknown>): void {
		const l = this.latest;
		if (!l || l.closed || l.state !== "open") return;
		l.headerCount++;
		if (l.headerCount > 1) {
			l.fail("ambiguous", "a second stream call started before the response");
			return;
		}
		l.headerRef = headers;
	}

	/** `before_provider_request`: one wire attempt, kept by reference. */
	request(payload: unknown): void {
		const l = this.latest;
		if (!l || l.closed || l.state !== "open") return;
		if (l.headerCount === 0) {
			l.fail("ambiguous", "a request without its stream call");
			return;
		}
		l.attempts.push(payload);
	}

	/** The final-payload tap: the payload the handler chain returned for the latest attempt. */
	finalPayload(payload: unknown): void {
		const l = this.latest;
		if (!l || l.closed || l.state !== "open" || l.attempts.length === 0) return;
		l.attempts[l.attempts.length - 1] = payload;
		l.tapped = true;
	}

	/** `after_provider_response`: promotes the latest attempt to P. */
	response(status: number): void {
		const l = this.latest;
		if (!l || l.closed || l.state !== "open") return;
		if (l.headerCount === 0 || l.attempts.length === 0) {
			l.fail("ambiguous", "a response without its request");
			return;
		}
		if (status < 200 || status >= 300) return;
		const attempt = l.attempts.at(-1);
		try {
			l.payload = structuredClone(attempt) as Payload;
		} catch {
			l.fail("failed", "the request could not be copied");
			return;
		}
		if (typeof l.payload !== "object" || l.payload === null || Array.isArray(l.payload)) {
			l.payload = undefined;
			l.fail("failed", "the request is not a JSON object");
			return;
		}
		l.headerNames = l.headerRef ? Object.keys(l.headerRef).filter((k) => l.headerRef![k] != null) : [];
		l.headerRef = undefined;
		l.attempts = [];
		// The provider has read P (and written its cache) by the time it answers.
		l.lastUse = Date.now();
		l.state = "promoted";
		l.closed = true;
		l.changed();
	}

	/** `cache_warming_decision`: a warmer replay inside an open L makes it ambiguous. */
	warming(): void {
		const l = this.latest;
		if (l && !l.closed && l.state === "open") l.fail("ambiguous", "a cache warmer replay overlapped the request");
	}

	/** The main assistant message started streaming. Anthropic reports the prompt's cache counts at the start. */
	assistantUpdate(usage?: ObservedUsage): void {
		const l = this.latest;
		if (!l || l.state !== "promoted" || l.ready) return;
		if (usage && !l.usage && usage.cacheRead + usage.cacheWrite > 0) l.usage = usage;
		l.ready = true;
		this.lastUsable = l;
		l.changed();
	}

	/** The main assistant message ended (completed, failed or aborted). */
	assistantEnd(usage: ObservedUsage | undefined, stopReason: string | undefined): void {
		const l = this.latest;
		if (!l) return;
		if (l.state === "promoted") {
			if (usage) l.usage = usage;
			if (!l.ready && stopReason !== "error" && stopReason !== "aborted") {
				l.ready = true;
				this.lastUsable = l;
			}
			l.closed = true;
			l.ended = true;
			l.changed();
			return;
		}
		if (l.state === "open") l.fail("failed", stopReason === "aborted" ? "the request was aborted" : "the request failed");
	}

	/** `agent_end`, or any other end of the run. */
	end(): void {
		const l = this.latest;
		if (!l) return;
		if (l.state === "open") l.fail("failed", "the run ended without a response");
		else if (!l.ended) {
			l.closed = true;
			l.ended = true;
			l.changed();
		}
	}

	/** Wait until the latest observation is no longer pending, or the signal aborts. */
	async settle(signal?: AbortSignal): Promise<void> {
		while (this.latest?.pending) {
			if (signal?.aborted) return;
			const l = this.latest;
			await new Promise<void>((resolve) => {
				const off = l.onChange(done);
				const offAll = this.onChange(done);
				const onAbort = () => done();
				signal?.addEventListener("abort", onAbort, { once: true });
				function done() {
					off();
					offAll();
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}
			});
		}
	}

	/**
	 * The observation an aside should fork from: the latest if usable, else the last usable one. One kept across a
	 * compaction counts only while its cache is warm.
	 */
	choose(now = Date.now()): Observation | undefined {
		const pick = this.latest?.usable ? this.latest : this.lastUsable?.usable ? this.lastUsable : undefined;
		if (pick?.compacted && !pick.warm(now)) return undefined;
		return pick;
	}

	/** Why `choose` has nothing: the latest request's failure, a cold compacted one, or the last reset. */
	whyNone(now = Date.now()): string {
		if (this.latest && !this.latest.usable && this.latest.reason) return this.latest.reason;
		const pick = this.latest?.usable ? this.latest : this.lastUsable;
		if (pick?.compacted && !pick.warm(now)) return COMPACTED_COLD;
		return this.missing ?? NO_MAIN_REQUEST;
	}
}

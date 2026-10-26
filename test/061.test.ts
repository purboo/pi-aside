// 0.6.1: an observation survives a compaction while its cache is warm; the detail line separates the first request.

import { describe, expect, test } from "bun:test";
import { gainedSince } from "../src/fork.ts";
import { cacheTtlMs, COMPACTED, COMPACTED_COLD, COMPACTED_OVERFLOW, NO_MAIN_REQUEST, Observer, type Recipe } from "../src/observe.ts";
import { detailLine, moneyLine } from "../src/panel.ts";

const recipe: Recipe = {
	provider: "p",
	modelId: "m",
	api: "anthropic-messages",
	reasoning: undefined,
	sessionId: "s",
	transport: "sse",
	thinkingBudgets: undefined,
	blockImages: false,
	virtual: false,
};
const MIN = 60_000;

/** An observer whose latest request was answered at `at` and is ready. */
function observed(at: number, payload: Record<string, unknown> = { messages: [] }): Observer {
	const o = new Observer();
	o.open([], "leaf", recipe);
	o.headers({});
	o.request(payload);
	o.response(200);
	o.assistantEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 100 }, "stop");
	o.latest!.lastUse = at;
	return o;
}

describe("compaction", () => {
	test("a warm observation is kept: same epoch, still chosen, until its cache would have expired", () => {
		const o = observed(1_000);
		const kept = o.latest!;
		const epoch = o.epoch;
		o.compacted(false, 1_000 + 1 * MIN);
		expect(o.epoch).toBe(epoch);
		expect(o.choose(1_000 + 1 * MIN)).toBe(kept);
		expect(kept.compacted).toBe(true);
		// 5 minutes less a 30 s margin.
		expect(o.choose(1_000 + 4 * MIN)).toBe(kept);
		expect(o.choose(1_000 + 4.6 * MIN)).toBeUndefined();
		expect(o.whyNone(1_000 + 4.6 * MIN)).toBe(COMPACTED_COLD);
	});

	test("each exact aside request renews it", () => {
		const o = observed(1_000);
		o.compacted(false, 1_000 + MIN);
		o.latest!.touch(1_000 + 4 * MIN);
		expect(o.choose(1_000 + 8 * MIN)).toBe(o.latest);
		o.latest!.touch(1_000 + 2 * MIN); // an older time does not move it back
		expect(o.choose(1_000 + 8 * MIN)).toBe(o.latest);
	});

	test("a cold one, an overflow, or none at all is dropped with a reason the reader shows", () => {
		const cold = observed(1_000);
		const epoch = cold.epoch;
		cold.compacted(false, 1_000 + 6 * MIN);
		expect(cold.choose(1_000 + 6 * MIN)).toBeUndefined();
		expect(cold.epoch).toBe(epoch + 1);
		expect(cold.whyNone()).toBe(COMPACTED_COLD);

		const overflow = observed(1_000);
		overflow.compacted(true, 1_000 + 10_000);
		expect(overflow.choose(1_000 + 10_000)).toBeUndefined();
		expect(overflow.whyNone()).toBe(COMPACTED_OVERFLOW);

		const none = new Observer();
		expect(none.whyNone()).toBe(NO_MAIN_REQUEST);
		none.compacted(false);
		expect(none.whyNone()).toBe(COMPACTED);
		none.reset("the session moved in its tree");
		expect(none.whyNone()).toBe("the session moved in its tree");
	});

	test("an open request is not kept across a compaction", () => {
		const o = observed(1_000);
		o.open([], "leaf2", recipe);
		o.compacted(false, 1_000 + 10_000);
		expect(o.choose(1_000 + 10_000)).toBeUndefined();
	});

	test("the next main request replaces the kept one", () => {
		const o = observed(1_000);
		o.compacted(false, 1_000 + MIN);
		o.open([], "leaf3", recipe);
		o.headers({});
		o.request({ messages: [1] });
		o.response(200);
		o.assistantUpdate();
		expect(o.choose()).toBe(o.latest);
		expect(o.latest!.compacted).toBe(false);
	});

	test("cache lifetime from P: Anthropic 1h markers, OpenAI 24h retention, else 5 minutes", () => {
		expect(cacheTtlMs({ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] })).toBe(5 * MIN);
		expect(cacheTtlMs({ system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] })).toBe(60 * MIN);
		expect(cacheTtlMs({ input: [], prompt_cache_retention: "24h" })).toBe(24 * 60 * MIN);
		const o = observed(1_000, { system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] });
		o.compacted(false, 1_000 + 30 * MIN);
		expect(o.choose(1_000 + 30 * MIN)).toBe(o.latest);
	});

	test("G skips a compaction after the observed leaf: T already holds what its summary covers", () => {
		const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text, timestamp: 1 } });
		const branch = [
			user("a", "before"),
			{ type: "compaction", id: "c", summary: "SUMMARY", firstKeptEntryId: "a", tokensBefore: 10 },
			{ type: "context_edit", id: "e", targetId: "a", replacement: {} },
			user("b", "after"),
		];
		const gained = gainedSince({ getBranch: () => branch }, "a") as Array<{ content: unknown }>;
		expect(gained.map((m) => m.content)).toEqual(["after"]);
		expect(JSON.stringify(gained)).not.toContain("SUMMARY");
	});
});

describe("detail line", () => {
	const base = { question: "q", raw: "", done: true, steps: [], startedAt: 0 };

	test("the first request shows whether the main cache was read; the totals follow when tools made more requests", () => {
		const rebuilt = {
			...base,
			tier: "rebuilt" as const,
			reason: COMPACTED,
			cost: 0,
			read: 594_175,
			written: 49_221,
			requests: 4,
			first: { read: 115_052, written: 38_223 },
		};
		expect(detailLine(rebuilt)).toBe(
			`rebuilt (${COMPACTED}) · read 115,052, wrote 38,223 · 4 requests: read 594,175, wrote 49,221 · no prices set for this model`,
		);
		const exact = { ...base, tier: "exact" as const, cost: 0.12, predicted: 175_473, read: 1_000_000, written: 13_000, requests: 6, first: { read: 175_473, written: 3_749 } };
		expect(detailLine(exact)).toBe("exact · read 175,473 of 175,473 cacheable, wrote 3,749 · 6 requests: read 1,000,000, wrote 13,000 · $0.120");
		const one = { ...base, tier: "exact" as const, cost: 0.03, predicted: 2_935, read: 2_935, written: 0, requests: 1, first: { read: 2_935, written: 0 } };
		expect(detailLine(one)).toBe("exact · read 2,935 of 2,935 cacheable · $0.030");
	});

	test("the money line judges an expired main cache by the first request, not the tool rounds' writes", () => {
		const warm = { ...base, tier: "exact" as const, cost: 0.4, read: 900_000, written: 20_000, requests: 8, first: { read: 150_000, written: 2_000 } };
		expect(moneyLine(warm)).toBeUndefined();
		const expired = { ...warm, first: { read: 0, written: 150_000 } };
		expect(moneyLine(expired)).toContain("main cache had expired");
	});
});

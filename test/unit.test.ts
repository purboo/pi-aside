import { describe, expect, test } from "bun:test";
import { BackgroundWork } from "../src/busy.ts";
import { STILL_RUNNING, withPlaceholders } from "../src/fork.ts";
import { Observer, type Recipe } from "../src/observe.ts";
import { moneyLine } from "../src/panel.ts";
import {
	applyDelta,
	checkC1,
	checkC2,
	checkC3,
	countMarkers,
	diffTopLevel,
	extendsList,
	splitList,
	strip,
} from "../src/payload.ts";
import { notice } from "../src/thread.ts";
import { UsageQueue } from "../src/usage.ts";

const A = "anthropic-messages";
const R = "openai-responses";
const cc = { type: "ephemeral" };

function anthropicP() {
	return {
		model: "m",
		max_tokens: 100,
		stream: true,
		system: [{ type: "text", text: "sys", cache_control: cc }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: [{ type: "text", text: "next", cache_control: cc }] },
		],
		metadata: { user_id: "u1" },
	};
}

describe("strip and lists", () => {
	test("strip removes markers and turns string content into a text block", () => {
		expect(strip({ role: "user", content: "x", cache_control: cc })).toEqual({ role: "user", content: [{ type: "text", text: "x" }] });
		expect(strip([{ a: { cache_control: cc, b: 1 } }])).toEqual([{ a: { b: 1 } }]);
	});

	test("extendsList allows the last element to be extended by appended blocks of the same message", () => {
		const base = [{ role: "user", content: [{ type: "text", text: "a" }] }];
		const longer = [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "q" }] }];
		expect(extendsList(longer, base)).toBe(true);
		expect(extendsList(base, longer)).toBe(false);
		expect(extendsList([{ role: "user", content: [{ type: "text", text: "b" }] }], base)).toBe(false);
		expect(extendsList([...base, { role: "assistant", content: [] }], base)).toBe(true);
	});

	test("splitList separates trailing configuration items (E)", () => {
		const e = { role: "system", content: [], output_config: { effort: "high" } };
		const p = { messages: [{ role: "user", content: [] }, e] };
		expect(splitList(A, p)).toEqual({ core: [{ role: "user", content: [] }], config: [e] });
		const r = { input: [{ role: "user" }, { type: "configuration_update", reasoning: { effort: "high" } }] };
		expect(splitList(R, r)!.config.length).toBe(1);
		expect(splitList("google-generative-ai", p)).toBeUndefined();
	});

	test("countMarkers counts every cache marker", () => {
		expect(countMarkers(anthropicP())).toBe(2);
	});
});

describe("C1–C3", () => {
	test("C1 accepts a handler's non-recipe field and rejects a changed transcript or recipe field", () => {
		const p = anthropicP();
		const b0 = { ...anthropicP() } as Record<string, unknown>;
		delete b0.metadata;
		const delta = diffTopLevel(b0, p);
		expect([...delta.keys()]).toEqual(["metadata"]);
		expect(checkC1(A, b0, p, delta).ok).toBe(true);
		const rewritten = anthropicP();
		rewritten.messages[0]!.content = [{ type: "text", text: "changed" }];
		const d2 = diffTopLevel(b0, rewritten);
		expect(checkC1(A, b0, rewritten, d2).ok).toBe(false);
		const maxed = { ...anthropicP(), max_tokens: 5 };
		expect(checkC1(A, b0, maxed, diffTopLevel(b0, maxed)).ok).toBe(false);
	});

	test("C2 accepts an appended question and rejects a changed prefix, changed E, or changed field", () => {
		const p = anthropicP();
		const b0 = anthropicP() as Record<string, unknown>;
		delete b0.metadata;
		const b1 = structuredClone(b0) as { messages: unknown[] };
		(b1.messages as Array<{ content: unknown[] }>)[2]!.content.push({ type: "text", text: "Q" });
		expect(checkC2(A, b0, b1, p).ok).toBe(true);
		const bad = structuredClone(b1) as { messages: Array<{ content: unknown[] }> };
		bad.messages[0]!.content = [{ type: "text", text: "zzz" }];
		expect(checkC2(A, b0, bad, p).ok).toBe(false);
		const field = { ...structuredClone(b1), max_tokens: 1 };
		expect(checkC2(A, b0, field, p).ok).toBe(false);
	});

	test("C3 checks F against P, with ΔH applied", () => {
		const p = anthropicP();
		const b0 = anthropicP() as Record<string, unknown>;
		delete b0.metadata;
		const delta = diffTopLevel(b0, p);
		const b1 = structuredClone(b0) as { messages: unknown[] };
		b1.messages.push({ role: "user", content: [{ type: "text", text: "Q" }] });
		const f = applyDelta(b1, delta);
		expect(f.metadata).toEqual({ user_id: "u1" });
		expect(checkC3(A, f, p).ok).toBe(true);
		expect(checkC3(A, b1, p).ok).toBe(false);
	});
});

const recipe: Recipe = {
	provider: "p",
	modelId: "m",
	api: A,
	reasoning: undefined,
	sessionId: "s",
	transport: "sse",
	thinkingBudgets: undefined,
	blockImages: false,
	virtual: false,
};

describe("observer", () => {
	test("H, R, S promote the latest attempt; readiness on the first update", () => {
		const o = new Observer();
		o.open([], null, recipe);
		const h = {};
		o.headers(h);
		const payload = { messages: [{ role: "user", content: [] }] };
		o.request({ messages: [] });
		o.request(payload);
		o.response(200);
		expect(o.latest!.state).toBe("promoted");
		expect(o.latest!.payload).toEqual(payload);
		expect(o.latest!.payload).not.toBe(payload);
		expect(o.latest!.pending).toBe(true);
		o.assistantUpdate();
		expect(o.choose()).toBe(o.latest);
	});

	test("a second H before S is ambiguous; a cache warmer replay too; errors fail", () => {
		const o = new Observer();
		o.open([], null, recipe);
		o.headers({});
		o.headers({});
		expect(o.latest!.state).toBe("ambiguous");
		o.open([], null, recipe);
		o.headers({});
		o.warming();
		expect(o.latest!.state).toBe("ambiguous");
		o.open([], null, recipe);
		o.headers({});
		o.request({});
		o.assistantEnd(undefined, "error");
		expect(o.latest!.state).toBe("failed");
		expect(o.choose()).toBeUndefined();
	});

	test("the previous usable observation is chosen while the latest failed", () => {
		const o = new Observer();
		o.open([], null, recipe);
		o.headers({});
		o.request({ messages: [] });
		o.response(200);
		o.assistantEnd({ input: 1, output: 1, cacheRead: 5, cacheWrite: 7 }, "stop");
		const good = o.latest!;
		expect(good.cacheablePrefix).toBe(12);
		o.open([], null, recipe);
		o.assistantEnd(undefined, "aborted");
		expect(o.choose()).toBe(good);
		o.reset();
		expect(o.choose()).toBeUndefined();
	});

	test("settle resolves when readiness can no longer change", async () => {
		const o = new Observer();
		o.open([], null, recipe);
		let settled = false;
		const p = o.settle().then(() => {
			settled = true;
		});
		o.headers({});
		o.request({ messages: [] });
		o.response(200);
		await Bun.sleep(5);
		expect(settled).toBe(false);
		o.assistantUpdate();
		await p;
		expect(settled).toBe(true);
	});
});

describe("usage queue", () => {
	test("appends only while idle in the same session; drops on leaving a busy session", () => {
		let idle = false;
		const appended: string[] = [];
		const q = new UsageQueue({ state: () => ({ idle, sessionId: "s1" }), append: (e) => appended.push(e.note) });
		q.push({ sessionId: "s1", provider: "p", model: "m", usage: {}, note: "a" });
		expect(appended).toEqual([]);
		idle = true;
		q.drain();
		expect(appended).toEqual(["a"]);
		idle = false;
		q.push({ sessionId: "s1", provider: "p", model: "m", usage: {}, note: "b" });
		expect(q.flushOrDrop()).toBe(1);
		q.push({ sessionId: "other", provider: "p", model: "m", usage: {}, note: "c" });
		idle = true;
		q.drain();
		expect(appended).toEqual(["a"]);
		q.stop();
	});
});

describe("background work", () => {
	test("sums counts per source, ignores junk, resets and queries on a session switch", () => {
		const handlers = new Map<string, (d: unknown) => void>();
		const emitted: string[] = [];
		const bus = {
			emit: (c: string) => emitted.push(c),
			on: (c: string, h: (d: unknown) => void) => {
				handlers.set(c, h);
				return () => handlers.delete(c);
			},
		};
		let changes = 0;
		const bw = new BackgroundWork(bus, () => changes++);
		const send = handlers.get("background-work")!;
		send({ source: "a", pending: 2 });
		send({ source: "b", pending: 1 });
		send({ source: "", pending: 5 });
		send({ pending: 5 });
		send("junk");
		expect(bw.pending).toBe(3);
		send({ source: "a", pending: 0 });
		expect(bw.pending).toBe(1);
		bw.reset();
		expect(bw.pending).toBe(0);
		expect(emitted).toEqual(["background-work:query"]);
		expect(changes).toBe(4);
		bw.dispose();
		expect(handlers.size).toBe(0);
	});
});

describe("placeholders, notice, money", () => {
	test("pending tool calls of the last assistant message get a still-running result", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }, { type: "toolCall", id: "t2", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 1 },
		];
		const out = withPlaceholders(msgs) as Array<{ role: string; toolCallId?: string; content?: Array<{ text: string }> }>;
		expect(out.length).toBe(3);
		expect(out[2]!.toolCallId).toBe("t2");
		expect(out[2]!.content![0]!.text).toBe(STILL_RUNNING);
	});

	test("the notice asks for the route line only with the route check", () => {
		expect(notice({ routeCheck: true })).toContain("route: side");
		expect(notice({ routeCheck: false })).not.toContain("route: side");
		expect(notice({ routeCheck: false })).toContain("handoff:");
	});

	test("money appears only when it is news", () => {
		const base = { question: "q", raw: "", done: true, cost: 0.03, read: 1000, written: 0, tier: "exact" as const };
		expect(moneyLine(base)).toBeUndefined();
		expect(moneyLine({ ...base, cost: 0.77, written: 150_000 })).toBe("main cache had expired · $0.77");
		expect(moneyLine({ ...base, cost: 0.71, tier: "rebuilt", reason: "a handler changed `tools`" })).toBe(
			"rebuilt context · $0.71 · a handler changed `tools`",
		);
	});
});

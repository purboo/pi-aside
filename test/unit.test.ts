import { describe, expect, test } from "bun:test";
import { BackgroundWork } from "../src/busy.ts";
import { asideLevel, STILL_RUNNING, withPlaceholders } from "../src/fork.ts";
import { Observer, type Recipe } from "../src/observe.ts";
import { HIDE_HINT, moneyLine, panelBody, type PanelState, progressLines, Reader, renderPanel, spinnerFrame as f } from "../src/panel.ts";
import {
	applyDelta,
	checkC1,
	checkC2,
	checkC3,
	countMarkers,
	diffTopLevel,
	differsOnlyInConfig,
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
		const base = { question: "q", raw: "", done: true, startedAt: 0, cost: 0.03, read: 1000, written: 0, tier: "exact" as const };
		expect(moneyLine(base)).toBeUndefined();
		expect(moneyLine({ ...base, cost: 0.77, written: 150_000 })).toBe("main cache had expired · $0.77");
		expect(moneyLine({ ...base, cost: 0.71, tier: "rebuilt", reason: "a handler changed `tools`" })).toBe(
			"rebuilt context · $0.71 · a handler changed `tools`",
		);
	});
});

describe("aside effort", () => {
	const effortModel = { compat: { supportsMidConvoEffort: true } };
	test("lowered to `low` only on models that take effort changes mid-conversation", () => {
		expect(asideLevel(effortModel, "xhigh")).toBe("low");
		expect(asideLevel(effortModel, "high")).toBe("low");
		expect(asideLevel(effortModel, "low")).toBe("low");
		expect(asideLevel(effortModel, "minimal")).toBe("minimal");
		expect(asideLevel(effortModel, undefined)).toBeUndefined();
		expect(asideLevel({}, "xhigh")).toBe("xhigh");
		expect(asideLevel({ compat: { supportsMidConvoEffort: false } }, "high")).toBe("high");
		// A level map without `low` (or mapping it to nothing) keeps the main level.
		expect(asideLevel({ ...effortModel, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }, "xhigh")).toBe("xhigh");
		expect(asideLevel({ ...effortModel, thinkingLevelMap: { low: null, high: "high" } }, "high")).toBe("high");
		expect(asideLevel({ ...effortModel, thinkingLevelMap: { low: "low", high: "high" } }, "high")).toBe("low");
	});

	const effort = (level: string) => ({ role: "system", content: [], output_config: { effort: level } });
	const payload = (level: string, extra: Record<string, unknown> = {}) => ({
		model: "m",
		thinking: { type: "adaptive" },
		output_config: { effort: "high" },
		messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: cc }] }, effort(level)],
		...extra,
	});

	test("the dry runs must differ only in the trailing configuration", () => {
		expect(differsOnlyInConfig(A, payload("low"), payload("xhigh"))).toBe(true);
		expect(differsOnlyInConfig(A, payload("low", { output_config: { effort: "low" } }), payload("xhigh"))).toBe(false);
		const moved = payload("low");
		(moved.messages[0] as { content: unknown[] }).content.push({ type: "text", text: "more" });
		expect(differsOnlyInConfig(A, moved, payload("xhigh"))).toBe(false);
	});

	test("C3 takes the aside's own trailing configuration when given", () => {
		const p = payload("xhigh");
		const f = payload("low");
		(f.messages as unknown[]).splice(1, 0, { role: "user", content: [{ type: "text", text: "q?" }] });
		expect(checkC3(A, f, p).ok).toBe(false);
		expect(checkC3(A, f, p, [effort("low")]).ok).toBe(true);
		expect(checkC3(A, f, p, [effort("medium")]).ok).toBe(false);
	});
});

describe("panel", () => {
	const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s };
	const turn = (over: Record<string, unknown> = {}) => ({
		question: "why B?",
		raw: "",
		done: false,
		startedAt: 1_000,
		cost: 0,
		read: 0,
		written: 0,
		...over,
	});
	const state = (over: Partial<PanelState> = {}, t: Record<string, unknown> = {}): PanelState => ({
		turns: [turn(t) as never],
		collapsed: false,
		...over,
	});

	test("before the first words: a spinner and the time, then the model's thinking", () => {
		const md = (text: string) => text.split("\n");
		expect(progressLines(turn() as never, 40, theme, md, 1_500)).toEqual([`${f(1_500)} working`]);
		expect(progressLines(turn() as never, 40, theme, md, 4_200)).toEqual([`${f(4_200)} working · 3s`]);
		const thinking = progressLines(turn({ thinking: "one\ntwo\nthree\nfour" }) as never, 40, theme, md, 3_000);
		expect(thinking).toEqual([`${f(3_000)} thinking · 2s`, "  two", "  three", "  four"]);
		expect(progressLines(turn({ activity: "reading a.ts" }) as never, 40, theme, md, 1_000)).toEqual([`${f(1_000)} reading a.ts`]);
	});

	test("the frame: spinner in the title while running, `↵ hides` on the lower edge while the editor is empty", () => {
		const waiting = renderPanel(state({ editorEmpty: true }), 40, theme, undefined, 1_000);
		expect(waiting[0]).not.toContain(f(1_000));
		expect(waiting[1]).toContain(`${f(1_000)} working`);
		expect(waiting.at(-1)).toContain(HIDE_HINT);
		const running = renderPanel(state({ editorEmpty: true }, { raw: "route: side\nBecause" }), 40, theme, undefined, 1_000);
		expect(running[0]).toContain(`${f(1_000)} why B?`);
		expect(running.join("\n")).not.toContain("working");
		const done = renderPanel(state({ editorEmpty: false }, { done: true, raw: "route: side\nBecause." }), 40, theme, undefined, 1_000);
		expect(done[0]).not.toContain(f(1_000));
		expect(done.join("\n")).toContain("Because.");
		expect(done.at(-1)).not.toContain(HIDE_HINT);
		for (const line of [...waiting, ...running, ...done]) expect(line.length).toBe(40);
	});

	test("a long answer: ten lines and `ctrl+o more`; expanded, up to the terminal's room, then `/aside`", () => {
		const raw = `route: side\n${Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n")}`;
		const compact = panelBody(state({ moreKey: "ctrl+o" }, { done: true, raw }), 40, theme);
		expect(compact.length).toBe(11);
		expect(compact.at(-1)).toBe("… ctrl+o more");
		const roomy = panelBody(state({ moreKey: "ctrl+o", expanded: true, maxLines: 20 }, { done: true, raw }), 40, theme);
		expect(roomy).toEqual(Array.from({ length: 15 }, (_, i) => `line ${i + 1}`));
		const tight = panelBody(state({ moreKey: "ctrl+o", expanded: true, maxLines: 12 }, { done: true, raw }), 40, theme);
		expect(tight.length).toBe(13);
		expect(tight.at(-1)).toBe("… /aside to read all");
	});

	test("the reader opens at the latest question", () => {
		const turns = Array.from({ length: 3 }, (_, i) => ({
			question: `question ${i + 1}?`,
			answer: Array.from({ length: 12 }, (_, j) => `answer ${i + 1}.${j + 1}`).join("\n"),
			detail: "exact",
		}));
		const reader = new Reader(() => turns, theme, () => {}, () => {}, () => 20);
		const first = reader.render(60);
		expect(first[1]).toContain("? question 3?");
		reader.handleInput("\x1b[H");
		expect(reader.render(60)[1]).toContain("? question 1?");
	});

	test("collapsed: one line, a spinner while the answer runs; hidden: nothing", () => {
		expect(renderPanel(state({ collapsed: true }, { done: true }), 40, theme, undefined, 1_000)).toEqual(["▸ why B?"]);
		expect(renderPanel(state({ collapsed: true }), 40, theme, undefined, 1_000)).toEqual([`${f(1_000)} why B?`]);
		expect(renderPanel(state({ collapsed: true, hidden: true }), 40, theme, undefined, 1_000)).toEqual([]);
	});
});

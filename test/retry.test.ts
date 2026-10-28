import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AssistantMessage, RetryPolicy, ToolCall } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Observer } from "../src/observe.ts";
import { panelView, progressLines } from "../src/panel.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AsideThread, type TurnView } from "../src/thread.ts";
import { UsageQueue, type QueuedUsage } from "../src/usage.ts";
import { type CaptureServer, startCaptureServer } from "./harness/capture.ts";
import { type ApiName, type PiRpc, startPi } from "./harness/pi.ts";

function message(stopReason: AssistantMessage["stopReason"], text = "", errorMessage?: string, units = 0): AssistantMessage {
	return {
		role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: Date.now(),
		stopReason, content: text ? [{ type: "text", text }] : [], ...(errorMessage ? { errorMessage } : {}),
		usage: {
			input: 10 * units, output: units, cacheRead: 100 * units, cacheWrite: 2 * units, totalTokens: 113 * units,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: units / 1000 },
		},
	};
}
const failed = (error: string, text = "", units = 0) => message("error", text, error, units);
const answered = (text = "route: side\nRecovered.", units = 0) => message("stop", text, undefined, units);

function threadFixture(script: AssistantMessage[], options: { retry?: Partial<RetryPolicy>; onUpdate?: (thread: AsideThread) => void } = {}) {
	const requests: unknown[][] = [];
	const entries: QueuedUsage[] = [];
	const retries: Array<NonNullable<TurnView["retry"]> & { raw: string; firstTextAt?: number }> = [];
	const executed: string[] = [];
	const model = { provider: "test", id: "test", api: "openai-completions", contextWindow: 200000 };
	const settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, ...options.retry } });
	const usage = new UsageQueue({ state: () => ({ idle: true, sessionId: "s" }), append: entry => entries.push(entry) });
	const thread = new AsideThread({
		env: {
			registry: {
				find: () => model,
				streamSimple(_model: unknown, context: { messages: unknown[] }, opts: { onPayload: (payload: unknown) => void }) {
					requests.push(structuredClone(context.messages));
					const response = script[requests.length - 1];
					if (!response) throw new Error("unexpected model request");
					return {
						async *[Symbol.asyncIterator]() {
							opts.onPayload({ messages: context.messages });
							yield { type: "text_delta", partial: response };
						},
						result: async () => response,
					};
				},
			},
			settings: () => settings,
			sessionManager: { getBranch: () => [], buildSessionContext: () => ({ messages: [] }) },
			selectedModel: () => model, thinkingLevel: () => "off", systemPrompt: () => "",
		},
		observer: new Observer(), usage, cwd: () => "/tmp", sessionId: () => "s",
		executeTool: async (name, args) => {
			executed.push(name);
			return { toolCall: { type: "toolCall", id: "executed", name, arguments: args as ToolCall["arguments"] }, isError: false, result: { content: [{ type: "text", text: "tool finished" }], details: undefined } };
		},
		onUpdate() {
			if (thread.current?.retry) retries.push({ ...thread.current.retry, raw: thread.current.raw, firstTextAt: thread.current.firstTextAt });
			options.onUpdate?.(thread);
		},
	});
	return { thread, requests, entries, retries, executed, settings };
}

const ask = (thread: AsideThread) => thread.ask("side task", { routeCheck: true });

describe("aside agent retries", () => {
	test("bare concurrency errors retry, replacing partial text and keeping paid usage without acting on failed output", async () => {
		const partial = failed("concurrency too high", "route: side\nDiscard this.\ntell: Do not relay this.", 1);
		partial.content.push({ type: "toolCall", id: "failed-call", name: "write", arguments: { path: "bad" } });
		const f = threadFixture([partial, answered(undefined, 2)]);
		const done = await ask(f.thread);
		expect(done.error).toBeUndefined();
		expect(done.raw).toBe("route: side\nRecovered.");
		expect(done.retry).toBeUndefined();
		expect(done.cost).toBeCloseTo(0.003);
		expect([done.read, done.written, done.requests]).toEqual([300, 6, 2]);
		expect(f.entries).toHaveLength(2);
		expect(f.requests[1]).toEqual(f.requests[0]);
		expect(f.retries).toMatchObject([{ attempt: 1, maxAttempts: 3, raw: "", firstTextAt: undefined }]);
		expect(f.executed).toEqual([]);
		expect(done.relays).toBeUndefined();
		expect(f.thread.history).toHaveLength(2);
		expect(JSON.stringify(f.thread.history)).not.toContain("Discard this");
	});

	test("a failed side route does not hide an agent route on the retried answer", async () => {
		const f = threadFixture([failed("503 overloaded", "route: side\nPartial."), answered("route: agent\n")]);
		const routes: string[] = [];
		await f.thread.ask("change main work", { routeCheck: true, onRoute: route => routes.push(route) });
		expect(routes).toEqual(["side", "agent"]);
		expect(f.executed).toEqual([]);
	});

	test("each tool round gets its own retry budget and completed tools run once", async () => {
		const tool = message("toolUse", "route: side\nChecking.");
		tool.content.push({ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo done" } });
		const f = threadFixture([failed("503 overloaded"), tool, failed("connection reset: network error", "Wrong partial"), answered("Finished.")], { retry: { maxRetries: 1 } });
		const done = await ask(f.thread);
		expect(done.error).toBeUndefined();
		expect(done.raw).toBe("route: side\nChecking.\n\nFinished.");
		expect(f.requests).toHaveLength(4);
		expect(f.requests[0]).toEqual(f.requests[1]);
		expect(f.requests[2]).toEqual(f.requests[3]);
		expect(JSON.stringify(f.requests[3])).toContain("tool finished");
		expect(JSON.stringify(f.requests[3])).not.toContain("Wrong partial");
		expect(f.executed).toEqual(["bash"]);
		expect(done.steps).toEqual([{ label: "$ echo done", ok: true }]);
		expect(f.retries.map(r => r.attempt)).toEqual([1, 1]);
	});

	test.each(["concurrency too high", "gateway_concurrency_limit", "gateway_concurrency_limit: Concurrency limit exceeded for user, please retry later"])("a gateway throttle retries: %s", async error => {
		const f = threadFixture([failed(error), answered()]);
		expect((await ask(f.thread)).error).toBeUndefined();
		expect(f.requests).toHaveLength(2);
	});

	test.each([
		"401 invalid API key", "400 invalid_request_error", "429 insufficient_quota",
		"503 context length exceeded", "concurrency too high: billing limit", "429 monthly usage limit reached",
	])("permanent failure stops immediately: %s", async error => {
		const f = threadFixture([failed(error), answered()]);
		expect((await ask(f.thread)).error).toBe(error);
		expect(f.requests).toHaveLength(1);
		expect(f.retries).toHaveLength(0);
	});

	test.each([{ enabled: false }, { maxRetries: 0 }])("honors retry settings: %j", async retry => {
		const f = threadFixture([failed("429 concurrency too high"), answered()], { retry });
		expect((await ask(f.thread)).error).toBe("429 concurrency too high");
		expect(f.requests).toHaveLength(1);
	});

	test("exponential backoff uses Pi's delay cap and stops at the configured budget", async () => {
		const f = threadFixture(Array.from({ length: 4 }, () => failed("503 overloaded")), {
			retry: { maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 15 },
		});
		expect((await ask(f.thread)).error).toBe("503 overloaded");
		expect(f.requests).toHaveLength(4);
		expect(f.retries.map(r => r.delayMs)).toEqual([10, 15, 15]);
		expect(f.thread.busy).toBe(false);
	});

	test("stopping during backoff cancels at once and a follow-up stays usable", async () => {
		const f = threadFixture([failed("concurrency_limit_exceeded"), answered()], {
			retry: { baseDelayMs: 60000 },
			onUpdate: thread => { if (thread.current?.retry) thread.abort(); },
		});
		const done = await ask(f.thread);
		expect(done.aborted).toBe(true);
		expect(done.error).toBeUndefined();
		expect(done.retry).toBeUndefined();
		expect(done.stopped).toMatchObject({ label: "waiting to retry", tool: false });
		expect(done.endedAt! - done.startedAt).toBeLessThan(1000);
		expect(f.requests).toHaveLength(1);
		expect((await ask(f.thread)).error).toBeUndefined();
		expect(f.requests).toHaveLength(2);
	});

	test("a provider abort never retries and preserves its partial answer", async () => {
		const f = threadFixture([message("aborted", "route: side\nPartial answer."), answered()]);
		const done = await ask(f.thread);
		expect(done.aborted).toBe(true);
		expect(done.raw).toContain("Partial answer.");
		expect(f.requests).toHaveLength(1);
	});

	test("the panel shows a retry countdown even after earlier tool-round text, within narrow widths", () => {
		const turn: TurnView = {
			question: "q", raw: "route: side\nChecking.", done: false, steps: [], startedAt: 0, cost: 0, read: 0, written: 0,
			retry: { attempt: 2, maxAttempts: 3, delayMs: 4000, startedAt: 1000 },
		};
		const theme = { fg: (_color: string, text: string) => text };
		expect(panelView({ turns: [turn] }, 80, theme, undefined, 2500).lines.join("\n")).toContain("retrying 2/3 in 3s");
		expect(progressLines(turn, 16, theme, text => [text], 2500).every(line => visibleWidth(line) <= 16)).toBe(true);
	});
});

let server: CaptureServer | undefined;
let pi: PiRpc | undefined;
afterEach(async () => { await pi?.close(); await server?.close(); pi = undefined; server = undefined; });

for (const api of ["anthropic", "responses", "completions"] as ApiName[]) {
	test(`${api}: real Pi retries an exact aside after a provider concurrency error`, async () => {
		server = await startCaptureServer();
		pi = await startPi({
			baseUrl: server.url, api,
			extensions: [resolve(import.meta.dir, "fixtures/probe.ts"), resolve(import.meta.dir, "../src/index.ts")],
			settings: { retry: { maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } },
		});
		server.enqueue({ text: "Main ready." });
		await pi.prompt("start");
		await pi.waitForAgentEnd();
		server.enqueue(
			{ status: 429, errorBody: { error: { type: "rate_limit_error", message: "concurrency too high" } } },
			{ text: "Recovered after throttling.", usage: { input: 10, cacheRead: 900 } },
		);
		await pi.prompt("/aside side question");
		const done = JSON.parse((await pi.waitForNotify("ASIDE_DONE ")).slice("ASIDE_DONE ".length));
		expect(done.error).toBeUndefined();
		expect(done.answer).toBe("Recovered after throttling.");
		expect(done.tier).toBe("exact");
		expect(server.requests).toHaveLength(3);
		expect(server.requests[2]!.body).toEqual(server.requests[1]!.body);
		expect(done.read).toBe(900);
		expect(JSON.stringify(pi.sessionEntries())).not.toContain("concurrency too high");
	}, 30000);
}

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installToolExecutor } from "../src/tools.ts";
import { type CaptureServer, startCaptureServer } from "./harness/capture.ts";
import { type PiRpc, startPi } from "./harness/pi.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/tools.ts");
let server: CaptureServer | undefined;
let pi: PiRpc | undefined;
afterEach(async () => { await pi?.close(); await server?.close(); pi = undefined; server = undefined; });

async function boot(env?: Record<string, string>, main = true) {
	server = await startCaptureServer();
	pi = await startPi({ baseUrl: server.url, extensions: [FIXTURE], env });
	if (main) {
		server.enqueue({ text: "Main assistant is ready." });
		await pi.prompt("start");
		await pi.waitForAgentEnd();
	}
	return pi;
}

async function call(name: string, args: unknown): Promise<AgentToolCallOutcome> {
	const skip = pi!.notifications().filter((n) => n.startsWith("TOOL_DONE ")).length;
	await pi!.prompt(`/tool-call ${JSON.stringify({ name, args })}`);
	return JSON.parse((await pi!.waitForNotify("TOOL_DONE ", skip)).slice("TOOL_DONE ".length));
}
function text(outcome: AgentToolCallOutcome): string { return JSON.stringify(outcome.result.content); }
async function threadDone(skip = 0) {
	return JSON.parse((await pi!.waitForNotify("THREAD_DONE ", skip)).slice("THREAD_DONE ".length));
}

describe("session tool executor", () => {
	test("write, edit and bash use the pipeline; overrides, validation and hooks apply without transcript entries", async () => {
		const p = await boot();
		const before = p.sessionEntries();
		expect((await call("write", { path: "note.txt", content: "alpha\n" })).isError).toBe(false);
		expect((await call("edit", { path: "note.txt", oldText: "alpha", newText: "beta" })).isError).toBe(false);
		expect((await call("bash", { command: "cat note.txt" })).result.content).toEqual([{ type: "text", text: "beta\n" }]);
		expect(readFileSync(join(p.cwd, "note.txt"), "utf8")).toBe("beta\n");
		expect(text(await call("read", { file: "custom.txt" }))).toContain("override:custom.txt");
		expect(text(await call("aside_echo", { value: "private" }))).toContain("redacted by result hook");
		expect(text(await call("aside_deferred", { value: "available" }))).toContain("echo:available");
		const hooksBefore = p.notifications().filter((n) => n.startsWith("TOOL_HOOK ")).length;
		const invalid = await call("write", { path: "invalid.txt" });
		expect(invalid.isError).toBe(true);
		expect(text(invalid)).toMatch(/validat|required/i);
		expect(p.notifications().filter((n) => n.startsWith("TOOL_HOOK ")).length).toBe(hooksBefore);
		expect(existsSync(join(p.cwd, "invalid.txt"))).toBe(false);
		const blocked = await call("write", { path: "blocked.txt", content: "denied" });
		expect(blocked.isError).toBe(true);
		expect(text(blocked)).toContain("permission denied by fixture");
		expect(existsSync(join(p.cwd, "blocked.txt"))).toBe(false);
		expect(p.sessionEntries()).toEqual(before);
		const starts = p.events.filter((e) => e.type === "tool_execution_start");
		expect(starts.length).toBeGreaterThan(5);
		expect(new Set(starts.map((e) => e.parentToolCallId)).size).toBe(1);
		expect(new Set(starts.map((e) => e.toolCallId)).size).toBe(starts.length);
		expect(JSON.stringify(server!.requests[0]!.body)).not.toContain("pi_aside_execute");
	}, 25_000);

	test("inactive, model-only and missing tools fail closed; an inactive bridge cannot use a stale loadout", async () => {
		const p = await boot();
		for (const name of ["aside_model_only", "missing_tool"]) {
			const result = await call(name, {});
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("not callable");
		}
		await p.prompt('/tool-active ["pi_aside_execute"]');
		expect(text(await call("write", { path: "inactive.txt", content: "no" }))).toContain("not callable");
		expect(existsSync(join(p.cwd, "inactive.txt"))).toBe(false);
		// Deferred tools remain callable when not active, per Pi's exposure contract.
		expect((await call("aside_deferred", { value: "yes" })).isError).toBe(false);
		await p.prompt('/tool-active ["write"]');
		expect(text(await call("write", { path: "bridge-off.txt", content: "no" }))).toContain("executor is inactive");
		expect(existsSync(join(p.cwd, "bridge-off.txt"))).toBe(false);
	}, 20_000);

	test("before a main assistant exists, Pi rejects nested execution and the aside says why", async () => {
		const p = await boot(undefined, false);
		const result = await call("write", { path: "early.txt", content: "no" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("once the agent has replied");
		expect(existsSync(join(p.cwd, "early.txt"))).toBe(false);
	}, 20_000);

	test("executor cancellation reaches the native tool and leaves later requests usable", async () => {
		const p = await boot();
		// Verify cancellation through the executor itself as well as the thread boundary below.
		await p.prompt('/tool-call {"name":"aside_slow","args":{}}');
		await p.waitForNotify("TOOL_STARTED");
		await p.prompt("/tool-abort");
		const cancelled = JSON.parse((await p.waitForNotify("TOOL_DONE ")).slice("TOOL_DONE ".length));
		expect(cancelled.isError).toBe(true);
		expect((await call("write", { path: "after.txt", content: "yes" })).isError).toBe(false);
	}, 20_000);

	test("missing loadout support fails without executing a registered target", async () => {
		let definition: ToolDefinition | undefined;
		const handlers = new Map<string, Function>();
		const fake = {
			registerTool: (tool: ToolDefinition) => { definition = tool; },
			on: (event: string, handler: Function) => { handlers.set(event, handler); },
			getActiveTools: () => ["pi_aside_execute", "write"],
		} as unknown as ExtensionAPI;
		const execute = installToolExecutor(fake);
		handlers.get("session_start")!({}, { sessionManager: { getSessionId: () => "s" } });
		const result = await execute("write", { path: "no.txt", content: "no" }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("prepareLoadout is unavailable");
		definition!.prepareLoadout!({
			registered: [{ name: "pi_aside_execute", execute: (...args: Parameters<ToolDefinition["execute"]>) => definition!.execute(...args) }],
		} as never);
		const unsupported = await execute("write", {}, new AbortController().signal);
		expect(unsupported.isError).toBe(true);
		expect(text(unsupported)).toContain("does not support aside tool execution through session hooks");
		const controller = new AbortController();
		controller.abort();
		expect((await execute("write", {}, controller.signal)).isError).toBe(true);
		handlers.get("session_shutdown")!();
		expect(text(await execute("write", {}, new AbortController().signal))).toContain("active Pi session");
		// Even a model-issued call to the hidden bridge cannot manufacture an internal request.
		await expect(definition!.execute("model", {}, undefined, undefined, {} as never)).rejects.toThrow("internal");
	});
});

describe("thread tool boundaries", () => {
	test("completed no-newline agent routes never execute tools, even without an onRoute callback", async () => {
		const p = await boot({ TOOLS_NO_ROUTE_CALLBACK: "1" });
		server!.enqueue({ text: "route: agent", toolCalls: [{ name: "write", arguments: { path: "agent.txt", content: "no" } }] });
		await p.prompt("/tool-aside change main work");
		const done = await threadDone();
		expect(done.error).toBeUndefined();
		expect(done.steps).toEqual([]);
		expect(existsSync(join(p.cwd, "agent.txt"))).toBe(false);
		expect(server!.requests.length).toBe(2);
	}, 20_000);

	test("only an explicit side route permits writes; completed no-newline side authorizes and records steps", async () => {
		const p = await boot();
		server!.enqueue(
			{ text: "I can do that.", toolCalls: [{ name: "write", arguments: { path: "unrouted.txt", content: "no" } }] },
			{ text: "route: side", toolCalls: [{ name: "write", arguments: { path: "side.txt", content: "yes" } }] },
			{ text: "Finished." },
		);
		await p.prompt("/tool-aside independent task");
		const done = await threadDone();
		// A route belongs to the reply's first line; appending one after unstructured text is not authorization.
		expect(existsSync(join(p.cwd, "unrouted.txt"))).toBe(false);
		expect(existsSync(join(p.cwd, "side.txt"))).toBe(false);
		expect(JSON.stringify(server!.requests[2]!.body)).toContain("Not run: start your reply");
		expect(done.steps).toEqual([]);
		server!.enqueue(
			{ text: "route: side", toolCalls: [{ id: "aside_write", name: "write", arguments: { path: "side.txt", content: "yes" } }] },
			{ text: "Finished." },
		);
		await p.prompt("/tool-aside independent task again");
		const side = await threadDone(1);
		expect(readFileSync(join(p.cwd, "side.txt"), "utf8")).toBe("yes");
		expect(side.steps).toEqual([{ label: "write side.txt", ok: true }]);
		expect(JSON.stringify(p.sessionEntries())).not.toContain("aside_write");
	}, 25_000);

	test("thread continuations receive hooked results and failed steps for denied calls", async () => {
		const p = await boot();
		server!.enqueue(
			{ text: "route: side\n", toolCalls: [
				{ id: "side_w", name: "write", arguments: { path: "thread.txt", content: "alpha" } },
				{ id: "side_e", name: "edit", arguments: { path: "thread.txt", oldText: "alpha", newText: "beta" } },
				{ id: "side_b", name: "bash", arguments: { command: "cat thread.txt" } },
				{ id: "side_r", name: "read", arguments: { path: "custom" } },
				{ id: "side_x", name: "aside_echo", arguments: { value: "private" } },
				{ id: "side_denied", name: "write", arguments: { path: "blocked.txt", content: "no" } },
			] },
			{ text: "Finished." },
		);
		await p.prompt("/tool-aside write an independent note");
		const done = await threadDone();
		expect(done.error).toBeUndefined();
		expect(done.steps).toEqual([
			{ label: "write thread.txt", ok: true }, { label: "edit thread.txt", ok: true },
			{ label: "$ cat thread.txt", ok: true }, { label: "aside_echo", ok: true },
			{ label: "write blocked.txt", ok: false },
		]);
		const continuation = JSON.stringify(server!.requests[2]!.body);
		expect(continuation).toContain("override:custom");
		expect(continuation).toContain("redacted by result hook");
		expect(continuation).toContain("permission denied by fixture");
		expect(continuation).toContain('"is_error":true');
		expect(readFileSync(join(p.cwd, "thread.txt"), "utf8")).toBe("beta");
		expect(JSON.stringify(p.sessionEntries())).not.toContain("side_denied");
	}, 20_000);

	test("cancelling an unterminated partial route does not forward it in finally", async () => {
		const p = await boot();
		server!.enqueue({ text: "route: agent", delayMs: 200, toolCalls: [{ name: "write", arguments: { path: "cancelled.txt", content: "no" } }] });
		await p.prompt("/tool-aside cancel-partial");
		const done = await threadDone();
		expect(done.aborted).toBe(true);
		expect(p.notifications().filter((n) => n.startsWith("TOOL_ROUTE "))).toEqual([]);
		expect(existsSync(join(p.cwd, "cancelled.txt"))).toBe(false);
	}, 20_000);

	test("cancelling while a permission hook waits prevents the approved tool from running later", async () => {
		const p = await boot();
		server!.enqueue({ text: "route: side\n", toolCalls: [
			{ name: "write", arguments: { path: "permission.txt", content: "no" } },
			{ name: "write", arguments: { path: "after-permission.txt", content: "no" } },
		] });
		await p.prompt("/tool-aside permission task");
		await p.waitForNotify("TOOL_PERMISSION");
		await p.prompt("/tool-abort");
		await p.prompt("/tool-release");
		const done = await threadDone();
		expect(done.aborted).toBe(true);
		expect(existsSync(join(p.cwd, "permission.txt"))).toBe(false);
		expect(existsSync(join(p.cwd, "after-permission.txt"))).toBe(false);
		expect(server!.requests.length).toBe(2);
	}, 20_000);

	test("cancelling a running tool stops the remaining calls and the next model request", async () => {
		const p = await boot();
		server!.enqueue({ text: "route: side\n", toolCalls: [
			{ name: "aside_slow", arguments: {} },
			{ name: "write", arguments: { path: "after-abort.txt", content: "no" } },
		] });
		await p.prompt("/tool-aside cancellable task");
		await p.waitForNotify("TOOL_STARTED");
		await p.prompt("/tool-abort");
		const done = await threadDone();
		expect(done.aborted).toBe(true);
		expect(existsSync(join(p.cwd, "after-abort.txt"))).toBe(false);
		expect(server!.requests.length).toBe(2);
		expect(p.events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName)).toEqual(["aside_slow"]);
	}, 20_000);
});

function reportedUsage(prefix: string): Array<{ tag?: string; toolName?: string; usage: import("@earendil-works/pi-ai").Usage; provider?: string; model?: string; note?: string }> {
	return pi!.notifications().filter((n) => n.startsWith(prefix)).map((n) => JSON.parse(n.slice(prefix.length)));
}
function usageUnits(prefix: string): number {
	return reportedUsage(prefix).reduce((total, result) => total + result.usage.input / 10, 0);
}

describe("tool usage accounting", () => {
	test("direct and nested own usage is counted once, with distinct attribution for overlapping executor requests", async () => {
		const p = await boot();
		const before = p.sessionEntries();
		await p.prompt('/tool-call {"name":"aside_paid_wait","args":{"tag":"waiting"}}');
		await p.waitForNotify("TOOL_PAID");
		await p.prompt('/tool-call {"name":"aside_paid_parent","args":{"tag":"tree"}}');
		await p.prompt('/tool-call {"name":"aside_paid_leaf","args":{"tag":"direct","units":3}}');
		await p.waitForNotify("TOOL_DONE ", 1);
		const usage = reportedUsage("TOOL_USAGE ");
		expect(usage.filter((r) => r.tag === "tree").map((r) => [r.toolName, r.usage.input / 10]).sort()).toEqual([
			["aside_paid_leaf", 1], ["aside_paid_leaf", 16], ["aside_paid_leaf", 2], ["aside_paid_middle", 8], ["aside_paid_parent", 4],
		]);
		expect(usage.filter((r) => r.tag === "direct").map((r) => [r.toolName, r.usage.input / 10])).toEqual([["aside_paid_leaf", 3]]);
		expect(usageUnits("TOOL_USAGE ")).toBe(35);
		const leaf = usage.find((r) => r.tag === "tree" && r.toolName === "aside_paid_leaf" && r.usage.input === 160)!.usage;
		expect(leaf.cacheWrite1h).toBe(32);
		expect(leaf.reasoning).toBe(16);
		expect(leaf.totalTokens).toBe(304);
		expect(leaf.cost.total).toBeCloseTo(16 * 0.37);
		expect(p.sessionEntries()).toEqual(before);
		// Main-model tools have a different parent and must never reach a side usage observer.
		server!.enqueue(
			{ toolCalls: [{ name: "aside_paid_leaf", arguments: { units: 100 } }] },
			{ text: "Main finished." },
		);
		await p.prompt("main paid tool");
		await p.waitForAgentEnd(2);
		expect(usageUnits("TOOL_USAGE ")).toBe(35);
		// A main agent_end resets nested ids while the first side invocation still waits.
		// The new call may reuse its id; async ownership must still keep both usages separate.
		expect((await call("aside_paid_leaf", { units: 6, tag: "after-reset" })).isError).toBe(false);
		expect(reportedUsage("TOOL_USAGE ").filter((r) => r.tag === "after-reset").map((r) => r.usage.input)).toEqual([60]);
		await p.prompt("/tool-release");
		await p.waitForNotify("TOOL_DONE ", 3);
		expect(usageUnits("TOOL_USAGE ")).toBe(43);
		expect(reportedUsage("TOOL_USAGE ").filter((r) => r.tag === "waiting").map((r) => r.toolName).sort()).toEqual(["aside_paid_leaf", "aside_paid_wait"]);
	}, 20_000);

	test("result hooks determine final reported usage and failed parents retain child usage", async () => {
		await boot();
		expect((await call("aside_paid_leaf", { units: 1, tag: "hooked" })).isError).toBe(false);
		expect(usageUnits("TOOL_USAGE ")).toBe(5);
		expect((await call("aside_paid_parent", { fail: true })).isError).toBe(true);
		expect(usageUnits("TOOL_USAGE ")).toBe(5 + 27);
		expect(reportedUsage("TOOL_USAGE ").some((r) => r.toolName === "aside_paid_parent")).toBe(false);
	}, 20_000);

	test("usage beyond Pi's bounded nested recorder is preserved without relying on stored call ids", async () => {
		const p = await boot();
		const before = p.sessionEntries();
		expect((await call("aside_paid_many", { repeat: 300 })).isError).toBe(false);
		expect(usageUnits("TOOL_USAGE ")).toBe(300);
		expect(reportedUsage("TOOL_USAGE ").filter((r) => r.toolName === "aside_paid_leaf")).toHaveLength(300);
		expect(p.sessionEntries()).toEqual(before);
	}, 20_000);

	test("thread costs and UsageQueue include direct plus nested usage in Pi's tool attribution bucket", async () => {
		const p = await boot();
		server!.enqueue(
			{ text: "route: side\n", toolCalls: [{ id: "paid_aside", name: "aside_paid_parent", arguments: {} }], usage: { input: 0, output: 0 } },
			{ text: "Finished.", usage: { input: 0, output: 0 } },
		);
		await p.prompt("/tool-aside paid independent task");
		const done = await threadDone();
		expect(done.error).toBeUndefined();
		expect(done.cost).toBeCloseTo(31 * 0.37);
		expect(done.read).toBe(31 * 3);
		expect(done.written).toBe(31 * 4);
		expect(usageUnits("THREAD_USAGE ")).toBe(31);
		const usage = reportedUsage("THREAD_USAGE ");
		expect(usage).toHaveLength(5);
		expect(usage.every((r) => r.provider === "Tools" && r.model === "summaries")).toBe(true);
		expect(usage.map((r) => r.note)).toEqual(expect.arrayContaining([
			expect.stringContaining('tool="aside_paid_parent"'), expect.stringContaining('tool="aside_paid_middle"'), expect.stringContaining('tool="aside_paid_leaf"'),
		]));
		const entries = p.sessionEntries();
		expect(entries.filter((e) => e.type === "usage" && e.provider === "Tools")).toHaveLength(5);
		expect(JSON.stringify(entries)).not.toContain("paid_aside");
	}, 20_000);

	test("abort after paid work accounts both the child and the final paid result before stopping", async () => {
		const p = await boot();
		server!.enqueue({ text: "route: side\n", usage: { input: 0, output: 0 }, toolCalls: [
			{ name: "aside_paid_wait", arguments: {} },
			{ name: "write", arguments: { path: "after-paid-abort.txt", content: "no" } },
		] });
		await p.prompt("/tool-aside cancel paid task");
		await p.waitForNotify("TOOL_PAID");
		expect(usageUnits("THREAD_USAGE ")).toBe(1);
		await p.prompt("/tool-abort");
		const done = await threadDone();
		expect(done.aborted).toBe(true);
		expect(done.cost).toBeCloseTo(3 * 0.37);
		expect(done.read).toBe(9);
		expect(done.written).toBe(12);
		expect(usageUnits("THREAD_USAGE ")).toBe(3);
		expect(existsSync(join(p.cwd, "after-paid-abort.txt"))).toBe(false);
		expect(server!.requests).toHaveLength(2);
	}, 20_000);
});

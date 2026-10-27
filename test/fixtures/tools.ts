// Standalone integration driver for the executor and thread; no production index wiring required.
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Observer } from "../../src/observe.ts";
import { AsideThread } from "../../src/thread.ts";
import { installToolExecutor } from "../../src/tools.ts";
import { currentSettings } from "../../src/transport.ts";
import { UsageQueue } from "../../src/usage.ts";

export default function toolsFixture(pi: ExtensionAPI): void {
	const executeTool = installToolExecutor(pi);
	let thread: AsideThread | undefined;
	let controller: AbortController | undefined;
	let releasePermission: (() => void) | undefined;
	let releasePaid: (() => void) | undefined;
	let releaseStubborn: (() => void) | undefined;
	const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
	for (const [name, exposure] of [["aside_echo", "direct"], ["aside_deferred", "deferred"], ["aside_model_only", "model-only"]] as const) {
		pi.registerTool({
			name, label: name, description: name, parameters: schema, exposure,
			async execute(_id, args) {
				return { content: [{ type: "text", text: `echo:${args.value}` }], details: { value: args.value } };
			},
		});
	}
	pi.registerTool({
		name: "read", label: "Configured read", description: "Configured read override",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		prepareArguments(args) {
			const input = args as { path?: string; file?: string };
			return { path: input.path ?? input.file };
		},
		async execute(_id, args) {
			return { content: [{ type: "text", text: `override:${args.path}` }], details: undefined };
		},
	});
	pi.registerTool({
		name: "aside_slow", label: "Slow", description: "Cancellable tool", parameters: { type: "object", properties: {} },
		async execute(_id, _args, signal, _update, ctx) {
			ctx.ui.notify("TOOL_STARTED", "info");
			await new Promise<void>((resolve) => {
				const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
				const timer = setTimeout(finish, 10_000);
				signal?.addEventListener("abort", finish, { once: true });
				if (signal?.aborted) finish();
			});
			return { content: [{ type: "text", text: signal?.aborted ? "cancelled" : "finished" }], details: undefined };
		},
	});
	pi.registerTool({
		name: "aside_stubborn", label: "Stubborn", description: "Ignores cancellation", parameters: { type: "object", properties: {} },
		async execute(_id, _args, _signal, _update, ctx) {
			ctx.ui.notify("TOOL_STUBBORN", "info");
			await new Promise<void>((resolve) => { releaseStubborn = resolve; setTimeout(resolve, 10_000); });
			return { content: [{ type: "text", text: "stubborn finished" }], details: undefined };
		},
	});
	const paidUsage = (units: number): Usage => ({
		input: 10 * units, output: 2 * units, cacheRead: 3 * units, cacheWrite: 4 * units,
		cacheWrite1h: 2 * units, reasoning: units, totalTokens: 19 * units,
		cost: { input: 0.1 * units, output: 0.2 * units, cacheRead: 0.03 * units, cacheWrite: 0.04 * units, total: 0.37 * units },
	});
	const paidParams = { type: "object", properties: {
		units: { type: "number" }, tag: { type: "string" }, fail: { type: "boolean" }, repeat: { type: "number" },
	} };
	for (const name of ["aside_paid_leaf", "aside_paid_middle", "aside_paid_parent", "aside_paid_wait", "aside_paid_many"]) {
		pi.registerTool({
			name, label: name, description: name, parameters: paidParams,
			async execute(_id, args, signal, _update, ctx) {
				const paid = args as { units?: number; repeat?: number; fail?: boolean };
				let units = paid.units ?? 1;
				if (name === "aside_paid_middle") {
					await ctx.executeTool("aside_paid_leaf", { units: 16 }, { signal });
					units = 8;
				} else if (name === "aside_paid_parent") {
					await Promise.all([
						ctx.executeTool("aside_paid_leaf", { units: 1 }, { signal }),
						ctx.executeTool("aside_paid_leaf", { units: 2 }, { signal }),
						ctx.executeTool("aside_paid_middle", {}, { signal }),
					]);
					units = 4;
				} else if (name === "aside_paid_wait") {
					await ctx.executeTool("aside_paid_leaf", { units: 1 }, { signal });
					ctx.ui.notify("TOOL_PAID", "info");
					await new Promise<void>((resolve) => {
						const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
						const timer = setTimeout(finish, 10_000);
						releasePaid = finish;
						signal?.addEventListener("abort", finish, { once: true });
						if (signal?.aborted) finish();
					});
					units = 2;
				} else if (name === "aside_paid_many") {
					for (let i = 0; i < (paid.repeat ?? 300); i++) await ctx.executeTool("aside_paid_leaf", { units: 1 }, { signal });
					units = 0;
				}
				if (paid.fail) throw new Error("parent failed after paid child work");
				return { content: [{ type: "text", text: name }], details: undefined, usage: paidUsage(units) };
			},
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		ctx.ui.notify(`TOOL_HOOK ${JSON.stringify(event)}`, "info");
		if (event.toolName === "write" && event.input.path === "permission.txt") {
			ctx.ui.notify("TOOL_PERMISSION", "info");
			await new Promise<void>((resolve) => { releasePermission = resolve; });
		}
		if (event.toolName === "write" && String(event.input.path).includes("blocked")) return { block: true, reason: "permission denied by fixture" };
		return undefined;
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "aside_paid_leaf" && event.input.tag === "hooked") return { usage: paidUsage(5) };
		if (event.toolName === "aside_echo") return { content: [{ type: "text", text: "redacted by result hook" }] };
		return undefined;
	});
	pi.registerCommand("tool-call", {
		description: "Execute a side tool without a transcript entry",
		handler: async (raw, ctx) => {
			const { name, args } = JSON.parse(raw);
			controller = new AbortController();
			void executeTool(name, args, controller.signal, (result) => ctx.ui.notify(`TOOL_USAGE ${JSON.stringify({ tag: args?.tag, ...result })}`, "info")).then((result) => ctx.ui.notify(`TOOL_DONE ${JSON.stringify(result)}`, "info"));
		},
	});
	pi.registerCommand("tool-active", {
		description: "Change active tools",
		handler: async (raw) => { pi.setActiveTools(JSON.parse(raw)); },
	});
	pi.registerCommand("tool-release", {
		description: "Release the pending permission hook",
		handler: async () => { releasePermission?.(); releasePermission = undefined; releasePaid?.(); releasePaid = undefined; releaseStubborn?.(); releaseStubborn = undefined; },
	});
	pi.registerCommand("tool-abort", {
		description: "Abort the side operation",
		handler: async () => { controller?.abort(); thread?.abort(); },
	});
	pi.registerCommand("tool-follow", {
		description: "Ask a follow-up on the same thread",
		handler: async (question, ctx) => {
			void thread!.ask(question, { routeCheck: true }).then((result) => ctx.ui.notify(`THREAD_DONE ${JSON.stringify(result)}`, "info"));
		},
	});
	pi.registerCommand("tool-aside", {
		description: "Run a thread with routing",
		handler: async (question, ctx) => {
			thread?.abort();
			thread = new AsideThread({
				env: {
					registry: ctx.modelRegistry, settings: () => currentSettings(() => pi.getSettings()),
					sessionManager: ctx.sessionManager, selectedModel: () => ctx.model,
					thinkingLevel: () => pi.getThinkingLevel(), systemPrompt: () => ctx.getSystemPrompt(),
				},
				observer: new Observer(), usage: new UsageQueue({
					state: () => ({ idle: ctx.isIdle(), sessionId: ctx.sessionManager.getSessionId() }),
					append: (entry) => {
						(ctx.sessionManager as SessionManager).appendUsage("aside", entry.provider, entry.model, entry.usage as Usage, entry.note);
						ctx.ui.notify(`THREAD_USAGE ${JSON.stringify(entry)}`, "info");
					},
				}),
				cwd: () => ctx.cwd, sessionId: () => ctx.sessionManager.getSessionId(), executeTool,
				onUpdate() {
					if (question === "cancel-partial" && thread?.current?.raw === "route: agent" && !thread.current.done) thread.abort();
				},
			});
			void thread.ask(question, {
				routeCheck: true,
				onRoute: process.env.TOOLS_NO_ROUTE_CALLBACK === "1" ? undefined : (route) => ctx.ui.notify(`TOOL_ROUTE ${route}`, "info"),
			}).then((result) => ctx.ui.notify(`THREAD_DONE ${JSON.stringify(result)}`, "info"));
		},
	});
}

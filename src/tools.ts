// Run side calls through Pi's session pipeline, including validation and permission hooks.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tool results report their own usage; children report separately through the same callback. */
export interface ToolUsage {
	toolName: string;
	usage: Usage;
}

/** Usage is reported even when cancellation subsequently replaces the final outcome. */
export type ToolExecutor = (
	name: string,
	args: unknown,
	signal: AbortSignal,
	onToolUsage?: (result: ToolUsage) => void,
) => Promise<AgentToolCallOutcome>;

const BRIDGE = "pi_aside_execute";

/** Pi hides this bridge after context_with_system fires. Apply the same declaration-only projection to the fork. */
export function projectAsideTools(messages: unknown[], active: readonly string[]): unknown[] {
	if (!active.includes(BRIDGE)) return messages;
	return messages.map((value) => {
		const message = value as { role?: string; toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> };
		if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return value;
		const { toolsAdded, toolsRemoved, ...rest } = message;
		const added = toolsAdded?.filter((tool) => tool.name !== BRIDGE) ?? [];
		const removed = toolsRemoved?.filter((tool) => tool.name !== BRIDGE) ?? [];
		return { ...rest, ...(added.length ? { toolsAdded: added } : {}), ...(removed.length ? { toolsRemoved: removed } : {}) };
	});
}

function failure(name: string, args: unknown, text: string): AgentToolCallOutcome {
	return {
		toolCall: { type: "toolCall", id: BRIDGE, name, arguments: args as AgentToolCallOutcome["toolCall"]["arguments"] },
		result: { content: [{ type: "text", text }], details: undefined },
		isError: true,
	};
}

/**
 * Install once in the extension factory and pass the returned function to ThreadHost.executeTool.
 * prepareLoadout supplies the session-wrapped bridge; only that bridge is invoked directly.
 * It delegates actual work to ctx.executeTool, never to a reconstructed or unwrapped tool.
 * Requires Pi's loadout/nested-call API and an existing main assistant message. Model-only,
 * hidden and inactive direct tools are unavailable, as they are to any ctx.executeTool caller.
 */
export function installToolExecutor(pi: ExtensionAPI): ToolExecutor {
	let bridge: AgentTool | undefined;
	let sessionId: string | undefined;
	let lifetime = new AbortController();
	// Requests are private object identities, so a model-issued bridge call cannot delegate work.
	const requests = new WeakMap<object, { name: string; args: unknown; onToolUsage?: (result: ToolUsage) => void }>();
	// Async context follows this invocation and its child calls, including overlapping requests.
	// Unlike correlating solely by call id, it also survives Pi resetting nested ids at agent_end.
	// Nothing is retained by id or after the asynchronous work finishes.
	const usageContext = new AsyncLocalStorage<{ scopeId: string; onToolUsage?: (result: ToolUsage) => void }>();
	pi.on("tool_execution_end", (event) => {
		const owner = usageContext.getStore();
		const parent = event.parentToolCallId;
		if (!owner || !parent || (parent !== owner.scopeId && !parent.startsWith(`${owner.scopeId}/`))) return;
		const usage: Usage | undefined = event.result?.usage;
		// End events carry each result's own usage after hooks. Pi adds child usage only to a
		// transcript parent result, which the aside never creates. Count each end once, even
		// after abort or before a parent later fails; do not also count outcome.result.usage.
		if (usage) owner.onToolUsage?.({ toolName: event.toolName, usage });
	});

	pi.registerTool({
		name: BRIDGE,
		label: "Aside tools",
		description: "Internal executor for temporary side conversations.",
		exposure: "model-only",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		prepareLoadout(loadout) {
			bridge = loadout.registered.find((tool) => tool.name === BRIDGE);
			return { hiddenDeclarations: [BRIDGE] };
		},
		async execute(scopeId, token, signal, _onUpdate, ctx) {
			const request = token && typeof token === "object" ? requests.get(token) : undefined;
			if (!request) throw new Error("The aside executor is internal");
			requests.delete(token);
			signal?.throwIfAborted();
			if (!ctx || typeof ctx.executeTool !== "function" || !Array.isArray(ctx.tools)) {
				throw new Error("This Pi version does not support aside tool execution through session hooks");
			}
			if (!ctx.tools.some((tool) => tool.name === request.name)) {
				throw new Error(`${request.name} is not available in an aside: not callable in this session (inactive, model-only, hidden, or unregistered)`);
			}
			const outcome = await usageContext.run(
				{ scopeId, onToolUsage: request.onToolUsage },
				() => ctx.executeTool(request.name, request.args, { signal }),
			);
			return { content: [], details: outcome };
		},
	});
	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		if (lifetime.signal.aborted) lifetime = new AbortController();
	});
	pi.on("session_shutdown", () => {
		sessionId = undefined;
		lifetime.abort();
	});

	return async (name, args, signal, onToolUsage) => {
		let token: object | undefined;
		try {
			signal.throwIfAborted();
			if (!sessionId || lifetime.signal.aborted) throw new Error("Aside tools require an active Pi session");
			if (!pi.getActiveTools().includes(BRIDGE)) throw new Error("The internal aside executor is inactive");
			if (!bridge) throw new Error("This Pi version does not support aside tools (prepareLoadout is unavailable)");
			const combined = AbortSignal.any([signal, lifetime.signal]);
			combined.throwIfAborted();
			token = {};
			requests.set(token, { name, args, onToolUsage });
			// Pi's nested recorder bounds calls/arguments per scope. Reusing one parent per session
			// also bounds the number of scopes when no transcript result consumes this record.
			const result = await bridge.execute(`pi-aside:${sessionId}`, token, combined);
			combined.throwIfAborted();
			if (!result.details || typeof result.details.isError !== "boolean" || !result.details.result) {
				throw new Error("Pi's aside executor returned an unsupported result");
			}
			return result.details as AgentToolCallOutcome;
		} catch (error) {
			return failure(name, args, error instanceof Error ? error.message : String(error));
		} finally {
			if (token) requests.delete(token);
		}
	};
}

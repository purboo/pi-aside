// The aside request (docs/design.md §4.2, §4.8): conversion under the frozen recipe, the dry run B0, ΔH, and the
// send of B1 whose onPayload checks C2 and C3 and returns F. T1 rebuilds when any check fails.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { Observation, Recipe } from "./observe.ts";
import {
	applyDelta,
	checkC1,
	checkC2,
	checkC3,
	countMarkers,
	type Delta,
	deepEqual,
	diffTopLevel,
	differsOnlyInConfig,
	type Payload,
	splitList,
	T0_APIS,
} from "./payload.ts";
import { OWN_REQUEST } from "./tap.ts";
import { envSnapshot, envUnchanged, mergeAttributionHeaders, requestOptions } from "./transport.ts";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

// biome-ignore lint: Pi's model, registry and stream types are used structurally.
type Any = any;

export interface ForkEnv {
	registry: Any;
	settings: () => SettingsManager;
	sessionManager: Any;
	/** The selected model and thinking level, for T1 without an observation. */
	selectedModel: () => Any;
	thinkingLevel: () => string;
	systemPrompt: () => string;
	/** Request-only tool declaration projection, matching Pi's hidden loadout declarations. */
	projectMessages?: (messages: unknown[]) => unknown[];
}

const IMAGE_DISABLED = "Image reading is disabled.";

/** Pi's convertToLlm wrapper with image blocking (sdk.js), then normalizeContext. */
export function toContext(messages: unknown[], blockImages: boolean): Any {
	let converted = convertToLlm(messages as AgentMessage[]) as Any[];
	if (blockImages) {
		converted = converted.map((msg) => {
			if ((msg.role === "user" || msg.role === "toolResult") && Array.isArray(msg.content)) {
				if (msg.content.some((c: Any) => c.type === "image")) {
					const content = msg.content
						.map((c: Any) => (c.type === "image" ? { type: "text", text: IMAGE_DISABLED } : c))
						.filter(
							(c: Any, i: number, arr: Any[]) =>
								!(
									c.type === "text" &&
									c.text === IMAGE_DISABLED &&
									i > 0 &&
									arr[i - 1].type === "text" &&
									arr[i - 1].text === IMAGE_DISABLED
								),
						);
					return { ...msg, content };
				}
			}
			return msg;
		});
	}
	return normalizeContext({ messages: converted });
}

/**
 * G: the messages the branch gained since the observation's leaf, or undefined if the leaf left the branch. A
 * compaction after the leaf is skipped: T already holds everything its summary covers.
 */
export function gainedSince(sessionManager: Any, leafId: string | null): unknown[] | undefined {
	const branch: Any[] = sessionManager.getBranch();
	let start = 0;
	if (leafId !== null) {
		const index = branch.findIndex((entry) => entry.id === leafId);
		if (index < 0) return undefined;
		start = index + 1;
	}
	return branch
		.slice(start)
		.filter((entry) => entry.type !== "compaction")
		.flatMap((entry) => sessionEntryToContextMessages(entry));
}

export const STILL_RUNNING = "(still running in the main session; its result is not available yet)";

/** Add a "still running" result for every tool call of the last assistant message that has none. */
export function withPlaceholders(messages: unknown[]): unknown[] {
	const out = [...messages];
	let lastAssistant = -1;
	for (let i = out.length - 1; i >= 0; i--) {
		if ((out[i] as Any).role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	if (lastAssistant < 0) return out;
	const calls = ((out[lastAssistant] as Any).content ?? []).filter((c: Any) => c?.type === "toolCall");
	const answered = new Set(
		out
			.slice(lastAssistant + 1)
			.filter((m: Any) => m.role === "toolResult")
			.map((m: Any) => m.toolCallId),
	);
	for (const call of calls) {
		if (answered.has(call.id)) continue;
		out.push({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: STILL_RUNNING }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	return out;
}

export class Fallback extends Error {}

export type Tier = "exact" | "rebuilt";

/** A fork: the base messages (T ++ G) and how requests over it are sent. */
export interface Fork {
	tier: Tier;
	/** Why T1 was used. */
	reason?: string;
	base: unknown[];
	observation?: Observation;
	recipe: {
		provider: string;
		modelId: string;
		api: string;
		reasoning: string | undefined;
		sessionId: string;
		transport: string | undefined;
		thinkingBudgets: unknown;
		blockImages: boolean;
	};
	/** The thinking level the aside sends with, when lower than the main session's (see `asideLevel`). */
	effort?: string;
	/** T0 only. */
	b0?: Payload;
	/** T0 with `effort`: the dry run of T at the aside's effort; it differs from B0 only in E. */
	b0e?: Payload;
	delta?: Delta;
	modelSnapshot?: Any;
	/** Number of entries in the session branch when the fork was made. */
	branchLength: number;
	/** SHA-256 of P's canonical JSON (T0). */
	pHash?: string;
}

export interface SendResult {
	message: Any;
	tier: Tier;
	reason?: string;
	/** Markers in the request sent (Anthropic). */
	markers?: number;
	/** The payload actually sent. */
	sent?: Payload;
}

/** The effort an aside asks for: quick answers, so its first words arrive soon. */
export const ASIDE_LEVEL = "low";
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The thinking level for an aside: `ASIDE_LEVEL` when the main session's is higher and the model takes effort
 * changes mid-conversation (`compat.supportsMidConvoEffort`: pi-ai sends the level as a trailing configuration item,
 * after the cached prefix), otherwise the main session's level. A level the model maps to nothing is not used.
 */
export function asideLevel(model: Any, level: string | undefined): string | undefined {
	if (!level || model?.compat?.supportsMidConvoEffort !== true) return level;
	const map = model.thinkingLevelMap;
	if (map && typeof map === "object" && (map[ASIDE_LEVEL] === null || (Object.keys(map).length > 0 && !(ASIDE_LEVEL in map)))) {
		return level;
	}
	const i = LEVELS.indexOf(level);
	return i > LEVELS.indexOf(ASIDE_LEVEL) ? ASIDE_LEVEL : level;
}

function baseOptions(
	env: ForkEnv,
	fork: Fork,
	model: Any,
	signal: AbortSignal | undefined,
	reasoning: string | undefined = fork.effort ?? fork.recipe.reasoning,
): Any {
	const settings = env.settings();
	const opts = requestOptions(settings);
	return {
		reasoning,
		sessionId: fork.recipe.sessionId,
		transport: fork.recipe.transport,
		thinkingBudgets: fork.recipe.thinkingBudgets,
		maxRetryDelayMs: opts.maxRetryDelayMs,
		timeoutMs: opts.timeoutMs,
		websocketConnectTimeoutMs: opts.websocketConnectTimeoutMs,
		maxRetries: opts.maxRetries,
		transformHeaders: (headers: Record<string, unknown>) =>
			mergeAttributionHeaders(model, settings, fork.recipe.sessionId, headers) ?? {},
		signal,
		[OWN_REQUEST]: true,
	};
}

/** Run a stream to its end and return the final message (or the error message). */
async function finish(stream: Any): Promise<Any> {
	for await (const _event of stream) {
		// drained
	}
	return await stream.result();
}

/** B0: the dry conversion of T; onPayload records the payload and aborts before any request is sent. */
export async function dryRun(
	env: ForkEnv,
	fork: Fork,
	model: Any,
	messages: unknown[],
	reasoning: string | undefined = fork.recipe.reasoning,
): Promise<Payload> {
	let captured: Payload | undefined;
	const options = baseOptions(env, fork, model, undefined, reasoning);
	options.onPayload = (payload: unknown) => {
		captured = structuredClone(payload) as Payload;
		throw new Fallback("dry run");
	};
	const message = await finish(env.registry.streamSimple(model, toContext(env.projectMessages?.(messages) ?? messages, fork.recipe.blockImages), options));
	if (!captured) throw new Fallback(`the dry conversion failed: ${message?.errorMessage ?? "no payload"}`);
	return captured;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isStatelessTransport(api: string, transport: string | undefined): boolean {
	if (api === "openai-codex-responses") return false;
	return transport !== "websocket";
}

/** Choose and prepare the fork for a new side thread. */
export async function makeFork(env: ForkEnv, observation: Observation | undefined, why: string | undefined): Promise<Fork> {
	const branchLength = env.sessionManager.getBranch().length;
	if (observation?.payload) {
		const reason = await prepareExact(env, observation, branchLength);
		if (typeof reason !== "string") return reason;
		return makeRebuilt(env, observation, reason, branchLength);
	}
	return makeRebuilt(env, observation, why ?? "no main request observed yet", branchLength);
}

async function prepareExact(env: ForkEnv, observation: Observation, branchLength: number): Promise<Fork | string> {
	const recipe = observation.recipe;
	if (!T0_APIS.has(recipe.api)) return `${recipe.api} is not checked`;
	if (!isStatelessTransport(recipe.api, recipe.transport)) return "the main session uses a stateful transport";
	const p = observation.payload!;
	if ("previous_response_id" in p && p.previous_response_id) return "the main request continues a stored response";
	const gained = gainedSince(env.sessionManager, observation.leafId);
	if (!gained) return "the branch moved away from the observed request";
	const registered = env.registry.find(recipe.provider, recipe.modelId);
	if (!registered) return "the model is no longer registered";
	let snapshot: Any;
	try {
		snapshot = structuredClone(registered);
	} catch {
		return "the model cannot be copied";
	}
	const fork: Fork = {
		tier: "exact",
		base: withPlaceholders([...observation.transcript, ...gained]),
		observation,
		recipe: { ...recipe },
		modelSnapshot: snapshot,
		branchLength,
	};
	let b0: Payload;
	try {
		b0 = await dryRun(env, fork, structuredClone(snapshot), observation.transcript);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const delta = diffTopLevel(b0, p);
	const c1 = checkC1(recipe.api, b0, p, delta);
	if (!c1.ok) return c1.reason!;
	fork.b0 = b0;
	fork.delta = delta;
	fork.pHash = await sha256(canonical(p));
	// A lower effort is used only when the dry conversion proves that it changes nothing but E.
	const lower = asideLevel(snapshot, recipe.reasoning);
	if (lower !== recipe.reasoning) {
		try {
			const b0e = await dryRun(env, fork, structuredClone(snapshot), observation.transcript, lower);
			if (differsOnlyInConfig(recipe.api, b0e, b0) && !deepEqual(b0e, b0)) {
				fork.effort = lower;
				fork.b0e = b0e;
			}
		} catch {
			// the main session's level
		}
	}
	return fork;
}

function canonical(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
		return out;
	}
	return value;
}

/** The physical model of the latest response on the branch. */
function lastPhysicalModel(env: ForkEnv): { provider: string; id: string } | undefined {
	const branch: Any[] = env.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : undefined;
		if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && m.api !== "pi-virtual") {
			return { provider: m.provider, id: m.model };
		}
	}
	return undefined;
}

export function makeRebuilt(env: ForkEnv, observation: Observation | undefined, reason: string, branchLength: number): Fork {
	let base: unknown[] | undefined;
	let recipe: Recipe | undefined = observation?.recipe;
	if (observation) {
		const gained = gainedSince(env.sessionManager, observation.leafId);
		if (gained) base = withPlaceholders([...observation.transcript, ...gained]);
	}
	if (!base) {
		const context = env.sessionManager.buildSessionContext();
		const system = env.systemPrompt();
		base = withPlaceholders([
			...(system ? [{ role: "system", content: system, timestamp: 0 }] : []),
			...(context?.messages ?? []),
		]);
		recipe = undefined;
	}
	let provider: string;
	let modelId: string;
	let api: string;
	if (recipe && !recipe.virtual) {
		provider = recipe.provider;
		modelId = recipe.modelId;
		api = recipe.api;
	} else {
		const physical = lastPhysicalModel(env);
		const selected = env.selectedModel();
		const found = physical ? env.registry.find(physical.provider, physical.id) : undefined;
		const model = found ?? selected;
		if (!model) throw new Error("no model is selected");
		provider = model.provider;
		modelId = model.id;
		api = model.api;
	}
	const level = recipe?.reasoning ?? (env.thinkingLevel() === "off" ? undefined : env.thinkingLevel());
	const settings = env.settings();
	const lower = asideLevel(env.registry.find(provider, modelId), level);
	return {
		tier: "rebuilt",
		reason,
		base,
		observation,
		...(lower !== level ? { effort: lower } : {}),
		recipe: {
			provider,
			modelId,
			api,
			reasoning: level,
			// T1 is isolated from the main session's transport state (§4.8).
			sessionId: crypto.randomUUID(),
			transport: "sse",
			thinkingBudgets: recipe?.thinkingBudgets ?? settings.getThinkingBudgets(),
			blockImages: recipe?.blockImages ?? settings.getBlockImages(),
		},
		branchLength,
	};
}

/** Send one request of the side thread: base ++ exchange. */
export async function send(
	env: ForkEnv,
	fork: Fork,
	exchange: unknown[],
	signal: AbortSignal,
	onEvent: (event: Any) => void,
): Promise<SendResult> {
	const messages = [...fork.base, ...exchange];
	if (fork.tier === "exact") {
		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await sendExact(env, fork, messages, signal, onEvent);
			if (result !== "restart") return result;
		}
		return demote(env, fork, "the model configuration kept changing", messages, signal, onEvent);
	}
	return sendRebuilt(env, fork, messages, signal, onEvent);
}

async function demote(
	env: ForkEnv,
	fork: Fork,
	reason: string,
	messages: unknown[],
	signal: AbortSignal,
	onEvent: (event: Any) => void,
): Promise<SendResult> {
	const rebuilt = makeRebuilt(env, fork.observation, reason, fork.branchLength);
	// The rebuilt fork keeps the same conversation; only the transport isolation and the label change.
	fork.tier = "rebuilt";
	fork.reason = reason;
	fork.recipe = rebuilt.recipe;
	fork.effort = rebuilt.effort;
	fork.b0 = undefined;
	fork.b0e = undefined;
	fork.delta = undefined;
	return sendRebuilt(env, fork, messages, signal, onEvent);
}

/**
 * Pi adjusts the output ceiling as context estimates change. It is outside the cached prompt; accept only the
 * ceiling computed by Pi for this request, leaving every other field (including thinking budgets) under C2/C3.
 */
function withContextBudget(api: string, payload: Payload, generated: Payload, model: Any, context: Any): Payload {
	const field = api === "openai-responses" ? "max_output_tokens" : api === "openai-completions" && "max_completion_tokens" in payload ? "max_completion_tokens" : "max_tokens";
	if (typeof payload[field] !== "number") return payload;
	const limit = clampMaxTokensToContext(model, context, model.maxTokens);
	const expected = api === "openai-responses" ? Math.max(16, limit) : limit;
	// A fixed sampling-parameter override may keep the old cap: compare that unchanged, as before.
	return generated[field] === expected ? { ...payload, [field]: expected } : payload;
}

async function sendExact(
	env: ForkEnv,
	fork: Fork,
	messages: unknown[],
	signal: AbortSignal,
	onEvent: (event: Any) => void,
): Promise<SendResult | "restart"> {
	const recipe = fork.recipe;
	const p = fork.observation!.payload!;
	let restart = false;
	let fallback: string | undefined;
	let sent: Payload | undefined;
	let sentAt: number | undefined;
	// Same-tick send of a private model recipe (§4.2): look up, clone, snapshot the environment and start the
	// stream in one synchronous step.
	const registered = env.registry.find(recipe.provider, recipe.modelId);
	if (!registered) return demote(env, fork, "the model is no longer registered", messages, signal, onEvent);
	let clone: Any;
	try {
		clone = structuredClone(registered);
	} catch {
		return demote(env, fork, "the model cannot be copied", messages, signal, onEvent);
	}
	if (!deepEqual(clone, fork.modelSnapshot)) {
		return demote(env, fork, "the model configuration changed", messages, signal, onEvent);
	}
	const options = baseOptions(env, fork, clone, signal);
	const context = toContext(env.projectMessages?.(messages) ?? messages, recipe.blockImages);
	const env0 = envSnapshot();
	options.onPayload = (b1: unknown) => {
		// Currency check: the registry's model and the environment are still the ones cloned.
		let fresh: Any;
		try {
			fresh = structuredClone(env.registry.find(recipe.provider, recipe.modelId));
		} catch {
			fresh = undefined;
		}
		if (!deepEqual(fresh, clone) || !envUnchanged(env0)) {
			restart = true;
			throw new Fallback("restart");
		}
		const expectedBase = withContextBudget(recipe.api, fork.b0e ?? fork.b0!, b1 as Payload, clone, context);
		const expectedObserved = withContextBudget(recipe.api, p, b1 as Payload, clone, context);
		const c2 = checkC2(recipe.api, expectedBase, b1 as Payload, p);
		if (!c2.ok) {
			fallback = c2.reason;
			throw new Fallback(c2.reason);
		}
		const f = applyDelta(b1 as Payload, fork.delta!);
		const c3 = checkC3(recipe.api, f, expectedObserved, fork.b0e ? splitList(recipe.api, fork.b0e)?.config : undefined);
		if (!c3.ok) {
			fallback = c3.reason;
			throw new Fallback(c3.reason);
		}
		sent = f;
		sentAt = Date.now();
		return f;
	};
	const stream = env.registry.streamSimple(clone, context, options);
	const message = await pump(stream, onEvent, () => sent !== undefined);
	if (restart) return "restart";
	if (fallback) return demote(env, fork, fallback, messages, signal, onEvent);
	// A request the provider answered read P's prefix again and renewed its cache.
	if (sentAt !== undefined && message?.stopReason !== "error") fork.observation!.touch(sentAt);
	return { message, tier: "exact", markers: sent ? countMarkers(sent) : undefined, sent };
}

async function sendRebuilt(
	env: ForkEnv,
	fork: Fork,
	messages: unknown[],
	signal: AbortSignal,
	onEvent: (event: Any) => void,
): Promise<SendResult> {
	const recipe = fork.recipe;
	const model = env.registry.find(recipe.provider, recipe.modelId) ?? env.selectedModel();
	if (!model) throw new Error("no model is available for the aside");
	const options = baseOptions(env, fork, model, signal);
	let sent: Payload | undefined;
	options.onPayload = (payload: unknown) => {
		if (payload && typeof payload === "object" && "previous_response_id" in payload) {
			const copy = { ...(payload as Payload) };
			delete copy.previous_response_id;
			sent = copy;
			return copy;
		}
		sent = payload as Payload;
		return undefined;
	};
	const stream = env.registry.streamSimple(model, toContext(env.projectMessages?.(messages) ?? messages, recipe.blockImages), options);
	const message = await pump(stream, onEvent, () => true);
	return { message, tier: "rebuilt", reason: fork.reason, markers: sent ? countMarkers(sent) : undefined, sent };
}

/** Drain a stream, forwarding its events only once the request was accepted for sending. */
async function pump(stream: Any, onEvent: (event: Any) => void, accepted: () => boolean): Promise<Any> {
	for await (const event of stream) {
		if (accepted()) onEvent(event);
	}
	return await stream.result();
}

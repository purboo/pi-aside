// A side thread (docs/design.md §4.4, §4.5; docs/ux.md §3.2, §3.9): questions, answers and side tasks over one fork,
// with the session's callable tools, follow-ups that fork again when the main session has moved, and accounting.

import { type Fork, type ForkEnv, gainedSince, makeFork, type SendResult, send, type Tier } from "./fork.ts";
import type { Observer } from "./observe.ts";
import { hasRouteLine, parseReply, type ParsedReply } from "./reply.ts";
import type { ToolExecutor, ToolUsage } from "./tools.ts";
import type { UsageQueue } from "./usage.ts";

// biome-ignore lint: Pi's message types are used structurally.
type Any = any;

export const MAX_TOOL_ROUNDS = 24;
export const INTERNAL_TOOLS = [
	{ name: "tell_agent", description: "Relay a self-contained message to the main agent ONLY on the user's explicit request.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false } },
	{ name: "move_out", description: "Move this aside to its own Pi window ONLY on the user's explicit request.", parameters: { type: "object", properties: { name: { type: "string" }, hint: { type: "string" } }, additionalProperties: false } },
];
/** Built-in tools that only read: their calls pass as an activity line and are not kept as steps. */
export const READING_TOOLS = ["read", "grep", "find", "ls"] as const;

export function notice(options: { routeCheck: boolean }): string {
	const lines = [
		"<aside>",
		"The user is asking this on the side, in a temporary side conversation, while the main agent keeps working. The main agent does not see this exchange. Only an explicit user request to relay something authorizes sending it to the main agent.",
		"Answer the question or do the task directly and briefly, in the language of the user's message. The main session's callable tools (including read, bash, edit, write, grep, find and ls when enabled) run here with the same validation and permission checks. Tools that Pi cannot call from another tool are unavailable here. Leave the main agent's own work alone: do not change the files, processes or state it is working on.",
	];
	if (options.routeCheck) {
		lines.push(
			"Start your reply with one line that is exactly `route: side` or `route: agent`, before any tool call. Write `route: agent` only when the message is about the main agent's own work: it asks the agent to do, stop or change something in what it is doing (for example \"can you also add tests?\", or \"why are you deleting the tests?\" meaning stop). A question, or a task that is not part of the agent's work (for example checking disk space, or writing a note to a file), is `route: side`: answer it or do it here, after the route line. A request to pass something from this side conversation on to the main agent (for example \"tell the agent what we found\") is also `route: side`: the agent has not seen this conversation.",
		);
	}
	lines.push(
		"Call tell_agent({message}) ONLY when the user's latest message explicitly asks you to tell/pass/relay something to the main agent, in any language. Never on your own initiative. The message must be self-contained: the main agent never saw this aside conversation. You can reach the agent with this tool; never claim you cannot. Its result tells you whether delivery is queued or read, so a brief confirmation is enough.",
		"Call move_out({name, hint}) ONLY on an explicit request to move this aside to its own window. Choose 2–3 lowercase English words in kebab case for name and one placeholder sentence in the conversation language for hint (for example: tell the agent when you're done). Do not make a separate naming request.",
		"You may end with one hidden last line `next: <what the user would say next>` only when there is an obvious next step; usually omit it. One short sentence, in the user's words and conversation language. Never add the /aside prefix. You may suggest telling the agent, but do not send without an explicit request.",
		"After a round-limit tool result, summarize done ✓ and left …, then stop with a next: line suggesting continuation. If much work remains, suggest moving this to its own window instead.",
		"</aside>",
	);
	return lines.join("\n");
}

/** A finished call of a tool that may change something (bash, edit, write): what the aside did. */
export interface Step {
	label: string;
	ok: boolean;
}

export interface TurnView {
	question: string;
	/** The answer text so far, route and next lines included. */
	raw: string;
	done: boolean;
	error?: string;
	/** A dim activity line, such as `reading src/a.ts` or `$ du -sh ~`. */
	activity?: string;
	/** Finished calls of tools that may change something, in order. */
	steps: Step[];
	relays?: Relay[];
	/** The model's (summarized) thinking in the current request, while no answer text has arrived. */
	thinking?: string;
	/** When the question was asked, and when the answer's first text arrived (ms since the epoch). */
	startedAt: number;
	firstTextAt?: number;
	/** The thinking level the aside used, when lower than the main session's. */
	effort?: string;
	tier?: Tier;
	reason?: string;
	cost: number;
	read: number;
	written: number;
	/** The main response's cacheable prefix at the fork (T0). */
	predicted?: number;
	aborted?: boolean;
}

export interface Relay { id: string; message: string; read: boolean }

export interface ThreadHost {
	env: ForkEnv;
	observer: Observer;
	usage: UsageQueue;
	cwd: () => string;
	sessionId: () => string;
	/** Execute through the main session's validation and permission hooks; unavailable means fail closed. */
	executeTool?: ToolExecutor;
	tellAgent?: (message: string) => Relay;
	moveOut?: (thread: AsideThread, args: { name?: string; hint?: string }, signal: AbortSignal) => Promise<void>;
	onUpdate: () => void;
}

function textOf(message: Any): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((c: Any) => c?.type === "text")
		.map((c: Any) => c.text)
		.join("");
}

function thinkingOf(message: Any): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((c: Any) => c?.type === "thinking" && typeof c.thinking === "string")
		.map((c: Any) => c.thinking)
		.join("\n\n");
}

/** The first non-empty line of a command, shortened, with `…` when more follows. */
export function oneLine(text: unknown, max = 80): string {
	const all = String(text ?? "").trim();
	const first = all.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
	if (first.length > max) return `${first.slice(0, max - 1)}…`;
	return all.includes("\n") ? `${first} …` : first;
}

/** What a tool call does, in a few words: the activity line while it runs, and the step it leaves. */
export function activityFor(call: Any): string {
	const args = call.arguments ?? {};
	switch (call.name) {
		case "move_out":
			return "moving to its own window…";
		case "tell_agent":
			return "telling the agent";
		case "read":
			return `reading ${args.path ?? ""}`.trim();
		case "grep":
			return `searching ${args.pattern ?? ""}`.trim();
		case "find":
			return `finding ${args.pattern ?? ""}`.trim();
		case "ls":
			return `listing ${args.path ?? "."}`;
		case "bash":
			return `$ ${oneLine(args.command)}`;
		case "powershell":
			return `PS> ${oneLine(args.command)}`;
		case "edit":
			return `edit ${args.path ?? ""}`.trim();
		case "write":
			return `write ${args.path ?? ""}`.trim();
		default:
			return String(call.name);
	}
}

function isReading(name: string): boolean {
	return (READING_TOOLS as readonly string[]).includes(name);
}

function toolResult(call: Any, text: string, isError: boolean): Any {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

/** Count the branch entries that put something into the model context. */
function contextEntryCount(sessionManager: Any): number {
	const branch: Any[] = sessionManager.getBranch();
	return branch.filter((e) => e.type === "message" || e.type === "custom_message" || e.type === "compaction" || e.type === "branch_summary").length;
}

export class AsideThread {
	fork: Fork | undefined;
	/** Q1, A1 (with tool rounds), Q2, … over the fork's base. */
	private exchange: unknown[] = [];
	/** Ordinary messages retained for promotion, independently of request re-forks. */
	readonly history: Any[] = [];
	baseBranch: Any[] = [];
	private promotion: { name?: string; hint?: string } | undefined;
	retired = false;
	private idleWaiters: Array<() => void> = [];
	private pauseRequested = false;
	waitForIdle(): Promise<void> {
		if (!this.busy) return Promise.resolve();
		this.pauseRequested = true;
		return new Promise(resolve => this.idleWaiters.push(resolve));
	}
	readonly turns: TurnView[] = [];
	private controller: AbortController | undefined;
	private contextCount = 0;
	private observationSeq: number | undefined;
	readonly epoch: number;
	readonly sessionId: string;

	constructor(private readonly host: ThreadHost) {
		this.epoch = host.observer.epoch;
		this.sessionId = host.sessionId();
	}

	get busy(): boolean {
		return this.controller !== undefined;
	}

	get current(): TurnView | undefined {
		return this.turns.at(-1);
	}

	parsed(turn: TurnView | undefined = this.current): ParsedReply | undefined {
		return turn ? parseReply(turn.raw, turn.done) : undefined;
	}

	abort(): void {
		this.controller?.abort();
	}

	/** Whether the main session gained context since this thread's last request. */
	private mainMoved(): boolean {
		if (!this.fork) return true;
		const latest = this.host.observer.choose();
		if (latest && latest.seq !== this.observationSeq) return true;
		return contextEntryCount(this.host.env.sessionManager) !== this.contextCount;
	}

	private quotedExchange(): string {
		const parts: string[] = [];
		for (const turn of this.turns.slice(0, -1)) {
			if (turn.aborted || turn.error) continue;
			const reply = parseReply(turn.raw, true);
			parts.push(`Q: ${turn.question}\nA: ${reply.body}`);
		}
		return parts.length > 0 ? `Earlier in this side conversation:\n\n${parts.join("\n\n")}\n\n` : "";
	}

	/** Ask a question in this thread. Resolves when the answer is complete, failed or aborted. */
	async ask(question: string, options: { routeCheck: boolean; onRoute?: (route: "side" | "agent") => void }): Promise<TurnView> {
		this.controller?.abort();
		this.pauseRequested = false;
		const turn: TurnView = { question, raw: "", done: false, steps: [], startedAt: Date.now(), cost: 0, read: 0, written: 0 };
		this.turns.push(turn);
		const controller = new AbortController();
		this.controller = controller;
		const signal = controller.signal;
		const update = () => {
			if (this.controller === controller || turn.done) this.host.onUpdate();
		};
		let routeReported = false;
		const reportRoute = (complete = turn.done) => {
			if (signal.aborted || turn.aborted || routeReported || !options.onRoute) return;
			const parsed = parseReply(turn.raw, complete);
			if (parsed.route) {
				routeReported = true;
				options.onRoute(parsed.route);
			}
		};
		try {
			let prefix = "";
			if (this.mainMoved()) {
				if (this.fork) prefix = this.quotedExchange();
				turn.activity = "waiting for the main request";
				update();
				await this.host.observer.settle(signal);
				if (signal.aborted) throw new DOMException("aborted", "AbortError");
				const latest = this.host.observer.latest;
				const observation = this.host.observer.choose();
				const why = latest && !latest.usable ? latest.reason : undefined;
				turn.activity = undefined;
				const fork = await makeFork(this.host.env, observation, why);
				signal.throwIfAborted();
				if (!this.fork) this.baseBranch = structuredClone(this.host.env.sessionManager.getBranch());
				this.fork = fork;
				this.exchange = [];
				this.observationSeq = observation?.seq;
				this.contextCount = contextEntryCount(this.host.env.sessionManager);
			}
			const fork = this.fork!;
			turn.tier = fork.tier;
			turn.reason = fork.reason;
			turn.effort = fork.effort;
			turn.predicted = fork.observation?.cacheablePrefix;
			const q = {
				role: "user",
				content: [{ type: "text", text: `${notice(options)}\n\n${prefix}${question}` }],
				timestamp: Date.now(),
			};
			const added: unknown[] = [{ role: "system", content: "", toolsAdded: INTERNAL_TOOLS, timestamp: Date.now() }, q];
			this.history.push({ role: "user", content: question, timestamp: Date.now() });
			let summary = false;
			let textBefore = "";
			for (let round = 0; ; round++) {
				signal.throwIfAborted();
				const result: SendResult = await send(this.host.env, fork, [...this.exchange, ...added], signal, (event: Any) => {
					if (!signal.aborted && event?.partial) {
						turn.raw = textBefore + textOf(event.partial);
						turn.thinking = thinkingOf(event.partial) || undefined;
						if (turn.firstTextAt === undefined && turn.raw.trim() !== "") turn.firstTextAt = Date.now();
						reportRoute();
						update();
					}
				});
				const message = result.message;
				turn.tier = result.tier;
				turn.reason = result.reason ?? turn.reason;
				turn.effort = fork.effort;
				turn.thinking = undefined;
				this.account(fork, result, turn);
				added.push(message);
				this.history.push(message);
				turn.raw = textBefore + textOf(message);
				textBefore = turn.raw;
				if (message.stopReason === "aborted") throw new DOMException("aborted", "AbortError");
				if (message.stopReason === "error") {
					turn.error = message.errorMessage ?? "the request failed";
					break;
				}
				signal.throwIfAborted();
				// The response is complete even if its route line has no trailing newline.
				const route = hasRouteLine(turn.raw) ? parseReply(turn.raw, true).route : undefined;
				reportRoute(true);
				if (route === "agent") break;
				signal.throwIfAborted();
				const calls = (message.content ?? []).filter((c: Any) => c?.type === "toolCall");
				if (calls.length === 0 || message.stopReason !== "toolUse") break;
				if (summary) {
					for (const call of calls) {
						const result = toolResult(call, "Not run: round limit reached. Summarize what is done and what is left, then stop.", true);
						added.push(result); this.history.push(result);
					}
					break;
				}
				if (round + 1 >= MAX_TOOL_ROUNDS) {
					for (const call of calls) {
						const result = toolResult(call, "Not run: round limit reached. Summarize what is done and what is left, then stop.", true);
						added.push(result); this.history.push(result);
					}
					summary = true;
					textBefore = "";
					continue;
				}
				// Routing happens before any tool: even a familiar tool name may have a session override.
				const unrouted = options.routeCheck && route !== "side";
				for (const call of calls) {
					signal.throwIfAborted();
					if (unrouted) {
						const result = toolResult(call, "Not run: start your reply with the route line (`route: side` or `route: agent`), then call tools.", true);
						added.push(result); this.history.push(result);
						continue;
					}
					turn.activity = activityFor(call);
					update();
					signal.throwIfAborted();
					const skippedForFollowup = this.pauseRequested;
					const outcome = await this.runTool(call, signal, turn);
					if (signal.aborted) throw new DOMException("aborted", "AbortError");
					if (!skippedForFollowup && !isReading(call.name) && !["tell_agent", "move_out"].includes(call.name)) turn.steps.push({ label: activityFor(call), ok: !outcome.isError });
					added.push(outcome);
					this.history.push(outcome);
				}
				if (this.promotion || this.pauseRequested) break;
				turn.activity = undefined;
				if (textBefore && !textBefore.endsWith("\n")) textBefore += "\n\n";
				update();
			}
			signal.throwIfAborted();
			this.exchange.push(...added);
			if (summary && !parseReply(turn.raw, true).next) {
				const parsed = parseReply(turn.raw, true);
				turn.raw = `route: ${parsed.route ?? "side"}\n${parsed.body}\nnext: continue`;
			}
			if (this.promotion) {
				const args = this.promotion; this.promotion = undefined;
				await this.host.moveOut?.(this, args, signal);
			}
		} catch (error) {
			if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
				turn.aborted = true;
			} else {
				turn.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			turn.done = true;
			turn.activity = undefined;
			turn.thinking = undefined;
			if (this.controller === controller) {
				this.controller = undefined;
				for (const resolve of this.idleWaiters.splice(0)) resolve();
			}
			reportRoute();
			update();
		}
		return turn;
	}

	private async runTool(call: Any, signal: AbortSignal, turn: TurnView): Promise<Any> {
		try {
			signal.throwIfAborted();
			if (this.pauseRequested) return toolResult(call, "Not run: the user asked a follow-up. Resume if still needed.", true);
			if (this.promotion) return toolResult(call, "Not run: continuing in the new window.", true);
			if (call.name === "tell_agent") {
				const message = call.arguments?.message;
				if (typeof message !== "string" || !message.trim()) return toolResult(call, "message must be a non-empty string", true);
				if (!this.host.tellAgent) return toolResult(call, "Delivery is unavailable.", true);
				const relay = this.host.tellAgent(message.trim());
				(turn.relays ??= []).push(relay);
				return toolResult(call, relay.read ? "Delivered. It has read this." : "Queued. It will see this after its current step.", false);
			}
			if (call.name === "move_out") {
				if (!this.host.moveOut) return toolResult(call, "Moving out is unavailable.", true);
				this.promotion = { name: call.arguments?.name, hint: call.arguments?.hint };
				return toolResult(call, "Moving to its own window.", false);
			}
			if (!this.host.executeTool) return toolResult(call, "Tool execution through Pi's session hooks is unavailable.", true);
			const outcome = await this.host.executeTool(call.name, call.arguments, signal, (result) => this.accountTool(result, turn));
			return {
				...outcome.result,
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: outcome.result.content ?? [],
				isError: outcome.isError,
				timestamp: Date.now(),
			};
		} catch (error) {
			return toolResult(call, error instanceof Error ? error.message : String(error), true);
		}
	}

	private accountTool({ toolName, usage }: ToolUsage, turn: TurnView): void {
		// Paid results remain paid after abort. Never add outcome.result.usage again: the executor
		// reports both the direct tool and its descendants through this callback exactly once.
		turn.cost += usage.cost.total;
		turn.read += usage.cacheRead;
		turn.written += usage.cacheWrite;
		if (!(usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost.total)) return;
		this.host.usage.push({
			sessionId: this.sessionId,
			// Tool usage has no provider/model fields. Match Pi's native tool-result cost bucket.
			provider: "Tools",
			model: "summaries",
			usage,
			note: `pi-aside tier=${turn.tier} tool=${JSON.stringify(toolName)} read=${usage.cacheRead} written=${usage.cacheWrite}`,
		});
		this.host.onUpdate();
	}

	private account(fork: Fork, result: SendResult, turn: TurnView): void {
		const message = result.message;
		const usage = message?.usage;
		if (!usage) return;
		turn.cost += usage.cost?.total ?? 0;
		turn.read += usage.cacheRead ?? 0;
		turn.written += usage.cacheWrite ?? 0;
		// A request that failed before reaching the provider reports nothing.
		if (!(usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) return;
		const parts = [
			`tier=${result.tier}`,
			result.reason ? `reason=${JSON.stringify(result.reason)}` : undefined,
			fork.observation?.cacheablePrefix !== undefined ? `predicted=${fork.observation.cacheablePrefix}` : undefined,
			`read=${usage.cacheRead ?? 0}`,
			`written=${usage.cacheWrite ?? 0}`,
			fork.pHash ? `p=sha256:${fork.pHash}` : undefined,
		].filter(Boolean);
		this.host.usage.push({
			sessionId: this.sessionId,
			provider: message.provider,
			model: message.responseModel ?? message.model,
			usage,
			note: `pi-aside ${parts.join(" ")}`,
		});
	}

	/** The thread's base was forked from this session and nothing reset it since. */
	valid(observer: Observer, sessionId: string): boolean {
		return this.epoch === observer.epoch && this.sessionId === sessionId;
	}
}

export { gainedSince };

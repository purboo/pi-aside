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
/** After a stop, how long a tool may take to return what it did so far; then the aside stops without it. */
export const STOP_GRACE_MS = 1000;
/** The note that opens the question after a stopped reply. */
export const STOPPED_NOTE = "(The user stopped your previous reply before it finished.)";
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
		"Your reply may end with hidden action lines, each on its own line after the visible text. The user does not see them; the side conversation acts on them when your reply ends. They are not tools: never call a tool for them.",
		"`tell: <message>` relays one self-contained line to the main agent. Write it ONLY when the user's latest message explicitly asks you to tell/pass/relay something to the main agent, in any language. Never on your own initiative. The main agent never saw this aside conversation, so include what it needs. This line is how you reach the agent: never claim you cannot. The user sees the delivery status, so a brief confirmation in the visible text is enough.",
		"`forward:` (nothing after the colon) sends the user's previous message in this side conversation to the main agent exactly as they wrote it, as their own message. Write it ONLY when the user's latest message asks to send that earlier message itself to the agent unchanged (for example \"send that to the agent as it is\"), usually because it was meant for the agent. To pass on findings or a reworded message, use `tell:` instead.",
		"`move: <name> | <hint>` moves this aside to its own Pi window. Write it ONLY on an explicit request to move this aside out. name is 2–3 lowercase English words in kebab case; hint is one short placeholder sentence in the same language as the user's messages here, such as \"tell the agent when you're done\" for English. Do not make a separate naming request. Unfinished tool work continues in the new window.",
		"`next: <what the user would say next>` only when there is an obvious next step; usually omit it. One short sentence, in the user's words and conversation language. Never add the /aside prefix. You may suggest telling the agent, but do not send without an explicit request.",
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
	/** The live activity line, such as `reading src/a.ts` or `$ du -sh ~`, and since when. */
	activity?: string;
	activitySince?: number;
	/**
	 * Set the moment the user (or anything else) stopped the turn while it ran: what it was doing (a tool's activity,
	 * `thinking`, `writing`, `working`), when, and for how long that had run. The turn keeps what it did.
	 */
	stopped?: { label: string; at: number; ms: number; tool: boolean };
	/** Finished calls of tools that may change something, in order. */
	steps: Step[];
	relays?: Relay[];
	/** The earlier question this turn's `forward:` line sent to the agent, verbatim. */
	forwarded?: string;
	/** The user sent this question to the agent instead (↑ ↵ or the panel's ↪): nothing more of this turn acts. */
	retracted?: boolean;
	/** The model's (summarized) thinking in the current request, while no answer text has arrived. */
	thinking?: string;
	/** When the question was asked, and when the answer's first text arrived (ms since the epoch). */
	startedAt: number;
	firstTextAt?: number;
	/** When the answer completed, failed or stopped. */
	endedAt?: number;
	/** The thinking level the aside used, when lower than the main session's. */
	effort?: string;
	tier?: Tier;
	reason?: string;
	/** Totals over every request of the turn (tool rounds read the aside's own cache) and its tools' results. */
	cost: number;
	read: number;
	written: number;
	/** Model requests of the turn, and the cache counts of the first: whether the main session's cache was read. */
	requests?: number;
	first?: { read: number; written: number };
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
	/** Send a question of this thread to the agent as the user's own message, with Pi's meaning. */
	forward?: (text: string, askedAt: number) => void;
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

/**
 * Count the branch entries that put something into the model context. A compaction is not counted: a fork made
 * before it stays correct (G skips it), and if its observation is dropped the thread sees that instead.
 */
function contextEntryCount(sessionManager: Any): number {
	const branch: Any[] = sessionManager.getBranch();
	return branch.filter((e) => e.type === "message" || e.type === "custom_message" || e.type === "branch_summary").length;
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
	/** Whether a move-out skipped tool calls of the current answer: the new window then goes on with that work. */
	unfinished = false;
	private idleWaiters: Array<() => void> = [];
	private pauseRequested = false;
	/** Set when a turn was stopped: the next question opens with it. */
	private stoppedNote: string | undefined;
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

	/**
	 * Stop the turn in progress at once. What it did stays in the thread: finished tool calls with their results, the
	 * stopped call with what it printed so far, and the text it wrote. The next question continues after it.
	 */
	abort(): void {
		const turn = this.current;
		if (this.controller && turn && !turn.done && !turn.stopped) {
			const at = Date.now();
			const tool = !!turn.activity;
			const label = turn.activity ?? (parseReply(turn.raw, false).body ? "writing" : turn.thinking?.trim() ? "thinking" : "working");
			turn.stopped = { label, at, ms: at - (tool ? (turn.activitySince ?? turn.startedAt) : turn.startedAt), tool };
		}
		this.controller?.abort();
	}

	/** Whether the main session gained context since this thread's last request. */
	private mainMoved(): boolean {
		if (!this.fork) return true;
		// A newer request, or the thread's own observation went cold after a compaction.
		if (this.host.observer.choose()?.seq !== this.observationSeq) return true;
		return contextEntryCount(this.host.env.sessionManager) !== this.contextCount;
	}

	private quotedExchange(): string {
		const parts: string[] = [];
		for (const turn of this.turns.slice(0, -1)) {
			const reply = parseReply(turn.raw, true);
			// Not what went to the agent instead, nor what failed.
			if (turn.retracted || turn.error || reply.route === "agent" || (turn.aborted && !turn.stopped)) continue;
			const steps = turn.steps.map((step) => `${step.ok ? "✓" : "✗"} ${step.label}`);
			if (turn.stopped) steps.push(`■ ${turn.stopped.label} (stopped by the user)`);
			const body = [...steps, reply.body].filter(Boolean).join("\n");
			parts.push(`Q: ${turn.question}\nA: ${body}${turn.stopped && !turn.stopped.tool ? "\n(stopped by the user before it finished)" : ""}`);
		}
		return parts.length > 0 ? `Earlier in this side conversation:\n\n${parts.join("\n\n")}\n\n` : "";
	}

	/** Ask a question in this thread. Resolves when the answer is complete, failed or aborted. */
	async ask(question: string, options: { routeCheck: boolean; onRoute?: (route: "side" | "agent") => void }): Promise<TurnView> {
		this.controller?.abort();
		this.pauseRequested = false;
		this.unfinished = false;
		const note = this.stoppedNote;
		this.stoppedNote = undefined;
		const turn: TurnView = { question, raw: "", done: false, steps: [], startedAt: Date.now(), cost: 0, read: 0, written: 0 };
		this.turns.push(turn);
		const controller = new AbortController();
		this.controller = controller;
		const signal = controller.signal;
		const update = () => {
			if (this.controller === controller || turn.done) this.host.onUpdate();
		};
		/** The request messages of this turn so far: kept in the thread when the turn completes or is stopped. */
		let added: Any[] | undefined;
		/** The tool call running when the turn was stopped, and what it returned within the grace period. */
		let stoppedCall: { call: Any; outcome?: Any } | undefined;
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
				turn.activitySince = Date.now();
				update();
				await this.host.observer.settle(signal);
				if (signal.aborted) throw new DOMException("aborted", "AbortError");
				const observation = this.host.observer.choose();
				const why = observation ? undefined : this.host.observer.whyNone();
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
				content: [{ type: "text", text: `${notice(options)}\n\n${prefix}${note ? `${note}\n\n` : ""}${question}` }],
				timestamp: Date.now(),
			};
			// The aside declares no tools of its own: added declarations would change the request's tool list on providers
			// without inline tool additions, and the main session's cache would not apply. Actions are reply lines.
			added = [q];
			this.history.push({ role: "user", content: question, timestamp: Date.now() });
			let summary = false;
			let textBefore = "";
			for (let round = 0; ; round++) {
				signal.throwIfAborted();
				const result: SendResult = await send(this.host.env, fork, [...this.exchange, ...added!], signal, (event: Any) => {
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
				if (!options.routeCheck || route === "side") this.act(parseReply(textOf(message), true), turn);
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
					turn.activitySince = Date.now();
					update();
					signal.throwIfAborted();
					const skippedForFollowup = this.pauseRequested;
					const running: { call: Any; outcome?: Any } = { call };
					stoppedCall = running;
					const outcome = await this.stoppable(this.runTool(call, signal, turn), signal);
					if (signal.aborted) {
						running.outcome = outcome;
						throw new DOMException("aborted", "AbortError");
					}
					stoppedCall = undefined;
					if (!skippedForFollowup && !isReading(call.name)) turn.steps.push({ label: activityFor(call), ok: !outcome.isError });
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
			added = undefined;
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
				// Not when a newer question replaced this one mid-flight: its request is already out without this turn.
				if (added && this.controller === controller) this.keepStopped(added, stoppedCall, turn);
			} else {
				turn.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			turn.done = true;
			turn.endedAt = Date.now();
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

	/**
	 * Carry out a reply's action lines: relay at once (one relay per turn), forward the previous question once, and
	 * move out after its tool calls are skipped.
	 */
	private act(parsed: ParsedReply, turn: TurnView): void {
		if (parsed.tell && !turn.relays?.length && this.host.tellAgent) (turn.relays ??= []).push(this.host.tellAgent(parsed.tell));
		if (parsed.forward && turn.forwarded === undefined && this.host.forward) {
			// The previous question, unless it was itself a forward request (whose own previous one went already) or the
			// user already sent it to the agent.
			const earlier = this.turns[this.turns.indexOf(turn) - 1];
			if (earlier && earlier.forwarded === undefined && !earlier.retracted) {
				turn.forwarded = earlier.question;
				this.host.forward(earlier.question, earlier.startedAt);
			}
		}
		if (parsed.move && this.host.moveOut && !this.promotion) this.promotion = parsed.move;
	}

	/** The stopped turn's work goes into the thread, so that the next question continues after it (and reads its cache). */
	private keepStopped(added: Any[], stoppedCall: { call: Any; outcome?: Any } | undefined, turn: TurnView): void {
		const kept: Any[] = [];
		for (const message of added) {
			if (message?.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
				// A reply cut off while streaming: its text stays; its thinking and unfinished tool calls go.
				const text = textOf(message);
				const index = this.history.indexOf(message);
				const clean = text.trim() ? { ...message, content: [{ type: "text", text }], stopReason: "stop" } : undefined;
				if (index >= 0) clean ? this.history.splice(index, 1, clean) : this.history.splice(index, 1);
				if (clean) kept.push(clean);
				continue;
			}
			kept.push(message);
		}
		// Every tool call of the last reply gets its result: the stopped one with what it printed, the rest not run.
		const answered = new Set(kept.filter((m) => m?.role === "toolResult").map((m) => m.toolCallId));
		let last: Any;
		for (const message of kept) if (message?.role === "assistant") last = message;
		for (const call of (last?.content ?? []).filter((c: Any) => c?.type === "toolCall")) {
			if (answered.has(call.id)) continue;
			let result: Any;
			if (stoppedCall && stoppedCall.call.id === call.id) {
				const printed = (stoppedCall.outcome?.content ?? [])
					.map((c: Any) => (c?.type === "text" ? c.text : ""))
					.join("")
					.trim();
				const seconds = Math.round((turn.stopped?.ms ?? 0) / 1000);
				const stop = `Stopped by the user after ${seconds}s, before it finished.`;
				result = toolResult(call, printed && !/^(this operation was aborted|aborted)\.?$/i.test(printed) ? `${printed}\n\n${stop}` : stop, true);
			} else {
				result = toolResult(call, "Not run: the user stopped the aside.", true);
			}
			kept.push(result);
			this.history.push(result);
		}
		this.exchange.push(...kept);
		this.stoppedNote = STOPPED_NOTE;
	}

	/** A tool call that the stop ends at once: it has STOP_GRACE_MS to return what it did so far. */
	private async stoppable<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const stopped = new Promise<undefined>((resolve) => {
			onAbort = () => {
				timer = setTimeout(() => resolve(undefined), STOP_GRACE_MS);
				timer.unref?.();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([work, stopped]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
			if (timer) clearTimeout(timer);
		}
	}

	private async runTool(call: Any, signal: AbortSignal, turn: TurnView): Promise<Any> {
		try {
			signal.throwIfAborted();
			if (this.pauseRequested) return toolResult(call, "Not run: the user asked a follow-up. Resume if still needed.", true);
			if (this.promotion) {
				this.unfinished = true;
				return toolResult(call, "Not run: continuing in the new window.", true);
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
		turn.requests = (turn.requests ?? 0) + 1;
		turn.first ??= { read: usage.cacheRead ?? 0, written: usage.cacheWrite ?? 0 };
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

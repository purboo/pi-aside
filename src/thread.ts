// A side thread (docs/design.md §4.4, §4.5; docs/ux.md §3.2): questions and answers over one fork, read-only tools,
// follow-ups that fork again when the main session has moved, and accounting.

import { createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { type Fork, type ForkEnv, gainedSince, makeFork, type SendResult, send, type Tier } from "./fork.ts";
import type { Observer } from "./observe.ts";
import { parseReply, type ParsedReply } from "./reply.ts";
import type { UsageQueue } from "./usage.ts";

// biome-ignore lint: Pi's message types are used structurally.
type Any = any;

export const MAX_TOOL_ROUNDS = 8;
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export function notice(options: { routeCheck: boolean }): string {
	const lines = [
		"<aside>",
		"The user is asking this on the side, in a temporary side conversation. The main agent keeps working and does not see this exchange. Nothing said here reaches the main session unless the user sends it back.",
		"Answer the question directly and briefly, in the language of the question. Only the read-only tools read, grep, find and ls run here; any other tool call fails.",
	];
	if (options.routeCheck) {
		lines.push(
			"Start your reply with one line that is exactly `route: side` or `route: agent`. Write `route: agent` only when the message is really addressed to the main agent: it asks the agent to do, stop or change something (for example \"can you also add tests?\", or \"why are you deleting the tests?\" meaning stop). Otherwise write `route: side`, then answer.",
		);
	}
	lines.push(
		"If, and only if, your answer shows that the main agent should change what it is doing, end with one line `handoff: <one short instruction to the agent, in the user's language>`. Otherwise do not write that line.",
		"</aside>",
	);
	return lines.join("\n");
}

export interface TurnView {
	question: string;
	/** The answer text so far, route and handoff lines included. */
	raw: string;
	done: boolean;
	error?: string;
	/** A dim activity line, such as `reading src/a.ts`. */
	activity?: string;
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

export interface ThreadHost {
	env: ForkEnv;
	observer: Observer;
	usage: UsageQueue;
	cwd: () => string;
	sessionId: () => string;
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

function activityFor(call: Any): string {
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
		default:
			return `${call.name} is not available in an aside`;
	}
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
		const turn: TurnView = { question, raw: "", done: false, startedAt: Date.now(), cost: 0, read: 0, written: 0 };
		this.turns.push(turn);
		const controller = new AbortController();
		this.controller = controller;
		const signal = controller.signal;
		const update = () => this.host.onUpdate();
		let routeReported = false;
		const reportRoute = () => {
			if (routeReported || !options.onRoute) return;
			const parsed = parseReply(turn.raw, turn.done);
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
				this.fork = await makeFork(this.host.env, observation, why);
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
			const added: unknown[] = [q];
			const tools = this.tools();
			let textBefore = "";
			for (let round = 0; ; round++) {
				const result: SendResult = await send(this.host.env, fork, [...this.exchange, ...added], signal, (event: Any) => {
					if (event?.partial) {
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
				turn.raw = textBefore + textOf(message);
				textBefore = turn.raw;
				if (message.stopReason === "aborted") throw new DOMException("aborted", "AbortError");
				if (message.stopReason === "error") {
					turn.error = message.errorMessage ?? "the request failed";
					break;
				}
				reportRoute();
				if (routeReported && parseReply(turn.raw, false).route === "agent") break;
				const calls = (message.content ?? []).filter((c: Any) => c?.type === "toolCall");
				if (calls.length === 0 || message.stopReason !== "toolUse") break;
				if (round + 1 >= MAX_TOOL_ROUNDS) {
					turn.error = `stopped after ${MAX_TOOL_ROUNDS} tool rounds`;
					break;
				}
				for (const call of calls) {
					turn.activity = activityFor(call);
					update();
					added.push(await this.runTool(tools, call, signal));
				}
				turn.activity = undefined;
				if (textBefore && !textBefore.endsWith("\n")) textBefore += "\n\n";
				update();
			}
			this.exchange.push(...added);
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
			if (this.controller === controller) this.controller = undefined;
			reportRoute();
			update();
		}
		return turn;
	}

	private tools(): Record<string, Any> {
		const cwd = this.host.cwd();
		return {
			read: createReadTool(cwd),
			grep: createGrepTool(cwd),
			find: createFindTool(cwd),
			ls: createLsTool(cwd),
		};
	}

	private async runTool(tools: Record<string, Any>, call: Any, signal: AbortSignal): Promise<unknown> {
		const result = (content: string, isError: boolean) => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: content }],
			isError,
			timestamp: Date.now(),
		});
		const tool = (READ_ONLY_TOOLS as readonly string[]).includes(call.name) ? tools[call.name] : undefined;
		if (!tool) return result(`${call.name} is not available in an aside. Only read, grep, find and ls run here.`, true);
		try {
			const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
			const output = await tool.execute(call.id, args, signal);
			return {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: output?.content ?? [],
				isError: false,
				timestamp: Date.now(),
			};
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
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

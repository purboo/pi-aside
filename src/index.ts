// pi-aside: ask a side question about a running Pi session without touching it, at the cache-read price.
// Engine: docs/design.md. Interaction: docs/ux.md.

import { type ExtensionAPI, type ExtensionContext, copyToClipboard, getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Markdown, matchesKey } from "@earendil-works/pi-tui";
import { BackgroundWork } from "./busy.ts";
import type { ForkEnv } from "./fork.ts";
import { Observer, type Recipe } from "./observe.ts";
import {
	detailLine,
	panelHit,
	type HintKind,
	type MarkdownRenderer,
	MONEY_THRESHOLD,
	type MoreAction,
	type PanelState,
	type PanelView,
	panelRoom,
	panelView,
	plainText,
	Reader,
	type ReaderTurn,
	renderBelow,
	SPIN_MS,
} from "./panel.ts";
import { canTakeBack, endsWithQuestionMark, routeEnter } from "./qmark.ts";
import { parseReply } from "./reply.ts";
import { AsideThread, type Relay, type TurnView } from "./thread.ts";
import { installToolExecutor, projectAsideTools } from "./tools.ts";
import { installFinalPayloadTap } from "./tap.ts";
import { currentSettings } from "./transport.ts";
import { UsageQueue } from "./usage.ts";
import { existsSync } from "node:fs";
import { backlogNote, collectBacklog, Inbox, type InboxDelivery, inboxOnline, inboxPath, inboxSession, legacyInboxPaths, postInbox, promotionOptions, sentTime, shellQuote, tmuxCommand, uniqueName, writePromotedSession } from "./promotion.ts";

// biome-ignore lint: Pi's event and UI types are used structurally where they are not exported.
type Any = any;

const PANEL_WIDGET = "pi-aside";
const BELOW_WIDGET = "pi-aside-below";
const STATUS_KEY = "pi-aside";
const SIDE_NOTE_TYPE = "aside";
const REBUILT_NOTICE_AFTER = 3;
/**
 * After an Esc the aside took (a stop, a close), another this soon is a double press or a key repeat: it does nothing,
 * so that a held or doubled Esc never goes on to close the panel or to stop the agent.
 */
export const ESC_GUARD_MS = 500;
/** Pi's working line while the panel is open, by what Esc does to the aside (Pi's default otherwise). */
export const WORKING_STOP = "Working · esc stops the aside first";
export const WORKING_CLOSE = "Working · esc closes the aside first";
const HISTORY_KEYS = ["tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.historyPrevious", "tui.editor.historyNext"];

/** Pi's Markdown component with Pi's Markdown theme; the last few renders are kept (the spinner redraws often). */
function markdownRenderer(theme: Any): MarkdownRenderer {
	const cache = new Map<string, string[]>();
	return (text, width, style) => {
		const key = `${style ?? ""}|${width}|${text}`;
		const hit = cache.get(key);
		if (hit) return hit;
		let lines: string[];
		try {
			const textStyle = style === "thinking" ? { color: (s: string) => theme.fg("thinkingText", s), italic: true } : undefined;
			lines = new Markdown(text, 0, 0, getMarkdownTheme(), textStyle).render(Math.max(10, width)).map((line) => line.replace(/\s+$/u, ""));
			while (lines.length > 0 && lines.at(-1) === "") lines.pop();
			while (lines.length > 0 && lines[0] === "") lines.shift();
		} catch {
			lines = plainText(text, width);
		}
		if (cache.size >= 8) cache.delete(cache.keys().next().value!);
		cache.set(key, lines);
		return lines;
	};
}

export default function piAside(pi: ExtensionAPI): void {
	const executeTool = installToolExecutor(pi);
	const observer = new Observer();
	let ctxRef: ExtensionContext | undefined;
	let thread: AsideThread | undefined;
	let panel: PanelState = { turns: [] };
	let tuiRef: Any;
	let panelShown = false;
	/** The panel's last render: what Pi's "more" key and the mouse do while it is on screen. */
	let panelLast: PanelView = { lines: [] };
	let panelMore: MoreAction | undefined;
	/** When the aside last took an Esc, and what it did: a stop, or a close of the panel or the reader (ESC_GUARD_MS). */
	let escAt = 0;
	let escDid: "stop" | "close" = "close";
	/** What Esc does to the aside now, as last told to Pi's working line and to `aside:esc` listeners. */
	let escShown: "stop" | "close" | undefined;
	/** Invalidates callbacks and completions from a stopped or replaced aside. */
	let askSeq = 0;
	let belowShown = false;
	/**
	 * The latest message the `?` rule took aside, until it goes to the agent, another aside starts or TAKE_BACK_MS after
	 * its answer. Recalled from Pi's history and sent again (↑ ↵), or a tap on the panel's forward mark, sends it to the
	 * agent instead (docs/ux.md §3.4.1).
	 */
	let retractable: { text: string; thread: AsideThread; turn: TurnView } | undefined;
	/** The editor holds the retractable message, recalled from Pi's history, possibly edited since. */
	let armed = false;
	/** The editor's text before a history key (↑ ↓): the refresh after it sees whether the key recalled the message. */
	let historyFrom: string | undefined;
	let suggestion: string | undefined;
	let childHint = process.env.PI_ASIDE_PARENT ? process.env.PI_ASIDE_HINT : undefined;
	let inboxes: Inbox[] = [];
	let promoted = 0;
	const relays = new Map<string, Relay>();
	let rebuiltInARow = 0;
	let rebuiltNoticeShown = false;
	let unsubscribeInput: (() => void) | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const usage = new UsageQueue({
		state: () => (ctxRef ? { idle: ctxRef.isIdle(), sessionId: ctxRef.sessionManager.getSessionId() } : undefined),
		append: (entry) => {
			(ctxRef!.sessionManager as Any).appendUsage("aside", entry.provider, entry.model, entry.usage, entry.note);
		},
	});

	const background = new BackgroundWork(pi.events as Any, () => refreshBelow());

	const env: ForkEnv = {
		get registry() {
			return ctxRef!.modelRegistry;
		},
		settings: () => currentSettings(() => pi.getSettings()),
		get sessionManager() {
			return ctxRef!.sessionManager;
		},
		selectedModel: () => ctxRef?.model,
		thinkingLevel: () => pi.getThinkingLevel(),
		systemPrompt: () => ctxRef?.getSystemPrompt() ?? "",
		projectMessages: (messages) => projectAsideTools(messages, pi.getActiveTools()),
	};

	// ---------------------------------------------------------------- observation (design §4.1)

	function recipeFor(ctx: ExtensionContext): Recipe | undefined {
		const model = ctx.model as Any;
		if (!model) return undefined;
		const settings = env.settings();
		const level = pi.getThinkingLevel();
		return {
			provider: model.provider,
			modelId: model.id,
			api: model.api,
			reasoning: level === "off" ? undefined : level,
			sessionId: ctx.sessionManager.getSessionId(),
			transport: settings.getTransport(),
			thinkingBudgets: settings.getThinkingBudgets(),
			blockImages: settings.getBlockImages(),
			virtual: model.api === "pi-virtual",
		};
	}

	pi.on("context_with_system", (event, ctx) => {
		ctxRef = ctx;
		const recipe = recipeFor(ctx);
		if (recipe) observer.open(event.messages.slice(), ctx.sessionManager.getLeafId(), recipe);
		return undefined;
	});
	pi.on("before_provider_headers", (event) => {
		observer.headers(event.headers as Any);
	});
	pi.on("before_provider_request", (event) => {
		observer.request(event.payload);
		return undefined;
	});
	pi.on("after_provider_response", (event) => {
		observer.response(event.status);
	});
	pi.on("cache_warming_decision", () => {
		observer.warming();
		return undefined;
	});
	pi.on("provider_stream_event", (event) => {
		const l = observer.latest;
		if (l && l.recipe.virtual && l.state === "promoted" && !l.ready) {
			l.recipe.provider = event.provider;
			l.recipe.modelId = event.model;
			l.recipe.api = event.api;
			l.recipe.virtual = false;
		}
	});
	const usageOf = (u: Any) =>
		u ? { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 } : undefined;
	pi.on("message_update", (event) => {
		const message = event.message as Any;
		if (message.role === "assistant") observer.assistantUpdate(usageOf(message.usage));
	});
	pi.on("message_end", (event) => {
		const message = event.message as Any;
		if (message.role === "assistant") observer.assistantEnd(usageOf(message.usage), message.stopReason);
		return undefined;
	});
	pi.on("agent_start", () => refreshBelow());
	pi.on("agent_end", () => {
		observer.end();
		usage.drain();
		refreshBelow();
	});

	// ---------------------------------------------------------------- sessions

	function resetSession(ctx: ExtensionContext | undefined): void {
		closeInboxes(); relays.clear();
		askSeq++;
		escAt = 0;
		thread?.abort();
		thread = undefined;
		forgetRetractable();
		panel = { turns: [] };
		suggestion = undefined;
		rebuiltInARow = 0;
		observer.reset();
		background.reset();
		if (ctx) ctxRef = ctx;
		showPanel(false);
		refreshBelow();
	}

	function beforeLeaving(): void {
		askSeq++;
		const dropped = usage.flushOrDrop();
		thread?.abort();
		forgetRetractable();
		if (dropped > 0) {
			try {
				ctxRef?.ui.setStatus(STATUS_KEY, `aside: ${dropped} usage ${dropped === 1 ? "entry" : "entries"} not recorded (session was busy)`);
			} catch {
				// the UI may already be gone
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		resetSession(ctx);
		installFinalPayloadTap(ctx.modelRegistry, (payload) => observer.finalPayload(payload));
		installTui(ctx);
		// Watch only after a move-out made the inbox. A reload or a restart that resumes the session keeps
		// listening for windows opened before it, and first delivers what they sent while it was away.
		const id = ctx.sessionManager.getSessionId();
		if (existsSync(inboxPath(id)) || legacyInboxPaths(id).length > 0) ensureInbox();
		refreshBelow();
	});
	pi.on("session_before_switch", () => {
		beforeLeaving();
		return undefined;
	});
	pi.on("session_before_fork", () => {
		beforeLeaving();
		return undefined;
	});
	pi.on("session_shutdown", () => {
		beforeLeaving();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		background.dispose();
		closeInboxes();
		// Pi 1.4 throws on any use of a ctx after reload or session replacement; pending timers must not reach it.
		ctxRef = undefined;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	});
	pi.on("session_compact", (event, ctx) => {
		ctxRef = ctx;
		observer.compacted(event.reason === "overflow");
	});
	pi.on("session_tree", (_event, ctx) => {
		askSeq++;
		thread?.abort();
		forgetRetractable();
		ctxRef = ctx;
		observer.reset("the session moved in its tree");
	});

	// ---------------------------------------------------------------- busy and routing (ux §3.1)

	function running(): boolean {
		return ctxRef ? !ctxRef.isIdle() : false;
	}

	function waiting(): boolean {
		return !running() && background.pending > 0;
	}

	function busy(): boolean {
		return running() || background.pending > 0;
	}

	pi.on("input", (event, ctx) => {
		ctxRef = ctx;
		if (event.source !== "interactive") return { action: "continue" };
		// Anything the user sends retires the placeholders, even when typing and Enter arrived in one chunk.
		childHint = undefined;
		suggestion = undefined;
		// The message the `?` rule took aside, sent again: this time it goes where Enter sends it without pi-aside.
		const back = takesBack(event.text);
		armed = false;
		if (back) {
			retract("history");
			return continueToAgent(event.text);
		}
		refreshBelow();
		if (event.images && event.images.length > 0) return continueToAgent(event.text);
		const key = event.streamingBehavior === "followUp" ? "followUp" : "submit";
		if (routeEnter({ text: event.text, busy: busy(), key }) === "side") {
			void startAside(event.text, { routeCheck: true });
			return { action: "handled" };
		}
		return continueToAgent(event.text);
	});

	function continueToAgent(_text: string): { action: "continue" } {
		suggestion = undefined;
		refreshBelow();
		return { action: "continue" };
	}

	// ---------------------------------------------------------------- sending it to the agent instead (ux §3.4)

	function forgetRetractable(): void {
		retractable = undefined;
		armed = false;
	}

	/** The retractable message, while it can still go to the agent instead. */
	function retractableNow(): typeof retractable {
		if (retractable && !canTakeBack(retractable.turn, Date.now())) forgetRetractable();
		return retractable;
	}

	/**
	 * Whether submitting `text` sends the retractable message to the agent: it was recalled from Pi's history, and maybe
	 * edited since. Typing the same words again is not enough: a question asked again is usually a new side question.
	 */
	function takesBack(text: string): boolean {
		const head = text.trim();
		if (!armed || head === "" || head.startsWith("/") || head.startsWith("!")) return false;
		return !!retractableNow();
	}

	/**
	 * Note what the editor holds. A history key that brings the retractable message into the editor arms it; one that
	 * brings in something else disarms it; edits keep it armed until the editor is empty again.
	 */
	function noteEditor(text: string): void {
		const from = historyFrom;
		historyFrom = undefined;
		if (text.trim() === "") armed = false;
		else if (from !== undefined && text !== from) {
			const r = retractableNow();
			armed = !!r && text.trim() === r.text.trim();
		}
	}

	/**
	 * The user sends the retractable message to the agent instead: the aside stops, what it said so far stays, and the
	 * panel says where the message went. The caller sends the text (Pi's own path for an Enter). Returns the text.
	 */
	function retract(via: "history" | "mark"): string | undefined {
		const r = retractableNow();
		if (!r) return undefined;
		forgetRetractable();
		r.turn.retracted = true;
		sentBack(r.text, via, r.turn.startedAt);
		if (r.thread === thread) {
			// Only this question's turn can be running: another aside would have replaced the retractable message.
			if (!r.turn.done) r.thread.abort();
			if (panel.turns === r.thread.turns && panel.turns.at(-1) === r.turn) {
				panel.sentToAgent = { text: r.text, waiting: !running(), byUser: true };
				suggestion = undefined;
			}
		}
		renderNow();
		setTimeout(refreshBelow, 0);
		return r.text;
	}

	/** Each message sent to the agent instead is a misroute the user corrected (docs/ux.md §5.2): count it. */
	function sentBack(question: string, via: "history" | "mark" | "forward", askedAt: number): void {
		pi.events.emit("aside:sent-back", { question, via, afterMs: Date.now() - askedAt });
	}

	/** Whether the hint below an empty editor offers ↑ ↵: the retractable message is in the open panel, still answered. */
	function undoable(): boolean {
		const r = retractable;
		// Also once stopped: an Esc right after the `?` rule took a message aside often meant "no, that was for the agent".
		return !!r && r.thread === thread && !panel.hidden && !panel.sentToAgent && panel.turns.at(-1) === r.turn && (!r.turn.done || !!r.turn.stopped);
	}

	function deliver(message: string, name = "aside"): Relay {
		const relay: Relay = { id: crypto.randomUUID(), message, read: !running() };
		relays.set(relay.id, relay);
		pi.sendMessage({ customType: SIDE_NOTE_TYPE, content: `Relayed from the user's aside conversation (${name}):\n\n${message}`, display: true, details: { id: relay.id, name, message } }, { triggerTurn: true, deliverAs: "steer" });
		return relay;
	}

	pi.on("message_start", event => {
		const message = event.message as Any;
		if (message.role === "custom" && message.customType === SIDE_NOTE_TYPE) {
			const relay = relays.get(message.details?.id);
			if (relay) { relay.read = true; relays.delete(relay.id); renderNow(); }
		}
	});
	pi.registerMessageRenderer<{ name: string; message: string; backlog?: { name: string; message: string; sentAt: number; times: number }[] }>(SIDE_NOTE_TYPE, (message, _options, theme) => ({
		render: width => {
			const backlog = message.details?.backlog;
			if (!backlog) return plainText(`${message.details?.name ?? "aside"} › ${message.details?.message ?? message.content}`, width).map(line => theme.fg("accent", line));
			return [
				...plainText(theme.fg("dim", `aside › ${backlog.length} queued while Pi was offline`), width),
				...backlog.flatMap(item => plainText(`aside:${item.name} · ${sentTime(item.sentAt)}${item.times > 1 ? ` ×${item.times}` : ""} › ${item.message}`, width).map(line => theme.fg("accent", line))),
			];
		}, invalidate() { },
	}));
	pi.registerEntryRenderer<{ name: string; index: string; target: string }>("aside-window", (entry, _options, theme) => ({
		render: width => plainText(theme.fg("dim", `↗ aside:${entry.data?.name} · window ${entry.data?.index}`), width), invalidate() { },
		handleMouse: event => {
			if (event.button === "left" && event.type === "click" && entry.data?.target) {
				void pi.exec("tmux", ["select-window", "-t", entry.data.target]); return { handled: true };
			}
			return undefined;
		},
	}));
	if (process.env.PI_ASIDE_PARENT) pi.registerTool({
		name: "tell_agent", label: "Tell the agent", description: "Relay a self-contained message to the parent agent ONLY when the user's latest message explicitly asks to tell/pass/relay something. Never send on your own initiative.",
		parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
		async execute(_id, args) {
			if (typeof args.message !== "string" || !args.message.trim()) throw new Error("message must be a non-empty string");
			const dir = process.env.PI_ASIDE_PARENT!;
			postInbox(dir, { name: process.env.PI_ASIDE_NAME ?? "aside", message: args.message.trim() });
			// Say "delivered" only when a Pi is listening; otherwise the message waits for the session to be resumed.
			const text = inboxOnline(dir)
				? "Delivered to the parent inbox."
				// `pi -c` would reopen this window's own, newer session, so name the original one.
				: `Queued, not delivered yet: no Pi is running the original agent's session now. It will receive this as soon as that session is resumed: \`pi --session ${inboxSession(dir)}\` (not \`pi -c\`, which reopens this window's session). Tell the user exactly this.`;
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	function ensureInbox(): string {
		const id = ctxRef!.sessionManager.getSessionId();
		const dir = inboxPath(id);
		if (inboxes.length === 0) {
			// What waited in any of the session's inboxes arrives as one late message, not a burst of steers.
			const waiting: InboxDelivery[] = [];
			for (const path of [dir, ...legacyInboxPaths(id)]) {
				const inbox = new Inbox(path, (value, backlog) => backlog ? waiting.push(value) : deliver(value.message, `aside:${value.name}`), error => ctxRef?.ui.notify(`aside: ${String(error)}`, "error"));
				inbox.start();
				inboxes.push(inbox);
			}
			if (waiting.length > 0) {
				try { deliverBacklog(waiting); } catch (error) {
					// Put them back so the next scan retries them.
					for (const value of waiting) postInbox(dir, value);
					ctxRef?.ui.notify(`aside: ${String(error)}`, "error");
				}
			}
		}
		return dir;
	}
	function deliverBacklog(values: InboxDelivery[]): void {
		const items = collectBacklog(values);
		const relay: Relay = { id: crypto.randomUUID(), message: items.map(item => item.message).join("\n\n"), read: !running() };
		relays.set(relay.id, relay);
		pi.sendMessage({ customType: SIDE_NOTE_TYPE, content: backlogNote(items), display: true, details: { id: relay.id, name: "aside", message: relay.message, backlog: items } }, { triggerTurn: true, deliverAs: "steer" });
	}
	function closeInboxes(): void {
		for (const inbox of inboxes) inbox.close();
		inboxes = [];
	}

	async function moveOut(current: AsideThread, args: { name?: string; hint?: string }, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const ctx = ctxRef!;
		const options = promotionOptions(args, ++promoted);
		const tmux = !!process.env.TMUX && !!process.env.TMUX_PANE;
		// new-window takes a window, not a pane: the new window goes right after the one Pi runs in.
		let window = "";
		if (tmux) {
			const here = await pi.exec("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE!, "#{window_id}"]);
			if (here.code !== 0) throw new Error(here.stderr.trim() || "Could not find the tmux window");
			window = here.stdout.trim();
			const windows = await pi.exec("tmux", ["list-windows", "-t", window, "-F", "#{window_name}"]);
			if (windows.code !== 0) throw new Error(windows.stderr.trim() || "Could not list tmux windows");
			signal.throwIfAborted();
			options.name = uniqueName(options.name, windows.stdout.trim().split("\n"));
		}
		const file = writePromotedSession({ cwd: ctx.cwd, branch: current.baseBranch, history: current.history, name: options.name, sessionDir: ctx.sessionManager.getSessionDir(), parentFile: ctx.sessionManager.getSessionFile(), relay: tmux });
		if (!tmux) {
			current.retired = true;
			const command = `pi --session ${shellQuote(file)}`;
			try { await copyToClipboard(command); current.current!.raw = `Copied: ${command} — paste it in any terminal.`; }
			catch { current.current!.raw = `${command} — paste it in any terminal.`; }
			return;
		}
		signal.throwIfAborted();
		const result = await pi.exec("tmux", tmuxCommand({ window, cwd: ctx.cwd, file, ...options, inbox: ensureInbox(), continue: current.unfinished }));
		signal.throwIfAborted();
		if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not open tmux window");
		const [target, index] = result.stdout.trim().split("\t");
		pi.appendEntry("aside-window", { name: options.name, index, target });
		askSeq++;
		suggestion = undefined;
		forgetRetractable();
		thread = undefined;
		panel = { turns: [], hidden: true };
		showPanel(false); refreshBelow();
	}

	/** Send the user's original text with Pi's meaning: a steer while running, a prompt otherwise. */
	function sendToAgent(text: string): void {
		try {
			if (running()) pi.sendUserMessage(text, { deliverAs: "steer" });
			else pi.sendUserMessage(text);
		} catch (error) {
			ctxRef?.ui.notify(`aside: could not send to the agent: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	// ---------------------------------------------------------------- asking

	function threadHost() {
		return {
			env,
			observer,
			usage,
			cwd: () => ctxRef?.cwd ?? process.cwd(),
			sessionId: () => ctxRef?.sessionManager.getSessionId() ?? "",
			executeTool,
			tellAgent: deliver,
			forward: (text: string, askedAt: number) => {
				sentBack(text, "forward", askedAt);
				sendToAgent(text);
			},
			moveOut,
			onUpdate: () => renderNow(),
		};
	}

	/**
	 * Whether the next question continues the current thread: exactly while its panel is open (docs/ux.md §3.2). A
	 * closed panel means the user is done with it, and the next question starts afresh.
	 */
	function continues(): boolean {
		const ctx = ctxRef;
		if (!ctx || !thread || thread.retired || thread.turns.length === 0) return false;
		if (panel.hidden || panel.sentToAgent) return false;
		return thread.valid(observer, ctx.sessionManager.getSessionId());
	}

	async function startAside(question: string, options: { routeCheck: boolean }): Promise<TurnView | undefined> {
		const ctx = ctxRef;
		if (!ctx) return undefined;
		const seq = ++askSeq;
		// Another aside starts: the message before it can no longer be taken back.
		forgetRetractable();
		if (!continues()) {
			thread?.abort();
			thread = new AsideThread(threadHost());
			panel = { turns: thread.turns };
		} else if (thread!.busy) {
			const waitingThread = thread!;
			await waitingThread.waitForIdle();
			if (seq !== askSeq || thread !== waitingThread || panel.hidden) return undefined;
		}
		const current = thread!;
		suggestion = undefined;
		panel.hidden = false;
		panel.sentToAgent = undefined;
		panel.scrollTop = undefined;
		showPanel(true);
		const wasWaiting = waiting();
		let routedToAgent = false;
		let asked: TurnView | undefined;
		const answer = current.ask(question, {
			routeCheck: options.routeCheck,
			onRoute: (route) => {
				if (seq !== askSeq || current !== thread || panel.hidden || route !== "agent" || !options.routeCheck || asked?.retracted) return;
				routedToAgent = true;
				if (retractable?.turn === asked) forgetRetractable();
				current.abort();
				panel.sentToAgent = { text: question, waiting: wasWaiting };
				sendToAgent(question);
				renderNow();
				refreshBelow();
			},
		});
		// ask() adds the question's turn before its first await. Only the `?` rule's guess can be taken back.
		asked = current.turns.at(-1);
		if (options.routeCheck && asked) retractable = { text: question, thread: current, turn: asked };
		refreshBelow();
		const turn = await answer;
		if (current !== thread || seq !== askSeq) return turn;
		const parsed = parseReply(turn.raw, true);
		if (options.routeCheck && !routedToAgent && !turn.retracted && !turn.aborted && turn.error && !parseReply(turn.raw, false).route) {
			// The aside failed before its route line: the text keeps Pi's meaning.
			if (retractable?.turn === turn) forgetRetractable();
			panel.sentToAgent = { text: question, waiting: wasWaiting };
			sendToAgent(question);
		} else if (!routedToAgent && parsed.next && !turn.error && !turn.aborted) {
			suggestion = parsed.next;
		}
		noteTier(turn);
		reportStatus(turn);
		if (ctx.mode === "rpc" && !routedToAgent) {
			const text = turn.error ? `aside failed: ${turn.error}` : turn.aborted ? "aside stopped" : parsed.body;
			ctx.ui.notify(text, turn.error ? "error" : "info");
		}
		renderNow();
		refreshBelow();
		return turn;
	}

	function noteTier(turn: TurnView): void {
		if (turn.tier === "rebuilt" && !turn.error && !turn.aborted) {
			rebuiltInARow++;
			if (rebuiltInARow >= REBUILT_NOTICE_AFTER && !rebuiltNoticeShown) {
				rebuiltNoticeShown = true;
				ctxRef?.ui.notify(`aside: the last ${rebuiltInARow} asides rebuilt the context and did not read the main cache (${turn.reason ?? "unknown reason"})`, "warning");
			}
		} else if (turn.tier === "exact") {
			rebuiltInARow = 0;
		}
	}

	/**
	 * Detail line: tier, then the first request's cache counts (whether the main session's cache was read), then the
	 * totals when tool rounds made more requests (those read the aside's own cache), cost. In the status bar only in
	 * RPC mode.
	 */
	function detail(turn: TurnView): string {
		return detailLine(turn, MONEY_THRESHOLD);
	}

	function reportStatus(turn: TurnView): void {
		if (ctxRef?.mode === "rpc") ctxRef.ui.setStatus(STATUS_KEY, `aside: ${detail(turn)}`);
		pi.events.emit("aside:done", {
			question: turn.question,
			tier: turn.tier,
			reason: turn.reason,
			read: turn.read,
			written: turn.written,
			predicted: turn.predicted,
			effort: turn.effort,
			firstTextMs: turn.firstTextAt === undefined ? undefined : turn.firstTextAt - turn.startedAt,
			totalMs: Date.now() - turn.startedAt,
			cost: turn.cost,
			error: turn.error,
			aborted: turn.aborted === true,
			answer: parseReply(turn.raw, true).body,
		});
	}

	// ---------------------------------------------------------------- /aside

	pi.registerCommand("aside", {
		description: "Ask or do an independent task on the side; with no text, reread the latest aside",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				ctx.ui.notify("pi-aside needs the interactive or RPC mode", "error");
				return;
			}
			const question = (args ?? "").trim();
			if (question) {
				void startAside(question, { routeCheck: false });
				return;
			}
			if (!thread || thread.turns.length === 0) {
				ctx.ui.notify("No aside yet. Type /aside <question>, or end a message with ? while the agent works.", "info");
				return;
			}
			if (ctx.mode === "rpc") {
				const turn = thread.turns.at(-1)!;
				ctx.ui.notify(parseReply(turn.raw, true).body, "info");
				return;
			}
			await openReader(ctx);
		},
	});

	function readerTurns(): ReaderTurn[] {
		return (thread?.turns ?? []).map((turn) => {
			const parsed = parseReply(turn.raw, turn.done);
			let answer = parsed.body;
			if (turn.error) answer += `${answer ? "\n\n" : ""}aside failed: ${turn.error}`;
			const stoppedAfter = turn.stopped && turn.stopped.ms >= 1000 ? ` after ${Math.floor(turn.stopped.ms / 1000)}s` : "";
			if (turn.retracted) answer += `${answer ? "\n\n" : ""}↪ sent to the agent`;
			else if (turn.stopped && !turn.stopped.tool) answer += `${answer ? "\n\n" : ""}(stopped while ${turn.stopped.label}${stoppedAfter})`;
			else if (turn.aborted && !turn.stopped) answer += `${answer ? "\n\n" : ""}(stopped)`;
			for (const relay of turn.relays ?? []) answer += `\n\n→ to the agent\n${relay.message}\n${relay.read ? "It has read this." : "It will see this after its current step."}`;
			if (turn.forwarded !== undefined) answer += `\n\n↪ sent to the agent\n${turn.forwarded}`;
			const steps = turn.steps.map((step) => `${step.ok ? "✓" : "✗"} ${step.label}`);
			if (turn.stopped?.tool && !turn.retracted) steps.push(`■ ${turn.stopped.label} · stopped${stoppedAfter}`);
			const hash = thread?.fork?.pHash ? ` · p ${thread.fork.pHash.slice(0, 12)}` : "";
			return { question: turn.question, answer, detail: `${detail(turn)}${hash}`, steps };
		});
	}

	/** Typing in the reader: the thread's panel opens again (so `?` follows up) and the text goes on in the editor. */
	function typeFromReader(text: string): void {
		if (thread && thread.turns.length > 0) panel.hidden = false;
		try {
			ctxRef?.ui.pasteToEditor(text);
		} catch {
			// the editor is gone
		}
		renderNow();
		setTimeout(refreshBelow, 0);
	}

	async function openReader(ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom<void>(
			(tui: Any, theme: Any, _keybindings: Any, done: (result: void) => void) =>
				new Reader(
					readerTurns,
					theme,
					() => {
						escAt = Date.now();
						escDid = "close";
						done(undefined);
					},
					() => tui.requestRender(),
					() => tui.terminal?.rows ?? process.stdout.rows ?? 40,
					markdownRenderer(theme),
					typeFromReader,
					() => typeof tui?.scrollBy === "function",
				),
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } as Any },
		);
	}

	// ---------------------------------------------------------------- TUI (ux §3.2, §3.3)

	function renderNow(): void {
		if (ctxRef?.mode !== "tui") return;
		showPanel(panel.turns.length > 0 && !panel.hidden);
		syncEsc();
		animate();
		try {
			tuiRef?.requestRender();
		} catch {
			// not mounted
		}
	}

	/** Whether the panel shows an answer still running (its spinner turns). */
	function spinning(): boolean {
		const turn = panel.turns.at(-1);
		return !!turn && !turn.done && !turn.stopped && !panel.hidden && !panel.sentToAgent;
	}

	/** Whether the open panel shows the aside at work: Esc then stops it, and leaves the panel open. */
	function asideRunning(): boolean {
		return panelOpen() && !!thread?.busy && panel.turns === thread.turns && spinning();
	}

	/**
	 * Stop the aside at once (docs/ux.md §3.2): the panel stays with what it did, and the next question continues the
	 * thread after it. The main agent keeps going.
	 */
	function stopAside(): void {
		thread?.abort();
		suggestion = undefined;
		renderNow();
		refreshBelow();
	}

	/**
	 * Say what Esc does while the panel is open: in Pi's working line, and to other extensions as `aside:esc`
	 * (`{ action: "stop" | "close" | undefined }`) for those that show their own interrupt hint.
	 */
	function syncEsc(): void {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		const action = panelOpen() ? (asideRunning() ? "stop" : "close") : undefined;
		if (action === escShown) return;
		escShown = action;
		try {
			ctx.ui.setWorkingMessage(action === "stop" ? WORKING_STOP : action === "close" ? WORKING_CLOSE : undefined);
		} catch {
			// an older Pi
		}
		pi.events.emit("aside:esc", { action });
	}

	/** Redraw at the spinner's pace while an answer runs. */
	function animate(): void {
		if (ticker || !spinning()) return;
		ticker = setInterval(() => {
			if (!spinning() || ctxRef?.mode !== "tui") {
				clearInterval(ticker);
				ticker = undefined;
			}
			try {
				tuiRef?.requestRender();
			} catch {
				// not mounted
			}
		}, SPIN_MS);
		ticker.unref?.();
	}

	/**
	 * Pi's "more" key (`app.tools.expand`, ctrl+o) where the open panel prints it: the long answer opens in the
	 * reader. Everywhere else the key keeps Pi's meaning (its tool output).
	 */
	function more(_action: MoreAction): void {
		if (ctxRef) void openReader(ctxRef);
	}

	/** Whether the panel is on screen. */
	function panelOpen(): boolean {
		return panelShown && panel.turns.length > 0 && !panel.hidden;
	}

	/**
	 * Close the panel (docs/ux.md §3.2): Esc, or a click or a tap on its close mark. An answer or a task still running
	 * stops with it. The thread stays readable with `/aside`; the next question starts a new one.
	 */
	function closePanel(): boolean {
		if (panel.turns.length === 0 || panel.hidden) return false;
		askSeq++;
		if (thread?.busy) thread.abort();
		panel.hidden = true;
		suggestion = undefined;
		renderNow();
		syncEsc();
		refreshBelow();
		return true;
	}

	/** The wheel or a swipe over the panel: scroll a long answer; at the end of one still streaming, follow it again. */
	function scrollPanel(delta: number): void {
		const scroll = panelLast.scroll;
		if (!scroll) return;
		const top = Math.min(scroll.max, Math.max(0, (panel.scrollTop ?? scroll.top) + delta));
		const streaming = !!panel.turns.at(-1) && !panel.turns.at(-1)!.done;
		panel.scrollTop = streaming && top >= scroll.max ? undefined : top;
	}

	/** Mouse events over the panel, where Pi reports them (fullscreen mode). */
	function panelMouse(event: Any): { handled: true } | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			scrollPanel(event.wheelDelta);
			return { handled: true };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const hit = panelHit(panelLast, event.width, event.x, event.y, !!panel.mouse);
		if (hit === undefined) return undefined;
		// The press makes the panel the target of the click that follows on the same cell.
		if (event.type === "click") {
			if (hit === "close") closePanel();
			else if (hit === "forward") {
				const text = retract("mark");
				// Too late: the mark goes away.
				if (text !== undefined) sendToAgent(text);
				else renderNow();
			} else if (ctxRef) void openReader(ctxRef);
		}
		return { handled: true };
	}

	function showPanel(show: boolean): void {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		if (show === panelShown) return;
		panelShown = show;
		try {
			if (!show) {
				panelMore = undefined;
				panelLast = { lines: [] };
				ctx.ui.setWidget(PANEL_WIDGET, undefined);
				syncEsc();
				return;
			}
			ctx.ui.setWidget(
				PANEL_WIDGET,
				(tui: Any, theme: Any) => {
					tuiRef = tui;
					const md = markdownRenderer(theme);
					return {
						render: (width: number) => {
							const rows = tui?.terminal?.rows ?? process.stdout.rows ?? 40;
							panel.maxLines = panelRoom(rows, running());
							try {
								panel.moreKey = keyText("app.tools.expand") || undefined;
							} catch {
								panel.moreKey = undefined;
							}
							// Pi reports the mouse in its fullscreen mode, whose renderer scrolls its own viewport.
							panel.mouse = typeof tui?.scrollBy === "function";
							const r = retractableNow();
							panel.forwardable = !!r && r.thread === thread && panel.turns.at(-1) === r.turn;
							panel.continueKey = busy() ? "?" : "/aside";
							const view = panelView(panel, width, theme, md, Date.now());
							panelLast = view;
							panelMore = view.more;
							return view.lines;
						},
						handleMouse: panelMouse,
						invalidate() { },
					};
				},
				{ placement: "aboveEditor" },
			);
		} catch {
			panelShown = false;
		}
	}

	function belowState(): { hint: HintKind; next: string | undefined; agent?: boolean } {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return { hint: undefined, next: undefined };
		let text = "";
		try {
			text = ctx.ui.getEditorText();
		} catch {
			text = "";
		}
		noteEditor(text);
		const back = takesBack(text);
		const side = !back && routeEnter({ text, busy: busy(), key: "submit" }) === "side" && endsWithQuestionMark(text);
		let hint: HintKind = back ? "back" : side ? (continues() ? "follow" : "ask") : undefined;
		if (text === "" && undoable()) hint = "undo";
		if (text !== "") { suggestion = undefined; childHint = undefined; }
		const next = text === "" ? suggestion : undefined;
		// Stopped while the agent runs: Esc is still the aside's until the panel closes. Say so where the user looks.
		const last = panel.turns.at(-1);
		const agent = text === "" && running() && !panel.hidden && !panel.sentToAgent && !!last?.stopped && !last.retracted;
		return { hint, next, agent };
	}

	let belowCache: { hint: HintKind; next: string | undefined; agent?: boolean } = { hint: undefined, next: undefined };

	function refreshBelow(): void {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		const state = belowState();
		belowCache = state;
		const show = state.hint !== undefined || state.next !== undefined || !!state.agent || childHint !== undefined;
		try {
			if (show !== belowShown) {
				belowShown = show;
				if (!show) ctx.ui.setWidget(BELOW_WIDGET, undefined);
				else
					ctx.ui.setWidget(
						BELOW_WIDGET,
						(tui: Any, theme: Any) => {
							tuiRef = tui;
							return { render: (width: number) => childHint && !belowCache.next ? plainText(theme.fg("dim", childHint), width) : renderBelow(belowCache, width, theme), invalidate() { } };
						},
						{ placement: "belowEditor" },
					);
			}
			tuiRef?.requestRender();
		} catch {
			belowShown = false;
		}
	}

	/** Whether Pi's input editor has the focus (not a selector, a dialog or another extension's overlay). */
	function editorFocused(): boolean {
		const focus = tuiRef?.getFocusedComponent;
		if (typeof focus !== "function") return true;
		const focused = focus.call(tuiRef);
		return !!focused && typeof focused === "object" && focused.actionHandlers instanceof Map;
	}

	function editorText(): string {
		try {
			return ctxRef?.ui.getEditorText() ?? "";
		} catch {
			return "";
		}
	}

	/** Pi's keys that browse its prompt history (↑ ↓ at the top or bottom of the editor, or the dedicated actions). */
	function isHistoryKey(kb: Any, data: string): boolean {
		return HISTORY_KEYS.some((id) => {
			try {
				return kb.matches(data, id) === true;
			} catch {
				return false;
			}
		});
	}

	/** Whether the editor shows its autocomplete list, which Esc closes first. */
	function autocompleteOpen(): boolean {
		const focused = tuiRef?.getFocusedComponent?.call(tuiRef);
		try {
			return typeof focused?.isShowingAutocomplete === "function" && focused.isShowingAutocomplete() === true;
		} catch {
			return false;
		}
	}

	function installTui(ctx: ExtensionContext): void {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		panelShown = false;
		belowShown = false;
		if (ctx.mode !== "tui") return;
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const kb = getKeybindings();
			// Esc acts on what is in front (docs/ux.md §3.2): it stops the aside while it runs, then closes its panel,
			// then, as in Pi, stops the agent. Each press does one thing: one right after another is a double press.
			if (matchesKey(data, "escape") && editorFocused() && !autocompleteOpen()) {
				const now = Date.now();
				const repeat = now - escAt < ESC_GUARD_MS;
				if (panelOpen()) {
					// A double press right after a stop does not go on to close the panel: the stopped aside can continue.
					if (repeat && escDid === "stop") escAt = now;
					else if (asideRunning()) {
						stopAside();
						[escAt, escDid] = [now, "stop"];
					} else {
						closePanel();
						[escAt, escDid] = [now, "close"];
					}
					return { consume: true };
				}
				// Nor does one right after the aside closed go on to stop the agent.
				if (repeat) {
					escAt = now;
					return { consume: true };
				}
			}
			// Pi's "more" key belongs to the panel only while the panel prints it.
			const action = panelOpen() ? panelMore : undefined;
			if (action && kb.matches(data, "app.tools.expand") && editorFocused()) {
				more(action);
				return { consume: true };
			}
			if ((suggestion || childHint) && editorFocused() && kb.matches(data, "tui.input.tab")) {
				let text = "";
				try {
					text = ctxRef?.ui.getEditorText() ?? "";
				} catch {
					text = "";
				}
				if (text === "") {
					ctxRef?.ui.setEditorText(suggestion ? `/aside ${suggestion}` : childHint!);
					childHint = undefined;
					suggestion = undefined;
					setTimeout(refreshBelow, 0);
					return { consume: true };
				}
			}
			// ↑ ↓ may bring a message back from Pi's history: compare the editor's text before and after the key.
			if (retractable && editorFocused() && isHistoryKey(kb, data)) historyFrom = editorText();
			// The editor applies the key after this listener: look at its text afterwards.
			setTimeout(refreshBelow, 0);
			return undefined;
		});
	}
}

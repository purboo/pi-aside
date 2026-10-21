// pi-aside: ask a side question about a running Pi session without touching it, at the cache-read price.
// Engine: docs/design.md. Interaction: docs/ux.md.

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Markdown } from "@earendil-works/pi-tui";
import { BackgroundWork } from "./busy.ts";
import type { ForkEnv } from "./fork.ts";
import { Observer, type Recipe } from "./observe.ts";
import {
	type MarkdownRenderer,
	MONEY_THRESHOLD,
	PANEL_LINES,
	type PanelState,
	plainText,
	Reader,
	type ReaderTurn,
	renderBelow,
	renderPanel,
	SPIN_MS,
} from "./panel.ts";
import { endsWithQuestionMark, routeEnter } from "./qmark.ts";
import { parseReply } from "./reply.ts";
import { AsideThread, type TurnView } from "./thread.ts";
import { installFinalPayloadTap } from "./tap.ts";
import { currentSettings } from "./transport.ts";
import { UsageQueue } from "./usage.ts";

// biome-ignore lint: Pi's event and UI types are used structurally where they are not exported.
type Any = any;

const PANEL_WIDGET = "pi-aside";
const BELOW_WIDGET = "pi-aside-below";
const STATUS_KEY = "pi-aside";
const SIDE_NOTE_TYPE = "aside";
const REBUILT_NOTICE_AFTER = 3;

/** Pi's Markdown component with Pi's Markdown theme; the last few renders are kept (the spinner redraws often). */
function markdownRenderer(theme: Any): MarkdownRenderer {
	const cache = new Map<string, string[]>();
	return (text, width, style) => {
		const key = `${style ?? ""}|${width}|${text}`;
		const hit = cache.get(key);
		if (hit) return hit;
		let lines: string[];
		try {
			const textStyle = style === "thinking" ? { color: (s: string) => theme.fg("dim", s), italic: true } : undefined;
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
	const observer = new Observer();
	let ctxRef: ExtensionContext | undefined;
	let thread: AsideThread | undefined;
	let panel: PanelState = { turns: [], collapsed: false };
	let tuiRef: Any;
	let panelShown = false;
	let belowShown = false;
	let handoff: { text: string; note: string } | undefined;
	let acceptedHandoff: { text: string; note: string } | undefined;
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
		thread?.abort();
		thread = undefined;
		panel = { turns: [], collapsed: false, expanded: panel.expanded };
		handoff = undefined;
		acceptedHandoff = undefined;
		rebuiltInARow = 0;
		observer.reset();
		background.reset();
		if (ctx) ctxRef = ctx;
		showPanel(false);
		refreshBelow();
	}

	function beforeLeaving(): void {
		const dropped = usage.flushOrDrop();
		thread?.abort();
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
	});
	pi.on("session_compact", (_event, ctx) => {
		ctxRef = ctx;
		observer.reset();
	});
	pi.on("session_tree", (_event, ctx) => {
		ctxRef = ctx;
		observer.reset();
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
		if (event.images && event.images.length > 0) return collapseAndContinue(event.text);
		const key = event.streamingBehavior === "followUp" ? "followUp" : "submit";
		if (routeEnter({ text: event.text, busy: busy(), key }) === "side") {
			void startAside(event.text, { routeCheck: true });
			return { action: "handled" };
		}
		return collapseAndContinue(event.text);
	});

	/** The user is sending something to the agent: collapse the panel and attach an accepted handoff's side note. */
	function collapseAndContinue(text: string): { action: "continue" } {
		// An answer still streaming stays visible: the user is waiting for it.
		if (panel.turns.length > 0 && !panel.collapsed && !thread?.busy) {
			panel.collapsed = true;
			renderNow();
		}
		if (acceptedHandoff && text.trim().length > 0) {
			const note = acceptedHandoff.note;
			acceptedHandoff = undefined;
			try {
				pi.sendMessage(
					{ customType: SIDE_NOTE_TYPE, content: note, display: true },
					{ deliverAs: running() ? "steer" : "nextTurn" },
				);
			} catch {
				// the handoff text still reaches the agent
			}
		}
		handoff = undefined;
		refreshBelow();
		return { action: "continue" };
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
			onUpdate: () => renderNow(),
		};
	}

	async function startAside(question: string, options: { routeCheck: boolean }): Promise<TurnView | undefined> {
		const ctx = ctxRef;
		if (!ctx) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const continuing = thread && !panel.collapsed && !panel.sentToAgent && thread.valid(observer, sessionId);
		if (!continuing) {
			thread?.abort();
			thread = new AsideThread(threadHost());
			panel = { turns: thread.turns, collapsed: false, expanded: panel.expanded };
		} else if (thread!.busy) {
			thread!.abort();
		}
		const current = thread!;
		handoff = undefined;
		acceptedHandoff = undefined;
		panel.collapsed = false;
		panel.hidden = false;
		panel.sentToAgent = undefined;
		showPanel(true);
		refreshBelow();
		const wasWaiting = waiting();
		let routedToAgent = false;
		const turn = await current.ask(question, {
			routeCheck: options.routeCheck,
			onRoute: (route) => {
				if (route !== "agent" || !options.routeCheck) return;
				routedToAgent = true;
				current.abort();
				panel.sentToAgent = { text: question, waiting: wasWaiting };
				sendToAgent(question);
				renderNow();
			},
		});
		if (current !== thread) return turn;
		const parsed = parseReply(turn.raw, true);
		if (options.routeCheck && !routedToAgent && !turn.aborted && turn.error && !parseReply(turn.raw, false).route) {
			// The aside failed before its route line: the text keeps Pi's meaning.
			panel.sentToAgent = { text: question, waiting: wasWaiting };
			sendToAgent(question);
		} else if (!routedToAgent && parsed.handoff && !turn.error && !turn.aborted) {
			handoff = { text: parsed.handoff, note: sideNote(turn, parsed.body) };
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

	function sideNote(turn: TurnView, answer: string): string {
		return `Side note the user brought back from an aside (a side conversation you did not see):\n\nQ: ${turn.question}\nA: ${answer}`;
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

	/** Detail line: tier, cache read against the cacheable prefix, cost. In the status bar only in RPC mode. */
	function detail(turn: TurnView): string {
		const fmt = (n: number) => n.toLocaleString("en-US");
		const parts: string[] = [];
		if (turn.tier === "exact") {
			parts.push("exact");
			parts.push(
				turn.predicted !== undefined
					? `read ${fmt(turn.read)} of ${fmt(turn.predicted)} cacheable${turn.written ? `, wrote ${fmt(turn.written)}` : ""}`
					: `read ${fmt(turn.read)}, wrote ${fmt(turn.written)}`,
			);
		} else if (turn.tier === "rebuilt") {
			parts.push(`rebuilt: not expected to hit${turn.reason ? ` (${turn.reason})` : ""}`);
			parts.push(`read ${fmt(turn.read)}, wrote ${fmt(turn.written)}`);
		}
		if (turn.effort) parts.push(`thinking ${turn.effort}`);
		parts.push(`$${turn.cost.toFixed(turn.cost < MONEY_THRESHOLD ? 3 : 2)}`);
		return parts.join(" · ");
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
		description: "Ask a side question about the session without touching it; with no question, reread the latest aside",
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
			if (turn.aborted) answer += `${answer ? "\n\n" : ""}(stopped)`;
			if (parsed.handoff) answer += `\n\nhandoff: ${parsed.handoff}`;
			const hash = thread?.fork?.pHash ? ` · p ${thread.fork.pHash.slice(0, 12)}` : "";
			return { question: turn.question, answer, detail: `${detail(turn)}${hash}` };
		});
	}

	async function openReader(ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom<void>(
			(tui: Any, theme: Any, _keybindings: Any, done: (result: void) => void) =>
				new Reader(
					readerTurns,
					theme,
					() => done(undefined),
					() => tui.requestRender(),
					() => tui.terminal?.rows ?? process.stdout.rows ?? 40,
					markdownRenderer(theme),
				),
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } as Any },
		);
	}

	// ---------------------------------------------------------------- TUI (ux §3.2, §3.3)

	function renderNow(): void {
		if (ctxRef?.mode !== "tui") return;
		showPanel(panel.turns.length > 0 && !panel.hidden);
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
		return !!turn && !turn.done && !panel.hidden && !panel.sentToAgent;
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

	/** ctrl+o (`app.tools.expand`): a collapsed panel opens again, expanded; otherwise expanded and compact toggle. */
	function toggleMore(): void {
		if (panel.collapsed && !panel.hidden && panel.turns.length > 0) {
			panel.collapsed = false;
			panel.expanded = true;
		} else {
			panel.expanded = !panel.expanded;
		}
		renderNow();
	}

	/**
	 * Enter on an empty editor puts the panel away (docs/ux.md §3.2): the frame collapses to one dim line, and the
	 * next such Enter clears that line. The thread stays readable with `/aside`.
	 */
	function putAway(): boolean {
		if (panel.turns.length === 0 || panel.hidden) return false;
		if (panel.collapsed) panel.hidden = true;
		else panel.collapsed = true;
		handoff = undefined;
		renderNow();
		refreshBelow();
		return true;
	}

	function showPanel(show: boolean): void {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		if (show === panelShown) return;
		panelShown = show;
		try {
			if (!show) {
				ctx.ui.setWidget(PANEL_WIDGET, undefined);
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
							panel.maxLines = Math.max(PANEL_LINES, rows - 14);
							try {
								panel.moreKey = keyText("app.tools.expand") || undefined;
							} catch {
								panel.moreKey = undefined;
							}
							return renderPanel(panel, width, theme, md, Date.now());
						},
						invalidate() {},
					};
				},
				{ placement: "aboveEditor" },
			);
		} catch {
			panelShown = false;
		}
	}

	function belowState(): { hint: boolean; ghost: string | undefined } {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return { hint: false, ghost: undefined };
		let text = "";
		try {
			text = ctx.ui.getEditorText();
		} catch {
			text = "";
		}
		const hint = routeEnter({ text, busy: busy(), key: "submit" }) === "side" && endsWithQuestionMark(text);
		const ghost = handoff && text.trim() === "" ? handoff.text : undefined;
		return { hint, ghost };
	}

	let belowCache = { hint: false, ghost: undefined as string | undefined };

	function refreshBelow(): void {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		const state = belowState();
		belowCache = state;
		panel.editorEmpty = editorText().trim() === "";
		const show = state.hint || state.ghost !== undefined;
		try {
			if (show !== belowShown) {
				belowShown = show;
				if (!show) ctx.ui.setWidget(BELOW_WIDGET, undefined);
				else
					ctx.ui.setWidget(
						BELOW_WIDGET,
						(tui: Any, theme: Any) => {
							tuiRef = tui;
							return { render: (width: number) => renderBelow(belowCache, width, theme), invalidate() {} };
						},
						{ placement: "belowEditor" },
					);
			}
			tuiRef?.requestRender();
		} catch {
			belowShown = false;
		}
	}

	function editorText(): string {
		try {
			return ctxRef?.ui.getEditorText() ?? "";
		} catch {
			return "";
		}
	}

	/** Whether Pi's input editor has the focus (not a selector, a dialog or another extension's overlay). */
	function editorFocused(): boolean {
		const focus = tuiRef?.getFocusedComponent;
		if (typeof focus !== "function") return true;
		const focused = focus.call(tuiRef);
		return !!focused && typeof focused === "object" && focused.actionHandlers instanceof Map;
	}

	function installTui(ctx: ExtensionContext): void {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		panelShown = false;
		belowShown = false;
		if (ctx.mode !== "tui") return;
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.input.submit") && editorText().trim() === "" && editorFocused() && putAway()) {
				return { consume: true };
			}
			// Pi's "more" (ctrl+o) expands the aside with everything else; Pi still toggles its tool output.
			if (kb.matches(data, "app.tools.expand") && editorFocused()) toggleMore();
			if (handoff && kb.matches(data, "tui.input.tab")) {
				let text = "";
				try {
					text = ctxRef?.ui.getEditorText() ?? "";
				} catch {
					text = "";
				}
				if (text.trim() === "") {
					ctxRef?.ui.setEditorText(handoff.text);
					acceptedHandoff = handoff;
					handoff = undefined;
					setTimeout(refreshBelow, 0);
					return { consume: true };
				}
			}
			// The editor applies the key after this listener: look at its text afterwards.
			setTimeout(refreshBelow, 0);
			return undefined;
		});
	}
}

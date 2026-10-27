// What the user sees (docs/ux.md §3.2–§3.5): the answer panel above the editor, the hint and the next-step placeholder
// text below it, and the `/aside` reader overlay. None of them takes the keyboard focus except the reader, which is
// an explicit modal. The panel works like a small window on top of the conversation: Esc or its "✕" closes it, and
// the wheel (a swipe on a touch screen) over it scrolls it.

import {
	decodeKittyPrintable,
	getKeybindings,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { parseReply } from "./reply.ts";
import type { TurnView } from "./thread.ts";

// biome-ignore lint: Pi's theme is used structurally.
type Theme = any;

/** Lines the panel takes, frame included, when the terminal height is unknown. */
export const PANEL_LINES = 12;
/** The panel never gets fewer lines than this, frame included. */
export const MIN_PANEL_LINES = 6;
/** Lines kept for Pi's editor, the hint below it and the footer when the agent is not running. */
export const EDITOR_ROOM = 10;
/** Lines of the model's thinking shown while no answer text has arrived. */
export const THINKING_LINES = 3;
export const MONEY_THRESHOLD = 0.25;
export const HINT = "↵ asks on the side · corrections still reach the agent";
/** The hint while the panel is open: the next question continues its thread (docs/ux.md §3.2). */
export const FOLLOW_HINT = "↵ follows up on the side · corrections still reach the agent";
/** While a `?` message the rule took aside is answered, with an empty editor: how to send it to the agent instead. */
export const UNDO_HINT = "↑↵ sends it to the agent instead";
/** The editor holds that message again (recalled with ↑ or typed again): Enter sends it to the agent (docs/ux.md §3.4). */
export const BACK_HINT = "↵ sends to the agent · it was asked on the side";
/** Below the editor after a stop while the agent runs: Esc is still the aside's, and how to reach the agent. */
export const AGENT_NOTE = "the agent is still running \u00b7 esc closes the aside, then esc stops the agent";
/** The close mark on the panel's top edge, where a click or a tap closes it (shown where Pi reports the mouse). */
export const CLOSE_MARK = "✕";
/** Beside the close mark: a click or a tap sends the question to the agent instead (where Pi reports the mouse). */
export const FORWARD_MARK = "↪";

/** Pi's own loader frames. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPIN_MS = 80;

export function spinnerFrame(now: number): string {
	return SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]!;
}

export interface PanelState {
	turns: TurnView[];
	/** Closed: not shown at all (`/aside` still rereads the thread). */
	hidden?: boolean;
	/** Lines the whole panel may take, frame included (`panelRoom`). */
	maxLines?: number;
	/** Pi's "more" key (`app.tools.expand`, ctrl+o) as Pi shows it; the panel claims it only where it prints it. */
	moreKey?: string;
	/** Whether Pi reports the mouse (fullscreen mode): the panel then shows its close mark. */
	mouse?: boolean;
	/**
	 * The first line of a long answer in view, where the user scrolled it. Undefined follows the answer: its end
	 * while it streams, its start once it is done.
	 */
	scrollTop?: number;
	/** Set when the text went to the agent: by the route check, or by the user ("↑ ↵", the forward mark). */
	sentToAgent?: { text: string; waiting: boolean; byUser?: boolean };
	/** The latest question can still go to the agent instead: the title shows the forward mark where Pi reports the mouse. */
	forwardable?: boolean;
	/** What continues a stopped aside, for the bottom edge: `?` while the agent is busy, `/aside` otherwise. */
	continueKey?: string;
}

/** Markdown to terminal lines; `thinking` text is rendered dim and italic. */
export type MarkdownRenderer = (text: string, width: number, style?: "thinking") => string[];

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "") out.push("");
		else out.push(...wrapTextWithAnsi(line, Math.max(10, width)));
	}
	return out;
}

/** Plain wrapping, for tests and when Pi's Markdown component is unavailable. */
export const plainText: MarkdownRenderer = (text, width) => wrap(text, width);

function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

/** The dim money line of docs/ux.md §3.5, or undefined on the normal (cheap) path. */
export function moneyLine(turn: TurnView): string | undefined {
	if (turn.cost < MONEY_THRESHOLD) return undefined;
	if (turn.tier === "rebuilt") return `rebuilt context · ${formatCost(turn.cost)}${turn.reason ? ` · ${turn.reason}` : ""}`;
	// Judged on the first request: later tool rounds always write their own new tail.
	const first = turn.first ?? { read: turn.read, written: turn.written };
	if (first.written > first.read) return `main cache had expired · ${formatCost(turn.cost)}`;
	return undefined;
}

/**
 * The reader's detail line: the tier, the first request's cache counts (whether the main session's cache was read),
 * the totals when tool rounds made more requests (those mostly read the aside's own cache), and the cost.
 */
export function detailLine(turn: TurnView, threshold = MONEY_THRESHOLD): string {
	const fmt = (n: number) => n.toLocaleString("en-US");
	const first = turn.first ?? { read: turn.read, written: turn.written };
	const parts: string[] = [];
	if (turn.tier === "exact") {
		parts.push("exact");
		parts.push(
			turn.predicted !== undefined
				? `read ${fmt(first.read)} of ${fmt(turn.predicted)} cacheable${first.written ? `, wrote ${fmt(first.written)}` : ""}`
				: `read ${fmt(first.read)}, wrote ${fmt(first.written)}`,
		);
	} else if (turn.tier === "rebuilt") {
		parts.push(`rebuilt${turn.reason ? ` (${turn.reason})` : ""}`);
		parts.push(`read ${fmt(first.read)}, wrote ${fmt(first.written)}`);
	}
	if ((turn.requests ?? 0) > 1) parts.push(`${turn.requests} requests: read ${fmt(turn.read)}, wrote ${fmt(turn.written)}`);
	if (turn.effort) parts.push(`thinking ${turn.effort}`);
	// A model without prices in models.json reports $0 for any number of tokens.
	if (turn.cost === 0 && (turn.read > 0 || turn.written > 0)) parts.push("no prices set for this model");
	else parts.push(`$${turn.cost.toFixed(turn.cost < threshold ? 3 : 2)}`);
	return parts.join(" · ");
}

/** Whole seconds, from the first one on. */
function seconds(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s >= 1 ? `${s}s` : "";
}

/** `left`, and `right` flush with the right edge. Where both do not fit, `left` is cut, but not below 16 columns. */
export function spread(left: string, right: string, width: number): string {
	const r = visibleWidth(right);
	if (r === 0 || width - r - 2 < Math.min(visibleWidth(left), 16)) return truncateToWidth(left, width, "\u2026");
	const l = truncateToWidth(left, width - r - 2, "\u2026");
	return `${l}${" ".repeat(Math.max(2, width - visibleWidth(l) - r))}${right}`;
}

/** The end of a long thinking text, cut at a paragraph or line start so that its Markdown stays whole. */
function thinkingTail(text: string): string {
	const trimmed = text.trimEnd();
	if (trimmed.length <= 600) return trimmed;
	const tail = trimmed.slice(-600);
	const cut = tail.indexOf("\n");
	return cut >= 0 && cut < tail.length - 1 ? tail.slice(cut + 1) : tail;
}

/**
 * The live line of an answer in progress: a spinner, what is happening and for how long, and while the model thinks,
 * the last lines of its thinking. Shown until the answer's first words, and during a tool call.
 */
export function progressLines(turn: TurnView, width: number, theme: Theme, md: MarkdownRenderer, now: number): string[] {
	const spin = theme.fg("accent", spinnerFrame(now));
	const dim = (s: string) => theme.fg("dim", s);
	// The live step reads in the text color, with its own time on the right.
	if (turn.activity) return [spread(`${spin} ${theme.fg("text", turn.activity)}`, dim(seconds(now - (turn.activitySince ?? turn.startedAt))), width)];
	const time = dim(seconds(now - turn.startedAt));
	if (turn.thinking?.trim()) {
		const tail = md(thinkingTail(turn.thinking), Math.max(10, width - 2), "thinking").filter((line) => line.trim() !== "");
		return [spread(`${spin} ${dim("thinking")}`, time, width), ...tail.slice(-THINKING_LINES).map((line) => `  ${line}`)];
	}
	return [spread(`${spin} ${dim("working")}`, time, width)];
}

/** Where a stopped turn was: what it was doing, in warning, and for how long it had run. */
export function stoppedLine(stopped: NonNullable<TurnView["stopped"]>, width: number, theme: Theme): string {
	const time = seconds(stopped.ms);
	return spread(`${theme.fg("warning", "\u25a0")} ${theme.fg("dim", stopped.label)}`, theme.fg("warning", `stopped${time ? ` \u00b7 ${time}` : ""}`), width);
}

/** What the aside did (its finished bash, edit and write calls), one line each: a green ✓, or the whole line red. */
export function stepLines(turn: TurnView, width: number, theme: Theme): string[] {
	return (turn.steps ?? []).map((step) =>
		truncateToWidth(step.ok ? `${theme.fg("success", "✓")} ${theme.fg("dim", step.label)}` : theme.fg("error", `✗ ${step.label}`), width, "…"),
	);
}

/**
 * Lines the panel may take, frame included. While the agent runs, half the screen, so that its work stays in view;
 * otherwise everything above Pi's editor and footer.
 */
export function panelRoom(rows: number, agentRunning: boolean): number {
	return Math.max(MIN_PANEL_LINES, agentRunning ? Math.floor(rows / 2) : rows - EDITOR_ROOM);
}

/** What Pi's "more" key does while the panel shows it: open the reader. */
export type MoreAction = "reader";

export interface PanelView {
	lines: string[];
	/** Set only when the panel prints the key: elsewhere it keeps Pi's meaning. */
	more?: MoreAction;
	/** Lines (indexes into `lines`) that open the reader when clicked or tapped: the "more lines" counts. */
	readerRows?: number[];
	readerZones?: Array<{ row: number; from: number; to: number }>;
	/** The long answer's scroll position and its largest value; undefined when it fits. */
	scroll?: { top: number; max: number };
	/** The title shows the forward mark, where a click or a tap sends the question to the agent instead. */
	forward?: boolean;
}

function moreLabel(state: PanelState): string {
	return state.moreKey ? ` · ${state.moreKey}` : " · /aside";
}

function count(n: number): string {
	return `${n} more ${n === 1 ? "line" : "lines"}`;
}

/**
 * Body lines of the open panel (without the frame). The panel grows with its answer up to `maxLines`. A longer
 * answer scrolls: by default it shows its end while it streams and its start once it is done, with a line counting
 * what is above or below.
 */
export function panelBodyView(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): PanelView {
	const turn = state.turns.at(-1);
	if (!turn) return { lines: [] };
	const dim = (s: string) => theme.fg("dim", s);
	const sent = state.sentToAgent;
	// The route check sends before any answer; what the aside said before the user sent it on stays (no text is lost).
	if (sent && !sent.byUser) return { lines: [dim(`↪ sent to the agent · it reads as ${sent.waiting ? "a request" : "a correction"}`)] };
	const head: string[] = [];
	const previous = state.turns.at(-2);
	if (previous) head.push(truncateToWidth(dim(`after: ${previous.question.replace(/\s+/g, " ")}`), width, "…"));
	const tail: string[] = [];
	const parsed = parseReply(turn.raw, turn.done);
	const relays = (turn.relays ?? []).flatMap(relay => [
		theme.fg("accent", "→ to the agent"),
		...plainText(relay.message, Math.max(1, width - 2)).map(line => `${theme.fg("accent", "┃")} ${line}`),
		dim(relay.read ? "It has read this." : "It will see this after its current step."),
	]);
	const forwarded = turn.forwarded === undefined ? [] : [
		theme.fg("accent", "↪ sent to the agent"),
		...plainText(turn.forwarded, Math.max(1, width - 2)).map(line => `${theme.fg("accent", "┃")} ${line}`),
	];
	const body = [...stepLines(turn, width, theme), ...relays, ...forwarded, ...(parsed.body ? md(parsed.body, width) : [])];
	if (sent) {
		tail.push(dim("↪ sent to the agent"));
	} else if (turn.stopped) {
		// At once, even while a stopped tool still has a moment to return what it printed.
		tail.push(stoppedLine(turn.stopped, width, theme));
		if (turn.error) tail.push(theme.fg("error", truncateToWidth(`aside failed: ${turn.error.replace(/\s+/g, " ").trim()}`, width, "…")));
	} else if (!turn.done) {
		if (turn.activity || !parsed.body) tail.push(...progressLines(turn, width, theme, md, now));
	} else {
		if (turn.aborted) tail.push(dim("stopped"));
		if (turn.error) tail.push(theme.fg("error", truncateToWidth(`aside failed: ${turn.error.replace(/\s+/g, " ").trim()}`, width, "…")));
	}

	const room = Math.max(2, (state.maxLines ?? PANEL_LINES) - 2 - head.length - tail.length);
	if (body.length <= room) return { lines: [...head, ...body, ...tail] };
	// Scrolled to the end, the view has the "above" line and room - 1 lines of the answer.
	const max = body.length - (room - 1);
	const auto = turn.done ? 0 : max;
	const top = Math.min(max, Math.max(0, state.scrollTop ?? auto));
	let shown = room - (top > 0 ? 1 : 0);
	const below = top + shown < body.length;
	if (below) shown -= 1;
	const lines = [...head];
	const readerRows: number[] = [];
	const key = moreLabel(state);
	if (top > 0) {
		readerRows.push(lines.length);
		lines.push(dim(`↑ ${count(top)}${below ? "" : key}`));
	}
	lines.push(...body.slice(top, top + shown));
	if (below) {
		readerRows.push(lines.length);
		lines.push(dim(`↓ ${count(body.length - top - shown)}${key}`));
	}
	lines.push(...tail);
	const more: MoreAction | undefined = state.moreKey ? "reader" : undefined;
	return { lines, more, readerRows, scroll: { top, max } };
}

/** Body lines of the panel for its current state (without the frame). */
export function panelBody(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): string[] {
	return panelBodyView(state, width, theme, md, now).lines;
}

/**
 * The framed panel: a rounded box with the latest question as its title, a spinner before it while the answer
 * streams, and the close mark on the top edge where Pi reports the mouse. Nothing when closed.
 */
export function renderPanel(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): string[] {
	return panelView(state, width, theme, md, now).lines;
}

/** Columns of the top edge where a click or a tap closes the panel: the close mark and a cell around it. */
export function closeZone(width: number): [number, number] {
	return [width - 5, width - 1];
}

/** Columns of the top edge where a click or a tap sends the question to the agent: the forward mark and a cell around it. */
export function forwardZone(width: number): [number, number] {
	return [width - 10, width - 8];
}

/** `renderPanel`, and what the keys and the mouse do while these lines are on screen. */
export function panelView(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): PanelView {
	const turn = state.turns.at(-1);
	if (!turn || state.hidden) return { lines: [] };
	const question = turn.question.replace(/\s+/g, " ");
	const running = !turn.done && !turn.stopped && !state.sentToAgent;
	// The lit edge is what Esc acts on: it stops the aside while it runs, and closes the panel once it settles.
	const tone = running ? "borderAccent" : "borderMuted";
	const border = (s: string) => theme.fg(tone, s);
	const inner = Math.max(10, width - 4);
	// The spinner sits in the title while the answer streams, and on the progress line before it (never both).
	const progress = !!turn.activity || parseReply(turn.raw, turn.done).body === "";
	const spin = running && !progress ? `${spinnerFrame(now)} ` : "";
	// The close mark sits at column width - 4: "╭─" title fill " ✕ " "─╮". The forward mark, at width - 9, keeps two
	// cells of edge between them, so that a tap meant for one does not land on the other.
	const close = state.mouse && width >= 20 ? ` ${CLOSE_MARK} ` : "";
	const forward = !!close && !!state.forwardable && !state.sentToAgent && width >= 30;
	const mark = forward ? ` ${FORWARD_MARK} ` : "";
	const gap = forward ? 2 : 0;
	const title = truncateToWidth(` ${spin}${question} `, Math.max(4, width - 6 - visibleWidth(close) - visibleWidth(mark) - gap), "…");
	const fill = Math.max(0, width - 3 - visibleWidth(title) - (close ? visibleWidth(close) + 1 : 0) - visibleWidth(mark) - gap);
	const top = border("╭─") + theme.fg("muted", title) + border("─".repeat(fill)) + (mark ? theme.fg("accent", mark) + border("─".repeat(gap)) : "") + (close ? theme.fg("dim", close) + border("─") : "") + border("╮");
	const out = [truncateToWidth(top, width)];
	const body = panelBodyView(state, inner, theme, md, now);
	for (const line of body.lines) {
		const text = truncateToWidth(line.replace(/\s+$/u, ""), inner);
		out.push(`${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${border("│")}`);
	}
	out.push(bottomEdge(running ? [["esc", "stop"]] : turn.stopped && !state.sentToAgent ? [[state.continueKey ?? "?", "continue"], ["esc", "close"]] : [["esc", "close"]], width, theme, border));
	return { lines: out, more: body.more, readerRows: body.readerRows?.map((row) => row + 1), readerZones: body.readerRows?.map(row => ({ row: row + 1, from: 2, to: Math.min(width - 3, 1 + visibleWidth(body.lines[row]!)) })), scroll: body.scroll, ...(forward ? { forward } : {}) };
}

/** The bottom edge, with what the keys do now: `╰─ esc stop ───╯`. A narrow panel keeps a plain edge. */
function bottomEdge(keys: Array<[string, string]>, width: number, theme: Theme, border: (s: string) => string): string {
	const text = keys.map(([key, what]) => `${theme.fg("dim", key)} ${theme.fg("muted", what)}`).join(theme.fg("dim", " \u00b7 "));
	const used = visibleWidth(text) + 5;
	if (keys.length === 0 || used + 2 > width) return border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	return `${border("╰─ ")}${text}${border(` ${"─".repeat(width - used)}╯`)}`;
}

/**
 * What Enter would do with the editor's text: nothing new, ask on the side, follow up on the open panel's thread, or
 * send the message the `?` rule took aside to the agent (`back`). `undo`: the editor is empty while that message is
 * answered, and ↑ ↵ would send it to the agent instead.
 */
export type HintKind = "ask" | "follow" | "back" | "undo" | undefined;

const HINTS: Record<Exclude<HintKind, undefined>, string> = { ask: HINT, follow: FOLLOW_HINT, back: BACK_HINT, undo: UNDO_HINT };

/** Below the editor: the hint before an Enter that asks on the side, or the next-step placeholder. */
export function renderBelow(input: { hint: HintKind | boolean; next: string | undefined; agent?: boolean }, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	if (input.next) lines.push(truncateToWidth(theme.fg("dim", `/aside ${input.next}`), width));
	if (input.hint) lines.push(truncateToWidth(theme.fg("dim", typeof input.hint === "string" ? HINTS[input.hint] : HINT), width));
	if (input.agent) lines.push(truncateToWidth(theme.fg("muted", AGENT_NOTE), width));
	return lines;
}

export interface ReaderTurn {
	question: string;
	answer: string;
	detail: string;
	/** What the aside did, one line each (`✓ $ du -sh ~`). */
	steps?: string[];
}

/** Text a key press would type, or undefined for keys, releases and control characters. */
export function typedText(data: string): string | undefined {
	if (isKeyRelease(data)) return undefined;
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.length === 0 || data.startsWith("\x1b")) return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
	return /[\x00-\x1f\x7f]/.test(data) ? undefined : data;
}

/**
 * The `/aside` reader: every question and answer of the latest thread, opened at the latest question. Esc, Enter
 * and Pi's "more" key close it; typing closes it too and the text goes on in the editor, so a follow-up never
 * needs a key first. The wheel (a swipe) scrolls it.
 */
export class Reader {
	private offset = 0;
	private lastHeight = 20;

	constructor(
		private readonly turns: () => ReaderTurn[],
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly rows: () => number,
		private readonly md: MarkdownRenderer = plainText,
		/** Typing in the reader: it has closed, and `text` belongs in the editor. */
		private readonly type?: (text: string) => void,
		/** Whether Pi reports the mouse for this reader. */
		private readonly mouse: () => boolean = () => false,
	) { }

	/** Where the latest question starts: the reader opens there, like a conversation opens at its end. */
	private latestStart = 0;
	private opened = false;

	private lines(width: number): string[] {
		const out: string[] = [];
		const inner = Math.max(10, width - 2);
		for (const turn of this.turns()) {
			this.latestStart = out.length;
			out.push(...wrap(this.theme.fg("accent", `? ${turn.question}`), inner));
			out.push("");
			for (const step of turn.steps ?? []) out.push(truncateToWidth(this.theme.fg("dim", step), inner, "…"));
			out.push(...this.md(turn.answer, inner).map((line) => line.replace(/\s+$/u, "")));
			out.push(...wrap(this.theme.fg("dim", turn.detail), inner));
			out.push("");
		}
		return out;
	}

	render(width: number): string[] {
		const height = Math.max(5, Math.floor(this.rows() * 0.8) - 2);
		this.lastHeight = height;
		const all = this.lines(width - 2);
		const max = Math.max(0, all.length - height);
		if (!this.opened) {
			this.opened = true;
			this.offset = this.latestStart;
		}
		if (this.offset > max) this.offset = max;
		const view = all.slice(this.offset, this.offset + height);
		const border = (s: string) => this.theme.fg("borderMuted", s);
		const title = " aside ";
		const close = this.mouse() && width >= 20 ? ` ${CLOSE_MARK} ─` : "";
		const out = [border("╭─") + this.theme.fg("muted", title) + border("─".repeat(Math.max(0, width - 3 - title.length - close.length))) + this.theme.fg("dim", close) + border("╮")];
		for (const line of view) {
			const text = truncateToWidth(line, width - 4);
			out.push(`${border("│")} ${text}${" ".repeat(Math.max(0, width - 4 - visibleWidth(text)))} ${border("│")}`);
		}
		const typing = this.type ? "· type to follow up " : "";
		const footer = truncateToWidth(
			` ↑↓ scroll · esc close ${typing}${all.length > height ? `· ${this.offset + 1}–${Math.min(all.length, this.offset + height)} of ${all.length} ` : ""}`,
			Math.max(4, width - 2),
		);
		out.push(border("╰") + this.theme.fg("dim", footer) + border(`${"─".repeat(Math.max(0, width - 2 - visibleWidth(footer)))}╯`));
		return out;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "return") || isMoreKey(data)) {
			this.done();
			return;
		}
		const page = Math.max(1, this.lastHeight - 2);
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset += 1;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, "pageDown")) this.offset += page;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
		else {
			const text = typedText(data);
			if (text !== undefined && this.type) {
				this.done();
				this.type(text);
				return;
			}
		}
		this.requestRender();
	}

	/** The wheel, or a swipe on a touch screen, scrolls the reader (Pi's fullscreen mode reports it). */
	handleMouse(event: { type: string; wheelDelta?: number; button?: string; width?: number; x?: number; y?: number }): { handled: true } | undefined {
		if (event.type === "wheel") {
			this.offset = Math.max(0, this.offset + (event.wheelDelta ?? 0));
			return { handled: true };
		}
		if (this.mouse() && event.width !== undefined && event.width >= 20 && event.y === 0 && event.button === "left") {
			const [from, to] = closeZone(event.width);
			if (event.x !== undefined && event.x >= from && event.x <= to && (event.type === "press" || event.type === "click")) {
				if (event.type === "click") this.done();
				return { handled: true };
			}
		}
		return undefined;
	}

	invalidate(): void { }
}

/** Pi's "more" key (`app.tools.expand`); false where Pi's keybindings are not loaded. */
function isMoreKey(data: string): boolean {
	try {
		return getKeybindings().matches(data, "app.tools.expand" as never);
	} catch {
		return false;
	}
}

/** Only the count's visible text opens the reader; close and forward win on both top rows. */
export function panelHit(view: PanelView, width: number, x: number, y: number, mouse: boolean): "close" | "forward" | "reader" | undefined {
	const [from, to] = closeZone(width);
	if (mouse && y >= 0 && y <= 1 && x >= from && x <= to) return "close";
	const [forwardFrom, forwardTo] = forwardZone(width);
	if (mouse && view.forward && y >= 0 && y <= 1 && x >= forwardFrom && x <= forwardTo) return "forward";
	if (view.readerZones?.some(zone => y === zone.row && x >= zone.from && x <= zone.to)) return "reader";
	return undefined;
}

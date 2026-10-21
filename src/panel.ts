// What the user sees (docs/ux.md §3.2–§3.5): the answer panel above the editor, the hint and the handoff ghost
// text below it, and the `/aside` reader overlay. None of them takes focus except the reader, which is an explicit
// modal closed with Esc.

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
/** On the open panel's lower edge while the editor is empty: Enter there folds it to one line. */
export const FOLD_HINT = "↵ folds";
/** On the folded line while the editor is empty: Enter there clears it. */
export const CLEAR_HINT = "↵ clears";

/** Pi's own loader frames. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPIN_MS = 80;

export function spinnerFrame(now: number): string {
	return SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]!;
}

export interface PanelState {
	turns: TurnView[];
	/** One dim line instead of the frame. */
	collapsed: boolean;
	/** Not shown at all (`/aside` still rereads the thread). */
	hidden?: boolean;
	/** Whether the editor is empty and has the focus: Enter then folds or clears the panel, and the panel says so. */
	editorEmpty?: boolean;
	/** Lines the whole panel may take, frame included (`panelRoom`). */
	maxLines?: number;
	/** Pi's "more" key (`app.tools.expand`, ctrl+o) as Pi shows it; the panel claims it only where it prints it. */
	moreKey?: string;
	/** Set when the route check sent the text to the agent. */
	sentToAgent?: { text: string; waiting: boolean };
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
	if (turn.written > 0) return `main cache had expired · ${formatCost(turn.cost)}`;
	return undefined;
}

function elapsed(turn: TurnView, now: number): string {
	const seconds = Math.floor((now - turn.startedAt) / 1000);
	return seconds >= 1 ? ` · ${seconds}s` : "";
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
	if (turn.activity) return [`${spin} ${dim(`${turn.activity}${elapsed(turn, now)}`)}`];
	if (turn.thinking?.trim()) {
		const tail = md(thinkingTail(turn.thinking), Math.max(10, width - 2), "thinking").filter((line) => line.trim() !== "");
		return [`${spin} ${dim(`thinking${elapsed(turn, now)}`)}`, ...tail.slice(-THINKING_LINES).map((line) => `  ${line}`)];
	}
	return [`${spin} ${dim(`working${elapsed(turn, now)}`)}`];
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
}

function moreLabel(state: PanelState): string {
	return state.moreKey ? ` · ${state.moreKey}` : " · /aside";
}

/**
 * Body lines of the open panel (without the frame). The panel grows with its answer up to `maxLines`; a longer
 * answer shows its end while it streams and its start once it is done, with one line counting the rest.
 */
export function panelBodyView(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): PanelView {
	const turn = state.turns.at(-1);
	if (!turn) return { lines: [] };
	const dim = (s: string) => theme.fg("dim", s);
	if (state.sentToAgent) {
		return { lines: [dim(`↪ sent to the agent · it reads as ${state.sentToAgent.waiting ? "a request" : "a correction"}`)] };
	}
	const head: string[] = [];
	const previous = state.turns.at(-2);
	if (previous) head.push(truncateToWidth(dim(`after: ${previous.question.replace(/\s+/g, " ")}`), width, "…"));
	const tail: string[] = [];
	const parsed = parseReply(turn.raw, turn.done);
	const body = parsed.body ? md(parsed.body, width) : [];
	if (!turn.done) {
		if (turn.activity || body.length === 0) tail.push(...progressLines(turn, width, theme, md, now));
	} else {
		if (turn.aborted) tail.push(dim("stopped"));
		if (turn.error) tail.push(theme.fg("error", `aside failed: ${turn.error}`));
	}
	const money = moneyLine(turn);
	if (money) tail.push(dim(money));
	const room = Math.max(2, (state.maxLines ?? PANEL_LINES) - 2 - head.length - tail.length);
	if (body.length <= room) return { lines: [...head, ...body, ...tail] };
	const shown = room - 1;
	const rest = body.length - shown;
	const count = `${rest} more ${rest === 1 ? "line" : "lines"}${moreLabel(state)}`;
	const more: MoreAction | undefined = state.moreKey ? "reader" : undefined;
	if (!turn.done) return { lines: [...head, dim(`↑ ${count}`), ...body.slice(-shown), ...tail], more };
	return { lines: [...head, ...body.slice(0, shown), dim(`↓ ${count}`), ...tail], more };
}

/** Body lines of the panel for its current state (without the frame). */
export function panelBody(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): string[] {
	return panelBodyView(state, width, theme, md, now).lines;
}

/**
 * The framed panel (rounded box with the latest question as its title, a spinner before it while the answer streams,
 * and `↵ folds` on the lower edge while the editor is empty), one dim line when folded, nothing when cleared.
 */
export function renderPanel(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): string[] {
	return panelView(state, width, theme, md, now).lines;
}

/** `renderPanel`, and what Pi's "more" key does while these lines are on screen. */
export function panelView(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): PanelView {
	const turn = state.turns.at(-1);
	if (!turn || state.hidden) return { lines: [] };
	const border = (s: string) => theme.fg("borderMuted", s);
	const question = turn.question.replace(/\s+/g, " ");
	const running = !turn.done && !state.sentToAgent;
	if (state.collapsed) {
		const mark = running ? theme.fg("accent", spinnerFrame(now)) : theme.fg("dim", "▸");
		// A folded panel is one the user is done with: it does not claim Pi's "more" key (their tool output).
		const keys = state.editorEmpty ? CLEAR_HINT : "";
		const left = `${mark} ${theme.fg("dim", question)}`;
		if (!keys || width < visibleWidth(keys) + 12) return { lines: [truncateToWidth(left, width)] };
		const fitted = truncateToWidth(left, width - visibleWidth(keys) - 3, "…");
		const gap = " ".repeat(Math.max(2, width - visibleWidth(fitted) - visibleWidth(keys)));
		return { lines: [`${fitted}${gap}${theme.fg("dim", keys)}`] };
	}
	const inner = Math.max(10, width - 4);
	// The spinner sits in the title while the answer streams, and on the progress line before it (never both).
	const progress = !!turn.activity || parseReply(turn.raw, turn.done).body === "";
	const spin = running && !progress ? `${spinnerFrame(now)} ` : "";
	const title = truncateToWidth(` ${spin}${question} `, Math.max(4, width - 6), "…");
	const top = border("╭─") + theme.fg("muted", title) + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`);
	const out = [truncateToWidth(top, width)];
	const body = panelBodyView(state, inner, theme, md, now);
	for (const line of body.lines) {
		const text = truncateToWidth(line.replace(/\s+$/u, ""), inner);
		out.push(`${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${border("│")}`);
	}
	const hint = state.editorEmpty ? ` ${FOLD_HINT} ` : "";
	if (hint && width >= visibleWidth(hint) + 6) {
		out.push(border(`╰${"─".repeat(Math.max(0, width - 3 - visibleWidth(hint)))}`) + theme.fg("dim", hint) + border("─╯"));
	} else {
		out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	}
	return { lines: out, more: body.more };
}

/** What Enter would do with the editor's text: nothing new, ask on the side, or follow up on the open panel's thread. */
export type HintKind = "ask" | "follow" | undefined;

/** Below the editor: the hint before an Enter that asks on the side, or the handoff ghost text. */
export function renderBelow(input: { hint: HintKind | boolean; ghost: string | undefined }, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	if (input.ghost) lines.push(truncateToWidth(theme.fg("dim", `⇥ ${input.ghost}  (tab accepts)`), width));
	if (input.hint) lines.push(truncateToWidth(theme.fg("dim", input.hint === "follow" ? FOLLOW_HINT : HINT), width));
	return lines;
}

export interface ReaderTurn {
	question: string;
	answer: string;
	detail: string;
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
 * needs a key first.
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
	) {}

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
		const out = [border("╭─") + this.theme.fg("muted", title) + border(`${"─".repeat(Math.max(0, width - 3 - title.length))}╮`)];
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

	invalidate(): void {}
}

/** Pi's "more" key (`app.tools.expand`); false where Pi's keybindings are not loaded. */
function isMoreKey(data: string): boolean {
	try {
		return getKeybindings().matches(data, "app.tools.expand" as never);
	} catch {
		return false;
	}
}

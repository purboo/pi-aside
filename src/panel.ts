// What the user sees (docs/ux.md §3.2–§3.5): the answer panel above the editor, the hint and the handoff ghost
// text below it, and the `/aside` reader overlay. None of them takes focus except the reader, which is an explicit
// modal closed with Esc.

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parseReply } from "./reply.ts";
import type { TurnView } from "./thread.ts";

// biome-ignore lint: Pi's theme is used structurally.
type Theme = any;

export const PANEL_LINES = 10;
/** Lines of the model's thinking shown while no answer text has arrived. */
export const THINKING_LINES = 3;
export const MONEY_THRESHOLD = 0.25;
export const HINT = "↵ asks on the side · corrections still reach the agent";
/** On the panel's lower edge while the editor is empty: Enter there puts the panel away (docs/ux.md §3.2). */
export const HIDE_HINT = "↵ hides";

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
	/** Whether the editor is empty: the lower edge then shows `HIDE_HINT`. */
	editorEmpty?: boolean;
	/** Pi's "more" toggle (`app.tools.expand`, ctrl+o) is on: the answer gets up to `maxLines` lines. */
	expanded?: boolean;
	/** Lines an expanded answer may take (from the terminal height). */
	maxLines?: number;
	/** The key that toggles "more", as Pi shows it (`ctrl+o`). */
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

/** Body lines of the panel for its current state (without the frame). */
export function panelBody(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): string[] {
	const turn = state.turns.at(-1);
	if (!turn) return [];
	const dim = (s: string) => theme.fg("dim", s);
	if (state.sentToAgent) {
		return [dim(`↪ sent to the agent · it reads as ${state.sentToAgent.waiting ? "a request" : "a correction"}`)];
	}
	const lines: string[] = [];
	const parsed = parseReply(turn.raw, turn.done);
	const body = parsed.body ? md(parsed.body, width) : [];
	const limit = state.expanded ? Math.max(PANEL_LINES, state.maxLines ?? PANEL_LINES) : PANEL_LINES;
	if (!turn.done) {
		lines.push(...body.slice(-limit));
		if (turn.activity || body.length === 0) lines.push(...progressLines(turn, width, theme, md, now));
	} else {
		if (body.length > limit) {
			lines.push(...body.slice(0, limit));
			const more = !state.expanded && state.moreKey ? `${state.moreKey} more` : "/aside to read all";
			lines.push(dim(`… ${more}`));
		} else {
			lines.push(...body);
		}
		if (turn.aborted) lines.push(dim("stopped"));
		if (turn.error) lines.push(theme.fg("error", `aside failed: ${turn.error}`));
	}
	const money = moneyLine(turn);
	if (money) lines.push(dim(money));
	return lines;
}

/**
 * The framed panel (rounded box with the question as its title, a spinner before it while the answer streams, and
 * `↵ hides` on the lower edge while the editor is empty), one dim line when collapsed, nothing when hidden.
 */
export function renderPanel(state: PanelState, width: number, theme: Theme, md: MarkdownRenderer = plainText, now = Date.now()): string[] {
	const turn = state.turns.at(-1);
	if (!turn || state.hidden) return [];
	const border = (s: string) => theme.fg("borderMuted", s);
	const question = turn.question.replace(/\s+/g, " ");
	const running = !turn.done && !state.sentToAgent;
	if (state.collapsed) {
		const mark = running ? theme.fg("accent", spinnerFrame(now)) : theme.fg("dim", "▸");
		return [truncateToWidth(`${mark} ${theme.fg("dim", question)}`, width)];
	}
	const inner = Math.max(10, width - 4);
	// The spinner sits in the title while the answer streams, and on the progress line before it (never both).
	const progress = !!turn.activity || parseReply(turn.raw, turn.done).body === "";
	const spin = running && !progress ? `${spinnerFrame(now)} ` : "";
	const title = truncateToWidth(` ${spin}${question} `, Math.max(4, width - 6), "…");
	const top = border("╭─") + theme.fg("muted", title) + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`);
	const out = [truncateToWidth(top, width)];
	for (const line of panelBody(state, inner, theme, md, now)) {
		const text = truncateToWidth(line.replace(/\s+$/u, ""), inner);
		out.push(`${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${border("│")}`);
	}
	const hint = state.editorEmpty ? ` ${HIDE_HINT} ` : "";
	if (hint && width >= visibleWidth(hint) + 6) {
		out.push(border(`╰${"─".repeat(Math.max(0, width - 3 - visibleWidth(hint)))}`) + theme.fg("dim", hint) + border("─╯"));
	} else {
		out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	}
	return out;
}

/** Below the editor: the hint before an Enter that asks on the side, or the handoff ghost text. */
export function renderBelow(input: { hint: boolean; ghost: string | undefined }, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	if (input.ghost) lines.push(truncateToWidth(theme.fg("dim", `⇥ ${input.ghost}  (tab accepts)`), width));
	if (input.hint) lines.push(truncateToWidth(theme.fg("dim", HINT), width));
	return lines;
}

export interface ReaderTurn {
	question: string;
	answer: string;
	detail: string;
}

/** The `/aside` reader: every question and answer of the latest thread, opened at the latest question; Esc closes. */
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
		const footer = ` ↑↓ scroll · esc close ${all.length > height ? `· ${this.offset + 1}–${Math.min(all.length, this.offset + height)} of ${all.length} ` : ""}`;
		out.push(border("╰") + this.theme.fg("dim", footer) + border(`${"─".repeat(Math.max(0, width - 2 - visibleWidth(footer)))}╯`));
		return out;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		const page = Math.max(1, this.lastHeight - 2);
		if (matchesKey(data, "up") || data === "k") this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down") || data === "j") this.offset += 1;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, "pageDown") || data === " ") this.offset += page;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
		this.requestRender();
	}

	invalidate(): void {}
}

// What the user sees (docs/ux.md §3.2–§3.5): the answer panel above the editor, the hint and the handoff ghost
// text below it, and the `/aside` reader overlay. None of them takes focus except the reader, which is an explicit
// modal closed with Esc.

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parseReply } from "./reply.ts";
import type { TurnView } from "./thread.ts";

// biome-ignore lint: Pi's theme is used structurally.
type Theme = any;

export const PANEL_LINES = 10;
export const MONEY_THRESHOLD = 0.25;
export const HINT = "↵ asks on the side · corrections still reach the agent";

export interface PanelState {
	turns: TurnView[];
	collapsed: boolean;
	/** Set when the route check sent the text to the agent. */
	sentToAgent?: { text: string; waiting: boolean };
}

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

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "") out.push("");
		else out.push(...wrapTextWithAnsi(line, Math.max(10, width)));
	}
	return out;
}

/** Body lines of the panel for its current state (without the frame). */
export function panelBody(state: PanelState, width: number, theme: Theme): string[] {
	const turn = state.turns.at(-1);
	if (!turn) return [];
	const dim = (s: string) => theme.fg("dim", s);
	if (state.sentToAgent) {
		return [dim(`↪ sent to the agent · it reads as ${state.sentToAgent.waiting ? "a request" : "a correction"}`)];
	}
	const lines: string[] = [];
	const parsed = parseReply(turn.raw, turn.done);
	const body = wrap(parsed.body, width);
	if (!turn.done) {
		lines.push(...body.slice(-PANEL_LINES));
		if (turn.activity) lines.push(dim(turn.activity));
		else if (body.length === 0) lines.push(dim("…"));
	} else {
		if (body.length > PANEL_LINES) {
			lines.push(...body.slice(0, PANEL_LINES));
			lines.push(dim("… /aside to read all"));
		} else {
			lines.push(...body);
		}
		if (turn.aborted) lines.push(dim("stopped"));
		if (turn.error) lines.push(theme.fg("error", `aside failed: ${turn.error}`));
		if (parsed.handoff) lines.push(dim(`⇥ ${parsed.handoff}`));
	}
	const money = moneyLine(turn);
	if (money) lines.push(dim(money));
	return lines;
}

/** The framed panel (rounded box with the question as title), or one dim line when collapsed. */
export function renderPanel(state: PanelState, width: number, theme: Theme): string[] {
	const turn = state.turns.at(-1);
	if (!turn) return [];
	const border = (s: string) => theme.fg("borderMuted", s);
	if (state.collapsed) return [truncateToWidth(theme.fg("dim", `▸ ${turn.question.replace(/\s+/g, " ")}`), width)];
	const inner = Math.max(10, width - 4);
	const title = truncateToWidth(` ${turn.question.replace(/\s+/g, " ")} `, Math.max(4, width - 6), "…");
	const top = border("╭─") + theme.fg("muted", title) + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`);
	const out = [truncateToWidth(top, width)];
	for (const line of panelBody(state, inner, theme)) {
		const text = truncateToWidth(line, inner);
		out.push(`${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${border("│")}`);
	}
	out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return out;
}

/** Below the editor: the hint before an Enter that asks on the side, or the handoff ghost text. */
export function renderBelow(input: { hint: boolean; ghost: string | undefined }, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	if (input.ghost) lines.push(truncateToWidth(theme.fg("dim", `⇥ ${input.ghost}`), width));
	if (input.hint) lines.push(truncateToWidth(theme.fg("dim", HINT), width));
	return lines;
}

export interface ReaderTurn {
	question: string;
	answer: string;
	detail: string;
}

/** The `/aside` reader: every question and answer of the latest thread, scrollable; Esc closes. */
export class Reader {
	private offset = 0;
	private lastHeight = 20;

	constructor(
		private readonly turns: () => ReaderTurn[],
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly rows: () => number,
	) {}

	private lines(width: number): string[] {
		const out: string[] = [];
		const inner = Math.max(10, width - 2);
		for (const turn of this.turns()) {
			out.push(...wrap(this.theme.fg("accent", `? ${turn.question}`), inner));
			out.push("");
			out.push(...wrap(turn.answer, inner));
			out.push(...wrap(this.theme.fg("dim", turn.detail), inner));
			out.push("");
		}
		return out;
	}

	render(width: number): string[] {
		const height = Math.max(5, Math.floor(this.rows() * 0.8) - 2);
		this.lastHeight = height;
		const all = this.lines(width);
		const max = Math.max(0, all.length - height);
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

// The question-mark rule (docs/ux.md §3.1): while the agent is busy, a message ending in a question mark is
// asked on the side. The ending is language-neutral and lives in the user's own text.

const QUESTION_MARKS = new Set(["?", "\uFF1F", "\u061F", "\u037E"]);

// Trailing whitespace, closing punctuation (Pe), final quotes (Pf) and ASCII quotes are skipped.
const TRAILING = /[\s\p{Pe}\p{Pf}"']+$/u;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** True when the end of `text` lies inside a fenced code block (CommonMark fence rules). */
export function endsInsideFence(text: string): boolean {
	let open: { char: string; length: number } | undefined;
	for (const line of text.split(/\r?\n/)) {
		const match = FENCE.exec(line);
		if (!match) continue;
		const marker = match[1]!;
		const rest = match[2]!;
		const char = marker[0]!;
		if (!open) {
			// A backtick fence's info string may not contain a backtick.
			if (char === "`" && rest.includes("`")) continue;
			open = { char, length: marker.length };
		} else if (char === open.char && marker.length >= open.length && rest.trim() === "") {
			open = undefined;
		}
	}
	return open !== undefined;
}

/** The question-mark ending of docs/ux.md §3.1 (U9). */
export function endsWithQuestionMark(text: string): boolean {
	if (endsInsideFence(text)) return false;
	const stripped = text.replace(TRAILING, "");
	if (stripped.length === 0) return false;
	const last = Array.from(stripped).at(-1)!;
	return QUESTION_MARKS.has(last);
}

/**
 * How long after its answer ends a message the rule took aside can still be sent to the agent instead (docs/ux.md
 * §3.4.1). A misroute shows when the panel opens or while the answer is read; a question asked again minutes later
 * is a new side question, not a correction.
 */
export const TAKE_BACK_MS = 120_000;

/** Whether the message of this turn can still go to the agent instead: while it is answered, and for TAKE_BACK_MS after. */
export function canTakeBack(turn: { done: boolean; endedAt?: number }, now: number): boolean {
	return !turn.done || turn.endedAt === undefined || now - turn.endedAt <= TAKE_BACK_MS;
}

export type EnterKey = "submit" | "followUp";

/** Where a submitted editor text goes: "side" asks on the side, "pi" keeps Pi's meaning. */
export function routeEnter(input: { text: string; busy: boolean; key: EnterKey }): "side" | "pi" {
	if (input.key !== "submit" || !input.busy) return "pi";
	const head = input.text.trimStart();
	if (head.startsWith("/") || head.startsWith("!")) return "pi";
	return endsWithQuestionMark(input.text) ? "side" : "pi";
}

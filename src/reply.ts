import { truncateToWidth } from "@earendil-works/pi-tui";

// Parsing of the aside model's reply (docs/ux.md §3.3, §3.4): a hidden first line `route: side|agent`, the
// visible body, and optional hidden last lines: `next: <what the user would say next>`, `tell: <message for the main
// agent>` and `move: <name> | <hint>`. Actions are text, not tools: declaring tools in the fork would change the
// request's tool list on providers without inline tool additions, and the main session's cache would not apply.

export type Route = "side" | "agent";

export interface ParsedReply {
	route: Route | undefined;
	body: string;
	next: string | undefined;
	/** A complete reply's `tell:` line: relay this to the main agent. */
	tell?: string;
	/** A complete reply's `move:` line: move this aside to its own window. */
	move?: { name?: string; hint?: string };
}

const ROUTE_LINE = /^route\s*:\s*(side|agent)$/i;
const ACTION_LINE = /^\s*[*`]*(next|tell|move)[*`]*\s*:(.*)$/i;
const ACTION_FORMS = ["next:", "tell:", "move:"];
const ROUTE_FORMS = ["route: side", "route: agent", "route : side", "route : agent", "route:side", "route:agent"];

function cleanLine(line: string): string {
	return line
		.trim()
		.replace(/^[*`]+|[*`]+$/g, "")
		.trim();
}

/** Whether an unterminated first line can still become a route line. */
function couldBecomeRoute(partial: string): boolean {
	const cleaned = cleanLine(partial).toLowerCase().replace(/\s+/g, " ");
	if (cleaned === "") return true;
	return ROUTE_FORMS.some((form) => form.startsWith(cleaned));
}

/** Whether the reply so far starts with a complete route line (the default `side` of `parseReply` does not count). */
export function hasRouteLine(raw: string): boolean {
	const text = raw.replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+/, "");
	const newline = text.indexOf("\n");
	return ROUTE_LINE.test(cleanLine(newline < 0 ? text : text.slice(0, newline)));
}

export function parseReply(raw: string, done: boolean): ParsedReply {
	const text = raw.replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+/, "");
	const newline = text.indexOf("\n");
	const first = newline < 0 ? text : text.slice(0, newline);
	let route: Route;
	let rest: string;
	if (newline < 0 && !done) {
		if (couldBecomeRoute(first)) return { route: undefined, body: "", next: undefined };
		route = "side";
		rest = text;
	} else {
		const match = ROUTE_LINE.exec(cleanLine(first));
		if (match) {
			route = match[1]!.toLowerCase() as Route;
			rest = newline < 0 ? "" : text.slice(newline + 1);
		} else {
			route = "side";
			rest = text;
		}
	}

	const lines = rest.split("\n");
	while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
	const parsed: ParsedReply = { route, body: "", next: undefined };
	// While streaming, the last line may still become an action line: keep it hidden until it is clearly prose.
	if (!done && lines.length > 0) {
		const trimmed = lines.at(-1)!.trim().toLowerCase();
		if (trimmed !== "" && ACTION_FORMS.some(form => form.startsWith(trimmed))) lines.pop();
	}
	for (;;) {
		while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
		const match = lines.length > 0 ? ACTION_LINE.exec(lines.at(-1)!) : null;
		if (!match) break;
		lines.pop();
		if (!done) continue;
		const value = match[2]!.replace(/^[*`\s]+|[*`\s]+$/g, "");
		const kind = match[1]!.toLowerCase();
		if (kind === "next") parsed.next ??= sanitizeSuggestion(value);
		else if (kind === "tell") { if (value && parsed.tell === undefined) parsed.tell = value; }
		else if (parsed.move === undefined) {
			const bar = value.indexOf("|");
			const name = (bar < 0 ? value : value.slice(0, bar)).trim();
			const hint = bar < 0 ? "" : value.slice(bar + 1).trim();
			parsed.move = { ...(name ? { name } : {}), ...(hint ? { hint } : {}) };
		}
	}
	parsed.body = lines.join("\n").trim();
	return parsed;
}

/** A suggestion is one sentence in the user's words, never another command. */
export function sanitizeSuggestion(value: string): string | undefined {
	const line = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]/)[0]!.replace(/[\x00-\x1f\x7f]/g, "").trim();
	if (!line || line.toLowerCase() === "none" || line.startsWith("/")) return undefined;
	return truncateToWidth(line, 80, "…").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

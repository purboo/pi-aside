import { truncateToWidth } from "@earendil-works/pi-tui";

// Parsing of the aside model's reply (docs/ux.md §3.3, §3.4): a hidden first line `route: side|agent`, the
// visible body, and an optional last line `next: <one line for the agent>`.

export type Route = "side" | "agent";

export interface ParsedReply {
	route: Route | undefined;
	body: string;
	next: string | undefined;
}

const ROUTE_LINE = /^route\s*:\s*(side|agent)$/i;
const NEXT_LINE = /^\s*next\s*:(.*)$/i;
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
	let next: string | undefined;
	const last = lines.at(-1);
	if (last !== undefined) {
		const match = NEXT_LINE.exec(last);
		if (done) {
			if (match) {
				lines.pop();
				const value = match[1]!.trim();
				next = sanitizeSuggestion(value);
			}
		} else {
			const trimmed = last.trim().toLowerCase();
			if (match || (trimmed !== "" && "next:".startsWith(trimmed))) lines.pop();
		}
	}
	return { route, body: lines.join("\n").trim(), next };
}

/** A suggestion is one sentence in the user's words, never another command. */
export function sanitizeSuggestion(value: string): string | undefined {
	const line = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]/)[0]!.replace(/[\x00-\x1f\x7f]/g, "").trim();
	if (!line || line.toLowerCase() === "none" || line.startsWith("/")) return undefined;
	return truncateToWidth(line, 80, "…").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

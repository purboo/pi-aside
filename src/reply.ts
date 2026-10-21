// Parsing of the aside model's reply (docs/ux.md §3.3, §3.4): a hidden first line `route: side|agent`, the
// visible body, and an optional last line `handoff: <one line for the agent>`.

export type Route = "side" | "agent";

export interface ParsedReply {
	route: Route | undefined;
	body: string;
	handoff: string | undefined;
}

const ROUTE_LINE = /^route\s*:\s*(side|agent)$/i;
const HANDOFF_LINE = /^\s*handoff\s*:(.*)$/i;
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
		if (couldBecomeRoute(first)) return { route: undefined, body: "", handoff: undefined };
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
	let handoff: string | undefined;
	const last = lines.at(-1);
	if (last !== undefined) {
		const match = HANDOFF_LINE.exec(last);
		if (done) {
			if (match) {
				lines.pop();
				const value = match[1]!.trim();
				handoff = value === "" || value.toLowerCase() === "none" ? undefined : value;
			}
		} else {
			const trimmed = last.trim().toLowerCase();
			if (match || (trimmed !== "" && "handoff:".startsWith(trimmed))) lines.pop();
		}
	}
	return { route, body: lines.join("\n").trim(), handoff };
}

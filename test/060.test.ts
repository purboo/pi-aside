// 0.6.0: sending a message the `?` rule took aside to the agent instead (docs/ux.md §3.4.1).

import { expect, test } from "bun:test";
import { BACK_HINT, CLOSE_MARK, closeZone, FORWARD_MARK, forwardZone, HINT, panelBody, panelHit, panelView, renderBelow, UNDO_HINT, type PanelState } from "../src/panel.ts";
import { canTakeBack, TAKE_BACK_MS } from "../src/qmark.ts";
import { parseReply } from "../src/reply.ts";
import { notice } from "../src/thread.ts";

const theme = { fg: (_color: string, text: string) => text };
const turn = (over: Record<string, unknown> = {}) => ({ question: "why are you deleting the tests?", raw: "", done: false, steps: [], startedAt: 1_000, cost: 0, read: 0, written: 0, ...over });
const state = (over: Partial<PanelState> = {}, t: Record<string, unknown> = {}): PanelState => ({ turns: [turn(t) as never], maxLines: 12, ...over });

test("a message can go to the agent instead while it is answered, and for two minutes after", () => {
	expect(TAKE_BACK_MS).toBe(120_000);
	expect(canTakeBack({ done: false }, 10_000_000)).toBe(true);
	expect(canTakeBack({ done: true, endedAt: 1_000 }, 1_000 + TAKE_BACK_MS)).toBe(true);
	expect(canTakeBack({ done: true, endedAt: 1_000 }, 1_001 + TAKE_BACK_MS)).toBe(false);
});

test("forward: is a hidden reply line with nothing after its colon, hidden while it streams", () => {
	expect(parseReply("route: side\nSent it.\nforward:", true)).toMatchObject({ route: "side", body: "Sent it.", forward: true });
	expect(parseReply("Sent it.\n**forward:**\nnext: wait for the agent", true)).toMatchObject({ body: "Sent it.", forward: true, next: "wait for the agent" });
	// Whatever a model writes after the colon, the user's own text is what goes.
	expect(parseReply("Sent it.\nforward: why are you deleting the tests?", true).forward).toBe(true);
	expect(parseReply("route: side\nSent it.\nforw", false).body).toBe("Sent it.");
	expect(parseReply("route: side\nSent it.\nforward:", false).forward).toBeUndefined();
	// A word in prose is not an action line.
	expect(parseReply("Go forward\nThat is all.", true).forward).toBeUndefined();
	expect(parseReply("forward", true)).toMatchObject({ body: "forward" });
});

test("the notice explains forward: against tell:, and only on an explicit request", () => {
	for (const routeCheck of [true, false]) {
		const text = notice({ routeCheck });
		expect(text).toContain("`forward:` (nothing after the colon)");
		expect(text).toContain("exactly as they wrote it");
		expect(text).toContain("ONLY when the user's latest message asks to send that earlier message itself");
		expect(text).toContain("use `tell:` instead");
	}
});

test("below the editor: ↑↵ while the message is answered, then where Enter sends it once recalled", () => {
	expect(renderBelow({ hint: "undo", next: undefined }, 100, theme)).toEqual([UNDO_HINT]);
	expect(renderBelow({ hint: "back", next: undefined }, 100, theme)).toEqual([BACK_HINT]);
	expect(renderBelow({ hint: true, next: undefined }, 100, theme)).toEqual([HINT]);
	expect(UNDO_HINT).toBe("↑↵ sends it to the agent instead");
	expect(BACK_HINT).toBe("↵ sends to the agent · it was asked on the side");
});

test("sent by the user, the panel keeps what the aside said and says where the message went", () => {
	const body = panelBody(state({ sentToAgent: { text: "q", waiting: false, byUser: true } }, { done: true, aborted: true, raw: "route: side\nThey cover the old API." }), 50, theme);
	expect(body).toEqual(["They cover the old API.", "↪ sent to the agent"]);
	// Still streaming when it was sent: no spinner, no "stopped".
	const early = panelBody(state({ sentToAgent: { text: "q", waiting: false, byUser: true } }, { raw: "" }), 50, theme);
	expect(early).toEqual(["↪ sent to the agent"]);
	// The route check's own send is unchanged: one line, with its reading.
	const routed = panelBody(state({ sentToAgent: { text: "q", waiting: false } }, { done: true, aborted: true, raw: "route: agent\n" }), 50, theme);
	expect(routed).toEqual(["↪ sent to the agent · it reads as a correction"]);
	// A sent panel does not spin.
	const top = panelView(state({ sentToAgent: { text: "q", waiting: false, byUser: true } }, { raw: "route: side\nThey" }), 50, theme, undefined, 1_000).lines[0]!;
	expect(top).toContain("╭─ why are you deleting the tests? ─");
});

test("a forward: line shows what went to the agent, word for word", () => {
	const body = panelBody(state({}, { question: "send that to the agent as it is?", done: true, raw: "route: side\nSent it.", forwarded: "why are you deleting the tests?" }), 50, theme);
	expect(body).toEqual(["↪ sent to the agent", "┃ why are you deleting the tests?", "Sent it."]);
});

test("the forward mark: beside the close mark where Pi reports the mouse, two edge cells apart, its own tap zone", () => {
	const width = 60;
	const view = panelView(state({ mouse: true, forwardable: true }, { done: true, raw: "route: side\nDone." }), width, theme);
	const top = [...view.lines[0]!];
	expect(top.length).toBe(width);
	expect(top.indexOf(CLOSE_MARK)).toBe(width - 4);
	expect(top.indexOf(FORWARD_MARK)).toBe(width - 9);
	expect(view.lines[0]!.endsWith(` ${FORWARD_MARK} ── ${CLOSE_MARK} ─╮`)).toBe(true);
	expect(view.forward).toBe(true);
	const [from, to] = forwardZone(width);
	const [closeFrom] = closeZone(width);
	expect(to).toBeLessThan(closeFrom - 1);
	for (const x of [width - 10, width - 9, width - 8]) {
		expect(panelHit(view, width, x, 0, true)).toBe("forward");
		expect(panelHit(view, width, x, 1, true)).toBe("forward");
	}
	expect(panelHit(view, width, width - 7, 0, true)).toBeUndefined();
	expect(panelHit(view, width, from - 1, 0, true)).toBeUndefined();
	expect(panelHit(view, width, width - 4, 0, true)).toBe("close");
	// A long question leaves both marks in place.
	const long = panelView(state({ mouse: true, forwardable: true }, { question: "why ".repeat(40), done: true, raw: "ok" }), width, theme);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI resets that truncation adds.
	const plain = [...long.lines[0]!.replace(/\x1b\[[0-9;]*m/g, "")];
	expect(plain.length).toBe(width);
	expect(plain.indexOf(FORWARD_MARK)).toBe(width - 9);
	expect(plain.indexOf(CLOSE_MARK)).toBe(width - 4);
});

test("no forward mark without the mouse, once sent, for a question that cannot go back, or on a narrow panel", () => {
	const cases: Partial<PanelState>[] = [
		{ mouse: false, forwardable: true },
		{ mouse: true, forwardable: true, sentToAgent: { text: "q", waiting: false, byUser: true } },
		{ mouse: true, forwardable: false },
	];
	for (const over of cases) {
		const view = panelView(state(over, { done: true, raw: "route: side\nDone." }), 60, theme);
		expect(view.lines[0]).not.toContain(FORWARD_MARK);
		expect(view.forward).toBeUndefined();
		expect(panelHit(view, 60, 51, 0, true)).toBeUndefined();
	}
	expect(panelView(state({ mouse: true, forwardable: true }, { done: true, raw: "ok" }), 28, theme).lines[0]).not.toContain(FORWARD_MARK);
});

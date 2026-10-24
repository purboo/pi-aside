// Key replay in the real Pi TUI (docs/ux.md §6: U2, U5, U9 and the route check), offline in a private tmux.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CaptureServer, startCaptureServer } from "./harness/capture.ts";
import { type PiTui, startPiTui } from "./harness/tui.ts";

const ROOT = resolve(import.meta.dir, "..");
const ASIDE = join(ROOT, "src/index.ts");

let server: CaptureServer | undefined;
let tui: PiTui | undefined;

afterEach(async () => {
	await tui?.close();
	await server?.close();
	tui = undefined;
	server = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const BG = join(ROOT, "test/fixtures/bg.ts");

async function start(extensions: string[] = [ASIDE], settings?: Record<string, unknown>): Promise<{ server: CaptureServer; tui: PiTui }> {
	server = await startCaptureServer();
	tui = await startPiTui({ baseUrl: server.url, extensions, settings });
	await tui.waitForScreen(/claude-test/, 20_000);
	return { server, tui };
}

const bodies = (s: CaptureServer) => s.requests.map((r) => JSON.stringify(r.body));

describe("TUI", () => {
	test("a relay queues behind the main tool and changes to read when Pi injects it", async () => {
		const { server, tui } = await start();
		server.enqueue({ toolCalls: [{ name: "bash", arguments: { command: "sleep 2; echo main-step-finished" } }] });
		tui.type("do the current main step"); tui.key("Enter");
		await server.waitForRequests(1);
		await tui.waitForScreen(/sleep 2/);
		let side = 0;
		server.respond(request => JSON.stringify(request.body).includes("<aside>")
			? ++side === 1 ? { text: "route: side\n", toolCalls: [{ name: "tell_agent", arguments: { message: "After this step, retain the routing tests." } }] } : { text: "Queued." }
			: { text: "Read the relay after completing the main step." });
		tui.type("/aside tell the agent to retain the routing tests"); tui.key("Enter");
		await tui.waitForScreen(/It will see this after its current step\./);
		await tui.waitForScreen(/It has read this\./);
		const main = server.requests.filter(request => !JSON.stringify(request.body).includes("<aside>"));
		expect(main).toHaveLength(2);
		expect(JSON.stringify(main[1]!.body)).toContain("main-step-finished");
		expect(JSON.stringify(main[1]!.body)).toContain("retain the routing tests");
	}, 20_000);

	test("tell_agent shows the sent block and aside prefix in the main transcript", async () => {
		const { server, tui } = await start();
		let side = 0;
		server.respond(request => JSON.stringify(request.body).includes("<aside>")
			? ++side === 1 ? { text: "route: side\n", toolCalls: [{ name: "tell_agent", arguments: { message: "Keep the routing tests." } }] } : { text: "Delivered." }
			: { text: "I will keep the tests." });
		tui.type("/aside tell the agent to keep the routing tests"); tui.key("Enter");
		const screen = await tui.waitForScreen(/It has read this\./);
		expect(screen).toContain("→ to the agent");
		expect(screen).toContain("┃ Keep the routing tests.");
		await tui.waitForScreen(/aside › Keep the routing tests\./);
		expect(tui.screen()).not.toMatch(/handoff:|tab accepts|⇥/);
	}, 20_000);

	test("busy + `?`: hint, asks on the side, panel above the editor; the main session never sees it", async () => {
		const { server, tui } = await start();
		const hold = deferred();
		server.enqueue({ text: "Refactoring now.", hold: hold.promise, usage: { input: 50, cacheWrite: 900 } });
		tui.type("refactor the parser");
		tui.key("Enter");
		await server.waitForRequests(1);
		tui.type("why did it pick approach B?");
		await tui.waitForScreen(/↵ asks on the side · corrections still reach the agent/);
		server.enqueue({ text: "route: side\nBecause B touches fewer callers.", usage: { input: 20, cacheRead: 900 } });
		tui.key("Enter");
		await sleep(300);
		hold.resolve();
		const screen = await tui.waitForScreen(/Because B touches fewer callers\./);
		expect(screen).toMatch(/╭─ why did it pick approach B\?/);
		await sleep(1000);
		expect(server.requests.length).toBe(2);
		expect(bodies(server)[0]).not.toContain("approach B");
		// Sending something to the agent leaves the panel as it is: only the user closes it.
		server.enqueue({ text: "Okay.", usage: { input: 50, cacheRead: 900 } });
		tui.type("thanks");
		tui.key("Enter");
		await server.waitForRequests(3);
		await tui.waitForScreen(/Okay\./);
		expect(tui.screen()).toMatch(/╭─ why did it pick approach B\?/);
		const third = bodies(server)[2]!;
		expect(third).toContain("thanks");
		expect(third).not.toContain("why did it pick approach B");
		expect(third).not.toContain("fewer callers");
	}, 60_000);

	test("busy + CJK `？` asks on the side; busy without `?` steers; idle `?` prompts", async () => {
		const { server, tui } = await start();
		const hold = deferred();
		server.enqueue(
			{ toolCalls: [{ id: "toolu_1", name: "bash", arguments: { command: "sleep 1; echo ok" } }], hold: hold.promise, usage: { input: 50, cacheWrite: 900 } },
			{ text: "Done.", usage: { input: 50, cacheRead: 900 } },
		);
		tui.type("run the script");
		tui.key("Enter");
		await server.waitForRequests(1);
		server.respond((r) => (JSON.stringify(r.body).includes("为什么用 B") ? { text: "route: side\n因为 B 改动更少。", usage: { input: 10 } } : undefined));
		tui.type("为什么用 B？");
		await tui.waitForScreen(/↵ asks on the side/);
		tui.key("Enter");
		await sleep(200);
		tui.type("use approach A instead");
		await sleep(200);
		expect(tui.screen()).not.toMatch(/↵ asks on the side/);
		tui.key("Enter");
		hold.resolve();
		await tui.waitForScreen(/因为 B 改动更少。/);
		await server.waitForRequests(3);
		await sleep(1500);
		const main = server.requests.filter((r) => !JSON.stringify(r.body).includes("为什么用 B"));
		const last = JSON.stringify(main.at(-1)!.body);
		expect(last).toContain("use approach A instead");
		expect(last).not.toContain("为什么用 B");
		// Idle: a question is a normal prompt.
		server.respond(undefined);
		await tui.waitForScreen(/Done\./);
		server.enqueue({ text: "Idle answer.", usage: { input: 50 } });
		const before = server.requests.length;
		tui.type("what changed?");
		await sleep(200);
		expect(tui.screen()).not.toMatch(/↵ asks on the side/);
		tui.key("Enter");
		await server.waitForRequests(before + 1);
		const prompt = JSON.stringify(server.requests[before]!.body);
		expect(prompt).toContain("what changed?");
		expect(prompt).not.toContain("<aside>");
	}, 60_000);

	test("Esc closes the panel first (a quick second Esc is a double press); the next Esc stops the agent", async () => {
		const { server, tui } = await start();
		const hold = deferred();
		server.enqueue({ text: "First part.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/First part\./);
		server.enqueue({ text: "route: side\nSide answer here.", usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside what happened?");
		tui.key("Enter");
		await tui.waitForScreen(/Side answer here\./);
		server.enqueue({ text: "Never shown.", hold: hold.promise, usage: { input: 50 } });
		tui.type("continue");
		tui.key("Enter");
		await tui.waitForScreen(/Working/);
		tui.key("Escape");
		for (let i = 0; i < 50 && /Side answer here\./.test(tui.screen()); i++) await sleep(50);
		expect(tui.screen()).not.toMatch(/Side answer here\./);
		tui.key("Escape");
		await sleep(800);
		expect(tui.screen()).not.toMatch(/[Aa]bort/);
		expect(tui.screen()).toMatch(/Working/);
		// With nothing of the aside on screen, Esc is Pi's again.
		tui.key("Escape");
		await tui.waitForScreen(/[Aa]bort/);
		hold.resolve();
	}, 60_000);

	test("Esc dismisses autocomplete before the aside, and a focused dialog keeps its own Esc", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Hello.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/Hello\./);
		server.enqueue({ text: "route: side\nKeep this answer visible.", usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside question");
		tui.key("Enter");
		await tui.waitForScreen(/Keep this answer visible\./);
		tui.type("/mod");
		await tui.waitForScreen(/Select model|Switch model|\/model/);
		tui.key("Escape");
		await sleep(200);
		expect(tui.screen()).toMatch(/Keep this answer visible\./);
		tui.key("C-u");
		tui.key("C-l");
		await tui.waitForScreen(/Enter to select · Ctrl\+S to set as default/);
		tui.key("Escape");
		for (let i = 0; i < 50 && /Enter to select · Ctrl\+S/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/Enter to select · Ctrl\+S/);
		expect(tui.screen()).toMatch(/Keep this answer visible\./);
		tui.key("Escape");
		for (let i = 0; i < 50 && /Keep this answer visible\./.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/Keep this answer visible\./);
	}, 60_000);

	test("regular mode keeps keyboard dismissal and does not advertise touch targets", async () => {
		const { server, tui } = await start([ASIDE], { tuiMode: "regular" });
		server.enqueue({ text: "Hello.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/Hello\./);
		server.enqueue({ text: "route: side\nRegular side answer.", usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside regular mode question");
		tui.key("Enter");
		await tui.waitForScreen(/Regular side answer\./);
		const title = tui.screen().split("\n").find((line) => line.includes("╭─ regular mode question"));
		expect(title).toBeDefined();
		expect(title).not.toContain("✕");
		tui.key("Escape");
		for (let i = 0; i < 50 && /Regular side answer\./.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/Regular side answer\./);
	}, 60_000);

	test("next: placeholder, Tab fills /aside, Enter continues the aside", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Using approach B.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("pick an approach");
		tui.key("Enter");
		await tui.waitForScreen(/Using approach B\./);
		server.enqueue({ text: "route: side\nA is safer here.\nnext: check approach A", usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside is B right?");
		tui.key("Enter");
		await tui.waitForScreen(/\/aside check approach A/);
		tui.key("Tab");
		await sleep(300);
		const screen = tui.screen();
		expect(screen).not.toMatch(/⇥|tab accepts/);
		expect(screen).toMatch(/^.*\/aside check approach A\s*$/m);
		server.enqueue({ text: "Switching.", usage: { input: 50, cacheRead: 900 } });
		const before = server.requests.length;
		tui.key("Enter");
		await server.waitForRequests(before + 1);
		const body = JSON.stringify(server.requests[before]!.body);
		expect(body).toContain("check approach A");
		expect(body).toContain("<aside>");
		expect(body).toContain("A is safer here.");
	}, 60_000);

	test("route: agent sends the original text as a steer and says so", async () => {
		const { server, tui } = await start();
		server.enqueue(
			{ toolCalls: [{ id: "toolu_2", name: "bash", arguments: { command: "sleep 2; echo ok" } }], usage: { input: 50, cacheWrite: 900 } },
			{ text: "Finished.", usage: { input: 50, cacheRead: 900 } },
		);
		tui.type("delete the old tests");
		tui.key("Enter");
		await server.waitForRequests(1);
		await sleep(500);
		server.respond((r) => (JSON.stringify(r.body).includes("<aside>") ? { text: "route: agent\n", usage: { input: 10, cacheRead: 900 } } : undefined));
		tui.type("why are you deleting the tests?");
		tui.key("Enter");
		await tui.waitForScreen(/↪ sent to the agent · it reads as a correction/);
		await server.waitForRequests(3, 20_000);
		await tui.waitForScreen(/Finished\./);
		const last = JSON.stringify(server.requests.at(-1)!.body);
		expect(last).toContain("why are you deleting the tests?");
		expect(last).not.toContain("<aside>");
	}, 60_000);

	test("a bracketed paste with `?` and a newline is inserted, not submitted", async () => {
		const { server, tui } = await start();
		const hold = deferred();
		server.enqueue({ text: "Working.", hold: hold.promise, usage: { input: 50 } });
		tui.type("start");
		tui.key("Enter");
		await server.waitForRequests(1);
		tui.paste("is this right?\nand this?");
		await sleep(500);
		expect(server.requests.length).toBe(1);
		expect(tui.screen()).toMatch(/is this right\?/);
		hold.resolve();
	}, 60_000);

	test("waiting for background work: `?` asks on the side without starting a turn; other text prompts", async () => {
		const { server, tui } = await start([BG, ASIDE]);
		server.enqueue({ text: "Spawned the subagents.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("start the subagents");
		tui.key("Enter");
		await tui.waitForScreen(/Spawned the subagents\./);
		tui.type("/bg 2");
		tui.key("Enter");
		await sleep(300);
		tui.type("how far along are they?");
		await tui.waitForScreen(/↵ asks on the side/);
		server.enqueue({ text: "route: side\nTwo are still running.", usage: { input: 10, cacheRead: 900 } });
		tui.key("Enter");
		await tui.waitForScreen(/Two are still running\./);
		await sleep(800);
		expect(server.requests.length).toBe(2);
		expect(JSON.stringify(server.requests[1]!.body)).toContain("<aside>");
		// Not a question: Pi's meaning while idle, a prompt.
		server.enqueue({ text: "Noted.", usage: { input: 50, cacheRead: 900 } });
		tui.type("also check the logs");
		await sleep(200);
		expect(tui.screen()).not.toMatch(/↵ asks on the side/);
		tui.key("Enter");
		await server.waitForRequests(3);
		expect(JSON.stringify(server.requests[2]!.body)).toContain("also check the logs");
		await tui.waitForScreen(/Noted\./);
		// Work done: questions prompt again.
		tui.type("/bg 0");
		tui.key("Enter");
		await sleep(300);
		tui.type("done?");
		await sleep(300);
		expect(tui.screen()).not.toMatch(/↵ asks on the side/);
	}, 60_000);

	test("before its first words the panel shows a spinner and the time, then the model's thinking; Markdown renders", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Hello.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/Hello\./);
		const hold = deferred();
		const holdText = deferred();
		server.enqueue({
			hold: hold.promise,
			thinking: "**Comparing** the two approaches carefully.",
			holdText: holdText.promise,
			text: "route: side\n**Because** B touches `fewer` callers.\n\n- first reason\n- second reason",
			usage: { input: 10, cacheRead: 900 },
		});
		tui.type("/aside why B?");
		tui.key("Enter");
		await tui.waitForScreen(/[\u2800-\u28ff] working/);
		await tui.waitForScreen(/working · [1-9]s/);
		hold.resolve();
		await tui.waitForScreen(/[\u2800-\u28ff] thinking/);
		const thinking = await tui.waitForScreen(/Comparing the two approaches carefully\./);
		expect(thinking).not.toContain("**Comparing**");
		holdText.resolve();
		const screen = await tui.waitForScreen(/Because B touches fewer callers\./);
		expect(screen).not.toContain("**Because**");
		expect(screen).not.toContain("`fewer`");
		expect(screen).toMatch(/first reason/);
		expect(screen).not.toMatch(/thinking|working|Comparing/);
	}, 60_000);

	test("Esc closes the panel and stops an aside still running; Enter on an empty editor leaves it; /aside rereads it", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Hello.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/Hello\./);
		server.enqueue({ text: "route: side\nThe side answer.", usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside what happened?");
		tui.key("Enter");
		await tui.waitForScreen(/The side answer\./);
		const requests = server.requests.length;
		tui.key("Enter");
		await sleep(500);
		expect(tui.screen()).toMatch(/╭─ what happened\?/);
		tui.key("Escape");
		for (let i = 0; i < 50 && /what happened\?/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/what happened\?/);
		await sleep(500);
		expect(server.requests.length).toBe(requests);
		tui.type("/aside");
		tui.key("Enter");
		await tui.waitForScreen(/esc close/);
		expect(tui.screen()).toMatch(/The side answer\./);
		tui.key("Escape");
		for (let i = 0; i < 50 && /esc close/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/esc close/);
		// An aside still running stops with its panel.
		const hold = deferred();
		server.enqueue({ text: "route: side\nNever shown.", hold: hold.promise, usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside is it slow?");
		tui.key("Enter");
		await tui.waitForScreen(/╭─ is it slow\?/);
		await server.waitForRequests(requests + 1);
		tui.key("Escape");
		for (let i = 0; i < 50 && /is it slow\?/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/is it slow\?/);
		hold.resolve();
		tui.type("/aside");
		tui.key("Enter");
		const reread = await tui.waitForScreen(/esc close/);
		expect(reread).toMatch(/\(stopped\)/);
		expect(reread).not.toMatch(/Never shown\./);
		tui.key("Escape");
	}, 60_000);

	test("a long answer: ctrl+o where the panel prints it opens the reader; typing there goes on in the editor", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Hello.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/Hello\./);
		const lines = Array.from({ length: 30 }, (_, i) => `point number ${i + 1}`).join("\n\n");
		server.enqueue({ text: `route: side\n${lines}`, usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside list the points");
		tui.key("Enter");
		await tui.waitForScreen(/\u2193 \d+ more lines \u00b7 ctrl\+o/);
		expect(tui.screen()).toMatch(/point number 1\b/);
		expect(tui.screen()).not.toMatch(/point number 30/);
		tui.key("C-o");
		await tui.waitForScreen(/type to follow up/);
		tui.key("End");
		await tui.waitForScreen(/point number 30/);
		tui.type("and the last one");
		for (let i = 0; i < 50 && /type to follow up/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/type to follow up/);
		await tui.waitForScreen(/and the last one/);
		// Closed, the panel no longer claims ctrl+o: it stays Pi's.
		for (let i = 0; i < 16; i++) tui.key("BSpace");
		await tui.waitForScreen(/\u2193 \d+ more lines/);
		tui.key("Escape");
		for (let i = 0; i < 50 && /list the points/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/list the points/);
		tui.key("C-o");
		await sleep(600);
		expect(tui.screen()).not.toMatch(/type to follow up/);
	}, 60_000);

	test("fullscreen: the wheel (a swipe) over the panel scrolls it, not the conversation; a tap on its close mark closes it", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Hello.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/Hello\./);
		const lines = Array.from({ length: 30 }, (_, i) => `point number ${i + 1}`).join("\n\n");
		server.enqueue({ text: `route: side\n${lines}`, usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside list the points");
		tui.key("Enter");
		await tui.waitForScreen(/\u2193 \d+ more lines \u00b7 ctrl\+o/);
		const rows = tui.screen().split("\n");
		const top = rows.findIndex((line) => line.includes("\u256d\u2500 list the points"));
		expect(top).toBeGreaterThanOrEqual(0);
		expect(rows[top]).toContain("\u2715");
		expect(tui.screen()).toMatch(/point number 1\b/);
		// Wheel down over the panel (SGR button 65, 1-based cells).
		for (let i = 0; i < 6; i++) tui.type(`\x1b[<65;20;${top + 4}M`);
		await tui.waitForScreen(/\u2191 \d+ more lines/);
		expect(tui.screen()).not.toMatch(/point number 1\b/);
		expect(tui.screen()).toMatch(/Hello\./);
		// Wheel up again: back at the start.
		for (let i = 0; i < 40; i++) tui.type(`\x1b[<64;20;${top + 4}M`);
		await tui.waitForScreen(/point number 1\b/);
		// Tap the count line to read more; the reader owns its wheel and its close mark, too.
		let now = tui.screen().split("\n");
		const countRow = now.findIndex((line) => /↓ \d+ more lines/.test(line));
		expect(countRow).toBeGreaterThanOrEqual(0);
		tui.type(`\x1b[<0;20;${countRow + 1}M`);
		tui.type(`\x1b[<0;20;${countRow + 1}m`);
		await tui.waitForScreen(/type to follow up/);
		now = tui.screen().split("\n");
		let readerTop = now.findIndex((line) => /╭─ aside /.test(line));
		expect(readerTop).toBeGreaterThanOrEqual(0);
		for (let i = 0; i < 6; i++) tui.type(`\x1b[<65;20;${readerTop + 5}M`);
		await sleep(200);
		expect(tui.screen()).not.toMatch(/\? list the points/);
		now = tui.screen().split("\n");
		readerTop = now.findIndex((line) => /╭─ aside /.test(line));
		const readerClose = [...now[readerTop]!].indexOf("✕") + 1;
		tui.type(`\x1b[<0;${readerClose};${readerTop + 1}M`);
		tui.type(`\x1b[<0;${readerClose};${readerTop + 1}m`);
		for (let i = 0; i < 50 && /type to follow up/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/type to follow up/);
		// A tap on the panel's close mark: press and release on the same cell.
		now = tui.screen().split("\n");

		const row = now.findIndex((line) => line.includes("\u256d\u2500 list the points"));
		const col = [...now[row]!].indexOf("\u2715") + 1;
		tui.type(`\x1b[<0;${col};${row + 1}M`);
		tui.type(`\x1b[<0;${col};${row + 1}m`);
		for (let i = 0; i < 50 && /list the points/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/list the points/);
		expect(tui.screen()).toMatch(/Hello\./);
	}, 60_000);

	test("a side task: its tools run only after the route line, and the panel lists what it did", async () => {
		const { server, tui } = await start();
		// The agent stays busy in a tool call; its next request comes long after this test.
		server.enqueue({ toolCalls: [{ id: "toolu_8", name: "bash", arguments: { command: "sleep 40; echo ok" } }], usage: { input: 50, cacheWrite: 900 } });
		tui.type("refactor the parser");
		tui.key("Enter");
		await server.waitForRequests(1);
		await sleep(400);
		server.enqueue(
			{ toolCalls: [{ id: "toolu_x", name: "bash", arguments: { command: "echo early >> log.txt" } }], usage: { input: 20, cacheRead: 900 } },
			{ text: "route: side\nOn it.", toolCalls: [{ id: "toolu_y", name: "bash", arguments: { command: "echo side >> log.txt" } }], usage: { input: 20, cacheRead: 900 } },
			{ text: "Logged it.", usage: { input: 20, cacheRead: 900 } },
		);
		tui.type("add a line to log.txt?");
		await tui.waitForScreen(/\u21b5 asks on the side/);
		tui.key("Enter");
		const screen = await tui.waitForScreen(/Logged it\./);
		expect(screen).toMatch(/\u2713 \$ echo side >> log\.txt/);
		expect(screen).not.toMatch(/echo early/);
		expect(readFileSync(join(tui.cwd, "log.txt"), "utf8")).toBe("side\n");
		const asides = server.requests.filter((r) => JSON.stringify(r.body).includes("<aside>"));
		expect(asides.length).toBe(3);
		expect(JSON.stringify(asides[1]!.body)).toContain("Not run: start your reply with the route line");
		// The main session never saw it.
		expect(JSON.stringify(server.requests[0]!.body)).not.toContain("log.txt");
	}, 60_000);

	test("an open panel means a follow-up, a closed one a fresh question; the hint says which before Enter", async () => {
		const { server, tui } = await start();
		// The agent stays busy in a tool call; its next request comes long after this test.
		server.enqueue({ toolCalls: [{ id: "toolu_9", name: "bash", arguments: { command: "sleep 40; echo ok" } }], usage: { input: 50, cacheWrite: 900 } });
		tui.type("refactor the parser");
		tui.key("Enter");
		await server.waitForRequests(1);
		await sleep(400);
		server.enqueue({ text: "route: side\nBecause B touches fewer callers.", usage: { input: 20, cacheRead: 900 } });
		tui.type("why did it pick B?");
		await tui.waitForScreen(/↵ asks on the side/);
		tui.key("Enter");
		await tui.waitForScreen(/Because B touches fewer callers\./);
		server.enqueue({ text: "route: side\nYes, in cli.ts.", usage: { input: 20, cacheRead: 900 } });
		tui.type("is A still used?");
		await tui.waitForScreen(/↵ follows up on the side/);
		tui.key("Enter");
		const followed = await tui.waitForScreen(/Yes, in cli\.ts\./);
		expect(followed).toMatch(/╭─ is A still used\?/);
		expect(followed).toMatch(/after: why did it pick B\?/);
		expect(followed).not.toMatch(/Because B touches/);
		const asides = server.requests.filter((r) => JSON.stringify(r.body).includes("<aside>"));
		expect(JSON.stringify(asides.at(-1)!.body)).toContain("Because B touches fewer callers.");
		tui.key("Escape");
		for (let i = 0; i < 50 && /\u256d\u2500 is A still used\?/.test(tui.screen()); i++) await sleep(100);
		expect(tui.screen()).not.toMatch(/\u256d\u2500 is A still used\?/);
		server.enqueue({ text: "route: side\nAbout a minute.", usage: { input: 20, cacheRead: 900 } });
		tui.type("how long will it take?");
		await tui.waitForScreen(/↵ asks on the side/);
		expect(tui.screen()).not.toMatch(/follows up/);
		tui.key("Enter");
		const fresh = await tui.waitForScreen(/About a minute\./);
		expect(fresh).not.toMatch(/after:/);
		expect(JSON.stringify(server.requests.at(-1)!.body)).not.toContain("Yes, in cli.ts.");
	}, 60_000);

	test("the reader opens at the latest question; long CJK Markdown lines wrap inside its frame", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Hello.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("hello");
		tui.key("Enter");
		await tui.waitForScreen(/Hello\./);
		const long = Array.from({ length: 30 }, (_, i) => `\u7b2c ${i + 1} \u884c`).join("\n\n");
		server.enqueue({ text: `route: side\n${long}`, usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside first?");
		tui.key("Enter");
		await tui.waitForScreen(/more lines \u00b7 ctrl\+o/);
		const cjk =
			"1. **\u5386\u53f2\u6570\u636e\u4e0d\u518d\u7b97\u9a8c\u8bc1**\uff1a\u5df2\u5b8c\u6210\u5e76\u5408\u5165 trunk\uff08`1fe6175`\uff0cledger #294\uff09\u3002" +
			"\u8fd9\u662f\u4e00\u6bb5\u5f88\u957f\u7684\u4e2d\u6587\u53e5\u5b50".repeat(12) +
			"END";
		server.enqueue({ text: `route: side\n${cjk}`, usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside second?");
		tui.key("Enter");
		await tui.waitForScreen(/END/);
		tui.type("/aside");
		tui.key("Enter");
		const screen = await tui.waitForScreen(/esc close/);
		expect(screen).toMatch(/\? second\?/);
		expect(screen).toMatch(/END/);
		expect(screen).not.toMatch(/\? first\?/);
		expect(screen).not.toContain("**");
		const framed = screen.split("\n").filter((line) => line.startsWith("\u2502"));
		for (const line of framed) expect(line).not.toMatch(/\.\.\.\s*\u2502$|\u2026\s*\u2502$/);
		tui.key("Escape");
	}, 60_000);

	test("an aside that fails before its route line sends the text as a steer", async () => {
		const { server, tui } = await start();
		server.enqueue(
			{ toolCalls: [{ id: "toolu_3", name: "bash", arguments: { command: "sleep 2; echo ok" } }], usage: { input: 50, cacheWrite: 900 } },
			{ text: "All done.", usage: { input: 50, cacheRead: 900 } },
		);
		server.respond((r) => (JSON.stringify(r.body).includes("<aside>") ? { status: 400, errorBody: { type: "error", error: { type: "invalid_request_error", message: "bad aside" } } } : undefined));
		tui.type("run it");
		tui.key("Enter");
		await server.waitForRequests(1);
		await sleep(400);
		tui.type("is it slow?");
		tui.key("Enter");
		await tui.waitForScreen(/↪ sent to the agent/);
		await tui.waitForScreen(/All done\./, 20_000);
		const last = JSON.stringify(server.requests.at(-1)!.body);
		expect(last).toContain("is it slow?");
		expect(last).not.toContain("<aside>");
	}, 60_000);
});

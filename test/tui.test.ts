// Key replay in the real Pi TUI (docs/ux.md §6: U2, U5, U9 and the route check), offline in a private tmux.

import { afterEach, describe, expect, test } from "bun:test";
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

async function start(extensions: string[] = [ASIDE]): Promise<{ server: CaptureServer; tui: PiTui }> {
	server = await startCaptureServer();
	tui = await startPiTui({ baseUrl: server.url, extensions });
	await tui.waitForScreen(/claude-test/, 20_000);
	return { server, tui };
}

const bodies = (s: CaptureServer) => s.requests.map((r) => JSON.stringify(r.body));

describe("TUI", () => {
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
		// Sending anything to the agent collapses the panel to one dim line.
		server.enqueue({ text: "Okay.", usage: { input: 50, cacheRead: 900 } });
		tui.type("thanks");
		tui.key("Enter");
		await tui.waitForScreen(/▸ why did it pick approach B\?/);
		await server.waitForRequests(3);
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

	test("Esc aborts the agent with the panel visible", async () => {
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
		await tui.waitForScreen(/[Aa]bort/);
		hold.resolve();
	}, 60_000);

	test("handoff: ghost text, Tab accepts into the editor, Enter sends it with the side note", async () => {
		const { server, tui } = await start();
		server.enqueue({ text: "Using approach B.", usage: { input: 50, cacheWrite: 900 } });
		tui.type("pick an approach");
		tui.key("Enter");
		await tui.waitForScreen(/Using approach B\./);
		server.enqueue({ text: "route: side\nA is safer here.\nhandoff: switch to approach A", usage: { input: 10, cacheRead: 900 } });
		tui.type("/aside is B right?");
		tui.key("Enter");
		await tui.waitForScreen(/⇥ switch to approach A/);
		tui.key("Tab");
		await sleep(300);
		const screen = tui.screen();
		expect(screen).not.toMatch(/⇥ switch to approach A/);
		expect(screen).toMatch(/^switch to approach A\s*$/m);
		server.enqueue({ text: "Switching.", usage: { input: 50, cacheRead: 900 } });
		const before = server.requests.length;
		tui.key("Enter");
		await server.waitForRequests(before + 1);
		const body = JSON.stringify(server.requests[before]!.body);
		expect(body).toContain("switch to approach A");
		expect(body).toContain("Side note the user brought back");
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

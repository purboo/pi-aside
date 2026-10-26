// Offline integration: real Pi 1.3.0 in RPC mode, pi-aside loaded, a capture server for the provider.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { postInbox } from "../src/promotion.ts";
import { join, resolve } from "node:path";
import { extendsList, splitList, strip } from "../src/payload.ts";
import { type CaptureServer, startCaptureServer } from "./harness/capture.ts";
import { type ApiName, PROVIDERS, type PiRpc, startPi } from "./harness/pi.ts";

const ROOT = resolve(import.meta.dir, "..");
const ASIDE = join(ROOT, "src/index.ts");
const PROBE = join(ROOT, "test/fixtures/probe.ts");

let server: CaptureServer | undefined;
let pi: PiRpc | undefined;

afterEach(async () => {
	await pi?.close();
	await server?.close();
	pi = undefined;
	server = undefined;
});

interface Done {
	tier: string;
	reason?: string;
	read: number;
	written: number;
	predicted?: number;
	answer: string;
	error?: string;
	effort?: string;
	aborted: boolean;
}

async function asideDone(p: PiRpc, skip = 0): Promise<Done> {
	const line = await p.waitForNotify("ASIDE_DONE ", skip, 30_000);
	return JSON.parse(line.slice("ASIDE_DONE ".length));
}

const LIST: Record<ApiName, string> = { anthropic: "messages", responses: "input", completions: "messages" };

/** E with every effort set to `level`: the aside's own trailing configuration (fork.ts `asideLevel`). */
function withEffort(config: unknown[], level: string): unknown {
	return JSON.parse(JSON.stringify(config).replace(/"effort":"[a-z]+"/g, `"effort":"${level}"`));
}

function expectExtends(api: ApiName, aside: Record<string, unknown>, main: Record<string, unknown>, effort?: string) {
	const apiId = PROVIDERS[api].api;
	const a = splitList(apiId, aside)!;
	const m = splitList(apiId, main)!;
	expect(extendsList(a.core, m.core)).toBe(true);
	if (effort) {
		expect(m.config.length).toBeGreaterThan(0);
		expect(strip(a.config)).toEqual(strip(withEffort(m.config, effort)));
		expect(JSON.stringify(m.config)).not.toContain(`"effort":"${effort}"`);
	} else {
		expect(strip(a.config)).toEqual(strip(m.config));
	}
	for (const key of new Set([...Object.keys(aside), ...Object.keys(main)])) {
		if (key === LIST[api]) continue;
		expect([key, strip(aside[key])]).toEqual([key, strip(main[key])]);
	}
}

for (const api of ["anthropic", "responses", "completions"] as ApiName[]) {
	describe(`${api}`, () => {
		test("idle aside is exact: extends the main request, same top-level fields, no hooks, one usage entry", async () => {
			server = await startCaptureServer();
			pi = await startPi({ baseUrl: server.url, api, extensions: [PROBE, ASIDE], env: { PROBE_STICKY: "1" } });
			server.enqueue({ text: "Hello from the main agent.", usage: { input: 50, cacheWrite: 1000, output: 7 } });
			await pi.prompt("hello there");
			await pi.waitForAgentEnd(1);
			await pi.prompt("/probe");
			const before = JSON.parse((await pi.waitForNotify("PROBE ", 0)).slice(6));

			server.enqueue({ text: "route: side\nIt said hello.", usage: { input: 20, cacheRead: 1000, output: 6 } });
			await pi.prompt("/aside what did you say?");
			const done = await asideDone(pi);
			expect(done.error).toBeUndefined();
			expect(done.tier).toBe("exact");
			expect(done.answer).toBe("It said hello.");
			expect(server.requests.length).toBe(2);
			const [main, aside] = server.requests;
			expectExtends(api, aside!.body, main!.body);
			expect(aside!.path).toBe(main!.path);
			// Credential and headers follow the main request's, sticky routing field included.
			for (const name of ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "user-agent"]) {
				expect([name, aside!.headers[name]]).toEqual([name, main!.headers[name]]);
			}
			const text = JSON.stringify(aside!.body);
			expect(text).toContain("what did you say?");
			expect(text).toContain("sticky-");

			await pi.prompt("/probe");
			const after = JSON.parse((await pi.waitForNotify("PROBE ", 1)).slice(6));
			expect(after).toEqual(before);

			await pi.waitFor(() => pi!.sessionEntries().filter((e) => e.type === "usage" && e.kind === "aside").length === 1 || undefined, 5000, "usage entry");
			const entry = pi.sessionEntries().find((e) => e.type === "usage" && e.kind === "aside")!;
			expect(String(entry.note)).toContain("tier=exact");
		}, 60_000);
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const CASES: Array<{ api: ApiName; model?: string; thinking?: string }> = [
	{ api: "anthropic" },
	{ api: "anthropic", model: "claude-effort", thinking: "high" },
	{ api: "responses", model: "gpt-effort", thinking: "high" },
	{ api: "completions" },
];

for (const c of CASES) {
	const label = `${c.api}${c.model ? `/${c.model}` : ""}`;
	describe(`${label} concurrent`, () => {
		test("asked while the main reply streams: waits for readiness, extends the observed request, exact", async () => {
			server = await startCaptureServer();
			pi = await startPi({ baseUrl: server.url, api: c.api, model: c.model, thinking: c.thinking, extensions: [PROBE, ASIDE] });
			const hold = deferred();
			let releasedAt = 0;
			server.enqueue({ text: "One two three four five six.", chunks: 6, delayMs: 150, hold: hold.promise, usage: { input: 40, cacheWrite: 900 } });
			await pi.prompt("count to six");
			await server.waitForRequests(1);
			server.enqueue({ text: "route: side\nIt is counting.", usage: { input: 20, cacheRead: 900 } });
			await pi.prompt("/aside what is it doing?");
			await new Promise((r) => setTimeout(r, 400));
			expect(server.requests.length).toBe(1);
			releasedAt = Date.now();
			hold.resolve();
			const done = await asideDone(pi);
			expect(done.error).toBeUndefined();
			expect(done.tier).toBe("exact");
			const [main, aside] = server.requests;
			expect(aside!.at).toBeGreaterThanOrEqual(releasedAt);
			// Models that take effort changes mid-conversation answer at a low effort: only E differs.
			expectExtends(c.api, aside!.body, main!.body, c.model ? "low" : undefined);
			expect(done.effort).toBe(c.model ? "low" : undefined);
			expect(JSON.stringify(aside!.body)).not.toContain("One two");
			await pi.waitForAgentEnd(1);
			// The usage entry waits for idle.
			await pi.waitFor(() => pi!.sessionEntries().some((e) => e.type === "usage" && e.kind === "aside") || undefined, 5000, "usage entry");
			const entries = pi.sessionEntries();
			const usageIndex = entries.findIndex((e) => e.type === "usage" && e.kind === "aside");
			const replyIndex = entries.findIndex((e) => e.type === "message" && (e.message as { role: string }).role === "assistant");
			expect(usageIndex).toBeGreaterThan(replyIndex);
		}, 60_000);
	});
}

describe("tool rounds", () => {
	test("after a main tool round the aside is exact and sees the tool result", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE, ASIDE] });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(pi.cwd, "notes.txt"), "the secret word is pumpkin\n");
		server.enqueue(
			{ toolCalls: [{ id: "toolu_a", name: "read", arguments: { path: "notes.txt" } }], usage: { input: 40, cacheWrite: 800 } },
			{ text: "I read the notes.", usage: { input: 30, cacheRead: 800, cacheWrite: 100 } },
		);
		await pi.prompt("read notes.txt");
		await pi.waitForAgentEnd(1);
		server.enqueue({ text: "route: side\nThe word is pumpkin.", usage: { input: 10, cacheRead: 900 } });
		await pi.prompt("/aside what is the secret word?");
		const done = await asideDone(pi);
		expect(done.tier).toBe("exact");
		const aside = server.requests[2]!;
		expectExtends("anthropic", aside.body, server.requests[1]!.body);
		expect(JSON.stringify(aside.body)).toContain("pumpkin");
	}, 60_000);

	test("asked while a main tool runs: the pending call gets a still-running result, exact", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE, ASIDE] });
		server.enqueue(
			{ toolCalls: [{ id: "toolu_b", name: "bash", arguments: { command: "sleep 2; echo finished" } }], usage: { input: 40, cacheWrite: 800 } },
			{ text: "Done sleeping.", usage: { input: 30, cacheRead: 800 } },
		);
		await pi.prompt("sleep a bit");
		await pi.waitFor(() => pi!.events.some((e) => e.type === "tool_execution_start") || undefined, 10_000, "tool start");
		server.enqueue({ text: "route: side\nIt is sleeping.", usage: { input: 10, cacheRead: 800 } });
		await pi.prompt("/aside what is it running?");
		const done = await asideDone(pi);
		expect(done.tier).toBe("exact");
		const aside = server.requests[1]!;
		expectExtends("anthropic", aside.body, server.requests[0]!.body);
		expect(JSON.stringify(aside.body)).toContain("still running");
		await pi.waitForAgentEnd(1);
	}, 60_000);

	test("the aside runs Pi's built-in tools and refuses others; continuation requests stay exact", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE, ASIDE] });
		const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
		writeFileSync(join(pi.cwd, "a.txt"), "alpha content\n");
		server.enqueue({ text: "Hi.", usage: { input: 40, cacheWrite: 800 } });
		await pi.prompt("hi");
		await pi.waitForAgentEnd(1);
		server.enqueue(
			{
				text: "route: side\nLet me look.",
				toolCalls: [
					{ id: "toolu_r", name: "read", arguments: { path: "a.txt" } },
					{ id: "toolu_b", name: "bash", arguments: { command: "echo made > made.txt" } },
					{ id: "toolu_w", name: "write", arguments: { path: "notes/feedback.md", content: "# Feedback\n" } },
					{ id: "toolu_s", name: "subagents", arguments: { action: "run" } },
				],
				usage: { input: 10, cacheRead: 800 },
			},
			{ text: "It says alpha; I wrote the note.", usage: { input: 10, cacheRead: 850 } },
		);
		await pi.prompt("/aside what is in a.txt? write a note too");
		const done = await asideDone(pi);
		expect(done.error).toBeUndefined();
		expect(done.tier).toBe("exact");
		expect(done.answer).toContain("It says alpha");
		expect(readFileSync(join(pi.cwd, "made.txt"), "utf8")).toBe("made\n");
		expect(readFileSync(join(pi.cwd, "notes/feedback.md"), "utf8")).toBe("# Feedback\n");
		expect(existsSync(join(pi.cwd, "a.txt"))).toBe(true);
		const second = server.requests[2]!;
		const text = JSON.stringify(second.body);
		expect(text).toContain("alpha content");
		expect(text).toContain("subagents is not available in an aside");
		expectExtends("anthropic", second.body, server.requests[0]!.body);
		// The main session never sees the aside's tool calls.
		expect(JSON.stringify(pi.sessionEntries())).not.toContain("toolu_b");
		await pi.waitFor(() => pi!.sessionEntries().filter((e) => e.type === "usage" && e.kind === "aside").length === 2 || undefined, 5000, "two usage entries");
	}, 60_000);
});

describe("packaging", () => {
	test("loads as an installed package (settings.packages), after the packages installed before it", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE], settings: { packages: [ROOT] } });
		server.enqueue({ text: "Hello.", usage: { input: 40, cacheWrite: 800 } });
		await pi.prompt("hello");
		await pi.waitForAgentEnd(1);
		server.enqueue({ text: "route: side\nPackaged answer.", usage: { input: 10, cacheRead: 800 } });
		await pi.prompt("/aside does it load?");
		const done = await asideDone(pi);
		expect(done.tier).toBe("exact");
		expect(done.answer).toBe("Packaged answer.");
	}, 60_000);
});

describe("handlers and fallbacks", () => {
	test("a payload replacement by an extension loaded after pi-aside reaches the aside (final-payload tap)", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [ASIDE, PROBE], env: { PROBE_REPLACE: "1" } });
		server.enqueue({ text: "Hello.", usage: { input: 40, cacheWrite: 800 } });
		await pi.prompt("hello");
		await pi.waitForAgentEnd(1);
		server.enqueue({ text: "route: side\nAnswer.", usage: { input: 10, cacheRead: 800 } });
		await pi.prompt("/aside anything?");
		const done = await asideDone(pi);
		expect(done.tier).toBe("exact");
		const [main, aside] = server.requests;
		expect(main!.body.metadata).toEqual({ user_id: "late-replacement" });
		expect(aside!.body.metadata).toEqual({ user_id: "late-replacement" });
		expectExtends("anthropic", aside!.body, main!.body);
	}, 60_000);

	test("a handler that rewrites the transcript fails C1: rebuilt, fresh session id", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "responses", extensions: [PROBE, ASIDE], env: { PROBE_REWRITE: "1" } });
		server.enqueue({ text: "Hello.", usage: { input: 40 } });
		await pi.prompt("hello");
		await pi.waitForAgentEnd(1);
		server.enqueue({ text: "route: side\nAnswer.", usage: { input: 50 } });
		await pi.prompt("/aside anything?");
		const done = await asideDone(pi);
		expect(done.tier).toBe("rebuilt");
		expect(done.reason).toMatch(/changed `input`|does not reproduce/);
		const [main, aside] = server.requests;
		expect(aside!.body.prompt_cache_key).not.toBe(main!.body.prompt_cache_key);
	}, 60_000);

	test("no main request yet: rebuilt with the session's system prompt", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE, ASIDE] });
		server.enqueue({ text: "route: side\nNothing happened yet.", usage: { input: 50 } });
		await pi.prompt("/aside what happened?");
		const done = await asideDone(pi);
		expect(done.tier).toBe("rebuilt");
		expect(done.answer).toBe("Nothing happened yet.");
		expect(JSON.stringify(server.requests[0]!.body.system)).toContain("pi");
	}, 60_000);

	test("after a compaction the warm request is still the fork: exact, no summary, the old transcript", async () => {
		server = await startCaptureServer();
		// Keep almost nothing, so that a two-turn session has something to compact.
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE, ASIDE], settings: { compaction: { keepRecentTokens: 1 } } });
		server.enqueue({ text: "Noted.", usage: { input: 40, cacheWrite: 800 } });
		await pi.prompt("the project is called Ladder");
		await pi.waitForAgentEnd(1);
		server.enqueue({ text: "The plan has three steps.", usage: { input: 40, cacheRead: 800, cacheWrite: 100 } });
		await pi.prompt("make a plan");
		await pi.waitForAgentEnd(2);
		// Pi summarizes the history and the split turn's prefix separately: two requests.
		server.enqueue({ text: "COMPACTION-SUMMARY: a plan was made.", usage: { input: 900, output: 20 } });
		server.enqueue({ text: "COMPACTION-SUMMARY: the turn asked for a plan.", usage: { input: 900, output: 20 } });
		const compacted = await pi.send({ type: "compact" }, 30_000);
		expect([compacted.success, compacted.error]).toEqual([true, undefined]);
		const n = server.requests.length;
		expect(n).toBe(4);
		server.enqueue({ text: "route: side\nThree steps.", usage: { input: 10, cacheRead: 900 } });
		await pi.prompt("/aside how many steps?");
		const done = await asideDone(pi);
		expect(done.error).toBeUndefined();
		expect(done.tier).toBe("exact");
		const main = server.requests[1]!;
		const aside = server.requests[n]!;
		expectExtends("anthropic", aside.body, main.body);
		const text = JSON.stringify(aside.body);
		expect(text).not.toContain("COMPACTION-SUMMARY");
		expect(text).toContain("the project is called Ladder");
		// The compaction is real: the main session's next request starts from the summary.
		server.enqueue({ text: "Step one.", usage: { input: 30, cacheWrite: 300 } });
		await pi.prompt("go on");
		await pi.waitForAgentEnd(3);
		const next = JSON.stringify(server.requests[n + 1]!.body);
		expect(next).toContain("COMPACTION-SUMMARY");
		expect(next).not.toContain("the project is called Ladder");
	}, 60_000);

	test("a follow-up continues the fork; after the main session moves it forks again", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE, ASIDE] });
		server.enqueue({ text: "First reply.", usage: { input: 40, cacheWrite: 800 } });
		await pi.prompt("first");
		await pi.waitForAgentEnd(1);
		server.enqueue({ text: "route: side\nAnswer one.", usage: { input: 10, cacheRead: 800 } });
		await pi.prompt("/aside question one?");
		await asideDone(pi, 0);
		server.enqueue({ text: "route: side\nAnswer two.", usage: { input: 10, cacheRead: 850 } });
		await pi.prompt("/aside question two?");
		const two = await asideDone(pi, 1);
		expect(two.tier).toBe("exact");
		const req3 = server.requests[2]!;
		expect(JSON.stringify(req3.body)).toContain("Answer one.");
		expectExtends("anthropic", req3.body, server.requests[1]!.body);
		// The main session moves on.
		server.enqueue({ text: "Second reply.", usage: { input: 40, cacheRead: 800, cacheWrite: 50 } });
		await pi.prompt("second");
		await pi.waitForAgentEnd(2);
		server.enqueue({ text: "route: side\nAnswer three.", usage: { input: 10, cacheRead: 900 } });
		await pi.prompt("/aside question three?");
		const three = await asideDone(pi, 2);
		expect(three.tier).toBe("exact");
		const req5 = server.requests[4]!;
		const body = JSON.stringify(req5.body);
		expect(body).toContain("Second reply.");
		expect(body).toContain("Earlier in this side conversation");
		expectExtends("anthropic", req5.body, server.requests[3]!.body);
	}, 60_000);
});


describe("0.5.0 relays, continuation and promotion", () => {
	test("a promoted Pi's normal main-agent tell_agent tool writes to its parent inbox", async () => {
		const inbox = mkdtempSync(join(tmpdir(), "aside-child-inbox-"));
		try {
			server = await startCaptureServer();
			pi = await startPi({ baseUrl: server.url, extensions: [ASIDE], env: { PI_ASIDE_PARENT: inbox, PI_ASIDE_NAME: "disk-cleanup", PI_ASIDE_HINT: "Tell the agent when done" } });
			server.enqueue(
				{ toolCalls: [{ name: "tell_agent", arguments: { message: "The user asks me to report that disk cleanup is complete." } }] },
				{ text: "Sent to the parent." },
			);
			// The parent Pi is listening (this test process stands in for it).
			writeFileSync(join(inbox, "owner"), String(process.pid));
			await pi.prompt("Tell the main agent that cleanup is complete.");
			await pi.waitForAgentEnd();
			const files = readdirSync(inbox).filter(name => name.endsWith(".json"));
			expect(files).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(inbox, files[0]!), "utf8"))).toEqual({ name: "disk-cleanup", message: "The user asks me to report that disk cleanup is complete.", sentAt: expect.any(Number) });
			expect(JSON.stringify(server.requests.at(-1)!.body)).toContain("Delivered to the parent inbox.");
			// The parent Pi exited: the message is kept, and the window must not claim delivery.
			rmSync(join(inbox, "owner"));
			server.enqueue(
				{ toolCalls: [{ name: "tell_agent", arguments: { message: "Second note." } }] },
				{ text: "Queued." },
			);
			await pi.prompt("Tell it one more thing.");
			await pi.waitFor(() => server!.requests.length >= 4 && readdirSync(inbox).filter(name => name.endsWith(".json")).length === 2 ? true : undefined);
			await pi.waitForAgentEnd();
			expect(readdirSync(inbox).filter(name => name.endsWith(".json"))).toHaveLength(2);
			const last = JSON.stringify(server.requests.at(-1)!.body);
			expect(last).toContain("Queued, not delivered yet");
			expect(last).toContain("pi --session ");
		} finally { rmSync(inbox, { recursive: true, force: true }); }
	}, 20_000);

	test("models without native tool additions still fork on the main cache: the aside declares no tools", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, model: "claude-legacy", extensions: [ASIDE, PROBE] });
		server.enqueue({ text: "Main ready." });
		await pi.prompt("start"); await pi.waitForAgentEnd();
		server.enqueue({ text: "route: side\nAnswer." });
		await pi.prompt("/aside explain");
		const done = await asideDone(pi);
		expect(done.error).toBeUndefined();
		expect(done.tier).not.toBe("rebuilt");
		expect(String(done.reason ?? "")).not.toContain("tools");
		const side = server.requests.at(-1)!.body as { tools?: unknown };
		const main = server.requests.at(-2)!.body as { tools?: unknown };
		expect(JSON.stringify(side.tools)).toBe(JSON.stringify(main.tools));
		expect(JSON.stringify(side)).not.toContain("tool_addition");
	}, 20_000);

	test("a move request waits for the current aside tool to finish and retains its result", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, extensions: [ASIDE, PROBE], env: { TMUX: "", TMUX_PANE: "" } });
		server.enqueue({ text: "Main ready." });
		await pi.prompt("start"); await pi.waitForAgentEnd();
		server.enqueue(
			{ text: "route: side\n", toolCalls: [{ name: "bash", arguments: { command: "echo started > progress; sleep 0.5; echo finished > progress" } }, { name: "bash", arguments: { command: "echo should-not-run > after-move" } }] },
			{ text: "route: side\nMoving it.\nmove: disk-cleanup" },
		);
		await pi.prompt("/aside do an independent task");
		await pi.waitFor(() => existsSync(join(pi!.cwd, "progress")) ? true : undefined);
		await pi.prompt("/aside move this to its own window");
		expect((await asideDone(pi)).error).toBeUndefined();
		expect(readFileSync(join(pi.cwd, "progress"), "utf8").trim()).toBe("finished");
		expect(existsSync(join(pi.cwd, "after-move"))).toBe(false);
		const sessionRoot = pi.sessionDir; // promoted next to the main session
		const file = readdirSync(sessionRoot, { recursive: true }).find(file => String(file).endsWith(".jsonl") && readFileSync(join(sessionRoot, String(file)), "utf8").includes('"name":"aside:'))!;
		const child = SessionManager.open(join(sessionRoot, String(file)));
		expect(JSON.stringify(child.buildSessionContext())).toContain("finished");
	}, 20_000);

	test("tell_agent is available with no main tools and delivers a user-side instruction without a bridge", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, extensions: [ASIDE, PROBE], args: ["--tools", ""] });
		let side = 0;
		server.respond(request => JSON.stringify(request.body).includes("<aside>")
			? ++side === 1 ? { text: "route: side\nPassed on.\ntell: The user asks you to retain all tests; we found they cover routing." } : { text: "Delivered." }
			: { text: "I will retain the tests." });
		await pi.prompt("/aside tell the agent what we found");
		expect((await asideDone(pi)).error).toBeUndefined();
		await pi.waitForAgentEnd();
		const entries = pi.sessionEntries().filter(entry => entry.type === "custom_message");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.customType).toBe("aside");
		expect(entries[0]!.display).toBe(true);
		expect(entries[0]!.content).toContain("Relayed from the user's aside conversation");
		expect(JSON.stringify(entries)).toContain("retain all tests");
		expect(JSON.stringify(server.requests.find(request => !JSON.stringify(request.body).includes("<aside>"))!.body)).toContain("retain all tests");
		expect(pi.events.filter(event => event.type === "tool_execution_start")).toHaveLength(0);
	}, 20_000);

	test("24th tool response is refused, one summary request follows, and continue gets fresh rounds", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, extensions: [ASIDE, PROBE] });
		server.enqueue({ text: "Main ready." });
		await pi.prompt("start"); await pi.waitForAgentEnd();
		let rounds = 0;
		server.respond(() => {
			rounds++;
			if (rounds <= 24) return { text: "route: side\n", toolCalls: [{ name: rounds === 24 ? "write" : "read", arguments: rounds === 24 ? { path: "must-not-run.txt", content: "no" } : { path: "missing.txt" } }] };
			return { text: rounds === 25 ? "✓ Checked what was possible.\n… More remains." : "Continued." };
		});
		await pi.prompt("/aside inspect repeatedly");
		const done = await asideDone(pi);
		expect(done.error).toBeUndefined();
		expect(rounds).toBe(25);
		expect(existsSync(join(pi.cwd, "must-not-run.txt"))).toBe(false);
		expect(JSON.stringify(server.requests.at(-1)!.body)).toContain("Not run: round limit reached. Summarize what is done and what is left, then stop.");
		expect(done.answer).toContain("More remains.");
		await pi.prompt("/aside continue");
		expect((await asideDone(pi, 1)).answer).toContain("Continued.");
		expect(rounds).toBe(26);
	}, 25_000);

	test("cross-process inbox delivery uses the promoted window name and removes the file", async () => {
		server = await startCaptureServer();
		// A stand-in tmux: the inbox exists only once a move-out opened a window.
		const bin = mkdtempSync(join(tmpdir(), "pi-aside-tmux-"));
		// Like real tmux, new-window refuses a pane target ("can't specify pane here").
		writeFileSync(join(bin, "tmux"), [
			"#!/bin/sh",
			"case \"$1\" in",
			"  display-message) echo @1 ;;",
			"  new-window) [ \"$4\" = @1 ] || { echo \"can't specify pane here\" >&2; exit 1; }; printf '%s\\n' \"$*\" >> \"$0.log\"; printf '@9\\t3\\n' ;;",
			"esac",
		].join("\n"), { mode: 0o755 });
		pi = await startPi({ baseUrl: server.url, extensions: [ASIDE], env: { TMUX: "/tmp/fake,1,0", TMUX_PANE: "%1", PATH: `${bin}:${process.env.PATH}` } });
		const root = join(pi.agentDir, "aside-inbox");
		expect(existsSync(root)).toBe(false);
		server.enqueue({ text: "route: side\nmove: disk-cleanup" });
		await pi.prompt("/aside move this out");
		server.enqueue({ text: "Received the child's findings." });
		await pi.waitFor(() => existsSync(root) && readdirSync(root).length ? true : undefined);
		const inbox = join(root, readdirSync(root)[0]!);
		postInbox(inbox, { name: "disk-cleanup", message: "Disk cleanup finished; 9 GB recovered." });
		await pi.waitForAgentEnd();
		// The session directory now also holds the promoted session: search every file.
		const dir = pi!.sessionDir;
		const entries = readdirSync(dir, { recursive: true }).filter(file => String(file).endsWith(".jsonl"))
			.flatMap(file => readFileSync(join(dir, String(file)), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
		expect(entries.find(entry => entry.customType === "aside-window")?.data).toMatchObject({ name: "disk-cleanup", index: "3", target: "@9" });
		const relay = entries.find(entry => entry.customType === "aside")!;
		expect((relay.details as { name: string }).name).toBe("aside:disk-cleanup");
		expect(JSON.stringify(server.requests.at(-1)!.body)).toContain("9 GB recovered");
		expect(readdirSync(inbox).filter(name => name.endsWith(".json"))).toEqual([]);
		// A live Pi marks the inbox it reads, so windows can tell "delivered" from "queued".
		expect(readFileSync(join(inbox, "owner"), "utf8")).toMatch(/^\d+$/);
		// Finished work moves without a prompt; a move that cut tool calls short goes on with "continue".
		expect(readFileSync(join(bin, "tmux.log"), "utf8")).not.toContain(" continue");
		server.enqueue({ text: "route: side\nmove: second-task", toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] });
		await pi.prompt("/aside move this out now");
		await pi.waitFor(() => readFileSync(join(bin, "tmux.log"), "utf8").includes("second-task") || undefined);
		expect(readFileSync(join(bin, "tmux.log"), "utf8").trim().split("\n").at(-1)).toEndWith(" continue");
	}, 20_000);

	test("non-tmux move_out creates a resumable named session and shows its launch command", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, extensions: [ASIDE, PROBE], env: { TMUX: "", TMUX_PANE: "" } });
		server.enqueue({ text: "route: side\nMoving it.\nmove: disk-cleanup | Tell the agent when done" });
		await pi.prompt("/aside move this to its own window");
		const done = await asideDone(pi);
		expect(done.error).toBeUndefined();
		expect(done.answer).toContain("pi --session");
		expect(done.answer).toContain("paste it in any terminal");
		const sessionRoot = pi.sessionDir; // promoted next to the main session
		const files = readdirSync(sessionRoot, { recursive: true }).filter(file => String(file).endsWith(".jsonl") && readFileSync(join(sessionRoot, String(file)), "utf8").includes('"name":"aside:'));
		expect(files).toHaveLength(1);
		const child = SessionManager.open(join(sessionRoot, String(files[0])));
		expect(child.getSessionName()).toBe("aside:disk-cleanup");
		expect(JSON.stringify(child.buildSessionContext())).toContain("move this to its own window");
		expect(readFileSync(child.getSessionFile()!, "utf8")).not.toContain("<aside>");
	}, 20_000);
});

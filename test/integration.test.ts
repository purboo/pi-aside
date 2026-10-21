// Offline integration: real Pi 1.3.0 in RPC mode, pi-aside loaded, a capture server for the provider.

import { afterEach, describe, expect, test } from "bun:test";
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

	test("the aside runs read-only tools and refuses others; continuation requests stay exact", async () => {
		server = await startCaptureServer();
		pi = await startPi({ baseUrl: server.url, api: "anthropic", extensions: [PROBE, ASIDE] });
		const { writeFileSync, existsSync } = await import("node:fs");
		writeFileSync(join(pi.cwd, "a.txt"), "alpha content\n");
		server.enqueue({ text: "Hi.", usage: { input: 40, cacheWrite: 800 } });
		await pi.prompt("hi");
		await pi.waitForAgentEnd(1);
		server.enqueue(
			{
				text: "route: side\nLet me look.",
				toolCalls: [
					{ id: "toolu_r", name: "read", arguments: { path: "a.txt" } },
					{ id: "toolu_w", name: "bash", arguments: { command: "touch pwned.txt" } },
				],
				usage: { input: 10, cacheRead: 800 },
			},
			{ text: "It says alpha.", usage: { input: 10, cacheRead: 850 } },
		);
		await pi.prompt("/aside what is in a.txt?");
		const done = await asideDone(pi);
		expect(done.error).toBeUndefined();
		expect(done.tier).toBe("exact");
		expect(done.answer).toContain("It says alpha.");
		expect(existsSync(join(pi.cwd, "pwned.txt"))).toBe(false);
		const second = server.requests[2]!;
		const text = JSON.stringify(second.body);
		expect(text).toContain("alpha content");
		expect(text).toContain("not available in an aside");
		expectExtends("anthropic", second.body, server.requests[0]!.body);
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

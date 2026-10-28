import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { extendsList, splitList } from "../src/payload.ts";
import { type CaptureServer, startCaptureServer } from "./harness/capture.ts";
import { type ApiName, type PiRpc, PROVIDERS, startPi } from "./harness/pi.ts";

let server: CaptureServer | undefined;
let pi: PiRpc | undefined;
afterEach(async () => { await pi?.close(); await server?.close(); pi = undefined; server = undefined; });

const scenarios = (["anthropic", "responses", "completions"] as ApiName[])
	.flatMap(api => [7000, 1000].map(mainInput => ({ api, mainInput })));
for (const { api, mainInput } of scenarios) {
	test(`${api}: context-based output ${mainInput === 7000 ? "decrease" : "increase"} keeps an exact fork across questions and tool rounds`, async () => {
		server = await startCaptureServer();
		pi = await startPi({
			baseUrl: server.url, api, thinking: "off",
			modelLimits: { contextWindow: 16384, maxTokens: 14000 },
			extensions: [resolve(import.meta.dir, "fixtures/probe.ts"), resolve(import.meta.dir, "../src/index.ts")],
		});
		server.enqueue({ text: "Main ready.", usage: { input: mainInput, output: 5 } });
		await pi.prompt(mainInput === 1000 ? `start ${"x".repeat(20000)}` : "start");
		await pi.waitForAgentEnd();
		server.enqueue(
			{ text: "Checking.", toolCalls: [{ id: "read-1", name: "read", arguments: { path: "missing.txt" } }], usage: { input: 100, cacheRead: 7500 } },
			{ text: "Checked.", usage: { input: 100, cacheRead: 8000 } },
		);
		await pi.prompt("/aside check a file");
		const done = JSON.parse((await pi.waitForNotify("ASIDE_DONE ")).slice("ASIDE_DONE ".length));
		expect(done.error).toBeUndefined();
		expect(done.tier).toBe("exact");
		expect(server.requests).toHaveLength(3);
		const main = server.requests[0]!.body;
		const field = api === "responses" ? "max_output_tokens" : "max_tokens" in main ? "max_tokens" : "max_completion_tokens";
		if (mainInput === 7000) expect(server.requests[1]!.body[field]).toBeLessThan(main[field] as number);
		else expect(server.requests[1]!.body[field]).toBeGreaterThan(main[field] as number);
		for (const aside of server.requests.slice(1)) {
			expect(aside.body[field]).toBeGreaterThan(16);
			expect(extendsList(splitList(PROVIDERS[api].api, aside.body)!.core, splitList(PROVIDERS[api].api, main)!.core)).toBe(true);
			for (const key of Object.keys(main).filter(key => ![field, "input", "messages"].includes(key))) {
				expect([key, aside.body[key]]).toEqual([key, main[key]]);
			}
		}
		server.enqueue({ text: "Follow-up answer.", usage: { input: 100, cacheRead: 8500 } });
		await pi.prompt("/aside follow up");
		const follow = JSON.parse((await pi.waitForNotify("ASIDE_DONE ", 1)).slice("ASIDE_DONE ".length));
		expect(follow.error).toBeUndefined();
		expect(follow.tier).toBe("exact");
		expect(server.requests).toHaveLength(4);
		expect(server.requests[3]!.body[field]).toBeLessThan(server.requests[2]!.body[field] as number);
	}, 30000);
}

import { expect, test } from "bun:test";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
// Test-only import: the installed extension must not depend on this subpath being available.
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { contextOutputLimit } from "../src/output-budget.ts";

function assistant(timestamp = 20, totalTokens = 7000, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant", timestamp, stopReason, api: "openai-completions", provider: "test", model: "test",
		content: [{ type: "text", text: "Answer." }, { type: "thinking", thinking: "Reasoning." }, { type: "toolCall", id: "call", name: "read", arguments: { path: "example.txt" } }],
		usage: { input: 1000, output: 5, cacheRead: 2000, cacheWrite: 100, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
const system: Message = {
	role: "system", timestamp: 0, content: [{ type: "text", text: "System." }, { type: "text", text: "Second block." }],
	sections: { first: "First section.", removed: null },
	toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
	toolsRemoved: [{ name: "write" }],
};
const user: Message = { role: "user", timestamp: 10, content: "Question." };
const image: Message = { role: "user", timestamp: 30, content: [{ type: "text", text: "Image." }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
const result: Message = { role: "toolResult", timestamp: 40, toolCallId: "call", toolName: "read", isError: false, content: [{ type: "text", text: "File content." }] };
const emptyUsage = assistant();
emptyUsage.usage = { ...emptyUsage.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

const cases: Array<{ name: string; messages: Message[] }> = [
	{ name: "empty context", messages: [] },
	{ name: "text estimate", messages: [user] },
	{ name: "system sections and tool additions/removals", messages: [system, user] },
	{ name: "images", messages: [system, image] },
	{ name: "measured total usage", messages: [system, user, assistant(), image, result] },
	{ name: "usage component fallback", messages: [user, assistant(20, 0), result] },
	{ name: "failed usage ignored", messages: [user, assistant(20, 7000, "error"), result] },
	{ name: "aborted usage ignored", messages: [user, assistant(20, 7000, "aborted"), result] },
	{ name: "all-zero usage ignored", messages: [user, emptyUsage, result] },
	{ name: "usage invalidated by a newer prefix", messages: [{ ...system, timestamp: 100 }, user, assistant()] },
	{ name: "last valid usage retained after stale responses", messages: [user, assistant(), { ...system, timestamp: 100 }, assistant(50, 5000), result] },
	{ name: "newer valid usage replaces previous usage", messages: [user, assistant(), image, result, assistant(60, 9000)] },
];
for (const { name, messages } of cases) {
	test(`portable output limit matches Pi: ${name}`, () => {
		const context = { messages } as TranscriptContext;
		for (const model of [
			{ contextWindow: 16384, maxTokens: 14000 },
			{ contextWindow: 0, maxTokens: 14000 },
			{ contextWindow: -1, maxTokens: 14000 },
			{ contextWindow: 4100, maxTokens: 500 },
			{ contextWindow: 200000, maxTokens: 1000 },
		]) {
			expect(contextOutputLimit(model, context)).toBe(clampMaxTokensToContext(model as Parameters<typeof clampMaxTokensToContext>[0], context, model.maxTokens));
		}
	});
}

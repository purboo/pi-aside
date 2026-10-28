// Pi 1.4's context-output calculation, kept local because extension loaders expose only selected pi-ai modules.
// Parity tests compare this with pi-ai's helper; runtime imports use the extension-visible root entry only.
import { getSystemMessageText, type Message, type TranscriptContext } from "@earendil-works/pi-ai";

const CHARS_PER_TOKEN = 3.5;
const IMAGE_CHARS = 4800;
const CONTEXT_SAFETY_TOKENS = 4096;

function stringify(value: unknown): string {
	try { return JSON.stringify(value) ?? "undefined"; }
	catch { return "[unserializable]"; }
}

function textTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageTokens(message: Message): number {
	if (message.role === "system") {
		return textTokens(getSystemMessageText(message))
			+ (message.toolsAdded?.length ? textTokens(stringify(message.toolsAdded)) : 0)
			+ (message.toolsRemoved?.length ? textTokens(stringify(message.toolsRemoved)) : 0);
	}
	if (typeof message.content === "string") return textTokens(message.content);
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
		else if (block.type === "toolCall") chars += block.name.length + stringify(block.arguments).length;
		else chars += IMAGE_CHARS;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Mirror pi-ai's estimator, including measured usage and invalidation by a newer prefix message. */
function contextTokens(context: TranscriptContext): number {
	let tokens = 0;
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	for (const message of context.messages) {
		if (message.role === "assistant") {
			const usage = message.usage;
			const measured = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			if (message.timestamp >= latestPrefixTimestamp && message.stopReason !== "aborted" && message.stopReason !== "error" && measured > 0) {
				tokens = measured;
			} else {
				tokens += messageTokens(message);
			}
		} else {
			tokens += messageTokens(message);
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}
	return tokens;
}

export function contextOutputLimit(model: { contextWindow: number; maxTokens: number }, context: TranscriptContext): number {
	if (model.contextWindow <= 0) return Math.max(1, model.maxTokens);
	return Math.min(model.maxTokens, Math.max(1, model.contextWindow - contextTokens(context) - CONTEXT_SAFETY_TOKENS));
}

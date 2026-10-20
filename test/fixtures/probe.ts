// Test extension: reports pi-aside's results and counts provider hooks. Optional handler changes, selected by env:
// PROBE_STICKY=1 sets metadata.user_id / prompt_cache_key (like pi-zip), PROBE_REWRITE=1 rewrites the first message.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
	// biome-ignore lint: test code
	let ctxRef: any;
	const counts = { context: 0, headers: 0, request: 0, response: 0 };
	pi.on("session_start", (_e, ctx) => {
		ctxRef = ctx;
	});
	pi.on("context_with_system", () => {
		counts.context++;
		return undefined;
	});
	pi.on("before_provider_headers", () => {
		counts.headers++;
	});
	pi.on("before_provider_request", (event) => {
		counts.request++;
		// biome-ignore lint: test code
		const payload = event.payload as any;
		if (process.env.PROBE_STICKY === "1") {
			if (Array.isArray(payload.messages) && "max_tokens" in payload) payload.metadata = { user_id: "sticky-user-1" };
			else if (Array.isArray(payload.input)) payload.prompt_cache_key = "sticky-key-1";
			else payload.user = "sticky-user-1";
		}
		if (process.env.PROBE_REWRITE === "1") {
			const list = payload.messages ?? payload.input;
			const first = list?.find((m: { role?: string }) => m.role === "user");
			if (first) first.content = [{ type: "text", text: "rewritten by a handler" }];
		}
		return undefined;
	});
	pi.on("after_provider_response", () => {
		counts.response++;
	});
	pi.events.on("aside:done", (data) => {
		ctxRef?.ui.notify(`ASIDE_DONE ${JSON.stringify(data)}`, "info");
	});
	pi.registerCommand("probe", {
		description: "report hook counts",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`PROBE ${JSON.stringify(counts)}`, "info");
		},
	});
}

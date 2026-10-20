// Test extension: a background-work emitter (the convention of docs/ux.md §3.1). `/bg <n>` sets the pending count.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function bg(pi: ExtensionAPI): void {
	let pending = 0;
	const report = () => pi.events.emit("background-work", { source: "test-bg", pending });
	pi.events.on("background-work:query", report);
	pi.registerCommand("bg", {
		description: "set the pending background work count",
		handler: async (args) => {
			pending = Number.parseInt(args ?? "0", 10) || 0;
			report();
		},
	});
}

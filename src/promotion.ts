// Session promotion and the small file inbox shared with independent Pi windows.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { withPlaceholders } from "./fork.ts";
import { parseReply, sanitizeSuggestion } from "./reply.ts";

// Pi messages and session entries are retained losslessly, including provider metadata.
type Any = any;

export function promotionOptions(args: { name?: unknown; hint?: unknown }, number: number): { name: string; hint: string } {
	return {
		name: typeof args.name === "string" && /^[a-z]+(?:-[a-z]+){1,2}$/.test(args.name) && args.name.length <= 60 ? args.name : `aside-${number}`,
		hint: typeof args.hint === "string" ? sanitizeSuggestion(args.hint) ?? "tell the agent when you're done" : "tell the agent when you're done",
	};
}

export function uniqueName(name: string, windows: readonly string[]): string {
	let candidate = name;
	for (let n = 2; windows.includes(`aside:${candidate}`); n++) candidate = `${name}-${n}`;
	return candidate;
}

export function shellQuote(text: string): string { return `'${text.replace(/'/g, "'\\''")}'`; }

export function tmuxCommand(options: { window: string; cwd: string; file: string; name: string; hint: string; inbox: string; continue: boolean }): string[] {
	const command = `env PI_ASIDE_PARENT=${shellQuote(options.inbox)} PI_ASIDE_NAME=${shellQuote(options.name)} PI_ASIDE_HINT=${shellQuote(options.hint)} pi --session ${shellQuote(options.file)}${options.continue ? " continue" : ""}`;
	return ["new-window", "-a", "-t", options.window, "-n", `aside:${options.name}`, "-c", options.cwd, "-P", "-F", "#{window_id}\t#{window_index}", command];
}

/** Preserve the exact fork branch (including compactions/edits), then append ordinary aside messages. */
export function writePromotedSession(options: { cwd: string; branch: Any[]; history: Any[]; name: string; sessionDir?: string; parentFile?: string; relay?: boolean }): string {
	const session = SessionManager.create(options.cwd, options.sessionDir, { parentSession: options.parentFile });
	const file = session.getSessionFile()!;
	mkdirSync(session.getSessionDir(), { recursive: true });
	const header = session.getHeader()!;
	writeFileSync(file, [header, ...options.branch].map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
	const child = SessionManager.open(file);
	const context = child.buildSessionContext().messages;
	for (const placeholder of withPlaceholders(context).slice(context.length)) child.appendMessage(placeholder as Any);
	for (const original of options.history) {
		const message = structuredClone(original);
		if (message.role === "assistant") {
			message.content = message.content.flatMap((part: Any) => {
				if (part.type !== "text") return [part];
				const text = parseReply(part.text, true).body;
				return text ? [{ ...part, text }] : [];
			});
		}
		// The new window has no move_out tool: say plainly that the move happened, and where the conversation is now.
		if (message.role === "toolResult" && message.toolName === "move_out" && !message.isError) {
			message.content = [{ type: "text", text: `Moved: this conversation now continues in its own Pi window, aside:${options.name}. You are in that window, and move_out is no longer needed.${options.relay ? " To reach the original agent, use tell_agent when the user asks." : ""}` }];
		}
		child.appendMessage(message);
	}
	child.appendSessionInfo(`aside:${options.name}`);
	return file;
}

export interface InboxMessage { message: string; name: string }
export function inboxPath(sessionId: string, pid = process.pid): string {
	return join(getAgentDir(), "aside-inbox", `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${pid}`);
}
export function postInbox(dir: string, value: InboxMessage): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `${randomUUID()}.tmp`);
	writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
	renameSync(temp, temp.replace(/\.tmp$/, ".json"));
}

/** Atomic child writes; synchronous scanning prevents duplicate delivery from coalesced fs.watch events. */
export class Inbox {
	private watcher: FSWatcher | undefined;
	constructor(readonly dir: string, private readonly deliver: (value: InboxMessage) => void, private readonly onError: (error: unknown) => void) { }
	start(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		this.watcher = watch(this.dir, () => this.scan());
		this.watcher.on("error", this.onError);
		this.watcher.unref();
		this.scan();
	}
	scan(): void {
		for (const name of readdirSync(this.dir).filter(name => name.endsWith(".json")).sort()) {
			const file = join(this.dir, name);
			try {
				const value = JSON.parse(readFileSync(file, "utf8"));
				if (typeof value.message !== "string" || !value.message.trim() || typeof value.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)) {
					unlinkSync(file); this.onError(new Error("Invalid aside inbox message")); continue;
				}
				this.deliver(value);
				unlinkSync(file);
			} catch (error) { this.onError(error); }
		}
	}
	close(): void { this.watcher?.close(); this.watcher = undefined; }
}

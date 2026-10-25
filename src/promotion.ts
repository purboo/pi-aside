// Session promotion and the small file inbox shared with independent Pi windows.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
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
	let relays = 0;
	for (const original of options.history) {
		const message = structuredClone(original);
		const told: string[] = [];
		if (message.role === "assistant") {
			message.content = message.content.flatMap((part: Any) => {
				if (part.type !== "text") return [part];
				const reply = parseReply(part.text, true);
				if (reply.tell) told.push(reply.tell);
				// Without tell_agent in the new window, a delivered relay stays in words.
				const text = [
					reply.body,
					reply.tell && !options.relay ? `[Delivered to the main agent: ${reply.tell}]` : "",
					reply.forward ? "[Sent the user's previous message to the main agent unchanged.]" : "",
				].filter(Boolean).join("\n\n");
				return text ? [{ ...part, text }] : [];
			});
		}
		// A relay that already happened becomes the new window's own tell_agent call, or its model disowns it.
		const calls = options.relay ? told.map(tell => ({ type: "toolCall", id: `aside_relay_${++relays}`, name: "tell_agent", arguments: { message: tell } })) : [];
		if (calls.length) { message.content.push(...calls); message.stopReason = "toolUse"; }
		child.appendMessage(message);
		for (const call of calls) child.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: "tell_agent", content: [{ type: "text", text: "Delivered to the parent agent." }], isError: false, timestamp: message.timestamp } as Any);
	}
	// Say plainly that the move happened and where the conversation is now, or the new window's model disowns it.
	child.appendCustomMessageEntry("aside-moved", `Moved: this conversation now continues in its own Pi window, aside:${options.name}. You are in that window; the move is done.${options.relay ? " To reach the original agent, use tell_agent when the user asks." : ""}`, false);
	child.appendSessionInfo(`aside:${options.name}`);
	return file;
}

/** `sentAt` (epoch ms) is set by the sender; files from Pi 0.5.2 and earlier lack it and fall back to the file time. */
export interface InboxMessage { message: string; name: string; sentAt?: number }
export type InboxDelivery = InboxMessage & { sentAt: number };
// One inbox per session, not per process: a restarted Pi that resumes the session reads what its windows sent meanwhile.
export function inboxPath(sessionId: string): string {
	return join(getAgentDir(), "aside-inbox", safeId(sessionId));
}
function safeId(sessionId: string): string { return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"); }
/** Inboxes of this session made by Pi 0.5.1 and earlier, named `<id>-<pid>`; windows opened then still write there. */
export function legacyInboxPaths(sessionId: string): string[] {
	const root = join(getAgentDir(), "aside-inbox");
	const prefix = `${safeId(sessionId)}-`;
	try {
		return readdirSync(root).filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))).map(name => join(root, name));
	} catch { return []; }
}
const OWNER = "owner";
function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function ownerOf(dir: string): number | undefined {
	try { return Number(readFileSync(join(dir, OWNER), "utf8").trim()) || undefined; } catch { return undefined; }
}
/** The parent session id an inbox belongs to (pre-0.5.2 names carry a `-<pid>` suffix). */
export function inboxSession(dir: string): string {
	const name = basename(dir);
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(name)?.[0] ?? name;
}
/** Whether a running Pi is listening on this inbox right now. */
export function inboxOnline(dir: string): boolean {
	const pid = ownerOf(dir);
	return pid !== undefined && alive(pid);
}
export interface BacklogItem { name: string; message: string; sentAt: number; times: number }
/** Messages sent while no Pi listened, oldest first; identical re-sends from one window collapse into one item. */
export function collectBacklog(values: InboxDelivery[]): BacklogItem[] {
	const items: BacklogItem[] = [];
	for (const value of [...values].sort((a, b) => a.sentAt - b.sentAt)) {
		const same = items.find(item => item.name === value.name && item.message.trim() === value.message.trim());
		if (same) same.times++;
		else items.push({ name: value.name, message: value.message, sentAt: value.sentAt, times: 1 });
	}
	return items;
}
export function sentTime(ms: number): string {
	const d = new Date(ms), pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** One message for the whole backlog, so the agent sees it at once, knows it is late, and can tell re-sends apart. */
export function backlogNote(items: BacklogItem[]): string {
	const head = `While this session's Pi was not running, the user's aside windows sent ${items.length === 1 ? "this message" : `${items.length} messages`}. ${items.length === 1 ? "It is" : "They are listed oldest first,"} delivered late, with send times (local).`
		+ (items.length > 1 ? " The user may have re-sent one when it seemed lost: treat messages that repeat an earlier one as a single request and do not act on it twice." : "")
		+ " Some may already be out of date; check before acting.";
	return [head, ...items.map((item, i) => `### ${i + 1}. aside:${item.name} · sent ${sentTime(item.sentAt)}${item.times > 1 ? ` (sent ${item.times}×)` : ""}\n\n${item.message}`)].join("\n\n");
}
export function postInbox(dir: string, value: InboxMessage): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const sentAt = value.sentAt ?? Date.now();
	// The time prefix keeps a sorted scan in send order.
	const temp = join(dir, `${String(sentAt).padStart(15, "0")}-${randomUUID()}.tmp`);
	writeFileSync(temp, JSON.stringify({ ...value, sentAt }), { mode: 0o600 });
	renameSync(temp, temp.replace(/\.tmp$/, ".json"));
}

/** Atomic child writes; synchronous scanning prevents duplicate delivery from coalesced fs.watch events. */
export class Inbox {
	private watcher: FSWatcher | undefined;
	/** `backlog` is true for messages already waiting when this Pi started reading: they were sent while no Pi listened. */
	constructor(readonly dir: string, private readonly deliver: (value: InboxDelivery, backlog: boolean) => void, private readonly onError: (error: unknown) => void) { }
	start(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		// The latest Pi on the session takes the inbox; a second live Pi stops reading so nothing is delivered twice.
		writeFileSync(join(this.dir, OWNER), String(process.pid), { mode: 0o600 });
		this.watcher = watch(this.dir, () => this.scan());
		this.watcher.on("error", this.onError);
		this.watcher.unref();
		this.scan(true);
	}
	private owns(): boolean {
		const pid = ownerOf(this.dir);
		if (pid === process.pid) return true;
		if (pid !== undefined && alive(pid)) return false;
		try { writeFileSync(join(this.dir, OWNER), String(process.pid), { mode: 0o600 }); } catch { return false; }
		return true;
	}
	scan(backlog = false): void {
		if (!this.watcher || !this.owns()) return;
		for (const name of readdirSync(this.dir).filter(name => name.endsWith(".json")).sort()) {
			const file = join(this.dir, name);
			try {
				const value = JSON.parse(readFileSync(file, "utf8"));
				if (typeof value.message !== "string" || !value.message.trim() || typeof value.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)) {
					unlinkSync(file); this.onError(new Error("Invalid aside inbox message")); continue;
				}
				const sentAt = typeof value.sentAt === "number" && Number.isFinite(value.sentAt) ? value.sentAt : statSync(file).mtimeMs;
				this.deliver({ name: value.name, message: value.message, sentAt }, backlog);
				unlinkSync(file);
			} catch (error) { this.onError(error); }
		}
	}
	close(): void {
		this.watcher?.close(); this.watcher = undefined;
		// Going offline: windows report "queued" instead of "delivered" until a Pi resumes the session.
		if (ownerOf(this.dir) === process.pid) try { unlinkSync(join(this.dir, OWNER)); } catch { /* already gone */ }
	}
}

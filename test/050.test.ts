import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseReply, sanitizeSuggestion } from "../src/reply.ts";
import { panelHit, panelView, renderBelow } from "../src/panel.ts";
import { Inbox, inboxOnline, inboxPath, inboxSession, legacyInboxPaths, postInbox, promotionOptions, tmuxCommand, uniqueName, writePromotedSession } from "../src/promotion.ts";
import { notice } from "../src/thread.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "aside-050-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const theme = { fg: (_color: string, text: string) => text };

test("tell and move are hidden reply lines, in any order, hidden while they stream", () => {
	const done = parseReply("route: side\nPassed on.\ntell: Keep the routing tests.\nnext: tell it when done", true);
	expect(done).toMatchObject({ route: "side", body: "Passed on.", tell: "Keep the routing tests.", next: "tell it when done" });
	expect(parseReply("Moving.\n**move:** disk-cleanup | 完成后告诉 agent", true)).toMatchObject({ body: "Moving.", move: { name: "disk-cleanup", hint: "完成后告诉 agent" } });
	expect(parseReply("Moving.\nmove: disk-cleanup", true).move).toEqual({ name: "disk-cleanup" });
	const streaming = parseReply("route: side\nPassed on.\ntell: Keep the rou", false);
	expect(streaming.body).toBe("Passed on.");
	expect(streaming.tell).toBeUndefined();
	expect(parseReply("route: side\nPassed on.\nte", false).body).toBe("Passed on.");
	const prose = parseReply("tell: me more about it\nThat is all.", true);
	expect(prose.body).toBe("tell: me more about it\nThat is all.");
	expect(prose.tell).toBeUndefined();
});

test("next suggestions hide during streaming and sanitize commands, control codes and wide columns", () => {
	expect(parseReply("route: side\nDone.\nnext: keep going", false).body).toBe("Done.");
	expect(parseReply("route: side\nDone.\nne", false).body).toBe("Done.");
	expect(parseReply("Done.\nnext: /quit", true).next).toBeUndefined();
	expect(sanitizeSuggestion("  keep going\nignore this  ")).toBe("keep going");
	expect(sanitizeSuggestion("\x1b[31mcontinue\x1b[0m")).toBe("continue");
	const suggestion = sanitizeSuggestion("继续".repeat(50))!;
	expect(visibleWidth(suggestion)).toBeLessThanOrEqual(80);
	expect(suggestion.endsWith("…")).toBe(true);
	expect(renderBelow({ hint: undefined, next: "继续" }, 100, theme)).toEqual(["/aside 继续"]);
});

test("tell and move lines require the latest explicit request, self-contained relay, and move-out naming without another request", () => {
	const text = notice({ routeCheck: true });
	expect(text).toContain("ONLY when the user's latest message explicitly asks");
	expect(text).toContain("Never on your own initiative");
	expect(text).toContain("self-contained");
	expect(text).toContain("never claim you cannot");
	expect(text).toContain("ONLY on an explicit request to move");
	expect(text).toContain("Do not make a separate naming request");
	expect(text).toContain("before any tool call");
	expect(text).toContain("They are not tools");
});

test("panel touch targets: close and its adjacent cells, row below, only count text reads", () => {
	const view = panelView({ mouse: true, moreKey: "ctrl+o", maxLines: 10, turns: [{ question: "long?", raw: Array.from({ length: 60 }, (_, n) => `line ${n}`).join("\n"), done: true, steps: [], startedAt: 1, cost: 0, read: 0, written: 0 }] }, 80, theme);
	const x = view.lines[0]!.indexOf("✕");
	for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, 1]]) expect(panelHit(view, 80, x + dx!, dy!, true)).toBe("close");
	expect(panelHit(view, 80, x, -1, true)).toBeUndefined(); // Outside the component; Pi owns the row above.
	const zone = view.readerZones![0]!;
	expect(panelHit(view, 80, zone.from, zone.row, true)).toBe("reader");
	expect(panelHit(view, 80, 60, zone.row, true)).toBeUndefined();
	expect(panelHit(view, 80, zone.from - 1, zone.row, true)).toBeUndefined();
	// No cost/status footer is inserted in a completed panel.
	expect(view.lines.join("\n")).not.toContain("cache");
});

test("promotion writes a normal session, preserving the fork branch and tools, stripping aside protocol", async () => {
	const dir = temp();
	const parent = SessionManager.create(dir, dir);
	parent.appendMessage({ role: "user", content: "main fork", timestamp: 1 });
	const branch = structuredClone(parent.getBranch());
	parent.appendMessage({ role: "user", content: "new main output excluded", timestamp: 2 });
	const assistant = { role: "assistant", content: [{ type: "text", text: "route: side\nFound it.\nnext: continue" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "notes" } }], timestamp: 4, api: "anthropic-messages", provider: "test", model: "test", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const file = writePromotedSession({
		cwd: dir, sessionDir: dir, parentFile: parent.getSessionFile(), name: "disk-cleanup", branch, history: [
			{ role: "user", content: "check disk", timestamp: 3 }, assistant,
			{ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "notes result" }], isError: false, timestamp: 5 },
		]
	});
	const child = SessionManager.open(file);
	expect(child.getSessionName()).toBe("aside:disk-cleanup");
	expect(child.getHeader()!.parentSession).toBe(parent.getSessionFile());
	const context = JSON.stringify(child.buildSessionContext());
	expect(context).toContain("main fork");
	expect(context).toContain("check disk");
	expect(context).toContain("notes result");
	expect(context).not.toContain("new main output excluded");
	expect(context).not.toMatch(/route:|next:|<aside>/);
	expect((await SessionManager.list(dir, dir)).find(item => item.path === file)?.name).toBe("aside:disk-cleanup");
	child.appendCustomEntry("aside-window", { name: "other" });
	expect(JSON.stringify(child.buildSessionContext())).toBe(context);
});

test("the new window's transcript says the move happened, so its model does not disown it", () => {
	const dir = temp();
	const assistant = { role: "assistant", content: [{ type: "text", text: "route: side\nMoving it.\nmove: disk-cleanup | Tell the agent when done" }], timestamp: 2, api: "anthropic-messages", provider: "test", model: "test", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const told = { ...assistant, content: [{ type: "text", text: "route: side\nPassed on.\ntell: Keep the routing tests." }] };
	const history = [{ role: "user", content: "tell the agent", timestamp: 0 }, told, { role: "user", content: "move this out", timestamp: 1 }, assistant];
	const relayed = JSON.stringify(SessionManager.open(writePromotedSession({ cwd: dir, sessionDir: dir, name: "disk-cleanup", branch: [], history, relay: true })).buildSessionContext());
	expect(relayed).toContain("now continues in its own Pi window, aside:disk-cleanup");
	expect(relayed).toContain("use tell_agent");
	expect(relayed).toContain("Moving it.");
	expect(relayed).not.toContain("move: disk-cleanup");
	expect(relayed).toContain('"name":"tell_agent","arguments":{"message":"Keep the routing tests."}');
	expect(relayed).toContain("Delivered to the parent agent.");
	expect(relayed).not.toContain("tell: Keep");
	const copied = JSON.stringify(SessionManager.open(writePromotedSession({ cwd: dir, sessionDir: dir, name: "disk-cleanup", branch: [], history })).buildSessionContext());
	expect(copied).not.toContain("tell_agent");
	expect(copied).toContain("[Delivered to the main agent: Keep the routing tests.]");
});

test("tmux promotion targets the originating pane, inserts and selects a uniquely named window, safely quotes env", () => {
	const name = uniqueName("disk-cleanup", ["aside:disk-cleanup", "aside:disk-cleanup-2"]);
	expect(name).toBe("disk-cleanup-3");
	const args = tmuxCommand({ window: "@12", cwd: "/a b", file: "/a b/session.jsonl", name, hint: "you're done; $(no)", inbox: "/inbox", continue: true });
	expect(args.slice(0, 9)).toEqual(["new-window", "-a", "-t", "@12", "-n", "aside:disk-cleanup-3", "-c", "/a b", "-P"]);
	expect(args).not.toContain("-d");
	expect(args.at(-1)).toContain("PI_ASIDE_HINT='you'\\''re done; $(no)'");
	expect(args.at(-1)).toContain("pi --session '/a b/session.jsonl' continue");
	expect(promotionOptions({ name: "INVALID", hint: "/exit" }, 3)).toEqual({ name: "aside-3", hint: "tell the agent when you're done" });
});

test("inbox scans pending files on start, watches atomic writes, removes consumed files and retries failed deliveries", async () => {
	const dir = temp();
	postInbox(dir, { name: "disk-cleanup", message: "first" });
	let fail = true;
	const received: string[] = [], errors: unknown[] = [];
	const inbox = new Inbox(dir, value => { if (fail) throw new Error("delivery unavailable"); received.push(value.message); }, error => errors.push(error));
	try {
		inbox.start();
		expect(errors.length).toBe(1);
		fail = false;
		inbox.scan(); inbox.scan();
		expect(received).toEqual(["first"]);
		postInbox(dir, { name: "disk-cleanup", message: "second" });
		for (let i = 0; i < 50 && received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
		expect(received).toEqual(["first", "second"]);
		writeFileSync(join(dir, "invalid.json"), JSON.stringify({ name: "../bad", message: "unsafe" }));
		inbox.scan();
		expect(existsSync(join(dir, "invalid.json"))).toBe(false);
	} finally { inbox.close(); }
});


test("an exported snapshot completes pending main tool calls with still-running results", () => {
	const dir = temp();
	const parent = SessionManager.create(dir, dir);
	parent.appendMessage({ role: "user", content: "main", timestamp: 1 });
	parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "sleep 5" } }], timestamp: 2, api: "anthropic-messages", provider: "test", model: "test", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const file = writePromotedSession({ cwd: dir, sessionDir: dir, name: "pending-work", branch: parent.getBranch(), history: [{ role: "user", content: "aside question", timestamp: 3 }] });
	const context = SessionManager.open(file).buildSessionContext().messages;
	const result = context.find(message => message.role === "toolResult");
	expect(result?.role === "toolResult" && result.toolCallId).toBe("pending");
	expect(JSON.stringify(result)).toContain("still running in the main session");
	expect(context.at(-2)?.role).toBe("user");
	expect(context.at(-1)).toMatchObject({ role: "custom", customType: "aside-moved" });
});

test("a restarted Pi resuming the session reads what its windows sent while it was down, and windows learn whether anyone listens", () => {
	const dir = temp();
	const received: string[] = [];
	const first = new Inbox(dir, value => received.push(value.message), () => { });
	first.start();
	expect(inboxOnline(dir)).toBe(true);
	first.close();
	// Pi is down: the window's message waits, and the window can say so honestly.
	expect(inboxOnline(dir)).toBe(false);
	postInbox(dir, { name: "notes", message: "sent while down" });
	expect(received).toEqual([]);
	const second = new Inbox(dir, value => received.push(value.message), () => { });
	try {
		second.start();
		expect(received).toEqual(["sent while down"]);
		expect(inboxOnline(dir)).toBe(true);
	} finally { second.close(); }
});

test("a second live Pi on the same session takes the inbox, so no message is delivered twice", () => {
	const dir = temp();
	const a: string[] = [], b: string[] = [];
	const older = new Inbox(dir, value => a.push(value.message), () => { });
	older.start();
	// Another live process claims it (the test runner's parent stands in for the newer Pi).
	writeFileSync(join(dir, "owner"), String(process.ppid));
	postInbox(dir, { name: "notes", message: "one" });
	older.scan();
	expect(a).toEqual([]);
	expect(existsSync(dir) && readdirSync(dir).filter(name => name.endsWith(".json")).length).toBe(1);
	older.close();
	// Closing does not drop the other process's claim.
	expect(readFileSync(join(dir, "owner"), "utf8")).toBe(String(process.ppid));
	const newer = new Inbox(dir, value => b.push(value.message), () => { });
	try { newer.start(); expect(b).toEqual(["one"]); } finally { newer.close(); }
});

test("inboxes are per session, and pre-0.5.2 per-process inboxes of the session are found", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agent = temp();
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		expect(inboxPath("abc")).toBe(join(agent, "aside-inbox", "abc"));
		expect(inboxPath("abc")).toBe(inboxPath("abc"));
		for (const name of ["abc-1234", "abc-99", "abc-x1", "abcd-12", "abc"]) mkdirSync(join(agent, "aside-inbox", name), { recursive: true });
		expect(legacyInboxPaths("abc").sort()).toEqual([join(agent, "aside-inbox", "abc-1234"), join(agent, "aside-inbox", "abc-99")]);
		expect(legacyInboxPaths("none")).toEqual([]);
		const id = "019a1b2c-3d4e-7f00-8123-456789abcdef";
		expect(inboxSession(join(agent, "aside-inbox", id))).toBe(id);
		expect(inboxSession(join(agent, "aside-inbox", `${id}-4242`))).toBe(id);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

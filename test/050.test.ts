import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseReply, sanitizeSuggestion } from "../src/reply.ts";
import { panelHit, panelView, renderBelow } from "../src/panel.ts";
import { Inbox, postInbox, promotionOptions, tmuxCommand, uniqueName, writePromotedSession } from "../src/promotion.ts";
import { notice } from "../src/thread.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "aside-050-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const theme = { fg: (_color: string, text: string) => text };

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

test("internal tools require the latest explicit request, self-contained relay, and move-out naming without another request", () => {
	const text = notice({ routeCheck: true });
	expect(text).toContain("ONLY when the user's latest message explicitly asks");
	expect(text).toContain("Never on your own initiative");
	expect(text).toContain("self-contained");
	expect(text).toContain("never claim you cannot");
	expect(text).toContain("ONLY on an explicit request to move");
	expect(text).toContain("Do not make a separate naming request");
	expect(text).toContain("before any tool call");
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

test("the new window's transcript says the move happened, so its model does not disown move_out", () => {
	const dir = temp();
	const call = { type: "toolCall", id: "m", name: "move_out", arguments: { name: "disk-cleanup" } };
	const assistant = { role: "assistant", content: [{ type: "text", text: "route: side\n" }, call], timestamp: 2, api: "anthropic-messages", provider: "test", model: "test", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const history = [{ role: "user", content: "move this out", timestamp: 1 }, assistant, { role: "toolResult", toolCallId: "m", toolName: "move_out", content: [{ type: "text", text: "Moving to its own window." }], isError: false, timestamp: 3 }];
	const relayed = JSON.stringify(SessionManager.open(writePromotedSession({ cwd: dir, sessionDir: dir, name: "disk-cleanup", branch: [], history, relay: true })).buildSessionContext());
	expect(relayed).toContain("now continues in its own Pi window, aside:disk-cleanup");
	expect(relayed).toContain("use tell_agent");
	expect(relayed).not.toContain("Moving to its own window.");
	const copied = JSON.stringify(SessionManager.open(writePromotedSession({ cwd: dir, sessionDir: dir, name: "disk-cleanup", branch: [], history })).buildSessionContext());
	expect(copied).not.toContain("tell_agent");
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
	expect(context.at(-1)?.role).toBe("user");
});

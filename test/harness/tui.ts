// Real Pi TUI in a detached tmux session on a private socket, against the capture server.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiName, modelsJson, PROVIDERS, piPackageDir } from "./pi.ts";

export interface TuiOptions {
	baseUrl: string;
	api?: ApiName;
	extensions?: string[];
	settings?: Record<string, unknown>;
	keybindings?: Record<string, unknown>;
	cols?: number;
	rows?: number;
}

export class PiTui {
	constructor(
		readonly socket: string,
		readonly session: string,
		readonly agentDir: string,
		readonly sessionDir: string,
		readonly cwd: string,
	) {}

	private tmux(...args: string[]): string {
		return execFileSync("tmux", ["-L", this.socket, ...args], { encoding: "utf8" });
	}

	/** Literal text (UTF-8, CJK included). */
	type(text: string): void {
		this.tmux("send-keys", "-t", this.session, "-l", text);
	}

	/** tmux key names: Enter, Escape, Tab, M-Enter, C-c, Up, … */
	key(...keys: string[]): void {
		this.tmux("send-keys", "-t", this.session, ...keys);
	}

	/** A bracketed paste. */
	paste(text: string): void {
		this.tmux("set-buffer", "-b", "pa", text);
		this.tmux("paste-buffer", "-p", "-b", "pa", "-t", this.session);
	}

	screen(): string {
		return this.tmux("capture-pane", "-p", "-t", this.session);
	}

	async waitForScreen(pattern: RegExp, timeoutMs = 15_000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const s = this.screen();
			if (pattern.test(s)) return s;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; screen:\n${s}`);
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	async close(): Promise<void> {
		try {
			this.tmux("kill-server");
		} catch {
			// already gone
		}
		rmSync(this.agentDir, { recursive: true, force: true });
		rmSync(this.sessionDir, { recursive: true, force: true });
		rmSync(this.cwd, { recursive: true, force: true });
	}
}

export async function startPiTui(options: TuiOptions): Promise<PiTui> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-aside-tui-agent-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-aside-tui-sessions-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-aside-tui-cwd-"));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(options.baseUrl), null, 2));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ cacheWarming: "off", quietStartup: true, collapseChangelog: true, ...options.settings }, null, 2),
	);
	if (options.keybindings) writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify(options.keybindings, null, 2));
	const api = PROVIDERS[options.api ?? "anthropic"];
	const socket = `pi-aside-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const session = "pi";
	const cli = join(piPackageDir(), "dist/bundle/cli.js");
	const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const command = [
		`PI_CODING_AGENT_DIR=${quote(agentDir)}`,
		"PI_OFFLINE=1",
		"PI_SKIP_VERSION_CHECK=1",
		"PI_TELEMETRY=0",
		"TERM=xterm-256color",
		"node",
		quote(cli),
		"--session-dir",
		quote(sessionDir),
		"--provider",
		api.provider,
		"--model",
		api.model,
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		...(options.extensions ?? []).flatMap((e) => ["-e", quote(e)]),
	].join(" ");
	const conf = join(agentDir, "tmux.conf");
	writeFileSync(conf, "set -g extended-keys on\nset -g extended-keys-format csi-u\nset -s escape-time 0\nset -g status off\n");
	execFileSync("tmux", [
		"-L",
		socket,
		"-f",
		conf,
		"new-session",
		"-d",
		"-s",
		session,
		"-x",
		String(options.cols ?? 110),
		"-y",
		String(options.rows ?? 36),
		"-c",
		cwd,
		`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy ${command}`,
	]);
	const tui = new PiTui(socket, session, agentDir, sessionDir, cwd);
	return tui;
}

// Real Pi in RPC mode against the capture server, isolated from the user's agent directory.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

export function piPackageDir(): string {
	return realpathSync(process.env.PI_ASIDE_PI_DIR ?? join(ROOT, "node_modules/@earendil-works/pi-coding-agent"));
}

export const PROVIDERS = {
	anthropic: { provider: "cap-anthropic", api: "anthropic-messages", model: "claude-test", key: "test-key-anthropic" },
	responses: { provider: "cap-responses", api: "openai-responses", model: "gpt-test", key: "test-key-responses" },
	completions: { provider: "cap-completions", api: "openai-completions", model: "chat-test", key: "test-key-completions" },
} as const;

export type ApiName = keyof typeof PROVIDERS;

export function modelsJson(baseUrl: string): unknown {
	const model = (id: string, reasoning: boolean, compat?: Record<string, unknown>) => ({
		id,
		name: id,
		reasoning,
		input: ["text", "image"],
		contextWindow: 200000,
		maxTokens: 16000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		...(compat ? { compat } : {}),
	});
	return {
		providers: {
			[PROVIDERS.anthropic.provider]: {
				baseUrl,
				api: PROVIDERS.anthropic.api,
				apiKey: PROVIDERS.anthropic.key,
				models: [model(PROVIDERS.anthropic.model, true), model("claude-plain", false), model("claude-effort", true, { supportsMidConvoEffort: true, forceAdaptiveThinking: true })],
			},
			[PROVIDERS.responses.provider]: {
				baseUrl: `${baseUrl}/v1`,
				api: PROVIDERS.responses.api,
				apiKey: PROVIDERS.responses.key,
				models: [model(PROVIDERS.responses.model, true), model("gpt-effort", true, { supportsMidConvoEffort: true })],
			},
			[PROVIDERS.completions.provider]: {
				baseUrl: `${baseUrl}/v1`,
				api: PROVIDERS.completions.api,
				apiKey: PROVIDERS.completions.key,
				models: [model(PROVIDERS.completions.model, false)],
			},
		},
	};
}

export interface PiOptions {
	baseUrl: string;
	api?: ApiName;
	/** Model id within the API's provider (default: the provider's main test model). */
	model?: string;
	thinking?: string;
	extensions?: string[];
	settings?: Record<string, unknown>;
	env?: Record<string, string>;
	cwd?: string;
	args?: string[];
}

export interface UiRequest {
	id: string;
	method: string;
	[key: string]: unknown;
}

export class PiRpc {
	readonly events: Record<string, unknown>[] = [];
	readonly ui: UiRequest[] = [];
	stderr = "";
	private buffer = "";
	private pending = new Map<string, (r: Record<string, unknown>) => void>();
	private waiters = new Set<() => void>();
	private nextId = 0;

	constructor(
		readonly child: ChildProcess,
		readonly agentDir: string,
		readonly sessionDir: string,
		readonly cwd: string,
		private readonly ownsCwd = false,
	) {
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.onData(chunk));
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
				this.pending.get(record.id)!(record);
				this.pending.delete(record.id);
			} else if (record.type === "extension_ui_request") {
				this.ui.push(record as UiRequest);
			} else {
				this.events.push(record);
			}
			for (const w of [...this.waiters]) w();
		}
	}

	send(command: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
		const id = `c${++this.nextId}`;
		return new Promise((resolvePromise, reject) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${String(command.type)} timed out; stderr: ${this.stderr.slice(-2000)}`));
			}, timeoutMs);
			this.pending.set(id, (r) => {
				clearTimeout(t);
				resolvePromise(r);
			});
			this.child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	prompt(message: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return this.send({ type: "prompt", message, ...extra });
	}

	async waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000, what = "condition"): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = probe();
			if (value !== undefined && value !== false) return value;
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out waiting for ${what}; stderr: ${this.stderr.slice(-3000)}`);
			await new Promise<void>((r) => {
				const t = setTimeout(done, Math.min(left, 250));
				this.waiters.add(done);
				function done() {
					clearTimeout(t);
					r();
				}
			}).finally(() => undefined);
			this.waiters.clear();
		}
	}

	/** Wait until `agent_end` has been seen `count` times in total. */
	waitForAgentEnd(count = 1, timeoutMs = 20_000): Promise<true> {
		return this.waitFor(() => this.events.filter((e) => e.type === "agent_end").length >= count || undefined, timeoutMs, `agent_end #${count}`);
	}

	notifications(): string[] {
		return this.ui.filter((u) => u.method === "notify").map((u) => String(u.message));
	}

	/** Wait for a notification matching `prefix` beyond the first `skip` such notifications. */
	async waitForNotify(prefix: string, skip = 0, timeoutMs = 20_000): Promise<string> {
		return this.waitFor(() => this.notifications().filter((m) => m.startsWith(prefix))[skip], timeoutMs, `notify ${prefix}#${skip}`);
	}

	sessionFile(): string | undefined {
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
				d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".jsonl") ? [join(dir, d.name)] : [],
			);
		return walk(this.sessionDir)[0];
	}

	sessionEntries(): Record<string, unknown>[] {
		const file = this.sessionFile();
		if (!file) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}

	async close(): Promise<void> {
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.stdin!.end();
			this.child.kill("SIGTERM");
			await new Promise<void>((r) => {
				const t = setTimeout(() => {
					this.child.kill("SIGKILL");
					r();
				}, 3000);
				this.child.once("exit", () => {
					clearTimeout(t);
					r();
				});
			});
		}
		rmSync(this.agentDir, { recursive: true, force: true });
		rmSync(this.sessionDir, { recursive: true, force: true });
		if (this.ownsCwd) rmSync(this.cwd, { recursive: true, force: true });
	}
}

export async function startPi(options: PiOptions): Promise<PiRpc> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-aside-agent-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-aside-sessions-"));
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-aside-cwd-"));
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(options.baseUrl), null, 2));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", ...options.settings }, null, 2));
	const api = PROVIDERS[options.api ?? "anthropic"];
	const cli = join(piPackageDir(), "dist/bundle/cli.js");
	const args = [
		cli,
		"--mode",
		"rpc",
		"--session-dir",
		sessionDir,
		"--provider",
		api.provider,
		"--model",
		options.model ?? api.model,
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		...(options.thinking ? ["--thinking", options.thinking] : []),
		...(options.extensions ?? []).flatMap((e) => ["-e", e]),
		...(options.args ?? []),
	];
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PI_")) env[k] = v;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		...options.env,
	});
	for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
	const child = spawn("node", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const pi = new PiRpc(child, agentDir, sessionDir, cwd, options.cwd === undefined);
	// Ready once it answers a command.
	await pi.send({ type: "get_state" }, 30_000);
	return pi;
}

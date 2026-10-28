import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CaptureServer, startCaptureServer } from "./harness/capture.ts";
import { type PiRpc, piPackageDir, startPi } from "./harness/pi.ts";

const ROOT = resolve(import.meta.dir, "..");
let packedDir: string | undefined;
let server: CaptureServer | undefined;
let pi: PiRpc | undefined;
afterEach(async () => {
	await pi?.close(); await server?.close();
	if (packedDir) rmSync(packedDir, { recursive: true, force: true });
	pi = undefined; server = undefined; packedDir = undefined;
});

test("the npm tarball loads and answers without a local node_modules directory", async () => {
	packedDir = mkdtempSync(join(tmpdir(), "pi-aside-packed-"));
	execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packedDir], { cwd: ROOT, stdio: "pipe" });
	const tarball = readdirSync(packedDir).find(file => file.endsWith(".tgz"))!;
	execFileSync("tar", ["-xzf", join(packedDir, tarball), "-C", packedDir]);
	const installed = join(packedDir, "package");
	expect(readdirSync(installed)).not.toContain("node_modules");
	// Exercise Pi's native loader too: bundled CLI tests alone can resolve imports through the checkout.
	const loaded = JSON.parse(execFileSync("node", ["--input-type=module", "-e", `
		import { pathToFileURL } from "node:url";
		const { loadExtensions } = await import(pathToFileURL(process.argv[1]).href);
		const result = await loadExtensions([process.argv[2]], process.cwd());
		console.log(JSON.stringify({ errors: result.errors, commands: result.extensions.flatMap(e => [...e.commands.keys()]) }));
	`, join(piPackageDir(), "dist/core/extensions/loader.js"), join(installed, "src/index.ts")], { cwd: installed, encoding: "utf8", timeout: 15000 }));
	expect(loaded.errors).toEqual([]);
	expect(loaded.commands).toContain("aside");
	server = await startCaptureServer();
	pi = await startPi({
		baseUrl: server.url,
		extensions: [resolve(import.meta.dir, "fixtures/probe.ts")],
		settings: { packages: [installed] },
		modelLimits: { contextWindow: 16384, maxTokens: 14000 },
		thinking: "off",
	});
	const commands = await pi.send({ type: "get_commands" });
	expect(commands.success).toBe(true);
	expect((commands.data as { commands: Array<{ name: string }> }).commands.map(command => command.name)).toContain("aside");
	expect(pi.stderr).not.toContain("Failed to load extension");
	server.enqueue({ text: "Main ready.", usage: { input: 7000, output: 5 } });
	await pi.prompt("start");
	await pi.waitForAgentEnd();
	server.enqueue({ text: "Packaged answer.", usage: { input: 100, cacheRead: 7500 } });
	await pi.prompt("/aside does it load?");
	const done = JSON.parse((await pi.waitForNotify("ASIDE_DONE ")).slice("ASIDE_DONE ".length));
	expect(done.error).toBeUndefined();
	expect(done.tier).toBe("exact");
	expect(done.answer).toBe("Packaged answer.");
	expect(server.requests).toHaveLength(2);
	expect(server.requests[1]!.body.max_tokens).toBeLessThan(server.requests[0]!.body.max_tokens as number);
}, 30000);

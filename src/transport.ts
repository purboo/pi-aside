// Transport for the aside's requests (docs/design.md §4.2, "Routing: the next-request rule"): the request options
// and the attribution headers the main session's next request would get, synthesized from the current settings,
// never copied from the observation; plus the currency check.

import { SettingsManager } from "@earendil-works/pi-coding-agent";

type AnyModel = { provider: string; id: string; api: string; baseUrl: string; [key: string]: unknown };

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, host: string): boolean {
	try {
		return new URL(baseUrl).hostname === host;
	} catch {
		return false;
	}
}

function isTruthyEnvFlag(value: string): boolean {
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Replica of Pi's `isInstallTelemetryEnabled` (telemetry.js, Pi 1.1.0–1.3.0). */
export function telemetryEnabled(settings: SettingsManager, env: string | undefined = process.env.PI_TELEMETRY): boolean {
	return env !== undefined ? isTruthyEnvFlag(env) : settings.getEnableInstallTelemetry();
}

/** Replica of Pi's `mergeProviderAttributionHeaders` (provider-attribution.js, Pi 1.1.0–1.3.0): D ⊕ X. */
export function mergeAttributionHeaders(
	model: AnyModel,
	settings: SettingsManager,
	sessionId: string | undefined,
	...sources: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
	const merged: Record<string, unknown> = {};
	if (
		sessionId &&
		(model.provider === "opencode" || model.provider === "opencode-go" || matchesHost(model.baseUrl, OPENCODE_HOST))
	) {
		merged["x-opencode-session"] = sessionId;
		merged["x-opencode-client"] = "pi";
	}
	if (telemetryEnabled(settings)) {
		if (model.provider === "openrouter" || model.baseUrl.includes(OPENROUTER_HOST)) {
			merged["HTTP-Referer"] = "https://pi.dev";
			merged["X-OpenRouter-Title"] = "pi";
			merged["X-OpenRouter-Categories"] = "cli-agent";
		} else if (model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST)) {
			merged["X-BILLING-INVOKE-ORIGIN"] = "Pi";
		} else if (
			model.provider === "cloudflare-workers-ai" ||
			model.provider === "cloudflare-ai-gateway" ||
			matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
			matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
		) {
			merged["User-Agent"] = "pi-coding-agent";
		}
	}
	for (const source of sources) if (source) Object.assign(merged, source);
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The current settings, read through Pi's own settings code. */
export function currentSettings(getSettings: () => unknown): SettingsManager {
	return SettingsManager.inMemory(structuredClone(getSettings()) as never);
}

export interface RequestOptions {
	timeoutMs: number | undefined;
	websocketConnectTimeoutMs: number | undefined;
	maxRetries: number | undefined;
	maxRetryDelayMs: number | undefined;
}

/** The options Pi's `buildRequestOptions` (sdk.js) gives the main session's next request. */
export function requestOptions(settings: SettingsManager): RequestOptions {
	const retry = settings.getProviderRetrySettings();
	const idle = settings.getHttpIdleTimeoutMs();
	return {
		timeoutMs: retry.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
		websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
		maxRetries: retry.maxRetries,
		maxRetryDelayMs: retry.maxRetryDelayMs,
	};
}

/** Snapshot of the process environment for the currency check. */
export function envSnapshot(): Map<string, string | undefined> {
	return new Map(Object.entries(process.env));
}

export function envUnchanged(snapshot: Map<string, string | undefined>): boolean {
	const keys = Object.keys(process.env);
	if (keys.length !== snapshot.size) return false;
	for (const key of keys) {
		if (!snapshot.has(key) || snapshot.get(key) !== process.env[key]) return false;
	}
	return true;
}

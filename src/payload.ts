// Provider payload comparison (docs/design.md §4.2): the per-API table, strip(), the trailing configuration items E,
// the handler delta ΔH, and the checks C1–C3. Pure functions over JSON payloads.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Payload = { [key: string]: unknown };

interface ApiShape {
	/** The name of the content list. */
	list: string;
	/** Whether an item is a trailing configuration item (E). */
	isConfigItem(item: unknown): boolean;
}

const API_TABLE: Record<string, ApiShape> = {
	"anthropic-messages": {
		list: "messages",
		isConfigItem: (item) =>
			isObject(item) &&
			item.role === "system" &&
			Array.isArray(item.content) &&
			item.content.length === 0 &&
			"output_config" in item,
	},
	"openai-responses": {
		list: "input",
		isConfigItem: (item) => isObject(item) && item.type === "configuration_update",
	},
	"openai-completions": {
		list: "messages",
		isConfigItem: () => false,
	},
};

/** APIs whose payloads tier T0 can check and send. */
export const T0_APIS = new Set(Object.keys(API_TABLE));

/** Top-level fields the recipe controls: a handler may not change them (C1). */
export const RECIPE_FIELDS = new Set([
	"messages",
	"input",
	"system",
	"instructions",
	"tools",
	"tool_choice",
	"model",
	"max_tokens",
	"max_output_tokens",
	"max_completion_tokens",
	"thinking",
	"reasoning",
	"reasoning_effort",
	"output_config",
	"stream",
]);

export const MARKER_KEY = "cache_control";

export function apiShape(api: string): ApiShape | undefined {
	return API_TABLE[api];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		if (a.length !== bb.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
		return true;
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
	const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
	if (ak.length !== bk.length) return false;
	for (const k of ak) if (!(k in bo) || !deepEqual(ao[k], bo[k])) return false;
	return true;
}

/**
 * Remove cache markers everywhere, and write a string-valued message content as one text block: pi-ai turns the
 * last user message's string into a block when it attaches a marker, and that message is no longer last in a fork.
 */
export function strip(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(strip);
	if (!isObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		if (key === MARKER_KEY || inner === undefined) continue;
		out[key] = strip(inner);
	}
	if (typeof out.role === "string" && typeof out.content === "string") {
		out.content = [{ type: "text", text: out.content }];
	}
	return out;
}

function containsMarker(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsMarker);
	if (!isObject(value)) return false;
	if (MARKER_KEY in value) return true;
	return Object.values(value).some(containsMarker);
}

/** Number of cache markers anywhere in a payload. */
export function countMarkers(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((n: number, v) => n + countMarkers(v), 0);
	if (!isObject(value)) return 0;
	let n = MARKER_KEY in value ? 1 : 0;
	for (const v of Object.values(value)) n += countMarkers(v);
	return n;
}

export interface SplitList {
	core: unknown[];
	config: unknown[];
}

/** Split a content list as core ++ E, where E is the longest run of trailing configuration items. */
export function splitList(api: string, payload: Payload): SplitList | undefined {
	const shape = API_TABLE[api];
	if (!shape) return undefined;
	const list = payload[shape.list];
	if (!Array.isArray(list)) return undefined;
	let end = list.length;
	while (end > 0 && shape.isConfigItem(list[end - 1])) end--;
	return { core: list.slice(0, end), config: list.slice(end) };
}

/**
 * Whether stripped `longer` extends stripped `shorter`: every element equal, except that the last element of
 * `shorter` may be extended by appended content blocks of the same role.
 */
export function extendsList(longer: unknown[], shorter: unknown[]): boolean {
	if (longer.length < shorter.length) return false;
	for (let i = 0; i < shorter.length; i++) {
		const a = strip(longer[i]);
		const b = strip(shorter[i]);
		if (deepEqual(a, b)) continue;
		if (i !== shorter.length - 1) return false;
		if (!isObject(a) || !isObject(b)) return false;
		if (!Array.isArray(a.content) || !Array.isArray(b.content)) return false;
		if (a.content.length < b.content.length) return false;
		const { content: ac, ...arest } = a;
		const { content: bc, ...brest } = b;
		if (!deepEqual(arest, brest)) return false;
		for (let j = 0; j < (bc as unknown[]).length; j++) if (!deepEqual((ac as unknown[])[j], (bc as unknown[])[j])) return false;
	}
	return true;
}

/** ΔH: the top-level fields of P that differ from B0, with P's value (undefined: P removed it). */
export type Delta = Map<string, unknown>;

export function diffTopLevel(base: Payload, observed: Payload): Delta {
	const delta: Delta = new Map();
	const keys = new Set([...Object.keys(base), ...Object.keys(observed)]);
	for (const key of keys) {
		if (!deepEqual(strip(base[key]), strip(observed[key]))) delta.set(key, observed[key]);
	}
	return delta;
}

export function applyDelta(payload: Payload, delta: Delta): Payload {
	const out: Payload = { ...payload };
	for (const [key, value] of delta) {
		if (value === undefined) delete out[key];
		else out[key] = structuredClone(value);
	}
	return out;
}

export interface CheckResult {
	ok: boolean;
	/** Short reason when not ok. */
	reason?: string;
}

const ok: CheckResult = { ok: true };
const fail = (reason: string): CheckResult => ({ ok: false, reason });

/** C1: ΔH touches only fields the recipe does not control, and strip(B0.list) = strip(P.list). */
export function checkC1(api: string, b0: Payload, p: Payload, delta: Delta): CheckResult {
	const shape = API_TABLE[api];
	if (!shape) return fail(`api ${api} is not supported`);
	for (const key of delta.keys()) {
		if (RECIPE_FIELDS.has(key)) return fail(`a handler or the recipe changed \`${key}\``);
	}
	if (!deepEqual(strip(b0[shape.list]), strip(p[shape.list]))) return fail("the observed transcript does not reproduce the request");
	return ok;
}

function otherFieldsEqual(api: string, a: Payload, b: Payload): string | undefined {
	const shape = API_TABLE[api]!;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (key === shape.list) continue;
		if (!deepEqual(strip(a[key]), strip(b[key]))) return key;
	}
	return undefined;
}

/** C2: the fork appends to the core of B0, with the same E and every other top-level field equal. */
export function checkC2(api: string, b0: Payload, b1: Payload, p: Payload): CheckResult {
	const s0 = splitList(api, b0);
	const s1 = splitList(api, b1);
	const sp = splitList(api, p);
	if (!s0 || !s1 || !sp) return fail("no content list");
	if (!deepEqual(strip(s1.config), strip(s0.config))) return fail("the trailing configuration changed");
	if (!extendsList(s1.core, s0.core)) return fail("the fork does not extend the conversation");
	// P's last marker must lie inside core(B0), so the fork can read up to it.
	let lastMarker = -1;
	const plist = p[API_TABLE[api]!.list] as unknown[];
	for (let i = 0; i < plist.length; i++) if (containsMarker(plist[i])) lastMarker = i;
	if (lastMarker >= s0.core.length) return fail("the observed cache marker lies outside the shared prefix");
	const field = otherFieldsEqual(api, b1, b0);
	if (field) return fail(`the fork changed \`${field}\``);
	return ok;
}

/**
 * Whether two dry conversions of the same transcript differ only in their trailing configuration items E: the same
 * core and the same other top-level fields. This is what proves that a lower aside effort keeps the cache prefix.
 */
export function differsOnlyInConfig(api: string, a: Payload, b: Payload): boolean {
	const sa = splitList(api, a);
	const sb = splitList(api, b);
	if (!sa || !sb) return false;
	if (!deepEqual(strip(sa.core), strip(sb.core))) return false;
	return otherFieldsEqual(api, a, b) === undefined;
}

/**
 * C3, on the bytes sent: F's top-level fields equal P's, and strip(core(F)) extends strip(core(P)). E(F) equals E(P),
 * or `expectedConfig` when the aside runs at its own effort (proved by `differsOnlyInConfig` on the dry runs).
 */
export function checkC3(api: string, f: Payload, p: Payload, expectedConfig?: unknown[]): CheckResult {
	const sf = splitList(api, f);
	const sp = splitList(api, p);
	if (!sf || !sp) return fail("no content list");
	if (!deepEqual(strip(sf.config), strip(expectedConfig ?? sp.config))) return fail("the trailing configuration differs from the observed request");
	if (!extendsList(sf.core, sp.core)) return fail("the request does not extend the observed request");
	const field = otherFieldsEqual(api, f, p);
	if (field) return fail(`\`${field}\` differs from the observed request`);
	return ok;
}

/** Canonical JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isObject(value)) {
		const keys = Object.keys(value)
			.filter((k) => value[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

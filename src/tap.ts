// The final-payload tap. `before_provider_request` handlers run in extension load order, and a handler may return a
// replacement payload, which extensions loaded earlier never see. Pi sends every session request through the same
// model runtime that backs `ctx.modelRegistry`, and passes the handler chain as `onPayload`; wrapping that runtime's
// `streamSimple` lets pi-aside see the payload the handler chain returns, which is the request sent, whatever the
// load order. Without the tap (another Pi build), the observation falls back to the R event's payload by reference.

// biome-ignore lint: Pi's runtime is used structurally.
type Any = any;

const TAP = Symbol.for("pi-aside.final-payload-tap");
/** Marks pi-aside's own requests, which the tap ignores. */
export const OWN_REQUEST = Symbol.for("pi-aside.own-request");

interface Tap {
	listener: ((payload: unknown) => void) | undefined;
}

/** Install the tap once per runtime; later calls replace the listener. Returns false when unavailable. */
export function installFinalPayloadTap(modelRegistry: unknown, listener: (payload: unknown) => void): boolean {
	const runtime = (modelRegistry as Any)?.runtime;
	if (!runtime || typeof runtime.streamSimple !== "function") return false;
	const existing: Tap | undefined = runtime[TAP];
	if (existing) {
		existing.listener = listener;
		return true;
	}
	const tap: Tap = { listener };
	const original = runtime.streamSimple;
	runtime.streamSimple = function (this: unknown, model: unknown, context: unknown, options: Any) {
		if (options && !options[OWN_REQUEST] && typeof options.onPayload === "function") {
			const inner = options.onPayload;
			options = {
				...options,
				onPayload: async (payload: unknown, m: unknown) => {
					const result = await inner(payload, m);
					try {
						tap.listener?.(result === undefined ? payload : result);
					} catch {
						// observation only
					}
					return result;
				},
			};
		}
		return original.call(this, model, context, options);
	};
	runtime[TAP] = tap;
	return true;
}

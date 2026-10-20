# pi-aside: design

Status: design, 2026-10-20. Nothing is implemented yet.

pi-aside answers a side question about the running Pi session without touching it. The side question rides on
the main session's prompt cache. It pays the cache-read price for the whole conversation, not the cache-write
price. It never enters the main transcript, never runs the main session's extension hooks and never changes what
the main session sends next.

The command is `/aside <question>`. The npm name `pi-aside` was free on 2026-10-20 (registry 404). The only
`pi-package` with "aside" in its name is `@alexanderbianchi/herdr-aside`, which is a different package.

## 1. Why another side-question package

### 1.1 The cost that matters

A side question needs the whole conversation as context. On Anthropic models the prompt cache is a byte prefix
over `tools → system → messages`. A request that repeats the main session's prefix exactly reads it from cache. A
request that differs anywhere writes everything after the first difference again.

At the owner's prices (input 4, output 20, cache read 0.2 and cache write 5 dollars per million tokens), a question
over a 150K-token session costs:

| Request | Prefix cost |
|---|---|
| repeats the main prefix (cache read) | 150K × 0.2/M ≈ **$0.03** |
| any other prefix (cache write) | 150K × 5/M ≈ **$0.75** |

Each new side thread of a package that misses pays the $0.75 again. The owner spends about $1.5k a day. Side
questions are frequent in long sessions, which is exactly where the gap is widest.

A cache read also restarts the entry's TTL. Anthropic entries refresh on each use within the TTL. An aside asked
while the main session is idle therefore keeps the main session's cache warm as a side effect.

### 1.2 What exists (survey of 61 packages, 2026-10-20)

61 packages match btw/side/aside/qq among the npm packages tagged `pi-package`. The tarballs are in
`/tmp/btw-survey`. The ones that address caching at all:

| Package | How it builds the side request | Effect on the main cache |
|---|---|---|
| `pi-btw` 0.8.0 (installed here) | A child agent session with its own system prompt (adds `<btw_capabilities>`), 4 built-in tools and rebuilt messages (`btw.ts:312-354`, `:517`, `:2148`) | Misses on every new thread |
| `@juicesharp/rpiv-btw` 2.13.9 | Rebuilds the context with `tools: []` (`btw.ts:334`) | Misses. "Cache parity" there means between its own invocations |
| `@cluski/pi-by-the-way` 0.1.0 | Same system prompt and tools; messages rebuilt from the session branch with `convertToLlm` | Hits only when no extension changed the main request. Misses after any `context` rewrite (such as a pi-zip fold) and loses `before_provider_request` changes |
| `@fractaal/pi-btw` 0.1.0 | The post-`context` transcript from `context_with_system`, re-serialized by pi-ai, under a **new** session id. Requires the fractaal fork of Pi | Sees context rewrites, but not `before_provider_request` or header changes. Its README says first-request reuse on OpenAI Codex happens "sometimes" |
| `@elvinw/pi-qq` 0.5.7 | Runs the question as a real main turn on a temporary branch, waits for idle, then rewinds or prunes the session file | Byte-identical by construction, but serial, and every extension hook sees it as a user turn |
| `pi-herdr-btw` 0.3.1 | A child Pi process in another pane that replays the parent's system prompt and native messages | Hits only if the child's own extensions produce the same bytes |
| Claude Code `/btw` (reference) | `runForkedAgent` with "cache-safe params"; no tools | Hits; this is the design this package generalizes |

**The gap.** The request the provider actually receives is produced by Pi plus every extension's `context`,
`context_with_system`, `before_provider_request` and `before_provider_headers` handlers. Every package above rebuilds
some earlier stage of that pipeline, so it misses whenever a later stage changed something.

On this machine a later stage always changes something:
- pi-zip rewrites `context` when it folds;
- pi-zip replaces the payload to add a sticky `metadata.user_id` (`pi-zip/src/run.ts:1566`);
- the sub2api relay routes by that id, and Anthropic caches are per account.

So a rebuilt request can land on another account, which is a full miss even when its bytes are right. No surveyed
package replays the payload as sent.

## 2. Axioms

- **A1. Prefix.** A provider prompt cache is keyed by the exact rendered prefix (Anthropic: `tools → system →
  messages`, plus top-level fields that key the message cache: `model`, `thinking` and, for budget-based thinking,
  `max_tokens`; see Pi's `cache-warmer.js` `isReplayable`). It is also keyed by the routing identity that picks the
  account or shard (`metadata.user_id` through relays, `prompt_cache_key` on OpenAI).
- **A2. Truth.** The only exact copy of that prefix is the payload Pi last sent, after every handler ran.
- **A3. No side effects.** An aside must not change the main session's future requests, transcript, compaction or
  any extension's state.
- **A4. Zero parameters.** No settings. Behaviour follows from A1–A3 and from what the provider reports.
- **A5. Measured.** Every answer shows what the provider reports it read from cache, against what A1 predicts. A
  claim the provider's usage cannot confirm is shown as unconfirmed.

Everything below follows from these five.

## 3. What the user sees

```text
/aside why did it pick that approach?     ask in a fresh fork of the session as it is now
/aside                                    reopen the latest aside
```

The aside opens as an overlay panel, and the main session keeps running underneath.

| Key | Action |
|---|---|
| Enter | Ask a follow-up in the same fork |
| Esc | Hide the panel; a reply in progress continues |
| Ctrl+C | Stop the reply in progress |
| Ctrl+S | Send the discussion back to the main session |
| Ctrl+Y | Copy the discussion |

**Panel header.** It shows what the provider reported for the last request, for example:
- `cache 151,233 / 151,233 read · $0.04`, a confirmed hit;
- `cache 0 / 151,233 · $0.77 (main cache was cold; this also re-warmed it)`.

**Status line.** It shows `aside: replying…` or `aside: reply ready` while the panel is hidden.

Non-interactive modes (RPC, print and JSON) do not open the panel. In RPC mode the answer comes back as a
notification, which is also how the tests drive it (§7). Print and JSON modes refuse with a message.

## 4. Mechanism

### 4.1 Capture: the payload as sent

The extension keeps one capture per session:

```text
Capture = {
  payload,      // reference to the object Pi passes to the provider
  headers,      // reference to the header map from before_provider_headers
  model,        // ctx.model when captured; must satisfy payload.model === model.id (anthropic/openai)
  thinking,     // pi.getThinkingLevel() when captured
  leafId,       // the session leaf when the request was sent
  sentAt,
  firstEventAt, // the first provider stream event of its response (§4.3)
  promptTokens, // input + cacheRead + cacheWrite of its response, once known
}
```

**Which requests count.** A capture is taken in `before_provider_request` only when a `context` event fired since
the last capture. This is pi-zip's replay rule. It excludes Pi's idle cache-warmer replays (sent with
`maxTokens: 1`), compaction and summary calls, and other extensions' nested calls, none of which runs the agent's
`context` stage.

**What is kept.** The capture keeps the reference without cloning it. Handlers that run after pi-aside and mutate
the payload in place are therefore still seen. The payload is deep-cloned only when an aside is asked.

**Headers.** Headers are captured the same way from `before_provider_headers`, whose handlers mutate in place.
Authorization, API key and cookie headers are dropped, because the aside request resolves its own auth.

**When the capture is dropped:**
- `session_compact`, `session_tree` or `session_start`;
- a capture whose `payload.model` does not match the captured model. This happens with virtual-model routing or an
  extension redirect, and the aside then uses tier T1 (§4.8).

**Ordering limit.** Handlers run in extension load order (Pi `runner.js:1066-1094`). A handler that runs after
pi-aside and *replaces* the payload, rather than mutating it, is not seen.
- `pi install` appears to append to the `packages` list (pi-btw, installed last here, is listed last). A newly
  installed pi-aside therefore runs last; on this machine it would follow pi-zip. S0 confirms this.
- A5 catches the remaining case: the hit comes back short of `promptTokens`, and the panel names the likely cause.
- §8 asks Pi upstream for an observe-only event carrying the final payload. pi-aside will feature-detect it.

### 4.2 The fork request

An aside request is the captured payload, with the session's growth since the capture and the question appended:

```text
fork = clone(P)                       // every top-level field verbatim: model, system, tools, tool_choice,
                                      // thinking, max_tokens, metadata, prompt_cache_key, betas, stream
fork.<list> = P.<list> ++ tail        // <list> = messages | input, per API
tail = convert( entries after Capture.leafId on the current branch   // the reply, tool results, steers
              + "still running" results for tool calls without one   // so tool_use is always answered
              + user turn: <aside notice> + question )
```

**Building the tail.** The tail is built by pi-ai's own converter, so its blocks are what Pi would have produced:
1. Call `ctx.modelRegistry.streamSimple(model, { messages: tailMessages }, opts)`. Here `opts` holds the same
   `sessionId`, the same `reasoning` level and the captured headers.
2. In `opts.onPayload`, return the spliced fork in place of the payload pi-ai built.
3. pi-ai then sends the fork and parses the stream as usual.

The request goes through the model runtime directly, so no Pi extension handler runs for it (A3). Pi wires
handlers only into the agent's own `streamFn` (`sdk.js:225-230`).

**Splice adapters, one per API:**

| API | List | Splice rules |
|---|---|---|
| `anthropic-messages` | `messages` | If the tail starts with a user turn and P ends with one, append the blocks to P's last turn instead of adding a second user turn. Keep at most 4 `cache_control` markers (pi-ai already uses system, last tool and last user turn, plus one more system marker with OAuth); drop the tail's marker if the budget is full. Never move or remove P's markers |
| `openai-responses` (HTTP) | `input` | Append the items. `prompt_cache_key` and `store` come from P |
| `openai-completions` | `messages` | Append. Prefix caching is automatic on the providers that cache |

Any other API, or a transport that keeps conversation state, uses T1. Examples are WebSocket sessions with
`previous_response_id` and Claude Bridge.

**The notice** rides in the question's user turn, never in `system`, which is part of the prefix. It says:
- this is a temporary side conversation, and the main agent keeps working;
- only read-only tools run here;
- nothing said here reaches the main session unless the user sends it back.

### 4.3 Timing

An Anthropic cache entry becomes usable only after its response begins. The aside therefore checks the capture's
state before it sends:

| Main session state | Tail | Wait |
|---|---|---|
| request sent, no response event yet | question only | until the first provider stream event (`provider_stream_event` on Pi ≥0.99.1, else the first `message_update`); no time limit, cancellable |
| response streaming | question only | none |
| response done, tools running | reply + "still running" results + question | none |
| idle | reply + tool results + question | none |
| idle past the model's cache TTL (`model.promptCache`, else 300 s) | as idle | none, but the panel says the main cache is cold. This aside writes it and so re-warms it for the main session's next turn |

### 4.4 Tools

Tool declarations stay exactly as P has them, because they are part of the prefix. When the model calls a tool:
- `read`, `grep`, `find` and `ls` run through Pi SDK factories (`createReadTool` etc.) in the session's cwd. The SDK
  instances run no extension hooks.
- Every other tool, including `bash`, gets an error result: "not available in an aside".
- The model then continues. A fork stops after 8 tool rounds, and Ctrl+C stops it earlier.

### 4.5 Follow-ups

A fork is `P ++ tail ++ (question, answer)*`. Each follow-up repeats the fork's own prefix, so it reads the fork's
cache entry when the tail marker fit in the budget. Otherwise it reads P's entry and pays the fork's short suffix as
plain input. `/aside <new question>` always starts a new fork from the main session's current capture.

### 4.6 Accounting

Each aside request is recorded with `ctx.sessionManager.appendUsage("aside", provider, model, usage, note)`. That is
Pi's own usage entry, available on every supported Pi, and it never enters the model context. The note carries:
- the predicted prefix (`promptTokens` of the capture) and the reported cache read;
- the tier (§4.8);
- a SHA-256 of P's canonical JSON, so the evaluator can join the aside to the main request it forked from.

This makes aside spend visible in the session file to pi-ctx-eval's ledger and to any tool that reads usage
entries. pi-btw's spend, by contrast, lives only in memory (`btw.ts:2827`).

Fork transcripts are kept in memory only. They end with the session or the process.

### 4.7 Send back

Ctrl+S sends the discussion to the main session as one custom message, framed as context the user brought back:
- If the main session is running, it is delivered as `steer`.
- If it is idle, it is delivered as `nextTurn`. It rides with the user's next prompt, so pressing Ctrl+S never
  starts a paid turn by itself.

### 4.8 Tiers

| Tier | When | Request | Label in the panel and usage note |
|---|---|---|---|
| T0 exact | A valid capture on a supported API | §4.2 | `exact` |
| T1 rebuilt | No capture yet in this process, the capture was dropped (§4.1), or the API is unsupported | Pi's current context via `convertToLlm` of the branch, with the same system prompt, tools and thinking | `rebuilt: cache not expected` |

T1 exists so that `/aside` always answers. It costs what other packages cost, and it says so.

## 5. Interaction with other software

**pi-zip.**
- pi-zip's handlers never see an aside (§4.2), so its state cannot change.
- The aside keeps pi-zip's sticky `metadata.user_id`, because it is in P.
- An aside read refreshes the main session's cache TTL, which pi-zip's cache model does not know about. pi-zip
  could treat any usage entry with `cacheRead > 0` on the session's model as a refresh signal. That would be a
  generic Pi-format rule, so pi-zip keeps no dependency on pi-aside. It is a pi-zip idea, not part of this package.

**Pi's cache warmer (1.3.0).** The warmer may still replay at 270 s. The replay is a cache read and harmless. No
interaction is needed.

**pi-btw and other btw packages.** They use different commands and coexist.

## 6. Size

| File | Purpose | Lines (estimate) |
|---|---|---|
| `src/capture.ts` | The capture state machine | ~120 |
| `src/fork.ts` | Tail building, splice adapters, breakpoint budget | ~170 |
| `src/thread.ts` | Fork loop, tool policy, usage | ~130 |
| `src/panel.ts` | Overlay | ~140 |
| `src/index.ts` | Wiring and command | ~80 |
| **Total** | | **≤ 700** |

## 7. Acceptance

Everything below runs offline against a capture server unless marked live. The capture server is a local HTTP
server that speaks the Anthropic and OpenAI SSE formats, records every request's body and headers, and plays scripted
responses. Pi is pointed at it through a test `models.json`.

**Supported Pi builds.** 1.1.0, 1.2.0 and 1.3.0 are each built from a pinned lock, as in pi-ctx-eval R6.

**Invariants.**

| ID | Invariant | How it is checked |
|---|---|---|
| I1 | Prefix identity: every top-level field of the first aside request equals P's; its list starts with P's list; P's markers are unchanged | Byte compare of the recorded bodies, for each API |
| I2 | Routing identity: the same `metadata.user_id` / `prompt_cache_key`, and the same non-auth headers as P | Recorded headers and bodies |
| I3 | No side effects: with and without asides interleaved, the main session sends byte-identical later requests and writes identical non-usage session entries | Two scripted runs **with pi-zip 0.4.11 installed** |
| I4 | At most 4 `cache_control` markers, including OAuth | Bodies |
| I5 | Only `read`, `grep`, `find` and `ls` execute; a `bash` or `write` call produces an error result and no process or file change | Scripted tool calls |
| I6 | Each aside request appends exactly one `usage` entry of kind `aside`, and nothing enters the model context | Session file |
| I7 | Timing: an aside asked before the main response begins is sent only after the first stream event | Capture-server event timestamps |
| I8 | Tail conversion equivalence: converting `[history + tail]` and taking the suffix equals converting `[tail]` alone | Unit, over recorded transcripts for each API |

**Mutants.** Each mutant must fail at least one invariant:
- rebuild from the session instead of P;
- a new session id;
- drop `metadata`;
- change `max_tokens`;
- strip or reorder `tools`;
- put the notice in `system`;
- add a fifth marker;
- route the aside through the agent's `streamFn`, which runs the hooks;
- skip the first-event wait;
- execute `bash`.

**Comparison.** The same scripted session is run with pi-zip active, folding and sticky, against
`@cluski/pi-by-the-way`, `@fractaal/pi-btw` (if its Pi fork is installable) and `pi-btw` 0.8.0. The capture server
reports each package's longest common prefix with P, in tokens.

**Live (owner-approved, a few cents).** On relay Claude, run one main turn, then an aside, then a second main turn.
Pass: the aside's `cacheRead` equals the capture's `promptTokens`, and the second main turn's `cacheRead` is not
lower than without the aside. Repeat once on `gateway-gpt`.

## 8. Risks and open points

1. **A later extension replaces the payload.** Mitigated by install order and detected by A5. The upstream ask is
   an observe-only `provider_request_sent { payload, headers }`, or the final payload in `after_provider_response`.
2. **Anthropic consecutive-turn merge.** §4.2 merges the turns explicitly, so the request never relies on the API
   merging them. Spike S1 confirms that the merged turn still reads P's entry.
3. **Relay routing.** The aside reads the main session's cache only if the relay picks the same account. P's
   metadata and headers are replayed verbatim. Spike S3 measures it on relay.
4. **Cold cache.** A cold main cache makes the aside a full write. The panel says so, and the write re-warms the
   main session, so the cost is not wasted if the user continues.
5. **Payload retention.** The capture holds one payload, up to about 1 MB, in memory. It is never written to disk,
   and it is replaced on every main request.
6. **Pi API drift.** Every hook used exists from Pi 0.86.1 to 1.3.0, checked in installed builds:
   - `before_provider_request` and `before_provider_headers`;
   - `appendUsage`;
   - `modelRegistry.streamSimple`.

   `provider_stream_event` needs 0.99.1 or later; earlier builds fall back to `message_update`. CI covers 1.1.0,
   1.2.0 and 1.3.0.

## 9. Plan

| Step | Content | Exit |
|---|---|---|
| S0 spike | Capture server; a hand-made aside on Pi 1.3.0; S1 (merge), S2 (marker budget and OAuth), S3 (relay routing, live, cents), S4 (`openai-responses` key) | Each claim confirmed, or the design changed |
| M1 | `capture.ts`, `fork.ts`, `thread.ts`; I1, I2, I4, I6, I7, I8 on 1.3.0 | Invariants green, mutants killed |
| M2 | Panel and send back; I3 and I5 with pi-zip installed | Green |
| M3 | 1.1.0 and 1.2.0; comparison run; GPT review | LAND |
| M4 | README and release through the OIDC publish workflow | npm `pi-aside` |

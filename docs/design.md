# pi-aside: design

Status: design, revision 2 (2026-10-20). Nothing is implemented yet. Revision 2 answers the GPT design review
(`/tmp/aside-design-review.md`, 12 findings). The resolution of each finding is in §10.

pi-aside answers a side question about the running Pi session at the cache-read price. The aside request is the
request the main session would send next if the question were the user's next message. It is computed without
running any extension hook, and it is sent only after it is checked against the request the main session actually
sent. The aside never enters the main transcript, and it never runs the main session's extension hooks.

The command is `/aside <question>`. The npm name `pi-aside` was free on 2026-10-20 (registry 404). The only
`pi-package` with "aside" in its name is `@alexanderbianchi/herdr-aside`, which is a different package.

## 1. Why another side-question package

### 1.1 The cost that matters

A side question needs the whole conversation as context. On Anthropic models the prompt cache is a prefix over the
rendered `tools → system → messages`. A request whose content matches the main session's cached prefix reads it. A
request that differs anywhere writes everything after the first difference again.

At the owner's prices (input 4, output 20, cache read 0.2 and cache write 5 dollars per million tokens), a question
over a 150K-token session costs:

| Request | Prefix cost |
|---|---|
| matches the main prefix (cache read) | 150K × 0.2/M ≈ **$0.03** |
| any other prefix (cache write) | 150K × 5/M ≈ **$0.75** |

A package that misses pays the $0.75 on every new side thread. The owner spends about $1.5k a day, and side
questions are most frequent in long sessions, where the gap is widest.

A cache read also restarts the entry's TTL, because Anthropic entries refresh on each use within the TTL. An aside
asked while the main session is idle therefore keeps the main session's cache warm.

### 1.2 What exists (survey of 61 packages, 2026-10-20)

61 packages tagged `pi-package` match btw/side/aside/qq. Their tarballs are in `/tmp/btw-survey`. The ones that
address caching:

| Package | How it builds the side request | Effect on the main cache |
|---|---|---|
| `pi-btw` 0.8.0 (installed here) | A child agent session with its own system prompt (adds `<btw_capabilities>`), 4 built-in tools and rebuilt messages (`btw.ts:312-354`, `:517`, `:2148`). Usage goes into its own custom entries (`pi.appendEntry`, `btw.ts:2827`), not into Pi usage entries | Misses on every new thread |
| `@juicesharp/rpiv-btw` 2.13.9 | Rebuilds the context with `tools: []` (`btw.ts:334`) | Misses. "Cache parity" there means between its own invocations |
| `@cluski/pi-by-the-way` 0.1.0 | Same system prompt and tools; messages rebuilt from the session branch with `convertToLlm` | Hits only when no extension changed the main request. Misses after any `context` rewrite (such as a pi-zip fold), and loses `before_provider_request` changes |
| `@fractaal/pi-btw` 0.1.0 | The post-`context` transcript from `context_with_system`, re-serialized by pi-ai under a **new** session id; requires the fractaal fork of Pi | Sees context rewrites, but not `before_provider_request` or header changes. Its README says first-request reuse on OpenAI Codex happens "sometimes" |
| `@elvinw/pi-qq` 0.5.7 | Runs the question as a real main turn on a temporary branch, then rewinds or prunes the session file | Matches by construction, but is serial, and every extension hook sees it as a user turn |
| `pi-herdr-btw` 0.3.1 | A child Pi process in another pane replays the parent's system prompt and native messages | Hits only if the child's own extensions produce the same bytes |
| Claude Code `/btw` (reference) | `runForkedAgent` with "cache-safe params"; no tools | Hits. Its private implementation was not inspected |

**The gap.** The request the provider receives is produced by Pi plus every extension's `context`,
`context_with_system`, `before_provider_request` and `before_provider_headers` handlers. Each package above rebuilds
an earlier stage of that pipeline, so it misses whenever a later stage changed something.

On this machine a later stage always changes something:
- pi-zip rewrites the transcript when it folds;
- pi-zip replaces the payload to add a sticky `metadata.user_id` (`pi-zip/src/run.ts:1566`);
- the sub2api relay routes by that id, and Anthropic caches are per account.

A request without that id can land on another account, which is a full miss even when its content is right. No
surveyed package carries the handler changes over.

## 2. Axioms

- **A1. Prefix.** A provider prompt cache is keyed by:
  - the rendered content up to a breakpoint (Anthropic: `tools → system → messages`; the `cache_control` markers
    themselves move every turn and are not part of the key);
  - the top-level fields that key the message cache: `model`, `thinking`, and `max_tokens` under budget-based
    thinking (Pi `cache-warmer.js`, `isReplayable`);
  - the routing identity that picks the account or shard: `metadata.user_id` through relays, `prompt_cache_key` on
    OpenAI.
- **A2. Truth.** The only exact record of what the main session sends is the payload Pi hands to the provider
  after every handler ran. pi-aside observes it at its own position among the handlers (§4.1), so every guarantee
  is stated relative to that observation.
- **A3. No hooks, no transcript.** An aside runs no extension hook and adds nothing to the model context. Its one
  session write is a Pi usage entry (§4.6), the same kind Pi's own cache warmer writes. Effects through the shared
  provider cache, such as a refreshed TTL, are intended, and they are reported.
- **A4. Zero parameters.** No settings. Behaviour follows from A1–A3 and from what the provider reports.
- **A5. Checked, then measured.** An aside is sent at tier T0 only after a local check proves its content and
  routing fields extend the observed request. Each answer shows the provider's cache read against the cacheable
  prefix the main response reported. Usage numbers are observations, never proof.

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

**Panel header.** It shows the tier and what the provider reported:
- `exact · read 151,040 of 151,040 cacheable · $0.04`;
- `exact · read 0, wrote 151,040 · $0.77` — the provider wrote instead of reading. The usual cause is an expired
  main cache, and this write re-warms it for the main session's next turn;
- `rebuilt · not expected to hit` (§4.8).

**Status line.** It shows `aside: replying…` or `aside: reply ready` while the panel is hidden.

**Other modes.** RPC mode returns the answer as a notification, which is also how the tests drive it (§7). Print
and JSON modes refuse with a message.

## 4. Mechanism

### 4.1 Observation

pi-aside keeps one **observation** per session. It is assembled over one logical agent request:

| Event | Recorded |
|---|---|
| `context_with_system` | Starts a logical request L. Records the transcript `T` (agent messages, system messages included) as it stands after the handlers before pi-aside, and the session leaf |
| `before_provider_request` within L | One **attempt**: a reference to the payload. A retry inside pi-ai, such as Anthropic's strict-tools fallback (`anthropic-messages.js:436-454`), adds another attempt |
| `before_provider_headers` within L | The attempt's header map, by reference, because handlers mutate it in place |
| `after_provider_response`, status 2xx | Promotes the latest attempt. L closes, and its observation replaces the previous one |
| `provider_stream_event` (Pi ≥0.99.1) | The physical provider, API and model id of the promoted attempt |
| main response `message_end` | Its usage. `cacheRead + cacheWrite` is the **cacheable prefix**: the tokens before P's last breakpoint |

Rules:
- **Gate.** `before_provider_request` outside an open L is ignored. That covers Pi's warmer replays (sent with
  `maxTokens: 1`) and anything else replayed without the agent's `context` stage. Compaction and extension
  summaries go through `modelRegistry.streamSimple` and run no hook.
- **Cloning.** Attempts are kept by reference and cloned only when promoted. Handlers after pi-aside that mutate in
  place are therefore seen.
- **Dropping.** The observation is dropped on `session_compact`, `session_tree`, `session_start` and
  `session_shutdown`.
- **Ordering limit.** Handlers run in extension load order (`runner.js:1066-1094`). A later handler that *replaces*
  the object is not seen, nor is a later `context_with_system` handler. Built-in and inline extensions can load
  after packages (`resource-loader.js:571`). Every guarantee is therefore relative to the observation (A2).
  - A new `pi install` appears to append to the `packages` list, so pi-aside usually runs last among packages. S0
    confirms this.
  - The upstream ask is an observe-only event carrying the final payload and headers (§8).

The **promoted payload** is called P below.

### 4.2 The aside request: next request, handler-free

The aside does not splice provider payloads by hand. It asks pi-ai to convert the whole fork and compares the
result against P.

```text
T     = observed transcript (post-context, system and tool-state messages included)
G     = what the branch gained since the observation's leaf: the reply, tool results, steers;
        plus "still running" results for tool calls that have none yet
Q     = user message: <aside notice> + question
conv  = the agent's convertToLlm (with the session's image blocking), then pi-ai's provider conversion,
        same physical model, same reasoning level, same sessionId, cache retention as the main session

B0 = conv(T)            dry: an onPayload hook records the payload and aborts before any HTTP call
B1 = conv(T ++ G ++ Q)  the real request; its onPayload returns F
ΔH = diff(B0, P)        what handlers after Pi's conversion changed
ΔG = diff(B0, B1)       what the fork adds
F  = B1 with ΔH applied
```

**Tier T0 is used only if all three checks pass.** Otherwise the aside uses T1 (§4.8). Comparisons strip
`cache_control` markers.

| Check | Meaning | Typical failure |
|---|---|---|
| C1 `ΔH` touches top-level fields only | Handlers changed fields such as `metadata` or `max_tokens`, never the content list. The content list of B0 equals P's | A handler rewrote messages in `before_provider_request`; the reproduction is off (convertToLlm settings, version drift) |
| C2 `ΔG` touches the content list only, by appending | `B1.list` extends `B0.list`. The last element of `B0.list` may be extended by appended blocks of the same role. `system`, `tools`, `betas` and every other top-level field are equal | The gain carries a system or tool-set change; a provider-specific rule rewrote the boundary |
| C3 `F`'s top-level fields equal P's, and `strip(F.list)` extends `strip(P.list)` | Follows from C1 and C2, and is checked anyway on the bytes sent | — |

Why this is enough:
- Every block of the fork is produced by pi-ai's own converter over the full transcript. The provider rules
  therefore hold, because pi-ai already obeys them for the main session: turn merging, tool_use/tool_result
  pairing, thinking signatures, Responses item IDs and encrypted reasoning, and `store:false`.
- Tool state for conversion *and parsing* comes from the same transcript, for example OAuth tool-name mapping and
  Responses custom tools.
- Markers are placed by pi-ai exactly as in the main session's next request. That request reads the main cache
  every turn by design, and it never exceeds the marker limit.
- The request is sent through `ctx.modelRegistry.streamSimple`, which runs no extension hook. Pi wires handlers
  only into the agent's `streamFn` (`sdk.js:225-230`).

**Routing and headers:**
- The physical model comes from the observation, never from `ctx.model`, so a virtual model's router is not
  invoked.
- The headers are the observed map with auth keys replaced by fresh `getApiKeyAndHeaders` values. Provider-derived
  headers are recomputed by pi-ai from the full fork context; for example, Copilot's vision header sees the images
  in T.
- The endpoint is resolved by the same auth path. `ResolvedRequestAuth.baseUrl` is recorded at observation and at
  aside time, and a difference forces T1.

**Supported APIs for T0:** `anthropic-messages`, `openai-responses` over HTTP, and `openai-completions`. The only
API-specific knowledge is the name of the content list (`messages` or `input`) and the marker key. A payload with
`previous_response_id`, a WebSocket transport, or a provider that keeps conversation state uses T1.

**The notice** rides in Q, never in `system`. It says:
- this is a temporary side conversation, and the main agent keeps working;
- only read-only tools run here;
- nothing said here reaches the main session unless the user sends it back.

### 4.3 Timing

An Anthropic cache entry is usable only after its response begins. The aside therefore checks the state of L and
the observation:

| State | Action |
|---|---|
| L open, no 2xx response yet | Wait for promotion. The wait ends on the 2xx response, or on the attempt's failure, abort, `agent_end`, session switch or shutdown. On failure, the previous observation is used if the branch still extends it; otherwise T1 |
| Observation promoted, response streaming or done | Send now. G holds what has landed, with "still running" results where needed |
| No observation in this process | T1 |

The panel never calls the main cache "cold" because of elapsed time alone, since Pi's warmer may have refreshed
it. It reports what the provider wrote and read.

### 4.4 Tools

Tool declarations stay exactly as in P, because they are part of the prefix. When the model calls a tool:
- `read`, `grep`, `find` and `ls` run through Pi SDK factories (`createReadTool` etc.) in the session's cwd. These
  SDK instances run no extension hook.
- Every other tool gets an error result: "not available in an aside".
- The fork continues. It stops after 8 tool rounds, and Ctrl+C stops it earlier.

### 4.5 Follow-ups

A follow-up converts `T ++ G ++ Q ++ A1 ++ Q2` the same way and checks it against P with C1–C3. Its content
extends the first aside request, so it reads the fork's own cache entry. `/aside <new question>` always starts a
new fork from the latest observation.

### 4.6 Accounting

Each aside request appends one Pi usage entry: `appendUsage("aside", provider, model, usage, note)`.
- The entry stays out of the model context, as the warmer's `cache_warm` entries do.
- **Deferred while the main agent runs.** A usage entry advances the session leaf
  (`session-manager.js:815,864`), so mid-run writes are queued until `agent_settled`. The main run's own entries
  then never get an aside as parent.
- **The note** carries:
  - the tier;
  - the predicted cacheable prefix and the reported read;
  - a SHA-256 of P's canonical JSON, which joins the aside to the main request it forked from.

pi-ctx-eval's ledger reads usage entries, so aside spend is visible to it with no special case.

Fork transcripts live in memory only, bound to the session that created them. A session switch aborts them.

### 4.7 Send back

Ctrl+S sends the discussion to the main session as one custom message, framed as context the user brought back:
- If the main session is running, it is delivered as `steer`.
- If it is idle, it is delivered as `nextTurn`, so it rides with the user's next prompt. Ctrl+S never starts a paid
  turn by itself.

### 4.8 Tiers

| Tier | When | Request | Label |
|---|---|---|---|
| T0 exact | An observation exists, the API is supported, and C1–C3 pass | §4.2 | `exact` |
| T1 rebuilt | Anything else | `conv(branch ++ Q)` on the last physical model; the virtual router (`reason: "direct"`) only if no physical model is known | `rebuilt: not expected to hit`, plus the failed check |

T1 exists so that `/aside` always answers. It costs what other packages cost, and it says so.

## 5. Interaction with other software

### pi-zip
- pi-zip's handlers never see an aside, so its state cannot change through hooks.
- P carries pi-zip's sticky `metadata.user_id`, and C1 accepts it as a top-level handler change, so the aside
  routes to the same account.
- **Known effect.** An aside's read refreshes the main cache. pi-zip's clock (`cache.ts:93-101`) counts messages
  and `cache_warm` usage entries only, so after an aside it may think the cache expired and fold, rewriting a
  prefix that was in fact warm.
  - **pi-zip 0.4.12 item:** count any usage entry on the branch as a touch when its `cacheRead` is at least the
    last main response's cacheable prefix, whatever its kind. This rule reads Pi's own entry format only, so
    pi-zip keeps no dependency on pi-aside.
  - pi-zip's learned cache-survival statistics (`run.ts:1602`) will also see longer survival. That is real, and
    intended.

### Other software
- **Pi's cache warmer (1.3.0).** It may still replay at 270 s. The replay is a cache read and harmless.
- **pi-btw and other btw packages.** They use different commands and coexist.

## 6. Size

| File | Purpose | Lines (estimate) |
|---|---|---|
| `src/observe.ts` | Logical requests, attempts, promotion, gate | ~130 |
| `src/fork.ts` | Dry conversion, ΔH/ΔG, C1–C3, per-API list table | ~150 |
| `src/thread.ts` | Fork loop, tool policy, deferred usage | ~130 |
| `src/panel.ts` | Overlay | ~140 |
| `src/index.ts` | Wiring and command | ~80 |
| **Total** | | **≤ 650** |

## 7. Acceptance

Everything below runs offline against a capture server unless marked live. The capture server is a local HTTP
server that speaks the Anthropic and OpenAI SSE formats, records every request's body, URL and headers, and plays
scripted responses. Pi is pointed at it through a test `models.json`.

**Supported Pi builds.** 1.1.0, 1.2.0 and 1.3.0 are each built from a pinned lock, as in pi-ctx-eval R6.

**The oracle.** For each scripted state, the same question is also sent as a real next user message on a scratch
copy of the session. That request O is the main session's true next request. The aside's T0 request must equal O
in content and routing fields, except for the notice.

**Invariants.**

| ID | Invariant | How it is checked |
|---|---|---|
| I1 | T0 content: the aside equals the oracle O, notice excepted; its marker-stripped list extends P's; every top-level field equals P's | Recorded bodies, for each API |
| I2 | Routing: same URL, `metadata.user_id` / `prompt_cache_key`, non-auth headers as P; provider-derived headers as O's | Recorded requests; includes image-in-T with image-free G, and changed auth or endpoint (must give T1) |
| I3 | No hooks, no transcript: with and without asides interleaved, the main session's later requests are byte-identical, and its session entries are identical once usage entries are removed and parents re-linked | Two scripted runs **with pi-zip 0.4.11 installed** and with a spy extension counting every hook call |
| I4 | At most 4 `cache_control` markers, OAuth included | Bodies |
| I5 | Only `read`, `grep`, `find` and `ls` execute; a `bash` or `write` call produces an error result and no process or file change | Scripted tool calls |
| I6 | Exactly one `aside` usage entry per aside request, written only while the main agent is idle; nothing in the model context | Session file, with an aside asked mid-run |
| I7 | Timing and lifecycle: no aside request is sent before its observation's 2xx response; the wait ends on failure, abort, empty stream, retry or session switch | Capture-server timestamps; failing and empty streams; strict-tools retry; session switch mid-wait |
| I8 | Checks are sound: every state where C1–C3 pass satisfies I1, and every scripted defect makes them fail | Fixtures: P ending in user, assistant or tool results; native system and tool changes in G; steers; images; unsigned cross-provider history; signed and encrypted reasoning; `store:false`; Responses custom tools; model or thinking change since the observation |

**Mutants.** Each mutant must fail at least one invariant:
- rebuild from the session instead of T;
- a new session id;
- drop `metadata`;
- change `max_tokens`;
- strip or reorder `tools`;
- put the notice in `system`;
- add a fifth marker;
- route the aside through the agent's `streamFn`, which runs the hooks;
- skip the promotion wait;
- execute `bash`;
- a later handler replacing the payload, where a spy extension loads after pi-aside (the aside must label the
  shortfall, not claim a hit);
- keep the first attempt instead of the promoted one after a strict-tools retry;
- convert G alone and splice it (losing tool declarations, duplicating Responses IDs);
- drop provider-derived headers;
- use `ctx.model` under a virtual model;
- write usage mid-run.

**Comparison.** The same scripted session runs with pi-zip active (folding and sticky) against
`@cluski/pi-by-the-way`, `@fractaal/pi-btw` (if its Pi fork is installable) and `pi-btw` 0.8.0. The capture server
reports each package's longest common prefix with O, in tokens, and whether `metadata.user_id` matched.

**Live (owner-approved, a few cents).** On relay Claude, run one main turn, then an aside, then a second main turn.
Pass:
- the aside's `cacheRead` equals the first main response's cacheable prefix;
- the second main turn's `cacheRead` is not lower than in a run without the aside.

Repeat once on `gateway-gpt`.

## 8. Risks and open points

1. **A later extension replaces the payload or the transcript.** Every claim is relative to the observation (A2).
   A shortfall shows in the panel, and the ordering is confirmed in S0.
   - The upstream ask is an observe-only `provider_request_sent { payload, headers, url }` event, or the final
     payload in `after_provider_response`. pi-aside would feature-detect it and drop the ordering limit.
   - A provider decorator would observe the final payload too. It is rejected: it would put pi-aside in the main
     request path and wrap every provider.
2. **The dry conversion must send nothing.** S0 checks, per API and per Pi build, that an `onPayload` hook that
   aborts prevents the HTTP call.
3. **Relay routing.** Same metadata, headers and endpoint; S3 measures it on relay.
4. **Payload retention.** One observation holds P, T and B0, a few MB at most. It is never written to disk and is
   replaced on every main request.
5. **Pi API drift.** Every hook used exists from Pi 0.86.1 to 1.3.0 (checked in installed builds):
   - `before_provider_request`, `before_provider_headers` and `after_provider_response`;
   - `appendUsage`, `modelRegistry.streamSimple` and `convertToLlm`.

   Two hooks are newer:
   - `context_with_system` appears from 0.87.1;
   - `provider_stream_event` appears from 0.99.1. Without it, the physical model comes from P's `model` field
     matched against the registry, and an ambiguous match gives T1.

   CI covers 1.1.0, 1.2.0 and 1.3.0.

## 9. Plan

| Step | Content | Exit |
|---|---|---|
| S0 spike | Capture server. A hand-made aside on Pi 1.3.0. Five checks:<br>S1: consecutive-turn behaviour and reading the main entry;<br>S2: the dry conversion sends nothing;<br>S3: relay routing, live, a few cents;<br>S4: the `openai-responses` cache key;<br>S5: `pi install` order | Each claim confirmed, or the design changed |
| M1 | `observe.ts`, `fork.ts`, `thread.ts`; I1, I2, I4, I6, I7 and I8 on 1.3.0 | Invariants green, mutants killed |
| M2 | Panel and send back; I3 and I5 with pi-zip installed | Green |
| M3 | 1.1.0 and 1.2.0; comparison run; GPT review | LAND |
| M4 | README and release through the OIDC publish workflow | npm `pi-aside` |

## 10. Review resolutions (revision 2)

| # | Finding | Resolution |
|---|---|---|
| 1 | The capture is not necessarily what was sent; usage cannot certify it | A2 makes every claim relative to the observation. A5: usage numbers are observations. Upstream ask and the rejected provider decorator are in §8.1. Late-replacement mutant added |
| 2 | One `context` event can produce several wire attempts | Logical request L with attempts; promotion on a 2xx response (§4.1). Strict-tools retry fixture and mutant |
| 3 | Tail-only conversion loses system and tool state, conversion and parsing | No tail conversion: the whole fork is converted (§4.2). C2 rejects gains that change system or tools |
| 4 | Responses item IDs are positional | Whole-fork conversion gives globally consistent IDs, and C2 verifies the shared region |
| 5 | The splice contradicted I1; assistant boundaries unspecified | No hand splice. C2 defines "extends" over the marker-stripped list, last element included. I1 is redefined against the oracle O |
| 6 | Captured headers miss provider-derived headers; auth can change the endpoint | Provider headers are recomputed from the full fork context; auth headers are fresh; an endpoint difference forces T1. I2 extended |
| 7 | `appendUsage` advances the leaf | A3 permits exactly that write, like Pi's warmer. It is deferred to idle. I3 compares with usage entries removed and parents re-linked |
| 8 | Warming changes pi-zip's later state | A3 narrowed to "no hooks, no transcript"; cache effects are intended and reported. pi-zip 0.4.12 item in §5 |
| 9 | A virtual model reruns the router | Physical model pinned from the observation. T1 uses the router only when no physical model is known, and labels it |
| 10 | The wait lacks terminal and lifecycle transitions | §4.3 ends the wait on failure, abort, `agent_end`, switch and shutdown. I7 extended |
| 11 | Exact cache-read equality is the wrong threshold | The prediction is the main response's `cacheRead + cacheWrite`. "Cold" is never claimed from time alone |
| 12 | Wrong claims about pi-btw and pi-zip | pi-btw persists usage in custom entries. pi-zip registers `context_with_system`, and the attempt gate is pi-aside's own rule |

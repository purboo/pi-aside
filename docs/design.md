# pi-aside: design

Status: design, revision 4 (2026-10-20). Nothing is implemented yet.
- Revision 2 answers the first GPT design review (`/tmp/aside-design-review.md`, 12 findings); see §10.
- Revision 3 answers the re-review (7 findings, no P0); see §11. Its rule: **attribution selects a candidate, checks
  prove it**. No guarantee rests on event timing alone.
- Revision 4 answers the second re-review (4 findings); see §12. Credentials follow the **next-request rule**: the
  aside uses Pi's auth resolution at send time, as the main session's next request would.

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
  - the routing identity that picks the account or shard: the credential, `metadata.user_id` through relays,
    `prompt_cache_key` on OpenAI.
- **A2. Truth.** The only exact record of what the main session sends is the payload Pi hands to the provider
  after every handler ran. pi-aside observes it at its own position among the handlers (§4.1), so every guarantee
  is stated relative to that observation.
- **A3. No hooks, no transcript.** An aside runs no extension hook and adds nothing to the model context. Its one
  session write is a Pi usage entry (§4.6), the same kind Pi's own cache warmer writes. Effects through the shared
  provider cache, such as a refreshed TTL, are intended, and they are reported. Effects through other extensions'
  reading of usage entries are reported, not prevented (§5).
- **A4. Zero parameters.** No settings. Behaviour follows from A1–A3 and from what the provider reports.
- **A5. Checked, then measured.** An aside is sent at tier T0 only after a local check proves that its content and
  its body's routing fields extend the observed request. Its credential and endpoint are Pi's at send time, as for
  the main session's next request (§4.2); no extension can prove them equal to P's. Event order only *selects* the
  candidate; the checks decide. Each
  answer shows the provider's cache read against the cacheable prefix the main response reported. Usage numbers
  are observations, never proof.

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
- `rebuilt · not expected to hit` plus the reason (§4.8).

**Status line.** It shows `aside: replying…` or `aside: reply ready` while the panel is hidden.

**Other modes.** RPC mode returns the answer as a notification, which is also how the tests drive it (§7). Print
and JSON modes refuse with a message.

## 4. Mechanism

### 4.1 Observation

pi-aside keeps one **observation** per session. It is assembled over one logical agent request L.

**How Pi emits provider events.** Each `streamSimple` call is one **stream call**:
- `before_provider_headers` (H) fires once, inside request preparation (`transformHeaders`, `sdk.js:204`), after
  auth is resolved;
- `before_provider_request` (R) fires once per wire attempt. pi-ai's own retry for a rejected strict-tools request
  adds an R (`anthropic-messages.js:436-454`). SDK-level retries resend the same payload without a new R;
- `after_provider_response` (S) fires at most once, on success only, before any provider event is read
  (`anthropic-messages.js:478`). A failed attempt emits nothing.

Pi's cache warmer (1.3.0) also produces stream calls. It copies the agent's request options, including the
callbacks, so its H, R and S reach every handler (`cache-warmer.js:238`). It fires `cache_warming_decision` before
each replay, and its payload carries `maxTokens: 1`. It never produces agent message events.

| Event | Recorded |
|---|---|
| `context_with_system` | Opens L. Records the transcript `T` (agent messages, system and tool-state messages included) as it stands after the handlers before pi-aside, the session leaf, and the **recipe** R (below) |
| first H in L | Starts L's main stream call. Keeps the header map by reference (handlers mutate it in place) |
| R in L's main call | One attempt, kept by reference |
| S of L's main call | **Promotes** the latest attempt: it is cloned and becomes P. L closes |
| first main-assistant `message_update`, or its `message_end` | Marks the observation **ready** (below). `message_end` also gives the usage: `cacheRead + cacheWrite` is the **cacheable prefix** |
| `provider_stream_event` (Pi ≥0.99.1) | The physical provider, API and model id of the promoted call |

**Attribution rules.**
- **Ambiguity.** L is ambiguous, and promotes nothing, if any of the following arrives before its main call's S:
  - a second H;
  - a `cache_warming_decision`;
  - an R or S not preceded by L's first H.
- **Closing.** L closes on S, on the main assistant's `message_end` (an error or abort without S), on `agent_end`,
  or on a session event. After that, H, R and S are ignored until the next `context_with_system`. Pi's warmer and
  anything else replayed without the `context` stage can therefore only reach an observation by being mistaken
  inside an open L.
- **Mistaken payloads fail.** That mistake cannot pass C1 (§4.2): a warmer payload differs from `conv_R(T)` in
  `max_tokens`, which the recipe controls.

**Readiness is separate from promotion.** An Anthropic cache entry is usable once the response has begun, but S
fires before any provider event is read; a 2xx with a withheld body is not a started response. The observation is
therefore ready on the first `message_update` of the main assistant message, or on its `message_end`. Agent
message events come only from the agent loop, never from the warmer or other `streamSimple` callers, so they need no
attribution.

**APIs without S.** Google adapters never call `onResponse` (`google-generative-ai.js:49`), and neither does Codex's
WebSocket path (`openai-codex-responses.js:198`). These APIs are not T0 APIs (§4.2), so an aside on them goes to
T1 at once instead of waiting for an event that never comes.

**The recipe R.** The conversion inputs are frozen at `context_with_system`:
- the physical model and API;
- the effective reasoning level and the thinking budgets;
- the token limit and cache retention;
- the session id and transport;
- image blocking, and the agent's `convertToLlm`.

Both conversions in §4.2 use the same R, so a later `/model` or thinking change does not touch an aside of this
observation. An R that does not reproduce P fails C1, and the aside falls to T1.

Other rules:
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

### 4.2 The aside request: next request, handler-free

The aside does not splice provider payloads by hand. It asks pi-ai to convert the whole fork and compares the
result against P.

```text
T      = observed transcript (post-context, system and tool-state messages included)
G      = what the branch gained since the observation's leaf: the reply, tool results, steers;
         plus "still running" results for tool calls that have none yet
Q      = user message: <aside notice> + question
conv_R = the agent's convertToLlm, then pi-ai's provider conversion, under the frozen recipe R

B0 = conv_R(T)            dry: an onPayload hook records the payload and aborts; no inference request is sent
B1 = conv_R(T ++ G ++ Q)  the real request; its onPayload returns F
ΔH = diff(B0, P)          what handlers after Pi's conversion changed
F  = B1 with ΔH applied
```

**The context passed to pi-ai.** T's system and tool-state messages go in as transcript messages, which the agent
loop passes through `normalizeContext`. The legacy `systemPrompt` and `tools` fields are never set as well: doing so
would add a second system message.

**The dry run.** The abort happens in `onPayload`, after auth resolution and before the inference request. Resolving
auth may itself refresh an OAuth token, for example Copilot's (`github-copilot.js:247`). The main session's next
request would do the same.

**Normalisation.** `strip()` removes `cache_control` markers. It also writes a string-valued message content as one
text block, because pi-ai turns the last user message's string into a block when it attaches a marker
(`anthropic-messages.js:1236-1241`), and that message is no longer last in B1.

**Terminal configuration items.** pi-ai appends items after the conversation that describe the request, not the
history:

| API | Trailing item E | Source |
|---|---|---|
| `anthropic-messages` (native effort) | `{role: "system", content: [], output_config: {effort}}` | `insertThinkingLevelMessages`, `anthropic-messages.js:1250` |
| `openai-responses` | `configuration_update` | `openai-responses-shared.js:278` |
| `openai-completions` | none | — |

Each list is split as `list = core ++ E`, where E is the longest run of trailing items of the API's E shape. Inside
B1, the effort of an earlier assistant turn stays in the core as its historical item. Only the trailing items are
split off.

**Tier T0 is used only if all three checks pass.** Otherwise the aside uses T1 (§4.8).

| Check | Meaning | Typical failure |
|---|---|---|
| C1 `ΔH` touches only fields the recipe does not control, and `strip(B0.list) = strip(P.list)` | Handlers may change routing and annotation fields such as `metadata` or `prompt_cache_key`. They may not change the recipe-controlled fields: the content list, `system`/`instructions`, `tools`, `tool_choice`, `model`, the token limits, `thinking`/`reasoning`/`output_config`, and `stream` | A handler rewrote messages; R does not reproduce P (settings, version drift); a mistaken warmer payload (`max_tokens: 1`) |
| C2 the fork appends to the core | `E(B1) = E(B0)`, and `strip(core(B1))` extends `strip(core(B0))`. The last core element of B0 may be extended by appended blocks of the same role. P's last cache marker lies inside `core(B0)`. Every other top-level field is equal | The gain carries a system or tool-set change; a provider rule rewrote the boundary |
| C3 on the bytes sent: `F`'s top-level fields equal P's, and `strip(core(F))` extends `strip(core(P))` | Follows from C1 and C2, and is checked anyway | — |

The concurrent case is common. The aside is asked while the main reply streams, so G has no completed reply. On a
native-effort model this gives `B0 = …, user, E` and `B1 = …, user ⊕ question, E`. With E split off, the core
comparison passes, and the effort is unchanged.

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

**Routing.**
- *Model.* The physical model comes from the observation, never from `ctx.model`, so a virtual model's router is
  not invoked.
- *Credential and endpoint: the next-request rule.* The aside passes no `apiKey`, no `baseUrl` and no auth header.
  Pi resolves auth once, inside the aside's own send (`prepareRequest`, `model-runtime.js:452`), exactly as it will
  for the main session's next request. Pi's own warmer replays the same way. Nothing is checked before the send, so
  no window exists between a check and the send.
  - *Why not bind to P's credential.* Pi keeps the main call's resolution local to `prepareRequest`.
    - A second lookup (`getApiKeyAndHeaders`) is a new resolution: it can differ, and it can refresh an OAuth token.
    - An explicit key does not pin the send either, because header-only credentials and the endpoint are resolved
      again (`model-runtime.js:465-471`).
    - The re-review reproduced both (§12).
  - *Why this is not a weaker tier.*
    - If the credential is unchanged, which is the normal case, the aside reads P's cache.
    - If it changed, the main session's next request misses P's cache too, and the aside writes the entry that
      request will read.
    - T1 would use the same credential and carry less, so it is never better.

    Credential identity therefore never decides the tier. The panel reports the read (A5).
- *Headers.* The final map is `F ⊕ X`, in the order Pi uses (`sdk.js:204`, `provider-attribution.js:60`):
  - X is what Pi's resolution produces for the aside: auth and configured headers, as passed to the aside's
    `transformHeaders`.
  - F is the observed map restricted to the names of Pi's session and attribution headers: `x-opencode-session`,
    `x-opencode-client`, `HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`,
    `X-BILLING-INVOKE-ORIGIN` and `User-Agent`. None of them carries a secret. The table is copied from each
    supported build's `provider-attribution.js`, and CI checks it per build.
  - No other observed name is carried. It came from an earlier auth resolution or from a handler, and the two cannot
    be told apart, so carrying it could send a stale credential to a new endpoint. Its name, never its value, goes
    into the note and the panel (`headers not carried: …`), and the hit is then unproven.
  - Provider-derived headers and SDK-generated auth are added by pi-ai after `transformHeaders`, from the full fork
    context. For example, Copilot's vision header sees the images in T.

**Supported APIs for T0:** `anthropic-messages`, `openai-responses` and `openai-completions`, each only over a
stateless HTTP/SSE transport.
- A payload with `previous_response_id`, a WebSocket transport, or a provider that keeps conversation or connection
  state uses T1.
- `openai-codex-responses` is always T1.
- S0 checks, per T0 adapter, that the session id keys no client-side state: no socket and no continuation cache.
- The only API-specific knowledge is in one table: the name of the content list (`messages` or `input`), the
  marker key, and the shape of E.

**The notice** rides in Q, never in `system`. It says:
- this is a temporary side conversation, and the main agent keeps working;
- only read-only tools run here;
- nothing said here reaches the main session unless the user sends it back.

### 4.3 Timing

| State of the latest L | Action |
|---|---|
| Open, not promoted | Wait for promotion, then for readiness |
| Promoted, not ready | Wait for readiness |
| Ready | Send now. G holds what has landed, with "still running" results where needed |
| Ambiguous, failed or aborted | Use the previous observation if it is ready and the branch still extends it; otherwise T1 |
| API without S, or no observation in this process | T1 at once |

Any wait also ends on the main assistant's `message_end` with an error or abort, on `agent_end`, on a session switch
and on shutdown. The decision is then made from the table again.

The panel never calls the main cache "cold" because of elapsed time alone, since Pi's warmer may have refreshed
it. It reports what the provider wrote and read.

### 4.4 Tools

Tool declarations stay exactly as in P, because they are part of the prefix. When the model calls a tool:
- `read`, `grep`, `find` and `ls` run through Pi SDK factories (`createReadTool` etc.) in the session's cwd. These
  SDK instances run no extension hook.
- Every other tool gets an error result: "not available in an aside".
- The fork continues. It stops after 8 tool rounds, and Ctrl+C stops it earlier.

### 4.5 Follow-ups

A follow-up converts `T ++ G ++ Q ++ A1 ++ Q2` under the same R and checks it against P with C1–C3. Its content
extends the first aside request, so it reads the fork's own cache entry. `/aside <new question>` always starts a
new fork from the latest observation.

### 4.6 Accounting

Each aside request appends one Pi usage entry: `appendUsage("aside", provider, model, usage, note)`.
- The entry stays out of the model context, as the warmer's `cache_warm` entries do.
- **The note** carries:
  - the tier;
  - the predicted cacheable prefix and the reported read;
  - a SHA-256 of P's canonical JSON, which joins the aside to the main request it forked from.

**Writes only when idle.** A usage entry advances the session leaf (`session-manager.js:815,864`), so entries are
queued with their origin session id and written by a drain.
- Whenever the queue becomes non-empty, one drain task runs. It loops:
  1. `await waitForIdle()`. The function is kept from the context of the `/aside` command that queued the entry,
     since only a command context has it (Pi 1.1.0 included);
  2. then, with no `await` in between, check `ctx.isIdle()` and that the current session is the origin;
  3. if both hold, append every queued entry; otherwise loop.
- This covers every return to idle, not only `agent_settled`. Two examples:
  - a preparation failure resolves idle waiters without emitting settled (`agent-session.js:1399`);
  - manual compaction clears the busy state on its own (`:2182`).
- On `session_before_switch`, `session_before_fork` and `session_shutdown`, the queue is flushed synchronously if the
  session is idle. If it is not, the entries are dropped, and the status line says how many were not recorded.

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
| T0 exact | A ready observation exists, the API and transport are supported, and C1–C3 pass | §4.2 | `exact` |
| T1 rebuilt | Anything else | `conv(branch ++ Q)` on the last physical model; the virtual router (`reason: "direct"`) only if no physical model is known | `rebuilt: not expected to hit`, plus the reason |

**T1 is isolated from the main session's transport state.** It uses:
- a fresh session id;
- a stateless transport (`sse` where the adapter offers a choice);
- no `previous_response_id`.

For example, Codex's default `auto` transport would otherwise reuse the main session's socket and replace its
continuation state (`openai-codex-responses.js:890`, `:1215`). An API with no stateless transport refuses the aside
with a message.

T1 exists so that `/aside` always answers. It costs what other packages cost, and it says so.

## 5. Interaction with other software

### pi-zip
- pi-zip's handlers never see an aside, so its state cannot change through hooks.
- P carries pi-zip's sticky `metadata.user_id`. C1 accepts it as a handler change to a field the recipe does not
  control, so the aside routes to the same account.
- **Known effect.** An aside's read refreshes the main cache. pi-zip's clock (`cache.ts:93-101`) counts messages
  and `cache_warm` usage entries only, so after an aside it may think the cache expired and fold, rewriting a
  prefix that was in fact warm.
  - **pi-zip 0.4.12 item:** count any usage entry on the branch as a touch when its `cacheRead` is at least the
    last main response's cacheable prefix, whatever its kind. This rule reads Pi's own entry format only, so
    pi-zip keeps no dependency on pi-aside.
  - pi-zip's learned cache-survival statistics (`run.ts:1602`) will also see longer survival. That is real, and
    intended. It is also why I3 (§7) does not assert that later main requests are unchanged when pi-zip is
    installed.

### Other software
- **Pi's cache warmer (1.3.0).** Its replays are excluded from the observation (§4.1). A replay while idle is a
  cache read and harmless.
- **pi-btw and other btw packages.** They use different commands and coexist.

## 6. Size

| File | Purpose | Lines (estimate) |
|---|---|---|
| `src/observe.ts` | Stream calls, attribution, promotion, readiness, recipe | ~180 |
| `src/fork.ts` | Dry conversion, ΔH, the per-API table (list, marker, E), strip, C1–C3, the header carry table | ~190 |
| `src/thread.ts` | Fork loop, tool policy, T1 isolation, usage drain | ~160 |
| `src/panel.ts` | Overlay | ~140 |
| `src/index.ts` | Wiring and command | ~80 |
| **Total** | | **≤ 800** |

## 7. Acceptance

Everything below runs offline against a capture server unless marked live. The capture server is a local HTTP
server that speaks the Anthropic and OpenAI SSE formats, records every request's body, URL and headers, and plays
scripted responses, including a 2xx whose body is withheld. Pi is pointed at it through a test `models.json`.

**Supported Pi builds.** 1.1.0, 1.2.0 and 1.3.0, each a genuinely pinned stack from pi-ctx-eval's `pi-builds`
manifest (R6). `/tmp/rel2/pi12` is not usable: it loads pi-ai and pi-agent-core 1.3.0.

**The oracle.** For each scripted state the harness computes O, the handler-free conversion of the frozen request
state:
- A scratch Pi agent runs with one test extension that replays the recorded hook outputs:
  - its `context_with_system` handler returns `T ++ G ++ Q`, and Pi uses that output as is (`runner.js:1035`). A
    `context` handler would not do, because Pi prepends its system message again to a changed conversation
    (`runner.js:101`);
  - a second `context_with_system` handler of the same extension asserts that the transcript reaching conversion
    equals the recorded fork;
  - its `before_provider_request` applies the recorded ΔH. It has no `before_provider_headers` handler.
- The recipe is R.
- O is the request it sends.

O shares pi-ai with pi-aside, but none of pi-aside's code. A second oracle, O_real, is the true next main request
(the question sent as a real next user message on a scratch copy of the session). O_real is compared only in
fixtures whose hook output cannot change: spy extensions, and pi-zip with no fold due.

**Invariants.**

| ID | Invariant | How it is checked |
|---|---|---|
| I1 | T0 content: the aside equals O, notice excepted, and equals O_real where O_real applies; its stripped core extends P's; every top-level field equals P's | Recorded bodies, for each API |
| I2 | Routing: `metadata.user_id` / `prompt_cache_key` as P's. URL, credential and every header as O_real's under the next-request rule (§4.2), provider-derived headers as O's. No observed header outside F reaches the wire | Recorded requests. Includes: image-in-T with image-free G. Between P and the aside, each of: an API-key change; an OAuth refresh; a header-only bearer replaced by an API key on another `baseUrl`. The aside follows the new credential and endpoint, and the old bearer never reaches the capture server. A handler-added header is not carried and is named in the note |
| I3 | No hooks, no direct writes. (a) A spy extension counts zero hook calls caused by asides. (b) With pi-aside's `pi` and `ctx` proxied, the only write-capable calls are one `appendUsage("aside", …)` per aside request and, on Ctrl+S, one `sendMessage`; the source contains no other write call. (c) Controlled equality: the main session's entries (aside entries removed, parents re-linked) and its later requests are byte-identical to a run without asides, when the capture server's main responses, usage included, do not depend on asides and only extensions that do not read usage entries are loaded | Scripted runs with and without asides. (a) and (b) are also asserted with pi-zip 0.4.11 and 0.4.12 installed. (c) is asserted neither with pi-zip nor against a real provider. A real aside changes the usage that later main messages persist (`session-manager.js:827`), and pi-zip's survival estimate and fold entries follow from it (`run.ts:1480`). With pi-zip, the harness reports entry and request differences next to pi-zip's fold decisions |
| I4 | At most 4 `cache_control` markers, OAuth included | Bodies |
| I5 | Only `read`, `grep`, `find` and `ls` execute; a `bash` or `write` call produces an error result and no process or file change | Scripted tool calls |
| I6 | Exactly one `aside` usage entry per aside request, written only while the main agent is idle; nothing in the model context | Session file. Covers: an aside asked mid-run; a preparation failure without `agent_settled`; manual compaction; a session switch with entries queued |
| I7 | Attribution and timing: no aside request is sent before its observation is ready; a warmer never becomes P | Capture-server timestamps. Covers: a warmer firing during a long main request (L ambiguous); a warmer payload forced in as the candidate (C1 rejects); a 2xx with a withheld body (waits for readiness); failing and empty streams; the strict-tools retry; a session switch mid-wait; Google and Codex (T1 at once) |
| I8 | Checks are sound: every state where C1–C3 pass satisfies I1, and every scripted defect makes them fail | Fixtures: P ending in user, assistant or tool results; native system and tool changes in G; steers; images; unsigned cross-provider history; signed and encrypted reasoning; `store:false`; Responses custom tools; a model or thinking change after the observation (frozen R); native effort on Anthropic and Responses in the concurrent case (must pass); a string user message whose marker moves |
| I9 | T1 isolation: on `openai-codex-responses` with the default transport, an aside leaves the main session's next request, socket and continuation state unchanged | Recorded requests and adapter state |

**Mutants.** Each mutant must fail at least one invariant:
- rebuild from the session instead of T;
- a new session id at T0;
- drop `metadata`;
- change `max_tokens`;
- strip or reorder `tools`;
- put the notice in `system`;
- add a fifth marker;
- route the aside through the agent's `streamFn`, which runs the hooks;
- promote on a 2xx without waiting for readiness;
- promote the latest attempt in L without the ambiguity rule (a warmer becomes P);
- execute `bash`;
- a later handler replacing the payload, where a spy extension loads after pi-aside (the aside must label the
  shortfall, not claim a hit);
- keep the first attempt instead of the promoted one after a strict-tools retry;
- convert G alone and splice it (losing tool declarations, duplicating Responses IDs);
- drop provider-derived headers;
- carry the whole observed header map (the old bearer reaches the capture server);
- pass an `apiKey`, a `baseUrl` or an auth header from an earlier resolution (the credential-change fixtures fail);
- append any entry other than the usage entry (I3(b));
- use `ctx.model` under a virtual model;
- drain usage only on `agent_settled`;
- T1 with the main session id or transport;
- treat E as content (the concurrent native-effort fixture then falls to T1);
- `strip()` without string normalisation;
- set the legacy `systemPrompt` as well.

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
     payload in `after_provider_response`. Either would need a request id shared by H, R and S, the names of the
     headers that came from auth resolution, and a non-secret credential fingerprint. pi-aside would feature-detect
     it and then:
     - drop both the ordering limit and the ambiguity rule;
     - carry handler-added headers;
     - report a credential change before sending.
   - A provider decorator would observe the final payload too. It is rejected: it would put pi-aside in the main
     request path and wrap every provider.
2. **The dry conversion must not send the inference request.** S0 checks this per API and per Pi build. The
   re-review's probe already found zero fetch calls on all three T0 APIs. Auth refresh before `onPayload` is
   expected (§4.2).
3. **Credential identity is observed, not proved.** Pi keeps the main call's auth resolution local to
   `prepareRequest`, so no extension can bind to it or pin it. Revision 3 tried both, and the re-review gave a
   counterexample for each (§12).
   - Under the next-request rule, the aside uses Pi's resolution at send time.
   - A change since P shows as a low read in the panel. The write then serves the main session's next request.
   - Dropping K also takes the extra auth lookup off the main request path, with its latency and possible OAuth
     refresh.
4. **Relay routing.** The same metadata as P, and the same auth and endpoint resolution as the main session's next
   request. S3 measures it on relay.
5. **Payload retention.** One observation holds P, T and B0, a few MB at most. It is never written to disk and is
   replaced on every main request.
6. **Pi API drift.** Every hook used exists from Pi 0.86.1 to 1.3.0 (checked in installed builds):
   - `before_provider_request`, `before_provider_headers` and `after_provider_response`;
   - `appendUsage`, `modelRegistry.streamSimple` and `convertToLlm`.

   Some hooks are newer:
   - `context_with_system` appears from 0.87.1;
   - `provider_stream_event` appears from 0.99.1. Without it, the physical model comes from P's `model` field
     matched against the registry, and an ambiguous match gives T1;
   - `cache_warming_decision` exists only where the warmer does (1.3.0).

   CI covers 1.1.0, 1.2.0 and 1.3.0.

## 9. Plan

| Step | Content | Exit |
|---|---|---|
| S0 spike | Capture server; a hand-made aside on Pi 1.3.0. Nine checks:<br>S1: consecutive-turn behaviour, reading the main entry, and the last element growing;<br>S2: the dry conversion sends no inference request;<br>S3: relay routing, live, a few cents;<br>S4: the `openai-responses` cache key;<br>S5: `pi install` order;<br>S6: on Anthropic, a string user message and the same text as one block read the same cache entry;<br>S7: the aside's URL, auth and carried headers equal the true next main request's for an API key, OAuth and a header-only credential, also after a credential and endpoint change; the header carry table matches the build's `provider-attribution.js`;<br>S8: the H, R+, S sequence per T0 adapter, with the strict-tools fallback giving R, R, S;<br>S9: per T0 adapter, the session id keys no client-side state | Each claim confirmed, or the design changed |
| M1 | `observe.ts`, `fork.ts`, `thread.ts`; I1, I2, I4, I6, I7 and I8 on 1.3.0 | Invariants green, mutants killed |
| M2 | Panel and send back; I3, I5 and I9 with pi-zip installed | Green |
| M3 | 1.1.0 and 1.2.0 (pinned stacks); comparison run; GPT review | LAND |
| M4 | README and release through the OIDC publish workflow | npm `pi-aside` |

## 10. Review resolutions (revision 2)

| # | Finding | Resolution |
|---|---|---|
| 1 | The capture is not necessarily what was sent; usage cannot certify it | A2 makes every claim relative to the observation. A5: usage numbers are observations. Upstream ask and the rejected provider decorator are in §8.1. Late-replacement mutant added |
| 2 | One `context` event can produce several wire attempts | Logical request L with attempts; promotion on a 2xx response (§4.1). Strict-tools retry fixture and mutant. *Completed in rev 3 (§11, items 1 and 2)* |
| 3 | Tail-only conversion loses system and tool state, conversion and parsing | No tail conversion: the whole fork is converted (§4.2). C2 rejects gains that change system or tools |
| 4 | Responses item IDs are positional | Whole-fork conversion gives globally consistent IDs, and C2 verifies the shared region |
| 5 | The splice contradicted I1; assistant boundaries unspecified | No hand splice. C2 defines "extends" over the marker-stripped list, last element included. I1 is redefined against the oracle O |
| 6 | Captured headers miss provider-derived headers; auth can change the endpoint | Provider headers are recomputed from the full fork context; auth headers are fresh; an endpoint difference forces T1. I2 extended. *Completed in rev 3 (§11, item 4)* *Superseded in rev 4 (§12, items 1 and 2): the endpoint and credential follow Pi's resolution at send time* |
| 7 | `appendUsage` advances the leaf | A3 permits exactly that write, like Pi's warmer. It is deferred to idle. I3 compares with usage entries removed and parents re-linked. *Completed in rev 3 (§11, item 3)* |
| 8 | Warming changes pi-zip's later state | A3 narrowed to "no hooks, no transcript"; cache effects are intended and reported. pi-zip 0.4.12 item in §5. *Completed in rev 3 (§11, item 5)* |
| 9 | A virtual model reruns the router | Physical model pinned from the observation. T1 uses the router only when no physical model is known, and labels it |
| 10 | The wait lacks terminal and lifecycle transitions | §4.3 ends the wait on failure, abort, `agent_end`, switch and shutdown. I7 extended. *Completed in rev 3 (§11, items 1 and 2)* |
| 11 | Exact cache-read equality is the wrong threshold | The prediction is the main response's `cacheRead + cacheWrite`. "Cold" is never claimed from time alone |
| 12 | Wrong claims about pi-btw and pi-zip | pi-btw persists usage in custom entries. pi-zip registers `context_with_system`, and the attempt gate is pi-aside's own rule |

## 11. Re-review resolutions (revision 3)

| # | Finding | Resolution |
|---|---|---|
| 1 | An open L does not exclude warmer attempts; Pi's warmer copies the callbacks | Stream calls (H, R+, S) and an ambiguity rule: a second H, a `cache_warming_decision`, or an orphan R/S before S promotes nothing (§4.1). C1 now forbids handler changes to recipe-controlled fields, so a mistaken warmer payload (`max_tokens: 1`) fails. Fixtures and two mutants in I7 |
| 2 | 2xx is not a started response; Google and Codex WebSocket never call `onResponse` | Promotion on S, readiness separately on the first main-assistant `message_update` or `message_end` (§4.1, §4.3). APIs without S go to T1 at once. Withheld-body fixture and mutant |
| 3 | `agent_settled` misses some returns to idle | A drain task: `waitForIdle`, then a synchronous idle and session recheck before `appendUsage`; a synchronous flush on switch, fork and shutdown (§4.6). I6 fixtures for preparation failure, manual compaction and switch; mutant |
| 4 | The same endpoint does not mean the same account; resolution can change before the send | Credential identity K (account id or secret hash) compared at aside time; the send is pinned to the validated snapshot, checked again in `transformHeaders` (§4.2). Residual window in §8.3. I2 fixtures; two mutants *Superseded in rev 4 (§12, items 1 and 2)* |
| 5 | The oracle and I3 claim more than C1–C3 prove | O is the handler-free conversion of the frozen state, built by replaying the recorded hook outputs. O_real only where hook output cannot change. I3 split into (a)–(c), with (c) not asserted under pi-zip (§7) *Completed in rev 4 (§12, items 3 and 4)* |
| 6 | T1 can reuse the main session's socket and continuation state | T1 uses a fresh session id, a stateless transport and no `previous_response_id`; no stateless transport means a refusal (§4.8). T0 requires a stateless transport, and S9 checks it. I9 |
| 7 | C2 rejects the concurrent case on native-effort models; strings change representation | Terminal configuration items E are split off per API and must be equal; P's last marker must lie in the core; `strip()` normalises strings to one block (§4.2). I8 fixtures (must pass), S6, two mutants |

Other points taken from the re-review:
- The dry run's claim is narrowed to the inference request (§4.2, §8.2).
- The recipe R is frozen with T (§4.1).
- The legacy `systemPrompt`/`tools` fields are never set (§4.2).
- The 1.2.0 build must be a pinned stack (§7).

## 12. Second re-review resolutions (revision 4)

| # | Finding | Resolution |
|---|---|---|
| 1 | K is not bound to the main request's credential: `getApiKeyAndHeaders` is a second resolution, possibly with an OAuth refresh | K is removed. Under the next-request rule, the aside uses Pi's resolution at send time, as the main session's next request and Pi's warmer do. Credential identity no longer decides the tier, because T1 would use the same credential and carry less (§4.2, A5, §8.3). I2 has credential-change fixtures |
| 2 | An explicit key does not pin header-only auth or the endpoint | Nothing is pinned: no `apiKey`, `baseUrl` or auth header is passed. Only Pi's session and attribution headers are carried from the observation. Every other observed name is reported and never sent, so a stale bearer cannot reach a new endpoint (§4.2). I2 has a stale-bearer fixture; two mutants |
| 3 | The oracle's `context` handler duplicates the system state | The oracle returns `T ++ G ++ Q` from `context_with_system` and checks the transcript that reaches conversion (§7) |
| 4 | I3(b) forbids effects the design permits | I3 is restated (§7): (b) is a direct-write check, by proxy and by a source scan. Entry and request equality move to (c), which is asserted only where main responses do not depend on asides and no extension reads usage. With pi-zip and in live runs, differences are reported |

Other points taken from the second re-review:
- `waitForIdle` is kept from the `/aside` command context (§4.6).
- The checks it confirmed stand unchanged: the warmer does not starve T0, the readiness events on all three T0 APIs,
  the trailing E split, and explicit scalar keys.

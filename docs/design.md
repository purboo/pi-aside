# pi-aside: design

Status: design, revision 11 (2026-10-20). Nothing is implemented yet.
- Revision 2 answers the first GPT design review (`/tmp/aside-design-review.md`, 12 findings); see §10.
- Revision 3 answers the re-review (7 findings, no P0); see §11. Its rule: **attribution selects a candidate, checks
  prove it**. No guarantee rests on event timing alone.
- Revision 4 answers the second re-review (4 findings); see §12. Credentials follow the **next-request rule**: the
  aside uses Pi's auth resolution at send time, as the main session's next request would.
- Revision 5 answers the third re-review (3 P1, 1 P2); see §13. Routing is computed fresh, never copied: the
  current model object, Pi's auth, and synthesised default headers. T0 promises content fidelity, not a cost.
- Revision 6 answers the fourth re-review (1 P1, 3 P2); see §14. A currency check in B1's `onPayload` checks that the
  model snapshot and the process environment remain current.
- Revision 7 answers the fifth re-review (1 P1, 1 P2); see §15. B1 takes its model object and Pi takes its
  provider in one synchronous step.
- Revision 8 answers the sixth re-review (3 P1); see §16. B1 sends a private clone of the model recipe, so the
  endpoint cannot change under it. The currency check drops object identity and adds the process environment. The
  residual lists every input Pi and the SDKs read after that step, and I2 states it.
- Revision 9 answers the seventh re-review (2 P1, 1 P2); see §17. There is no parity claim under reverted changes.
  The residual runs through SDK authentication, dispatch and retries. Request options come from the current
  settings, as Pi derives them.
- Revision 10 answers the eighth re-review (2 P1, 2 P2); see §18. The currency check covers model-visible registry
  changes and the environment only. Transport claims are limited to the no-concurrent-change case, and I2 asserts
  named fixtures only. The retained retry cap is documented, and the settings parsing is pinned.
- Revision 11 answers the ninth re-review (2 P2, wording); see §19. S7 is limited to I2's asserted fixtures, and
  the stronger historical resolution is marked superseded.

pi-aside answers a side question about the running Pi session, at the cache-read price whenever the main cache is
still alive and routing is unchanged. The aside request's content is the request the main session would send next
if the question were the user's next message. It is computed without running any extension hook, and it is sent
only after it is checked against the request the main session actually sent. Its transport (endpoint, credential,
headers) is resolved by Pi at send time, as for the main session's requests, within the limits of §4.2. The aside never enters the main transcript, and it never runs the main session's extension hooks.

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
  its body's routing fields extend the observed request. Its credential and endpoint are resolved by Pi at send
  time, by the procedure the main session's next request uses, within §4.2's limits; no extension can prove them
  equal to P's. Event order only *selects* the
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
  main cache. The write serves the main session's next turn if that turn keeps the same model, credential and
  prefix;
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
- the physical model's identity: provider, id and API. The model object, which also carries routing, is looked up
  at aside time (§4.2);
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

**Routing: the next-request rule.** Routing has two parts, handled differently:
- *Body routing fields*, such as `metadata.user_id` and `prompt_cache_key`, are part of the payload. They are
  replayed from P through ΔH, and C1 checks them.
- *Transport routing*, meaning the endpoint, the credential and the headers, is resolved fresh by Pi at the aside's
  send, by the resolution the main session's next request would use. It is never copied from the observation, and
  no observed transport value is sent. It equals that next request's when nothing changes concurrently (I2);
  §4.2's *Residual* lists where it can differ.
- *Model.* The physical model's identity (provider, id, API) comes from the observation, never from `ctx.model`, so
  a virtual model's router is not invoked. The model *object* is looked up in `ctx.modelRegistry`, separately for
  each send:
  - Its routing fields (`baseUrl`, configured headers) are therefore current. Configuration can put the endpoint on
    the model (`provider-composer.js:167`), and `prepareRequest` keeps the supplied model's URL unless auth returns
    one (`model-runtime.js:471`).
  - *Same-tick send of a private recipe.* B1 looks up the registry's object with `find(provider, id)`, deep-clones
    it (`structuredClone`), and passes the clone to `streamSimple` in the same synchronous step, with no `await` in
    between. Pi starts `prepareRequest` synchronously (`lazyStream` runs its setup at once, `lazy.js:36`), and
    `prepareRequest` takes the provider before its first `await` (`model-runtime.js:452-456`, pi-ai
    `models.js:336-337`; on 1.1.0 `model-runtime.js:447-451`, `models.js:334-337`). Pi keeps the supplied object
    when auth returns no URL (`model-runtime.js:471`), and the adapters read its `baseUrl` only later, after
    preparation and lazy loading (for example `openai-responses.js:233`). Only the aside holds the clone, so the
    endpoint those reads see is the one cloned, whatever happens to the registry's object. What this step binds is
    the model recipe and the provider object. It binds nothing that Pi or an SDK reads later (*Residual*).
  - *Same recipe.* The clone must deep-equal the snapshot of B0's object, so both conversions use one recipe.
    Otherwise the aside starts again from B0. C1 then proves that this recipe still reproduces P, so a
    configuration change that alters the payload fails C1 and gives T1.
  - *Currency check.* A defence, not the binding. It detects model-visible registry changes and process-environment
    differences that are still present at `onPayload`, nothing more. B1's `onPayload` runs after Pi's auth resolution and the SDK
    client's construction, and before any byte is sent (all three T0 APIs on 1.1.0 and 1.3.0). Two conditions must
    hold there:
    - a fresh `find(provider, id)` deep-equals the clone. Object identity is not required: configured endpoints and
      custom models produce a new object on every lookup (`provider-composer.js:167`, `:188`, `:190`, `:395`), so
      an unchanged configuration must stay T0;
    - `process.env` equals the copy B1 took just before its synchronous step: the same key set, with no addition or
      deletion, and the same value for every key (about 0.06 ms for 70 keys).

    Otherwise B1 aborts and the aside starts again; after two restarts it uses T1. An abort in `onPayload` ends the
    stream with an error event, and the restart reads the aside's own flag, not the stream result.
  - *Residual.* Some inputs are read after the synchronous step, inside Pi's preparation or the SDK client's
    construction:
    - configured headers, from the provider configuration after the auth `await` (`model-runtime.js:369-375`);
    - an environment-backed credential, resolved after the credential store's `await` (pi-ai `auth/resolve.js:24`,
      `provider-composer.js:290`);
    - SDK inputs from the environment, read at client construction after `transformHeaders` and lazy loading. Examples
      on both builds are `OPENAI_CUSTOM_HEADERS`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` (`openai/client.mjs:172`,
      `:242`), and `ANTHROPIC_CUSTOM_HEADERS` (`@anthropic-ai/sdk/client.mjs:116`). A custom header can carry `Authorization`
      or `x-api-key`.

    - after `onPayload`, the last point at which pi-aside can check anything:
      - dispatch: Pi installs undici's `EnvHttpProxyAgent` (`http-dispatcher.js:73`). `HTTP(S)_PROXY` is taken when
        the dispatcher is built, but `NO_PROXY` is read on every dispatch
        (`undici/lib/dispatcher/env-http-proxy-agent.js:171`), so a `NO_PROXY` change after `onPayload` switches the
        request between direct and proxied, even as a single change;
      - SDK authentication that runs at send time: Anthropic federation reads its identity-token file and exchanges
        it (`/v1/oauth/token`) after `onPayload`, so token-file rotation and the SDK's token cache are not seen;
      - retries, which dispatch again and can authenticate again.

    The currency check does not detect three kinds of change:
    - provider-level configuration the model object does not carry, even as a single change that is never
      reverted. For example, headers held by the provider's auth (`provider-composer.js:225-247`). Re-registering
      the provider with header B during B1's auth resolution passes the check: the aside sends A, a fresh resolution
      gives B;
    - a change reverted before `onPayload` (A → B → A);
    - anything read after `onPayload`.

    Then a header, key or SDK input from one state can reach another state's URL. Pi's own requests have
    the same windows, but not necessarily the same outcome. The aside sends a fixed clone, while the main request's
    SDK client reads the registry's mutable object. So under a combined change the two can pair differently. In one
    case, the URL is mutated to B and the environment key is set to B during credential resolution, and both are
    restored by `onPayload`: the aside sends key B to A, while the main request sends key B to B.

    In short, transport uses Pi's request-time resolution with a private model snapshot. The checks do not prove
    atomic routing or parity with the next main request. I2 verifies the named fixtures and makes no guarantee for
    other concurrent changes. Closing these windows needs Pi (§8).
  - The recipe must clone. All 1,650 bundled models on 1.1.0 and 1,714 on 1.3.0 clone without loss. An object that
    `structuredClone` rejects, for example one with a function-valued field, gives T1.
  - If the registry no longer has the model, the aside uses T1.
- *Credential and endpoint.* The aside passes no `apiKey`, no `baseUrl` and no auth header. Pi resolves auth once,
  inside the aside's own send (`prepareRequest`, `model-runtime.js:452`), by the same procedure as for the main session's
  next request. Pi's own warmer replays the same way. Auth is resolved once, from the provider taken in the same
  step as the model object. A configuration written in two separate steps (key, then endpoint) can still be seen
  half-way. That window is the same for every Pi request, the main session's included.
  - *Why not bind to P's credential.* Pi keeps the main call's resolution local to `prepareRequest`.
    - A second lookup (`getApiKeyAndHeaders`) is a new resolution: it can differ, and it can refresh an OAuth token.
    - An explicit key does not pin the send either, because header-only credentials and the endpoint are resolved
      again (`model-runtime.js:465-471`).
    - The re-review reproduced both (§12).
  - *What T0 promises.* T0 promises checked content fidelity: the model sees what the main session's model sees,
    and the request is the only one that can read P's cache. It does not promise a cost:
    - if routing is unchanged and P's cache entry is still alive, which is the normal case, it reads P's cache;
    - if the entry expired, it writes, as the main session's next request would;
    - after a credential change it writes instead. That write can serve the main session's next request only if
      that request keeps the same model, credential and prefix. T1 can then be cheaper, for example when a
      handler made P much larger than the branch, but it answers over different context.

    Credential identity therefore does not decide the tier. The panel reports the read and the write (A5).
- *Headers.* The final map is `D ⊕ X`, in the order Pi uses (`sdk.js:204`, `provider-attribution.js:60`):
  - X is what Pi's resolution produces for the aside: auth and the current model's configured headers, as passed to
    the aside's `transformHeaders`.
  - D is Pi's session and attribution defaults, *synthesized*, never copied: a replica of
    `mergeProviderAttributionHeaders`' defaults, computed from the current model object, the frozen session id and
    the current telemetry policy (`PI_TELEMETRY` if set, otherwise `pi.getSettings().enableInstallTelemetry` with
    the build's default, `telemetry.js`; the default is `true` in 1.1.0–1.3.0 and lives in the settings manager). Its names are `x-opencode-session`, `x-opencode-client`, `HTTP-Referer`,
    `X-OpenRouter-Title`, `X-OpenRouter-Categories`, `X-BILLING-INVOKE-ORIGIN` and `User-Agent`, and its values are
    constants or the session id. `provider-attribution.js` and `telemetry.js` are byte-identical in 1.1.0, 1.2.0 and
    1.3.0. CI pins their hashes per supported build and asserts the telemetry default, so a change in Pi fails CI
    rather than the replica.
  - SDK-generated headers follow the request options, for example `X-Stainless-Timeout`. So the aside passes the
    options the main session's next request would get, *synthesized* the same way. This is a replica of Pi's
    `buildRequestOptions` (`sdk.js:193-201`), computed from the current settings with Pi's defaults:
    - `timeoutMs` from `retry.provider.timeoutMs`, else the HTTP idle timeout (0 means none, `2147483647`);
    - `websocketConnectTimeoutMs`;
    - `maxRetries` and `maxRetryDelayMs` from the provider retry settings.

    The replica reproduces the settings manager's parsing, validation and defaults: `"disabled"`, numeric strings
    and flooring included (`parseTimeoutSetting`, `getHttpIdleTimeoutMs`, `getProviderRetrySettings`,
    `getWebSocketConnectTimeoutMs`, `SETTINGS_DEFAULTS`). CI pins the hashes of that function's source and of these
    per build, as for D. Without the options, the aside would send no timeout header on the OpenAI APIs and `600`
    on Anthropic, where the main request sends `300`. The aside passes its own `AbortSignal`, since its lifecycle is
    its own.
  - *Retry cap.* The main agent reads `maxRetryDelayMs` once, when it is created (`sdk.js:288`). It forwards that
    value on every request (`agent.js:314`), where it takes precedence over the settings (`sdk.js:203`). An
    extension cannot read the retained value. So after a settings change of `retry.provider.maxRetryDelayMs`, the
    aside, which uses the current settings, and the main session can retry differently. For example, with a
    retained 1 ms cap, settings at 10 ms and a 5 ms retry delay, the main request gives up and the aside retries.
    The cap decides only whether and when a failed request is tried again. It changes no payload, header or
    endpoint.
  - D's model input is the registry object before any auth URL substitution. Pi passes the same `requestModel` to
    the merge (`sdk.js:205`).
  - No observed header value is sent. An observed name outside `D ⊕ X` came from an earlier resolution, from earlier
    configuration or from a handler, and these cannot be told apart. Its name, never its value, goes into the note
    and the panel (`headers not carried: …`), and the hit is then unproven.
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
extends the first aside request, so it can read the fork's own cache entry: if routing is unchanged and the entry
is still alive, as in §4.2. `/aside <new question>` always starts a
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
  control. A relay that routes by it therefore routes the aside as it routed P, as long as the credential and
  model are unchanged (§4.2).
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
- The recipe is R, with the model object current in the scratch agent's registry.
- O is the request it sends.
- Pi catches handler exceptions and reports them through `emitError` (`runner.js:1052`). The harness therefore
  fails on any extension error event, so a failed self-check cannot pass silently.

O shares pi-ai with pi-aside, but none of pi-aside's code. A second oracle, O_real, is the true next main request
(the question sent as a real next user message on a scratch copy of the session). O_real is compared only in
fixtures whose hook output cannot change: spy extensions, and pi-zip with no fold due.

**Invariants.**

| ID | Invariant | How it is checked |
|---|---|---|
| I1 | T0 content: the aside equals O, notice excepted, and equals O_real where O_real applies; its stripped core extends P's; every top-level field equals P's | Recorded bodies, for each API |
| I2 | Routing: `metadata.user_id` / `prompt_cache_key` as P's. With no concurrent change: URL, credential and every header, SDK-generated ones included, as the main session's next request's under the next-request rule (§4.2), and provider-derived headers as O's. No observed header value reaches the wire. Under concurrent changes only the named fixtures below are asserted | Recorded requests. *Asserted:* a baseline with no change, where every header of the aside, `X-Stainless-*` included, equals the main session's next request's under default, custom, zero, `"disabled"` and numeric-string `httpIdleTimeoutMs`, and a provider timeout override; image-in-T with image-free G. Between P and the aside, each of: an API-key change; an OAuth refresh; a header-only bearer replaced by an API key on another `baseUrl`; a configured `baseUrl` and key change on an API-key provider, made before the aside starts or between B0 and B1 as A → B and as A → B → A, and made inside B1's auth resolution as A → B (caught, restart); an unchanged configured endpoint and key, which must stay T0 with no restart; the registry's model object mutated in place during B1's preparation, its `baseUrl` set to B and restored to A before `onPayload` (the request goes to the clone's URL); an environment-backed key and an SDK custom-header variable (`OPENAI_CUSTOM_HEADERS`, `ANTHROPIC_CUSTOM_HEADERS`) changed before `onPayload` as A → B (caught, restart); a configured header removed, including one with an attribution name such as `User-Agent`; telemetry turned off and turned on; a model configuration change that alters the payload (C1 fails, T1). In each, the aside follows the state in force, no key reaches another state's URL, and no old value reaches the capture server. A handler-added header is not carried and is named in the note. *Characterised, not asserted:* the harness records what the aside and the main session's next request send for each residual schedule of §4.2: the configured key and URL, the environment key, the SDK header variables, and the combined URL-and-key change, each changed inside B1's preparation and reverted by `onPayload`; a provider re-registered with another header during B1's auth resolution and never reverted; a `NO_PROXY` change after `onPayload`; an identity-token file rotated after `onPayload`; a retry after a settings change of `maxRetryDelayMs`. The results go into the report next to §4.2's *Residual*. I2 makes no guarantee for other concurrent changes |
| I3 | No hooks, no direct writes. (a) A spy extension counts zero hook calls caused by asides. (b) Direct writes, scoped to the main session's conversation and persistent state: with pi-aside's `pi` and `ctx` proxied recursively, nested state APIs such as `ctx.sessionManager` included, the only such mutations are one `appendUsage("aside", …)` per aside request and, on Ctrl+S, one `sendMessage`. UI calls are not state. Pi's own credential persistence after an OAuth refresh inside `streamSimple` is Pi's behaviour, which the main session's next request would cause too, and is outside (b). A manual source audit backs the proxy. This is a bounded check, not a proof against every transitive write. (c) Controlled equality, Ctrl+S excluded: the main session's entries (aside entries removed, parents re-linked) and its later requests are byte-identical to a run without asides, once generated entry ids and timestamps are normalised. It applies when the capture server's main responses, usage included, do not depend on asides and only extensions that do not read usage entries are loaded | Scripted runs with and without asides. (a) and (b) are also asserted with pi-zip 0.4.11 and 0.4.12 installed. (c) is asserted neither with pi-zip nor against a real provider. A real aside changes the usage that later main messages persist (`session-manager.js:827`), and pi-zip's survival estimate and fold entries follow from it (`run.ts:1480`). With pi-zip, the harness reports entry and request differences next to pi-zip's fold decisions |
| I4 | At most 4 `cache_control` markers, OAuth included | Bodies |
| I5 | Only `read`, `grep`, `find` and `ls` execute; a `bash` or `write` call produces an error result and no process or file change | Scripted tool calls |
| I6 | Exactly one `aside` usage entry per aside request, written only while the main agent is idle; nothing in the model context. The one exception is the drop policy of §4.6: an entry queued when a busy session is switched, forked or shut down is dropped, counted and reported, never written later | Session file and status line. Covers: an aside asked mid-run; a preparation failure without `agent_settled`; manual compaction; a session switch with entries queued while idle (written) and while busy (dropped, count reported) |
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
- copy observed attribution header values instead of synthesising D (the telemetry-off and removed-header fixtures
  fail);
- send with the model object frozen at observation (the configured-endpoint fixture sends the new key to the old
  URL);
- look B1's model object up before B0 and reuse it (the A → B → A fixture between B0 and B1 sends B's key to A's
  URL);
- skip the currency check (the single-change fixture inside auth resolution sends B's configured headers to A's
  URL);
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
   - A change since P shows as a low read in the panel. The write can serve the main session's next request only if
     that request keeps the same model, credential and prefix.
   - Dropping K also takes the extra auth lookup off the main request path, with its latency and possible OAuth
     refresh.
   - A change from A to B and back inside Pi's preparation can pair B's configured headers, environment-backed key
     or SDK environment input with A's endpoint. Inputs read after `onPayload` (`NO_PROXY`, send-time SDK
     authentication such as Anthropic federation, retries) are outside any check. This holds for the aside and for
     Pi's own requests, whose outcomes can differ (§4.2, *Residual*).
   - A registry generation would not close these windows, and neither would a snapshot of the registry and the
     environment. Token files, SDK token caches and dispatcher configuration lie outside both. The upstream ask is
     a request-scoped routing record: Pi captures, once per request, the endpoint, the credential, the headers and
     the dispatcher decision it actually uses, exposes them to `onPayload`, or better to a final pre-dispatch hook,
     and uses nothing else. pi-aside would feature-detect it and compare.
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
| S0 spike | Capture server; a hand-made aside on Pi 1.3.0. Nine checks:<br>S1: consecutive-turn behaviour, reading the main entry, and the last element growing;<br>S2: the dry conversion sends no inference request;<br>S3: relay routing, live, a few cents;<br>S4: the `openai-responses` cache key;<br>S5: `pi install` order;<br>S6: on Anthropic, a string user message and the same text as one block read the same cache entry;<br>S7: the aside's URL, auth and headers equal the true next main request's for an API key, OAuth and a header-only credential with no concurrent change, and after each change I2 lists as *asserted* (a credential change, a configured endpoint change before the aside, between B0 and B1, or unreverted inside B1's auth resolution, and a telemetry change); the residual schedules of §4.2 are only recorded; the hashes of `provider-attribution.js` and `telemetry.js` match the replica's;<br>S8: the H, R+, S sequence per T0 adapter, with the strict-tools fallback giving R, R, S;<br>S9: per T0 adapter, the session id keys no client-side state | Each claim confirmed, or the design changed |
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
| 1 | K is not bound to the main request's credential: `getApiKeyAndHeaders` is a second resolution, possibly with an OAuth refresh | K is removed. Under the next-request rule, the aside uses Pi's resolution at send time, as the main session's next request and Pi's warmer do. Credential identity no longer decides the tier, because T1 would use the same credential and carry less (§4.2, A5, §8.3). I2 has credential-change fixtures *Refined in rev 5 (§13, items 1 and 3)* |
| 2 | An explicit key does not pin header-only auth or the endpoint | Nothing is pinned: no `apiKey`, `baseUrl` or auth header is passed. Only Pi's session and attribution headers are carried from the observation. Every other observed name is reported and never sent, so a stale bearer cannot reach a new endpoint (§4.2). I2 has a stale-bearer fixture; two mutants *Refined in rev 5 (§13, item 2): D is synthesised, not carried* |
| 3 | The oracle's `context` handler duplicates the system state | The oracle returns `T ++ G ++ Q` from `context_with_system` and checks the transcript that reaches conversion (§7) |
| 4 | I3(b) forbids effects the design permits | I3 is restated (§7): (b) is a direct-write check, by proxy and by a source scan. Entry and request equality move to (c), which is asserted only where main responses do not depend on asides and no extension reads usage. With pi-zip and in live runs, differences are reported |

Other points taken from the second re-review:
- `waitForIdle` is kept from the `/aside` command context (§4.6).
- The checks it confirmed stand unchanged: the warmer does not starve T0, the readiness events on all three T0 APIs,
  the trailing E split, and explicit scalar keys.

## 13. Third re-review resolutions (revision 5)

| # | Finding | Resolution |
|---|---|---|
| 1 | The frozen model object can send the fresh key to the old configured endpoint | R freezes the model's identity only. The model object is looked up in the registry at aside time, and both conversions use it, so C1 proves the payload still matches P (§4.1, §4.2). I2 has a configured-endpoint fixture; one mutant |
| 2 | Observed attribution values may be configured, handler-set or out of policy | D is synthesised from the current model, the session id and the current telemetry policy, through a replica of Pi's defaults pinned by file hash per build. No observed value is sent (§4.2). I2 has removed-header and telemetry fixtures in both directions; one mutant |
| 3 | "T1 is never better" is not a valid cost argument | T0 promises checked content fidelity and only measured cache use. The cost claims are qualified, as are the claims that the write serves the next main request and that the relay picks the same account (§4.2, §5, §8.3) |
| 4 | I3 needs scope and normalisation | (b) is scoped to direct mutations of conversation and persistent state, with a recursive proxy and a manual audit; it is a bounded check. (c) excludes Ctrl+S and normalises entry ids and timestamps (§7) |

Also: the harness fails on any extension error event, because Pi catches handler exceptions (§7).

## 14. Fourth re-review resolutions (revision 6)

| # | Finding | Resolution |
|---|---|---|
| 1 | A configuration change during preparation pairs a fresh key with the old endpoint; payload checks cannot see it | Currency check in B1's `onPayload`, after auth resolution and before the wire. The current registry object must deep-equal the lookup snapshot; otherwise B1 aborts and the aside restarts, then falls to T1 after two restarts (§4.2). I2 runs the endpoint fixture between B0 and B1 too; one mutant |
| 2 | Cache claims stayed unconditional | The summary, the panel text and T0's promise are conditional on unchanged routing and a live cache entry (introduction, §3, §4.2) |
| 3 | "No observed routing value is sent" contradicts the replayed body fields | Body routing fields (replayed through ΔH, checked by C1) are distinguished from transport routing (fresh) (§4.2) |
| 4 | I6's exact count contradicts the drop policy | I6 states the exception: dropped entries are counted and reported (§7) |

Also: CI asserts the telemetry default with the file hashes, and D's model input is the pre-substitution registry
object, as in Pi (`sdk.js:205`).

## 15. Fifth re-review resolutions (revision 7)

| # | Finding | Resolution |
|---|---|---|
| 1 | An A → B → A change passes a snapshot check while auth keeps B's provider and the object carries A's endpoint | B1 looks up its model object and calls `streamSimple` in one synchronous step, and Pi takes the provider before its first `await`, so the endpoint and the credential share one registry state (superseded by §16–§18: this holds for the model recipe and the provider object only, not for inputs read later). The `onPayload` check stays as a defence and adds identity. The residual (configured headers read after the `await`, shared with Pi's own requests) is stated, and its fix needs a Pi generation (§4.2, §8). I2 runs A → B → A at three points; one mutant |
| 2 | Follow-ups promised an unconditional hit | Conditional, as in §4.2 (§4.5) |

## 16. Sixth re-review resolutions (revision 8)

| # | Finding | Resolution |
|---|---|---|
| 1 | The currency check required object identity, but configured endpoints and custom models give a new object on every lookup, so an unchanged configuration never stayed T0 | Identity dropped; deep equality kept. I2 adds an unchanged-endpoint fixture that must stay T0 with no restart (§4.2) |
| 2 | Passing the registry's object does not fix its endpoint: adapters read `baseUrl` later, and an in-place change undone before `onPayload` sent A's key to B's URL | B1 sends a private `structuredClone` of the recipe; an object that does not clone gives T1. I2 adds the in-place mutation fixture (§4.2) |
| 3 | The residual named only configured headers; environment-backed keys and SDK environment headers are read later too | The residual lists all three. The currency check compares `process.env`, which catches single changes. Reverted changes are the stated residual (parity was claimed here and withdrawn in revision 9, §17). §8 asks Pi for request-scoped routing |

## 17. Seventh re-review resolutions (revision 9)

| # | Finding | Resolution |
|---|---|---|
| 1 | With the clone, a combined URL-and-key change reverted by `onPayload` sends key B to A for the aside and B to B for the main request, so the parity claim fails | Parity and "no added exposure" withdrawn. The residual states that the outcomes can differ and gives this case. I2 characterises the residual schedules, the combined one included, and asserts nothing for them (§4.2, §7) |
| 2 | Routing and auth inputs are read after `onPayload`: `NO_PROXY` per dispatch, Anthropic federation's token file and exchange, retries | The residual extends through dispatch, send-time SDK authentication and retries. §8 explains why neither a registry generation nor an environment snapshot closes it, and asks for request-scoped routing |
| 3 | Settings-derived request options are missing, so `X-Stainless-Timeout` differs from the main request's | The options are synthesized from the current settings as Pi's `buildRequestOptions` does, with source hashes pinned in CI. I2 adds a baseline parity fixture for every header (§4.2, §7) |

## 18. Eighth re-review resolutions (revision 10)

| # | Finding | Resolution |
|---|---|---|
| 1 | A single header-only provider re-registration during B1's auth resolution passes the currency check, since provider headers live outside the model recipe | The check is stated as detecting model-visible registry changes and environment differences only. The case is in the residual and characterised in I2. Header parity is withdrawn for it (§4.2) |
| 2 | I2's exception list was narrower than §4.2's residual (token files, token caches, dispatcher) | I2 is split into asserted fixtures and characterised schedules, and makes no guarantee for other concurrent changes. §4.2 adopts the reviewer's wording: Pi's request-time resolution with a private model snapshot, no proof of atomic routing or parity. The configured-key A → B → A inside auth resolution, wrongly asserted before, moves to the characterised list |
| 3 | The main agent retains `maxRetryDelayMs` from its creation and gives it precedence over settings | Documented as a retry-policy difference that changes no payload, header or endpoint, with the reviewer's reproduction and a characterised I2 schedule. The settings parsing and defaults are replicated and pinned in CI (§4.2) |
| 4 | The introduction, a revision note and the transport-routing rule still promised identity with the next main request | Qualified as content fidelity plus Pi's fresh resolution at send time, equal to the next main request's when nothing changes concurrently, within §4.2's limits |

## 19. Ninth re-review resolutions (revision 11)

| # | Finding | Resolution |
|---|---|---|
| 1 | S7 required parity after an endpoint change during preparation, beyond §4.2's scope; §14's resolution kept "endpoint and credential share one registry state" | S7 covers the no-change case and I2's asserted fixtures only, and records the residual schedules. The §14 sentence is marked superseded by §16–§18 |
| 2 | Revision 6's note said the currency check checks the credential | It now says the check confirms that the model snapshot and the process environment remain current |

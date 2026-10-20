# pi-aside: implementation notes

Status: implemented against Pi 1.3.0. This document maps the code to [design.md](design.md) (engine, rev 11) and
[ux.md](ux.md) (interaction, rev 5), lists where the implementation departs from them and why, and records how it was
verified.

## 1. Map

| Module | Design | Role |
|---|---|---|
| `src/observe.ts` | design §4.1 | One logical request L at a time: `context_with_system` opens it with T, the leaf and the recipe; H, R, S attribute the wire attempt; the first `message_update` or `message_end` makes it ready. Ambiguity (a second H, a warmer replay, a request without H) and failures are recorded, never guessed. |
| `src/tap.ts` | new, amends §4.1 | The final-payload tap (§2.1 below). |
| `src/payload.ts` | design §4.2 | The per-API table (content list, trailing configuration items E, marker key), `strip()`, ΔH, and the checks C1, C2 and C3. |
| `src/fork.ts` | design §4.2, §4.8 | Conversion under the frozen recipe (Pi's `convertToLlm` with image blocking, `normalizeContext`), the dry run B0 (onPayload records and aborts, nothing is sent), G with "still running" placeholders, the same-tick send with the currency check, F = B1 ⊕ ΔH, and T1 (fresh session id, SSE, no stored-response continuation). |
| `src/transport.ts` | design §4.2 routing | Request options and attribution headers synthesized from the current settings, as Pi's next request would get them, never copied from the observation. |
| `src/thread.ts` | design §4.4, §4.5; ux §3.2 | The side thread: the notice, read-only tools (`read`, `grep`, `find`, `ls`, at most 8 rounds), follow-ups, re-forking when the main session moved, accounting. |
| `src/usage.ts` | design §4.6 | Usage entries, appended only while the agent is idle; dropped and counted when a busy session is left. |
| `src/qmark.ts`, `src/reply.ts` | ux §3.1, §3.3, §3.4 | The question-mark rule (U9) and the route and handoff lines. |
| `src/busy.ts` | ux §3.1, §3.8 | The `background-work` convention on `pi.events`. |
| `src/panel.ts` | ux §3.2, §3.3, §3.5 | The answer panel, the hint and ghost line, the money line, the `/aside` reader. |
| `src/index.ts` | all | Wiring: events, routing, the `/aside` command, widgets. |

## 2. Departures from the design

### 2.1 The final-payload tap (amends design §4.1)

`before_provider_request` handlers run in extension load order, and a handler may return a replacement payload.
Extensions loaded earlier never see the replacement. The design makes every guarantee relative to that order and
expects pi-aside to be installed last. On a real relay this failed silently. pi-zip 0.4.11 returns a replacement
payload that adds a sticky `metadata.user_id`, which the relay uses to choose the upstream account. With pi-aside
loaded before it (`-e` extensions load before packages), P lacked the field, C1–C3 passed against that stale P, the
aside went out without the sticky id, and it read 0 cached tokens on one run out of two.

Pi sends every session request through the model runtime that also backs `ctx.modelRegistry`, and passes the handler
chain as `onPayload`. pi-aside wraps that runtime's `streamSimple` once and records the payload the chain returns for
the latest attempt. That payload is what Pi sends, whatever the load order. pi-aside's own requests carry a marker
and are not tapped. If a Pi build has no such runtime, the observation falls back to the R event's payload by
reference, which is the design's behaviour. Test: "a payload replacement by an extension loaded after pi-aside
reaches the aside" fails without the tap and passes with it.

Handlers of `context_with_system` that run after pi-aside still make T stale. C1 then fails, and the aside uses T1:
correct, but it does not read the cache. Installing pi-aside last avoids this; `pi install` appends.

### 2.2 Enter is routed through Pi's `input` event (amends ux §4)

ux.md planned to intercept the submit key with `onTerminalInput`. pi-aside instead handles Pi's `input` event, which
Pi emits for every interactive submit before acting on it, with `streamingBehavior` telling a steer from a follow-up.
Returning `handled` takes the text; `continue` keeps Pi's meaning. This removes four risks of the original plan:
- A remapped `tui.input.submit` works without finding the key.
- A bracketed paste containing `?` and a newline never submits.
- IME composition is irrelevant, because only committed, submitted text is seen.
- No keystroke is ever consumed except Tab on an empty editor with a pending suggestion.

`onTerminalInput` is used only for that Tab and to refresh the hint after each key.

### 2.3 Ghost text is a dim line below the editor

Ghost text drawn inside the editor would need `setEditorComponent`, which conflicts with other editor extensions
(the user's own setup replaces the editor frame). The suggestion is a dim line `⇥ <suggestion>  (tab accepts)` in a
`belowEditor` widget. It shows only while the editor is empty, as ux §3.3 specifies for the ghost text.

### 2.4 An answer still streaming does not collapse

ux §3.2 collapses the panel when the user next sends anything to the agent. pi-aside applies this only to finished
answers. Sending a steer while the answer streams leaves it visible, because the user is waiting for it. The next
send after it finishes collapses it.

### 2.5 The cacheable prefix on OpenAI APIs

The detail line compares the aside's cache read with the main request's cacheable prefix, which design §4.6 defines
as cache read plus cache write. OpenAI APIs report no cache writes, so the prefix there is the whole prompt (input
plus cache read). Anthropic reports the counts in its first stream event, so the figure is available while the main
reply still streams.

### 2.6 Not implemented

- **The fork-point breakpoint (ux §5.5).** The aside's markers are pi-ai's defaults. When the main cache has
  expired, the aside pays the cold write, and the money line says so.
- **A `background-work` emitter in pi-durable-subagents.** Until an emitter exists, "busy" means running, as ux §3.1
  specifies for that case.
- **The user studies of ux §6 (U1) and the 40-message misroute set (U8).** Both need real users and a real model.
  The route check is implemented and tested with scripted replies.

## 3. Verification

### 3.1 Offline (`bun run check`, about 30 s, 111 tests)

A local capture server speaks the three APIs as pi-ai consumes them. Real Pi 1.3.0 runs over RPC and, for the
interaction, in a private tmux server. Nothing touches `~/.pi` or the network.

| Area | Tests |
|---|---|
| Exact fork, idle, per API | The aside's request extends the main request element by element (strip applied), every other top-level field is equal, the credential and SDK headers match, a handler's sticky field is carried, no extension hook sees the aside, and one usage entry is written with `tier=exact`. |
| Concurrent, per API, with native effort (Anthropic `output_config`, Responses `configuration_update`) | Asked while the main reply is withheld: the aside waits for readiness, then extends the observed request with the same trailing configuration. Its usage entry follows the main reply in the session file. |
| Tool rounds | After a main tool round; during a running main tool (still-running placeholder); the aside's own read-only tools, refusal of `bash` (no file created), continuation requests still exact. |
| Fallbacks | A handler that rewrites the transcript, which gives T1 with a fresh session id; no main request yet, which gives T1 with the session's system prompt. |
| Order | A payload replacement by an extension loaded after pi-aside (the tap). Loading as an installed package. |
| Follow-ups | The fork continues; after the main session moves, it forks again with the earlier exchange quoted. |
| TUI | The hint, a busy `?` asked on the side and never seen by the main session, collapse on the next send, CJK `？`, a steer without `?`, an idle `?` as a prompt, Esc aborting with the panel visible, Tab accepting the suggestion and Enter sending it with the side note, `route: agent` sent as a steer, a failed aside sent as a steer, a bracketed paste, and the waiting state. |
| Units | The text rules (71 gate cases), strip, lists, C1–C3, the observer state machine, the usage queue, background work, placeholders, the notice, money. |

### 3.2 Real provider (2026-10-21, a few cents in total)

| Setup | Result |
|---|---|
| Anthropic relay, idle aside, no other extensions | `exact`, read 2,935 of 2,935 cacheable, $0.0013 (the main turn cost $0.0075) |
| OpenAI Responses provider, idle aside | `exact`, read 5,120 of 5,245 (OpenAI caches in 128-token blocks) |
| Anthropic relay, asked after the first streamed token | Answered in 1.4–2.0 s while the main reply still streamed; read 2,953 of 2,953; the main reply was unaffected |
| Anthropic relay, every installed extension (pi-zip, pi-durable-subagents, …), pi-aside loaded first | Without the tap: read 0 on one run of two (§2.1). With the tap: the sticky `metadata.user_id` is carried, and the aside read 16,729 of 16,729 |
| The real TUI with every installed extension | Hint under the custom editor frame, panel above it, answer while the agent streamed |

## 4. Corrections for design.md

design.md is maintained separately. These changes are proposed, not applied:
- §4.1: observe P through the final-payload tap where available (§2.1). The R event's object by reference remains the
  fallback.
- §3, line 130: the cold write does not serve the main session's next turn, because the aside's marker sits after Q
  (ux §5.5).
- §4.5: a follow-up forks again when the main session gained context since the thread's last request (ux §3.2).

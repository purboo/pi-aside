# pi-aside: implementation notes

Status: implemented against Pi 1.4.0. This document maps the code to [design.md](design.md) (engine, rev 11) and
[ux.md](ux.md) (interaction, rev 9), lists where the implementation departs from them and why, and records how it was
verified.

## 1. Map

| Module | Design | Role |
|---|---|---|
| `src/observe.ts` | design §4.1 | One logical request L at a time: `context_with_system` opens it with T, the leaf and the recipe; H, R, S attribute the wire attempt; the first `message_update` or `message_end` makes it ready. Ambiguity (a second H, a warmer replay, a request without H) and failures are recorded, never guessed. |
| `src/tap.ts` | new, amends §4.1 | The final-payload tap (§2.1 below). |
| `src/payload.ts` | design §4.2 | The per-API table (content list, trailing configuration items E, marker key), `strip()`, ΔH, and the checks C1, C2 and C3. |
| `src/fork.ts` | design §4.2, §4.8 | Conversion under the frozen recipe (Pi's `convertToLlm` with image blocking, `normalizeContext`), the dry run B0 (onPayload records and aborts, nothing is sent), G with "still running" placeholders, the same-tick send with the currency check, F = B1 ⊕ ΔH, and T1 (fresh session id, SSE, no stored-response continuation). |
| `src/transport.ts` | design §4.2 routing | Request options and attribution headers synthesized from the current settings, as Pi's next request would get them, never copied from the observation. |
| `src/thread.ts` | design §4.4, §4.5; ux §3.2 | The side thread: the notice, 24 rounds followed by one summary request, route-before-action guard, follow-ups, re-forking when the main session moved, accounting. |
| `src/tools.ts` | ux §3.9; new, amends design §4.4 | The private executor bridge, session tool validation and hooks, and projection of its hidden declaration. |
| `src/usage.ts` | design §4.6 | Usage entries, appended only while the agent is idle; dropped and counted when a busy session is left. |
| `src/qmark.ts`, `src/reply.ts` | ux §3.1, §3.3, §3.4 | The question-mark rule (U9) and the route and next lines. |
| `src/busy.ts` | ux §3.1, §3.8 | The `background-work` convention on `pi.events`. |
| `src/panel.ts` | ux §3.2, §3.3, §3.5 | The answer panel, the hint and placeholder line, the money line, the `/aside` reader. |
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
- Submit routing sees complete committed text rather than raw key sequences.

`onTerminalInput` handles Tab acceptance, the panel's printed "more" key, Esc dismissal and refreshing the hint.
Esc leaves an autocomplete list or an unrelated focused dialog alone.

### 2.3 The empty-editor placeholder uses a flush dim line (0.5.0)

Pi 1.4.0 has no placeholder API. `getEditorComponent()` returns a configured factory, not the live editor.
`setEditorComponent()` rebuilds the editor. Wrapping the current factory can preserve it initially but cannot
compose with another extension that replaces it later; mutating its rendered lines would also assume its cursor,
frame and autocomplete layout. The permitted fallback is one dim `belowEditor` line: `/aside <next-step>`.
It has no `⇥` or acceptance instruction. Child windows use the same fallback without `/aside`. No editor factory
is replaced. Tab is consumed only with empty text, a suggestion, and editor focus; other Tab goes through Pi.
Typing, closing, a new question or main output clears the aside suggestion. Child hints clear when typed into.

### 2.4 The panel stays until closed

Since 0.4.0, neither an empty Enter nor a message sent to the main agent folds the panel. The old collapse-on-send
behavior made the visual state hard to predict; the panel now has only open and closed states (§2.7).

### 2.5 The cacheable prefix on OpenAI APIs

The detail line compares the aside's cache read with the main request's cacheable prefix, which design §4.6 defines
as cache read plus cache write. OpenAI APIs report no cache writes, so the prefix there is the whole prompt (input
plus cache read). Anthropic reports the counts in its first stream event, so the figure is available while the main
reply still streams.

### 2.6 Asides think at a low effort when that keeps the cache (amends design §4.2 C2, C3)

An aside inherited the main session's thinking level. At `xhigh` the panel stayed empty for seconds while the
model thought about a side question. Some models take effort changes in the middle of a conversation
(`compat.supportsMidConvoEffort`): pi-ai then sends the level as a trailing configuration item (E: an Anthropic
`system` item with `output_config.effort`, a Responses `configuration_update`), after the cached prefix, and keeps
the top-level fields unchanged.

On such models the aside asks at `low` when the main level is higher (`asideLevel` in `src/fork.ts`; a level the
model's `thinkingLevelMap` lacks or maps to nothing is not used). The change is proved, not assumed: when the fork
is made, a second dry run of T at the lower level must differ from B0 in E only (same core, same other top-level
fields). Then C2 compares B1 with that dry run, and C3 compares E(F) with its E instead of E(P). Every other check
is unchanged, so the request still extends P byte for byte up to E. Without the proof the aside keeps the main
level. T1 uses the same rule on its own requests.

Measured on the Anthropic relay (Claude Opus 5.5, main at `xhigh`, idle aside, two runs each): the first words came
after 3.8 s at the main level and after 1.7–1.9 s at `low`; the cache read was the same (3,557 tokens, `exact`).

### 2.7 The panel: a small window (amends ux §3.2; 0.4.0)

- Before the first words, Pi's spinner shows `working` and elapsed seconds. Thinking shows its last three lines,
  dim and italic. Answers and the reader use Pi's Markdown component and theme.
- Esc closes the panel and aborts the aside's controller, never the main agent. No folded line remains. A second
  Esc within 500 ms is consumed; after that interval it keeps Pi's normal meaning. Dialogs and autocomplete keep
  their Esc. A request generation and thread/session ownership guards discard late route callbacks and suggestions
  from cancelled or replaced work.
- A close mark and count-line targets work through `handleMouse` in fullscreen mode. A wheel over the panel
  scrolls its own answer and is consumed even at its ends, so it cannot scroll the main conversation. The reader
  also handles wheel events and has a close mark. Regular mode keeps the keyboard paths because Pi leaves mouse
  handling to the terminal.
- Room remains `panelRoom`: half the rows while the agent runs, rows minus 10 otherwise, minimum 6, frame
  included. Long answers initially show their end while streaming and their start when done. A user scroll holds
  its position; returning to the end of a stream follows it again. A new question resets the position.
- The panel claims `app.tools.expand` only while its last render printed the key on a count line. Elsewhere
  ctrl+o is Pi's tool-output key.
- Open means follow-up; closed or sent-to-agent means a fresh question. The hint says which before Enter; a
  follow-up shows the latest question as its title and `after: <previous question>` below it.
- `/aside`, ctrl+o or a count-line click opens the reader at the latest question. Esc, Enter, ctrl+o or the close
  mark closes it. Printable text closes it, reopens the panel, and goes on in the editor through `pasteToEditor`.
- Finished shell, edit and write calls leave one concise step in the panel and reader. The activity line shows
  the tool currently running. Cancellation prevents later calls; completed filesystem changes are not undone.

### 2.8 Not implemented

- **The fork-point breakpoint (ux §5.5).** The aside's markers are pi-ai's defaults. When the main cache has
  expired, the aside pays the cold write, and the money line says so.
- **A `background-work` emitter in pi-durable-subagents.** Until an emitter exists, "busy" means running, as ux §3.1
  specifies for that case. So while the agent is idle and only subagents run, a `?` message goes to the agent as a
  prompt (seen in real use, dsa 1.2.0); `/aside <question>` asks on the side meanwhile.
- **The user studies of ux §6 (U1) and the 40-message misroute set (U8).** Both need real users and a real model.
  The route check is implemented and tested with scripted replies.

### 2.9 Tools use Pi's session pipeline (amends design §4.4)

`src/tools.ts` registers a private bridge that hides its own declaration through `prepareLoadout`. The hook gives
it the session-wrapped executor; invoking that wrapper gives the bridge an `ExtensionToolContext`. Actual target
calls go through `ctx.executeTool`, so configured overrides, argument preparation and validation, permission
hooks, result hooks and native cancellation all apply. Model-issued bridge calls cannot manufacture the private
request token. Inactive, hidden, unregistered and `model-only` targets fail closed. Pi also requires an existing
main assistant message for nested calls; until the main agent has answered once, tools in a blank session return
that limitation instead of running an unwrapped fallback.

Pi hides loadout declarations after `context_with_system`, which is where the aside observes the transcript.
The fork therefore applies `projectAsideTools` before every dry conversion and send: the same filtering of the
bridge's `toolsAdded` and `toolsRemoved` fields that Pi applies while it is active. No other tool or content is
changed. C1–C3 still prove the result against the actual main request. Without the projection, every previously
exact test fell back to `rebuilt`; with it, the three API and continuation tests remain exact.

A route check requires an explicit `side` route before any tool, including a reading tool whose implementation
may have been overridden. Completed route lines do not need a trailing newline. An `agent` route stops before
any tools even without an `onRoute` callback. Cancellation suppresses route callbacks and is checked before each
call, each model request, and committing the side exchange. Side tool calls do not enter the main transcript;
the native nested events have an aside parent ID, so the main TUI does not display them as its own tool calls.

Finalized `tool_execution_end` events report each tool's own usage after hooks. An `AsyncLocalStorage` scope
assigns those events to the side invocation, including nested calls and overlapping requests, without retaining
call IDs. The thread adds them once to its cost and queues entries under Pi's native `Tools/summaries` bucket;
paid results still count after cancellation or before a parent fails. No second count comes from the returned
outcome. Tools must report `result.usage`; costs discarded by a throwing tool cannot be recovered. The stable
bridge scope remains bounded even when Pi's nested recorder reaches its call limit or resets IDs.

### 2.10 Relays and consumption (0.5.0)

`src/thread.ts` adds `tell_agent` and `move_out` as one appended `SystemMessage.toolsAdded` definition per fork
(declaring a name again counts as a redefinition for addition-only transports and would refold the tool list,
losing the cache). They are
handled before the session executor, including in blank sessions and when the main has no tools. The notice
restricts them to an explicit latest user request and requires self-contained relay text. There is no separate
language-specific intent heuristic. The route-before-tool guard still covers both internal tools.

`pi.sendMessage({customType: "aside", content, display: true, details}, {triggerTurn: true, deliverAs: "steer"})`
uses Pi's native queue. Verified in `agent-session.js:sendCustomMessage`: streaming goes through `agent.steer`
and idle delivery starts a custom-message run. It never aborts a tool. `message_start` for that custom message
marks a queued relay consumed; idle delivery is immediately read. This reports entry into context, not model
comprehension or completion. The shared relay object updates the panel's `→ to the agent` block and one plain
status sentence. The message renderer displays `aside ›` or `aside:<name> ›`; content labels it as an instruction
relayed from the user's aside. The handoff parser, accepted handoff and side-note-on-send path are removed.

### 2.11 Native tool declarations and cache checks (Pi limitation)

The new tools must always be available to the aside and absent from the main agent's loadout. Their definitions
therefore follow the frozen main prefix. Pi's provider adapters can preserve that prefix only when the model's
compatibility supports native mid-conversation tool additions: Anthropic needs `supportsMidConvoSystemMessages`
and `supportsMidConvoToolChanges` (and initial tools), Responses needs `supportsMidConvoSystemMessages` and
`supportsAdditionalTools`, Completions needs `supportsMidConvoSystemMessages` and `supportsMidConvoToolAdditions`.
These capabilities are read from Pi's model configuration; pi-aside never invents support for a provider.

Otherwise Pi folds the definitions into top-level `tools`, which differs from P. Keeping exact cache reuse while
also declaring these tools is technically impossible on that path. C1–C3 remain unchanged: they reject the changed
payload and use the existing isolated `rebuilt` fallback. Usage and cache accounting are unchanged. Tests now
explicitly configure native-capable fake models for exact-fork regressions, plus a legacy model that proves
conservative fallback and retains both internal tools. This is a cache limitation, with the same user-visible design.

### 2.12 Summary and promotion (0.5.0)

Response 24's tool calls each receive the specified limit result without execution. Exactly one further model
request writes a summary. A missing/invalid `next:` becomes `continue`. A follow-up has a fresh counter. If the
summary request itself asks for tools, none run and no further request is made.

`src/promotion.ts` writes a version-3 session using a fresh `SessionManager` header, the captured main branch
at the initial fork (including compactions, context edits and metadata), then normal user/assistant/tool-result
entries through `SessionManager.appendMessage`. Provider metadata and tool call IDs are preserved; aside notice,
route and next protocol are excluded. Unanswered main tool calls at that snapshot receive the same still-running
placeholder results as the fork, keeping the exported context valid. Names use `appendSessionInfo`. SessionManager
round-trip and list tests verify resumability and discovery in the normal cwd session directory.

An incoming follow-up waits for the current aside tool to finish, skips remaining calls and yields before another request; it never aborts that tool to move.
`move_out` runs in sequence after earlier tools and stops further calls before exporting. Only when that skipped
later calls of the same answer is the child started with `continue`; a real tmux trial showed that a `continue`
after finished work made the child's model disown the move. tmux has no pane targets for `new-window`
("can't specify pane here"): `display-message -t $TMUX_PANE '#{window_id}'` finds the window, and
`new-window -a -t <window>` without `-d`,
quote child environment/command arguments, and return the stable window ID and displayed index. Names are checked
in that tmux session and suffixed on collision. The parent appends a custom **entry**, via `appendEntry` and
`registerEntryRenderer`, rather than a custom message: Pi explicitly excludes custom entries from LLM context
and emits `entry_appended` for immediate display. Fullscreen clicks select its stable window ID.

Outside tmux the exported thread retires and the panel keeps the launch command. Pi's `copyToClipboard` is attempted;
if it fails, the UI shows the command without the inaccurate `Copied:` claim. This is the closest permitted fallback.
A failed tmux launch leaves the panel/thread available and the valid exported session on disk.

The parent's inbox lives under `getAgentDir()/aside-inbox/<session-id>-<pid>`. `fs.watch` plus a startup scan reads
atomic JSON writes; only successfully delivered files are removed, so delivery errors can retry. Invalid shapes are
removed and reported. Watchers close on session replacement/shutdown. A child with `PI_ASIDE_PARENT` registers a
normal main-agent `tell_agent` tool writing into that inbox. Its new model/tool usage belongs to its independent Pi.

### 2.13 Panel touch boundary and bottom line (0.5.0)

Close columns win on rows 0 and 1. Reader hit zones cover only visible count text, excluding the right half of
the row. The literal row above the top frame is outside the widget: Pi cannot route that click to its
`handleMouse`. The closest component-scoped behavior covers the close mark, horizontal neighboring cells and the
row directly below; clicks outside the widget retain Pi's behavior. A regression explicitly checks this boundary.
No cost line is appended to the completed panel. The reader retains accounting details and Pi retains totals.

## 3. Verification

### 3.1 Offline (`bun run check`, 169 tests)

Final 0.5.0 check: TypeScript passed; **169 tests passed, 0 failed, 731 assertions**, across 7 files in 51.51 s.

A local capture server speaks the three APIs as pi-ai consumes them. Real Pi 1.4.0 runs over RPC and, for the
interaction, in a private tmux server. Nothing touches `~/.pi` or the network.

| Area | Tests |
|---|---|
| Exact fork, idle, per API | The aside's request extends the main request element by element (strip applied), every other top-level field is equal, the credential and SDK headers match, a handler's sticky field is carried, no extension hook sees the aside, and one usage entry is written with `tier=exact`. |
| Concurrent, per API, with native effort (Anthropic `output_config`, Responses `configuration_update`) | Asked while the main reply is withheld: the aside waits for readiness, then extends the observed request with the same trailing configuration. Its usage entry follows the main reply in the session file. |
| Tool rounds | After a main tool round; during a running main tool (still-running placeholder); the aside's shell and file tools, extension tools, hook blocks, configured overrides, validation, cancellation, continuation requests still exact. |
| Fallbacks | A handler that rewrites the transcript, which gives T1 with a fresh session id; no main request yet, which gives T1 with the session's system prompt. |
| Order | A payload replacement by an extension loaded after pi-aside (the tap). Loading as an installed package. |
| Follow-ups | The fork continues; after the main session moves, it forks again with the earlier exchange quoted. |
| TUI | Busy `?` routing and hints, CJK punctuation, normal steers and idle prompts, Esc closing only the aside and guarding double presses, cancelling a running aside, Enter and agent sends leaving the panel open, next-step suggestions, direct relay, route fallback, bracketed paste, background work, spinner/thinking, Markdown, long answers and ctrl+o, typing in the reader, panel wheel/touch targets, reader wheel and close, fresh versus follow-up threads, and route-before-tool behavior. |
| 0.5.0 | Hidden/sanitized next suggestions and Tab to `/aside`; no-main-tools relay; queued-to-read TUI status; parent inbox and child main-agent relay; response-24 summary and fresh continuation; SessionManager round-trip, discovery, pending main tools and protocol stripping; safe tmux command/name construction; move waits for a tool and skips later calls; non-tmux command fallback; count text and expanded close touch zones. |
| Effort | On models with mid-conversation effort, the aside's E carries `low` and everything else matches the main request (Anthropic and Responses); other models keep the main level. |
| Units | The text rules (71 gate cases), strip, lists, C1–C3, the observer state machine, the usage queue, background work, placeholders, the notice, money, the panel room and count line, the claim on ctrl+o, the reader's keys. |

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
- §4.4: side tasks use callable tools through Pi's tool pipeline, instead of a read-only allowlist (ux §3.9).

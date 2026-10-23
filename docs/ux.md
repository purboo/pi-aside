# pi-aside: interaction design

Status: implemented, revision 8. The panel is a small window: Esc or its close mark closes it; a wheel or
swipe over it scrolls it. Empty Enter and sending a message to the agent leave it alone. Side tasks can use the
session's callable tools, through Pi's own validation and permission hooks (§3.9). Revision 7 introduced room,
follow-ups and the reader; revision 6 introduced progress and Markdown; revision 5 moved routing to Pi's `input`
event. This document describes the current behavior. The engine in `design.md` remains the cache-checked fork;
implementation changes and departures are recorded in `implementation.md`. §7 records earlier design mistakes.

## 1. The goal

> It looks like nothing is there, yet everything is there. Nobody has to be taught, and it feels great to use.

In practice this means five rules:
1. **Change nothing that already works.** Fix only the moment that hurts.
2. **Use familiar interactions.** Enter sends, Tab accepts a suggestion, Esc closes what is in front. A wheel or
   swipe scrolls the content underneath it. Never show `tier`, `cache` or `fork` on the normal path.
3. **Show the destination.** Opening a panel does not silently capture normal messages. Anything that changes
   what Enter does must be visible *before* the user commits.
4. **Lossless recovery over prediction.** When the system has to guess, a wrong guess must cost about two
   keystrokes and lose no text.
5. **Guesses only fall back to Pi.** The user opens the side path with their own punctuation. The system may
   close it again and do what Pi would have done, but it never moves a message away from Pi's meaning on its
   own. Its errors then cost no more than Pi without pi-aside.

## 2. The moment that hurts

The agent is working, and the user has a question. Today Pi offers:

| Key (Pi's meaning) | Effect on a question |
|---|---|
| Enter = steer | It interrupts after the current turn. The agent answers, often loses its thread, and the Q&A stays in the context forever |
| Alt+Enter = follow-up | It waits until the agent is done. Usually too late |
| Esc = abort | Stops everything |

Asking while the agent is really done already works: it is just the next turn. It does not work when Pi is idle
but the agent is waiting, for example for subagents that will wake it when they finish. A question then starts a
main turn: the Q&A stays in the orchestrator's context, the turn costs a full main request, and a subagent report
that lands meanwhile is merged into that turn at its next boundary (pi-durable-subagents injects reports at
`turn_end` and `agent_before_settle`, `dist/agent/main.js:211-212`). pi-aside treats running and waiting alike
(§3.1). An agent that is idle with nothing pending keeps Pi's behaviour, and `/aside` covers it.

## 3. The design

### 3.1 The question mark is the interface

**While the agent is busy, a message ending in a question mark is asked on the side**, unless the route check
(§3.4) finds a request or a correction. Everything else keeps Pi's meaning.

The ending is language-neutral: the last character after trailing whitespace, closing brackets and closing quotes
are removed must be one of `?` (ASCII), `？` (full-width, what Chinese and Japanese IMEs type), `؟` (Arabic) or
`;` (U+037E, Greek). Spanish `¿…?` ends in `?`. A message whose end lies inside a fenced code block never
qualifies. No sentence-final words are inspected: `吗` and `呢` (Chinese question particles), `right` and `eh` stay with Pi. A message without a
question mark is a steer, exactly as today.

```text
 agent busy, editor text ends with "?"         →  Enter asks on the side
 agent running, anything else                  →  Enter steers (Pi)
 agent waiting, anything else                  →  Enter sends a prompt (Pi)
 agent busy, Alt+Enter                         →  Pi's meaning, "?" or not
 agent idle, nothing pending                   →  Pi, unchanged
 slash commands                                →  Pi, unchanged
```

**Busy** means running or waiting:
- *Running*: `ctx.isIdle()` is false.
- *Waiting*: Pi is idle, but an extension reports background work that will wake the agent. Pi has no such
  state, so it comes from a small convention on `pi.events`. An extension emits `background-work` with
  `{ source, pending }` whenever its count changes, and again in reply to `background-work:query`, which pi-aside
  emits at `session_start`. pi-durable-subagents would report the unfinished workflows that will wake this
  session. pi-aside keeps the latest count per source and clears all counts on a session switch. With no emitter
  installed, waiting never occurs, and the rule is the running-only rule of revision 3.
- Waiting is visible: the subagent summary line sits above the editor, and the hint below it appears exactly as
  in the running case.
- A really idle agent keeps Pi's meaning even for questions. Its Q&A *is* the main conversation ("what are the
  options?", then "go with 2"). Sending it aside would take the discussion away from the agent, a guess away
  from Pi (rule 5).

- The destination is shown before the user commits. While the text ends in `?`, one dim line sits below the
  editor: `↵ asks on the side · corrections still reach the agent`, or `↵ follows up on the side · …` while an
  aside panel is open (§3.2). If the text has no `?`, nothing new is shown.
- The rule is one character long and lives in the user's own text. To steer with a question, the user deletes the
  `?`. To ask the agent itself, the user presses Alt+Enter.
- People already put `?` on questions, so the rule is learned by using it, not by reading about it.

### 3.2 The answer is a small window above the editor

```text
 agent's conversation…                            ← wheel or swipe here: main conversation
 ╭─ why did it pick B? ──────────────────── ✕ ─╮
 │ B keeps the retry logic inside the adapter.   │  ← wheel or swipe here: aside
 │ …                                            │
 │ ↓ 12 more lines · ctrl+o                      │  ← click or tap: reader
 ╰──────────────────────────────────────────────╯
 editor…
```

- **Close what is in front.** Esc closes the panel. If the aside is still answering or running a tool, it is
  cancelled; the main agent keeps going. With no panel open, Esc keeps Pi's behavior. The reader and Pi's own
  dialogs or autocomplete close first when they own the input. A second Esc within 500 ms after an aside closes
  is consumed to protect against double presses and key repeat; after that interval Esc can stop the agent.
- **Touch and mouse.** In Pi's fullscreen mode, a close mark on the panel's top edge closes it. A wheel or swipe
  over the panel scrolls the aside, including at its boundaries; it never falls through to the main conversation.
  A wheel outside the panel keeps Pi's behavior. Clicking or tapping a count line opens the reader. The reader
  also scrolls with the wheel and has a close mark. A mobile terminal must send mouse reports for these gestures;
  regular mode leaves scrolling to the terminal and keeps the keyboard paths.
- **Open or closed.** There is no folded line. An empty Enter and a message sent to the agent leave the panel
  alone. The next aside replaces its contents, and switching sessions clears it. `/aside` rereads the latest
  thread after the panel is closed.
- **Follow-ups: open means continuing.** Another `?` message while the panel is open continues the same side
  thread; once it is closed, the next one starts afresh. The hint below the editor says which before Enter
  (§3.1). To continue a closed thread, open `/aside` and type: the reader closes, the panel opens again, and the
  text goes on in the editor. A follow-up shows only the latest question, as its title, with one dim line
  `after: <the question before>`; the whole thread is in the reader.
  If the main session gained messages since the last request (a report, finished tool, or steer), the follow-up
  forks again from the latest observation and quotes the earlier side exchange in its appended message. This
  amends `design.md` §4.5, which always continues `T ++ G ++ Q ++ A1 ++ Q2`.
- **Never an empty box.** Before the first words the panel shows Pi's spinner with `working` and elapsed seconds;
  while the model thinks, `thinking` with its last lines of thinking, dim. Answers render as Markdown. Models
  that take effort changes mid-conversation use low effort when the cache proof permits it (`implementation.md`
  §2.6).
- **Long answers.** The panel grows up to half the screen while the agent runs and up to the room above the
  editor otherwise. Before the user scrolls, a long answer shows its end while streaming and its start once done,
  with a count of the lines outside the view. Scrolling holds that position; reaching the end of a streaming
  answer follows it again. A new question resets the position.
- **A key belongs to the panel only where it is printed.** Where the count line shows `ctrl+o`, Pi's "more" key
  opens the reader. Everywhere else it keeps Pi's meaning (tool output).
- **The reader.** `/aside`, ctrl+o on a count line, or a click on that line opens the latest thread at its latest
  question. Esc, Enter, ctrl+o, or its close mark closes it. Typing closes it too and goes on in the editor, with
  the panel open again; a follow-up never needs an extra key first.
- **Tools.** A dim activity line shows the current tool call. Finished shell, edit and write calls leave one
  concise step, such as `✓ $ du -sh ~/.cache` or `✓ write notes/feedback.md`; failures have `✗`. The steps also
  appear in the reader. Tools and their permission behavior are described in §3.9.
- **No session branch.** The side exchange and its tool results remain in memory; nothing is added to `/tree`
  or the main model context. The session file receives usage accounting when the agent is idle. Tools can still
  change shared files or external state, and session-bound extension tools can affect the main session: a side
  conversation is not an isolated filesystem or a sandbox. A session switch cancels the aside and discards it.

### 3.3 Handing off is ghost text

Sometimes the answer shows that the agent should do something else. The handoff reuses what everyone already
knows from shells and IDEs: dim suggested text that Tab accepts.

```text
 │ ╰───────────────────────────────────────────────╯
 ├───────────────────────────────────────────────────┤
 │ █ switch to approach A (see side note)            │  ← dim ghost text in the empty editor
 └───────────────────────────────────────────────────┘
      ⇥ accept
```

- The aside model is told in its notice to end with an optional one-line `handoff`, and only when the question
  implies a change to the agent's work, or the user asks it to pass something on ("tell the agent what we
  found"). Without a handoff line, no ghost text appears.
- Relaying is the same gesture, not a second channel. A relay request is `route: side`: forwarding the words
  verbatim would reach an agent that never saw the conversation. The aside writes the self-contained message in
  its answer, which becomes the side note, and the handoff line points the agent at it. The aside cannot send
  anything itself; the user's Tab and Enter decide whether and when the agent is interrupted.
- **Tab** on an empty editor accepts the suggestion into the editor, using Pi's existing autocomplete meaning. The
  user can edit it. **Enter** sends it with Pi's meaning: a steer while running, the next prompt while idle.
- A sent handoff carries the side Q&A as a custom message next to it, so the agent gets the reasoning as well.
  Nothing reaches the main session without the user's own Enter (A3).
- Typing anything replaces the ghost text, as ghost text always works.

This also covers a wrong guess. `isn't foo.ts generated?` is a correction phrased as a question. It goes to the
side, gets an answer within seconds, and comes back as a sharper steer through Tab and Enter, with no lost text.
Esc closes an open aside first; once it is closed and the 500 ms double-press guard has elapsed, Esc stops the agent.

### 3.4 The route check

A question mark does not make a message a question. `can you also add tests?` is a request, and
`why are you deleting the tests?` usually means "stop". Sent to the side, the first loses an instruction, and the
second lets the agent keep doing harm. These are the only misroutes that cost more than keystrokes.

The aside request itself answers the routing question, so no extra request is needed:
- The notice appended to the question asks the model to start with one hidden line, `route: side` or
  `route: agent`, before tools that can act. `agent` means a request to change or stop the main agent's current
  work. Independent tasks, such as checking disk space or writing a feedback note, stay on the side. The model
  sees the conversation, including what the agent is doing. The
  notice lives in the appended message, not in tools or system, because those are part of the cached prefix.
- `route: side` answers or carries out the independent task on the side (§3.2, §3.9).
- While waiting (§3.1), `route: agent` sends the text as a prompt, which starts a turn: again Pi's meaning.
- `route: agent` stops the aside and sends the user's original text as a steer, which is what Enter would have
  done without pi-aside. The panel shows one line:

```text
 │ ╭─ why are you deleting the tests? ────────────────╮
 │ │ ↪ sent to the agent · it reads as a correction   │
 │ ╰──────────────────────────────────────────────────╯
```

- If the aside fails before the route line, the text is sent as a steer.
- The check runs only on messages the user already sent to the side, and it can only send them back to Pi's
  meaning (rule 5). A false `agent` costs what Pi costs today: the question enters the main context. A false
  `side` is the case of §5.2.
- Delay: the route line arrives with the first tokens of a cache-read request, usually within one or two seconds.
  A steer waits for the end of the current turn anyway, so the added delay is usually hidden in that wait.
- No tool runs before an explicit `side` route; an `agent` route ends the aside before tools. Cancelling
  a request never forwards its partial route line. Esc follows the window behavior in §3.2.

### 3.5 Money is shown only when it is news

| Engine outcome | What the user sees |
|---|---|
| T0, cache read (the normal case, about $0.03) | Nothing |
| T0, cold cache, written, at or above $0.25 | One dim line: `main cache had expired · $0.77`. The write is **not** a prepayment today: Anthropic writes an entry only at a breakpoint, the aside's message breakpoint is after Q, and the main session's next request does not contain Q. A fork-point breakpoint (§5.5) would make it one |
| T1 rebuilt, at or above $0.25 | One dim line in the panel: `rebuilt context · $0.71 · model changed since the last turn` |
| Three T1 asides in a row in one session | One notice with the reason, once |

- Cost already lives in Pi's footer. Every aside's usage entry feeds it (`design.md` §4.6), so the totals stay
  true without new UI.
- The tier, `read x of y` and the hash of P appear in the `/aside` reader's detail line and in the usage note. They
  are for debugging, not for everyday use.
- No confirmation dialogs. The expensive cases are rare and labelled after the fact.

### 3.6 Where "everything" hides

| Capability | Where it lives |
|---|---|
| Ask without derailing | The `?` you already type |
| Ask while subagents run | The same `?`: waiting counts as busy (§3.1, §3.8) |
| Ask when idle | `/aside …`, found through `/` completion |
| Read, inspect disk space, or write a note | The session's callable tools (§3.9) |
| Act on the answer | Ghost text, then Tab and Enter |
| Requests about the main agent's work ending in `?` | The route check sends them to the agent |
| Recover from a wrong guess | Same ghost text |
| Read a long answer | The panel grows; ctrl+o on its count line opens the reader |
| Scroll | Wheel or swipe over the panel or reader (fullscreen) |
| Reread | `/aside` |
| Close the aside | Esc or its close mark |
| Continue or start afresh | Open panel continues, closed starts afresh; the hint says which |
| Stop the agent | Esc once the aside is closed and the double-press guard has elapsed |
| Cheap answers | The engine, invisible |
| Cost accounting | Pi's footer, unchanged |
| Settings | None (A4) |

### 3.7 All keys

| Key | Meaning | New? |
|---|---|---|
| Enter | Send. While busy, a question-mark ending asks on the side (or follows up while the panel is open), subject to the route check. Empty Enter leaves the panel alone | Extended, visibly |
| Alt+Enter | Queue a follow-up | Pi |
| Esc | Close the reader or panel in front; with no aside open, Pi's abort after the 500 ms double-press guard | Window behavior |
| Wheel or swipe | Scroll the panel or reader underneath it; outside, Pi's scrolling | Fullscreen mouse input |
| Click or tap on ✕ | Close the panel or reader | Fullscreen mouse input |
| Click or tap on a count line | Open the reader | Fullscreen mouse input |
| Typing in the reader | Closes it; the text goes on in the editor | Natural |
| Tab | Autocomplete, also accepts the handoff ghost text in an empty editor | Pi |
| ctrl+o | Show more: Pi's tool output; where printed in the panel, the whole aside | Pi, extended only where printed |

### 3.8 Waiting for subagents

- **A report is never held up by an aside.** An aside is a separate request, not a main turn. A subagent report
  that arrives during an aside starts its turn at once, and the aside keeps streaming.
- **The thread follows the main session.** After the report's turn, the next `?` follow-up is forked again from
  the latest state (§3.2), so it sees the report.
- **What the aside cannot see.** It knows the main conversation and the files. It does not see a subagent's live
  progress: `subagents` may be declared `model-only`, which Pi does not make callable from another tool
  (§3.9). When unavailable, the aside answers from the last status in the conversation and says how old it is.
  `/subagents` remains the place to watch them.

### 3.9 Independent tasks and tools

An aside can inspect disk usage with `bash`, write feedback with `write`, and use the session's callable extension
tools. It does not add a separate approval flow: calls go through Pi's validation and existing tool hooks. Tool
overrides and configured shell behavior therefore apply. Inactive tools stay unavailable; Pi's `model-only`
tools are not callable through its nested-tool API. That API also needs an existing main assistant response; a
blank session cannot execute side tools before the main agent has answered once. No fallback runs an unwrapped
built-in tool to bypass a block.

The routing boundary is the main agent's current task, not whether the message is a question or a request.
`/aside <task>` chooses the side explicitly. While busy, a `?` message uses the route check. An ordinary message
without `?` still goes to the main agent; opening the panel does not capture Enter.

The model is told to leave the main agent's files and processes alone. This is guidance, not a lock: both agents
share the workspace, and tools can have external effects. Closing stops further work and requests cancellation of
an in-flight tool; it cannot undo a completed edit or delete. Tool failures are shown to the aside as failures,
not as successful actions. At most 24 model/tool rounds run for one question.

## 4. Feasibility (Pi extension API, checked in `dist/core/extensions/types.d.ts`)

| Need | API |
|---|---|
| The route check's fallback steer | `pi.sendUserMessage` with steer delivery, as in `design.md` §4.7 |
| The waiting state (§3.1) | `pi.events` (`emit`, `on`; `dist/core/event-bus.d.ts`); one emitter in pi-durable-subagents |
| Route a submitted text that ends in `?` while the agent runs | Pi's `input` event (`handled` or `continue`; `streamingBehavior` tells a steer from a follow-up), `ctx.isIdle()`. Implemented this way instead of intercepting the key, so a remapped submit key, bracketed paste and IME need no special handling |
| Esc for the panel; Tab on an empty editor with a pending handoff; refreshing the hint | `ctx.ui.onTerminalInput` (returns `consume`), `getEditorText` |
| The hint below the editor and the panel above it | `ctx.ui.setWidget(key, …, { placement })` |
| Accept the handoff | `ctx.ui.setEditorText` |
| Reader overlay | `ctx.ui.custom(…, { overlay: true })` |
| Panel/reader wheel, close and more targets | Component `handleMouse` in Pi fullscreen mode |
| The handoff's side note | `pi.sendMessage` (custom message), delivered with the user's message |

Ghost text drawn *inside* the editor would need `setEditorComponent`, which conflicts with other editor
replacements. The implementation draws it as a dim `belowEditor` widget line, `⇥ <suggestion>  (tab accepts)`, shown
only while the editor is empty.

## 5. Risks and how they are measured

1. **The route check says `agent` for a real question.** The question becomes a steer, which is Pi's behaviour
   today. Measurement: the rate of `route: agent`, and a local sample of the texts for review. If it is high, the
   notice is tuned. No user harm beyond the status quo.
2. **The route check says `side` for a request or a correction.** Its recovery is the
   handoff (§3.3). Measurement: how often a `?` aside is followed within 30 s by a handoff or by a steer with
   similar text. If that happens in more than 15 % of asides over a week of real use, the rule becomes opt-in, and
   the hint offers the side instead (key decided then). A correction misrouted this way lets the agent keep going
   until the user hands off or closes the aside and then stops the agent. A steer does not stop the agent at once either, because it lands after
   the current turn; Esc first closes the visible aside, then can stop the agent. This is the one misroute that does harm.
   Measurement: an Esc within 10 s of a `side` aside. Before release, a fixed set of 40 messages (English and
   Chinese requests, corrections and questions, from real sessions) must route with no `side` error on a request
   or correction about the main agent's work. If real use shows users getting burned, the rule becomes opt-in regardless of the 15 % figure.
3. **Discovery depends on typing a question mark.** Users who never end a question with `?` or `？` (common in
   Chinese chat) never see the hint. They keep Pi's behaviour and can use `/aside`. Matching words such as `吗`
   (a Chinese question particle) was rejected: word lists are per language, and `吧` or `呢` often end requests.
4. **Raw-input interception is fragile.** Bracketed paste, IME composition and remapped `tui.input.submit` must
   keep working. S0-UX tests them, and the extension reads Pi's keybindings instead of hard-coding Enter.
5. **The cold write is wasted.** Writes happen only at breakpoints (Anthropic, "How automatic prefix checking
   works"), and pi-ai marks only the last user block, so a cold aside's entry ends after Q, and the main session's
   next turn cannot read it. `design.md` §3 ("The write serves the main session's next turn") has the same
   error. Proposed engine change: one more breakpoint at the fork point, so the main session's next request finds it
   within its 20-position lookback. The fork point is the last block of `T ++ G` that the next main request will
   repeat byte for byte, so it is never a "still running" placeholder result, whose real result will differ. A
   cold cache usually means an idle session, where G is the final reply and has no placeholder. To check in S0: a free marker slot (3 used
   with an API key, 4 with OAuth, so one would move), a marker on an assistant block when G ends with one, and
   that I4 and C1–C3 still hold because markers are stripped.
6. **Nothing here is proven yet.** "Nobody has to be taught" is a test result, not a claim. See U1.
7. **A stale waiting count.** If an emitter never reports zero, questions to a really idle agent keep going to the
   side. The hint shows this before every send, a session switch clears the counts, and U10 tests that the
   emitter reports zero when the last workflow ends.

## 6. Acceptance (adds to `design.md` §7)

| ID | Assertion | Method |
|---|---|---|
| U1 | Untaught use: three Pi users who were not told about pi-aside get a side answer and act on it in a scripted scenario | Observed session; no hints from the observer |
| U2 | Esc closes an open panel, cancelling only the aside; a rapid second Esc does not stop the agent; a later Esc keeps Pi's behavior | Key replay |
| U3 | The hint below the editor is present exactly when Enter will ask on the side | Snapshot plus key replay |
| U4 | Normal-path screens contain no tier, cache, token or price text | Snapshot |
| U5 | Nothing reaches the main session without the user's Enter; a handoff adds exactly one custom message | Capture server plus session file |
| U6 | Paste, IME and a remapped submit key behave as without pi-aside | Key replay |
| U7 | Misroute rates are logged locally (§5.1, §5.2) | Usage note field |
| U8 | Route check: the 40-message set routes with no `side` error on a request or correction about the main task; an aside failure before the route line sends a steer | Fixture set against the capture server; injected failure |
| U9 | Question-mark detection: `?`, `？`, `؟` and U+037E qualify after trailing whitespace, brackets and quotes; an end inside a code fence does not; `吗` without a mark does not | Unit fixtures |
| U10 | Waiting: with a pi-durable-subagents workflow pending and Pi idle, a `?` message shows the hint, asks on the side and starts no turn; a report during the aside starts its turn at once; the next `?` sees the report; the count returns to zero when the last workflow ends, and the hint disappears | Scripted session with a stub workflow |

| U11 | A wheel or swipe over the panel scrolls it, including at its boundaries; tap close/more works in fullscreen; the reader also scrolls | Mouse-event replay in real Pi |
| U12 | Independent tasks run callable tools with validation and permission hooks; a cancelled aside never forwards or starts later tool calls | Capture server, tool fixtures and cancellation regressions |

## 7. Earlier design mistakes (historical)

Revision 1 was designed without checking Pi's keymap:
- **We overvalued an unchanged keymap.** Revisions 2–7 reserved Esc for interrupting the agent even with a
  framed aside visible. In actual use people repeatedly pressed Esc to close the window and stopped their main
  work instead. Revision 8 follows that expectation: close what is in front first, with a double-press guard.
  Tab still belongs to autocomplete.
- **It broke its own rule.** Tab meant ask, reopen and hand off. Two Tabs could send something to the main
  session.
- **It had a silent wrong destination.** While a note was open, Enter went to the aside. A steer typed then
  (`stop, use A`) would never reach the agent. That is the worst class of interaction error.
- **Its cost confirmation was misplaced.** Cold writes are rare, and a dialog on every one adds friction to the
  common cheap case; a label after the fact is enough.
- **It invented UI** (a focusable note, a four-state machine) where Pi's existing widgets and keys already do the
  job.

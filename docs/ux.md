# pi-aside: interaction design

Status: implemented, revision 5 (§4: Enter is routed through Pi's `input` event, and the ghost text is a line below the editor; §3.2: an answer still streaming does not collapse; see `implementation.md` §2). Revision 4: busy includes waiting for subagents (§3.1, §3.8), and follow-ups see the latest main state (§3.2). This document covers only what the user sees and does. The engine in `design.md`
(observation, T0/T1, C1–C3, routing, accounting) changes in two places only: follow-ups fork again when the main session has moved (§3.2), and a fork-point breakpoint is proposed (§5.5). Revision 1 is critiqued in §7.

## 1. The goal

> It looks like nothing is there, yet everything is there. Nobody has to be taught, and it feels great to use.

In practice this means five rules:
1. **Change nothing that already works.** Fix only the moment that hurts.
2. **No new keys, no new words.** Reuse what Pi users already know: Enter, Alt+Enter, Esc and Tab, each with the
   meaning Pi already gives it. Never show `tier`, `cache` or `fork` on the normal path.
3. **No modes.** A key means the same thing whatever is on screen. Anything that changes what Enter does must be
   visible *before* the user commits.
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
  editor: `↵ asks on the side · corrections still reach the agent`. If the text has no `?`, nothing new is
  shown.
- The rule is one character long and lives in the user's own text. To steer with a question, the user deletes the
  `?`. To ask the agent itself, the user presses Alt+Enter.
- People already put `?` on questions, so the rule is learned by using it, not by reading about it.

### 3.2 The answer sits above the editor and never takes focus

```text
 │ ● editing src/adapter.ts                         ← main session keeps streaming
 │
 │ ╭─ why did it pick B? ─────────────────────────╮
 │ │ A touches three callers; B stays inside the   │  ← widget (aboveEditor),
 │ │ adapter and keeps the retry logic intact.▌    │    not focusable
 │ ╰───────────────────────────────────────────────╯
 ├───────────────────────────────────────────────────┤
 │ █                                                 │  ← editor keeps every key
 └───────────────────────────────────────────────────┘
```

- **No focus, so no modes.** Esc still aborts the agent and Tab still completes. Enter still follows §3.1.
- **Follow-ups.** Another `?` message while the panel is expanded continues the same side thread. That is how a
  conversation already works. If the main session has gained messages since the thread's last request (a
  subagent report, a finished tool call, a steer), the follow-up is forked again from the latest observation,
  and the earlier side exchange rides inside the new appended message as quoted context. A follow-up therefore
  never answers from a stale snapshot. This amends `design.md` §4.5, which always continues
  `T ++ G ++ Q ++ A1 ++ Q2`.
- **Dismissal needs no key.** When the user next sends anything to the agent, the panel collapses to one dim line
  (`▸ why did it pick B?`). An answer still streaming stays expanded: the user is waiting for it. The next aside replaces it, and a session switch clears it.
- **Long answers.** While streaming, the panel shows the last 10 lines. When the answer is done, it shows the
  first 10 lines and `… /aside to read all`. `/aside` with no argument opens the latest aside in a reader overlay.
  The reader is an explicit modal with its own footer, and Esc closes it, as in every Pi selector.
- Read-only tools run silently. A dim line such as `reading src/adapter.ts` appears while one runs.
- **The session does not fork.** The side thread is an in-memory continuation of the main request
  (`design.md` §4.2: `T ++ G ++ Q`, where G is what the branch gained since the observed request). It sees the
  conversation up to the last completed message, not the reply still streaming. Nothing appears in `/tree`, the
  transcript or the model context. The session file gains one usage entry per aside request, written once the
  agent is idle (`design.md` §4.6). A session switch discards the thread.

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
  implies a change to the agent's work. Without a handoff line, no ghost text appears.
- **Tab** on an empty editor accepts the suggestion into the editor, using Pi's existing autocomplete meaning. The
  user can edit it. **Enter** sends it with Pi's meaning: a steer while running, the next prompt while idle.
- A sent handoff carries the side Q&A as a custom message next to it, so the agent gets the reasoning as well.
  Nothing reaches the main session without the user's own Enter (A3).
- Typing anything replaces the ghost text, as ghost text always works.

This also covers a wrong guess. `isn't foo.ts generated?` is a correction phrased as a question. It goes to the
side, gets an answer within seconds, and comes back as a sharper steer through Tab and Enter, with no lost text.
Esc still stops the agent at once if something urgent happens meanwhile.

### 3.4 The route check

A question mark does not make a message a question. `can you also add tests?` is a request, and
`why are you deleting the tests?` usually means "stop". Sent to the side, the first loses an instruction, and the
second lets the agent keep doing harm. These are the only misroutes that cost more than keystrokes.

The aside request itself answers the routing question, so no extra request is needed:
- The notice appended to the question asks the model to start with one hidden line, `route: side` or
  `route: agent`. `agent` means the user is asking the agent to do, stop or change something. The model sees the
  whole conversation, including what the agent is doing, so it judges this much better than any word list. The
  notice lives in the appended message, not in tools or system, because those are part of the cached prefix.
- `route: side` (the usual case) shows the answer as in §3.2.
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
- Esc remains the brake. It aborts the agent at once, as in Pi.

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
| Read the codebase | Read-only tools, run silently |
| Act on the answer | Ghost text, then Tab and Enter |
| Requests and corrections that end in `?` | The route check sends them to the agent |
| Recover from a wrong guess | Same ghost text |
| Reread or scroll | `/aside` |
| Stop the agent | Esc, unchanged |
| Cheap answers | The engine, invisible |
| Cost accounting | Pi's footer, unchanged |
| Settings | None (A4) |

### 3.7 All keys

| Key | Meaning | New? |
|---|---|---|
| Enter | Send. While busy, a question-mark ending asks on the side unless the route check finds a request or correction (shown before sending) | Extended, visibly |
| Alt+Enter | Queue a follow-up | Pi |
| Esc | Abort the agent; close the reader overlay | Pi |
| Tab | Autocomplete, which now also accepts the handoff ghost text in an empty editor | Pi |

Revision 1 had Tab with three meanings, Esc meaning "dismiss", and a focus mode. Revision 2 has no new key.

### 3.8 Waiting for subagents

- **A report is never held up by an aside.** An aside is a separate request, not a main turn. A subagent report
  that arrives during an aside starts its turn at once, and the aside keeps streaming.
- **The thread follows the main session.** After the report's turn, the next `?` follow-up is forked again from
  the latest state (§3.2), so it sees the report.
- **What the aside cannot see.** It knows the main conversation and the files. It does not see a subagent's live
  progress: `subagents` is not one of the read-only built-ins, so a call gets "not available in an aside"
  (`design.md` §4.4). It answers from the last status in the conversation and says how old that is. `/subagents`
  remains the place to watch them. Letting an extension declare read-only calls (such as `status`) to the aside
  is possible later; it is not part of this design.

## 4. Feasibility (Pi extension API, checked in `dist/core/extensions/types.d.ts`)

| Need | API |
|---|---|
| The route check's fallback steer | `pi.sendUserMessage` with steer delivery, as in `design.md` §4.7 |
| The waiting state (§3.1) | `pi.events` (`emit`, `on`; `dist/core/event-bus.d.ts`); one emitter in pi-durable-subagents |
| Route a submitted text that ends in `?` while the agent runs | Pi's `input` event (`handled` or `continue`; `streamingBehavior` tells a steer from a follow-up), `ctx.isIdle()`. Implemented this way instead of intercepting the key, so a remapped submit key, bracketed paste and IME need no special handling |
| Tab on an empty editor with a pending handoff; refreshing the hint | `ctx.ui.onTerminalInput` (returns `consume`), `getEditorText` |
| The hint below the editor and the panel above it | `ctx.ui.setWidget(key, …, { placement })` |
| Accept the handoff | `ctx.ui.setEditorText` |
| Reader overlay | `ctx.ui.custom(…, { overlay: true })` |
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
   until the user hands off or presses Esc. A steer does not stop the agent at once either, because it lands after
   the current turn, and Esc is the real brake in both cases. This is the one misroute that does harm.
   Measurement: an Esc within 10 s of a `side` aside. Before release, a fixed set of 40 messages (English and
   Chinese requests, corrections and questions, from real sessions) must route with no `side` error on a request
   or correction. If real use shows users getting burned, the rule becomes opt-in regardless of the 15 % figure.
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
| U2 | No key changes meaning based on what is on screen; Esc aborts the agent with the panel visible | Key replay |
| U3 | The hint below the editor is present exactly when Enter will ask on the side | Snapshot plus key replay |
| U4 | Normal-path screens contain no tier, cache, token or price text | Snapshot |
| U5 | Nothing reaches the main session without the user's Enter; a handoff adds exactly one custom message | Capture server plus session file |
| U6 | Paste, IME and a remapped submit key behave as without pi-aside | Key replay |
| U7 | Misroute rates are logged locally (§5.1, §5.2) | Usage note field |
| U8 | Route check: the 40-message set routes with no `side` error on a request or correction; an aside failure before the route line sends a steer | Fixture set against the capture server; injected failure |
| U9 | Question-mark detection: `?`, `？`, `؟` and U+037E qualify after trailing whitespace, brackets and quotes; an end inside a code fence does not; `吗` without a mark does not | Unit fixtures |
| U10 | Waiting: with a pi-durable-subagents workflow pending and Pi idle, a `?` message shows the hint, asks on the side and starts no turn; a report during the aside starts its turn at once; the next `?` sees the report; the count returns to zero when the last workflow ends, and the hint disappears | Scripted session with a stub workflow |

## 7. Why revision 1 was not good enough

Revision 1 was designed without checking Pi's keymap:
- **It collided with Pi.** Esc is `app.interrupt`, so "Esc hides the note" would have taken over the user's way to
  stop the agent. Tab is autocomplete.
- **It broke its own rule.** Tab meant ask, reopen and hand off. Two Tabs could send something to the main
  session.
- **It had a silent wrong destination.** While a note was open, Enter went to the aside. A steer typed then
  (`stop, use A`) would never reach the agent. That is the worst class of interaction error.
- **Its cost confirmation was misplaced.** Cold writes are rare, and a dialog on every one adds friction to the
  common cheap case; a label after the fact is enough.
- **It invented UI** (a focusable note, a four-state machine) where Pi's existing widgets and keys already do the
  job.

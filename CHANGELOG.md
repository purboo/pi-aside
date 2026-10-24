# Changelog

## 0.5.3

- Messages a moved-out window sent while the main Pi was not running now arrive as one message when the session
  is resumed, instead of one steer after another: oldest first, each with its send time, identical re-sends
  shown once (`×2`), and the agent is told that some may repeat an earlier request or be out of date.

## 0.5.2

- Fixed: after the main Pi restarted, messages from a moved-out window were reported as delivered but never
  arrived. The inbox now belongs to the session, not the process: resuming the session (`pi --session <id>`)
  delivers everything sent meanwhile, including from windows opened by older versions.
- A moved-out window says a message is queued, not delivered, while no Pi is running the original session, and
  names the command that resumes it.

## 0.5.1

- Fixed: on models without inline tool additions (such as Anthropic-compatible providers with
  `supportsMidConvoToolChanges: false`), every new aside rebuilt the whole context
  (`rebuilt: not expected to hit (the fork changed tools)`). Relaying and moving out are now hidden reply
  lines, `tell:` and `move:`, so the aside declares no tools and reads the main session's cache again.
- A moved-out window sees earlier relays as its own `tell_agent` calls, so its model no longer denies them.

## 0.5.0

- Ask the aside to tell the main agent: its internal `tell_agent` tool sends a self-contained steer without
  aborting the current step. The panel shows the sent message and a plain sentence for queued/read status;
  the main transcript marks the relay `aside ›`.
- Optional hidden `next:` suggestions appear as gray `/aside …` text beside the empty editor. Tab fills it;
  Enter follows up on the aside. Typing clears it. The old handoff and side-note relay are removed.
- At the 24th tool response, skip those calls and request one summary, with a continuation suggestion.
- Ask to move out: preserve the fork and whole aside in a named, resumable Pi session; open and select an
  adjacent tmux window, or copy/show a resume command. Promoted windows can relay findings to the parent inbox.
- Expand the panel's close target to two rows and restrict reader clicks to the visible count text.
- Completed panels have no cost footer. Usage accounting and the reader's details remain available.
- Pi has no editor placeholder API, so suggestions are a dim line flush with the editor; custom editor
  extensions keep working. Models without native tool additions use the existing conservative rebuilt path.
- A moved-out window goes on by itself only when the move cut tool calls short. Its transcript says plainly
  that the move happened, so its model does not disown the `move_out` call.
- Fixed for Pi 1.4.0: `/reload` no longer crashes Pi through a timer that touched the old extension context.
- In a session where the agent has not replied yet, aside tools say so plainly instead of Pi's internal
  "No assistant message issued this call".
- The aside's own tools are declared once per fork, so later questions do not invalidate the provider cache.

## 0.4.1

- Asking the aside to pass something on to the main agent ("tell it what we found") now produces a handoff: the
  aside writes a self-contained message from the side conversation, and Tab then Enter sends it with the side
  note. Such requests stay in the aside instead of reaching an agent that never saw the conversation.

## 0.4.0

- Esc closes the aside panel and cancels its work while the main agent keeps going. A quick second Esc is
  ignored for 500 ms; with no aside open, Esc keeps Pi's behavior. Autocomplete and focused dialogs close first.
- In fullscreen mode, a wheel or swipe over the panel scrolls the aside, even at its boundaries. A close mark
  works by click or tap, and clicking a “more lines” count opens the reader. The reader also scrolls and closes
  by touch or mouse. Keyboard paths remain available in regular mode.
- The panel has open and closed states. Empty Enter and messages sent to the agent leave it open; the folded
  line and its Enter hints are gone. An open panel continues its thread; after closing, a question starts afresh.
- Independent tasks can use the session's callable tools, including shell commands, file edits and extension
  tools, through Pi's argument validation and permission hooks. Disabled tools stay disabled; Pi's `model-only`
  tools are not callable through its nested-tool API. No separate confirmation flow is added.
- The route check distinguishes changes to the main agent's current task from independent side tasks. An
  explicit `side` route is required before tools that can act. Cancelled and replaced requests never forward
  a partial route or run later calls.
- Finished shell, edit and write calls leave concise steps in the panel and reader. A question can use up to
  24 model/tool rounds. Closing cancels further work; completed changes are not undone.
- Costs reported by extension tools are counted once, including nested calls and paid results after cancellation.

## 0.3.0

- The panel grows with its answer instead of stopping at 10 lines: up to half the screen while the agent runs, so
  its work stays in view, and up to the room above Pi's editor otherwise. A longer answer shows its end while it
  streams and its start once it is done, with one line counting the rest: `↓ 12 more lines · ctrl+o`.
- ctrl+o belongs to the panel only where the panel prints it, and there it opens the reader. Everywhere else it is
  Pi's again (tool output); 0.2.0 toggled both.
- An open panel means a follow-up, a folded or cleared one a fresh question, and the hint under the editor says
  which before Enter: `↵ follows up on the side` or `↵ asks on the side`.
- A follow-up's panel shows the new question as its title and one dim line naming the question before.
- Enter on an empty editor folds the panel (`↵ folds`), then clears the folded line (`↵ clears`).
- Typing in the reader closes it and goes on in the editor, with the panel open again; Enter and ctrl+o close it
  too. Its letter keys (`q`, `j`, `k`, space) no longer scroll, since they type.

## 0.2.0

- The panel is never an empty box: before the first words it shows Pi's spinner with `working` and the seconds so
  far, then `thinking` with the last lines of the model's thinking.
- Asides answer sooner on models that take effort changes mid-conversation (the Claude models with
  `supportsMidConvoEffort`, Responses models with `configuration_update`): they think at a `low` effort, sent as the
  trailing configuration item, so the cache read is unchanged. A second dry run proves that only that item differs;
  otherwise the main session's level is kept.
- Answers, thinking and the `/aside` reader render as Markdown.
- Enter on an empty editor puts the panel away: the frame collapses to one line, and a second Enter clears it.
  The frame shows `↵ hides` while the editor is empty.
- ctrl+o (Pi's "more") expands a long answer to the terminal's room and reopens a collapsed panel; Pi still
  toggles its tool output. A truncated answer ends with `… ctrl+o more`.
- The `/aside` reader opens at the latest question, and its lines wrap at the frame instead of being cut.
- `aside:done` carries `effort`, `firstTextMs` and `totalMs`.

## 0.1.0

First release.

- Ask on the side: while the agent runs (or waits for background work), a message ending in a question mark is
  answered above the editor from a fork of the main session's request, at the cache-read price. `/aside <question>`
  asks at any time; `/aside` rereads the latest side conversation.
- Exact forks for `anthropic-messages`, `openai-responses` and `openai-completions` over HTTP/SSE, checked request
  by request (C1–C3), with a rebuilt fallback everywhere else.
- The route check sends requests and corrections phrased as questions back to the agent; handoff suggestions are
  accepted with Tab.
- Read-only tools in the aside, usage entries in the session file, and an observation of the request Pi actually
  sends whatever the extension load order.

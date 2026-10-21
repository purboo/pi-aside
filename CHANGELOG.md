# Changelog

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

# pi-aside

Ask a side question about a running [Pi](https://github.com/earendil-works/pi) session without touching it, at the
cache-read price.

While the agent works, end a message with a question mark and press Enter:

```text
── ⠋ Working ───────────────────────────────────────────────────────────
why did it pick approach B?
────────────────────────────────────────────────────────────────────────
↵ asks on the side · corrections still reach the agent
```

The answer appears above the editor while the agent keeps going:

```text
╭─ why did it pick approach B? ─────────────────────────────────────────╮
│ A touches three callers; B stays inside the adapter and keeps the      │
│ retry logic intact.                                                    │
╰────────────────────────────────────────────────────────────────────────╯
```

The exchange stays on the side. Ask the aside to “tell the agent …” when you want it to relay a self-contained
message, or “move this to its own window” to continue in a separate Pi. If the message was meant for the agent, press ↑
and Enter: it goes to the agent as you wrote it.

## Install

```sh
pi install npm:pi-aside
```

or from a checkout: `pi install /path/to/pi-aside`.

## Use

| You do | What happens |
|---|---|
| End a message in `?` (or `？`, `؟`) and press Enter **while the agent runs** | Asked on the side. The dim hint under the editor shows it before you press Enter. |
| The same while the agent is idle | Pi's meaning: a normal prompt. |
| Anything without a final question mark | Pi's meaning: a steer while running, a prompt while idle. |
| Alt+Enter | Pi's meaning: a follow-up. |
| Another `?` message while the answer is shown | Follows up in the same side conversation. The hint says `↵ follows up on the side`, the panel's title becomes your new question, and one dim line names the one before. |
| A `?` message after the panel was closed | A fresh side conversation (`↵ asks on the side`). |
| Send anything to the agent | The panel stays open until you close it. |
| Enter on an empty editor | Keeps Pi's behavior; the panel stays open. |
| ctrl+o where a long answer shows `↓ 12 more lines · ctrl+o` | Opens the whole conversation in a reader. Everywhere else ctrl+o keeps Pi's meaning (tool output). |
| Typing in the reader | Closes it and goes on in the editor; the panel opens again, so a `?` follows up. |
| `/aside <question>` | Asks on the side, busy or not. |
| `/aside` | Opens the latest side conversation in the reader, at the latest question. Esc closes it. |
| Tab on an empty editor with a gray `/aside …` suggestion | Fills the suggestion; Enter sends it to the aside. Typing clears it. |
| “Tell the agent …” in the aside | Sends a self-contained relay marked `aside ›`; the panel shows what was sent and whether the agent has read it. |
| ↑ then Enter after a `?` message went to the side | Sends it to the agent instead, as you wrote it, as if pi-aside had not taken it; the aside stops and keeps what it said. While the aside answers, an empty editor shows `↑↵ sends it to the agent instead`. Works until another aside starts or two minutes after the answer. Typing the same question again still asks on the side. |
| Tap or click ↪ beside ✕ | The same, in fullscreen. |
| “Send that to the agent as it is” in the aside | Sends your previous message unchanged, as your own message. |
| “Move this to its own window” in the aside | Opens a named Pi window beside the current tmux window, with the conversation and tools preserved. Outside tmux, copies or shows the resume command. |
| Esc while the aside works | Stops it at once; the main agent keeps going. The panel stays with what the aside did and where it stopped: finished steps, the text so far, and `■ $ bun run build · stopped · 41s`. A follow-up (`?` while the agent runs, `/aside` otherwise) continues after it, and still reads its cache. The panel's bottom edge says what Esc does now (`esc stop`, `esc close`), and so does Pi's working line (`Working · esc stops the aside first`). |
| Esc once it has stopped or answered | Closes the panel. Then Esc is Pi's again and stops the agent. An Esc within 500 ms of the one before does nothing, so a double press never goes further than one step. |
| Swipe or wheel over the panel | Scrolls the aside. Outside it, Pi's scrolling. Requires fullscreen mode and a terminal that reports mouse events. |
| Tap or click ✕ | Closes the panel or reader (fullscreen). |
| Tap or click a “more lines” count | Opens the reader (fullscreen). |

An aside can also do an independent task: `/aside check disk usage` or `/aside write this feedback to notes/tool.md`.
It uses the session's callable tools through Pi's validation and permission hooks, with no extra approval flow.
Finished shell, edit and write calls leave concise steps in the panel. Tools share the workspace; stopping the
aside kills the running command and skips the rest, but does not undo completed changes. Pi's `model-only` tools cannot run through its
nested-tool API. This API also requires an existing main assistant response: immediately after starting a blank
session, let the main agent answer once before asking an aside to run tools.

A question mark does not always make a message a question: `can you also add tests?` may concern the main agent's
current task. The aside model starts its reply with a hidden route line. Independent tasks stay on the side;
when the message is about changing the main agent's current work, pi-aside sends your
original text as a steer, which is what Enter would have done without it, and says so:
`↪ sent to the agent · it reads as a correction`. When it guesses wrong, or you wanted the agent itself to
answer, ↑ ↵ sends your message on ([ux.md §3.4.1](docs/ux.md#341-sending-it-to-the-agent-instead)).

"Running" also covers waiting for background work: when an extension reports pending work (for example, subagents
whose reports will wake the agent), a `?` message asks on the side instead of starting a turn. See
[the convention](docs/ux.md#31-the-question-mark-is-the-interface).

## What it costs

An aside is a fork of the main session's request, so it reads the main session's prompt cache. With a 150K-token
session, an aside costs about $0.03 instead of the $0.75 a cold request would cost. Measured on a real Anthropic relay
with a 16.7K-token session, with every installed extension loaded:

```text
aside: exact · read 16,729 of 16,729 cacheable, wrote 190 · $0.004
```

Usage stays in Pi’s totals; `/aside` opens a reader with cost and cache details. The panel has no cost footer.

## How it works

pi-aside observes the request the main session actually sent (P) and the transcript it came from. An aside rebuilds
that request with the same recipe, appends what the session gained since then and the question, checks that the
result extends P byte for byte (checks C1–C3), and sends it through Pi's model registry with the main session's
credentials. Any check that fails falls back to a rebuilt request, labelled `rebuilt`, which still works but does not
read the cache. A compaction keeps the observed request while its cache is warm (5 minutes, or 1 hour with a
1-hour cache marker): an aside right after pi-zip or `/compact` still reads it. The reader's detail line shows
the first request's cache counts, then the totals when tool rounds made more requests.

- Exact forks require native mid-conversation tool additions to preserve the main tool declarations. Otherwise the
  existing checks select the rebuilt path. Supported APIs are `anthropic-messages`, `openai-responses` and
  `openai-completions` over HTTP/SSE. Other APIs and stateful transports use the rebuilt path.
- The aside uses the session's callable tools, up to 24 rounds per question, then one summary request.
  `/aside continue` starts fresh rounds. Its internal relay and move tools remain available even without main tools.
  Disabled session tools stay disabled; Pi's existing overrides, argument validation and tool hooks apply.
- Each aside request adds one usage entry to the session file once the agent is idle, so `/session` costs stay
  complete.

Design: [docs/design.md](docs/design.md) (engine) and [docs/ux.md](docs/ux.md) (interaction).
Implementation notes, deviations and verification: [docs/implementation.md](docs/implementation.md).

## Development

```sh
bun install
bun run link-pi     # links the installed Pi packages into node_modules
bun run check       # tsc and every test (offline: a local capture server, real Pi over RPC and in tmux)
```

## License

MIT

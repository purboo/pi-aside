# Changelog

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

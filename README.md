# pi-aside

Ask a side question about a running [Pi](https://github.com/earendil-works/pi) session without touching it, at the
cache-read price.

```text
/aside why did it pick that approach?
```

The aside repeats the request the main session last sent, byte for byte, and appends your question. The provider
serves the whole conversation from the main session's prompt cache. The main session's transcript, its next
requests and every extension's state stay exactly as they were. Each answer shows how much the provider read from
cache.

The proposed interaction needs no new key: while the agent is busy, a message ending in a question mark is asked
on the side, and everything else keeps the meaning Pi gives it.

Status: design, nothing is implemented yet.
- [docs/design.md](docs/design.md): the engine (observation, cache tiers, checks, accounting).
- [docs/ux.md](docs/ux.md): the interaction design (what the user sees and does).

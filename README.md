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

Status: design. See [docs/design.md](docs/design.md).

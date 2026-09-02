# Go rewrite status

The Go implementation is being developed alongside the production Node.js application on the `rewrite/go` branch. The Node.js files remain the compatibility reference until the rewrite reaches feature parity.

## First slice

- Compatible loading of `data/config.json` and `data/rules.json`
- Fixed A, AAAA, and CNAME rules with existing precedence semantics
- Parallel upstream forwarding with UDP-to-TCP retry on truncated replies
- TTL-aware bounded LRU cache (default: 2,000 entries)
- Time- and count-bounded query history (default: one day / 10,000 entries)
- DNS listeners on both UDP and TCP
- Clean signal-driven shutdown

The Web API, authentication, persistence, SSE, and embedded Web console remain to be ported.

## Router build target

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOARM64=v8.0 \
  go build -trimpath -ldflags="-s -w" -o dist/kaven-dns ./cmd/kaven-dns
```

Suggested Xiaomi BE3600 runtime environment:

```sh
GOMEMLIMIT=64MiB GOMAXPROCS=2 ./kaven-dns
```

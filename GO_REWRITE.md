# Go rewrite status

The Go implementation is being developed alongside the production Node.js application on the `rewrite/go` branch. The Node.js files remain the compatibility reference until the rewrite reaches feature parity.

## Implemented

- Compatible loading of `data/config.json` and `data/rules.json`
- Fixed A, AAAA, and CNAME rules with existing precedence semantics
- Parallel upstream forwarding with UDP-to-TCP retry on truncated replies
- TTL-aware bounded LRU cache (default: 2,000 entries)
- Time- and count-bounded query history (default: one day / 10,000 entries)
- DNS listeners on both UDP and TCP
- Clean signal-driven shutdown
- Node-compatible scrypt and legacy password verification
- Persisted bearer sessions with login throttling
- Authenticated rules, configuration, query, cache, statistics, resolve-test, and shutdown APIs
- Bounded SSE updates (maximum four consoles; five-second state interval)
- Existing `queries.json` restoration and clean-shutdown persistence
- Existing offline Vue console embedded in the executable
- Atomic configuration, rule, session, and query snapshot writes

## Remaining compatibility work

- Live DNS and Web listener moves when their configured ports or bind addresses change
- Console/operation log capture
- Remote stable-version update checks
- Full bilingual validation parity for every API error
- Automated visual checks for Chinese, English, desktop, and narrow mobile layouts

## Router build target

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOARM64=v8.0 \
  go build -trimpath -ldflags="-s -w" -o dist/kaven-dns ./cmd/kaven-dns
```

Suggested Xiaomi BE3600 runtime environment:

```sh
GOMEMLIMIT=64MiB GOMAXPROCS=2 ./kaven-dns
```

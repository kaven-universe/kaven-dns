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
- Live DNS UDP/TCP and Web listener changes with rollback on bind failure
- Bounded console and operation logs exposed through REST and SSE
- Stable GitHub release checks with a five-second timeout and bounded response parsing
- Chinese and English errors for authentication, listener, update, configuration, and rule-validation paths
- OpenWrt arm64 package with `procd`, upgrade-safe installation, and low-memory defaults

## Remaining compatibility work

- Exact bilingual wording parity for lower-priority validation edge cases
- Automated visual checks for Chinese, English, desktop, and narrow mobile layouts

## Router deployment

Build the OpenWrt arm64 bundle on Windows:

```powershell
./scripts/build-router.ps1
```

The command creates `dist/kaven-dns-openwrt-arm64.tar.gz` and its SHA-256
checksum. The bundle contains the static executable, a `procd` service,
installer, uninstaller, low-memory defaults, and router setup instructions.

The package uses `127.0.0.1:5330` for DNS because OpenWrt's `dnsmasq` normally
owns port 53. After verifying Kaven DNS, configure `dnsmasq` to forward to that
port as described in the package's `README.txt`. The Web console listens on
port 8080.

The equivalent binary-only build command is:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOARM64=v8.0 \
  go build -trimpath -ldflags="-s -w" -o dist/kaven-dns ./cmd/kaven-dns
```

Suggested Xiaomi BE3600 runtime environment:

```sh
GOMEMLIMIT=64MiB GOMAXPROCS=2 ./kaven-dns
```

The router profile also lowers query history to 2,000 entries and cache size to
1,000 entries. Existing configuration is preserved during installation and
upgrade, so these defaults only apply to a new router installation.

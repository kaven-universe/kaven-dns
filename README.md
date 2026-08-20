# kaven-dns

A DNS server built on Node.js with a Web console for monitoring and management.

## Features

- **Standard DNS service**: listens on both UDP and TCP; supports A / AAAA / CNAME and passes common record types through
- **Dynamic resolution rules** (add / edit / delete take effect immediately, no restart):
  - `Fixed answer`: return a specified IP (or several) or a CNAME target directly
  - `Forward`: forward the query to a third-party DNS (a per-rule upstream can be set, e.g. `8.8.8.8`); queries that match no rule go to the default upstream group
  - **Domain groups**: one rule holds multiple domains (one per line in the editor, up to 500); they share the same configuration, and editing the rule applies to the whole group at once
- **Answer caching**: forwarded answers are cached by their minimum TTL (bounds configurable), with LRU eviction, hit-rate stats and one-click flush
- **Upstream racing**: default upstreams are queried in parallel and the fastest successful response wins; TC-flagged answers are automatically retried over TCP
- **Bilingual Web console** (Chinese / English, simple password authentication):
  - Language switcher on the login page and in the header; the preference is remembered and auto-detected from the browser on first visit
  - Dashboard: query volume, rule/cache/forward hits, failures, average latency, cache hit rate, live query log (domain / source filters)
  - Rules management: table + modal editor, enable toggle, remarks
  - Settings: upstream list, cache and log parameters, ports, password change, cache flush, resolve test
  - API error messages are localized too, negotiated from the `Accept-Language` header
- **No database**: rules and config persist to `data/*.json` (atomic writes); logs and stats live in memory

## Quick Start

```bash
pnpm install
pnpm start
```

On first run an admin password is generated and printed to the console, then open <http://127.0.0.1:8080> to sign in.

> Listening on port 53 requires administrator privileges:
> - Windows: run the terminal as administrator; or start with a debug port first: `KAVEN_DNS_PORT=5330 pnpm start`
> - After allowing UDP/TCP 53 through the firewall, LAN devices can point their DNS at this machine

## Verification

```bash
# Forwarded resolution (the second query hits the cache; the source column
# in the dashboard log changes accordingly)
nslookup baidu.com 127.0.0.1

# After adding a fixed rule test.local -> 1.2.3.4 on the Rules page:
nslookup test.local 127.0.0.1
```

## Rule Matching

A rule holds a group of domain patterns; a query matches the rule when it matches any pattern in the group. The table below is per pattern:

| Pattern | Matches |
|---|---|
| `example.com` | itself and all subdomains (dnsmasq style) |
| `*.example.com` | subdomains only, not itself |

- Priority: patterns with more labels (longer suffix) win; among equal label counts, plain patterns beat wildcards. When different rules tie on specificity, the newer rule wins — so an override added after a group rule takes effect.
- Record types must match the query type; CNAME rules are the exception — an A/AAAA query returns the CNAME plus the target's resolved records
- Legacy rules persisted with a single `domain` field are migrated to the `domains` array automatically on startup

## Configuration

`data/config.json` (editable on the Settings page):

| Field | Default | Description |
|---|---|---|
| `dnsPort` | 53 | DNS listen port (UDP+TCP); restart required after change |
| `webPort` | 8080 | Web console port; restart required after change |
| `upstreams` | `223.5.5.5, 119.29.29.29, 114.114.114.114` | Default upstream group (`ip` or `ip:port`) |
| `forwardTimeoutMs` | 3000 | Timeout per upstream forward |
| `cacheMaxEntries` | 10000 | Max cache entries (LRU) |
| `ttlMin` / `ttlMax` | 10 / 3600 | Cache TTL clamp range (seconds) |
| `logCapacity` | 1000 | Query log entries kept in memory |

Environment variables: `KAVEN_DNS_PORT` / `KAVEN_WEB_PORT` temporarily override the ports (useful for debugging).

## REST API Summary

Everything except login requires `Authorization: Bearer <token>`.
Error messages are localized when an `Accept-Language: zh` (or `en`) header is sent.

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Sign in `{password}` → `{token}` |
| GET/POST | `/api/rules` | List / create rules |
| PUT/DELETE | `/api/rules/:id` | Update / delete |
| GET | `/api/logs?domain=&source=&limit=` | Query log |
| GET | `/api/stats` | Stats and cache info |
| POST | `/api/cache/flush` | Flush the cache |
| GET/PUT | `/api/config` | Read / update config (incl. password change) |
| POST | `/api/resolve` | Resolve test `{domain, type}` |

## Project Layout

```
src/
├── index.js          # Entry point: wires everything together and starts DNS + Web
├── config.js         # Config load/persist (password generated on first run)
├── i18n.js           # zh/en message dictionaries for user-facing API errors
├── dns/
│   ├── server.js     # UDP + TCP DNS server (dns2)
│   ├── resolver.js   # Resolution pipeline: rule → fixed / cache / forward
│   ├── forwarder.js  # Parallel upstream racing
│   ├── cache.js      # LRU + TTL cache
│   ├── matching.js   # Domain matching (wildcards, suffix priority)
│   └── util.js       # Type maps and summary helpers
├── store/
│   ├── rules.js      # Rule CRUD + JSON persistence (hot reload)
│   └── logs.js       # Query log ring buffer + stats
└── web/
    ├── server.js     # Express REST API
    ├── auth.js       # Password login + token sessions
    └── public/index.html  # Vue3 single-file frontend (CDN, no build step, zh/en)
```

## Notes

- The frontend loads Vue 3 from the jsdelivr CDN; for offline use, replace the script in `index.html` with a local copy
- Session tokens are kept in memory; the process restart requires signing in again

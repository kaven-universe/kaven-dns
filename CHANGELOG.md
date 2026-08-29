# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Settings now includes a confirmed Query History reset that clears retained queries and aggregate query counters, persists the reset immediately, and synchronizes all connected consoles

### Changed

- Queries and Logs terminology now matches across tabs, hash routes, REST endpoints, JSON/SSE payloads, frontend state, translations, store modules, tests, and documentation: Queries uses `/api/queries` and Logs uses `/api/logs`
- `logRetentionDays` is now `queryRetentionDays`, and `data/querylog.json` is now `data/queries.json`; existing configuration and history are migrated automatically
- Settings now uses a balanced responsive grid with grouped endpoint, query policy, security, and maintenance controls

### Testing

- Added reset persistence/rollback, authentication, SSE synchronization, and legacy config/history migration coverage

## [1.2.1] - 2026-08-27

### Fixed

- TCP-originated DNS queries no longer silently lose their client IP in the query log. A `net.Socket`'s own `.address()` method (unrelated to the remote peer, always truthy) was shadowing the intended `remoteAddress` string, and `JSON.stringify` then silently dropped the resulting function value from the REST API, SSE stream, and persisted `data/querylog.json` (UDP queries were unaffected)

### Changed

- The "Query Log" and "System Logs" nav/tab labels are now "Queries" and "Logs", matching the single-word style of Domains/Clients/Rules/Settings; their URL routes and internal identifiers were renamed to match (`#/queries`, `#/logs`)

### Added

- An Export button on the Queries tab, next to the domain filter, downloads the current filter's matches (time range, column filters) as a dated JSON file

### Testing

- Extended the UDP/TCP end-to-end test to assert the logged client IP is a real string that survives a JSON round-trip (75 tests total)

## [1.2.0] - 2026-08-27

### Added

- Query Log tab: a time-range selector (last 15 minutes / 1 / 6 / 24 hours / 7 days, or a custom from/to range) alongside the existing domain search
- Column-header filter popovers (funnel icon → pick a value → Reset/Confirm) on Domain, Client, Type, Source, Rule/Upstream and Status in the Query Log tab, and on Failures in the Domains/Clients tabs
- The query log and its stats now survive a normal exit/restart: saved to `data/querylog.json` on a clean shutdown (`SIGINT`/`SIGTERM`) and restored on the next start. There is no per-query disk write during normal operation, and an unclean termination (crash, `kill -9`) still loses whatever wasn't saved at the last clean shutdown

### Changed

- Dashboard reworked: the overview stays a compact preview (top-6 domains/clients, latest 20 log rows), with three dedicated full-page tabs (Query Log, Domains, Clients) as sortable, searchable tables; the 60-minute trend chart moved to the Query Log tab
- The Domains/Clients tab headings are now just "Domains"/"Clients" (the Dashboard's compact preview cards still say "Top Domains"/"Active Clients")
- Query log size is now controlled by a single `logRetentionDays` setting (default 7 days, 0 disables time-based trimming) instead of a raw entry-count setting. There is no fixed entry-count ceiling: entries are additionally trimmed (oldest first) only when the system is low on free memory or this process's own memory usage grows large, so the log can hold as much history as available memory allows
- `getAnalytics()`'s top-domains/active-clients rankings are no longer capped at 6 by default (raised to 500, with accurate total counts)

### Removed

- The `cacheMaxEntries` and `logCapacity` settings are no longer user-configurable; the DNS answer cache uses a fixed internal default, and the query log's size is no longer bounded by a fixed entry count at all (existing config files with these fields keep loading normally, the fields are just ignored)

### Testing

- Added coverage for the new log filters (domain, rule/upstream, since/until time range), retention trimming, memory-based trimming, query log persistence round-tripping, and updated config `sanitize()` expectations for the simplified settings (75 tests total)

## [1.1.0] - 2026-08-26

### Added

- Dashboard query analytics: 60-minute query/latency/failure trends, top domains, and active clients
- Authenticated SSE stream (`/api/events`) for live dashboard updates — batched query/system-log events, coalesced stats snapshots, backpressure recovery, and automatic reconnect, with periodic REST fallback

### Security

- Password hashing now uses salted `scrypt` instead of a bare unsalted SHA-256 digest. Existing installs keep working: a saved hash from an older version still verifies through a backward-compatible legacy check, and the hash upgrades automatically the next time the password is set or changed
- Login lockout now escalates for repeated failures from the same IP (10s, 20s, 40s, ... capped at 10 minutes) instead of a flat 10 seconds
- Password verification (both the current and legacy hash formats) now uses a timing-safe comparison

### Fixed

- `heldByOwnDnsListener` now recognizes the IPv6 wildcard (`::`) as covering every address, matching the existing `0.0.0.0` handling
- The DNS answer cache no longer evicts a valid entry when a concurrent duplicate query overwrites an existing key
- Removed stale comments and a dead `setFileWriter` hook left over from the earlier removal of desktop/tray packaging
- README's description of when the Docker publish workflow runs now matches the actual `workflow_dispatch`-only trigger

### Testing

- Added test coverage for the core DNS pipeline (domain matching, cache, resolver, upstream forwarding, UDP/TCP server), rule validation and persistence, and config sanitization — previously untested

## [1.0.0] - 2026-08-26

- Initial release: DNS server (UDP + TCP, fixed/forward rules, answer caching) with a bilingual Web console, first-run setup wizard, Docker image, and system logging

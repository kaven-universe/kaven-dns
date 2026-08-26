# Changelog

All notable changes to this project are documented in this file.

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

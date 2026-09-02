# Kaven DNS Agent Guidelines

This file applies to the entire repository. Kaven DNS is a Go application;
`README.md` is the canonical feature, API, configuration, build, and deployment
reference. Update it whenever user-visible behavior changes.

## Project model

- Go 1.24 or newer is the only application runtime. Keep `CGO_ENABLED=0`
  compatibility so release binaries remain self-contained.
- `cmd/kaven-dns/main.go` is the composition root. Domain code belongs under
  the owning `internal/` package.
- `internal/webassets/public/index.html` is the complete Vue 3 client. Vue is
  vendored locally so the console works offline; do not introduce a frontend
  build pipeline or CDN dependency for isolated changes.
- Runtime state is compatible JSON under `data/`, or `KAVEN_DATA_DIR` when set.
  Never edit or commit runtime data, logs, or `dist/` artifacts.
- `VERSION` is the release version source. Build scripts inject it and the Git
  commit into `internal/buildinfo` with linker flags.

## Architecture and invariants

- `internal/config` owns defaults, sanitization, paths, and compatible JSON
  configuration. Use `internal/persist` for atomic writes.
- `internal/dnsserver` owns UDP/TCP request handling. `internal/resolver` owns
  the rule -> fixed/cache/forward pipeline, `internal/rules` owns matching and
  persistence, and `internal/cache` owns TTL/LRU behavior.
- DNS must listen on UDP and TCP. Listener moves must roll back on failure and
  must not leave only one transport active.
- Plain domain patterns match the domain and subdomains; `*.example.com`
  matches subdomains only. More labels win, then plain over wildcard, then the
  newer rule. CNAME rules participate in A/AAAA resolution.
- Forwarded cache entries are scoped by domain, type, and upstream set. Cache
  only successful answers, clamp minimum TTL, and preserve authority and
  additional records.
- `internal/web` is the HTTP/SSE boundary. Setup status/check/setup and login
  are the only public API flows. Never expose passwords, hashes, or tokens.
- All API input requires server-side validation and bounded list/body limits.
  User-facing errors and Web text require matching Chinese and English wording.
- Preserve persisted configuration, rules, sessions, and query history. Add
  normalization or migration when changing stored shapes.
- Query/log observers must not block or fail the DNS request path. Keep SSE
  streams authenticated, bounded, batched, and free of URL bearer tokens.

## Style and validation

- Run `gofmt` on Go changes. Prefer small named helpers, explicit lifecycle
  handling, dependency injection, and standard-library functionality.
- Add focused tests beside the owning package. Avoid privileged ports and live
  upstream DNS when deterministic fakes can cover behavior.
- After changes run `go test ./...` and `go vet ./...`. For network lifecycle
  work, retain the compiled-process smoke coverage in `cmd/kaven-dns`.
- For Web UI changes, exercise setup/login and the affected flow in Chinese and
  English at desktop and narrow widths when a browser is available.
- Run `./scripts/build-all.ps1` for release/build changes. Build the Docker
  image when changing its runtime, paths, permissions, ports, or data behavior.
- Respect unrelated working-tree changes and avoid collateral reformatting.

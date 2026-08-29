# Kaven DNS Agent Guidelines

This file applies to the entire repository. Keep changes small and consistent with the existing plain Node.js architecture. Use [README.md](README.md) as the canonical feature, API, configuration, and deployment reference; update it when user-visible behavior changes.

## Project Model

- The application targets Node.js 22 or newer and uses CommonJS (`require` / `module.exports`) with no transpilation or application build step.
- Runtime dependencies are intentionally small: Express provides the Web API and `dns2` provides DNS packets and transports. Prefer Node.js built-ins and existing helpers before adding a dependency.
- `src/web/public/index.html` is the whole Vue 3 client: HTML, CSS, translations, and application logic live together. Vue is vendored locally under `src/web/public/vendor/` so the console works offline.
- Runtime state is JSON under `data/`, or under `KAVEN_DATA_DIR` when set. `data/`, `node_modules/`, and logs are not source files and must not be edited or committed.
- Supported distribution is the plain Node.js application and Docker image. Do not reintroduce Windows executable, SEA, desktop, or tray packaging unless explicitly requested.

## Architecture

- `src/index.js` is the composition root. It wires stores, cache, resolver, DNS transports, authentication, Web server, listener restarts, and shutdown handling. Keep domain logic in the owning module rather than growing the entry point.
- `src/config.js` owns defaults, sanitization, data paths, password hashing, and atomic JSON writes. Reuse `atomicWriteJson` for persistent JSON state.
- `src/dns/server.js` owns UDP/TCP request handling and query recording. `resolver.js` owns the rule -> fixed/cache/forward pipeline, `matching.js` owns domain precedence, `forwarder.js` owns upstream I/O, and `cache.js` owns TTL/LRU behavior.
- `src/store/` owns mutable in-memory state and persistence. Rules are read live by the resolver, so successful CRUD changes take effect without restart.
- `src/web/server.js` is the HTTP boundary. Keep request validation and status-code decisions here, and inject collaborators through `createWebServer` rather than importing application singletons.
- `src/store/queries.js` owns query history and aggregate query statistics; `src/store/logs.js` owns console logs and operation records. Both expose lightweight subscriptions; observers must never block or fail the DNS request path.
- `src/web/events.js` owns authenticated SSE batching, heartbeats, and slow-client recovery. Keep its `queries` and `logs` event/snapshot fields aligned with the matching tabs and REST resources.
- `src/web/auth.js` owns bearer sessions and login throttling. `src/i18n.js` owns localized server messages. `src/system.js` owns host/process metrics.

## Behavioral Invariants

- DNS must continue to listen on both UDP and TCP. Listener changes must avoid leaving one transport half-open and must keep the Web console available when DNS binding fails.
- Plain domain patterns match the domain and its subdomains; `*.example.com` matches subdomains only. More labels win, then plain patterns beat wildcards, then the later/newer rule wins. CNAME rules also participate in A/AAAA resolution.
- Forwarded cache entries are scoped by domain, query type, and upstream set. Cache only successful answers, clamp their minimum TTL to the configured range, and preserve authority/additional records as the current resolver does.
- Configuration is a shared live object. Validate input, call `sanitize`, persist atomically, and apply listener/cache/query changes at runtime where the existing API promises immediate effect.
- Setup status/check/setup and login are the only public API flows. Routes registered after `app.use('/api', auth.middleware)` must remain authenticated. Never return or log password hashes, passwords, bearer tokens, or persisted session tokens.
- Live console updates use an authenticated fetch/SSE stream plus REST snapshots and fallback. Batch and bound high-frequency events, recover slow clients with a fresh snapshot, and never put bearer tokens in URLs or let stream writes run inline with DNS resolution.
- All untrusted API input needs server-side validation even when the client validates it. Keep the existing JSON body limit and bounded list/query limits unless a requirement explicitly changes them.
- User-facing API errors must use `t(req.lang, ...)`, with matching Chinese and English entries in `src/i18n.js`. Frontend-visible text likewise needs both locales.
- Preserve compatibility with persisted configuration, rules, and sessions. When changing a stored shape, provide normalization or migration on load instead of assuming fresh data.

## Code Style

- Follow the existing style: `'use strict';`, two-space indentation, single quotes, semicolons, trailing commas in multiline literals, and `const` by default.
- Use CommonJS throughout. Do not introduce TypeScript, ESM, a bundler, or a frontend package pipeline for an isolated change.
- Prefer async/await and small named helpers. Keep protocol, persistence, and lifecycle edge cases explicit; add comments only when the reason is not evident from the code.
- Preserve dependency injection in constructors/factories so DNS, stores, and Web behavior remain testable without starting the whole process.
- Do not edit `src/web/public/vendor/vue.global.prod.js` except for an intentional vendored Vue upgrade. Keep all browser assets local and usable without a CDN.

## Development And Validation

```bash
pnpm install
pnpm test
pnpm start
```

- `pnpm test` runs the built-in Node test runner over `test/*.test.js`. Tests use `node:test` and `node:assert/strict`; place focused regression tests beside that suite and avoid privileged ports or live upstream DNS when a unit test can cover the behavior.
- There is currently no lint, format, or application build script. Do not claim those checks ran, and do not add a toolchain solely to validate a small change.
- Always run `pnpm test` after code changes. For startup or network changes, also run the app with a temporary `KAVEN_DATA_DIR`, an unprivileged DNS port such as `5330`, and a free Web port so validation cannot overwrite real user data or require administrator rights.
- For Web UI changes, manually exercise first-run/login plus the affected workflow in both Chinese and English, and check a narrow mobile viewport as well as desktop. Preserve the no-build, offline client.
- For DNS changes, cover fixed, forward, cache, failure, and UDP/TCP behavior as applicable. Use deterministic fakes for upstream behavior where practical.
- Build the Docker image when changing the Dockerfile, runtime dependencies, startup paths, permissions, exposed ports, or data-directory behavior.

## Change Checklist

- Keep `package.json` and `pnpm-lock.yaml` synchronized when dependencies change.
- Update README API/configuration tables when routes, fields, defaults, environment variables, matching rules, or deployment behavior change.
- Add both backend and frontend localization entries when introducing user-visible text.
- Check failure and rollback paths for listener moves and persistent writes, especially Windows file-lock behavior.
- Respect unrelated work already present in the working tree; do not rewrite large files or reformat untouched sections as collateral changes.

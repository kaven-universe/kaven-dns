# kaven-dns

A self-contained Go DNS server with a Web console for monitoring and management.

![Dashboard screenshot](assets/screenshot-dashboard.png)

## Features

- **Standard DNS service**: listens on both UDP and TCP; supports A / AAAA / CNAME and passes common record types through
- **EDNS Client Subnet awareness**: valid ECS data from a local loopback DNS forwarder is used to preserve the original client in Queries and client analytics; remote clients cannot override their logged address
- **Dynamic resolution rules** (add / edit / delete take effect immediately, no restart):
  - `Fixed answer`: return a specified IP (or several) or a CNAME target directly
  - `Forward`: forward the query to a third-party DNS (a per-rule upstream can be set, e.g. `8.8.8.8`); queries that match no rule go to the default upstream group
  - **Domain groups**: one rule holds multiple domains (one per line in the editor, up to 500); they share the same configuration, and editing the rule applies to the whole group at once
- **Answer caching**: forwarded answers are cached by their minimum TTL (bounds configurable), with LRU eviction, hit-rate stats and one-click flush
- **Upstream racing**: default upstreams are queried in parallel and the fastest successful response wins; TC-flagged answers are automatically retried over TCP
- **Bilingual Web console** (Chinese / English, simple password authentication):
  - Language switcher on the login page and in the header; the preference is remembered and auto-detected from the browser on first visit
  - Dashboard: at-a-glance overview — query volume, rule/cache/forward hits, failures, average latency, cache hit rate, a top-6 preview of top domains / active clients, and the 20 most recent queries; server cards for uptime, process/system CPU usage, memory (process RSS + system), and host info (hostname, OS, arch, runtime version)
  - Queries tab: a 60-minute query/latency/failure trend chart, plus the complete live query history as a sortable table (click any column header) with a domain search box, a time-range selector (last 15m/1h/6h/24h/7d, or a custom from/to range), and column-header filter popovers (funnel icon → pick a value → Reset/Confirm) on Domain, Client, Type, Source, Rule/Upstream and Status (OK or failed)
  - Domains tab / Clients tab: the complete top-domains and active-clients rankings as sortable, searchable tables with the same column-header filter popover on Failures (all / has failures / no failures), each on its own page (not capped to the Dashboard's top-6 preview)
  - Authenticated SSE streams batched live updates to visible consoles, with automatic reconnect, periodic REST fallback, and a persistent bilingual warning while the server is unreachable; analytics use the retained query window, which survives a normal restart (saved on clean shutdown, restored on the next start) and is only lost on a crash
  - Rules management: table + modal editor, enable toggle, remarks, import/export as JSON (merge by domains+type, or replace all)
  - Settings: upstream list, cache and query-retention parameters, ports, password change, cache flush, query-history reset, stable-version update check, resolve test
  - Logs tab: operation/config-change records plus console output (what a hidden terminal would have shown), with a dark console viewer
  - Shared bilingual footer across setup, login and the console, showing the running version with links to the GitHub source and Docker Hub image
  - API error messages are localized too, negotiated from the `Accept-Language` header
- **No database**: rules, config and query history persist to `data/*.json` (atomic writes, restored on the next start after a normal exit/restart)

## Quick Start

To run from source, install Go 1.24 or newer:

```bash
go run ./cmd/kaven-dns
```

Prebuilt releases do not require Go or any other application runtime.

On first run the console opens a **setup screen** where you set the admin password, the DNS/Web ports and the DNS bind address; then sign in with the password you chose.

> Listening on port 53 requires administrator privileges:
> - Windows: run the terminal as administrator; or set `KAVEN_DNS_PORT=5330` and start on an unprivileged port
> - After allowing UDP/TCP 53 through the firewall, LAN devices can point their DNS at this machine

## Usage

Once setup is complete, the server is already answering queries with the default upstream group — the steps below cover pointing real devices at it and shaping how it resolves:

- **Sign in** to the Web console at `http://<host>:<webPort>` (default port `8080`) with the admin password you set during setup.
- **Add rules** on the Rules page for any domain you want to control: `Fixed answer` for internal hostnames or blocking, `Forward` to send specific domains to a different upstream. Rules take effect immediately, no restart needed — see [Rule Matching](#rule-matching) for how patterns and priority work.
- **Everything unmatched** falls through to the default upstream group (see [Configuration](#configuration)) with caching and upstream racing applied automatically.
- **Verify and monitor**: use the Settings page's resolve test, an external tool such as `nslookup` (see [Verification](#verification) below), or watch live traffic on the Dashboard, Queries, Domains and Clients tabs.

### Configure your system to use it

Point a device's DNS at this machine's LAN IP (not `127.0.0.1`, which only resolves for processes on the same machine) on port `53` — most OS/router DNS settings don't support a custom port, so if you're running on a debug port such as `5330`, only tools that let you specify a port (e.g. `nslookup`, the Settings page's resolve test) can reach it.

- **Windows**: Settings → Network & Internet → your connection → "Edit" next to DNS server assignment → Manual → On → set Preferred DNS to the server's LAN IP → Save.
- **macOS**: System Settings → Network → your connection → Details → DNS → add the server's LAN IP under DNS Servers (place it above any other entries).
- **Linux (NetworkManager)**: `nmcli con mod <connection-name> ipv4.dns <ip>` then `nmcli con up <connection-name>`; other setups can edit `/etc/systemd/resolved.conf` or `/etc/resolv.conf` directly.
- **Router** (recommended — applies to every device on the network): in the router's LAN/DHCP settings, set the DNS server to this machine's LAN IP. Give that machine a static/reserved IP first so devices don't lose DNS when its lease changes.
- **Android**: Wi-Fi settings → long-press the connected network → Modify network → Advanced options → IP settings: Static → set DNS 1 to the server's LAN IP.
- **iOS**: Settings → Wi-Fi → ⓘ next to the connected network → Configure DNS → Manual → add the server's LAN IP.

If a local `dnsmasq` instance relays requests to Kaven DNS over loopback, enable full-length ECS in `dnsmasq` so the Queries and Clients views show the originating LAN device instead of `127.0.0.1`:

```ini
add-subnet=32,128
```

Restart `dnsmasq` after changing its configuration. Kaven DNS accepts ECS for client attribution only from loopback peers; shorter valid prefixes are displayed in CIDR form, and malformed or remotely supplied values are ignored.

## Verification

```bash
# Forwarded resolution (the second query hits the cache; the source column
# in the dashboard log changes accordingly)
nslookup baidu.com 127.0.0.1

# After adding a fixed rule test.local -> 1.2.3.4 on the Rules page:
nslookup test.local 127.0.0.1
```

## Deployment

### Prebuilt binaries

Release artifacts cover Linux, Windows, and macOS on amd64 and arm64. The
OpenWrt arm64 bundle is published alongside them. Build every target locally
from PowerShell with:

```powershell
./scripts/build-all.ps1
```

Outputs and `SHA256SUMS` are written to `dist/releases/`. On Linux or macOS,
make a downloaded raw binary executable with `chmod +x <filename>` before
starting it. The program reads and writes `data/` beside the working directory
unless `KAVEN_DATA_DIR` is set.

### OpenWrt routers

The static `procd` bundle supports arm64 and ARMv7 low-memory OpenWrt devices.
Build it on Windows with Go and `tar` available:

```powershell
./scripts/build-router.ps1
# For ARMv7 routers:
./scripts/build-router.ps1 -Architecture armv7
```

The build embeds the version from `VERSION` and the current Git commit,
which are available from the setup-status API. Pass `-Version <version>` to
override the display version for a release build.

Copy the matching `dist/kaven-dns_<version>_openwrt_<architecture>.tar.gz` to the router, extract it,
and follow the included `README.txt`. The installer preserves configuration on
upgrades and uses these conservative defaults:

- Go memory limit: 64 MiB
- Go CPU parallelism: 2
- Query history: 2,000 entries
- DNS cache: 1,000 entries
- Kaven DNS: `127.0.0.1:5330`; Web console: `0.0.0.0:8080`

Port 5330 avoids conflicting with OpenWrt's `dnsmasq` on port 53. The included
instructions first verify Kaven DNS and then configure `dnsmasq` to forward to
it. Do not change `dnsmasq` until the Kaven DNS service is confirmed running,
or the router can temporarily lose DNS resolution.

This bundle requires an arm64 or ARMv7 OpenWrt installation and root shell
access. It cannot be installed through the standard Xiaomi stock-firmware Web
interface.

#### Example: router at 192.168.31.1

For an ARMv7 router, build and upload the package from PowerShell. The `-O`
option is required for Dropbear-based routers that do not provide an SFTP
server:

```powershell
./scripts/build-router.ps1 -Architecture armv7
scp -O -oHostKeyAlgorithms=+ssh-rsa -oPubkeyAcceptedAlgorithms=+ssh-rsa `
  ./dist/kaven-dns_<version>_openwrt_armv7.tar.gz `
  root@192.168.31.1:/tmp/kaven-dns.tar.gz
ssh -oHostKeyAlgorithms=+ssh-rsa -oPubkeyAcceptedAlgorithms=+ssh-rsa `
  root@192.168.31.1
```

After verifying the router's SSH host fingerprint, extract and install from
the root shell:

```sh
rm -rf /tmp/kaven-dns-install
mkdir -p /tmp/kaven-dns-install
tar -xzf /tmp/kaven-dns.tar.gz -C /tmp/kaven-dns-install
cd /tmp/kaven-dns-install/kaven-dns_<version>_openwrt_armv7
sh install.sh
```

On the Xiaomi stock firmware tested at `192.168.31.1`, `/` is read-only
squashfs and the standard installer fails when writing `/usr/bin`. The router
reports `armv7l`, and its existing nginx also occupies Web port `8080`. That
firmware is not a supported standard OpenWrt target. For a temporary manual
test, place the binary and data under writable `/data`, then start it with a
different Web port:

```sh
cp kaven-dns /data/kaven-dns
chmod 0755 /data/kaven-dns
mkdir -p /data/kaven-dns-data
cp config.router.json /data/kaven-dns-data/config.json
cp kaven-dns-stock-start.sh /data/kaven-dns-start.sh
chmod 0755 /data/kaven-dns-start.sh
/data/kaven-dns-start.sh
sed -i '/@reboot \/data\/kaven-dns-start\.sh/d' /etc/crontabs/root
grep -qF '* * * * * /data/kaven-dns-start.sh' /etc/crontabs/root || \
  printf '\n* * * * * /data/kaven-dns-start.sh >/dev/null 2>&1\n' >> /etc/crontabs/root
/etc/init.d/cron restart
```

Verify with `ps`, `netstat -ln`, and `wget -qO- http://127.0.0.1:18080/`.
On this router, configure Kaven DNS on `127.0.0.1:5330` to avoid confusion with
standard mDNS port `5353`. Configure the router's
dnsmasq to forward DNS queries to it:

```sh
uci -q get dhcp.@dnsmasq[0].noresolv
uci -q get dhcp.@dnsmasq[0].server
uci set dhcp.@dnsmasq[0].noresolv='1'
uci -q del_list dhcp.@dnsmasq[0].server='127.0.0.1#5330'
uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#5330'
uci set dhcp.@dnsmasq[0].add_subnet='32,128'
uci commit dhcp
/etc/init.d/dnsmasq restart
nslookup openwrt.org 192.168.31.1
```

Do not restart dnsmasq until the Kaven DNS listener is verified. If forwarding
fails, restore the saved `noresolv` and `server` values, then commit and
restart dnsmasq.

The launcher and its once-per-minute cron entry start Kaven DNS shortly after a
router reboot; this is used instead of `@reboot` because the router's BusyBox
cron does not execute `@reboot` jobs. It also recreates the firmware-specific
dnsmasq ECS include before restarting dnsmasq. The binary, launcher, and data
all survive on `/data`.

### Docker

Prebuilt multi-architecture images (`linux/amd64` and `linux/arm64`) are published to Docker Hub and the GitHub Container Registry:

- `kavenzero/kaven-dns`
- `ghcr.io/kaven-universe/kaven-dns`

Run the latest image with DNS on port 53 and the Web console on port 8080:

```bash
docker run -d \
  --name kaven-dns \
  --restart unless-stopped \
  --cap-add NET_BIND_SERVICE \
  -p 53:53/tcp \
  -p 53:53/udp \
  -p 8080:8080 \
  -v kaven-dns-data:/app/data \
  kavenzero/kaven-dns:latest
```

Open `http://localhost:8080` to complete the first-run setup. The named volume preserves configuration, rules, sessions, and Queries history across container upgrades. The Go process handles `SIGTERM` directly and saves query history before exiting; `docker kill` skips graceful shutdown and can lose queries received since the previous clean stop.

The container runs as a non-root user. If you do not want to grant permission to bind port 53, run DNS on an unprivileged port instead:

```bash
docker run -d \
  --name kaven-dns \
  --restart unless-stopped \
  -e KAVEN_DNS_PORT=5330 \
  -p 5330:5330/tcp \
  -p 5330:5330/udp \
  -p 8080:8080 \
  -v kaven-dns-data:/app/data \
  kavenzero/kaven-dns:latest
```

Select DNS port `5330` in the first-run setup screen as well. The environment variable applies the startup override, while the setup selection is saved in the persistent configuration.

To build the image locally:

```bash
docker build -t kaven-dns .
```

The Docker workflow runs for version tags and manual dispatch. The release
workflow builds all binary targets on version tags and publishes them with
individual and combined SHA-256 checksums; manual runs retain the same files as
GitHub Actions artifacts without creating a release.

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
| `dnsPort` | 53 | DNS listen port (UDP+TCP); changes apply immediately after saving |
| `bindAddress` | 0.0.0.0 | DNS listen address; e.g. `127.0.0.1` for local only (coexists with the Windows ICS service that holds `0.0.0.0:53`) |
| `webPort` | 8080 | Web console port; changes apply immediately after saving |
| `webBindAddress` | 0.0.0.0 | Web console bind address; e.g. `127.0.0.1` for local-only, or a LAN IP to serve the console on that interface |
| `upstreams` | `223.5.5.5, 119.29.29.29` | Default upstream group (`ip` or `ip:port`) |
| `forwardTimeoutMs` | 3000 | Timeout per upstream forward |
| `ttlMin` / `ttlMax` | 10 / 3600 | Cache TTL clamp range (seconds) |
| `queryRetentionDays` | 1 | Days of query history to retain; 0 disables time-based trimming |
| `queryHistoryMaxEntries` | 10000 | Maximum retained query entries; lower this on memory-constrained devices |
| `cacheMaxEntries` | 2000 | Maximum DNS cache entries |
| `sessionTtlHours` | 24 | Web console session validity in hours; renewed on activity (idle timeout) and persisted across restarts |

Environment variables: `KAVEN_DNS_PORT` / `KAVEN_WEB_PORT` temporarily override the ports, and `KAVEN_BIND_ADDRESS` / `KAVEN_WEB_BIND_ADDRESS` temporarily override their listener addresses (useful for loopback-only debugging); `KAVEN_DATA_DIR` relocates the data directory (defaults to `<working-directory>/data`). Standard Go runtime settings such as `GOMEMLIMIT` and `GOMAXPROCS` can constrain memory and CPU parallelism.

## REST API Summary

Everything except the setup endpoints and login requires `Authorization: Bearer <token>`.
Error messages are localized when an `Accept-Language: zh` (or `en`) header is sent.

| Method | Path | Description |
|---|---|---|
| GET | `/api/setup/status` | Check whether first-run setup is required; returns the application version and local IPv4 addresses |
| POST | `/api/setup/check` | Check whether the selected DNS port and address are available |
| POST | `/api/setup` | Complete first-run setup with password, ports and bind addresses |
| POST | `/api/auth/login` | Sign in `{password}` → `{token}` |
| GET/POST | `/api/rules` | List / create rules |
| POST | `/api/rules/import` | Import rules `{rules, mode: merge\|replace}` |
| PUT/DELETE | `/api/rules/:id` | Update / delete |
| GET | `/api/queries?domain=&source=&status=&type=&client=&rule=&since=&until=&limit=` | Query history (`status`: `ok`\|`fail`; `since`/`until` are epoch ms) |
| POST | `/api/queries/reset` | Clear query history and reset aggregate query counters |
| GET | `/api/stats` | Stats, cache info, DNS listener status |
| GET | `/api/logs?limit=` | Console logs + operation records |
| GET | `/api/events` | Authenticated SSE stream for batched Queries, stats and Logs updates |
| POST | `/api/shutdown` | Stop the program |
| POST | `/api/cache/flush` | Flush the cache |
| GET | `/api/update` | Compare the running version with the latest stable GitHub tag |
| GET/PUT | `/api/config` | Read / update config (incl. password change) |
| POST | `/api/resolve` | Resolve test `{domain, type}` |

## Project Layout

```
cmd/kaven-dns/          # Composition root and compiled-process smoke test
internal/
├── auth/               # Password verification, throttling, bearer sessions
├── buildinfo/          # Build-time version and commit metadata
├── cache/               # TTL-aware bounded LRU cache
├── config/              # Compatible configuration and sanitization
├── dnsserver/           # UDP + TCP DNS listeners and query recording
├── history/             # Retained queries, stats, and analytics
├── logstore/            # Bounded console and operation logs
├── persist/             # Atomic JSON persistence
├── resolver/            # Rule → fixed/cache/forward resolution pipeline
├── rules/               # Matching, validation, CRUD, and persistence
├── systeminfo/          # Host/process CPU and memory metrics
├── update/              # Stable GitHub tag lookup
├── web/                 # HTTP API, SSE, listener lifecycle
└── webassets/           # Embedded offline Vue console and vendored Vue
deploy/openwrt/           # procd service and router installer
scripts/                  # Cross-platform and OpenWrt build scripts
```

## Notes

- The frontend serves embedded Vue 3 from `internal/webassets/public/vendor/`, so the console works in offline / intranet environments
- Login sessions are stored in `data/sessions.json` (idle timeout, renewed on activity) so server restarts keep you signed in
- Query history and its stats are saved to `data/queries.json` on a clean shutdown (SIGINT/SIGTERM) and restored on the next start, so a normal exit/restart doesn't lose history; there is no ongoing per-query disk write, and an unclean termination (crash, `kill -9`) still loses whatever wasn't saved at the last clean shutdown
- Existing `logRetentionDays` settings and `data/querylog.json` snapshots are migrated automatically to `queryRetentionDays` and `data/queries.json`

'use strict';

const net = require('net');

const { DATA_DIR, RULES_FILE, SESSIONS_FILE, resolveQueriesFile, loadConfig, verifyPassword } = require('./config');
const { RulesStore } = require('./store/rules');
const { QueryStore } = require('./store/queries');
const { createLogStore } = require('./store/logs');
const { DnsCache } = require('./dns/cache');
const { Resolver } = require('./dns/resolver');
const { createDnsServers } = require('./dns/server');
const { createAuth } = require('./web/auth');
const { createWebServer } = require('./web/server');

async function main() {
  // Capture console output into an in-memory ring buffer for the Logs tab.
  const logs = createLogStore(600);
  logs.captureConsole();

  const { config } = loadConfig();
  const queriesFile = resolveQueriesFile();

  const rulesStore = new RulesStore(RULES_FILE);
  const queries = new QueryStore(undefined, config.queryRetentionDays, undefined, queriesFile);
  const cache = new DnsCache(); // fixed size (DnsCache's own default); not user-configurable
  const resolver = new Resolver({ rulesStore, cache, getConfig: () => config });
  const dns = createDnsServers({ resolver, queries, port: config.dnsPort, address: config.bindAddress });
  const auth = createAuth({
    verifyPassword: password => verifyPassword(password, config.passwordHash),
    getSessionTtlMs: () => config.sessionTtlHours * 3600 * 1000,
    sessionsFile: SESSIONS_FILE,
  });
  const consoleUrl = (port, address) => {
    const host = !address || address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address;
    return `http://${host}:${port}`;
  };
  const web = createWebServer({
    config,
    rulesStore,
    queries,
    logs,
    cache,
    resolver,
    auth,
    getDnsStatus: () => dns.status(),
    restartDns: async (port, address) => {
      const attempt = async (addr) => {
        await dns.restart(port, addr);
        const s = dns.status();
        logs.record('dns', `listening on ${s.address}:${s.port} (UDP + TCP)`);
        return s;
      };
      try {
        const s = await attempt(address);
        return { applied: true, error: '', address: s.address };
      } catch (e) {
        logs.record('dns', `failed to listen on ${address || '0.0.0.0'}:${port}: ${e.message}`, 'error');
        if (e.code === 'EADDRINUSE')
          console.error('Hint: another process is using this port; find it with `netstat -ano | findstr :' + port + '`');
        console.error('The Web console remains available; DNS resolution is NOT served until the port is free.');
        return { applied: false, error: (e && e.code) || e.message, address: address || '0.0.0.0' };
      }
    },
    // Populated after listen() below; lets PUT /api/config move the console
    // to a new port without restarting the process.
    runtime: {},
  });

  const webServer = await web.listen(config.webPort, config.webBindAddress).catch(e => {
    console.error(`[web] failed to listen on port ${config.webPort}: ${e.message}`);
    console.error('Hint: set the KAVEN_WEB_PORT environment variable to use another port.');
    process.exit(1);
  });
  const webPort = config.webPort;

  const runtime = web.runtime;
  runtime.currentPort = webPort;
  runtime.webAddress = config.webBindAddress;
  runtime.server = webServer;
  // Check a port is free without disturbing the running console, so the
  // settings API can reject a bad port before committing it.
  runtime.probeWeb = port => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
  runtime.moveWeb = async (newPort, newAddress) => {
    const oldPort = runtime.currentPort;
    web.disconnectEvents();
    await new Promise(resolve => runtime.server.close(resolve));
    try {
      runtime.server = await web.listen(newPort, newAddress);
      runtime.currentPort = newPort;
      logs.record('web', `console moved: ${consoleUrl(oldPort, runtime.webAddress)} -> ${consoleUrl(runtime.currentPort, newAddress)}`);
      runtime.webAddress = newAddress;
      return { ok: true, port: runtime.currentPort };
    } catch (e) {
      // Extremely unlikely (probe passed); restore the old port rather than
      // leaving the console down entirely.
      runtime.server = await web.listen(oldPort, newAddress || runtime.webAddress);
      runtime.currentPort = oldPort;
      throw e;
    }
  };

  logs.record('startup', `web console at ${consoleUrl(webPort, config.webBindAddress)} (data dir: ${DATA_DIR})`);

  dns.start().then(() => {
    const s = dns.status();
    logs.record('dns', `listening on ${s.address}:${s.port} (UDP + TCP)`);
  }).catch(e => {
    logs.record('dns', `failed to listen on ${config.bindAddress}:${config.dnsPort}: ${e.message}`, 'error');
    if (e.code === 'EADDRINUSE') {
      console.error('Hint: another process is using this port; find it with `netstat -ano | findstr :%d`'.replace('%d', config.dnsPort));
    } else {
      console.error('Hint: try a different port via the Settings page or the KAVEN_DNS_PORT environment variable.');
    }
    console.error('The Web console remains available; DNS resolution is NOT served until the port is free.');
  });

  // Periodically drop expired cache entries to bound memory usage
  const sweepTimer = setInterval(() => cache.sweep(), 60 * 1000);
  sweepTimer.unref();

  // Query history has no fixed entry-count ceiling (see store/queries.js), so
  // this is the only thing bounding its growth in practice - check more
  // often than the cache sweep above to react quickly to a traffic burst.
  const queryMemoryTimer = setInterval(() => queries.enforceMemoryBound(), 5 * 1000);
  queryMemoryTimer.unref();

  function shutdown(signal) {
    logs.record('shutdown', `received ${signal}; stopping`);
    clearInterval(sweepTimer);
    clearInterval(queryMemoryTimer);
    try {
      queries.persist();
    } catch (e) {
      console.error(`[queries] Failed to save ${queriesFile}: ${e.message}`);
    }
    try {
      dns.close();
    } catch (_) { /* ignore */ }
    web.close();
    if (runtime.server) runtime.server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('Startup failed:', e);
  process.exit(1);
});

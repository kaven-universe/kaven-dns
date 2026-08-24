'use strict';

const net = require('net');

const { DATA_DIR, RULES_FILE, SESSIONS_FILE, loadConfig, saveConfig, hashPassword } = require('./config');
const { RulesStore } = require('./store/rules');
const { LogStore } = require('./store/logs');
const { DnsCache } = require('./dns/cache');
const { Resolver } = require('./dns/resolver');
const { createDnsServers } = require('./dns/server');
const { createAuth } = require('./web/auth');
const { createWebServer } = require('./web/server');

async function main() {
  const { config } = loadConfig();

  const rulesStore = new RulesStore(RULES_FILE);
  const logs = new LogStore(config.logCapacity);
  const cache = new DnsCache(config.cacheMaxEntries);
  const resolver = new Resolver({ rulesStore, cache, getConfig: () => config });
  const dns = createDnsServers({ resolver, logs, port: config.dnsPort, address: config.bindAddress });
  const auth = createAuth({
    verifyPassword: password => hashPassword(password) === config.passwordHash,
    getSessionTtlMs: () => config.sessionTtlHours * 3600 * 1000,
    sessionsFile: SESSIONS_FILE,
  });
  const web = createWebServer({
    config,
    rulesStore,
    logs,
    cache,
    resolver,
    auth,
    getDnsStatus: () => dns.status(),
    restartDns: async (port, address) => {
      try {
        await dns.restart(port, address);
        console.log(`[dns] listening on ${address || '0.0.0.0'}:${port} (UDP + TCP)`);
        return { applied: true, error: '' };
      } catch (e) {
        console.error(`[dns] failed to listen on ${address || '0.0.0.0'}:${port}: ${e.message}`);
        if (e.code === 'EADDRINUSE')
          console.error('Hint: another process is using this port; find it with `netstat -ano | findstr :' + port + '`');
        console.error('The Web console remains available; DNS resolution is NOT served until the port is free.');
        return { applied: false, error: (e && e.code) || e.message };
      }
    },
    // Populated after listen() below; lets PUT /api/config move the console
    // to a new port without restarting the process.
    runtime: {},
  });

  const webServer = await web.listen(config.webPort).catch(e => {
    console.error(`[web] failed to listen on port ${config.webPort}: ${e.message}`);
    console.error('Hint: set the KAVEN_WEB_PORT environment variable to use another port.');
    process.exit(1);
  });

  const runtime = web.runtime;
  runtime.currentPort = config.webPort;
  runtime.server = webServer;
  // Check a port is free without disturbing the running console, so the
  // settings API can reject a bad port before committing it.
  runtime.probeWeb = port => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
  runtime.moveWeb = async newPort => {
    const oldPort = runtime.currentPort;
    await new Promise(resolve => runtime.server.close(resolve));
    try {
      runtime.server = await web.listen(newPort);
      runtime.currentPort = newPort;
      console.log(`[web] console moved: http://127.0.0.1:${oldPort} -> http://127.0.0.1:${newPort}`);
      return { ok: true, port: newPort };
    } catch (e) {
      // Extremely unlikely (probe passed); restore the old port rather than
      // leaving the console down entirely.
      runtime.server = await web.listen(oldPort);
      throw e;
    }
  };

  console.log(`[web] console: http://127.0.0.1:${config.webPort}  (data dir: ${DATA_DIR})`);

  dns.start().then(() => {
    console.log(`[dns] listening on ${config.bindAddress}:${config.dnsPort} (UDP + TCP)`);
  }).catch(e => {
    console.error(`[dns] failed to listen on ${config.bindAddress}:${config.dnsPort}: ${e.message}`);
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

  function shutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down...`);
    clearInterval(sweepTimer);
    try {
      dns.close();
    } catch (_) { /* ignore */ }
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

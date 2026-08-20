'use strict';

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
  const dns = createDnsServers({ resolver, logs, port: config.dnsPort });
  const auth = createAuth({
    verifyPassword: password => hashPassword(password) === config.passwordHash,
    getSessionTtlMs: () => config.sessionTtlHours * 3600 * 1000,
    sessionsFile: SESSIONS_FILE,
  });
  const web = createWebServer({ config, rulesStore, logs, cache, resolver, auth });

  const webServer = await web.listen(config.webPort).catch(e => {
    console.error(`[web] failed to listen on port ${config.webPort}: ${e.message}`);
    console.error('Hint: set the KAVEN_WEB_PORT environment variable to use another port.');
    process.exit(1);
  });

  console.log(`[web] console: http://127.0.0.1:${config.webPort}  (data dir: ${DATA_DIR})`);

  dns.start().catch(e => {
    console.error(`[dns] failed to listen on port ${config.dnsPort}: ${e.message}`);
    console.error('Hint: port 53 requires administrator privileges on Windows;');
    console.error('      use the KAVEN_DNS_PORT environment variable for another port (e.g. 5330),');
    console.error('      or change it on the Settings page and restart.');
    console.error('      The Web console remains available.');
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
    webServer.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('Startup failed:', e);
  process.exit(1);
});

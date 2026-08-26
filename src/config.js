'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

// Data directory resolution:
//  1. KAVEN_DATA_DIR environment variable (Docker volumes, custom layouts)
//  2. <repo>/data otherwise
const DATA_DIR = process.env.KAVEN_DATA_DIR
  ? path.resolve(process.env.KAVEN_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  dnsPort: 53,
  webPort: 8080,
  // Local address the DNS servers bind to; 0.0.0.0 = every interface
  bindAddress: '0.0.0.0',
  // Local address the Web console binds to; 0.0.0.0 = every interface
  webBindAddress: '0.0.0.0',
  // Default upstream DNS servers (UDP); queries are raced, fastest response wins
  upstreams: ['223.5.5.5', '119.29.29.29', '114.114.114.114'],
  // Timeout for a single upstream forward (ms)
  forwardTimeoutMs: 3000,
  // Maximum cache entries (LRU eviction)
  cacheMaxEntries: 10000,
  // Cache TTL bounds (seconds); actual value is the answer's minimum TTL clamped here
  ttlMin: 10,
  ttlMax: 3600,
  // Number of query log entries kept in memory
  logCapacity: 1000,
  // Web console session lifetime in hours; sessions are renewed on activity,
  // so this is effectively an idle timeout
  sessionTtlHours: 24,
  // salted scrypt hash of the Web console password (see hashPassword); generated on first run
  passwordHash: '',
};

const SCRYPT_PREFIX = 'scrypt';
const SCRYPT_KEYLEN = 32;

// Stored as `scrypt:<salt>:<derivedHex>` so a rainbow-table/precomputed
// attack against a leaked config.json needs a fresh computation per install.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `${SCRYPT_PREFIX}:${salt}:${derived}`;
}

// Original (pre-salt) scheme: sha256("kaven-dns:" + password). Kept only so
// a passwordHash saved by an older version still verifies; hashPassword()
// never produces this format for new/changed passwords.
function legacyHashPassword(password) {
  return crypto.createHash('sha256').update(`kaven-dns:${password}`).digest('hex');
}

function verifyPassword(password, storedHash) {
  const stored = String(storedHash || '');
  const parts = stored.split(':');
  if (parts.length === 3 && parts[0] === SCRYPT_PREFIX) {
    const [, salt, expectedHex] = parts;
    const expected = Buffer.from(expectedHex, 'hex');
    const candidate = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
  }
  return Boolean(stored) && legacyHashPassword(password) === stored;
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Antivirus/indexing services on Windows may briefly lock files; retry once
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EEXIST') {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } else {
      throw e;
    }
  }
}

function clampInt(value, min, max, dflt) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

const UPSTREAM_RE = /^(\d+\.\d+\.\d+\.\d+)(:\d{1,5})?$/;

function sanitize(config) {
  config.upstreams = (Array.isArray(config.upstreams) ? config.upstreams : [])
    .map(s => String(s).trim())
    .filter(s => UPSTREAM_RE.test(s) || /^[0-9a-fA-F:]+$/.test(s));
  if (!config.upstreams.length) config.upstreams = [...DEFAULTS.upstreams];
  config.dnsPort = clampInt(config.dnsPort, 1, 65535, DEFAULTS.dnsPort);
  config.webPort = clampInt(config.webPort, 1, 65535, DEFAULTS.webPort);
  const addr = String(config.bindAddress || '').trim();
  config.bindAddress = net.isIP(addr) ? addr : DEFAULTS.bindAddress;
  const webAddr = String(config.webBindAddress || '').trim();
  config.webBindAddress = net.isIP(webAddr) ? webAddr : DEFAULTS.webBindAddress;
  config.forwardTimeoutMs = clampInt(config.forwardTimeoutMs, 500, 30000, DEFAULTS.forwardTimeoutMs);
  config.cacheMaxEntries = clampInt(config.cacheMaxEntries, 100, 1000000, DEFAULTS.cacheMaxEntries);
  config.ttlMin = clampInt(config.ttlMin, 1, 3600, DEFAULTS.ttlMin);
  config.ttlMax = clampInt(config.ttlMax, config.ttlMin, 86400, DEFAULTS.ttlMax);
  config.logCapacity = clampInt(config.logCapacity, 100, 10000, DEFAULTS.logCapacity);
  config.sessionTtlHours = clampInt(config.sessionTtlHours, 1, 720, DEFAULTS.sessionTtlHours);
  config.passwordHash = String(config.passwordHash || '');
  return config;
}

/**
 * Load config: use defaults when the file does not exist.
 * On first run (no password hash) generate a random password and print it.
 * KAVEN_DNS_PORT / KAVEN_WEB_PORT environment variables override the ports
 * (handy for debugging without administrator privileges).
 */
function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const config = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) {
      console.error(`[config] Failed to read ${CONFIG_FILE}, using defaults: ${e.message}`);
    }
  }
  // First run = no admin password set yet. Nothing is generated here; the Web
  // console shows a setup screen where the user picks the password, ports and
  // bind address (persisted by the POST /api/setup endpoint).
  const firstRun = !config.passwordHash;
  if (firstRun) {
    console.log('==============================================================');
    console.log('  First run: open the Web console to complete the setup');
    console.log('  (admin password, DNS/Web ports, bind address).');
    console.log('==============================================================');
  }
  if (process.env.KAVEN_DNS_PORT) {
    if (config.dnsPort !== Number(process.env.KAVEN_DNS_PORT))
      console.log(`[config] KAVEN_DNS_PORT=${process.env.KAVEN_DNS_PORT} overrides dnsPort from config (${config.dnsPort})`);
    config.dnsPort = Number(process.env.KAVEN_DNS_PORT);
  }
  if (process.env.KAVEN_WEB_PORT) {
    if (config.webPort !== Number(process.env.KAVEN_WEB_PORT))
      console.log(`[config] KAVEN_WEB_PORT=${process.env.KAVEN_WEB_PORT} overrides webPort from config (${config.webPort})`);
    config.webPort = Number(process.env.KAVEN_WEB_PORT);
  }
  sanitize(config);
  atomicWriteJson(CONFIG_FILE, config);
  return { config, firstRun };
}

function saveConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteJson(CONFIG_FILE, config);
}

module.exports = {
  DATA_DIR,
  RULES_FILE: path.join(DATA_DIR, 'rules.json'),
  SESSIONS_FILE: path.join(DATA_DIR, 'sessions.json'),
  loadConfig,
  saveConfig,
  sanitize,
  hashPassword,
  verifyPassword,
  atomicWriteJson,
};

'use strict';

const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Packet } = require('dns2');
const { saveConfig, sanitize, hashPassword } = require('../config');
const { validateRule } = require('../store/rules');
const { normalizeDomain } = require('../dns/matching');
const { typeName, summarizeAnswers } = require('../dns/util');
const { t, normalizeLang } = require('../i18n');
const { createSystemMonitor } = require('../system');
const { createEventStream } = require('./events');

const UPSTREAM_RE = /^\d+\.\d+\.\d+\.\d+(:\d{1,5})?$/;

// Local IPv4 addresses (for the bind-address dropdowns in the UI).
function getLocalIPv4s() {
  const ips = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const iface of os.networkInterfaces()[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

// When a service binds 0.0.0.0 (every interface), local probes must target
// the loopback address instead.
const effectiveProbeAddress = address =>
  !address || address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address;

// Base URL of the Web console for the given bind address/port.
function consoleBaseUrl(port, address) {
  return `http://${effectiveProbeAddress(address)}:${port}`;
}

// Best-effort check whether `address:port` can be bound by the DNS server,
// i.e. both a UDP (dgram) and a TCP (net.Server) listen succeed on it.
function probeBindable(address, port) {
  return new Promise(resolve => {
    const dgram = require('dgram');
    const udp = dgram.createSocket('udp4');
    const tcp = net.createServer();
    const state = { udp: null, tcp: null };
    let timer;
    const finish = () => {
      clearTimeout(timer);
      try { udp.close(); } catch (_) { /* already closed */ }
      try { tcp.close(); } catch (_) { /* already closed */ }
      resolve({
        available: state.udp === 'ok' && state.tcp === 'ok',
        udp: state.udp || 'timeout',
        tcp: state.tcp || 'timeout',
        address: address || '0.0.0.0',
        port,
      });
    };
    const maybeDone = () => { if (state.udp !== null && state.tcp !== null) finish(); };
    udp.once('error', e => { state.udp = e.code || e.message; maybeDone(); });
    udp.once('listening', () => { state.udp = 'ok'; try { udp.close(); } catch (_) { /* ignore */ } maybeDone(); });
    try { udp.bind(port, address || undefined); } catch (e) { state.udp = e.code || e.message; maybeDone(); }
    tcp.once('error', e => { state.tcp = e.code || e.message; maybeDone(); });
    try {
      tcp.listen(port, address || undefined, () => { state.tcp = 'ok'; tcp.close(() => maybeDone()); });
    } catch (e) { state.tcp = e.code || e.message; maybeDone(); }
    timer = setTimeout(finish, 3000);
  });
}

// A bindability probe cannot acquire an endpoint already held by our own DNS
// listener. Treat it as available when restarting DNS would first release the
// same endpoint. An IPv4 wildcard listener also owns every local IPv4 address.
function heldByOwnDnsListener(status, address, port) {
  if (!status || !status.listening || status.port !== port) return false;
  const currentAddress = status.address || '0.0.0.0';
  const requestedAddress = address || '0.0.0.0';
  return currentAddress === requestedAddress || currentAddress === '0.0.0.0';
}

function createWebServer({ config, rulesStore, logs, cache, resolver, auth, syslog, getDnsStatus, restartDns, runtime }) {
  const app = express();
  const systemMonitor = createSystemMonitor();
  const eventStream = createEventStream({
    logs,
    syslog,
    cache,
    systemMonitor,
    getDnsStatus,
    isAuthorized: token => auth.check(token),
  });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Negotiate the response language for user-facing API messages ('zh'/'en').
  app.use((req, res, next) => {
    req.lang = normalizeLang(req.headers['accept-language']);
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Authentication ----
  app.post('/api/auth/login', (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const result = auth.login(String((req.body && req.body.password) || ''), ip, req.lang);
    if (!result.ok) {
      if (syslog) syslog.record('auth', `login failed from ${ip}`, 'warn');
      return res.status(401).json({ error: result.error });
    }
    if (syslog) syslog.record('auth', `signed in from ${ip}`);
    res.json({ token: result.token });
  });

  app.post('/api/auth/logout', auth.middleware, (req, res) => {
    const header = req.headers.authorization || '';
    auth.logout(header.startsWith('Bearer ') ? header.slice(7) : '');
    res.json({ ok: true });
  });

  app.get('/api/auth/check', auth.middleware, (req, res) => {
    res.json({ ok: true });
  });

  // ---- First-run setup (public; active only until an admin password is set) ----
  app.get('/api/setup/status', (req, res) => {
    res.json({ needsSetup: !config.passwordHash, localIPs: getLocalIPv4s() });
  });

  // Availability check for the DNS address:port the user is about to enter.
  app.post('/api/setup/check', async (req, res) => {
    if (config.passwordHash)
      return res.status(409).json({ error: t(req.lang, 'setup.already_done') });
    const body = req.body || {};
    const dnsPort = Number(body.dnsPort);
    const bindAddress = String(body.bindAddress || '').trim();
    if (!Number.isInteger(dnsPort) || dnsPort < 1 || dnsPort > 65535)
      return res.status(400).json({ error: t(req.lang, 'config.port_range', { key: 'dnsPort' }) });
    if (bindAddress && !net.isIP(bindAddress))
      return res.status(400).json({ error: t(req.lang, 'config.bind_invalid', { value: bindAddress }) });

    const addr = bindAddress || '0.0.0.0';
    const cur = getDnsStatus ? getDnsStatus() : null;
    const selfHoldsRequested = heldByOwnDnsListener(cur, addr, dnsPort);
    const result = selfHoldsRequested
      ? { available: true, udp: 'ok', tcp: 'ok', address: addr, port: dnsPort, self: true }
      : await probeBindable(addr, dnsPort);
    // When busy, also probe 127.0.0.1 on the same port so the wizard can
    // suggest a local-only alternative. If OUR OWN DNS server already holds
    // the loopback port (the 0.0.0.0 -> 127.0.0.1 fallback), it is still
    // usable: completing setup restarts DNS onto the chosen address, which
    // closes the fallback listener first.
    if (!result.available && addr !== '127.0.0.1') {
      const selfHoldsLoopback = heldByOwnDnsListener(cur, '127.0.0.1', dnsPort);
      let alt = null;
      if (selfHoldsLoopback) {
        alt = { available: true, address: '127.0.0.1', port: dnsPort, self: true };
      } else {
        alt = await probeBindable('127.0.0.1', dnsPort);
      }
      if (alt.available) result.suggestion = { address: '127.0.0.1', port: dnsPort };
    }
    res.json(result);
  });

  app.post('/api/setup', async (req, res) => {
    if (config.passwordHash)
      return res.status(409).json({ error: t(req.lang, 'setup.already_done') });
    const body = req.body || {};
    const tr = (key, args) => t(req.lang, key, args);
    const errors = [];

    const password = String(body.password || '');
    if (password.length < 6) errors.push(tr('setup.password_min'));

    const dnsPort = Number(body.dnsPort);
    if (!Number.isInteger(dnsPort) || dnsPort < 1 || dnsPort > 65535)
      errors.push(tr('config.port_range', { key: 'dnsPort' }));

    const bindAddress = String(body.bindAddress || '').trim();
    if (bindAddress && !net.isIP(bindAddress))
      errors.push(tr('config.bind_invalid', { value: bindAddress }));

    // Optional: the Web console's own bind address (defaults to the current one).
    const webBind = body.webBindAddress !== undefined && body.webBindAddress !== null && body.webBindAddress !== ''
      ? String(body.webBindAddress).trim()
      : config.webBindAddress;
    if (!net.isIP(webBind))
      errors.push(tr('config.bind_invalid', { value: webBind }));

    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const webBindChanged = webBind !== config.webBindAddress;

    config.passwordHash = hashPassword(password);
    config.dnsPort = dnsPort;
    config.bindAddress = bindAddress || '0.0.0.0';
    if (webBindChanged) config.webBindAddress = webBind;
    sanitize(config);
    saveConfig(config);

    const response = { ok: true };
    if (restartDns) response.dns = await restartDns(config.dnsPort, config.bindAddress);
    if (syslog) syslog.record('setup', `first-run setup completed: dns ${config.dnsPort}@${config.bindAddress}, web@${config.webBindAddress}`);

    // Rebind the console when the web bind address changed (after the response
    // has flushed, so the current connection is not cut mid-reply).
    if (webBindChanged) {
      response.newWebUrl = consoleBaseUrl(config.webPort, config.webBindAddress);
      res.once('finish', () => {
        if (runtime && runtime.moveWeb)
          runtime.moveWeb(config.webPort, config.webBindAddress).catch(e =>
            console.error('[web] failed to re-bind console to', config.webBindAddress, '-', e.message));
      });
    }
    res.json(response);
  });

  // ---- All APIs below require authentication ----
  app.use('/api', auth.middleware);

  app.get('/api/events', (req, res) => {
    eventStream.handle(req, res);
  });

  // Rule CRUD
  app.get('/api/rules', (req, res) => {
    res.json({ rules: rulesStore.list() });
  });

  const ruleLabel = rule => {
    const n = rule.domains ? rule.domains.length : 0;
    const first = rule.domains && rule.domains[0] ? rule.domains[0] : '?';
    return `${first}${n > 1 ? ' (+' + (n - 1) + ')' : ''} ${rule.type || ''}`;
  };

  app.post('/api/rules', (req, res) => {
    const { errors, value } = validateRule(req.body || {}, req.lang);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const rule = rulesStore.add(value);
    if (syslog) syslog.record('rules', `added ${ruleLabel(rule)}`);
    res.status(201).json({ rule });
  });

  app.put('/api/rules/:id', (req, res) => {
    const old = rulesStore.getAll().find(r => r.id === req.params.id);
    if (!old) return res.status(404).json({ error: t(req.lang, 'rules.not_found') });
    const { errors, value } = validateRule({ ...old, ...req.body }, req.lang);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const rule = rulesStore.update(req.params.id, value);
    if (syslog) syslog.record('rules', `updated ${ruleLabel(rule)}`);
    res.json({ rule });
  });

  app.delete('/api/rules/:id', (req, res) => {
    const rule = rulesStore.getAll().find(r => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: t(req.lang, 'rules.not_found') });
    if (!rulesStore.remove(req.params.id))
      return res.status(404).json({ error: t(req.lang, 'rules.not_found') });
    if (syslog) syslog.record('rules', `removed ${ruleLabel(rule)}`);
    res.json({ ok: true });
  });

  // Import rules from an exported file. Every entry goes through the same
  // validation as manual editing; invalid entries are skipped and reported.
  // mode 'merge' updates existing rules with the same domain-set + type,
  // mode 'replace' drops all current rules first.
  app.post('/api/rules/import', (req, res) => {
    const body = req.body || {};
    const incoming = Array.isArray(body.rules) ? body.rules : [];
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    if (!incoming.length)
      return res.status(400).json({ error: t(req.lang, 'rules.import_empty') });

    const valid = [];
    const errors = [];
    incoming.forEach((r, i) => {
      const { errors: errs, value } = validateRule(r || {}, req.lang);
      if (errs.length) errors.push(`#${i + 1}: ${errs[0]}`);
      else valid.push({ value, src: r });
    });

    const now = Date.now();
    let added = 0;
    let updated = 0;
    if (mode === 'replace') {
      rulesStore.replaceAll(
        valid.map(({ value, src }) => ({
          ...value,
          id: src && typeof src.id === 'string' && src.id ? src.id : crypto.randomUUID(),
          createdAt: src && src.createdAt ? src.createdAt : now,
          updatedAt: now,
        })),
      );
      added = valid.length;
    } else {
      const sig = r => [...r.domains].sort().join('|') + '::' + r.type;
      const existing = new Map(rulesStore.getAll().map(r => [sig(r), r]));
      for (const { value, src } of valid) {
        const cur = existing.get(sig(value));
        if (cur) {
          rulesStore.update(cur.id, value);
          updated++;
        } else {
          rulesStore.add({
            ...value,
            createdAt: src && src.createdAt ? src.createdAt : now,
          });
          added++;
        }
      }
    }

    if (syslog) syslog.record('rules', `imported: +${added} added, ${updated} updated, ${errors.length} skipped (${mode})`);

    res.json({
      ok: true,
      mode,
      added,
      updated,
      skipped: errors.length,
      errors: errors.slice(0, 5),
    });
  });

  // Logs and stats
  app.get('/api/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json({
      logs: logs.list({
        limit,
        domain: String(req.query.domain || ''),
        source: String(req.query.source || ''),
      }),
    });
  });

  app.get('/api/stats', (req, res) => {
    res.json({
      stats: logs.getStats(),
      analytics: logs.getAnalytics(),
      cache: cache.info(),
      system: systemMonitor.snapshot(),
      dns: getDnsStatus ? getDnsStatus() : null,
    });
  });

  // System log: console output + audit events (operation/config changes)
  app.get('/api/syslog', (req, res) => {
    let limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) limit = 400;
    res.json(syslog ? syslog.snapshot(limit) : { console: [], events: [] });
  });

  // Stop the whole process (used by the packaged desktop app's Quit button).
  // The response is flushed before exit; requires an authenticated session.
  app.post('/api/shutdown', auth.middleware, (req, res) => {
    if (syslog) syslog.record('shutdown', 'stopping via the console Quit button');
    res.json({ ok: true });
    res.once('finish', () => {
      console.log('[web] shutdown requested via API; exiting.');
      process.exit(0);
    });
  });

  // Cache management
  app.post('/api/cache/flush', (req, res) => {
    const flushed = cache.flush();
    if (syslog) syslog.record('cache', `flushed ${flushed} cached entries`);
    res.json({ ok: true, flushed });
  });

  // Config read/write (never returns the password hash)
  app.get('/api/config', (req, res) => {
    const { passwordHash, ...rest } = config;
    res.json({ config: { ...rest, hasPassword: Boolean(passwordHash) }, localIPs: getLocalIPv4s() });
  });

  app.put('/api/config', async (req, res) => {
    const body = req.body || {};
    const lang = req.lang;
    const tr = (key, args) => t(lang, key, args);
    const errors = [];

    if (body.upstreams !== undefined) {
      const list = Array.isArray(body.upstreams)
        ? body.upstreams.map(s => String(s).trim()).filter(Boolean)
        : [];
      const bad = list.filter(s => !UPSTREAM_RE.test(s) && !net.isIPv6(s));
      if (bad.length) errors.push(tr('config.upstream_bad', { list: bad.join(', ') }));
      if (!list.length) errors.push(tr('config.upstream_required'));
      if (list.length > 8) errors.push(tr('config.upstream_max'));
      body._upstreams = list;
    }

    const nums = {};
    for (const key of ['forwardTimeoutMs', 'cacheMaxEntries', 'ttlMin', 'ttlMax', 'logCapacity']) {
      if (body[key] !== undefined) {
        const n = Number(body[key]);
        if (!Number.isFinite(n)) errors.push(tr('config.must_be_number', { key }));
        nums[key] = n;
      }
    }

    if (body.sessionTtlHours !== undefined) {
      const n = Number(body.sessionTtlHours);
      if (!Number.isInteger(n) || n < 1 || n > 720)
        errors.push(tr('config.session_ttl_range'));
      else nums.sessionTtlHours = n;
    }

    for (const key of ['dnsPort', 'webPort']) {
      if (body[key] !== undefined) {
        const n = Number(body[key]);
        if (!Number.isInteger(n) || n < 1 || n > 65535)
          errors.push(tr('config.port_range', { key }));
        nums[key] = n;
      }
    }

    let bindAddress;
    if (body.bindAddress !== undefined) {
      bindAddress = String(body.bindAddress).trim() || '0.0.0.0';
      if (!net.isIP(bindAddress))
        errors.push(tr('config.bind_invalid', { value: bindAddress }));
    }

    let webBindAddress;
    if (body.webBindAddress !== undefined) {
      webBindAddress = String(body.webBindAddress).trim() || '0.0.0.0';
      if (!net.isIP(webBindAddress))
        errors.push(tr('config.bind_invalid', { value: webBindAddress }));
    }

    let passwordChanged = false;
    if (body.newPassword !== undefined && body.newPassword !== '') {
      if (!body.currentPassword || hashPassword(body.currentPassword) !== config.passwordHash)
        errors.push(tr('config.current_password_incorrect'));
      else if (String(body.newPassword).length < 6)
        errors.push(tr('config.password_min'));
      else passwordChanged = true;
    }

    // Port changes are applied live: DNS re-listens immediately; the console
    // moves only after the response is out, so the connection is not cut
    // mid-reply. A busy web port is rejected up front without touching config.
    const dnsPortChanged = nums.dnsPort !== undefined && nums.dnsPort !== config.dnsPort;
    const bindChanged = bindAddress !== undefined && bindAddress !== config.bindAddress;
    const webPortChanged = nums.webPort !== undefined && nums.webPort !== config.webPort;
    const webBindChanged = webBindAddress !== undefined && webBindAddress !== config.webBindAddress;

    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    if (webPortChanged) {
      if (!runtime || !runtime.probeWeb) {
        return res.status(500).json({ error: t(req.lang, 'api.internal_error') });
      }
      try {
        await runtime.probeWeb(nums.webPort);
      } catch (_) {
        return res.status(400).json({ error: tr('config.web_port_busy', { port: nums.webPort }) });
      }
    }

    if (body._upstreams) config.upstreams = body._upstreams;
    const old = { ...config };
    if (nums.forwardTimeoutMs !== undefined) config.forwardTimeoutMs = nums.forwardTimeoutMs;
    if (nums.cacheMaxEntries !== undefined) {
      config.cacheMaxEntries = nums.cacheMaxEntries;
      cache.setMaxEntries(nums.cacheMaxEntries);
    }
    if (nums.ttlMin !== undefined) config.ttlMin = nums.ttlMin;
    if (nums.ttlMax !== undefined) config.ttlMax = nums.ttlMax;
    if (nums.logCapacity !== undefined) {
      config.logCapacity = nums.logCapacity;
      logs.setCapacity(nums.logCapacity);
    }
    if (nums.sessionTtlHours !== undefined) config.sessionTtlHours = nums.sessionTtlHours;
    if (nums.dnsPort !== undefined) config.dnsPort = nums.dnsPort;
    if (bindAddress !== undefined) config.bindAddress = bindAddress;
    if (webBindAddress !== undefined) config.webBindAddress = webBindAddress;
    if (nums.webPort !== undefined) config.webPort = nums.webPort;
    if (passwordChanged) config.passwordHash = hashPassword(String(body.newPassword));

    sanitize(config);
    saveConfig(config);

    // sanitize() clamps out-of-range numbers to valid bounds; tell the client
    // which requested values were silently adjusted so the UI can flag them.
    const adjusted = {};
    for (const key of ['forwardTimeoutMs', 'cacheMaxEntries', 'ttlMin', 'ttlMax', 'logCapacity']) {
      if (nums[key] !== undefined && nums[key] !== config[key]) adjusted[key] = config[key];
    }

    const response = { ok: true, passwordChanged, adjusted };
    if ((dnsPortChanged || bindChanged) && restartDns)
      response.dns = await restartDns(config.dnsPort, config.bindAddress);
    if (webPortChanged) response.newWebPort = nums.webPort;
    // Changing the web bind address/port moves the console; give the frontend
    // the exact base URL to follow.
    if (webPortChanged || webBindChanged)
      response.newWebUrl = consoleBaseUrl(config.webPort, config.webBindAddress);

    if (syslog) {
      const changed = [];
      if (dnsPortChanged) changed.push(`dnsPort=${config.dnsPort}`);
      if (bindChanged) changed.push(`bind=${config.bindAddress}`);
      if (webPortChanged) changed.push(`webPort=${nums.webPort}`);
      if (webBindChanged) changed.push(`webBind=${config.webBindAddress}`);
      if (passwordChanged) changed.push('password');
      for (const key of ['forwardTimeoutMs', 'cacheMaxEntries', 'ttlMin', 'ttlMax', 'logCapacity', 'sessionTtlHours']) {
        if (nums[key] !== undefined && old[key] !== config[key]) changed.push(`${key}=${config[key]}`);
      }
      if (old.upstreams !== config.upstreams && body._upstreams) changed.push(`upstreams(${config.upstreams.length})`);
      syslog.record('config', `updated: ${changed.join(', ') || 'no changes'}`);
    }

    res.json(response);

    // Move the console after the response has flushed to the client.
    if (webPortChanged || webBindChanged) {
      res.once('finish', () => {
        runtime.moveWeb(nums.webPort !== undefined ? nums.webPort : config.webPort, config.webBindAddress).catch(e =>
          console.error('[web] failed to move console to', config.webBindAddress, nums.webPort, '-', e.message));
      });
    }
  });

  // Resolve test: goes through the full pipeline (rules/cache included) for
  // debugging from the console UI
  app.post('/api/resolve', async (req, res) => {
    const domain = normalizeDomain((req.body && req.body.domain) || '');
    const tName = String((req.body && req.body.type) || 'A').toUpperCase();
    if (!domain) return res.status(400).json({ error: t(req.lang, 'resolve.domain_required') });
    const typeNum = Packet.TYPE[tName];
    if (!typeNum)
      return res.status(400).json({ error: t(req.lang, 'resolve.unsupported_type', { type: tName }) });

    const started = Date.now();
    let result = null;
    let error = null;
    try {
      result = await resolver.resolve(domain, typeNum);
    } catch (e) {
      error = e;
    }
    const latencyMs = Date.now() - started;

    logs.record({
      t: started,
      client: 'web-ui',
      domain,
      type: tName,
      source: result ? result.source : 'forward',
      rcode: result ? result.rcode : Packet.RCODE.SERVFAIL,
      latencyMs,
      answers: result ? summarizeAnswers(result.answers) : '',
      rule: (result && result.ruleLabel) || '',
      upstream: (result && result.upstream) || '',
      error: error ? error.message : '',
    });

    res.json({
      domain,
      type: tName,
      source: result ? result.source : 'error',
      rcode: result ? result.rcode : Packet.RCODE.SERVFAIL,
      latencyMs,
      rule: (result && result.ruleLabel) || '',
      upstream: (result && result.upstream) || '',
      answers: (result ? result.answers : []).map(a => ({
        name: a.name,
        type: typeName(a.type),
        ttl: a.ttl,
        value: a.address || a.domain || (a.data ? `${a.data.length} bytes` : typeName(a.type)),
      })),
      error: error ? error.message : null,
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: t(req.lang, 'api.not_found') }));

  // JSON parse errors and other errors return 400/500 uniformly
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed')
      return res.status(400).json({ error: t(req.lang, 'api.invalid_json') });
    console.error('[web] request error:', err && err.message);
    res.status(500).json({ error: t(req.lang, 'api.internal_error') });
  });

  function listen(port, address) {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, address || undefined, () => resolve(server));
      server.on('error', reject);
    });
  }

  return {
    listen,
    runtime,
    disconnectEvents: eventStream.disconnect,
    close: eventStream.close,
  };
}

module.exports = { createWebServer, heldByOwnDnsListener };

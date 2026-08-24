'use strict';

const path = require('path');
const net = require('net');
const crypto = require('crypto');
const express = require('express');
const { Packet } = require('dns2');
const { saveConfig, sanitize, hashPassword } = require('../config');
const { validateRule } = require('../store/rules');
const { normalizeDomain } = require('../dns/matching');
const { typeName, summarizeAnswers } = require('../dns/util');
const { t, normalizeLang } = require('../i18n');
const { createSystemMonitor } = require('../system');

const UPSTREAM_RE = /^\d+\.\d+\.\d+\.\d+(:\d{1,5})?$/;

function createWebServer({ config, rulesStore, logs, cache, resolver, auth, getDnsStatus, restartDns, runtime }) {
  const app = express();
  const systemMonitor = createSystemMonitor();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Negotiate the response language for user-facing API messages ('zh'/'en')
  app.use((req, res, next) => {
    req.lang = normalizeLang(req.headers['accept-language']);
    next();
  });

  // ---- Authentication ----
  app.post('/api/auth/login', (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const result = auth.login(String((req.body && req.body.password) || ''), ip, req.lang);
    if (!result.ok) return res.status(401).json({ error: result.error });
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

  // ---- All APIs below require authentication ----
  app.use('/api', auth.middleware);

  // Rule CRUD
  app.get('/api/rules', (req, res) => {
    res.json({ rules: rulesStore.list() });
  });

  app.post('/api/rules', (req, res) => {
    const { errors, value } = validateRule(req.body || {}, req.lang);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    res.status(201).json({ rule: rulesStore.add(value) });
  });

  app.put('/api/rules/:id', (req, res) => {
    const old = rulesStore.getAll().find(r => r.id === req.params.id);
    if (!old) return res.status(404).json({ error: t(req.lang, 'rules.not_found') });
    const { errors, value } = validateRule({ ...old, ...req.body }, req.lang);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    res.json({ rule: rulesStore.update(req.params.id, value) });
  });

  app.delete('/api/rules/:id', (req, res) => {
    if (!rulesStore.remove(req.params.id))
      return res.status(404).json({ error: t(req.lang, 'rules.not_found') });
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
      cache: cache.info(),
      system: systemMonitor.snapshot(),
      dns: getDnsStatus ? getDnsStatus() : null,
    });
  });

  // Cache management
  app.post('/api/cache/flush', (req, res) => {
    const flushed = cache.flush();
    res.json({ ok: true, flushed });
  });

  // Config read/write (never returns the password hash)
  app.get('/api/config', (req, res) => {
    const { passwordHash, ...rest } = config;
    res.json({ config: { ...rest, hasPassword: Boolean(passwordHash) } });
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

    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    if (webPortChanged && (!runtime || !runtime.probeWeb))
      return res.status(500).json({ error: t(req.lang, 'api.internal_error') });
    if (webPortChanged) {
      try {
        await runtime.probeWeb(nums.webPort);
      } catch (_) {
        return res.status(400).json({ error: tr('config.web_port_busy', { port: nums.webPort }) });
      }
    }

    if (body._upstreams) config.upstreams = body._upstreams;
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
    res.json(response);

    // Move the console after the response has flushed to the client.
    if (webPortChanged) {
      res.once('finish', () => {
        runtime.moveWeb(nums.webPort).catch(e =>
          console.error('[web] failed to move console to port', nums.webPort, '-', e.message));
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

  function listen(port) {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, () => resolve(server));
      server.on('error', reject);
    });
  }

  return { listen, runtime };
}

module.exports = { createWebServer };

'use strict';

const net = require('net');
const crypto = require('crypto');
const { atomicWriteJson } = require('../config');
const { normalizeDomain } = require('../dns/matching');
const { t } = require('../i18n');

const TYPES = ['A', 'AAAA', 'CNAME'];
const MODES = ['fixed', 'forward'];

const DOMAIN_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UPSTREAM_RULE_RE = /^\d+\.\d+\.\d+\.\d+(:\d{1,5})?$/;

/**
 * Validate and normalize a rule. Returns { errors: string[], value: normalized fields }.
 * Error messages are localized via `lang` ('zh' / 'en', default 'en').
 * For fixed mode `value` holds the IP list (comma-separated) or CNAME target;
 * for forward mode it is empty.
 */
function validateRule(input, lang = 'en') {
  const tr = (key, args) => t(lang, key, args);
  const errors = [];
  const domain = normalizeDomain(input.domain);
  if (!domain) errors.push(tr('rules.domain_required'));
  else if (domain.length > 253 || !DOMAIN_RE.test(domain))
    errors.push(tr('rules.domain_invalid'));

  const type = TYPES.includes(input.type) ? input.type : null;
  if (!type) errors.push(tr('rules.type_invalid'));

  const mode = MODES.includes(input.mode) ? input.mode : null;
  if (!mode) errors.push(tr('rules.mode_invalid'));

  let value = '';
  if (mode === 'fixed' && type) {
    const values = String(input.value || '')
      .split(/[,;\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!values.length) errors.push(tr('rules.fixed_value_required'));
    else if (type === 'A' && values.some(v => !net.isIPv4(v)))
      errors.push(tr('rules.a_ipv4'));
    else if (type === 'AAAA' && values.some(v => !net.isIPv6(v)))
      errors.push(tr('rules.aaaa_ipv6'));
    else if (type === 'CNAME' && values.length > 1)
      errors.push(tr('rules.cname_single'));
    else if (type === 'CNAME' && !HOSTNAME_RE.test(normalizeDomain(values[0])))
      errors.push(tr('rules.cname_invalid'));
    value = values.join(',');
  }

  const upstream = String(input.upstream || '').trim();
  if (upstream && !UPSTREAM_RULE_RE.test(upstream) && !net.isIPv6(upstream))
    errors.push(tr('rules.upstream_invalid'));

  const ttl = Number(input.ttl);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400)
    errors.push(tr('rules.ttl_invalid'));

  return {
    errors,
    value: {
      domain,
      type,
      mode,
      value,
      upstream: upstream || '',
      ttl,
      enabled: input.enabled !== false,
      remark: String(input.remark || '').slice(0, 200),
    },
  };
}

/**
 * Rule store: in-memory array + rules.json persistence.
 * DNS queries read the in-memory array directly; writes persist immediately
 * and take effect right away (hot reload, no restart needed).
 */
class RulesStore {
  constructor(file) {
    this.file = file;
    this.rules = this.load();
  }

  load() {
    try {
      const arr = JSON.parse(require('fs').readFileSync(this.file, 'utf8'));
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(r => r && typeof r === 'object')
        .map(r => ({ ...r, id: r.id || crypto.randomUUID() }));
    } catch (e) {
      if (e.code !== 'ENOENT')
        console.error(`[rules] Failed to read ${this.file}: ${e.message}`);
      return [];
    }
  }

  persist() {
    atomicWriteJson(this.file, this.rules);
  }

  list() {
    return this.rules.map(r => ({ ...r }));
  }

  // Read access for the resolver (read-only usage; no copy to keep queries cheap)
  getAll() {
    return this.rules;
  }

  add(data) {
    const now = Date.now();
    const rule = {
      id: crypto.randomUUID(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.push(rule);
    this.persist();
    return { ...rule };
  }

  update(id, data) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return null;
    const updated = {
      ...this.rules[idx],
      ...data,
      id,
      createdAt: this.rules[idx].createdAt,
      updatedAt: Date.now(),
    };
    this.rules[idx] = updated;
    this.persist();
    return { ...updated };
  }

  remove(id) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.persist();
    return true;
  }
}

module.exports = { RulesStore, validateRule };

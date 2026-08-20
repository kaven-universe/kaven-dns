'use strict';

const net = require('net');
const crypto = require('crypto');
const { atomicWriteJson } = require('../config');
const { normalizeDomain } = require('../dns/matching');
const { t } = require('../i18n');

const TYPES = ['A', 'AAAA', 'CNAME'];
const MODES = ['fixed', 'forward'];
const MAX_DOMAINS_PER_RULE = 500;

const DOMAIN_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UPSTREAM_RULE_RE = /^\d+\.\d+\.\d+\.\d+(:\d{1,5})?$/;

/**
 * Parse a domain group from an array of strings, or from a string where
 * domains are separated by newlines / commas / semicolons / whitespace
 * (what a textarea naturally produces). Returns deduplicated, normalized
 * domains with empty entries removed.
 */
function parseDomains(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\n,;\s]+/);
  const seen = new Set();
  const list = [];
  for (const item of raw) {
    const d = normalizeDomain(item);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    list.push(d);
  }
  return list;
}

/**
 * Validate and normalize a rule. Returns { errors: string[], value: normalized fields }.
 * A rule holds a group of domains (`domains: string[]`) sharing one
 * configuration; editing a rule applies to the whole group at once.
 * Error messages are localized via `lang` ('zh' / 'en', default 'en').
 */
function validateRule(input, lang = 'en') {
  const tr = (key, args) => t(lang, key, args);
  const errors = [];
  const domains = parseDomains(input.domains !== undefined ? input.domains : input.domain);
  if (!domains.length) errors.push(tr('rules.domains_required'));
  else if (domains.length > MAX_DOMAINS_PER_RULE)
    errors.push(tr('rules.domains_max', { n: MAX_DOMAINS_PER_RULE }));
  else {
    domains.forEach((d, i) => {
      if (d.length > 253 || !DOMAIN_RE.test(d))
        errors.push(tr('rules.domain_line_invalid', { n: i + 1, domain: d }));
    });
  }

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
      domains,
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
 * On load, legacy rules with a single `domain` string are migrated to the
 * `domains` array format (and the migration is persisted).
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
      let migrated = false;
      this.rules = arr
        .filter(r => r && typeof r === 'object')
        .map(r => {
          const rule = { ...r, id: r.id || crypto.randomUUID() };
          const domains = Array.isArray(r.domains)
            ? [...new Set(r.domains.map(normalizeDomain).filter(Boolean))]
            : [];
          if (r.domain !== undefined) delete rule.domain;
          if (domains.length) rule.domains = domains;
          else rule.domains = r.domain ? [normalizeDomain(r.domain)] : [];
          if (JSON.stringify(rule) !== JSON.stringify(r)) migrated = true;
          return rule;
        });
      if (migrated) this.persist();
      return this.rules;
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

  // Used by the import "replace" mode: swap the whole rule set at once
  replaceAll(rules) {
    this.rules = rules;
    this.persist();
  }
}

module.exports = { RulesStore, validateRule };

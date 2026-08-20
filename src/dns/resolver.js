'use strict';

const { Packet } = require('dns2');
const { findMatch, normalizeDomain } = require('./matching');
const { forwardQuery } = require('./forwarder');
const { TYPE_NAMES } = require('./util');

const MAX_CNAME_DEPTH = 4;

function ruleLabel(rule) {
  if (!rule) return '';
  return rule.remark ? `${rule.domain} (${rule.remark})` : rule.domain;
}

/**
 * Resolution pipeline: rule match → fixed answer / cache / upstream forward.
 * The rule list is read live on every query, so rule changes take effect
 * immediately without a restart.
 *
 * resolve() returns:
 *   { rcode, answers, authorities, additionals,
 *     source: 'fixed' | 'cache' | 'forward', ruleLabel, upstream? }
 */
class Resolver {
  constructor({ rulesStore, cache, getConfig }) {
    this.rulesStore = rulesStore;
    this.cache = cache;
    this.getConfig = getConfig;
  }

  async resolve(rawDomain, typeNumber, depth = 0, visited = new Set()) {
    const config = this.getConfig();
    const domain = normalizeDomain(rawDomain);
    const tName = TYPE_NAMES[typeNumber];
    const rule = tName ? findMatch(this.rulesStore.getAll(), domain, tName) : null;

    if (rule && rule.mode === 'fixed') {
      return this.buildFixedAnswer(rule, domain, typeNumber, tName, depth, visited);
    }

    const upstreams =
      rule && rule.mode === 'forward' && rule.upstream
        ? [rule.upstream]
        : config.upstreams;
    const cacheKey = `${domain}|${typeNumber}|${upstreams.join(',')}`;

    const hit = this.cache.get(cacheKey);
    if (hit) {
      return { ...hit, source: 'cache', ruleLabel: rule ? ruleLabel(rule) : '' };
    }

    const result = await forwardQuery(domain, typeNumber, upstreams, config.forwardTimeoutMs)
      .catch(err => {
        err.allFailed = true;
        throw err;
      });
    if (!result) {
      // Unsupported type (e.g. some private types): answer NOTIMP
      return {
        rcode: Packet.RCODE.NOTIMP,
        answers: [],
        authorities: [],
        additionals: [],
        source: 'forward',
        ruleLabel: rule ? ruleLabel(rule) : '',
      };
    }

    const { response, upstream } = result;
    const out = {
      rcode: response.header.rcode,
      answers: response.answers || [],
      authorities: (response.authorities || []).map(a => ({ ...a })),
      // Drop OPT/EDNS records: our response header does not echo EDNS
      additionals: (response.additionals || [])
        .filter(a => a.type !== Packet.TYPE.EDNS)
        .map(a => ({ ...a })),
      source: 'forward',
      upstream,
      ruleLabel: rule ? ruleLabel(rule) : '',
    };
    if (out.rcode === Packet.RCODE.NOERROR && out.answers.length) {
      const minTtl = Math.min(
        ...out.answers.map(a => (typeof a.ttl === 'number' ? a.ttl : config.ttlMin)),
      );
      const ttl = Math.max(config.ttlMin, Math.min(config.ttlMax, minTtl));
      this.cache.set(
        cacheKey,
        { rcode: out.rcode, answers: out.answers, authorities: out.authorities, additionals: out.additionals },
        ttl,
      );
    }
    return out;
  }

  async buildFixedAnswer(rule, domain, typeNumber, tName, depth, visited) {
    const label = ruleLabel(rule);
    const base = {
      rcode: Packet.RCODE.NOERROR,
      authorities: [],
      additionals: [],
      source: 'fixed',
      ruleLabel: label,
    };

    if (rule.type === 'CNAME') {
      const target = normalizeDomain(rule.value);
      const cnameRecord = {
        name: domain,
        type: Packet.TYPE.CNAME,
        class: Packet.CLASS.IN,
        ttl: rule.ttl,
        domain: target,
      };
      // For A/AAAA queries include the CNAME and keep resolving the target
      // to assemble a complete answer
      let extra = [];
      if (tName !== 'CNAME' && depth < MAX_CNAME_DEPTH && !visited.has(target)) {
        visited.add(target);
        const sub = await this.resolve(target, typeNumber, depth + 1, visited).catch(() => null);
        if (sub && sub.rcode === Packet.RCODE.NOERROR) extra = sub.answers || [];
      }
      return { ...base, answers: [cnameRecord, ...extra] };
    }

    const values = String(rule.value || '')
      .split(/[,;\s]+/)
      .filter(Boolean);
    const answers = values.map(value => ({
      name: domain,
      type: Packet.TYPE[rule.type],
      class: Packet.CLASS.IN,
      ttl: rule.ttl,
      address: value,
    }));
    return { ...base, answers };
  }
}

module.exports = { Resolver };

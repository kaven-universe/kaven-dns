'use strict';

/**
 * Query log (ring buffer, drops oldest when full) + aggregate stats.
 * Logs are kept in memory only and reset on restart.
 */
// Hard ceiling on retained entries, independent of the configured retention
// window - not user-configurable. Purely a safety net bounding worst-case
// memory if actual query volume is far higher than the retention window
// assumes; ~200000 entries is well under 200MB and should not bind for any
// realistic deployment.
const HARD_CAP = 200000;

class LogStore {
  constructor(capacity = HARD_CAP, retentionDays = 0, clock = Date.now) {
    this.capacity = capacity;
    this.retentionMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 0;
    this.clock = clock;
    this.entries = [];
    this.stats = this.resetStats();
    this.sequence = 0;
    this.listeners = new Set();
  }

  resetStats() {
    return {
      startedAt: Date.now(),
      total: 0,
      fixed: 0,
      cache: 0,
      forward: 0,
      servfail: 0,
      nxdomain: 0,
      totalLatencyMs: 0,
      forwardLatencyMs: 0,
    };
  }

  // 0 disables time-based trimming; entries are then bounded by capacity alone.
  setRetentionDays(days) {
    this.retentionMs = days > 0 ? days * 24 * 60 * 60 * 1000 : 0;
    this.trimExpired();
  }

  // Entries are appended in order, so expired ones are always a prefix.
  trimExpired() {
    if (!this.retentionMs) return;
    const cutoff = this.clock() - this.retentionMs;
    let i = 0;
    while (i < this.entries.length && this.entries[i].t < cutoff) i++;
    if (i > 0) this.entries.splice(0, i);
  }

  record(entry) {
    const logged = { ...entry, seq: ++this.sequence };
    this.entries.push(logged);
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity);
    this.trimExpired();

    const s = this.stats;
    s.total++;
    if (logged.source === 'fixed') s.fixed++;
    else if (logged.source === 'cache') s.cache++;
    else if (logged.source === 'forward') s.forward++;
    if (logged.rcode === 2) s.servfail++;
    if (logged.rcode === 3) s.nxdomain++;
    s.totalLatencyMs += logged.latencyMs || 0;
    // Latency of queries that actually hit an upstream (cache hits say
    // nothing about upstream quality)
    if (logged.source === 'forward') s.forwardLatencyMs += logged.latencyMs || 0;

    for (const listener of this.listeners) {
      try { listener(logged); } catch (_) { /* observers must never break DNS */ }
    }
    return logged;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list({ limit = 200, domain = '', source = '', status = '', type = '', client = '', rule = '', since = 0, until = 0 } = {}) {
    const d = domain.trim().toLowerCase();
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (d && !e.domain.includes(d)) continue;
      if (source && e.source !== source) continue;
      if (status === 'ok' && e.rcode !== 0) continue;
      if (status === 'fail' && e.rcode === 0) continue;
      if (type && e.type !== type) continue;
      if (client && e.client !== client) continue;
      if (rule && (e.rule || e.upstream || e.error || '') !== rule) continue;
      if (since && e.t < since) continue;
      if (until && e.t > until) continue;
      out.push(e);
    }
    return out;
  }

  getStats() {
    const s = this.stats;
    const forwards = s.forward;
    return {
      ...s,
      uptimeMs: Date.now() - s.startedAt,
      avgLatencyMs: s.total ? +(s.totalLatencyMs / s.total).toFixed(1) : 0,
      forwardAvgMs: forwards ? +(s.forwardLatencyMs / forwards).toFixed(1) : 0,
    };
  }

  // `limit` bounds the ranked lists sent to the dashboard; 500 is high enough
  // to be "complete" for realistic traffic while protecting the live stream
  // from a pathological number of distinct domains/clients.
  getAnalytics({ now = Date.now(), trendMinutes = 60, bucketMinutes = 5, activeMinutes = 5, limit = 500 } = {}) {
    const bucketMs = bucketMinutes * 60 * 1000;
    const bucketCount = Math.ceil(trendMinutes / bucketMinutes);
    const windowEnd = (Math.floor(now / bucketMs) + 1) * bucketMs;
    const windowStart = windowEnd - bucketCount * bucketMs;
    const activeSince = now - activeMinutes * 60 * 1000;
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
      t: windowStart + index * bucketMs,
      total: 0,
      failures: 0,
      latencyMs: 0,
    }));
    const domains = new Map();
    const clients = new Map();
    let sampledQueries = 0;

    for (const entry of this.entries) {
      const timestamp = Number(entry.t);
      if (!Number.isFinite(timestamp) || timestamp > now) continue;

      if (timestamp >= windowStart) {
        const index = Math.min(bucketCount - 1, Math.floor((timestamp - windowStart) / bucketMs));
        const bucket = buckets[index];
        bucket.total++;
        bucket.latencyMs += entry.latencyMs || 0;
        if (entry.rcode !== 0) bucket.failures++;
        sampledQueries++;

        if (entry.domain) {
          const current = domains.get(entry.domain) || { domain: entry.domain, count: 0, failures: 0 };
          current.count++;
          if (entry.rcode !== 0) current.failures++;
          domains.set(entry.domain, current);
        }
      }

      if (timestamp >= activeSince && entry.client && entry.client !== 'web-ui') {
        const current = clients.get(entry.client) || {
          client: entry.client,
          count: 0,
          failures: 0,
          lastSeen: 0,
        };
        current.count++;
        if (entry.rcode !== 0) current.failures++;
        current.lastSeen = Math.max(current.lastSeen, timestamp);
        clients.set(entry.client, current);
      }
    }

    const topDomains = [...domains.values()]
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
      .slice(0, limit);
    const activeClients = [...clients.values()]
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.client.localeCompare(b.client))
      .slice(0, limit);

    return {
      trend: {
        windowMinutes: bucketCount * bucketMinutes,
        bucketMinutes,
        buckets: buckets.map(bucket => ({
          t: bucket.t,
          total: bucket.total,
          failures: bucket.failures,
          avgLatencyMs: bucket.total ? +(bucket.latencyMs / bucket.total).toFixed(1) : 0,
        })),
      },
      topDomains,
      activeClients,
      topDomainCount: domains.size,
      activeClientCount: clients.size,
      activeMinutes,
      sampledQueries,
      retainedQueries: this.entries.length,
    };
  }

  reset() {
    this.entries = [];
    this.stats = this.resetStats();
  }
}

module.exports = { LogStore, HARD_CAP };

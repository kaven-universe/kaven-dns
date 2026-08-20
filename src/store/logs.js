'use strict';

/**
 * Query log (ring buffer, drops oldest when full) + aggregate stats.
 * Logs are kept in memory only and reset on restart.
 */
class LogStore {
  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.entries = [];
    this.stats = this.resetStats();
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

  setCapacity(n) {
    this.capacity = n;
    if (this.entries.length > n) this.entries.splice(0, this.entries.length - n);
  }

  record(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity);

    const s = this.stats;
    s.total++;
    if (entry.source === 'fixed') s.fixed++;
    else if (entry.source === 'cache') s.cache++;
    else if (entry.source === 'forward') s.forward++;
    if (entry.rcode === 2) s.servfail++;
    if (entry.rcode === 3) s.nxdomain++;
    s.totalLatencyMs += entry.latencyMs || 0;
    // Latency of queries that actually hit an upstream (cache hits say
    // nothing about upstream quality)
    if (entry.source === 'forward') s.forwardLatencyMs += entry.latencyMs || 0;
  }

  list({ limit = 200, domain = '', source = '' } = {}) {
    const d = domain.trim().toLowerCase();
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (d && !e.domain.includes(d)) continue;
      if (source && e.source !== source) continue;
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

  reset() {
    this.entries = [];
    this.stats = this.resetStats();
  }
}

module.exports = { LogStore };

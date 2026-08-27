'use strict';

const os = require('os');
const { atomicWriteJson } = require('../config');

/**
 * Query log (ring buffer, drops oldest when full) + aggregate stats.
 * Held in memory during normal operation - record() never touches disk, so
 * there is no per-query I/O cost. When constructed with a file path, a
 * snapshot (entries + stats + sequence) is restored on startup and saved
 * once on a clean shutdown (see index.js), so a normal exit/restart keeps
 * prior history; an unclean termination (crash, kill -9) still loses
 * whatever wasn't saved at the last clean shutdown.
 * There is no fixed entry-count ceiling by default (capacity is Infinity) -
 * entries are dropped only by age (retentionDays) and by actual memory
 * pressure (see enforceMemoryBound()), so the log can grow as large as
 * available memory allows. `capacity` still exists as an explicit,
 * optional ring-buffer bound for callers/tests that want one.
 */

// Memory-based trimming thresholds, checked periodically (see
// enforceMemoryBound()), not per-query. Two independent signals so this
// works both outside a container (where free host memory is meaningful)
// and inside one with a cgroup memory limit (where os.freemem()/totalmem()
// report the HOST's memory, not the container's, so are blind to that
// limit - this process's own RSS is bounded by the cgroup limit regardless
// of what os.* reports, so it's checked too).
const MIN_FREE_MEM_RATIO = 0.1; // keep >=10% of (host-reported) total memory free
const MAX_PROCESS_RSS_BYTES = 512 * 1024 * 1024; // 512MB ceiling on this process's own footprint
const MEMORY_TRIM_FRACTION = 0.1; // drop the oldest 10% of entries per check when over a threshold

function defaultMemoryStats() {
  return { freeRatio: os.freemem() / os.totalmem(), rss: process.memoryUsage().rss };
}

class LogStore {
  constructor(capacity = Infinity, retentionDays = 0, clock = Date.now, file = null, memoryStats = defaultMemoryStats) {
    this.capacity = capacity;
    this.retentionMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 0;
    this.clock = clock;
    this.file = file;
    this.memoryStats = memoryStats;
    this.entries = [];
    this.stats = this.resetStats();
    this.sequence = 0;
    this.listeners = new Set();
    if (file) this.load();
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

  // Restores a snapshot written by persist() on a previous clean shutdown.
  // Missing file (fresh install) or unreadable/corrupt content just starts
  // empty - a bad snapshot must never block startup.
  load() {
    try {
      const raw = JSON.parse(require('fs').readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw.entries)) this.entries = raw.entries;
      if (raw.stats && typeof raw.stats === 'object') this.stats = { ...this.resetStats(), ...raw.stats };
      this.sequence = Number.isInteger(raw.sequence)
        ? raw.sequence
        : this.entries.reduce((max, e) => Math.max(max, e.seq || 0), 0);
      // Re-apply the current capacity/retention in case they were lowered,
      // or a lot of real time passed, since the snapshot was written.
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
      this.trimExpired();
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[logs] Failed to read ${this.file}: ${e.message}`);
    }
  }

  // Called once, only on a clean shutdown (index.js) - never from record(),
  // so normal operation pays no ongoing disk-I/O cost.
  persist() {
    if (!this.file) return;
    atomicWriteJson(this.file, { entries: this.entries, stats: this.stats, sequence: this.sequence });
  }

  // Entries are appended in order, so expired ones are always a prefix.
  trimExpired() {
    if (!this.retentionMs) return;
    const cutoff = this.clock() - this.retentionMs;
    let i = 0;
    while (i < this.entries.length && this.entries[i].t < cutoff) i++;
    if (i > 0) this.entries.splice(0, i);
  }

  // Called periodically (see index.js), not per-query - checking memory
  // usage has a small but non-zero cost. Drops the oldest ~10% of entries
  // when the system is low on free memory OR this process's own footprint
  // has grown large, whichever fires first; a no-op otherwise, regardless
  // of retentionDays/capacity. With no fixed entry-count ceiling, this is
  // the only thing bounding real-world growth in practice.
  enforceMemoryBound() {
    if (this.entries.length < 2) return;
    const { freeRatio, rss } = this.memoryStats();
    if (freeRatio >= MIN_FREE_MEM_RATIO && rss < MAX_PROCESS_RSS_BYTES) return;
    const drop = Math.max(1, Math.ceil(this.entries.length * MEMORY_TRIM_FRACTION));
    this.entries.splice(0, Math.min(drop, this.entries.length));
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

module.exports = { LogStore };

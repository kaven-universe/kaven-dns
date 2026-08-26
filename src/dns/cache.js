'use strict';

/**
 * DNS answer cache: Map-based LRU (re-insert on hit to refresh order) + TTL expiry.
 * Entries hold the rcode and the three resource sections of a forwarded answer.
 * On a hit, each record's TTL is rewritten to the remaining seconds, which
 * matches proper DNS caching semantics.
 */
class DnsCache {
  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    // LRU: delete and re-insert to move the entry to the most recent position
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    const remaining = Math.max(1, Math.round((entry.expiresAt - Date.now()) / 1000));
    return {
      rcode: entry.rcode,
      answers: entry.answers.map(a => ({ ...a, ttl: Math.min(a.ttl ?? remaining, remaining) })),
      authorities: entry.authorities.map(a => ({ ...a })),
      additionals: entry.additionals.map(a => ({ ...a })),
    };
  }

  set(key, data, ttlSeconds) {
    // Only evict for a genuinely new key; overwriting an existing one (e.g.
    // two concurrent misses for the same query) does not grow the map.
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, {
      rcode: data.rcode,
      answers: data.answers.map(a => ({ ...a })),
      authorities: (data.authorities || []).map(a => ({ ...a })),
      additionals: (data.additionals || []).map(a => ({ ...a })),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  flush() {
    const flushed = this.map.size;
    this.map.clear();
    return flushed;
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(key);
    }
  }

  setMaxEntries(n) {
    this.maxEntries = n;
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  info() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? +(this.hits / total * 100).toFixed(1) : 0,
    };
  }
}

module.exports = { DnsCache };

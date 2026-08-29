'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { QueryStore } = require('../src/store/queries');

const MINUTE = 60 * 1000;

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaven-dns-queries-'));
  return path.join(dir, 'queries.json');
}

function entry(t, domain, client, latencyMs = 10, rcode = 0) {
  return { t, domain, client, latencyMs, rcode, source: 'forward' };
}

test('builds trend buckets and ranks domains from the in-memory window', () => {
  const now = Date.UTC(2026, 7, 26, 12, 2);
  const queries = new QueryStore(20);
  queries.record(entry(now - 54 * MINUTE, 'old.example', '192.0.2.1', 50));
  queries.record(entry(now - 4 * MINUTE, 'popular.example', '192.0.2.2', 20));
  queries.record(entry(now - 3 * MINUTE, 'popular.example', '192.0.2.2', 40, 2));
  queries.record(entry(now - 2 * MINUTE, 'other.example', '192.0.2.3', 30));

  const analytics = queries.getAnalytics({ now });

  assert.equal(analytics.sampledQueries, 4);
  assert.equal(analytics.trend.buckets.length, 12);
  assert.deepEqual(analytics.trend.buckets.at(-2), {
    t: Date.UTC(2026, 7, 26, 11, 55),
    total: 2,
    failures: 1,
    avgLatencyMs: 30,
  });
  assert.deepEqual(analytics.trend.buckets.at(-1), {
    t: Date.UTC(2026, 7, 26, 12, 0),
    total: 1,
    failures: 0,
    avgLatencyMs: 30,
  });
  assert.deepEqual(analytics.topDomains.map(item => [item.domain, item.count]), [
    ['popular.example', 2],
    ['old.example', 1],
    ['other.example', 1],
  ]);
});

test('reports recent DNS clients and excludes Web console test queries', () => {
  const now = Date.UTC(2026, 7, 26, 12, 2);
  const queries = new QueryStore(20);
  queries.record(entry(now - 6 * MINUTE, 'expired.example', '192.0.2.1'));
  queries.record(entry(now - 4 * MINUTE, 'one.example', '192.0.2.2'));
  queries.record(entry(now - 3 * MINUTE, 'two.example', '192.0.2.3'));
  queries.record(entry(now - 2 * MINUTE, 'one.example', '192.0.2.2', 10, 3));
  queries.record(entry(now - MINUTE, 'manual.example', 'web-ui'));

  const analytics = queries.getAnalytics({ now });

  assert.equal(analytics.activeClientCount, 2);
  assert.deepEqual(analytics.activeClients, [
    { client: '192.0.2.2', count: 2, failures: 1, lastSeen: now - 2 * MINUTE },
    { client: '192.0.2.3', count: 1, failures: 0, lastSeen: now - 3 * MINUTE },
  ]);
});

test('returns rankings beyond the old 6-item cap by default, with true distinct counts', () => {
  const now = Date.UTC(2026, 7, 26, 12, 2);
  const queries = new QueryStore(20);
  for (let i = 0; i < 8; i++) {
    queries.record(entry(now - MINUTE, `domain${i}.example`, `192.0.2.${i}`));
  }

  const analytics = queries.getAnalytics({ now });

  assert.equal(analytics.topDomains.length, 8);
  assert.equal(analytics.topDomainCount, 8);
  assert.equal(analytics.activeClients.length, 8);
  assert.equal(analytics.activeClientCount, 8);
});

test('still truncates rankings when an explicit limit is passed, keeping true counts', () => {
  const now = Date.UTC(2026, 7, 26, 12, 2);
  const queries = new QueryStore(20);
  for (let i = 0; i < 8; i++) {
    queries.record(entry(now - MINUTE, `domain${i}.example`, `192.0.2.${i}`));
  }

  const analytics = queries.getAnalytics({ now, limit: 2 });

  assert.equal(analytics.topDomains.length, 2);
  assert.equal(analytics.topDomainCount, 8);
  assert.equal(analytics.activeClients.length, 2);
  assert.equal(analytics.activeClientCount, 8);
});

test('publishes sequenced entries after updating aggregate stats', () => {
  const queries = new QueryStore(20);
  const published = [];
  queries.subscribe(() => { throw new Error('observer failure'); });
  const unsubscribe = queries.subscribe(item => {
    published.push({ item, total: queries.getStats().total });
  });

  const first = queries.record(entry(Date.now(), 'one.example', '192.0.2.1'));
  unsubscribe();
  queries.record(entry(Date.now(), 'two.example', '192.0.2.1'));

  assert.equal(first.seq, 1);
  assert.deepEqual(published, [{ item: first, total: 1 }]);
  assert.deepEqual(queries.list().map(item => item.seq), [2, 1]);
});

test('list() filters by domain, source, status, type, client and rule/upstream independently and combined', () => {
  const queries = new QueryStore(20);
  queries.record({ t: 1, domain: 'ok.example', client: '192.0.2.1', type: 'A', latencyMs: 5, rcode: 0, source: 'fixed', rule: 'ok.example A', upstream: '' });
  queries.record({ t: 2, domain: 'ok.example', client: '192.0.2.1', type: 'AAAA', latencyMs: 5, rcode: 2, source: 'forward', rule: '', upstream: '8.8.8.8' });
  queries.record({ t: 3, domain: 'other.example', client: '192.0.2.2', type: 'A', latencyMs: 5, rcode: 0, source: 'cache', rule: '', upstream: '8.8.8.8' });

  assert.deepEqual(queries.list({ domain: 'ok' }).map(e => e.t), [2, 1]);
  assert.deepEqual(queries.list({ source: 'cache' }).map(e => e.t), [3]);
  assert.deepEqual(queries.list({ status: 'ok' }).map(e => e.t), [3, 1]);
  assert.deepEqual(queries.list({ status: 'fail' }).map(e => e.t), [2]);
  assert.deepEqual(queries.list({ domain: 'ok', status: 'fail' }).map(e => e.t), [2]);
  assert.deepEqual(queries.list({ type: 'AAAA' }).map(e => e.t), [2]);
  assert.deepEqual(queries.list({ client: '192.0.2.2' }).map(e => e.t), [3]);
  assert.deepEqual(queries.list({ type: 'A', client: '192.0.2.1' }).map(e => e.t), [1]);
  assert.deepEqual(queries.list({ rule: 'ok.example A' }).map(e => e.t), [1]);
  assert.deepEqual(queries.list({ rule: '8.8.8.8' }).map(e => e.t), [3, 2]);
});

test('list() filters by a since/until time range, independently and combined with other filters', () => {
  const queries = new QueryStore(20);
  queries.record({ t: 100, domain: 'a.example', client: '192.0.2.1', type: 'A', latencyMs: 5, rcode: 0, source: 'fixed' });
  queries.record({ t: 200, domain: 'b.example', client: '192.0.2.1', type: 'A', latencyMs: 5, rcode: 2, source: 'forward' });
  queries.record({ t: 300, domain: 'c.example', client: '192.0.2.2', type: 'A', latencyMs: 5, rcode: 0, source: 'cache' });

  assert.deepEqual(queries.list({ since: 150 }).map(e => e.t), [300, 200]);
  assert.deepEqual(queries.list({ until: 250 }).map(e => e.t), [200, 100]);
  assert.deepEqual(queries.list({ since: 150, until: 250 }).map(e => e.t), [200]);
  assert.deepEqual(queries.list({ since: 100, until: 300 }).map(e => e.t), [300, 200, 100]);
  assert.deepEqual(queries.list({ since: 150, status: 'fail' }).map(e => e.t), [200]);
  assert.deepEqual(queries.list({ since: 1000 }).map(e => e.t), []);
});

test('retentionDays trims entries older than the window on record(), independent of capacity', () => {
  const DAY = 24 * 60 * MINUTE;
  let now = Date.UTC(2026, 0, 1);
  const queries = new QueryStore(100, 2, () => now); // capacity=100, keep 2 days
  queries.record(entry(now, 'old.example', '192.0.2.1'));
  now += DAY;
  queries.record(entry(now, 'mid.example', '192.0.2.2'));
  now += 1.5 * DAY; // old.example is now 2.5 days old (> 2-day retention)
  queries.record(entry(now, 'new.example', '192.0.2.3'));

  assert.deepEqual(queries.list({ limit: 10 }).map(e => e.domain).sort(), ['mid.example', 'new.example']);
});

test('setRetentionDays(0) disables time-based trimming, keeping capacity as the only bound', () => {
  const DAY = 24 * 60 * MINUTE;
  let now = Date.UTC(2026, 0, 1);
  const queries = new QueryStore(100, 2, () => now);
  queries.record(entry(now, 'old.example', '192.0.2.1'));
  queries.setRetentionDays(0);
  now += 30 * DAY;
  queries.record(entry(now, 'new.example', '192.0.2.2'));

  assert.deepEqual(queries.list({ limit: 10 }).map(e => e.domain).sort(), ['new.example', 'old.example']);
});

test('persist()/load() round-trip entries, stats and sequence across separate QueryStore instances', () => {
  const file = tempFile();
  const store1 = new QueryStore(100, 0, Date.now, file);
  store1.record(entry(1000, 'one.example', '192.0.2.1'));
  store1.record(entry(2000, 'two.example', '192.0.2.2', 10, 2));
  store1.persist();

  const store2 = new QueryStore(100, 0, Date.now, file);
  assert.deepEqual(store2.list().map(e => e.domain).sort(), ['one.example', 'two.example']);
  assert.equal(store2.getStats().total, 2);
  assert.equal(store2.getStats().servfail, 1);

  // A newly recorded entry must not collide with a restored seq number.
  const restored = store2.record(entry(3000, 'three.example', '192.0.2.3'));
  assert.equal(restored.seq, 3);
});

test('reset clears entries and stats, persists immediately, and keeps sequence monotonic', () => {
  const file = tempFile();
  const queries = new QueryStore(100, 0, Date.now, file);
  queries.record(entry(1000, 'one.example', '192.0.2.1'));
  queries.record(entry(2000, 'two.example', '192.0.2.2'));

  assert.equal(queries.reset(), 2);
  assert.deepEqual(queries.list(), []);
  assert.equal(queries.getStats().total, 0);

  const restored = new QueryStore(100, 0, Date.now, file);
  assert.deepEqual(restored.list(), []);
  assert.equal(restored.getStats().total, 0);
  assert.equal(restored.record(entry(3000, 'three.example', '192.0.2.3')).seq, 3);
});

test('reset restores the in-memory history when persistence fails', () => {
  const queries = new QueryStore(100);
  queries.record(entry(1000, 'one.example', '192.0.2.1'));
  queries.persist = () => { throw new Error('disk full'); };

  assert.throws(() => queries.reset(), /disk full/);
  assert.deepEqual(queries.list().map(item => item.domain), ['one.example']);
  assert.equal(queries.getStats().total, 1);
});

test('persist() is a no-op without a file, and load() tolerates a missing snapshot', () => {
  const noFile = new QueryStore(10);
  noFile.record(entry(1, 'a.example', '192.0.2.1'));
  assert.doesNotThrow(() => noFile.persist());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaven-dns-queries-'));
  const missing = path.join(dir, 'does-not-exist.json');
  assert.doesNotThrow(() => new QueryStore(10, 0, Date.now, missing));
});

test('load() re-applies the current capacity and retention window to a restored snapshot', () => {
  const DAY = 24 * 60 * MINUTE;
  const now = Date.UTC(2026, 0, 10);
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({
    entries: [
      entry(now - 10 * DAY, 'ancient.example', '192.0.2.1'),
      { ...entry(now - MINUTE, 'recent.example', '192.0.2.2'), seq: 5 },
    ],
    stats: { startedAt: now - 10 * DAY, total: 2, fixed: 0, cache: 0, forward: 2, servfail: 0, nxdomain: 0, totalLatencyMs: 20, forwardLatencyMs: 20 },
    sequence: 5,
  }));

  const queries = new QueryStore(100, 2, () => now, file); // 2-day retention
  assert.deepEqual(queries.list().map(e => e.domain), ['recent.example']);
  const next = queries.record(entry(now, 'new.example', '192.0.2.3'));
  assert.equal(next.seq, 6);
});

test('enforceMemoryBound() is a no-op when memory looks fine, regardless of retentionDays', () => {
  const queries = new QueryStore(1000, 0, Date.now, null, () => ({ freeRatio: 0.9, rss: 1000 }));
  for (let i = 0; i < 10; i++) queries.record(entry(i, `d${i}.example`, '192.0.2.1'));
  queries.enforceMemoryBound();
  assert.equal(queries.list({ limit: 100 }).length, 10);
});

test('enforceMemoryBound() trims the oldest ~10% of entries when free memory is low', () => {
  const queries = new QueryStore(1000, 0, Date.now, null, () => ({ freeRatio: 0.01, rss: 1000 }));
  for (let i = 0; i < 20; i++) queries.record(entry(i, `d${i}.example`, '192.0.2.1'));
  queries.enforceMemoryBound();
  const remaining = queries.list({ limit: 100 }).map(e => e.t).sort((a, b) => a - b);
  assert.equal(remaining.length, 18); // dropped the 2 oldest (10% of 20)
  assert.deepEqual(remaining.slice(0, 2), [2, 3]);
});

test('enforceMemoryBound() also trims when this process\'s own RSS looks large, even with free host memory', () => {
  const queries = new QueryStore(1000, 0, Date.now, null, () => ({ freeRatio: 0.9, rss: 999 * 1024 * 1024 * 1024 }));
  for (let i = 0; i < 10; i++) queries.record(entry(i, `d${i}.example`, '192.0.2.1'));
  queries.enforceMemoryBound();
  assert.equal(queries.list({ limit: 100 }).length, 9);
});

test('enforceMemoryBound() and retentionDays>0 both apply independently', () => {
  const DAY = 24 * 60 * MINUTE;
  let now = Date.UTC(2026, 0, 1);
  const queries = new QueryStore(1000, 2, () => now, null, () => ({ freeRatio: 0.01, rss: 1000 }));
  queries.record(entry(now, 'old.example', '192.0.2.1'));
  now += DAY;
  for (let i = 0; i < 9; i++) queries.record(entry(now, `mid${i}.example`, '192.0.2.2'));
  now += 1.5 * DAY; // old.example ages out (> 2-day retention) via trimExpired() on the next record()
  queries.record(entry(now, 'new.example', '192.0.2.3'));
  assert.ok(!queries.list({ limit: 100 }).some(e => e.domain === 'old.example'));
  queries.enforceMemoryBound(); // additionally drops the oldest ~10% for low memory
  assert.equal(queries.list({ limit: 100 }).length, 9);
});
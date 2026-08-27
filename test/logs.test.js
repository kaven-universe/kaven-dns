'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LogStore } = require('../src/store/logs');

const MINUTE = 60 * 1000;

function entry(t, domain, client, latencyMs = 10, rcode = 0) {
  return { t, domain, client, latencyMs, rcode, source: 'forward' };
}

test('builds trend buckets and ranks domains from the in-memory window', () => {
  const now = Date.UTC(2026, 7, 26, 12, 2);
  const logs = new LogStore(20);
  logs.record(entry(now - 54 * MINUTE, 'old.example', '192.0.2.1', 50));
  logs.record(entry(now - 4 * MINUTE, 'popular.example', '192.0.2.2', 20));
  logs.record(entry(now - 3 * MINUTE, 'popular.example', '192.0.2.2', 40, 2));
  logs.record(entry(now - 2 * MINUTE, 'other.example', '192.0.2.3', 30));

  const analytics = logs.getAnalytics({ now });

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
  const logs = new LogStore(20);
  logs.record(entry(now - 6 * MINUTE, 'expired.example', '192.0.2.1'));
  logs.record(entry(now - 4 * MINUTE, 'one.example', '192.0.2.2'));
  logs.record(entry(now - 3 * MINUTE, 'two.example', '192.0.2.3'));
  logs.record(entry(now - 2 * MINUTE, 'one.example', '192.0.2.2', 10, 3));
  logs.record(entry(now - MINUTE, 'manual.example', 'web-ui'));

  const analytics = logs.getAnalytics({ now });

  assert.equal(analytics.activeClientCount, 2);
  assert.deepEqual(analytics.activeClients, [
    { client: '192.0.2.2', count: 2, failures: 1, lastSeen: now - 2 * MINUTE },
    { client: '192.0.2.3', count: 1, failures: 0, lastSeen: now - 3 * MINUTE },
  ]);
});

test('returns rankings beyond the old 6-item cap by default, with true distinct counts', () => {
  const now = Date.UTC(2026, 7, 26, 12, 2);
  const logs = new LogStore(20);
  for (let i = 0; i < 8; i++) {
    logs.record(entry(now - MINUTE, `domain${i}.example`, `192.0.2.${i}`));
  }

  const analytics = logs.getAnalytics({ now });

  assert.equal(analytics.topDomains.length, 8);
  assert.equal(analytics.topDomainCount, 8);
  assert.equal(analytics.activeClients.length, 8);
  assert.equal(analytics.activeClientCount, 8);
});

test('still truncates rankings when an explicit limit is passed, keeping true counts', () => {
  const now = Date.UTC(2026, 7, 26, 12, 2);
  const logs = new LogStore(20);
  for (let i = 0; i < 8; i++) {
    logs.record(entry(now - MINUTE, `domain${i}.example`, `192.0.2.${i}`));
  }

  const analytics = logs.getAnalytics({ now, limit: 2 });

  assert.equal(analytics.topDomains.length, 2);
  assert.equal(analytics.topDomainCount, 8);
  assert.equal(analytics.activeClients.length, 2);
  assert.equal(analytics.activeClientCount, 8);
});

test('publishes sequenced entries after updating aggregate stats', () => {
  const logs = new LogStore(20);
  const published = [];
  logs.subscribe(() => { throw new Error('observer failure'); });
  const unsubscribe = logs.subscribe(item => {
    published.push({ item, total: logs.getStats().total });
  });

  const first = logs.record(entry(Date.now(), 'one.example', '192.0.2.1'));
  unsubscribe();
  logs.record(entry(Date.now(), 'two.example', '192.0.2.1'));

  assert.equal(first.seq, 1);
  assert.deepEqual(published, [{ item: first, total: 1 }]);
  assert.deepEqual(logs.list().map(item => item.seq), [2, 1]);
});

test('list() filters by domain, source, status, type, client and rule/upstream independently and combined', () => {
  const logs = new LogStore(20);
  logs.record({ t: 1, domain: 'ok.example', client: '192.0.2.1', type: 'A', latencyMs: 5, rcode: 0, source: 'fixed', rule: 'ok.example A', upstream: '' });
  logs.record({ t: 2, domain: 'ok.example', client: '192.0.2.1', type: 'AAAA', latencyMs: 5, rcode: 2, source: 'forward', rule: '', upstream: '8.8.8.8' });
  logs.record({ t: 3, domain: 'other.example', client: '192.0.2.2', type: 'A', latencyMs: 5, rcode: 0, source: 'cache', rule: '', upstream: '8.8.8.8' });

  assert.deepEqual(logs.list({ domain: 'ok' }).map(e => e.t), [2, 1]);
  assert.deepEqual(logs.list({ source: 'cache' }).map(e => e.t), [3]);
  assert.deepEqual(logs.list({ status: 'ok' }).map(e => e.t), [3, 1]);
  assert.deepEqual(logs.list({ status: 'fail' }).map(e => e.t), [2]);
  assert.deepEqual(logs.list({ domain: 'ok', status: 'fail' }).map(e => e.t), [2]);
  assert.deepEqual(logs.list({ type: 'AAAA' }).map(e => e.t), [2]);
  assert.deepEqual(logs.list({ client: '192.0.2.2' }).map(e => e.t), [3]);
  assert.deepEqual(logs.list({ type: 'A', client: '192.0.2.1' }).map(e => e.t), [1]);
  assert.deepEqual(logs.list({ rule: 'ok.example A' }).map(e => e.t), [1]);
  assert.deepEqual(logs.list({ rule: '8.8.8.8' }).map(e => e.t), [3, 2]);
});

test('list() filters by a since/until time range, independently and combined with other filters', () => {
  const logs = new LogStore(20);
  logs.record({ t: 100, domain: 'a.example', client: '192.0.2.1', type: 'A', latencyMs: 5, rcode: 0, source: 'fixed' });
  logs.record({ t: 200, domain: 'b.example', client: '192.0.2.1', type: 'A', latencyMs: 5, rcode: 2, source: 'forward' });
  logs.record({ t: 300, domain: 'c.example', client: '192.0.2.2', type: 'A', latencyMs: 5, rcode: 0, source: 'cache' });

  assert.deepEqual(logs.list({ since: 150 }).map(e => e.t), [300, 200]);
  assert.deepEqual(logs.list({ until: 250 }).map(e => e.t), [200, 100]);
  assert.deepEqual(logs.list({ since: 150, until: 250 }).map(e => e.t), [200]);
  assert.deepEqual(logs.list({ since: 100, until: 300 }).map(e => e.t), [300, 200, 100]);
  assert.deepEqual(logs.list({ since: 150, status: 'fail' }).map(e => e.t), [200]);
  assert.deepEqual(logs.list({ since: 1000 }).map(e => e.t), []);
});

test('retentionDays trims entries older than the window on record(), independent of capacity', () => {
  const DAY = 24 * 60 * MINUTE;
  let now = Date.UTC(2026, 0, 1);
  const logs = new LogStore(100, 2, () => now); // capacity=100, keep 2 days
  logs.record(entry(now, 'old.example', '192.0.2.1'));
  now += DAY;
  logs.record(entry(now, 'mid.example', '192.0.2.2'));
  now += 1.5 * DAY; // old.example is now 2.5 days old (> 2-day retention)
  logs.record(entry(now, 'new.example', '192.0.2.3'));

  assert.deepEqual(logs.list({ limit: 10 }).map(e => e.domain).sort(), ['mid.example', 'new.example']);
});

test('setRetentionDays(0) disables time-based trimming, keeping capacity as the only bound', () => {
  const DAY = 24 * 60 * MINUTE;
  let now = Date.UTC(2026, 0, 1);
  const logs = new LogStore(100, 2, () => now);
  logs.record(entry(now, 'old.example', '192.0.2.1'));
  logs.setRetentionDays(0);
  now += 30 * DAY;
  logs.record(entry(now, 'new.example', '192.0.2.2'));

  assert.deepEqual(logs.list({ limit: 10 }).map(e => e.domain).sort(), ['new.example', 'old.example']);
});
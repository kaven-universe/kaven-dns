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
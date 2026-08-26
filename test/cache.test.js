'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DnsCache } = require('../src/dns/cache');

function answer(address, ttl = 60) {
  return { rcode: 0, answers: [{ name: 'x.test', type: 1, class: 1, ttl, address }], authorities: [], additionals: [] };
}

test('returns a cached answer before it expires, with a decremented per-record TTL', () => {
  const cache = new DnsCache(10);
  cache.set('k', answer('1.2.3.4', 60), 60);
  const hit = cache.get('k');
  assert.equal(hit.rcode, 0);
  assert.equal(hit.answers[0].address, '1.2.3.4');
  assert.ok(hit.answers[0].ttl > 0 && hit.answers[0].ttl <= 60);
});

test('treats a zero-second TTL as already expired', () => {
  const cache = new DnsCache(10);
  cache.set('k', answer('1.2.3.4'), 0);
  assert.equal(cache.get('k'), null);
});

test('tracks hits, misses and hit rate', () => {
  const cache = new DnsCache(10);
  cache.set('k', answer('1.2.3.4'), 60);
  cache.get('k'); // hit
  cache.get('missing'); // miss
  const info = cache.info();
  assert.equal(info.hits, 1);
  assert.equal(info.misses, 1);
  assert.equal(info.hitRate, 50);
});

test('evicts the least-recently-used entry once at capacity, refreshing on read', () => {
  const cache = new DnsCache(2);
  cache.set('a', answer('1.1.1.1'), 60);
  cache.set('b', answer('2.2.2.2'), 60);
  cache.get('a'); // touch 'a', so 'b' becomes the oldest
  cache.set('c', answer('3.3.3.3'), 60);
  assert.equal(cache.get('b'), null);
  assert.ok(cache.get('a'));
  assert.ok(cache.get('c'));
});

test('does not evict a valid entry when set() overwrites an existing key at capacity', () => {
  const cache = new DnsCache(2);
  cache.set('a', answer('1.1.1.1'), 60);
  cache.set('b', answer('2.2.2.2'), 60);
  cache.set('b', answer('9.9.9.9'), 60); // overwrite, not growth
  assert.equal(cache.info().size, 2);
  assert.equal(cache.get('a').answers[0].address, '1.1.1.1');
  assert.equal(cache.get('b').answers[0].address, '9.9.9.9');
});

test('sweep() drops only expired entries', () => {
  const cache = new DnsCache(10);
  cache.set('expired', answer('1.1.1.1'), 0);
  cache.set('fresh', answer('2.2.2.2'), 60);
  cache.sweep();
  assert.equal(cache.info().size, 1);
});

test('setMaxEntries() shrinks the cache immediately, keeping the most recent entries', () => {
  const cache = new DnsCache(10);
  cache.set('a', answer('1.1.1.1'), 60);
  cache.set('b', answer('2.2.2.2'), 60);
  cache.set('c', answer('3.3.3.3'), 60);
  cache.setMaxEntries(1);
  assert.equal(cache.info().size, 1);
  assert.ok(cache.get('c'));
});

test('flush() clears all entries and reports how many were removed', () => {
  const cache = new DnsCache(10);
  cache.set('a', answer('1.1.1.1'), 60);
  cache.set('b', answer('2.2.2.2'), 60);
  assert.equal(cache.flush(), 2);
  assert.equal(cache.info().size, 0);
});

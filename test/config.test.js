'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitize, hashPassword, atomicWriteJson } = require('../src/config');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaven-dns-test-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('hashPassword is deterministic and distinguishes different inputs', () => {
  const a = hashPassword('correct horse');
  const b = hashPassword('correct horse');
  const c = hashPassword('battery staple');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('sanitize falls back to defaults for invalid ports, addresses and upstreams', () => {
  const config = sanitize({
    upstreams: ['example.com', '8.8.8.8', '1.1.1.1:53'],
    dnsPort: 999999,
    webPort: 0,
    bindAddress: 'not-an-address',
    webBindAddress: '10.0.0.5',
    forwardTimeoutMs: 1,
    cacheMaxEntries: -5,
    ttlMin: 5,
    ttlMax: 2,
    logCapacity: 50,
    sessionTtlHours: 0,
    passwordHash: 12345,
  });

  assert.deepEqual(config.upstreams, ['8.8.8.8', '1.1.1.1:53']);
  assert.equal(config.dnsPort, 53);
  assert.equal(config.webPort, 8080);
  assert.equal(config.bindAddress, '0.0.0.0');
  assert.equal(config.webBindAddress, '10.0.0.5');
  assert.equal(config.forwardTimeoutMs, 3000);
  assert.equal(config.cacheMaxEntries, 10000);
  assert.equal(config.ttlMin, 5);
  // ttlMax below the (already-clamped) ttlMin fails the range check and
  // resets to the default rather than clamping up to ttlMin.
  assert.equal(config.ttlMax, 3600);
  assert.equal(config.logCapacity, 1000);
  assert.equal(config.sessionTtlHours, 24);
  assert.equal(config.passwordHash, '12345');
});

test('sanitize keeps valid values unchanged', () => {
  const config = sanitize({
    upstreams: ['9.9.9.9', '2001:4860:4860::8888'],
    dnsPort: 5353,
    webPort: 8081,
    bindAddress: '127.0.0.1',
    webBindAddress: '::1',
    forwardTimeoutMs: 2000,
    cacheMaxEntries: 500,
    ttlMin: 20,
    ttlMax: 300,
    logCapacity: 2000,
    sessionTtlHours: 48,
    passwordHash: 'abc',
  });

  assert.deepEqual(config.upstreams, ['9.9.9.9', '2001:4860:4860::8888']);
  assert.equal(config.dnsPort, 5353);
  assert.equal(config.webPort, 8081);
  assert.equal(config.bindAddress, '127.0.0.1');
  assert.equal(config.webBindAddress, '::1');
  assert.equal(config.forwardTimeoutMs, 2000);
  assert.equal(config.cacheMaxEntries, 500);
  assert.equal(config.ttlMin, 20);
  assert.equal(config.ttlMax, 300);
  assert.equal(config.logCapacity, 2000);
  assert.equal(config.sessionTtlHours, 48);
});

test('sanitize resets an empty upstream list to the built-in defaults', () => {
  const config = sanitize({ upstreams: ['example.com', ''] });
  assert.deepEqual(config.upstreams, ['223.5.5.5', '119.29.29.29', '114.114.114.114']);
});

test('sanitize accepts dotted-quad-shaped strings even with out-of-range octets', () => {
  // The upstream regex only checks the \d+.\d+.\d+.\d+ shape, not that each
  // octet is 0-255, so this is kept as-is rather than filtered out.
  const config = sanitize({ upstreams: ['256.256.256.256'] });
  assert.deepEqual(config.upstreams, ['256.256.256.256']);
});

test('sanitize\'s loose IPv6-style check accepts hex-only words that are not addresses', () => {
  // The fallback pattern is just /^[0-9a-fA-F:]+$/, so any word made only of
  // a-f letters (no colon required) also passes.
  const config = sanitize({ upstreams: ['bad', 'cafe'] });
  assert.deepEqual(config.upstreams, ['bad', 'cafe']);
});

test('atomicWriteJson writes readable JSON and survives overwriting an existing file', () =>
  withTempDir(dir => {
    const file = path.join(dir, 'config.json');
    atomicWriteJson(file, { a: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });

    atomicWriteJson(file, { a: 2, b: [1, 2, 3] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2, b: [1, 2, 3] });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  }));

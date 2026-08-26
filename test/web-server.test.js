'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { heldByOwnDnsListener } = require('../src/web/server');

test('recognizes the exact endpoint held by the DNS server', () => {
  const status = { listening: true, address: '127.0.0.1', port: 53 };
  assert.equal(heldByOwnDnsListener(status, '127.0.0.1', 53), true);
});

test('recognizes IPv4 addresses covered by its wildcard listener', () => {
  const status = { listening: true, address: '0.0.0.0', port: 53 };
  assert.equal(heldByOwnDnsListener(status, '0.0.0.0', 53), true);
  assert.equal(heldByOwnDnsListener(status, '127.0.0.1', 53), true);
  assert.equal(heldByOwnDnsListener(status, '192.0.2.10', 53), true);
});

test('recognizes any address covered by an IPv6 wildcard listener', () => {
  const status = { listening: true, address: '::', port: 53 };
  assert.equal(heldByOwnDnsListener(status, '::', 53), true);
  assert.equal(heldByOwnDnsListener(status, '127.0.0.1', 53), true);
  assert.equal(heldByOwnDnsListener(status, '2001:db8::1', 53), true);
});

test('does not claim endpoints held by another listener', () => {
  assert.equal(heldByOwnDnsListener(null, '0.0.0.0', 53), false);
  assert.equal(heldByOwnDnsListener({ listening: false, address: '0.0.0.0', port: 53 }, '0.0.0.0', 53), false);
  assert.equal(heldByOwnDnsListener({ listening: true, address: '127.0.0.1', port: 53 }, '0.0.0.0', 53), false);
  assert.equal(heldByOwnDnsListener({ listening: true, address: '0.0.0.0', port: 5353 }, '0.0.0.0', 53), false);
});

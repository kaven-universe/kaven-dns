'use strict';

const net = require('net');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Packet, UDPClient, TCPClient } = require('dns2');

const { createDnsServers } = require('../src/dns/server');
const { LogStore } = require('../src/store/logs');

// dns2 needs the SAME port for its UDP and TCP stacks, unlike letting each
// bind an independent ephemeral port with `listen(0, ...)`; briefly bind a
// TCP socket to port 0 and reuse the OS-assigned port for both.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function fakeResolver(handler) {
  return { resolve: handler };
}

test('answers UDP and TCP queries and records a query log entry', async () => {
  const port = await getFreePort();
  const logs = new LogStore(20);
  const resolver = fakeResolver(async domain => ({
    rcode: Packet.RCODE.NOERROR,
    answers: [{ name: domain, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 30, address: '203.0.113.9' }],
    authorities: [],
    additionals: [],
    source: 'fixed',
    ruleLabel: 'test-rule',
  }));
  const dns = createDnsServers({ resolver, logs, port, address: '127.0.0.1' });
  await dns.start();
  try {
    const udpResponse = await UDPClient({ dns: '127.0.0.1', port, timeout: 2000 })('udp.test', 'A');
    assert.equal(udpResponse.header.rcode, Packet.RCODE.NOERROR);
    assert.equal(udpResponse.answers[0].address, '203.0.113.9');

    const tcpResponse = await TCPClient({ dns: '127.0.0.1', port })('tcp.test', 'A');
    assert.equal(tcpResponse.answers[0].address, '203.0.113.9');

    const entries = logs.list({ limit: 10 });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(e => e.domain).sort(), ['tcp.test', 'udp.test']);
    assert.equal(entries[0].rule, 'test-rule');
    // Regression: net.Socket (TCP) has its own .address() method, which is
    // truthy and previously won a naive `.address || .remoteAddress` check
    // over the real peer IP - silently storing a function that JSON.stringify
    // then drops the field for entirely. Both transports must log a real,
    // JSON-serializable client IP string.
    for (const entry of entries) {
      assert.equal(typeof entry.client, 'string');
      assert.ok(entry.client, `expected a non-empty client for ${entry.domain}`);
      assert.equal(JSON.parse(JSON.stringify(entry)).client, entry.client);
    }

    assert.deepEqual(dns.status(), { port, address: '127.0.0.1', listening: true, error: '' });
  } finally {
    dns.close();
  }
});

test('turns a resolver failure into SERVFAIL without crashing the listener', async () => {
  const port = await getFreePort();
  const logs = new LogStore(20);
  const resolver = fakeResolver(async () => { throw new Error('boom'); });
  const dns = createDnsServers({ resolver, logs, port, address: '127.0.0.1' });
  await dns.start();
  try {
    const response = await UDPClient({ dns: '127.0.0.1', port, timeout: 2000 })('broken.test', 'A');
    assert.equal(response.header.rcode, Packet.RCODE.SERVFAIL);
    const [entry] = logs.list({ limit: 1 });
    assert.equal(entry.rcode, Packet.RCODE.SERVFAIL);
    assert.equal(entry.error, 'boom');
  } finally {
    dns.close();
  }
});

test('restart() moves the listener to a new port', async () => {
  const portA = await getFreePort();
  const portB = await getFreePort();
  const logs = new LogStore(20);
  const resolver = fakeResolver(async domain => ({
    rcode: Packet.RCODE.NOERROR,
    answers: [{ name: domain, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 30, address: '198.51.100.1' }],
    authorities: [],
    additionals: [],
    source: 'fixed',
  }));
  const dns = createDnsServers({ resolver, logs, port: portA, address: '127.0.0.1' });
  await dns.start();
  try {
    await dns.restart(portB, '127.0.0.1');
    assert.deepEqual(dns.status(), { port: portB, address: '127.0.0.1', listening: true, error: '' });

    const response = await UDPClient({ dns: '127.0.0.1', port: portB, timeout: 2000 })('moved.test', 'A');
    assert.equal(response.answers[0].address, '198.51.100.1');
  } finally {
    dns.close();
  }
});

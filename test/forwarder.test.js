'use strict';

const dgram = require('dgram');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Packet, UDPServer } = require('dns2');

const { forwardQuery } = require('../src/dns/forwarder');

function startFakeUpstream(handler) {
  return new Promise((resolve, reject) => {
    const server = new UDPServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1').then(() => resolve(server));
  });
}

function respondWith(address) {
  return (request, send) => {
    const question = request.questions[0];
    const response = Packet.createResponseFromRequest(request);
    response.header.rcode = Packet.RCODE.NOERROR;
    response.answers = [{ name: question.name, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 30, address }];
    return send(response);
  };
}

// A UDP port that was briefly bound then released, so nothing answers there.
function getUnusedUdpPort() {
  return new Promise((resolve, reject) => {
    const probe = dgram.createSocket('udp4');
    probe.once('error', reject);
    probe.bind(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('races upstreams and returns the fastest successful response', async () => {
  const fast = await startFakeUpstream(respondWith('1.1.1.1'));
  const slow = await startFakeUpstream((request, send) => {
    setTimeout(() => {
      try {
        // The fast upstream has already answered by the time this fires, and
        // the test may have already closed this server; ignore either way.
        const result = respondWith('9.9.9.9')(request, send);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) { /* socket already closed */ }
    }, 150);
  });
  try {
    const fastAddr = `127.0.0.1:${fast.address().port}`;
    const slowAddr = `127.0.0.1:${slow.address().port}`;
    const { response, upstream } = await forwardQuery('race.test', Packet.TYPE.A, [slowAddr, fastAddr], 2000);
    assert.equal(upstream, fastAddr);
    assert.equal(response.answers[0].address, '1.1.1.1');
  } finally {
    fast.close();
    slow.close();
  }
});

test('rejects with an AggregateError when every upstream fails', async () => {
  const port = await getUnusedUdpPort();
  await assert.rejects(
    forwardQuery('fail.test', Packet.TYPE.A, [`127.0.0.1:${port}`], 400),
    err => {
      assert.ok(err instanceof AggregateError || Array.isArray(err.errors));
      return true;
    },
  );
});

test('returns null for a type dns2 does not support, without opening a socket', async () => {
  const result = await forwardQuery('whatever.test', 65280, ['127.0.0.1:1'], 100);
  assert.equal(result, null);
});

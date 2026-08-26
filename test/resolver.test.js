'use strict';

const dgram = require('dgram');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Packet, UDPServer } = require('dns2');

const { Resolver } = require('../src/dns/resolver');
const { DnsCache } = require('../src/dns/cache');

function ruleStore(rules) {
  return { getAll: () => rules };
}

function baseConfig(overrides = {}) {
  return { upstreams: ['198.51.100.53'], forwardTimeoutMs: 1000, ttlMin: 10, ttlMax: 3600, ...overrides };
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

function startFakeUpstream(handler) {
  return new Promise((resolve, reject) => {
    const server = new UDPServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1').then(() => resolve(server));
  });
}

test('returns a fixed A answer with multiple values without touching the network', async () => {
  const rules = [{ id: 'r1', domains: ['fixed.test'], type: 'A', mode: 'fixed', value: '10.0.0.1,10.0.0.2', ttl: 60, enabled: true }];
  const resolver = new Resolver({ rulesStore: ruleStore(rules), cache: new DnsCache(10), getConfig: () => baseConfig() });
  const result = await resolver.resolve('fixed.test', Packet.TYPE.A);
  assert.equal(result.source, 'fixed');
  assert.equal(result.rcode, Packet.RCODE.NOERROR);
  assert.deepEqual(result.answers.map(a => a.address), ['10.0.0.1', '10.0.0.2']);
  assert.equal(result.ruleLabel, 'fixed.test');
});

test('resolves a fixed CNAME target through another fixed rule', async () => {
  const rules = [
    { id: 'alias', domains: ['alias.test'], type: 'CNAME', mode: 'fixed', value: 'target.test', ttl: 60, enabled: true },
    { id: 'target', domains: ['target.test'], type: 'A', mode: 'fixed', value: '10.0.0.9', ttl: 30, enabled: true },
  ];
  const resolver = new Resolver({ rulesStore: ruleStore(rules), cache: new DnsCache(10), getConfig: () => baseConfig() });
  const result = await resolver.resolve('alias.test', Packet.TYPE.A);
  assert.equal(result.source, 'fixed');
  assert.equal(result.answers.length, 2);
  assert.equal(result.answers[0].type, Packet.TYPE.CNAME);
  assert.equal(result.answers[0].domain, 'target.test');
  assert.equal(result.answers[1].address, '10.0.0.9');
});

test('stops following a CNAME cycle instead of recursing forever', async () => {
  const rules = [
    { id: 'a', domains: ['loop-a.test'], type: 'CNAME', mode: 'fixed', value: 'loop-b.test', ttl: 60, enabled: true },
    { id: 'b', domains: ['loop-b.test'], type: 'CNAME', mode: 'fixed', value: 'loop-a.test', ttl: 60, enabled: true },
  ];
  const resolver = new Resolver({ rulesStore: ruleStore(rules), cache: new DnsCache(10), getConfig: () => baseConfig() });
  const result = await resolver.resolve('loop-a.test', Packet.TYPE.A);
  assert.equal(result.rcode, Packet.RCODE.NOERROR);
  assert.deepEqual(result.answers.map(a => a.domain), ['loop-b.test', 'loop-a.test', 'loop-b.test']);
});

test('serves a cached answer without any rule match or network call', async () => {
  const domain = 'cached.test';
  const typeNumber = Packet.TYPE.A;
  const upstreams = ['203.0.113.1'];
  const cache = new DnsCache(10);
  cache.set(`${domain}|${typeNumber}|${upstreams.join(',')}`, {
    rcode: Packet.RCODE.NOERROR,
    answers: [{ name: domain, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 30, address: '198.51.100.7' }],
    authorities: [],
    additionals: [],
  }, 30);
  const resolver = new Resolver({ rulesStore: ruleStore([]), cache, getConfig: () => baseConfig({ upstreams }) });
  const result = await resolver.resolve(domain, typeNumber);
  assert.equal(result.source, 'cache');
  assert.equal(result.answers[0].address, '198.51.100.7');
});

test('answers NOTIMP for a type dns2 does not support, without contacting an upstream', async () => {
  const resolver = new Resolver({ rulesStore: ruleStore([]), cache: new DnsCache(10), getConfig: () => baseConfig({ upstreams: ['127.0.0.1:1'] }) });
  const result = await resolver.resolve('whatever.test', 65280);
  assert.equal(result.rcode, Packet.RCODE.NOTIMP);
  assert.deepEqual(result.answers, []);
});

test('forwards to the upstream on a cache miss and caches the answer for the next query', async () => {
  const upstream = await startFakeUpstream((request, send) => {
    const question = request.questions[0];
    const response = Packet.createResponseFromRequest(request);
    response.header.rcode = Packet.RCODE.NOERROR;
    response.answers = [{ name: question.name, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 55, address: '93.184.216.34' }];
    send(response);
  });
  try {
    const port = upstream.address().port;
    const resolver = new Resolver({
      rulesStore: ruleStore([]),
      cache: new DnsCache(10),
      getConfig: () => baseConfig({ upstreams: [`127.0.0.1:${port}`] }),
    });
    const first = await resolver.resolve('forward.test', Packet.TYPE.A);
    assert.equal(first.source, 'forward');
    assert.equal(first.upstream, `127.0.0.1:${port}`);
    assert.equal(first.answers[0].address, '93.184.216.34');

    const second = await resolver.resolve('forward.test', Packet.TYPE.A);
    assert.equal(second.source, 'cache');
    assert.equal(second.answers[0].address, '93.184.216.34');
  } finally {
    upstream.close();
  }
});

test('rejects when every upstream fails', async () => {
  const port = await getUnusedUdpPort();
  const resolver = new Resolver({
    rulesStore: ruleStore([]),
    cache: new DnsCache(10),
    getConfig: () => baseConfig({ upstreams: [`127.0.0.1:${port}`], forwardTimeoutMs: 400 }),
  });
  await assert.rejects(resolver.resolve('nowhere.test', Packet.TYPE.A), err => {
    assert.equal(err.allFailed, true);
    return true;
  });
});

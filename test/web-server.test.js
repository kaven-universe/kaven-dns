'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { QueryStore } = require('../src/store/queries');
const { createLogStore } = require('../src/store/logs');
const { createAuth } = require('../src/web/auth');
const { createWebServer, heldByOwnDnsListener } = require('../src/web/server');

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

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

test('protects the update check and localizes upstream failures', async () => {
  const auth = createAuth({
    verifyPassword: password => password === 'correct',
    getSessionTtlMs: () => 60 * 1000,
  });
  const logs = createLogStore(20);
  let shouldFail = false;
  const updateChecker = async () => {
    if (shouldFail) throw new Error('GitHub unavailable');
    return {
      currentVersion: '1.2.1',
      latestVersion: '1.3.0',
      updateAvailable: true,
      url: 'https://github.com/kaven-universe/kaven-dns/tree/1.3.0',
    };
  };
  const web = createWebServer({
    config: {},
    rulesStore: {},
    queries: new QueryStore(20),
    cache: { info: () => ({ size: 0 }) },
    resolver: {},
    auth,
    logs,
    getDnsStatus: () => ({ listening: true }),
    runtime: {},
    updateChecker,
  });
  const server = await web.listen(0, '127.0.0.1');
  const port = server.address().port;

  try {
    const denied = await request(port, '/api/update');
    assert.equal(denied.status, 401);

    const token = auth.login('correct', '127.0.0.1').token;
    const headers = { Authorization: `Bearer ${token}` };
    const response = await request(port, '/api/update', headers);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).latestVersion, '1.3.0');

    shouldFail = true;
    const failed = await request(port, '/api/update', { ...headers, 'Accept-Language': 'zh-CN' });
    assert.equal(failed.status, 502);
    assert.equal(JSON.parse(failed.body).error, '无法检查更新，请稍后重试');
    assert.match(logs.snapshot().operationLogs.at(-1).msg, /GitHub unavailable/);
  } finally {
    web.close();
    await new Promise(resolve => server.close(resolve));
  }
});

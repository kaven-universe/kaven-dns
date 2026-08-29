'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { QueryStore } = require('../src/store/queries');
const { createLogStore } = require('../src/store/logs');
const { createAuth } = require('../src/web/auth');
const { createWebServer } = require('../src/web/server');

function request(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers, method }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('protects and resets queries', async () => {
  const queries = new QueryStore(20);
  queries.record({ t: Date.now(), domain: 'one.example', client: '192.0.2.1', latencyMs: 1, rcode: 0, source: 'fixed' });
  queries.record({ t: Date.now(), domain: 'two.example', client: '192.0.2.2', latencyMs: 2, rcode: 2, source: 'forward' });
  const logs = createLogStore(20);
  const auth = createAuth({
    verifyPassword: password => password === 'correct',
    getSessionTtlMs: () => 60 * 1000,
  });
  const web = createWebServer({
    config: {},
    rulesStore: {},
    queries,
    cache: { info: () => ({ size: 0 }) },
    resolver: {},
    auth,
    logs,
    getDnsStatus: () => ({ listening: true }),
    restartDns: async () => ({ applied: true }),
    runtime: {},
  });
  const server = await web.listen(0, '127.0.0.1');
  const port = server.address().port;

  try {
    const denied = await request(port, '/api/queries/reset', {}, 'POST');
    assert.equal(denied.status, 401);
    assert.equal(queries.getStats().total, 2);

    const token = auth.login('correct', '127.0.0.1').token;
    const headers = { Authorization: `Bearer ${token}` };
    const queryResponse = await request(port, '/api/queries?limit=20', headers);
    assert.equal(queryResponse.status, 200);
    assert.deepEqual(JSON.parse(queryResponse.body).queries.map(query => query.domain), ['two.example', 'one.example']);

    logs.record('test', 'canonical logs route');
    const logResponse = await request(port, '/api/logs?limit=20', headers);
    assert.equal(logResponse.status, 200);
    const logPayload = JSON.parse(logResponse.body);
    assert.match(logPayload.operationLogs.at(-1).msg, /canonical logs route/);
    assert.ok(Array.isArray(logPayload.consoleLogs));

    const removedRoute = await request(port, '/api/syslog', headers);
    assert.equal(removedRoute.status, 404);

    const response = await request(port, '/api/queries/reset', headers, 'POST');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, cleared: 2 });
    assert.deepEqual(queries.list(), []);
    assert.equal(queries.getStats().total, 0);
    assert.match(logs.snapshot().operationLogs.at(-1).msg, /2 entries cleared/);
  } finally {
    web.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('protects the event stream and sends an initial snapshot', async () => {
  const queries = new QueryStore(20);
  const logs = createLogStore(20);
  const auth = createAuth({
    verifyPassword: password => password === 'correct',
    getSessionTtlMs: () => 60 * 1000,
  });
  const web = createWebServer({
    config: {},
    rulesStore: {},
    queries,
    cache: { info: () => ({ size: 0 }) },
    resolver: {},
    auth,
    logs,
    getDnsStatus: () => ({ listening: true }),
    restartDns: async () => ({ applied: true }),
    runtime: {},
  });
  const server = await web.listen(0, '127.0.0.1');
  const port = server.address().port;

  try {
    const denied = await request(port, '/api/events');
    assert.equal(denied.status, 401);

    const token = auth.login('correct', '127.0.0.1').token;
    const snapshot = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { Authorization: `Bearer ${token}` },
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
          if (body.includes('event: snapshot\n')) web.disconnectEvents();
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
    });

    assert.equal(snapshot.status, 200);
    assert.match(snapshot.headers['content-type'], /^text\/event-stream/);
    assert.match(snapshot.body, /event: snapshot\ndata: .*"queries":\[\].*"logs":\{"consoleLogs":\[\],"operationLogs":\[\]\}/s);
  } finally {
    web.close();
    await new Promise(resolve => server.close(resolve));
  }
});
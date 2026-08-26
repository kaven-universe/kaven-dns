'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { LogStore } = require('../src/store/logs');
const { createSysLog } = require('../src/store/syslog');
const { createAuth } = require('../src/web/auth');
const { createWebServer } = require('../src/web/server');

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('protects the event stream and sends an initial snapshot', async () => {
  const logs = new LogStore(20);
  const syslog = createSysLog(20);
  const auth = createAuth({
    verifyPassword: password => password === 'correct',
    getSessionTtlMs: () => 60 * 1000,
  });
  const web = createWebServer({
    config: {},
    rulesStore: {},
    logs,
    cache: { info: () => ({ size: 0 }) },
    resolver: {},
    auth,
    syslog,
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
    assert.match(snapshot.body, /event: snapshot\ndata: .*"stats"/s);
  } finally {
    web.close();
    await new Promise(resolve => server.close(resolve));
  }
});
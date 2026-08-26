'use strict';

const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { LogStore } = require('../src/store/logs');
const { createSysLog } = require('../src/store/syslog');
const { createEventStream } = require('../src/web/events');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.writes = [];
    this.blockNext = false;
    this.ended = false;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders() {}

  write(value) {
    this.writes.push(value);
    if (this.blockNext) {
      this.blockNext = false;
      return false;
    }
    return true;
  }

  end() {
    this.ended = true;
  }
}

function eventFrames(response, event) {
  return response.writes.filter(value => value.includes(`event: ${event}\n`));
}

function eventData(frame) {
  const line = frame.split('\n').find(value => value.startsWith('data: '));
  return JSON.parse(line.slice(6));
}

function setup(options = {}) {
  const logs = new LogStore(20);
  const syslog = createSysLog(20);
  const stream = createEventStream({
    logs,
    syslog,
    cache: { info: () => ({ size: 0 }) },
    systemMonitor: { snapshot: () => ({ processCpu: 1 }) },
    getDnsStatus: () => ({ listening: true }),
    isAuthorized: token => token === 'valid',
  }, { startTimers: false, ...options });
  const response = new FakeResponse();
  stream.handle({ authToken: 'valid' }, response);
  response.writes = [];
  return { logs, syslog, stream, response };
}

test('batches query and system events outside the record path', () => {
  const { logs, syslog, stream, response } = setup();

  const query = logs.record({
    t: Date.now(), domain: 'example.com', client: '192.0.2.1',
    latencyMs: 12, rcode: 0, source: 'forward',
  });
  syslog.record('test', 'changed');

  assert.equal(eventFrames(response, 'queries').length, 0);
  stream.flushBatches();

  assert.deepEqual(eventData(eventFrames(response, 'queries')[0]), {
    entries: [query],
    dropped: 0,
  });
  assert.equal(eventData(eventFrames(response, 'syslog')[0]).events[0].msg, 'changed');

  stream.flushState(true);
  assert.equal(eventData(eventFrames(response, 'stats')[0]).stats.total, 1);
  stream.close();
});

test('bounds pending events and sends a fresh snapshot after backpressure', () => {
  const { logs, stream, response } = setup({ maxPending: 2 });
  for (let index = 0; index < 3; index++) {
    logs.record({
      t: Date.now(), domain: `${index}.example`, client: '192.0.2.1',
      latencyMs: 1, rcode: 0, source: 'cache',
    });
  }

  response.blockNext = true;
  stream.flushBatches();
  const batch = eventData(eventFrames(response, 'queries')[0]);
  assert.equal(batch.entries.length, 2);
  assert.equal(batch.dropped, 1);

  logs.record({
    t: Date.now(), domain: 'latest.example', client: '192.0.2.1',
    latencyMs: 1, rcode: 0, source: 'cache',
  });
  stream.flushBatches();
  assert.equal(eventFrames(response, 'queries').length, 1);

  response.emit('drain');
  assert.equal(eventFrames(response, 'snapshot').length, 1);
  assert.equal(eventData(eventFrames(response, 'snapshot')[0]).stats.total, 4);
  stream.close();
});
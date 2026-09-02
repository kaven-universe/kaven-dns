'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSystemMonitor } = require('../src/system');

test('reports runtime-neutral Node identity fields', () => {
  const snapshot = createSystemMonitor().snapshot();
  assert.equal(snapshot.runtimeName, 'Node');
  assert.equal(snapshot.runtimeVersion, process.version);
  assert.equal(snapshot.nodeVersion, process.version);
});

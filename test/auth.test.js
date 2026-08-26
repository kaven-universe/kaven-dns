'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuth } = require('../src/web/auth');

test('exposes the validated bearer token to authenticated stream handlers', () => {
  const auth = createAuth({
    verifyPassword: password => password === 'correct',
    getSessionTtlMs: () => 60 * 1000,
  });
  const token = auth.login('correct', '127.0.0.1').token;
  const req = { headers: { authorization: `Bearer ${token}` } };
  let called = false;

  auth.middleware(req, {}, () => { called = true; });

  assert.equal(called, true);
  assert.equal(req.authToken, token);
});
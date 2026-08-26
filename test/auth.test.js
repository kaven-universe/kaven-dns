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

test('escalates the lockout duration for repeated offenses from the same IP', () => {
  let now = 0;
  const auth = createAuth({
    verifyPassword: password => password === 'correct',
    getSessionTtlMs: () => 60 * 1000,
    clock: () => now,
  });

  for (let i = 0; i < 5; i++) assert.equal(auth.login('wrong', '10.0.0.1').ok, false);
  const firstLock = auth.login('correct', '10.0.0.1');
  assert.equal(firstLock.ok, false);
  assert.match(firstLock.error, /10/);

  now += 10 * 1000; // first lock (10s) just expired
  for (let i = 0; i < 5; i++) assert.equal(auth.login('wrong', '10.0.0.1').ok, false);
  const secondLock = auth.login('correct', '10.0.0.1');
  assert.equal(secondLock.ok, false);
  assert.match(secondLock.error, /20/); // doubled

  now += 20 * 1000; // second lock (20s) just expired
  const success = auth.login('correct', '10.0.0.1');
  assert.equal(success.ok, true);

  // An unrelated IP was never touched by the lockout above.
  assert.equal(auth.login('correct', '10.0.0.2').ok, true);
});
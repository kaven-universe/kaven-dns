'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDomain, matchDomain, findMatch } = require('../src/dns/matching');

test('normalizeDomain trims, lowercases and drops a trailing dot', () => {
  assert.equal(normalizeDomain('  WWW.Example.COM.  '), 'www.example.com');
  assert.equal(normalizeDomain(undefined), '');
});

test('a plain pattern matches itself and subdomains; a wildcard matches subdomains only', () => {
  assert.equal(matchDomain('example.com', 'example.com'), true);
  assert.equal(matchDomain('example.com', 'www.example.com'), true);
  assert.equal(matchDomain('example.com', 'notexample.com'), false);
  assert.equal(matchDomain('*.example.com', 'example.com'), false);
  assert.equal(matchDomain('*.example.com', 'www.example.com'), true);
});

test('findMatch prefers more labels regardless of which rule is older', () => {
  const rules = [
    { id: 'specific', domains: ['dev.example.com'], type: 'A', mode: 'fixed' },
    { id: 'general', domains: ['example.com'], type: 'A', mode: 'fixed' },
  ];
  const found = findMatch(rules, 'dev.example.com', 'A');
  assert.equal(found.rule.id, 'specific');
});

test('findMatch prefers a plain pattern over a wildcard at the same label count', () => {
  const rules = [
    { id: 'wildcard', domains: ['*.example.com'], type: 'A', mode: 'fixed' },
    { id: 'plain', domains: ['example.com'], type: 'A', mode: 'fixed' },
  ];
  const found = findMatch(rules, 'www.example.com', 'A');
  assert.equal(found.rule.id, 'plain');
});

test('findMatch breaks a specificity tie in favor of the later (newer) rule', () => {
  const rules = [
    { id: 'old', domains: ['a.example.com'], type: 'A', mode: 'fixed' },
    { id: 'new', domains: ['a.example.com'], type: 'A', mode: 'fixed' },
  ];
  const found = findMatch(rules, 'a.example.com', 'A');
  assert.equal(found.rule.id, 'new');
});

test('a CNAME rule participates in A/AAAA lookups but not unrelated types', () => {
  const rules = [{ id: 'alias', domains: ['alias.test'], type: 'CNAME', mode: 'fixed' }];
  assert.equal(findMatch(rules, 'alias.test', 'A').rule.id, 'alias');
  assert.equal(findMatch(rules, 'alias.test', 'AAAA').rule.id, 'alias');
  assert.equal(findMatch(rules, 'alias.test', 'CNAME').rule.id, 'alias');
  assert.equal(findMatch(rules, 'alias.test', 'TXT'), null);
});

test('findMatch skips disabled rules and returns null when nothing matches', () => {
  const rules = [{ id: 'off', domains: ['a.test'], type: 'A', mode: 'fixed', enabled: false }];
  assert.equal(findMatch(rules, 'a.test', 'A'), null);
  assert.equal(findMatch([], 'a.test', 'A'), null);
});

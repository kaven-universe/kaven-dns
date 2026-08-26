'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { RulesStore, validateRule } = require('../src/store/rules');
const { t } = require('../src/i18n');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaven-dns-rules-'));
  return path.join(dir, 'rules.json');
}

// ---- validateRule ----

test('validates and normalizes a fixed A rule with a domain group and multiple values', () => {
  const { errors, value } = validateRule({
    domains: ['B.example.com', 'a.example.com', 'a.example.com'],
    type: 'A',
    mode: 'fixed',
    value: ' 10.0.0.1 , 10.0.0.2 ',
    ttl: 120,
    remark: 'x'.repeat(250),
  });
  assert.deepEqual(errors, []);
  // parseDomains dedups but preserves first-seen order, it does not sort.
  assert.deepEqual(value.domains, ['b.example.com', 'a.example.com']);
  assert.equal(value.value, '10.0.0.1,10.0.0.2');
  assert.equal(value.ttl, 120);
  assert.equal(value.enabled, true);
  assert.equal(value.remark.length, 200);
});

test('parses domains out of a free-form textarea-style string', () => {
  const { errors, value } = validateRule({
    domains: 'a.example.com, b.example.com\nc.example.com;d.example.com',
    type: 'A',
    mode: 'fixed',
    value: '10.0.0.1',
    ttl: 60,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(value.domains, ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com']);
});

test('requires at least one domain', () => {
  const { errors } = validateRule({ domains: [], type: 'A', mode: 'fixed', value: '10.0.0.1', ttl: 60 });
  assert.ok(errors.includes(t('en', 'rules.domains_required')));
});

test('rejects more than the maximum number of domains per rule', () => {
  const domains = Array.from({ length: 501 }, (_, i) => `host${i}.example.com`);
  const { errors } = validateRule({ domains, type: 'A', mode: 'fixed', value: '10.0.0.1', ttl: 60 });
  assert.ok(errors.includes(t('en', 'rules.domains_max', { n: 500 })));
});

test('reports the offending line for an invalid domain', () => {
  const { errors } = validateRule({ domains: ['ok.example.com', 'not_valid'], type: 'A', mode: 'fixed', value: '10.0.0.1', ttl: 60 });
  assert.ok(errors.includes(t('en', 'rules.domain_line_invalid', { n: 2, domain: 'not_valid' })));
});

test('rejects an unknown record type or mode', () => {
  const badType = validateRule({ domains: ['a.test'], type: 'MX', mode: 'fixed', value: 'x', ttl: 60 });
  assert.ok(badType.errors.includes(t('en', 'rules.type_invalid')));

  const badMode = validateRule({ domains: ['a.test'], type: 'A', mode: 'bogus', value: '1.2.3.4', ttl: 60 });
  assert.ok(badMode.errors.includes(t('en', 'rules.mode_invalid')));
});

test('validates fixed-mode values against the record type', () => {
  const missing = validateRule({ domains: ['a.test'], type: 'A', mode: 'fixed', value: '', ttl: 60 });
  assert.ok(missing.errors.includes(t('en', 'rules.fixed_value_required')));

  const badA = validateRule({ domains: ['a.test'], type: 'A', mode: 'fixed', value: 'not-an-ip', ttl: 60 });
  assert.ok(badA.errors.includes(t('en', 'rules.a_ipv4')));

  const badAaaa = validateRule({ domains: ['a.test'], type: 'AAAA', mode: 'fixed', value: '10.0.0.1', ttl: 60 });
  assert.ok(badAaaa.errors.includes(t('en', 'rules.aaaa_ipv6')));

  const multiCname = validateRule({ domains: ['a.test'], type: 'CNAME', mode: 'fixed', value: 'x.test,y.test', ttl: 60 });
  assert.ok(multiCname.errors.includes(t('en', 'rules.cname_single')));

  const badCname = validateRule({ domains: ['a.test'], type: 'CNAME', mode: 'fixed', value: 'not_a_host', ttl: 60 });
  assert.ok(badCname.errors.includes(t('en', 'rules.cname_invalid')));

  const goodCname = validateRule({ domains: ['a.test'], type: 'CNAME', mode: 'fixed', value: 'target.example.com', ttl: 60 });
  assert.deepEqual(goodCname.errors, []);
});

test('validates the optional per-rule upstream and the TTL range', () => {
  const badUpstream = validateRule({ domains: ['a.test'], type: 'A', mode: 'forward', upstream: 'example.com', ttl: 60 });
  assert.ok(badUpstream.errors.includes(t('en', 'rules.upstream_invalid')));

  const goodUpstream = validateRule({ domains: ['a.test'], type: 'A', mode: 'forward', upstream: '8.8.8.8:53', ttl: 60 });
  assert.deepEqual(goodUpstream.errors, []);

  const badTtl = validateRule({ domains: ['a.test'], type: 'A', mode: 'forward', ttl: 0 });
  assert.ok(badTtl.errors.includes(t('en', 'rules.ttl_invalid')));
});

test('honors an explicit enabled: false and localizes errors in Chinese', () => {
  const disabled = validateRule({ domains: ['a.test'], type: 'A', mode: 'fixed', value: '1.2.3.4', ttl: 60, enabled: false });
  assert.equal(disabled.value.enabled, false);

  const { errors } = validateRule({ domains: [], type: 'A', mode: 'fixed', ttl: 60 }, 'zh');
  assert.ok(errors.includes(t('zh', 'rules.domains_required')));
});

// ---- RulesStore ----

test('add/list/update/remove round-trip and persist to disk', () => {
  const store = new RulesStore(tempFile());
  assert.deepEqual(store.list(), []);

  const rule = store.add({ domains: ['a.test'], type: 'A', mode: 'fixed', value: '1.2.3.4', ttl: 60, enabled: true });
  assert.ok(rule.id);
  assert.ok(rule.createdAt);
  assert.equal(store.list().length, 1);

  const updated = store.update(rule.id, { ...rule, value: '5.6.7.8' });
  assert.equal(updated.value, '5.6.7.8');
  assert.equal(updated.createdAt, rule.createdAt);
  assert.ok(updated.updatedAt >= rule.updatedAt);
  assert.equal(store.update('missing-id', {}), null);

  assert.equal(store.remove(rule.id), true);
  assert.equal(store.remove(rule.id), false);
  assert.deepEqual(store.list(), []);
});

test('list() returns shallow copies so top-level edits do not affect the store', () => {
  const store = new RulesStore(tempFile());
  store.add({ domains: ['a.test'], type: 'A', mode: 'fixed', value: '1.2.3.4', ttl: 60 });
  const copy = store.list()[0];
  copy.value = 'clobbered';
  assert.equal(store.list()[0].value, '1.2.3.4');
});

test('persists rules across separate RulesStore instances', () => {
  const file = tempFile();
  const store1 = new RulesStore(file);
  store1.add({ domains: ['persist.test'], type: 'A', mode: 'fixed', value: '1.2.3.4', ttl: 60 });

  const store2 = new RulesStore(file);
  assert.equal(store2.list().length, 1);
  assert.equal(store2.list()[0].domains[0], 'persist.test');
});

test('migrates a legacy single-domain rule to the domains array on load', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify([{ domain: 'legacy.example.com', type: 'A', mode: 'fixed', value: '1.2.3.4', ttl: 60 }]));

  const store = new RulesStore(file);
  const [rule] = store.list();
  assert.ok(rule.id);
  assert.deepEqual(rule.domains, ['legacy.example.com']);
  assert.equal(rule.domain, undefined);

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(persisted[0].domains, ['legacy.example.com']);
});

test('replaceAll swaps the entire rule set and persists it', () => {
  const store = new RulesStore(tempFile());
  store.add({ domains: ['old.test'], type: 'A', mode: 'fixed', value: '1.2.3.4', ttl: 60 });
  store.replaceAll([{ id: 'new', domains: ['new.test'], type: 'A', mode: 'fixed', value: '9.9.9.9', ttl: 60 }]);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].domains[0], 'new.test');
});

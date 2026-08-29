'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkForUpdates, compareVersions } = require('../src/update');

test('compares stable semantic versions numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.2.1'), -1);
  assert.throws(() => compareVersions('latest', '1.2.1'), /major\.minor\.patch/);
});

test('finds the highest stable tag and reports an available update', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => [
        { name: '1.3.0-rc.1' },
        { name: 'v1.9.0' },
        { name: 'v1.10.0' },
        { name: 'not-a-version' },
      ],
    };
  };

  const result = await checkForUpdates({ fetchImpl, currentVersion: '1.2.1' });

  assert.match(request.url, /api\.github\.com\/repos\/kaven-universe\/kaven-dns\/tags/);
  assert.equal(request.options.headers['User-Agent'], 'kaven-dns/1.2.1');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    currentVersion: '1.2.1',
    latestVersion: '1.10.0',
    updateAvailable: true,
    url: 'https://github.com/kaven-universe/kaven-dns/tree/v1.10.0',
  });
});

test('reports the current version as up to date', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ name: '1.2.0' }, { name: '1.2.1' }],
  });

  const result = await checkForUpdates({ fetchImpl, currentVersion: '1.2.1' });
  assert.equal(result.latestVersion, '1.2.1');
  assert.equal(result.updateAvailable, false);
});

test('rejects failed and invalid GitHub responses', async () => {
  await assert.rejects(
    checkForUpdates({
      fetchImpl: async () => ({ ok: false, status: 403 }),
      currentVersion: '1.2.1',
    }),
    /HTTP 403/,
  );
  await assert.rejects(
    checkForUpdates({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ name: 'nightly' }] }),
      currentVersion: '1.2.1',
    }),
    /no stable version tags/,
  );
});
'use strict';

const { version: PACKAGE_VERSION } = require('../package.json');

const TAGS_API_URL = 'https://api.github.com/repos/kaven-universe/kaven-dns/tags?per_page=100';
const REPOSITORY_URL = 'https://github.com/kaven-universe/kaven-dns';
const DEFAULT_TIMEOUT_MS = 5000;

function parseStableVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: match.slice(1).map(Number),
  };
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new TypeError('Versions must use major.minor.patch format');
  for (let i = 0; i < a.parts.length; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  }
  return 0;
}

async function checkForUpdates({
  fetchImpl = globalThis.fetch,
  currentVersion = PACKAGE_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const current = parseStableVersion(currentVersion);
  if (!current) throw new Error(`Invalid current version: ${currentVersion}`);
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is not available');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const response = await fetchImpl(TAGS_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `kaven-dns/${current.version}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

    const tags = await response.json();
    if (!Array.isArray(tags)) throw new Error('GitHub returned an invalid tag list');

    let latest = null;
    for (const tag of tags) {
      const parsed = parseStableVersion(tag && tag.name);
      if (parsed && (!latest || compareVersions(parsed.version, latest.version) > 0)) {
        latest = { ...parsed, tag: String(tag.name).trim() };
      }
    }
    if (!latest) throw new Error('GitHub returned no stable version tags');

    return {
      currentVersion: current.version,
      latestVersion: latest.version,
      updateAvailable: compareVersions(latest.version, current.version) > 0,
      url: `${REPOSITORY_URL}/tree/${encodeURIComponent(latest.tag)}`,
    };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Update check timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdates, compareVersions };
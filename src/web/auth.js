'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteJson } = require('../config');
const { t } = require('../i18n');

const MAX_FAILS = 5;
const BASE_LOCK_MS = 10 * 1000;
const MAX_LOCK_MS = 10 * 60 * 1000;
// Keep a repeat offender's strike count alive for a while after their lock
// expires, so pausing and resuming doesn't reset the lockout back to 10s.
const STRIKE_MEMORY_MS = 10 * 60 * 1000;

/**
 * Simple password authentication: a successful login issues a random token
 * (in-memory session). The lifetime comes from getSessionTtlMs() and is
 * renewed on every authenticated request, so it acts as an idle timeout.
 * Sessions are persisted to `sessionsFile` so server restarts keep users
 * logged in. Five consecutive failures lock the source IP out, doubling the
 * lockout (10s, 20s, 40s, ... capped at 10 minutes) for each repeat offense.
 * Error messages are localized via `lang`.
 */
function createAuth({ verifyPassword, getSessionTtlMs, sessionsFile, clock = Date.now }) {
  let sessions = new Map(); // token -> expiresAt
  const fails = new Map(); // ip -> { count, lockedUntil, strikes }
  let dirty = false;

  if (sessionsFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const now = clock();
      for (const [token, exp] of Object.entries(saved || {})) {
        if (typeof exp === 'number' && exp > now) sessions.set(token, exp);
      }
    } catch (e) {
      if (e.code !== 'ENOENT')
        console.error(`[auth] failed to read ${sessionsFile}: ${e.message}`);
    }
  }

  function persist() {
    if (!sessionsFile) return;
    try {
      atomicWriteJson(sessionsFile, Object.fromEntries(sessions));
      dirty = false;
    } catch (e) {
      console.error(`[auth] failed to write ${sessionsFile}: ${e.message}`);
    }
  }

  const timer = setInterval(() => {
    const now = clock();
    for (const [token, exp] of sessions) {
      if (exp < now) {
        sessions.delete(token);
        dirty = true;
      }
    }
    for (const [ip, f] of fails)
      if (f.lockedUntil && f.lockedUntil + STRIKE_MEMORY_MS < now) fails.delete(ip);
    // Flush login/logout and sliding renewals without writing on every request
    if (dirty) persist();
  }, 60 * 1000);
  timer.unref();

  function login(password, ip, lang = 'en') {
    const now = clock();
    const f = fails.get(ip);
    if (f && f.lockedUntil > now) {
      const wait = Math.ceil((f.lockedUntil - now) / 1000);
      return { ok: false, error: t(lang, 'auth.too_many_attempts', { s: wait }) };
    }
    if (!verifyPassword(password)) {
      const rec = f || { count: 0, lockedUntil: 0, strikes: 0 };
      rec.count++;
      if (rec.count >= MAX_FAILS) {
        rec.strikes++;
        rec.lockedUntil = now + Math.min(BASE_LOCK_MS * 2 ** (rec.strikes - 1), MAX_LOCK_MS);
        rec.count = 0;
      }
      fails.set(ip, rec);
      return { ok: false, error: t(lang, 'auth.incorrect_password') };
    }
    fails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, now + getSessionTtlMs());
    persist();
    return { ok: true, token };
  }

  function logout(token) {
    sessions.delete(token);
    persist();
  }

  function check(token) {
    const exp = sessions.get(token);
    if (!exp) return false;
    const now = clock();
    if (exp < now) {
      sessions.delete(token);
      persist();
      return false;
    }
    // Sliding renewal: activity extends the session by another full TTL
    sessions.set(token, now + getSessionTtlMs());
    dirty = true;
    return true;
  }

  function middleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : req.headers['x-auth-token'] || '';
    if (token && check(token)) {
      req.authToken = token;
      return next();
    }
    res.status(401).json({ error: t(req.lang, 'auth.not_signed_in') });
  }

  return { login, logout, check, middleware };
}

module.exports = { createAuth };

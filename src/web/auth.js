'use strict';

const crypto = require('crypto');
const { t } = require('../i18n');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 1000;

/**
 * Simple password authentication: a successful login issues a random token
 * (in-memory session, valid for 24 hours). Five consecutive failures lock
 * the source IP for 10 seconds. Error messages are localized via `lang`.
 */
function createAuth({ verifyPassword }) {
  const sessions = new Map(); // token -> expiresAt
  const fails = new Map(); // ip -> { count, lockedUntil }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of sessions) if (exp < now) sessions.delete(token);
    for (const [ip, f] of fails) if (f.lockedUntil && f.lockedUntil < now) fails.delete(ip);
  }, 60 * 1000);
  timer.unref();

  function login(password, ip, lang = 'en') {
    const f = fails.get(ip);
    if (f && f.lockedUntil > Date.now()) {
      const wait = Math.ceil((f.lockedUntil - Date.now()) / 1000);
      return { ok: false, error: t(lang, 'auth.too_many_attempts', { s: wait }) };
    }
    if (!verifyPassword(password)) {
      const rec = f || { count: 0, lockedUntil: 0 };
      rec.count++;
      if (rec.count >= MAX_FAILS) {
        rec.lockedUntil = Date.now() + LOCK_MS;
        rec.count = 0;
      }
      fails.set(ip, rec);
      return { ok: false, error: t(lang, 'auth.incorrect_password') };
    }
    fails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return { ok: true, token };
  }

  function logout(token) {
    sessions.delete(token);
  }

  function check(token) {
    const exp = sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function middleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : req.headers['x-auth-token'] || '';
    if (token && check(token)) return next();
    res.status(401).json({ error: t(req.lang, 'auth.not_signed_in') });
  }

  return { login, logout, check, middleware };
}

module.exports = { createAuth };

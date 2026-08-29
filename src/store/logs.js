'use strict';

/**
 * Logs tab store: in-memory ring buffers for console output and operation
 * records (rule/config/operation changes). console.log/warn/error are wrapped
 * so output that would otherwise only go to the terminal is also visible
 * from the Web console. Everything lives in memory, matching the rest of the
 * app (query history and stats are in-memory too).
 */

function createLogStore(capacity = 600) {
  const consoleLogs = [];
  const operationLogs = [];
  const listeners = new Set();
  let sequence = 0;

  const push = (arr, item, kind) => {
    const logged = { ...item, seq: ++sequence };
    arr.push(logged);
    if (arr.length > capacity) arr.splice(0, arr.length - capacity);
    for (const listener of listeners) {
      try { listener({ kind, item: logged }); } catch (_) { /* observers are isolated */ }
    }
    return logged;
  };

  const safeString = value => {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  };

  function captureConsole() {
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        const msg = args.map(a => (typeof a === 'string' ? a : safeString(a))).join(' ');
        push(consoleLogs, { t: Date.now(), level, msg }, 'console');
      };
    }
  }

  /** Record an operation (also echoed through the console log). */
  function record(type, msg, level = 'log') {
    push(operationLogs, { t: Date.now(), type, level, msg }, 'operation');
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${type}] ${msg}`);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function snapshot(limit = 400) {
    const take = arr => arr.slice(-limit);
    return { consoleLogs: take(consoleLogs), operationLogs: take(operationLogs) };
  }

  function clear() {
    consoleLogs.length = 0;
    operationLogs.length = 0;
  }

  return { captureConsole, record, subscribe, snapshot, clear };
}

module.exports = { createLogStore };

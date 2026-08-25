'use strict';

/**
 * System log: in-memory ring buffers for (a) console output and (b) audit
 * events (rule/config/operation changes). console.log/warn/error are wrapped
 * so output that a hidden GUI console would swallow is still visible from the
 * Web console; the packaged desktop build additionally tees it to
 * data/kaven-dns.log via setFileWriter(). Everything lives in memory,
 * matching the rest of the app (the query log / stats are in-memory too).
 */

function createSysLog(capacity = 600) {
  const consoleLines = [];
  const events = [];

  const push = (arr, item) => {
    arr.push(item);
    if (arr.length > capacity) arr.splice(0, arr.length - capacity);
  };

  const safeString = value => {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  };

  let fileWriter = null;
  const setFileWriter = fn => { fileWriter = fn; };

  function captureConsole() {
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        const msg = args.map(a => (typeof a === 'string' ? a : safeString(a))).join(' ');
        push(consoleLines, { t: Date.now(), level, msg });
        if (fileWriter) { try { fileWriter(msg); } catch (_) { /* never crash */ } }
      };
    }
  }

  /** Record an audit event (also echoed through the console / log file). */
  function record(type, msg, level = 'log') {
    push(events, { t: Date.now(), type, level, msg });
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${type}] ${msg}`);
  }

  function snapshot(limit = 400) {
    const take = arr => arr.slice(-limit);
    return { console: take(consoleLines), events: take(events) };
  }

  function clear() {
    consoleLines.length = 0;
    events.length = 0;
  }

  return { captureConsole, record, setFileWriter, snapshot, clear };
}

module.exports = { createSysLog };

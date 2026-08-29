'use strict';

const DEFAULT_MAX_PENDING = 500;

function createBuffer(limit) {
  let items = [];
  let dropped = 0;
  return {
    push(item) {
      if (items.length < limit) items.push(item);
      else dropped++;
    },
    take() {
      const batch = { items, dropped };
      items = [];
      dropped = 0;
      return batch;
    },
  };
}

function encodeEvent(id, event, data) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createEventStream({
  queries,
  logs,
  cache,
  systemMonitor,
  getDnsStatus,
  isAuthorized,
}, options = {}) {
  const clients = new Set();
  const maxPending = options.maxPending || DEFAULT_MAX_PENDING;
  const pendingQueries = createBuffer(maxPending);
  const pendingConsoleLogs = createBuffer(maxPending);
  const pendingOperationLogs = createBuffer(maxPending);
  let eventId = 0;
  let stateDirty = false;
  let stateTicks = 0;

  const buildState = () => ({
    stats: queries.getStats(),
    analytics: queries.getAnalytics(),
    cache: cache.info(),
    system: systemMonitor.snapshot(),
    dns: getDnsStatus ? getDnsStatus() : null,
  });

  const buildLogs = () => logs
    ? logs.snapshot(500)
    : { consoleLogs: [], operationLogs: [] };

  const buildSnapshot = () => ({
    ...buildState(),
    queries: queries.list({ limit: 200 }),
    logs: buildLogs(),
  });

  const clearPending = () => {
    pendingQueries.take();
    pendingConsoleLogs.take();
    pendingOperationLogs.take();
  };

  const removeClient = client => {
    clients.delete(client);
    if (!clients.size) clearPending();
  };

  function waitForDrain(client) {
    if (client.blocked) return;
    client.blocked = true;
    client.needsSnapshot = true;
    client.res.once('drain', () => {
      if (!clients.has(client)) return;
      client.blocked = false;
      if (client.needsSnapshot) {
        client.needsSnapshot = false;
        send(client, 'snapshot', buildSnapshot());
      }
    });
  }

  function send(client, event, data, id = ++eventId) {
    if (!clients.has(client)) return false;
    if (client.blocked) {
      client.needsSnapshot = true;
      return false;
    }
    try {
      const writable = client.res.write(encodeEvent(id, event, data));
      if (!writable) waitForDrain(client);
      return writable;
    } catch (_) {
      removeClient(client);
      return false;
    }
  }

  function broadcast(event, data) {
    const id = ++eventId;
    for (const client of clients) send(client, event, data, id);
  }

  function broadcastSnapshot() {
    clearPending();
    stateDirty = false;
    broadcast('snapshot', buildSnapshot());
  }

  const unsubscribeQueries = queries.subscribe(entry => {
    if (!clients.size) return;
    pendingQueries.push(entry);
    stateDirty = true;
  });

  const unsubscribeLogs = logs && logs.subscribe
    ? logs.subscribe(update => {
      if (!clients.size) return;
      if (update.kind === 'console') pendingConsoleLogs.push(update.item);
      else if (update.kind === 'operation') pendingOperationLogs.push(update.item);
      stateDirty = true;
    })
    : () => {};

  function flushBatches() {
    if (!clients.size) return;
    const queryBatch = pendingQueries.take();
    if (queryBatch.items.length || queryBatch.dropped) {
      broadcast('queries', {
        entries: queryBatch.items,
        dropped: queryBatch.dropped,
      });
    }

    const consoleBatch = pendingConsoleLogs.take();
    const operationBatch = pendingOperationLogs.take();
    if (consoleBatch.items.length || operationBatch.items.length || consoleBatch.dropped || operationBatch.dropped) {
      broadcast('logs', {
        consoleLogs: consoleBatch.items,
        operationLogs: operationBatch.items,
        dropped: consoleBatch.dropped + operationBatch.dropped,
      });
    }
  }

  function flushState(force = false) {
    if (!clients.size) return;
    stateTicks++;
    if (!force && !stateDirty && stateTicks % 3 !== 0) return;
    stateDirty = false;
    broadcast('stats', buildState());
  }

  function heartbeat() {
    for (const client of [...clients]) {
      if (isAuthorized && !isAuthorized(client.token)) {
        removeClient(client);
        try { client.res.end(); } catch (_) { /* already closed */ }
        continue;
      }
      if (client.blocked) {
        client.needsSnapshot = true;
        continue;
      }
      try {
        if (!client.res.write(': keepalive\n\n')) waitForDrain(client);
      } catch (_) {
        removeClient(client);
      }
    }
  }

  function handle(req, res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 3000\n\n');

    const client = {
      res,
      token: req.authToken || '',
      blocked: false,
      needsSnapshot: false,
    };
    clients.add(client);
    res.once('close', () => removeClient(client));
    send(client, 'snapshot', buildSnapshot());
  }

  const timers = [];
  if (options.startTimers !== false) {
    timers.push(setInterval(flushBatches, options.batchIntervalMs || 500));
    timers.push(setInterval(flushState, options.stateIntervalMs || 2000));
    timers.push(setInterval(heartbeat, options.heartbeatIntervalMs || 15000));
    timers.forEach(timer => timer.unref());
  }

  function disconnect() {
    for (const client of clients) {
      try { client.res.end(); } catch (_) { /* already closed */ }
    }
    clients.clear();
    clearPending();
  }

  function close() {
    unsubscribeQueries();
    unsubscribeLogs();
    timers.forEach(clearInterval);
    disconnect();
  }

  return { handle, flushBatches, flushState, broadcastSnapshot, disconnect, close };
}

module.exports = { createEventStream, encodeEvent };
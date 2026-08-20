'use strict';

const { UDPClient } = require('dns2');
const { TYPE_NAMES } = require('./util');

function parseUpstream(upstream) {
  // Supports `1.2.3.4` or `1.2.3.4:5353`; IPv6 without a port
  if (/^\d+\.\d+\.\d+\.\d+:\d{1,5}$/.test(upstream)) {
    const [host, port] = upstream.split(':');
    return { host, port: Number(port) };
  }
  return { host: upstream, port: 53 };
}

/**
 * Race UDP queries against multiple upstreams and take the fastest success
 * (Promise.any). Returns { response, upstream }; throws AggregateError when
 * all fail; returns null for query types dns2 does not support (caller
 * answers NOTIMP).
 */
async function forwardQuery(domain, typeNumber, upstreams, timeoutMs) {
  const tName = TYPE_NAMES[typeNumber];
  if (!tName) return null;

  const tasks = upstreams.map(upstream => {
    const { host, port } = parseUpstream(upstream);
    const query = UDPClient({
      dns: host,
      port,
      timeout: timeoutMs,
      retryOverTCP: true, // when the answer has the TC bit set, retry over TCP
    });
    return query(domain, tName).then(
      response => ({ response, upstream }),
      err => {
        err.upstream = upstream;
        throw err;
      },
    );
  });

  return Promise.any(tasks);
}

module.exports = { forwardQuery };

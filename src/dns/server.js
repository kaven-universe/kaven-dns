'use strict';

const { UDPServer, TCPServer, Packet } = require('dns2');
const { normalizeDomain } = require('./matching');
const { typeName, summarizeAnswers } = require('./util');

/**
 * Create UDP + TCP DNS servers.
 * Handler signature matches dns2: (request, send, clientInfo), where
 * clientInfo is rinfo (address/port) for UDP and a net.Socket
 * (remoteAddress) for TCP.
 */
// net.Socket (TCP) has its OWN .address() *method* (the local end), which is
// truthy and would win a naive `client.address || client.remoteAddress`
// check over the real peer IP - silently storing a function value that
// JSON.stringify then drops the field for entirely. UDP's rinfo has no such
// collision (.address is a plain string there), so only require a string.
function extractClientIp(client) {
  if (!client) return 'unknown';
  if (typeof client.remoteAddress === 'string' && client.remoteAddress) return client.remoteAddress;
  if (typeof client.address === 'string' && client.address) return client.address;
  return 'unknown';
}

function createDnsServers({ resolver, logs, port, address }) {
  async function handle(request, send, client) {
    const started = Date.now();
    const clientIp = extractClientIp(client);
    const question = request.questions && request.questions[0];

    if (!question || !question.name) {
      const resp = Packet.createResponseFromRequest(request);
      resp.header.rcode = Packet.RCODE.FORMERR;
      send(resp);
      return;
    }

    const domain = normalizeDomain(question.name);
    let result = null;
    let error = null;
    try {
      result = await resolver.resolve(domain, question.type);
    } catch (e) {
      error = e;
    }

    const response = Packet.createResponseFromRequest(request);
    if (result) {
      response.header.rcode = result.rcode;
      response.header.ra = 1;
      response.answers = result.answers;
      response.authorities = result.authorities || [];
      response.additionals = result.additionals || [];
    } else {
      response.header.rcode = Packet.RCODE.SERVFAIL;
    }
    try {
      send(response);
    } catch (e) {
      error = error || e;
    }

    logs.record({
      t: started,
      client: clientIp,
      domain,
      type: typeName(question.type),
      source: result ? result.source : 'forward',
      rcode: result ? result.rcode : Packet.RCODE.SERVFAIL,
      latencyMs: Date.now() - started,
      answers: result ? summarizeAnswers(result.answers) : '',
      rule: (result && result.ruleLabel) || '',
      upstream: (result && result.upstream) || '',
      error: error ? error.message : '',
    });
  }

  // dns2's UDP socket (dgram.Socket) cannot re-bind after close(), and the
  // TCP server's connection bookkeeping is per-instance — so switching ports
  // means building fresh server objects rather than re-listening the old ones.
  let udp = null;
  let tcp = null;

  function createServers() {
    const onErr = e => console.error('[dns] request error:', e.message);
    const newUdp = new UDPServer(handle);
    const newTcp = new TCPServer(handle);
    newUdp.on('requestError', onErr);
    newTcp.on('requestError', onErr);
    return { newUdp, newTcp };
  }

  const state = { port, address, listening: false, error: '' };

  async function start() {
    if (!udp) ({ newUdp: udp, newTcp: tcp } = createServers());
    try {
      // dns2's UDP listen() resolves a promise, but TCP (net.Server) reports
      // failure via the 'error' event; listen for both so either rejects.
      // An undefined/empty address makes both stacks bind every interface.
      const addr = state.address || undefined;
      await Promise.all([
        new Promise((resolve, reject) => {
          udp.once('error', reject);
          udp.listen(state.port, addr).then(resolve, reject);
        }),
        new Promise((resolve, reject) => {
          tcp.once('error', reject);
          tcp.listen(state.port, addr, () => resolve());
        }),
      ]);
      state.listening = true;
      state.error = '';
    } catch (e) {
      // Roll back a half-open state (e.g. UDP bound but TCP failed).
      try { udp.close(); } catch (_) { /* already closed */ }
      try { tcp.close(); } catch (_) { /* already closed */ }
      udp = null;
      tcp = null;
      state.listening = false;
      state.error = (e && e.code) || e.message;
      throw e;
    }
  }

  function close() {
    try { udp.close(); } catch (_) { /* already closed */ }
    try { tcp.close(); } catch (_) { /* already closed */ }
    udp = null;
    tcp = null;
    state.listening = false;
  }

  async function restart(newPort, newAddress) {
    close();
    state.port = newPort;
    state.address = newAddress;
    return start();
  }

  function status() {
    return { port: state.port, address: state.address || '0.0.0.0', listening: state.listening, error: state.error };
  }

  return { udp, tcp, start, close, restart, status };
}

module.exports = { createDnsServers };

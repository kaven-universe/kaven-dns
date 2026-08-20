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
function createDnsServers({ resolver, logs, port }) {
  async function handle(request, send, client) {
    const started = Date.now();
    const clientIp =
      (client && (client.address || client.remoteAddress)) || 'unknown';
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

  const udp = new UDPServer(handle);
  const tcp = new TCPServer(handle);
  const onErr = e => console.error('[dns] request error:', e.message);
  udp.on('requestError', onErr);
  tcp.on('requestError', onErr);

  async function start() {
    await udp.listen(port);
    await tcp.listen(port);
  }

  function close() {
    udp.close();
    tcp.close();
  }

  return { udp, tcp, start, close };
}

module.exports = { createDnsServers };

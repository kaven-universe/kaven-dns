'use strict';

const { Packet } = require('dns2');

// Numeric type → type name string required by the dns2 client (1 → 'A')
const TYPE_NAMES = {};
for (const [name, num] of Object.entries(Packet.TYPE)) {
  if (!(num in TYPE_NAMES)) TYPE_NAMES[num] = name;
}

function typeName(num) {
  return TYPE_NAMES[num] || `TYPE${num}`;
}

// Compact answer summary for logs/API display, e.g. "220.181.38.148, 220.181.38.251"
function summarizeAnswers(answers, max = 3) {
  const list = answers || [];
  if (!list.length) return '';
  const parts = list.slice(0, max).map(a => {
    if (a.address) return a.address;
    if (a.domain) return a.domain;
    if (a.data) return `${typeName(a.type)}(${a.data.length}B)`;
    return typeName(a.type);
  });
  const suffix = list.length > max ? ` … ${list.length} records` : '';
  return parts.join(', ') + suffix;
}

module.exports = { TYPE_NAMES, typeName, summarizeAnswers };

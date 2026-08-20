'use strict';

/**
 * Domain matching:
 *  - Rule `example.com`    matches example.com itself and all subdomains (dnsmasq style)
 *  - Rule `*.example.com`  matches subdomains only, not example.com itself
 *  - Priority: rules with more labels (longer suffix) are more specific and win;
 *    among equal label counts, plain rules beat wildcards
 */

function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function matchDomain(pattern, domain) {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return domain.endsWith('.' + base);
  }
  return domain === pattern || domain.endsWith('.' + pattern);
}

/**
 * Find the most specific rule matching (domain, typeName), or null.
 * Record types must match exactly; CNAME rules also participate in A/AAAA
 * queries (the resolver recursively resolves the target).
 */
function findMatch(rules, domain, typeName) {
  let best = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const typeOk =
      rule.type === typeName ||
      (rule.type === 'CNAME' && (typeName === 'A' || typeName === 'AAAA'));
    if (!typeOk || !matchDomain(rule.domain, domain)) continue;
    const labels = rule.domain.replace(/^\*\./, '').split('.').length;
    const notWildcard = rule.domain.startsWith('*.') ? 0 : 1;
    const score = labels * 10 + notWildcard;
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

module.exports = { normalizeDomain, matchDomain, findMatch };

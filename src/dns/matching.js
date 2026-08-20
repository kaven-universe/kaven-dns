'use strict';

/**
 * Domain matching:
 *  - Pattern `example.com`    matches example.com itself and all subdomains (dnsmasq style)
 *  - Pattern `*.example.com`  matches subdomains only, not example.com itself
 *  - A rule holds a group of domain patterns sharing one configuration;
 *    a query matches the rule when it matches any pattern in the group
 *  - Priority: patterns with more labels (longer suffix) are more specific and win;
 *    among equal label counts, plain patterns beat wildcards. When different
 *    rules tie on specificity, the NEWER rule (later in the list) wins, so an
 *    override added after a group rule takes effect.
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

function patternScore(pattern) {
  const labels = pattern.replace(/^\*\./, '').split('.').length;
  const notWildcard = pattern.startsWith('*.') ? 0 : 1;
  return labels * 10 + notWildcard;
}

/**
 * Find the most specific rule matching (domain, typeName). Returns
 * { rule, pattern } where `pattern` is the domain pattern that matched
 * (useful for logs when a rule holds many domains), or null.
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
    if (!typeOk) continue;
    for (const pattern of rule.domains || []) {
      if (!matchDomain(pattern, domain)) continue;
      const score = patternScore(pattern);
      // >= : on ties the newer rule (later in the array) wins
      if (score >= bestScore) {
        bestScore = score;
        best = { rule, pattern };
      }
    }
  }
  return best;
}

module.exports = { normalizeDomain, matchDomain, findMatch };

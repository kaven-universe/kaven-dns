'use strict';

/**
 * Minimal backend i18n for user-facing API error messages (zh / en).
 * The language is negotiated from the Accept-Language header sent by the
 * Web console; anything not starting with "zh" falls back to English.
 * Console/startup logs are intentionally English-only.
 */

const MESSAGES = {
  en: {
    'auth.incorrect_password': 'Incorrect password',
    'auth.too_many_attempts': 'Too many attempts; retry in {s} seconds',
    'auth.not_signed_in': 'Not signed in or session expired',

    'rules.domain_required': 'Domain is required',
    'rules.domain_invalid':
      'Invalid domain format (wildcards like *.example.com are supported)',
    'rules.type_invalid': 'Record type must be A / AAAA / CNAME',
    'rules.mode_invalid': 'Mode must be fixed or forward',
    'rules.fixed_value_required': 'Fixed mode requires an IP or CNAME target',
    'rules.a_ipv4': 'A record value must be an IPv4 address (comma-separated for multiple)',
    'rules.aaaa_ipv6': 'AAAA record value must be an IPv6 address (comma-separated for multiple)',
    'rules.cname_single': 'CNAME can only have one target domain',
    'rules.cname_invalid': 'CNAME target must be a valid domain',
    'rules.upstream_invalid': 'Invalid upstream format; expected an IPv4 or IPv4:port',
    'rules.ttl_invalid': 'TTL must be an integer between 1 and 86400 (seconds)',
    'rules.not_found': 'Rule not found',

    'config.upstream_bad': 'Invalid upstream format: {list}',
    'config.upstream_required': 'At least one upstream DNS server is required',
    'config.upstream_max': 'At most 8 upstreams are allowed',
    'config.must_be_number': '{key} must be a number',
    'config.port_range': '{key} must be an integer between 1 and 65535',
    'config.current_password_incorrect': 'Current password is incorrect',
    'config.password_min': 'New password must be at least 6 characters',

    'resolve.domain_required': 'Domain is required',
    'resolve.unsupported_type': 'Unsupported type {type}',

    'api.not_found': 'API not found',
    'api.invalid_json': 'Request body is not valid JSON',
    'api.internal_error': 'Internal server error',
  },
  zh: {
    'auth.incorrect_password': '密码错误',
    'auth.too_many_attempts': '尝试过于频繁，请 {s} 秒后重试',
    'auth.not_signed_in': '未登录或会话已过期',

    'rules.domain_required': '域名不能为空',
    'rules.domain_invalid': '域名格式不正确（支持 *.example.com 通配符）',
    'rules.type_invalid': '记录类型必须是 A / AAAA / CNAME',
    'rules.mode_invalid': '解析模式必须是 fixed（固定应答）或 forward（转发）',
    'rules.fixed_value_required': '固定应答需要填写 IP 或 CNAME 目标',
    'rules.a_ipv4': 'A 记录的值必须是 IPv4 地址（多个用逗号分隔）',
    'rules.aaaa_ipv6': 'AAAA 记录的值必须是 IPv6 地址（多个用逗号分隔）',
    'rules.cname_single': 'CNAME 只能有一个目标域名',
    'rules.cname_invalid': 'CNAME 目标必须是合法域名',
    'rules.upstream_invalid': '上游 DNS 格式不正确，应为 IPv4 或 IPv4:端口',
    'rules.ttl_invalid': 'TTL 必须是 1-86400 之间的整数（秒）',
    'rules.not_found': '规则不存在',

    'config.upstream_bad': '上游格式不正确: {list}',
    'config.upstream_required': '至少需要一个上游 DNS',
    'config.upstream_max': '上游最多 8 个',
    'config.must_be_number': '{key} 必须是数字',
    'config.port_range': '{key} 必须是 1-65535 的整数',
    'config.current_password_incorrect': '当前密码不正确',
    'config.password_min': '新密码至少 6 位',

    'resolve.domain_required': '域名不能为空',
    'resolve.unsupported_type': '不支持的类型 {type}',

    'api.not_found': '接口不存在',
    'api.invalid_json': '请求体不是合法 JSON',
    'api.internal_error': '服务器内部错误',
  },
};

function normalizeLang(acceptLanguage) {
  return String(acceptLanguage || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Translate `key` in `lang` with `{placeholder}` interpolation. */
function t(lang, key, args = {}) {
  const dict = MESSAGES[lang === 'zh' ? 'zh' : 'en'] || MESSAGES.en;
  let s = dict[key] ?? MESSAGES.en[key] ?? key;
  for (const [k, v] of Object.entries(args)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

module.exports = { t, normalizeLang };

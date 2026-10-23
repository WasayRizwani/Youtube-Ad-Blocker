(function (root) {
  'use strict';
  const DEFAULTS = { enabled: true, allowedHosts: [] };
  function hostname(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url.hostname.toLowerCase().replace(/\.$/, '');
    } catch { return null; }
  }
  function normalize(value = {}) {
    return {
      enabled: value.enabled !== false,
      allowedHosts: [...new Set((Array.isArray(value.allowedHosts) ? value.allowedHosts : [])
        .map(hostname).filter(Boolean))].sort()
    };
  }
  function isAllowed(host, settings) {
    host = hostname(host);
    return !!host && settings.allowedHosts.some(site => host === site || host.endsWith(`.${site}`));
  }
  function exceptionRules(settings) {
    if (!settings.enabled) return [];
    return settings.allowedHosts.flatMap((host, index) => [
      {
        id: 10000 + index * 2, priority: 100,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] }
      },
      {
        id: 10001 + index * 2, priority: 100,
        action: { type: 'allow' },
        condition: { initiatorDomains: [host] }
      }
    ]);
  }
  const api = { DEFAULTS, hostname, normalize, isAllowed, exceptionRules };
  root.QuietBrowse = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

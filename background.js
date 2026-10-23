'use strict';
importScripts('core.js');
const RULESETS = ['ads', 'easylist'];

let queue = Promise.resolve();
async function apply(settings) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(rule => rule.id),
    addRules: QuietBrowse.exceptionRules(settings)
  });
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: settings.enabled ? RULESETS : [],
    disableRulesetIds: settings.enabled ? [] : RULESETS
  });
  await chrome.action.setBadgeText({ text: settings.enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
}
async function read() {
  return QuietBrowse.normalize((await chrome.storage.local.get('settings')).settings);
}
function enqueue(operation) {
  const result = queue.then(operation);
  queue = result.catch(error => console.error('QuietBrowse:', error));
  return result;
}
enqueue(async () => { const settings = await read(); await apply(settings); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Settings can only be changed from this extension's own pages.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  enqueue(async () => {
    const previous = await read();
    if (message.type === 'GET_STATE') return previous;
    const next = QuietBrowse.normalize(previous);
    if (message.type === 'SET_ENABLED' && typeof message.enabled === 'boolean') {
      next.enabled = message.enabled;
    } else if (message.type === 'SET_SITE_ALLOWED' && typeof message.allowed === 'boolean') {
      const host = QuietBrowse.hostname(message.host);
      if (!host) throw new Error('Choose a normal website tab first.');
      if (message.allowed) next.allowedHosts = [...new Set([...next.allowedHosts, host])];
      else next.allowedHosts = next.allowedHosts.filter(site => host !== site && !host.endsWith(`.${site}`));
    } else throw new Error('Unknown settings request.');
    if (next.allowedHosts.length > 500) throw new Error('The 500-site exception limit has been reached.');
    try {
      await apply(next);
      await chrome.storage.local.set({ settings: next });
    } catch (error) {
      await apply(previous);
      throw error;
    }
    return next;
  }).then(settings => respond({ settings }), error => respond({ error: error.message }));
  return true;
});

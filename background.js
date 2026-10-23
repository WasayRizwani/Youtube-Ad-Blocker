'use strict';
importScripts('core.js');
const RULESETS = ['ads', 'easylist'];

let queue = Promise.resolve();
let initializationError = null;
async function configureYouTube(settings) {
  const desired = QuietBrowse.youtubeScript(settings);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['quietbrowse-youtube'] });
  if (!desired) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['quietbrowse-youtube'] });
    return;
  }
  if (!existing.length) await chrome.scripting.registerContentScripts([desired]);
  else {
    const previous = existing[0];
    const same = Object.keys(desired).every(key => JSON.stringify(previous[key]) === JSON.stringify(desired[key]));
    if (!same) await chrome.scripting.updateContentScripts([desired]);
  }
}
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
  await configureYouTube(settings);
  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: settings.enabled
  });
  await chrome.action.setBadgeText({ text: settings.enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: settings.enabled ? '#196958' : '#64748b' });
}
async function read() {
  return QuietBrowse.normalize((await chrome.storage.local.get('settings')).settings);
}
function enqueue(operation) {
  const result = queue.then(operation);
  queue = result.catch(error => console.error('QuietBrowse:', error));
  return result;
}
enqueue(async () => {
  try { await apply(await read()); initializationError = null; }
  catch (error) { initializationError = error.message; throw error; }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Settings can only be changed from this extension's own pages.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) ||
      !message || typeof message !== 'object') return false;
  enqueue(async () => {
    const previous = await read();
    if (message.type === 'GET_STATE') return previous;
    if (message.type === 'GET_HEALTH') {
      const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['quietbrowse-youtube'] });
      return { version: chrome.runtime.getManifest().version,
        youtubeRegistered: scripts.length > 0, error: initializationError };
    }
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
      initializationError = null;
    } catch (error) {
      await apply(previous);
      throw error;
    }
    return next;
  }).then(result => respond(message.type === 'GET_HEALTH' ? { health: result } : { settings: result }),
    error => respond({ error: error.message }));
  return true;
});

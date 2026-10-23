'use strict';
const enabled = document.querySelector('#enabled');
const allowed = document.querySelector('#allowed');
const status = document.querySelector('#status');
const reload = document.querySelector('#reload');
let tab;
let host;
let busy = false;
function render(settings) {
  enabled.checked = settings.enabled;
  enabled.disabled = busy;
  allowed.checked = !!host && QuietBrowse.isAllowed(host, settings);
  allowed.disabled = busy || !host;
  reload.disabled = busy || !host;
  const list = document.querySelector('#exceptions');
  list.replaceChildren();
  for (const site of settings.allowedHosts) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = site;
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.disabled = busy;
    remove.setAttribute('aria-label', `Remove exception for ${site}`);
    remove.addEventListener('click', () => update({ type: 'SET_SITE_ALLOWED', host: site, allowed: false }));
    item.append(text, remove);
    list.append(item);
  }
  if (!settings.allowedHosts.length) list.textContent = 'No site exceptions.';
}
async function update(message) {
  if (busy) return;
  busy = true;
  enabled.disabled = allowed.disabled = reload.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response.error) throw new Error(response.error);
    status.textContent = 'Saved. Reload the page to apply request-blocking changes fully.';
  } catch (error) { status.textContent = error.message; }
  finally {
    busy = false;
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response.settings) render(response.settings);
  }
}
enabled.addEventListener('change', () => update({ type: 'SET_ENABLED', enabled: enabled.checked }));
allowed.addEventListener('change', () => update({ type: 'SET_SITE_ALLOWED', host, allowed: allowed.checked }));
reload.addEventListener('click', () => chrome.tabs.reload(tab.id).then(() => window.close()));
(async () => {
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    host = tab?.url && /^https?:/.test(tab.url) ? QuietBrowse.hostname(tab.url) : null;
    document.querySelector('#host').textContent = host || 'Open a normal website tab';
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response.error) throw new Error(response.error);
    render(response.settings);
    status.textContent = host ? 'Your preferences stay in this browser.' : 'Chrome internal pages and the Web Store cannot be filtered.';
  } catch (error) { status.textContent = error.message; }
})();

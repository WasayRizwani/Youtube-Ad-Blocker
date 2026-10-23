const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const core = require('../core.js');
const root = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version;

test('site exceptions respect hostname boundaries and include subdomains', () => {
  const settings = core.normalize({ allowedHosts: ['EXAMPLE.com', 'example.com', null] });
  assert.deepEqual(settings.allowedHosts, ['example.com']);
  assert.equal(core.isAllowed('https://www.example.com/watch', settings), true);
  assert.equal(core.isAllowed('notexample.com', settings), false);
  assert.equal(core.isAllowed('example.com.evil.test', settings), false);
  assert.equal(core.hostname('chrome://extensions'), null);
});

test('network exceptions cover frame requests and their resources', () => {
  const rules = core.exceptionRules(core.normalize({ allowedHosts: ['example.com', 'youtube.com'] }));
  assert.equal(new Set(rules.map(rule => rule.id)).size, 4);
  assert.equal(rules[0].action.type, 'allowAllRequests');
  assert.deepEqual(rules[0].condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.deepEqual(rules[1].condition.initiatorDomains, ['example.com']);
  assert.deepEqual(core.exceptionRules({ enabled: false, allowedHosts: ['example.com'] }), []);
});

test('packaged files exist and ad rules preserve top-level navigation and video CDN', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
  assert.ok(manifest.permissions.includes('scripting'));
  for (const file of [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.content_scripts.flatMap(item => item.js), ...manifest.declarative_net_request.rule_resources.map(item => item.path)]) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
  }
  assert.ok(fs.statSync(path.join(root, core.youtubeScript(core.normalize()).js[0])).isFile());
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules/ads.json')));
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  for (const rule of rules) assert.ok(!rule.condition.resourceTypes.includes('main_frame'));
  assert.ok(!JSON.stringify(rules).includes('googlevideo.com'));
});

function background(options = {}) {
  let listener;
  let saved;
  let rules = [];
  let enabled = ['ads'];
  let fail = false;
  let scripts = [];
  let failScript = options.failRegistration === true;
  let actionCountEnabled = false;
  const chrome = {
    runtime: { id: 'test-extension', getURL: file => `chrome-extension://test-extension/${file}`,
      getManifest: () => ({ version: VERSION }),
      onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get() { return { settings: saved }; },
      async set(value) { if (fail) { fail = false; throw new Error('Storage failure'); } saved = value.settings; }
    } },
    declarativeNetRequest: {
      async getDynamicRules() { return rules; },
      async updateDynamicRules(value) { rules = value.addRules; },
      async updateEnabledRulesets(value) { enabled = value.enableRulesetIds; },
      async setExtensionActionOptions(value) { actionCountEnabled = value.displayActionCountAsBadgeText; }
    },
    scripting: {
      async getRegisteredContentScripts() { return structuredClone(scripts); },
      async registerContentScripts(value) {
        if (failScript) { failScript = false; throw new Error('Script registration failed'); }
        scripts = structuredClone(value);
      },
      async updateContentScripts(value) { scripts = structuredClone(value); },
      async unregisterContentScripts() { scripts = []; }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), {
    chrome, QuietBrowse: core, importScripts() {}, console: { error() {} }
  });
  return {
    send: message => new Promise(resolve => listener(message, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }, resolve)),
    rejected: sender => listener({ type: 'SET_ENABLED', enabled: false }, sender, () => {}),
    network: () => ({ rules, enabled }),
    scripts: () => scripts,
    counterEnabled: () => actionCountEnabled,
    failNextSave() { fail = true; }
  };
}

test('background persists switches and removes inherited site exceptions', async () => {
  const app = background();
  assert.equal((await app.send({ type: 'GET_STATE' })).settings.enabled, true);
  assert.equal(app.counterEnabled(), true);
  await app.send({ type: 'SET_SITE_ALLOWED', host: 'example.com', allowed: true });
  assert.equal(app.network().rules.length, 2);
  await app.send({ type: 'SET_SITE_ALLOWED', host: 'www.example.com', allowed: false });
  assert.equal(app.network().rules.length, 0);
  await app.send({ type: 'SET_ENABLED', enabled: false });
  assert.equal(app.network().enabled.length, 0);
  assert.equal(app.counterEnabled(), false);
  assert.equal((await app.send({ type: 'GET_STATE' })).settings.enabled, false);
  await app.send({ type: 'SET_ENABLED', enabled: true });
  assert.deepEqual(Array.from(app.network().enabled), ['ads', 'easylist']);
  assert.equal(app.counterEnabled(), true);
});

test('YouTube MAIN script runs early, persists, and excludes only allowed websites', () => {
  const script = core.youtubeScript(core.normalize());
  assert.equal(script.world, 'MAIN');
  assert.equal(script.runAt, 'document_start');
  assert.equal(script.persistAcrossSessions, true);
  assert.equal(script.allFrames, false);
  assert.deepEqual(core.youtubeScript(core.normalize({ enabled: false })), null);
  assert.deepEqual(core.youtubeScript(core.normalize({ allowedHosts: ['youtube.com', 'youtube-nocookie.com'] })), null);
  const partiallyAllowed = core.youtubeScript(core.normalize({ allowedHosts: ['www.youtube.com', 'example.com'] }));
  assert.deepEqual(partiallyAllowed.excludeMatches, ['*://*.www.youtube.com/*']);
  assert.equal(partiallyAllowed.matches.length, 2);
  assert.deepEqual(core.youtubeScript(core.normalize({ allowedHosts: ['youtube.com'] })).matches, ['*://*.youtube-nocookie.com/*']);
});

test('background keeps MAIN registration in sync with site exceptions and global switch', async () => {
  const app = background();
  const health = await app.send({ type: 'GET_HEALTH' });
  assert.equal(health.health.youtubeRegistered, true);
  assert.equal(health.health.error, null);
  assert.equal(health.health.version, VERSION);
  await app.send({ type: 'SET_SITE_ALLOWED', host: 'www.youtube.com', allowed: true });
  assert.deepEqual(Array.from(app.scripts()[0].excludeMatches), ['*://*.www.youtube.com/*']);
  await app.send({ type: 'SET_ENABLED', enabled: false });
  assert.equal(app.scripts().length, 0);
  await app.send({ type: 'SET_ENABLED', enabled: true });
  assert.deepEqual(Array.from(app.scripts()[0].excludeMatches), ['*://*.www.youtube.com/*']);
  await app.send({ type: 'SET_SITE_ALLOWED', host: 'www.youtube.com', allowed: false });
  assert.equal(app.scripts()[0].excludeMatches.length, 0);
});

test('initialization errors remain visible in health instead of reporting a ready filter', async () => {
  const app = background({ failRegistration: true });
  const result = await app.send({ type: 'GET_HEALTH' });
  assert.equal(result.health.youtubeRegistered, false);
  assert.equal(result.health.error, 'Script registration failed');
  await app.send({ type: 'SET_ENABLED', enabled: true });
  assert.equal((await app.send({ type: 'GET_HEALTH' })).health.error, null);
  assert.equal(app.scripts().length, 1);
});

test('failed persistence restores network configuration and queue remains usable', async () => {
  const app = background();
  await app.send({ type: 'GET_STATE' });
  app.failNextSave();
  const result = await app.send({ type: 'SET_ENABLED', enabled: false });
  assert.equal(result.error, 'Storage failure');
  assert.deepEqual(Array.from(app.network().enabled), ['ads', 'easylist']);
  assert.equal((await app.send({ type: 'GET_STATE' })).settings.enabled, true);
});

test('content scripts and foreign senders cannot modify preferences', () => {
  const app = background();
  assert.equal(app.rejected({ id: 'test-extension', tab: { id: 1 } }), false);
  assert.equal(app.rejected({ id: 'other' }), false);
  assert.equal(app.rejected({ id: 'test-extension', url: 'https://www.youtube.com/watch?v=test' }), false);
});

test('expanded domain rules cover common networks and preserve first-party resources', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules/easylist.json')));
  const domains = rules.flatMap(rule => rule.condition.requestDomains);
  assert.ok(domains.length > 40000);
  assert.equal(new Set(domains).size, domains.length);
  for (const domain of ['adform.net', 'paid.outbrain.com']) assert.ok(domains.includes(domain), domain);
  for (const rule of rules) {
    assert.equal(rule.condition.domainType, 'thirdParty');
    assert.ok(!rule.condition.resourceTypes.includes('main_frame'));
    assert.ok(rule.condition.requestDomains.every(domain => !['youtube.com', 'googlevideo.com', 'ytimg.com'].some(host => domain === host || domain.endsWith('.' + host))));
  }
});

test('filter converter never broadens conditional or path-based entries', () => {
  const output = execFileSync('python3', ['-c', `
import json, runpy
convert = runpy.run_path('scripts/update_ad_domains.py')['domains_from']
sample = '''||ads.example^
||ads.example^
||conditional.example^$domain=news.example
||typed.example^$script
||path.example/ad.js
@@||allowed.example^
||googlevideo.com^
||r1.googlevideo.com^
! comment
'''
print(json.dumps(convert(sample)))
`], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), ['ads.example']);
});

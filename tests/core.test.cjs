const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../core.js');
const root = path.resolve(__dirname, '..');

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
  for (const file of [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.content_scripts.flatMap(item => item.js), ...manifest.declarative_net_request.rule_resources.map(item => item.path)]) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
  }
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules/ads.json')));
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  for (const rule of rules) assert.ok(!rule.condition.resourceTypes.includes('main_frame'));
  assert.ok(!JSON.stringify(rules).includes('googlevideo.com'));
});

function background() {
  let listener;
  let saved;
  let rules = [];
  let enabled = ['ads'];
  let fail = false;
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get() { return { settings: saved }; },
      async set(value) { if (fail) { fail = false; throw new Error('Storage failure'); } saved = value.settings; }
    } },
    declarativeNetRequest: {
      async getDynamicRules() { return rules; },
      async updateDynamicRules(value) { rules = value.addRules; },
      async updateEnabledRulesets(value) { enabled = value.enableRulesetIds; }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), {
    chrome, QuietBrowse: core, importScripts() {}, console: { error() {} }
  });
  return {
    send: message => new Promise(resolve => listener(message, { id: 'test-extension' }, resolve)),
    rejected: sender => listener({ type: 'SET_ENABLED', enabled: false }, sender, () => {}),
    network: () => ({ rules, enabled }),
    failNextSave() { fail = true; }
  };
}

test('background persists switches and removes inherited site exceptions', async () => {
  const app = background();
  assert.equal((await app.send({ type: 'GET_STATE' })).settings.enabled, true);
  await app.send({ type: 'SET_SITE_ALLOWED', host: 'example.com', allowed: true });
  assert.equal(app.network().rules.length, 2);
  await app.send({ type: 'SET_SITE_ALLOWED', host: 'www.example.com', allowed: false });
  assert.equal(app.network().rules.length, 0);
  await app.send({ type: 'SET_ENABLED', enabled: false });
  assert.equal(app.network().enabled.length, 0);
  assert.equal((await app.send({ type: 'GET_STATE' })).settings.enabled, false);
  await app.send({ type: 'SET_ENABLED', enabled: true });
  assert.deepEqual(Array.from(app.network().enabled), ['ads']);
});

test('failed persistence restores network configuration and queue remains usable', async () => {
  const app = background();
  await app.send({ type: 'GET_STATE' });
  app.failNextSave();
  const result = await app.send({ type: 'SET_ENABLED', enabled: false });
  assert.equal(result.error, 'Storage failure');
  assert.deepEqual(Array.from(app.network().enabled), ['ads']);
  assert.equal((await app.send({ type: 'GET_STATE' })).settings.enabled, true);
});

test('content scripts and foreign senders cannot modify preferences', () => {
  const app = background();
  assert.equal(app.rejected({ id: 'test-extension', tab: { id: 1 } }), false);
  assert.equal(app.rejected({ id: 'other' }), false);
});

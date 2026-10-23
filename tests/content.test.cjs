const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../core.js');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');

async function page({host = 'www.youtube.com', hasPlayer = true, script = source} = {}) {
  let time = 0;
  let sequence = 0;
  let storageListener;
  const timers = new Map();
  const observers = new Set();
  const calls = {lookups: 0, skipScans: 0, timerCallbacks: 0};
  const root = {parent: null};
  const outside = {parent: root};
  let player;
  const contains = (ancestor, node) => {
    for (let current = node; current; current = current.parent) if (current === ancestor) return true;
    return false;
  };
  function mutate(target, type, attributeName) {
    for (const observer of [...observers]) {
      const {options, node} = observer;
      if (node !== target && (!options.subtree || !contains(node, target))) continue;
      if (type === 'attributes' && (!options.attributes ||
          (options.attributeFilter && !options.attributeFilter.includes(attributeName)))) continue;
      if (type === 'childList' && !options.childList) continue;
      observer.callback([{target, type, attributeName}]);
    }
  }
  function makePlayer(id = 'movie_player') {
    const value = {
      id, parent: root, isConnected: true, ad: false, buttons: [],
      classList: {contains: name => name === 'ad-showing' && value.ad},
      querySelectorAll() { calls.skipScans++; return value.buttons; }
    };
    return value;
  }
  if (hasPlayer) player = makePlayer();
  function addButton(options = {}) {
    const parent = player;
    const button = {
      parent, disabled: false, ariaDisabled: false, rendered: true,
      visibility: 'visible', clicks: 0, finish: true,
      getAttribute: name => name === 'aria-disabled' && button.ariaDisabled ? 'true' : null,
      getClientRects: () => button.rendered ? [{}] : [],
      click() {
        button.clicks++;
        if (button.finish) { parent.ad = false; mutate(parent, 'attributes', 'class'); }
      },
      ...options
    };
    parent.buttons.push(button);
    mutate(parent, 'childList');
    return button;
  }
  function schedule(callback, delay, interval = false) {
    const id = ++sequence;
    timers.set(id, {callback, at: time + delay, interval: interval ? delay : 0});
    return id;
  }
  const context = {
    QuietBrowse: core,
    location: {hostname: host, origin: `https://${host}`},
    document: {
      documentElement: root, head: {append() {}},
      createElement: () => ({remove() {}}),
      getElementById() { calls.lookups++; return player?.id === 'movie_player' ? player : null; },
      querySelector() { calls.lookups++; return player?.id === 'movie_player' ? player : null; },
      addEventListener() {}
    },
    chrome: {
      storage: {local: {get: async () => ({settings: core.normalize()})},
        onChanged: {addListener(fn) {storageListener = fn;}}},
      runtime: {id: 'test-extension', onMessage: {addListener() {}}}
    },
    MutationObserver: class {
      constructor(callback) {this.callback = callback;}
      observe(node, options) {this.node = node; this.options = options; observers.add(this);}
      disconnect() {observers.delete(this);}
    },
    getComputedStyle: element => ({visibility: element.visibility}),
    performance: {now: () => time},
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: id => timers.delete(id),
    addEventListener() {}, postMessage() {}
  };
  context.window = context;
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    calls, timers, observers, addButton,
    player: () => player,
    mutate,
    setAd(value) {player.ad = value; mutate(player, 'attributes', 'class');},
    outsideClass() {mutate(outside, 'attributes', 'class');},
    outsideChildren() {mutate(outside, 'childList');},
    replacePlayer() {
      if (player) {player.isConnected = false; player.parent = null;}
      player = makePlayer();
      mutate(root, 'childList');
      return player;
    },
    addPlaceholder() {
      player = makePlayer('placeholder');
      mutate(root, 'childList');
      return player;
    },
    identifyPlayer() {player.id = 'movie_player'; mutate(player, 'attributes', 'id');},
    transferPlayerId() {
      const previous = player;
      previous.id = 'retired_player';
      // The next node was already attached; this handoff changes IDs only.
      player = makePlayer();
      mutate(previous, 'attributes', 'id');
      mutate(player, 'attributes', 'id');
      return previous;
    },
    prefs(value) {storageListener({settings: {newValue: core.normalize(value)}}, 'local');},
    advance(milliseconds) {
      const end = time + milliseconds;
      let executions = 0;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++executions < 10000, 'timer loop should remain bounded');
        const [id, timer] = next;
        timers.delete(id); time = timer.at;
        if (timer.interval) timers.set(id, {...timer, at: time + timer.interval});
        calls.timerCallbacks++;
        timer.callback();
      }
      time = end;
    }
  };
}

test('normal playback does no periodic scanning or unrelated page lookups', async () => {
  const app = await page();
  const before = {...app.calls};
  for (let index = 0; index < 1000; index++) {
    app.outsideClass();
    app.outsideChildren();
    app.mutate(app.player(), 'attributes', 'class');
  }
  app.advance(60000);
  assert.deepEqual(app.calls, before);
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls.skipScans, 0);
});

test('mutation bursts cause one skip scan and skip only a visible enabled button', async () => {
  const app = await page();
  app.setAd(true);
  const hidden = app.addButton({rendered: false});
  const disabled = app.addButton({disabled: true});
  const ariaDisabled = app.addButton({ariaDisabled: true});
  const invisible = app.addButton({visibility: 'hidden'});
  const visible = app.addButton();
  for (let index = 0; index < 200; index++) app.mutate(app.player(), 'attributes', 'class');
  app.advance(50);
  assert.equal(app.calls.skipScans, 1);
  assert.equal(visible.clicks, 1);
  for (const button of [hidden, disabled, ariaDisabled, invisible]) assert.equal(button.clicks, 0);
  assert.equal(app.timers.size, 0);
});

test('a late player and replacement player both get working skip controls', async () => {
  const app = await page({hasPlayer: false});
  app.advance(60000);
  assert.equal(app.calls.timerCallbacks, 0);
  app.replacePlayer();
  app.setAd(true);
  const first = app.addButton();
  app.advance(50);
  assert.equal(first.clicks, 1);
  app.replacePlayer();
  app.setAd(true);
  const second = app.addButton();
  app.advance(50);
  assert.equal(second.clicks, 1);
  assert.equal(app.observers.size, 2);
});

test('an attached placeholder gains a player ID without another child-list mutation', async () => {
  const app = await page({hasPlayer: false});
  app.addPlaceholder();
  app.advance(50);
  app.setAd(true);
  const button = app.addButton();
  app.advance(50);
  assert.equal(button.clicks, 0);
  app.identifyPlayer();
  app.advance(50);
  assert.equal(button.clicks, 1);
  assert.equal(app.timers.size, 0);
});

test('player ID transfer works when the previous player stays connected', async () => {
  const app = await page();
  app.setAd(true);
  const retiredButton = app.addButton({finish: false});
  const retiredPlayer = app.transferPlayerId();
  app.setAd(true);
  const currentButton = app.addButton();
  app.advance(50);
  assert.equal(retiredPlayer.isConnected, true);
  assert.equal(retiredButton.clicks, 0);
  assert.equal(currentButton.clicks, 1);
  assert.equal(app.observers.size, 2);
  assert.equal(app.timers.size, 0);
});

test('controls enabled by attributes or revealed without a mutation are eventually skipped', async () => {
  const app = await page();
  app.setAd(true);
  const disabled = app.addButton({disabled: true});
  app.advance(50);
  assert.equal(disabled.clicks, 0);
  disabled.disabled = false;
  app.mutate(disabled, 'attributes', 'disabled');
  app.advance(50);
  assert.equal(disabled.clicks, 1);
  app.player().buttons = [];
  app.setAd(true);
  const hidden = app.addButton({visibility: 'hidden'});
  app.advance(50);
  assert.equal(hidden.clicks, 0);
  hidden.visibility = 'visible'; // For example, an ancestor CSS animation ends.
  app.advance(1000);
  assert.equal(hidden.clicks, 1);
  assert.equal(app.timers.size, 0);
});

test('ad-only retries preserve click throttling and stop when the ad state clears', async () => {
  const app = await page();
  app.setAd(true);
  const button = app.addButton({finish: false});
  app.advance(50);
  assert.equal(button.clicks, 1);
  app.mutate(button, 'attributes', 'class');
  app.advance(50);
  assert.equal(button.clicks, 1);
  app.advance(1000);
  assert.equal(button.clicks, 2);
  app.setAd(false);
  assert.equal(app.timers.size, 0);
  const scans = app.calls.skipScans;
  app.advance(60000);
  assert.equal(app.calls.skipScans, scans);
});

test('disabling or allowing the site cancels pending checks and re-enabling recovers', async () => {
  const app = await page();
  app.setAd(true);
  const button = app.addButton();
  app.prefs({enabled: false});
  assert.equal(app.observers.size, 0);
  assert.equal(app.timers.size, 0);
  app.advance(60000);
  assert.equal(button.clicks, 0);
  app.prefs({enabled: true});
  assert.equal(button.clicks, 1);
  app.setAd(true);
  app.prefs({allowedHosts: ['youtube.com']});
  assert.equal(app.observers.size, 0);
  assert.equal(app.timers.size, 0);
  app.advance(60000);
  assert.equal(button.clicks, 1);
});

test('ordinary websites do not install player observers or polling timers', async () => {
  const app = await page({host: 'news.example'});
  assert.equal(app.observers.size, 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls.lookups, 0);
});

module.exports = {page};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { prunePlayer, pruneText } = require('../youtube-main.js');
const source = fs.readFileSync(path.resolve(__dirname, '../youtube-main.js'), 'utf8');

function player() {
  return {
    adPlacements: [{ adPlacementRenderer: {} }], playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }], adSlots: [{ slot: 1 }],
    playabilityStatus: { status: 'OK', contextParams: 'signed-context' },
    streamingData: { adaptiveFormats: [{ url: 'https://media.example/signed?signature=secret', mimeType: 'video/mp4' }] },
    videoDetails: { videoId: 'ordinary-video', title: 'Ordinary video' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
    responseContext: { serviceTrackingParams: [] }, unrelated: { adSlots: ['ordinary nested metadata'] }
  };
}

test('known player ad fields are removed while all playback fields and input survive', () => {
  const original = player();
  const result = prunePlayer(original);
  assert.equal(result.removed, 3);
  assert.equal(Object.hasOwn(result.value, 'adPlacements'), false);
  assert.equal(Object.hasOwn(result.value, 'playerAds'), false);
  assert.equal(Object.hasOwn(result.value, 'adSlots'), false);
  for (const key of ['playabilityStatus', 'streamingData', 'videoDetails', 'captions', 'responseContext', 'unrelated']) {
    assert.equal(result.value[key], original[key], key);
  }
  assert.ok(original.adPlacements);
});

test('ad-key getters are not evaluated and unrelated descriptors or symbols are preserved', () => {
  const original = player();
  const symbol = Symbol('ordinary metadata');
  Object.defineProperty(original, 'hiddenMetadata', { value: 'keep nonenumerable', enumerable: false, writable: false });
  original[symbol] = 'keep symbol';
  Object.defineProperty(original, 'playerAds', { configurable: true, enumerable: true, get() { throw new Error('Do not evaluate ad metadata'); } });
  const result = prunePlayer(original);
  assert.equal(result.removed, 3);
  assert.equal(result.value.hiddenMetadata, 'keep nonenumerable');
  assert.equal(Object.getOwnPropertyDescriptor(result.value, 'hiddenMetadata').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(result.value, 'hiddenMetadata').writable, false);
  assert.equal(result.value[symbol], 'keep symbol');
  const page = harness(); page.context.payload = original;
  page.run('window.ytInitialPlayerResponse = payload');
  assert.equal(page.run('ytInitialPlayerResponse.hiddenMetadata'), 'keep nonenumerable');
  assert.equal(page.run('ytInitialPlayerResponse.playerAds'), undefined);
});

test('explicit player wrappers and XSSI JSON are supported without recursive deletion', () => {
  const input = { playerResponse: player(), ordinary: { adPlacements: ['keep'] } };
  const result = prunePlayer(input);
  assert.equal(result.removed, 3);
  assert.equal(result.value.ordinary, input.ordinary);
  const prefixed = ")]}'\n" + JSON.stringify({ player_response: JSON.stringify(player()) });
  const parsed = pruneText(prefixed);
  assert.equal(parsed.removed, 3);
  assert.ok(parsed.value.startsWith(")]}'\n"));
  assert.equal(JSON.parse(JSON.parse(parsed.value.slice(5)).player_response).videoDetails.videoId, 'ordinary-video');
});

test('unchanged, malformed, binary-like, cyclic, and excessively nested data fail open', () => {
  for (const value of [null, 1, 'text', [], { videoDetails: { adSlots: [1] } }]) {
    assert.equal(prunePlayer(value).value, value);
  }
  for (const text of ['not JSON', 'null', '[{"adSlots":[]}]', '{"streamingData":{}}']) {
    assert.equal(pruneText(text).value, text);
  }
  const cyclic = {}; cyclic.playerResponse = cyclic;
  assert.equal(prunePlayer(cyclic).removed, 0);
  let deep = player(); for (let i = 0; i < 100; i++) deep = { playerResponse: deep };
  assert.equal(prunePlayer(deep).removed, 0);
});

function harness(host = 'www.youtube.com', before) {
  const listeners = new Map();
  const messages = [];
  const xhrData = new WeakMap();
  let factory = () => response(player());
  const calls = [];
  class XMLHttpRequest {
    constructor() {
      xhrData.set(this, { raw: '', response: '' });
      this.readyState = 0; this.responseType = ''; this.responseURL = '';
    }
    open(method, url) {
      if (!xhrData.has(this)) throw new TypeError('Illegal receiver');
      this.readyState = 1;
      this.responseURL = new URL(url, `https://${host}/watch?v=example`).href;
      xhrData.set(this, { raw: '', response: '' });
    }
    get responseText() {
      if (!xhrData.has(this)) throw new TypeError('Illegal receiver');
      if (!['', 'text'].includes(this.responseType)) throw new DOMException('Wrong response type', 'InvalidStateError');
      return xhrData.get(this).raw;
    }
    get response() {
      if (!xhrData.has(this)) throw new TypeError('Illegal receiver');
      return xhrData.get(this).response;
    }
    finish(value) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      xhrData.set(this, { raw: text, response: this.responseType === 'json' ? value : this.responseType === 'arraybuffer' ? value : text });
      this.readyState = 4;
    }
  }
  function response(value, url = `https://${host}/youtubei/v1/player`, init = {}) {
    const result = new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'content-length': '999', 'x-preserved': 'yes' }, ...init
    });
    Object.defineProperty(result, 'url', { value: url });
    Object.defineProperty(result, 'redirected', { value: true });
    return result;
  }
  const context = {
    document: {}, location: { hostname: host, href: `https://${host}/watch?v=example`, origin: `https://${host}` },
    URL, Headers, Response, Request, queueMicrotask, XMLHttpRequest,
    fetch: function fetch(...args) { calls.push({ receiver: this, args }); return Promise.resolve(factory(...args)); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    postMessage(value) { messages.push(value); },
    console
  };
  context.window = context;
  before?.(context);
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    context, messages, calls, response,
    factory(fn) { factory = fn; },
    control(enabled, foreign = false) {
      context.__deliverMessage = listeners.get('message');
      context.__controlEnabled = enabled;
      context.__foreignControl = foreign;
      vm.runInContext(`__deliverMessage?.({source: __foreignControl ? {} : window, origin: location.origin,
        data: {source: 'quietbrowse-control', enabled: __controlEnabled}})`, context);
    },
    run: code => vm.runInContext(code, context)
  };
}

test('initial player response assignments and reassignments are cleaned before reads', () => {
  const page = harness();
  page.context.payload = player();
  page.run('var ytInitialPlayerResponse = payload;');
  assert.equal(page.run('ytInitialPlayerResponse.adSlots'), undefined);
  assert.equal(page.run('ytInitialPlayerResponse.videoDetails.videoId'), 'ordinary-video');
  page.run('ytInitialPlayerResponse = {adPlacements: [1], videoDetails: {videoId: "next"}}');
  assert.equal(page.run('ytInitialPlayerResponse.adPlacements'), undefined);
  assert.equal(page.run('ytInitialPlayerResponse.videoDetails.videoId'), 'next');
});

test('initial response updates never return stale ordinary playback metadata', () => {
  const page = harness(); page.context.payload = player();
  page.run('window.ytInitialPlayerResponse = payload; window.playerResponse = {playerResponse: payload}');
  const first = page.run('ytInitialPlayerResponse');
  assert.equal(page.run('ytInitialPlayerResponse'), first);
  page.run('payload.streamingData = {adaptiveFormats: [{url: "https://media.example/replacement"}]}');
  assert.equal(page.run('ytInitialPlayerResponse.streamingData.adaptiveFormats[0].url'), 'https://media.example/replacement');
  page.run('payload.videoDetails = {videoId: "updated-video"}');
  assert.equal(page.run('playerResponse.playerResponse.videoDetails.videoId'), 'updated-video');
  assert.equal(page.run('playerResponse.playerResponse.adPlacements'), undefined);
});

test('initial setter cleans assignment expressions while preserving writes through every reference', () => {
  const page = harness(); page.context.payload = player();
  page.run('window.assigned = (window.ytInitialPlayerResponse = payload)');
  assert.equal(page.run('assigned.adSlots'), undefined);
  assert.equal(page.run('assigned === payload && payload === ytInitialPlayerResponse'), true);
  page.run('ytInitialPlayerResponse.streamingData = {formats: ["changed through getter"]}; ytInitialPlayerResponse.custom = "keep"');
  assert.equal(page.run('payload.streamingData.formats[0]'), 'changed through getter');
  assert.equal(page.run('ytInitialPlayerResponse.custom'), 'keep');
  page.run('payload.videoDetails = {videoId: "changed through raw reference"}');
  assert.equal(page.run('ytInitialPlayerResponse.videoDetails.videoId'), 'changed through raw reference');
  page.run('delete ytInitialPlayerResponse.custom');
  assert.equal(page.run('payload.custom'), undefined);
  page.control(false);
  assert.ok(page.run('ytInitialPlayerResponse.adSlots'));
  assert.equal(page.run('ytInitialPlayerResponse.streamingData.formats[0]'), 'changed through getter');
  assert.equal(page.run('ytInitialPlayerResponse.videoDetails.videoId'), 'changed through raw reference');
});

test('read-only bootstrap data and page-owned CommonJS-style module are left alone', () => {
  const original = player();
  Object.freeze(original);
  const readonly = harness('www.youtube.com', context => {
    Object.defineProperty(context, 'ytInitialPlayerResponse', { value: original, configurable: false, writable: false });
    context.module = { exports: { pageOwned: true } };
  });
  assert.equal(readonly.run('ytInitialPlayerResponse'), original);
  assert.equal(readonly.run('module.exports.pageOwned'), true);
  assert.equal(readonly.run('module.exports.prunePlayer'), undefined);
  const page = harness(); page.context.payload = original;
  page.run('window.ytInitialPlayerResponse = payload');
  assert.equal(page.run('ytInitialPlayerResponse.adSlots'), undefined);
  assert.ok(original.adSlots);
});

test('legacy ytplayer config strings and raw player responses are cleaned', () => {
  const page = harness();
  page.context.payload = player();
  page.run('window.ytplayer = {config: {args: {player_response: JSON.stringify(payload), raw_player_response: payload}}};');
  assert.equal(page.run('JSON.parse(ytplayer.config.args.player_response).adSlots'), undefined);
  assert.equal(page.run('ytplayer.config.args.raw_player_response.streamingData.adaptiveFormats.length'), 1);
  assert.equal(page.run('ytplayer.config.args.raw_player_response.playerAds'), undefined);
});

test('fetch player response, text, clone metadata, headers, and body consumption are coherent', async () => {
  const page = harness();
  const request = new Request('https://www.youtube.com/youtubei/v1/player?key=example', { method: 'POST', body: '{}' });
  const init = { credentials: 'include' };
  const result = await page.context.fetch(request, init);
  assert.equal(page.calls[0].args[0], request);
  assert.equal(page.calls[0].args[1], init);
  assert.equal(page.calls[0].receiver, page.context);
  assert.equal(result.url, 'https://www.youtube.com/youtubei/v1/player');
  assert.equal(result.redirected, true);
  assert.equal(result.status, 200);
  assert.equal(result.statusText, 'OK');
  assert.equal(result.headers.get('x-preserved'), 'yes');
  assert.equal(result.headers.get('content-length'), null);
  assert.equal(result.bodyUsed, false);
  const clone = result.clone();
  assert.equal(clone.url, result.url);
  assert.equal(clone.redirected, result.redirected);
  const json = await result.json();
  assert.equal(result.bodyUsed, true);
  assert.equal(json.adSlots, undefined);
  assert.equal(json.streamingData.adaptiveFormats[0].url, player().streamingData.adaptiveFormats[0].url);
  assert.equal(JSON.parse(await clone.text()).playerAds, undefined);
  await assert.rejects(() => result.text(), TypeError);
});

test('fetch preserves non-player endpoints, malformed responses, redirects, and rejections', async () => {
  const page = harness();
  let original = page.response(player(), 'https://www.youtube.com/ordinary');
  page.factory(() => original);
  assert.equal(await page.context.fetch('https://www.youtube.com/ordinary'), original);
  original = page.response('not JSON');
  assert.equal(await page.context.fetch('https://www.youtube.com/youtubei/v1/player'), original);
  original = page.response(player(), 'https://accounts.example/login');
  assert.equal(await page.context.fetch('https://www.youtube.com/youtubei/v1/player'), original);
  original = page.response({ streamingData: { formats: ['ordinary'] } });
  assert.equal(await page.context.fetch('https://www.youtube.com/youtubei/v1/player'), original);
  const failure = new Error('network failed'); page.factory(() => { throw failure; });
  assert.throws(() => page.context.fetch('https://www.youtube.com/youtubei/v1/player'), error => error === failure);
  page.factory(() => Promise.reject(failure));
  await assert.rejects(page.context.fetch('https://www.youtube.com/youtubei/v1/player'), error => error === failure);
});

test('fetch body failure preserves the native response and body error', async () => {
  const page = harness();
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const original = new Response(stream);
  Object.defineProperty(original, 'url', { value: 'https://www.youtube.com/youtubei/v1/player' });
  page.factory(() => original);
  const request = page.context.fetch('https://www.youtube.com/youtubei/v1/player');
  await new Promise(resolve => setImmediate(resolve));
  controller.error(new DOMException('aborted', 'AbortError'));
  const result = await request;
  assert.equal(result, original);
  await assert.rejects(result.text(), { name: 'AbortError' });
});

test('get_watch and PBJ watch payloads are cleaned, while HTML stays unchanged', async () => {
  const page = harness();
  for (const url of ['https://www.youtube.com/youtubei/v1/get_watch', 'https://www.youtube.com/watch?v=example&pbj=1', 'https://www.youtube.com/playlist?list=example&pbj=1']) {
    page.factory(() => page.response([{ playerResponse: player() }, { adSlots: ['ordinary array metadata'] }], url));
    const result = await (await page.context.fetch(url)).json();
    assert.equal(result[0].playerResponse.adSlots, undefined);
    assert.deepEqual(result[1].adSlots, ['ordinary array metadata']);
  }
  const html = page.response('<!doctype html><title>Watch</title>', 'https://www.youtube.com/watch?v=example');
  page.factory(() => html);
  assert.equal(await page.context.fetch('https://www.youtube.com/watch?v=example'), html);
});

test('XHR text and JSON getters sanitize before any page event handler reads them', () => {
  const page = harness();
  for (const responseType of ['', 'text', 'json']) {
    const xhr = new page.context.XMLHttpRequest();
    xhr.open('POST', '/youtubei/v1/player'); xhr.responseType = responseType; xhr.finish(player());
    const result = responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
    assert.equal(result.adPlacements, undefined);
    assert.equal(result.videoDetails.videoId, 'ordinary-video');
    if (responseType !== 'json') assert.equal(xhr.response, xhr.responseText);
    else assert.throws(() => xhr.responseText, { name: 'InvalidStateError' });
    assert.equal(xhr.response, xhr.response);
  }
  const getter = Object.getOwnPropertyDescriptor(page.context.XMLHttpRequest.prototype, 'response').get;
  assert.throws(() => getter.call({}), TypeError);
  assert.throws(() => page.context.XMLHttpRequest.prototype.open.call({}, 'GET', '/youtubei/v1/player'), TypeError);
});

test('XHR binary resources, loading text, and unrelated URLs stay untouched', () => {
  const page = harness();
  const binary = new Uint8Array([1, 2, 3]).buffer;
  const xhr = new page.context.XMLHttpRequest();
  xhr.open('GET', '/youtubei/v1/player'); xhr.responseType = 'arraybuffer'; xhr.finish(binary);
  assert.equal(xhr.response, binary);
  const ordinary = new page.context.XMLHttpRequest();
  ordinary.open('GET', '/ordinary'); ordinary.finish(player());
  assert.ok(JSON.parse(ordinary.responseText).adSlots);
  ordinary.open('GET', '/youtubei/v1/player'); ordinary.finish(player()); ordinary.readyState = 3;
  assert.ok(JSON.parse(ordinary.responseText).adSlots);
  ordinary.readyState = 4; ordinary.responseURL = 'https://accounts.example/login';
  assert.ok(JSON.parse(ordinary.responseText).adSlots);
});

test('same-window disable restores unsanitized initial reads and bypasses player requests', async () => {
  const page = harness(); page.context.payload = player(); page.run('window.ytInitialPlayerResponse = payload');
  assert.equal(page.run('ytInitialPlayerResponse.adSlots'), undefined);
  page.control(false, true);
  assert.equal(page.run('ytInitialPlayerResponse.adSlots'), undefined);
  page.control(false);
  assert.ok(page.run('ytInitialPlayerResponse.adSlots'));
  const response = await page.context.fetch('https://www.youtube.com/youtubei/v1/player');
  assert.ok((await response.json()).adSlots);
  page.control(true);
  assert.equal(page.run('ytInitialPlayerResponse.adSlots'), undefined);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.ok(page.messages.some(message => message.source === 'quietbrowse-youtube-status' && message.active && message.removed > 0));
});

test('unrelated hosts and repeat injection leave platform behavior intact', () => {
  const outside = harness('example.com'); outside.context.payload = player();
  outside.run('window.ytInitialPlayerResponse = payload');
  assert.ok(outside.run('ytInitialPlayerResponse.adSlots'));
  const page = harness(); const fetch = page.context.fetch;
  page.run(source);
  assert.equal(page.context.fetch, fetch);
});

async function latestReport(page) {
  await new Promise(resolve => queueMicrotask(resolve));
  return page.messages.at(-1);
}

test('response counter counts successful responses rather than individual ad fields or repeated reads', async () => {
  const page = harness();
  page.context.payload = player();
  page.run('window.ytInitialPlayerResponse = payload');
  let report = await latestReport(page);
  assert.equal(report.removed, 3);
  assert.equal(report.filteredResponses, 1);
  for (let i = 0; i < 10; i++) page.run('ytInitialPlayerResponse.videoDetails.videoId');
  assert.equal((await latestReport(page)).filteredResponses, 1);

  await page.context.fetch('https://www.youtube.com/youtubei/v1/player');
  assert.equal((await latestReport(page)).filteredResponses, 2);

  const xhr = new page.context.XMLHttpRequest();
  xhr.open('POST', '/youtubei/v1/player'); xhr.finish(player());
  for (let i = 0; i < 10; i++) {
    assert.equal(JSON.parse(xhr.responseText).adSlots, undefined);
    assert.equal(xhr.response, xhr.responseText);
  }
  assert.equal((await latestReport(page)).filteredResponses, 3);
  xhr.open('POST', '/youtubei/v1/player'); xhr.finish(player());
  void xhr.response;
  assert.equal((await latestReport(page)).filteredResponses, 4);
});

test('serialized initial getters and stable frozen response views do not inflate response count', async () => {
  const page = harness();
  page.context.text = JSON.stringify(player());
  page.run('window.ytplayer = {config: {args: {player_response: text}}}');
  for (let i = 0; i < 10; i++) {
    assert.equal(page.run('JSON.parse(ytplayer.config.args.player_response).adSlots'), undefined);
  }
  assert.equal((await latestReport(page)).filteredResponses, 1);
  const next = player(); next.videoDetails.videoId = 'next-video';
  page.context.nextText = JSON.stringify(next);
  page.run('ytplayer.config.args.player_response = nextText');
  for (let i = 0; i < 10; i++) page.run('ytplayer.config.args.player_response');
  assert.equal((await latestReport(page)).filteredResponses, 2);

  page.context.frozen = Object.freeze(player());
  page.run('window.ytInitialPlayerResponse = frozen');
  for (let i = 0; i < 10; i++) page.run('ytInitialPlayerResponse');
  assert.equal((await latestReport(page)).filteredResponses, 3);
});

test('empty, malformed, unrelated, and disabled responses never increase the response counter', async () => {
  const page = harness();
  for (const value of [{}, { adPlacements: [], playerAds: null, adSlots: {} }, 'not JSON']) {
    page.factory(() => page.response(value));
    await page.context.fetch('https://www.youtube.com/youtubei/v1/player');
  }
  page.factory(() => page.response(player(), 'https://www.youtube.com/profile'));
  await page.context.fetch('https://www.youtube.com/profile');
  assert.equal((await latestReport(page)).filteredResponses, 0);

  page.control(false);
  page.factory(() => page.response(player()));
  assert.ok((await (await page.context.fetch('https://www.youtube.com/youtubei/v1/player')).json()).adSlots);
  page.context.payload = player(); page.run('window.ytInitialPlayerResponse = payload');
  assert.ok(page.run('ytInitialPlayerResponse.adSlots'));
  const xhr = new page.context.XMLHttpRequest();
  xhr.open('POST', '/youtubei/v1/player'); xhr.finish(player());
  assert.ok(JSON.parse(xhr.responseText).adSlots);
  assert.equal((await latestReport(page)).filteredResponses, 0);
});

test('a response containing multiple player wrappers is counted once and counters reset for new documents', async () => {
  const page = harness();
  page.factory(() => page.response([{ playerResponse: player() }, { player_response: player() }]));
  const result = await (await page.context.fetch('https://www.youtube.com/youtubei/v1/player')).json();
  assert.equal(result[0].playerResponse.adSlots, undefined);
  assert.equal(result[1].player_response.adSlots, undefined);
  const report = await latestReport(page);
  assert.equal(report.removed, 6);
  assert.equal(report.filteredResponses, 1);
  const nextDocument = harness();
  assert.equal((await latestReport(nextDocument)).filteredResponses, 0);
});

test('counter inspection cannot prevent removal of opaque page-owned ad values', () => {
  const opaque = new Proxy({}, { ownKeys() { throw new Error('opaque ad data'); } });
  const input = { adSlots: opaque, streamingData: { formats: ['ordinary'] } };
  const result = prunePlayer(input);
  assert.equal(result.value.adSlots, undefined);
  assert.equal(result.value.streamingData, input.streamingData);
  assert.equal(result.removed, 1);
  assert.equal(result.hasAdData, false);
  let descriptorReads = 0;
  const dynamic = new Proxy({ adSlots: [{}], streamingData: input.streamingData }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'adSlots' && ++descriptorReads === 2) throw new Error('counter-only inspection failed');
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });
  const filtered = prunePlayer(dynamic);
  assert.equal(filtered.value.adSlots, undefined);
  assert.equal(filtered.value.streamingData, input.streamingData);
  assert.equal(filtered.removed, 1);
});

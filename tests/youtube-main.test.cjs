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

test('ad-free text avoids JSON parsing while escaped keys and serialized wrappers remain filtered', () => {
  let parses = 0;
  const context = { module: { exports: {} }, JSON: {
    parse(value) { parses++; return JSON.parse(value); }, stringify: JSON.stringify
  } };
  vm.runInNewContext(source, context);
  const prune = context.module.exports.pruneText;
  const ordinary = JSON.stringify({ contents: Array.from({ length: 1000 }, (_, i) => ({ videoId: `video-${i}` })) });
  assert.equal(prune(ordinary).value, ordinary);
  assert.equal(prune('<!doctype html><title>Watch</title>').removed, 0);
  assert.equal(parses, 0, 'ad-free data does not incur a second JSON parse');

  for (const escaped of [
    String.raw`{"adSl\u006fts":[{"slot":1}],"videoDetails":{"videoId":"keep"}}`,
    String.raw`{"\u0070layerAds":[{"slot":1}],"videoDetails":{"videoId":"keep"}}`
  ]) {
    for (const text of [escaped, JSON.stringify({ player_response: escaped }), ")]}'\n" + JSON.stringify([{ playerResponse: JSON.parse(escaped) }])]) {
      const result = prune(text);
      assert.equal(result.removed, 1);
      assert.equal(result.hasAdData, true);
      assert.ok(result.value.includes('keep'));
    }
  }
  assert.ok(parses > 0);
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
    URL, Headers, Response, Request, ReadableStream, TextDecoder, TextEncoder, queueMicrotask, XMLHttpRequest,
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

test('fetch preserves non-player endpoints, malformed response bytes, redirects, and rejections', async () => {
  const page = harness();
  let original = page.response(player(), 'https://www.youtube.com/ordinary');
  page.factory(() => original);
  assert.equal(await page.context.fetch('https://www.youtube.com/ordinary'), original);
  original = page.response('not JSON');
  assert.equal(await (await page.context.fetch('https://www.youtube.com/youtubei/v1/player')).text(), 'not JSON');
  original = page.response(player(), 'https://accounts.example/login');
  assert.equal(await page.context.fetch('https://www.youtube.com/youtubei/v1/player'), original);
  original = page.response({ streamingData: { formats: ['ordinary'] } });
  assert.deepEqual(await (await page.context.fetch('https://www.youtube.com/youtubei/v1/player')).json(), { streamingData: { formats: ['ordinary'] } });
  const failure = new Error('network failed'); page.factory(() => { throw failure; });
  assert.throws(() => page.context.fetch('https://www.youtube.com/youtubei/v1/player'), error => error === failure);
  page.factory(() => Promise.reject(failure));
  await assert.rejects(page.context.fetch('https://www.youtube.com/youtubei/v1/player'), error => error === failure);
});

test('fetch headers resolve independently of a later native body error', async () => {
  const page = harness();
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const original = new Response(stream);
  Object.defineProperty(original, 'url', { value: 'https://www.youtube.com/youtubei/v1/player' });
  page.factory(() => original);
  const request = page.context.fetch('https://www.youtube.com/youtubei/v1/player');
  await new Promise(resolve => setImmediate(resolve));
  const result = await request;
  const failure = new DOMException('aborted', 'AbortError');
  controller.error(failure);
  await assert.rejects(result.text(), error => error === failure);
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
  assert.equal(await (await page.context.fetch('https://www.youtube.com/watch?v=example')).text(), '<!doctype html><title>Watch</title>');
});

test('explicit HTML and binary fetch responses return without cloning or waiting for the body', async () => {
  const page = harness();
  const url = 'https://www.youtube.com/watch?v=example';
  for (const type of ['text/html; charset=utf-8', 'APPLICATION/XHTML+XML', 'image/png', 'video/mp4', 'audio/mp4', 'font/woff2', 'application/pdf']) {
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    const original = new Response(body, { headers: { 'content-type': type } });
    Object.defineProperty(original, 'url', { value: url });
    let clones = 0;
    original.clone = () => { clones++; throw new Error('Unsupported content must not be read'); };
    page.factory(() => original);
    const result = await page.context.fetch(url);
    assert.equal(result, original);
    assert.equal(clones, 0, type);
    assert.equal(original.bodyUsed, false);
    controller.enqueue(new TextEncoder().encode('untouched body'));
    controller.close();
    assert.equal(await result.text(), 'untouched body');
  }
  const empty = new Response(null, { status: 204 });
  Object.defineProperty(empty, 'url', { value: url });
  empty.clone = () => { throw new Error('Empty body must not be read'); };
  page.factory(() => empty);
  assert.equal(await page.context.fetch(url), empty);
});

test('missing, plain-text, and unfamiliar fetch types still filter supported JSON and XSSI', async () => {
  const page = harness();
  const url = 'https://www.youtube.com/youtubei/v1/player';
  for (const type of [null, 'text/plain', 'application/octet-stream', 'application/json; charset=utf-8', 'application/vnd.youtube+json', 'application/x-unknown']) {
    const text = ")]}'\n" + JSON.stringify(player());
    const original = new Response(text);
    if (type === null) original.headers.delete('content-type');
    else original.headers.set('content-type', type);
    Object.defineProperty(original, 'url', { value: url });
    page.factory(() => original);
    const result = await page.context.fetch(url);
    const parsed = JSON.parse((await result.text()).slice(5));
    assert.equal(parsed.adSlots, undefined, String(type));
    assert.equal(parsed.videoDetails.videoId, 'ordinary-video');
  }
});

function controlledPlayerResponse(page, { type = 'application/json', status = 200 } = {}) {
  let controller;
  const events = { readers: 0, clones: 0, cancellations: [] };
  const body = new ReadableStream({
    type: 'bytes',
    start(value) { controller = value; },
    cancel(reason) { events.cancellations.push(reason); }
  }, { highWaterMark: 0 });
  const nativeReader = body.getReader;
  body.getReader = function (...args) {
    events.readers++;
    return Reflect.apply(nativeReader, this, args);
  };
  const original = new Response(body, {
    status, statusText: 'Player ready',
    headers: { 'content-type': type, 'content-length': '9999', 'content-encoding': 'gzip', 'x-preserved': 'yes' }
  });
  Object.defineProperties(original, {
    url: { value: 'https://www.youtube.com/youtubei/v1/player', configurable: true },
    redirected: { value: true }, type: { value: 'basic' }
  });
  original.clone = () => { events.clones++; throw new Error('The original body must not be teed'); };
  page.factory(() => original);
  return { original, controller, events };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('player fetch returns at headers and waits for consumption before reading or counting', { timeout: 3000 }, async () => {
  const page = harness();
  const { original, controller, events } = controlledPlayerResponse(page, { status: 201 });
  let returned = false;
  const pending = page.context.fetch(original.url).then(value => { returned = true; return value; });
  await nextTurn();
  assert.equal(returned, true, 'fetch must settle while its body is still incomplete');
  const result = await pending;
  assert.equal(events.readers, 0);
  assert.equal(events.clones, 0);
  assert.equal(original.bodyUsed, false);
  assert.equal(original.body.locked, false);
  assert.equal(result.bodyUsed, false);
  assert.equal(result.status, 201);
  assert.equal(result.statusText, 'Player ready');
  assert.equal(result.type, 'basic');
  assert.equal(result.redirected, true);
  assert.equal(result.headers.get('x-preserved'), 'yes');
  assert.equal(result.headers.get('content-length'), null);
  assert.equal(result.headers.get('content-encoding'), null);
  assert.equal((await latestReport(page)).filteredResponses, 0);
  // Response metadata belongs to this request, even if another page hook later
  // changes properties on the original response object.
  Object.defineProperty(original, 'url', { value: 'https://other.example/changed' });
  const clone = result.clone();
  assert.equal(clone.url, 'https://www.youtube.com/youtubei/v1/player');
  await nextTurn();
  assert.equal(events.readers, 0, 'cloning alone must not consume the source');
  let finished = false;
  const parsed = result.json().then(value => { finished = true; return value; });
  await nextTurn();
  assert.equal(events.readers, 1);
  assert.equal(result.bodyUsed, true);
  const bytes = new TextEncoder().encode(JSON.stringify(player()));
  controller.enqueue(bytes.slice(0, 20));
  await nextTurn();
  assert.equal(finished, false, 'partial JSON must not leak through to the player');
  assert.equal((await latestReport(page)).filteredResponses, 0);
  controller.enqueue(bytes.slice(20));
  controller.close();
  assert.equal((await parsed).adSlots, undefined);
  assert.equal(JSON.parse(await clone.text()).playerAds, undefined);
  assert.equal((await latestReport(page)).filteredResponses, 1);
  assert.equal(events.readers, 1);
  assert.equal(events.clones, 0);
});

async function bytesFromReader(reader, byob = false) {
  const chunks = [];
  while (true) {
    const result = await reader.read(...(byob ? [new Uint8Array(31)] : []));
    if (result.value?.length) chunks.push(Buffer.from(result.value));
    if (result.done) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

test('every native response body API and clone consumes the same sanitized byte stream once', { timeout: 5000 }, async () => {
  const consumers = {
    json: async response => response.json(),
    text: async response => JSON.parse(await response.text()),
    arrayBuffer: async response => JSON.parse(new TextDecoder().decode(await response.arrayBuffer())),
    blob: async response => {
      const blob = await response.blob();
      assert.equal(blob.type, 'application/json');
      return JSON.parse(await blob.text());
    },
    nativePrototype: async response => JSON.parse(await Response.prototype.text.call(response)),
    defaultReader: async response => JSON.parse(await bytesFromReader(response.body.getReader())),
    byobReader: async response => JSON.parse(await bytesFromReader(response.body.getReader({ mode: 'byob' }), true))
  };
  if (Response.prototype.bytes) consumers.bytes = async response => JSON.parse(new TextDecoder().decode(await response.bytes()));
  for (const [name, consume] of Object.entries(consumers)) {
    const page = harness();
    const { original, controller, events } = controlledPlayerResponse(page);
    const response = await page.context.fetch(original.url);
    const clone = response.clone();
    const reading = consume(response);
    const bytes = new TextEncoder().encode(JSON.stringify(player()));
    controller.enqueue(bytes.slice(0, 3));
    controller.enqueue(bytes.slice(3));
    controller.close();
    const value = await reading;
    assert.equal(value.adSlots, undefined, name);
    assert.equal(value.playerAds, undefined, name);
    assert.deepEqual(value.streamingData, player().streamingData, name);
    assert.equal((await clone.json()).adPlacements, undefined, name);
    assert.equal((await latestReport(page)).filteredResponses, 1, name);
    assert.equal(events.readers, 1, name);
    assert.equal(events.clones, 0, name);
    assert.equal(response.bodyUsed, true, name);
    assert.throws(() => response.clone(), TypeError, name);
    await assert.rejects(response.text(), TypeError, name);
  }
  const page = harness();
  page.factory(() => page.response('name=ordinary&value=keep', undefined, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
  const fields = await (await page.context.fetch('https://www.youtube.com/youtubei/v1/player')).formData();
  assert.equal(fields.get('name'), 'ordinary');
  assert.equal(fields.get('value'), 'keep');
  assert.equal((await latestReport(page)).filteredResponses, 0);
});

test('unchanged and malformed bodies preserve original bytes including BOM and invalid UTF-8', { timeout: 3000 }, async () => {
  const inputs = [
    Buffer.from('\ufeff{"videoDetails":{"title":"Snow 雪 and 🌱"}}'),
    Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x61, 0xc3, 0x28]),
    Buffer.concat([Buffer.from('\ufeff{"adSlots":['), Buffer.from([0xff]), Buffer.from('malformed')]),
    Buffer.alloc(0)
  ];
  for (const input of inputs) {
    const page = harness();
    const { original, controller } = controlledPlayerResponse(page);
    const response = await page.context.fetch(original.url);
    const clone = response.clone();
    const data = response.arrayBuffer();
    for (let offset = 0; offset < input.length; offset += 2) controller.enqueue(Uint8Array.from(input.subarray(offset, offset + 2)));
    controller.close();
    assert.deepEqual(Buffer.from(await data), input);
    assert.equal(await clone.text(), await new Response(input).text());
    assert.equal((await latestReport(page)).filteredResponses, 0);
  }
});

test('chunked UTF-8, BOM, XSSI and escaped ad keys preserve normal player data', { timeout: 3000 }, async () => {
  for (const prefix of ['\ufeff', '\ufeff)]}\'\n', ")]}'\n"]) {
    const page = harness();
    const payload = player(); payload.videoDetails.title = '雪 and 🌱';
    const text = prefix + JSON.stringify(payload).replace('"adSlots"', '"adSl\\u006fts"');
    const { original, controller } = controlledPlayerResponse(page);
    const response = await page.context.fetch(original.url);
    const pending = response.text();
    const input = new TextEncoder().encode(text);
    for (let offset = 0; offset < input.length; offset += 2) controller.enqueue(input.slice(offset, offset + 2));
    controller.close();
    const output = await pending;
    const parsed = JSON.parse(output.replace(/^\)\]\}'\n/, ''));
    assert.equal(parsed.adSlots, undefined);
    assert.equal(parsed.playerAds, undefined);
    assert.equal(parsed.videoDetails.title, payload.videoDetails.title);
    assert.deepEqual(parsed.streamingData, payload.streamingData);
    assert.equal((await latestReport(page)).filteredResponses, 1);
  }
});

test('response cancellation before and during reading reaches the original source without counting', { timeout: 3000 }, async () => {
  for (const reading of [false, true]) {
    const page = harness();
    const { original, controller, events } = controlledPlayerResponse(page);
    const response = await page.context.fetch(original.url);
    const reason = { why: reading ? 'cancel mid-body' : 'unused request' };
    if (reading) {
      const reader = response.body.getReader();
      const pending = reader.read();
      controller.enqueue(new TextEncoder().encode('{"adSlots":'));
      await nextTurn();
      assert.equal(events.readers, 1);
      await reader.cancel(reason);
      assert.equal((await pending).done, true);
    } else {
      assert.equal(events.readers, 0);
      await response.body.cancel(reason);
    }
    assert.deepEqual(events.cancellations, [reason]);
    assert.equal((await latestReport(page)).filteredResponses, 0);
    assert.equal(events.clones, 0);
    assert.equal(response.bodyUsed, true);
    await nextTurn();
    assert.equal(original.body.locked, false, 'cancellation releases the source reader');
  }
});

test('clone cancellation preserves the other branch and cancels the source only when both stop', { timeout: 3000 }, async () => {
  const page = harness();
  const { original, controller, events } = controlledPlayerResponse(page);
  const response = await page.context.fetch(original.url);
  const clone = response.clone();
  const cancelling = response.body.cancel('unused first branch');
  const reading = clone.json();
  controller.enqueue(new TextEncoder().encode(JSON.stringify(player())));
  controller.close();
  assert.equal((await reading).adSlots, undefined);
  await cancelling;
  assert.deepEqual(events.cancellations, []);
  assert.equal((await latestReport(page)).filteredResponses, 1);

  const stoppedPage = harness();
  const stopped = controlledPlayerResponse(stoppedPage);
  const unused = await stoppedPage.context.fetch(stopped.original.url);
  const unusedClone = unused.clone();
  await Promise.all([unused.body.cancel('first branch'), unusedClone.body.cancel('second branch')]);
  assert.deepEqual(stopped.events.cancellations, [['first branch', 'second branch']]);
  assert.equal(stopped.events.readers, 0);
  assert.equal((await latestReport(stoppedPage)).filteredResponses, 0);
});

test('empty response bodies settle pending BYOB reads at EOF without counting', { timeout: 3000 }, async () => {
  const page = harness();
  const { original, controller } = controlledPlayerResponse(page);
  const response = await page.context.fetch(original.url);
  const reader = response.body.getReader({ mode: 'byob' });
  const reading = reader.read(new Uint8Array(8));
  controller.close();
  const result = await reading;
  assert.equal(result.done, true);
  assert.equal(result.value.byteLength, 0);
  assert.equal((await latestReport(page)).filteredResponses, 0);
});

test('abort and source errors during reads preserve the exact native error and never count', { timeout: 3000 }, async () => {
  for (const failure of [new DOMException('native abort', 'AbortError'), new TypeError('native body failure')]) {
    const page = harness();
    const { original, controller } = controlledPlayerResponse(page);
    const response = await page.context.fetch(original.url);
    const data = response.text();
    const rejection = assert.rejects(data, error => error === failure);
    controller.enqueue(new TextEncoder().encode('{"adSlots":'));
    await nextTurn();
    controller.error(failure);
    await rejection;
    assert.equal((await latestReport(page)).filteredResponses, 0);
    assert.equal(original.body.locked, false, 'a failed source read releases its lock');
  }
});

test('non-byte response chunks retain native TypeError rejection instead of becoming empty or corrupted data', { timeout: 3000 }, async () => {
  for (const chunk of ['{"adSlots":[{}]}', new Uint16Array([123, 125])]) {
    const nativeResponse = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(chunk); controller.close(); }
    }));
    await assert.rejects(nativeResponse().text(), { name: 'TypeError' });
    const page = harness();
    const original = nativeResponse();
    Object.defineProperty(original, 'url', { value: 'https://www.youtube.com/youtubei/v1/player' });
    page.factory(() => original);
    const response = await page.context.fetch(original.url);
    await assert.rejects(response.text(), { name: 'TypeError' });
    assert.equal(original.body.locked, false);
    assert.equal((await latestReport(page)).filteredResponses, 0);
  }
});

test('disabling after headers or during a body read returns unfiltered original bytes', { timeout: 3000 }, async () => {
  for (const duringRead of [false, true]) {
    const page = harness();
    const { original, controller } = controlledPlayerResponse(page);
    const response = await page.context.fetch(original.url);
    const bytes = new TextEncoder().encode('\ufeff' + JSON.stringify(player()));
    let reading;
    if (duringRead) {
      reading = response.arrayBuffer();
      controller.enqueue(bytes.slice(0, 25));
      await nextTurn();
    }
    page.control(false);
    if (!duringRead) reading = response.arrayBuffer();
    controller.enqueue(duringRead ? bytes.slice(25) : bytes.slice());
    controller.close();
    assert.deepEqual(Buffer.from(await reading), Buffer.from(bytes));
    assert.equal((await latestReport(page)).filteredResponses, 0);
  }
});

test('body locking and setup failures retain native response behavior', { timeout: 3000 }, async () => {
  const page = harness();
  const { original, controller } = controlledPlayerResponse(page);
  const response = await page.context.fetch(original.url);
  const reader = response.body.getReader({ mode: 'byob' });
  assert.equal(response.body.locked, true);
  assert.equal(response.bodyUsed, false);
  assert.throws(() => response.clone(), TypeError);
  await assert.rejects(response.text(), TypeError);
  reader.releaseLock();
  assert.equal(response.body.locked, false);
  const pending = response.json();
  controller.enqueue(new TextEncoder().encode(JSON.stringify(player())));
  controller.close();
  assert.equal((await pending).adSlots, undefined);

  // A page can replace a constructor or present a locked response through an
  // earlier fetch hook. Setup must fail open before consuming that body.
  const missingStream = harness('www.youtube.com', context => { context.ReadableStream = undefined; });
  const intact = missingStream.response(player());
  missingStream.factory(() => intact);
  const untouched = await missingStream.context.fetch(intact.url);
  assert.equal(untouched, intact);
  assert.equal(intact.bodyUsed, false);
  assert.ok((await untouched.json()).adSlots);
  assert.equal((await latestReport(missingStream)).filteredResponses, 0);

  const locked = page.response(player());
  const originalReader = locked.body.getReader();
  page.factory(() => locked);
  assert.equal(await page.context.fetch(locked.url), locked);
  assert.equal(locked.bodyUsed, false);
  originalReader.releaseLock();
  const used = page.response(player());
  await used.text();
  page.factory(() => used);
  assert.equal(await page.context.fetch(used.url), used);
  assert.equal(used.bodyUsed, true);
});

test('filter decoding or encoding failure returns the exact original body bytes', { timeout: 3000 }, async () => {
  for (const constructor of ['TextDecoder', 'TextEncoder']) {
    const page = harness('www.youtube.com', context => {
      context[constructor] = class { constructor() { throw new Error('page-owned codec failed'); } };
    });
    const { original, controller } = controlledPlayerResponse(page);
    const response = await page.context.fetch(original.url);
    const bytes = new TextEncoder().encode('\ufeff' + JSON.stringify(player()));
    const pending = response.arrayBuffer();
    controller.enqueue(bytes.slice()); controller.close();
    assert.deepEqual(Buffer.from(await pending), Buffer.from(bytes), constructor);
    assert.equal((await latestReport(page)).filteredResponses, 0, constructor);
  }
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

  await (await page.context.fetch('https://www.youtube.com/youtubei/v1/player')).text();
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

test('serialized property reads reuse sanitized strings and refresh on changes without changing disable behavior', async () => {
  let parses = 0;
  const page = harness('www.youtube.com', context => {
    context.JSON = { parse(value) { parses++; return JSON.parse(value); }, stringify: JSON.stringify };
  });
  page.context.raw = JSON.stringify(player());
  page.run(`window.ytplayer = {config: {args: {
    get player_response() { return raw; },
    set player_response(value) { raw = value; }
  }}}`);
  const first = page.run('ytplayer.config.args.player_response');
  assert.equal(parses, 1);
  assert.equal(JSON.parse(first).adSlots, undefined);
  for (let i = 0; i < 50; i++) assert.equal(page.run('ytplayer.config.args.player_response'), first);
  assert.equal(parses, 1, 'repeated raw property reads reuse the filtered result');
  let report = await latestReport(page);
  assert.equal(report.filteredResponses, 1);
  assert.equal(report.removed, 3);

  page.control(false);
  assert.equal(page.run('ytplayer.config.args.player_response'), page.context.raw);
  assert.ok(JSON.parse(page.context.raw).adSlots);
  assert.equal(parses, 1);
  page.control(true);
  assert.equal(page.run('ytplayer.config.args.player_response'), first);
  assert.equal(parses, 1);

  const next = player(); next.videoDetails.videoId = 'next-video';
  page.context.raw = JSON.stringify(next);
  assert.equal(JSON.parse(page.run('ytplayer.config.args.player_response')).videoDetails.videoId, 'next-video');
  assert.equal(parses, 2, 'a changed raw value must be filtered again');
  report = await latestReport(page);
  assert.equal(report.filteredResponses, 2);

  page.run('ytplayer.config.args.player_response = raw');
  for (let i = 0; i < 20; i++) page.run('ytplayer.config.args.player_response');
  assert.equal(parses, 2, 'reads of the cached sanitized string must also avoid parsing');
  assert.equal((await latestReport(page)).filteredResponses, 2);
});

test('empty, malformed, unrelated, and disabled responses never increase the response counter', async () => {
  const page = harness();
  for (const value of [{}, { adPlacements: [], playerAds: null, adSlots: {} }, 'not JSON']) {
    page.factory(() => page.response(value));
    await (await page.context.fetch('https://www.youtube.com/youtubei/v1/player')).text();
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

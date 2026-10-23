// Chromium fixtures with native MAIN/isolated worlds, inline player bootstrap,
// fetch, XHR, and media. Only chrome.* APIs and network fixture responses are mocked.
// --extension attempts actual unpacked installation and DNR enforcement.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const extensionMode = process.argv.includes('--extension');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quietbrowse-test-'));
const playerResponse = {
  videoDetails: {videoId: 'fixture-video', title: 'Normal video', lengthSeconds: '12'},
  playabilityStatus: {status: 'OK'},
  streamingData: {adaptiveFormats: [{itag: 140, url: 'https://content.example/audio?signature=preserve'}]},
  captions: {captionTracks: [{languageCode: 'en', name: 'Advertising discussed in this video'}]},
  playbackTracking: {videostatsPlaybackUrl: {baseUrl: 'https://content.example/stats'}},
  playerAds: [{adSlotRenderer: {slot: 'pre-roll'}}],
  adPlacements: [{adPlacementRenderer: {config: {kind: 'AD_PLACEMENT_KIND_START'}}}],
  adSlots: [{adSlotRenderer: {slot: 'mid-roll'}}]
};
const unrelatedResponse = {profile: {name: 'Ad agency'}, adSlots: ['business-data'], adPlacements: ['keep']};
const fixture = `<!doctype html><html><head><title>Fixture</title></head><body>
  <script>window.ytInitialPlayerResponse = ${JSON.stringify(playerResponse)}; window.inlinePlayerSnapshot = JSON.stringify(window.ytInitialPlayerResponse);</script>
  <main id="article">Normal article and controls stay visible.<button id="normal">Play</button></main>
  <div class="ad" id="ordinary">A generic class must not hide real content.</div>
  <ins class="adsbygoogle" id="advert">Ad placeholder</ins>
  <div id="movie_player"><video></video></div>
</body></html>`;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const name = req.url.split('?')[0].slice(1);
  if (name === 'ad-probe') {
    res.setHeader('Content-Type', 'text/plain'); res.end('Ad fixture reached');
  } else if (name === 'youtubei/v1/player' || name === 'youtubei/v1/next' || name === 'api/profile') {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Fixture-Header', 'preserved');
    res.end(JSON.stringify(name === 'api/profile' ? unrelatedResponse : playerResponse));
  } else if (name.endsWith('.wav')) {
    // A small, native playable audio asset in a <video> element. Seeking must
    // produce a real media 'ended' event before the next content source loads.
    const frames = (name === 'ad.wav' ? 1 : 12) * 8000;
    const wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
    wav.writeUInt32LE(frames * 2, 40);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${wav.length}`);
      res.setHeader('Content-Length', end - start + 1);
      res.end(wav.subarray(start, end + 1));
    } else { res.setHeader('Content-Length', wav.length); res.end(wav); }
  } else if (['popup.html', 'popup.css', 'popup.js', 'core.js'].includes(name)) {
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(root, name)));
  } else { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
});

(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const browser = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
    '--no-proxy-server', '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required',
    '--host-resolver-rules=MAP ads.adform.net 127.0.0.1',
    `--user-data-dir=${profile}`
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let sequence = 0;
  let buffer = '';
  const pending = new Map();
  const deadline = setTimeout(() => { console.error('Browser check timed out'); browser.kill(); process.exitCode = 1; }, 35000);
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
  browser.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const call = pending.get(message.id);
      if (call) { pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
      if (message.method === 'Fetch.requestPaused') {
        // A synthetic YouTube origin lets native fetch/XHR hit the production
        // endpoint matcher without contacting YouTube or bypassing TLS checks.
        const {request, requestId} = message.params;
        const url = new URL(request.url);
        fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
          headers: request.headers.Range ? {Range: request.headers.Range} : {}
        }).then(async response => send('Fetch.fulfillRequest', {
          requestId, responseCode: response.status,
          responseHeaders: [...response.headers].map(([name, value]) => ({name, value})),
          body: Buffer.from(await response.arrayBuffer()).toString('base64')
        }, message.sessionId)).catch(error => { console.error('Fixture response failure:', error); process.exitCode = 1; });
      }
    }
  });
  const isolatedContexts = new Map();
  const evaluate = async (session, expression, isolated = false) => {
    const result = await send('Runtime.evaluate', { expression, contextId: isolated ? isolatedContexts.get(session) : undefined, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (session, expression) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await evaluate(session, expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const media = await evaluate(session, `(() => { const v = document.querySelector('video'); return v && {src: v.currentSrc, time: v.currentTime, duration: String(v.duration), ready: v.readyState, seekable: Array.from({length: v.seekable.length}, (_, i) => [v.seekable.start(i), v.seekable.end(i)]), muted: v.muted, paused: v.paused, player: v.parentElement.className, adUI: !!document.querySelector('.ytp-ad-text')?.getClientRects().length, error: v.error?.message}; })()`);
    throw new Error(`Condition not met: ${expression}; media: ${JSON.stringify(media)}`);
  };
  async function page(source, url, isolatedSource) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    if (url.startsWith('https://www.youtube.com/')) {
      await send('Fetch.enable', {patterns: [{urlPattern: 'https://www.youtube.com/*', requestStage: 'Request'}]}, sessionId);
    }
    if (source) await send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    if (isolatedSource) await send('Page.addScriptToEvaluateOnNewDocument', {source: isolatedSource, worldName: 'quietbrowse-fixture'}, sessionId);
    await send('Page.navigate', { url }, sessionId);
    await waitFor(sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
    if (isolatedSource) {
      const {frameTree} = await send('Page.getFrameTree', {}, sessionId);
      const {executionContextId} = await send('Page.createIsolatedWorld', {frameId: frameTree.frame.id, worldName: 'quietbrowse-fixture'}, sessionId);
      isolatedContexts.set(sessionId, executionContextId);
    }
    return sessionId;
  }
  const mock = `
    let prefs = {enabled: true, allowedHosts: []}; let change;
    globalThis.chrome = { storage: { local: { get: async () => ({settings: prefs}) },
      onChanged: { addListener(fn) { change = fn; } } }, runtime: {id: 'fixture-extension', onMessage: {addListener() {}}} };
    globalThis.setPrefs = next => { prefs = next; change({settings: {newValue: next}}, 'local'); };
  `;
  try {
    if (extensionMode) {
      // This must fail honestly when a managed browser disallows installation.
      const { id } = await send('Extensions.loadUnpacked', { path: root });
      const popup = await page('', `chrome-extension://${id}/popup.html`);
      const settings = async message => {
        const response = await evaluate(popup, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
        if (response.error) throw new Error(response.error);
        return response.settings;
      };
      await settings({ type: 'SET_ENABLED', enabled: true });
      const site = await page('', `http://127.0.0.1:${port}/fixture`);
      const probe = `fetch('http://ads.adform.net:${port}/ad-probe', {cache: 'no-store'}).then(r => r.text()).catch(() => 'BLOCKED')`;
      assert.equal(await evaluate(site, probe), 'BLOCKED');
      await settings({ type: 'SET_SITE_ALLOWED', host: '127.0.0.1', allowed: true });
      assert.equal(await evaluate(site, probe), 'Ad fixture reached');
      await settings({ type: 'SET_SITE_ALLOWED', host: '127.0.0.1', allowed: false });
      assert.equal(await evaluate(site, probe), 'BLOCKED');
      await settings({ type: 'SET_ENABLED', enabled: false });
      assert.equal(await evaluate(site, probe), 'Ad fixture reached');
      console.log('PASS: real unpacked extension blocks ad requests; site exceptions and global off restore requests');
      await settings({type: 'SET_ENABLED', enabled: true});
      const youtubeSite = await page('', 'https://www.youtube.com/fixture');
      const installedInitial = await evaluate(youtubeSite, 'JSON.parse(inlinePlayerSnapshot)');
      assert.equal(installedInitial.playerAds, undefined);
      assert.equal(installedInitial.adPlacements, undefined);
      assert.equal(installedInitial.adSlots, undefined);
      assert.deepEqual(installedInitial.streamingData, playerResponse.streamingData);
      const actualPageStatus = `(async () => { const [tab] = await chrome.tabs.query({url: 'https://www.youtube.com/fixture'}); return tab && chrome.tabs.sendMessage(tab.id, {type: 'GET_PAGE_STATUS'}); })()`;
      await waitFor(popup, `${actualPageStatus}.then(status => status?.playerFilter?.active === true)`);
      console.log('PASS: actual registered MAIN prevention runs before inline bootstrap; actual isolated content reports active');
      await settings({type: 'SET_SITE_ALLOWED', host: 'youtube.com', allowed: true});
      const allowedYoutube = await page('', 'https://www.youtube.com/fixture?allowed=1');
      assert.deepEqual(await evaluate(allowedYoutube, 'JSON.parse(inlinePlayerSnapshot)'), playerResponse);
      console.log('PASS: real site exception excludes MAIN prevention in a freshly loaded document');
      return;
    }
    function assertCleanPlayer(value) {
      assert.equal(value.adPlacements, undefined); assert.equal(value.playerAds, undefined); assert.equal(value.adSlots, undefined);
      assert.deepEqual(value.streamingData, playerResponse.streamingData);
      assert.deepEqual(value.videoDetails, playerResponse.videoDetails);
      assert.deepEqual(value.captions, playerResponse.captions);
      assert.deepEqual(value.playbackTracking, playerResponse.playbackTracking);
    }
    const main = `window.fixtureReports = []; addEventListener('message', event => { if (event.data?.source === 'quietbrowse-youtube-status') fixtureReports.push(event.data); });\n` + fs.readFileSync(path.join(root, 'youtube-main.js'), 'utf8');
    const content = mock + fs.readFileSync(path.join(root, 'core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'content.js'), 'utf8');
    const session = await page(main, 'https://www.youtube.com/fixture', content);
    assertCleanPlayer(await evaluate(session, 'JSON.parse(inlinePlayerSnapshot)'));
    console.log('PASS: MAIN prevention removes ad placements before inline player bootstrap; normal player data preserved');
    const fetchPlayer = `(async () => { const response = await fetch('/youtubei/v1/player?fixture=1', {method: 'POST', body: '{}'}); return {status: response.status, header: response.headers.get('x-fixture-header'), body: await response.json()}; })()`;
    const fetched = await evaluate(session, fetchPlayer);
    assert.equal(fetched.status, 200); assert.equal(fetched.header, 'preserved'); assertCleanPlayer(fetched.body);
    assertCleanPlayer(await evaluate(session, `(async () => JSON.parse(await (await fetch('/youtubei/v1/player')).text()))()`));
    console.log('PASS: native fetch JSON/text player responses filtered; response metadata and content preserved');
    const xhrPlayer = type => `new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('POST', '/youtubei/v1/player'); xhr.responseType = ${JSON.stringify(type)}; xhr.onload = () => resolve({status: xhr.status, header: xhr.getResponseHeader('x-fixture-header'), body: xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText)}); xhr.onerror = reject; xhr.send('{}'); })`;
    for (const type of ['', 'json']) {
      const xhr = await evaluate(session, xhrPlayer(type)); assert.equal(xhr.status, 200); assert.equal(xhr.header, 'preserved'); assertCleanPlayer(xhr.body);
    }
    assert.deepEqual(await evaluate(session, `fetch('/api/profile').then(response => response.json())`), unrelatedResponse);
    assert.deepEqual(await evaluate(session, `JSON.parse(${JSON.stringify(JSON.stringify(unrelatedResponse))})`), unrelatedResponse);
    console.log('PASS: native XHR text/JSON player responses filtered; unrelated APIs and JSON parsing untouched');
    await evaluate(session, 'setPrefs({enabled: false, allowedHosts: []})', true);
    await waitFor(session, 'fixtureReports.some(report => report.active === false)');
    assert.deepEqual((await evaluate(session, fetchPlayer)).body, playerResponse);
    await evaluate(session, 'setPrefs({enabled: true, allowedHosts: ["youtube.com"]})', true);
    assert.deepEqual((await evaluate(session, fetchPlayer)).body, playerResponse);
    await evaluate(session, 'setPrefs({enabled: true, allowedHosts: []})', true);
    await waitFor(session, 'fixtureReports.length && fixtureReports.at(-1).active === true');
    assertCleanPlayer((await evaluate(session, fetchPlayer)).body);
    console.log('PASS: isolated-world preference bridge disables MAIN filtering, honors site exceptions, and re-enables prevention');
    assert.equal(await evaluate(session, 'getComputedStyle(document.querySelector("#advert")).display'), 'none');
    assert.notEqual(await evaluate(session, 'getComputedStyle(document.querySelector("#article")).display'), 'none');
    assert.notEqual(await evaluate(session, 'getComputedStyle(document.querySelector("#ordinary")).display'), 'none');
    await evaluate(session, `document.body.insertAdjacentHTML('beforeend', '<ins id="lazy" class="adsbygoogle">Lazy ad</ins>')`);
    assert.equal(await evaluate(session, 'getComputedStyle(document.querySelector("#lazy")).display'), 'none');
    console.log('PASS: scrolling ad containers hidden; ordinary content and generic .ad class remain visible');
    await evaluate(session, `(() => {
      const player = document.querySelector('#movie_player'); player.classList.add('ad-showing');
      const hidden = document.createElement('button'); hidden.className = 'ytp-skip-ad-button'; hidden.style.display = 'none'; hidden.onclick = () => window.hiddenSkipClicked = true;
      const visible = document.createElement('button'); visible.className = 'ytp-skip-ad-button'; visible.textContent = 'Skip'; visible.onclick = () => { window.visibleSkipClicked = true; player.classList.remove('ad-showing'); };
      player.append(hidden, visible);
    })()`);
    await waitFor(session, 'window.visibleSkipClicked');
    assert.equal(await evaluate(session, '!!window.hiddenSkipClicked'), false);
    await evaluate(session, `document.querySelectorAll('.ytp-skip-ad-button').forEach(button => button.remove())`);
    console.log('PASS: visible skip button works even when a hidden duplicate precedes it');
    await evaluate(session, `(() => {
      const player = document.querySelector('#movie_player');
      const video = player.querySelector('video');
      video.volume = 0.42; video.defaultPlaybackRate = 1.25; video.playbackRate = 1.25;
      video.addEventListener('ended', () => {
        window.adEndedNatively = true;
        // Source changes before the old ad markers disappear. v0.2.0 sought
        // normal content to its end in this race; no media property may change.
        video.src = '/normal.wav';
        video.play();
        setTimeout(() => { player.classList.remove('ad-showing'); player.querySelector('.ytp-ad-text')?.remove(); }, 1000);
      }, {once: true});
      player.insertAdjacentHTML('beforeend', '<span class="ytp-ad-text">Ad</span>');
      player.classList.add('ad-showing');
      video.src = '/ad.wav';
      video.play();
    })()`);
    await waitFor(session, `window.adEndedNatively && document.querySelector('video').currentSrc.endsWith('/normal.wav') && !document.querySelector('#movie_player').classList.contains('ad-showing')`);
    const playback = await evaluate(session, `(() => { const video = document.querySelector('video'); return {time: video.currentTime, rate: video.playbackRate, volume: video.volume, muted: video.muted, paused: video.paused}; })()`);
    assert.ok(playback.time < 3, `normal content jumped to ${playback.time}`);
    assert.equal(playback.rate, 1.25); assert.equal(playback.volume, 0.42); assert.equal(playback.muted, false); assert.equal(playback.paused, false);
    console.log('PASS: native source transition with stale ad UI preserves content position, playback rate, volume and audio');
    await evaluate(session, `document.querySelector('video').muted = true; document.querySelector('#movie_player').classList.add('ad-showing')`);
    await evaluate(session, 'setPrefs({enabled: false, allowedHosts: []})', true);
    assert.equal(await evaluate(session, 'document.querySelector("video").muted'), true);
    assert.notEqual(await evaluate(session, 'getComputedStyle(document.querySelector("#advert")).display'), 'none');
    console.log('PASS: disabled cleanup restores cosmetic containers without changing the user mute preference');
    const popupMock = `
      let prefs = { enabled: true, allowedHosts: [] };
      globalThis.chrome = {
        tabs: { query: async () => [{id: 1, url: 'https://www.youtube.com/watch?v=test'}], reload: async () => {}, sendMessage: async () => ({enabled: true, youtube: true, playerFilter: {active: true, removed: 3}}) },
        runtime: { getManifest: () => ({version: ${JSON.stringify(currentVersion)}}), sendMessage: async msg => {
          if (msg.type === 'GET_HEALTH') return {health: {version: ${JSON.stringify(currentVersion)}, youtubeRegistered: true}};
          if (msg.type === 'SET_ENABLED') prefs.enabled = msg.enabled;
          if (msg.type === 'SET_SITE_ALLOWED') prefs.allowedHosts = msg.allowed ? [msg.host] : [];
          return {settings: structuredClone(prefs)};
        } }
      };
    `;
    const popup = await page(popupMock, `http://127.0.0.1:${port}/popup.html`);
    await waitFor(popup, '!document.querySelector("#enabled").disabled');
    assert.equal(await evaluate(popup, 'document.querySelector("#host").textContent'), 'www.youtube.com');
    await waitFor(popup, 'document.querySelector("#protection").textContent === "Player ad data was filtered on this page."');
    assert.equal(await evaluate(popup, 'document.querySelector("#version").textContent'), `v${currentVersion}`);
    assert.ok(await evaluate(popup, 'document.querySelector("#diagnostics").textContent.includes("3 ad-data fields")'));
    await evaluate(popup, 'document.querySelector("#allowed").click()');
    await waitFor(popup, 'document.querySelector("#exceptions").textContent.includes("www.youtube.com")');
    await evaluate(popup, 'document.querySelector("#enabled").click()');
    await waitFor(popup, '!document.querySelector("#enabled").disabled && !document.querySelector("#enabled").checked');
    console.log('PASS: popup website display, exception toggle, and global switch');
    const unchangedPopup = await page(popupMock.replace('removed: 3', 'removed: 0'), `http://127.0.0.1:${port}/popup.html?unchanged=1`);
    await waitFor(unchangedPopup, 'document.querySelector("#protection").textContent === "Player script loaded; ad blocking is not confirmed."');
    assert.ok(await evaluate(unchangedPopup, 'document.querySelector("#diagnostics").textContent.includes("0 ad-data fields")'));
    console.log('PASS: loaded script with zero removals does not claim ad filtering occurred');
    const failingPopup = await page(popupMock.replace('youtubeRegistered: true', 'youtubeRegistered: false'), `http://127.0.0.1:${port}/popup.html?error=1`);
    await waitFor(failingPopup, 'document.querySelector("#protection").textContent.includes("could not start")');
    assert.ok(await evaluate(failingPopup, 'document.querySelector("#diagnostics").textContent.includes("not registered")'));
    console.log('PASS: popup surfaces registration failure instead of claiming active protection');
    console.log('11 browser fixture checks passed. Actual unpacked installation/DNR requires --extension; live YouTube remains unverified.');
  } finally {
    clearTimeout(deadline);
    browser.kill();
    await once(browser, 'exit');
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });

// Real Chromium DOM checks with a mocked extension API. This does not validate DNR.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const extensionMode = process.argv.includes('--extension');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quietbrowse-test-'));
const fixture = `<!doctype html><html><head><title>Fixture</title></head><body>
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
  } else if (name.endsWith('.wav')) {
    // A small, native playable audio asset in a <video> element. Seeking must
    // produce a real media 'ended' event before the next content source loads.
    const frames = (name === 'ad.wav' ? 4 : 12) * 8000;
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
  const deadline = setTimeout(() => { console.error('Browser check timed out'); browser.kill(); process.exitCode = 1; }, 25000);
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
    }
  });
  const evaluate = async (session, expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
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
  async function page(source, url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    await waitFor(sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
    return sessionId;
  }
  const mock = `
    let prefs = {enabled: true, allowedHosts: []}; let change;
    globalThis.chrome = { storage: { local: { get: async () => ({settings: prefs}) },
      onChanged: { addListener(fn) { change = fn; } } } };
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
      return;
    }
    // Use a local DOM fixture with a YouTube hostname supplied to the script's
    // lexical scope. No real YouTube response or account is involved.
    const content = mock + fs.readFileSync(path.join(root, 'core.js'), 'utf8') +
      '\ndocument.addEventListener("DOMContentLoaded", () => { ((location) => {' +
      fs.readFileSync(path.join(root, 'content.js'), 'utf8') +
      '\n})({hostname: "www.youtube.com"}); }, {once: true});';
    const session = await page(content, `http://127.0.0.1:${port}/fixture`);
    assert.equal(await evaluate(session, 'getComputedStyle(document.querySelector("#advert")).display'), 'none');
    assert.notEqual(await evaluate(session, 'getComputedStyle(document.querySelector("#article")).display'), 'none');
    assert.notEqual(await evaluate(session, 'getComputedStyle(document.querySelector("#ordinary")).display'), 'none');
    console.log('PASS: ad containers hidden; article and normal controls preserved');
    await evaluate(session, `document.body.insertAdjacentHTML('beforeend', '<ins id="lazy" class="adsbygoogle">Lazy ad</ins>')`);
    assert.equal(await evaluate(session, 'getComputedStyle(document.querySelector("#lazy")).display'), 'none');
    console.log('PASS: ads inserted during scrolling are hidden');
    await evaluate(session, `document.querySelector('#movie_player').classList.add('ad-showing')`);
    await waitFor(session, 'document.querySelector("video").muted');
    await evaluate(session, `const b = document.createElement('button'); b.className = 'ytp-skip-ad-button'; b.textContent = 'Skip'; b.onclick = () => { window.skipped = true; document.querySelector('#movie_player').classList.remove('ad-showing'); }; document.querySelector('#movie_player').append(b);`);
    await waitFor(session, 'window.skipped && !document.querySelector("video").muted');
    console.log('PASS: YouTube fixture ad muted, skip clicked, original audio restored');
    await evaluate(session, `document.querySelector('.ytp-skip-ad-button').remove(); document.querySelector('video').muted = true; document.querySelector('#movie_player').classList.add('ad-showing')`);
    await evaluate(session, `setPrefs({enabled: true, allowedHosts: ['youtube.com']})`);
    assert.equal(await evaluate(session, 'document.querySelector("video").muted'), true);
    assert.notEqual(await evaluate(session, 'getComputedStyle(document.querySelector("#advert")).display'), 'none');
    await evaluate(session, `setPrefs({enabled: false, allowedHosts: []})`);
    assert.notEqual(await evaluate(session, 'getComputedStyle(document.querySelector("#lazy")).display'), 'none');
    console.log('PASS: site exceptions and global off remove cosmetic filtering');
    await evaluate(session, `
      document.querySelector('#movie_player').classList.remove('ad-showing');
      document.querySelector('video').muted = false;
      setPrefs({enabled: true, allowedHosts: []});
      const player = document.querySelector('#movie_player');
      const video = player.querySelector('video');
      video.addEventListener('ended', () => {
        window.adEndedNatively = true;
        player.classList.remove('ad-showing');
        player.querySelector('.ytp-ad-text').remove();
        video.src = '/normal.wav';
        video.play();
      }, {once: true});
      player.insertAdjacentHTML('beforeend', '<span class="ytp-ad-text">Ad</span>');
      player.classList.add('ad-showing');
      video.src = '/ad.wav';
      video.play();
    `);
    await waitFor(session, `window.adEndedNatively && document.querySelector('video').currentSrc.endsWith('/normal.wav') && document.querySelector('video').readyState >= 2 && !document.querySelector('video').muted`);
    assert.ok(await evaluate(session, 'document.querySelector("video").currentTime < 2'));
    console.log('PASS: identified ad advances to native end; normal media plays from start with original audio');
    await evaluate(session, `
      document.querySelector('#movie_player').classList.add('ad-showing');
      // A stale ad class alone must never be enough to seek the content video.
      window.beforeTime = document.querySelector('video').currentTime;
    `);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(await evaluate(session, 'document.querySelector("video").currentTime < window.beforeTime + 2'));
    await evaluate(session, `document.querySelector('#movie_player').classList.remove('ad-showing')`);
    console.log('PASS: stale ad class without visible ad UI does not seek ordinary content');
    await evaluate(session, `document.querySelector('#movie_player').insertAdjacentHTML('beforeend', '<span class="ytp-ad-text">Ad</span>'); document.querySelector('#movie_player').classList.add('ad-showing')`);
    for (const duration of ['Infinity', 'NaN', '181']) {
      await evaluate(session, `Object.defineProperty(document.querySelector('video'), 'duration', {configurable: true, value: ${duration}})`);
      const before = await evaluate(session, 'document.querySelector("video").currentTime');
      await new Promise(resolve => setTimeout(resolve, 300));
      const after = await evaluate(session, 'document.querySelector("video").currentTime');
      assert.ok(after < before + 2, `${duration} duration must not trigger a seek`);
    }
    await evaluate(session, `delete document.querySelector('video').duration; document.querySelector('.ytp-ad-text').remove(); document.querySelector('#movie_player').classList.remove('ad-showing')`);
    console.log('PASS: live, unknown-duration, and long media are not advanced');
    const popupMock = `
      let prefs = { enabled: true, allowedHosts: [] };
      globalThis.chrome = {
        tabs: { query: async () => [{id: 1, url: 'https://www.youtube.com/watch?v=test'}], reload: async () => {} },
        runtime: { sendMessage: async msg => {
          if (msg.type === 'SET_ENABLED') prefs.enabled = msg.enabled;
          if (msg.type === 'SET_SITE_ALLOWED') prefs.allowedHosts = msg.allowed ? [msg.host] : [];
          return {settings: structuredClone(prefs)};
        } }
      };
    `;
    const popup = await page(popupMock, `http://127.0.0.1:${port}/popup.html`);
    await waitFor(popup, '!document.querySelector("#enabled").disabled');
    assert.equal(await evaluate(popup, 'document.querySelector("#host").textContent'), 'www.youtube.com');
    await evaluate(popup, 'document.querySelector("#allowed").click()');
    await waitFor(popup, 'document.querySelector("#exceptions").textContent.includes("www.youtube.com")');
    await evaluate(popup, 'document.querySelector("#enabled").click()');
    await waitFor(popup, '!document.querySelector("#enabled").disabled && !document.querySelector("#enabled").checked');
    console.log('PASS: popup website display, exception toggle, and global switch');
    console.log('8 browser fixture checks passed. Live extension loading and DNR are not covered by this mode.');
  } finally {
    clearTimeout(deadline);
    browser.kill();
    await once(browser, 'exit');
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });

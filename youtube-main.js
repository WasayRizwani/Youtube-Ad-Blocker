/* Runs in YouTube's MAIN world at document_start. No extension APIs or secrets. */
(() => {
  'use strict';
  const AD_FIELDS = ['adPlacements', 'playerAds', 'adSlots'];

  // Deliberately avoid recursive key deletion: ordinary video metadata, signed
  // streams, authentication, captions, DRM, and playability must stay untouched.
  function prunePlayer(input, depth = 0, seen = new WeakSet()) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 8 || seen.has(input)) return { value: input, removed: 0 };
    seen.add(input);
    const changes = new Map();
    let removed = 0;
    const write = (key, value, remove = false) => {
      changes.set(key, { value, remove });
    };
    for (const key of AD_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        write(key, undefined, true);
        removed++;
      }
    }
    // These are explicit player-response wrappers, not arbitrary descendants.
    for (const key of ['playerResponse', 'player_response']) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      let current;
      try { current = input[key]; } catch { continue; }
      const nested = typeof current === 'string' ? pruneText(current, depth + 1) : prunePlayer(current, depth + 1, seen);
      if (nested.removed) { write(key, nested.value); removed += nested.removed; }
    }
    if (!removed) return { value: input, removed: 0 };
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const [key, change] of changes) {
      if (change.remove) delete descriptors[key];
      else {
        const descriptor = descriptors[key];
        descriptors[key] = 'value' in descriptor ? { ...descriptor, value: change.value } :
          { value: change.value, writable: true, configurable: descriptor.configurable, enumerable: descriptor.enumerable };
      }
    }
    return { value: Object.create(Object.getPrototypeOf(input), descriptors), removed };
  }

  function pruneText(text, depth = 0) {
    if (typeof text !== 'string') return { value: text, removed: 0 };
    const prefix = /^\)\]\}'(?:\r?\n)?/.exec(text)?.[0] || '';
    try {
      const result = prunePayload(JSON.parse(text.slice(prefix.length)), depth);
      return result.removed ? { value: prefix + JSON.stringify(result.value), removed: result.removed } : { value: text, removed: 0 };
    } catch { return { value: text, removed: 0 }; }
  }

  function prunePayload(input, depth = 0) {
    if (!Array.isArray(input)) return prunePlayer(input, depth);
    let removed = 0;
    const output = input.map(entry => {
      // PBJ watch responses wrap player data in top-level array entries. Never
      // delete similarly named fields from arbitrary array elements.
      if (!entry || typeof entry !== 'object' ||
          (!Object.prototype.hasOwnProperty.call(entry, 'playerResponse') &&
           !Object.prototype.hasOwnProperty.call(entry, 'player_response'))) return entry;
      const result = prunePlayer(entry, depth);
      removed += result.removed;
      return result.value;
    });
    return { value: removed ? output : input, removed };
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = { prunePlayer, pruneText, prunePayload };
    return;
  }
  if (!/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(location.hostname)) return;
  const marker = Symbol.for('quietbrowse.youtube.response-hooks.v1');
  if (window[marker]) return;
  Object.defineProperty(window, marker, { value: true });

  // Registration is removed/excluded for disabled and allowlisted documents by
  // the extension background. The isolated content script updates live pages.
  let enabled = true;
  const sources = { initial: 0, fetch: 0, xhr: 0 };
  let statusQueued = false;
  function status() {
    if (statusQueued) return;
    statusQueued = true;
    queueMicrotask(() => {
      statusQueued = false;
      try {
        window.postMessage({ source: 'quietbrowse-youtube-status', active: enabled,
          removed: sources.initial + sources.fetch + sources.xhr,
          sources: { ...sources } }, location.origin);
      } catch { /* The document may have navigated away. */ }
    });
  }
  function record(result, source) {
    if (result.removed) { sources[source] += result.removed; status(); }
    return result.value;
  }
  const initialCache = new WeakMap();
  const initialBackups = new WeakMap();
  function sameClean(left, right, depth = 0) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || depth > 8) return false;
    const keys = Reflect.ownKeys(left);
    if (keys.length !== Reflect.ownKeys(right).length) return false;
    return keys.every(key => Object.prototype.hasOwnProperty.call(right, key) &&
      (left[key] === right[key] ||
       (['playerResponse', 'player_response'].includes(key) && sameClean(left[key], right[key], depth + 1))));
  }
  function initialValue(value) {
    try {
      if (value && typeof value === 'object') {
        if (!enabled) { restoreInitial(value); return value; }
        if (Object.isFrozen(value) && initialCache.has(value)) return initialCache.get(value);
        const result = prunePlayer(value);
        if (!result.removed) return value;
        // Mutable initial data is cleaned in place. YouTube writes through both
        // its global and local references; a cloned getter view loses one side's
        // streamingData/metadata changes and can break subsequent playback.
        const clean = applyInitial(value, result.value);
        if (clean === value) return record({ value, removed: result.removed }, 'initial');
        const previous = initialCache.get(value);
        if (previous && sameClean(previous, clean)) return previous;
        initialCache.set(value, clean);
        return record({ value: clean, removed: result.removed }, 'initial');
      }
      if (!enabled) return value;
      return record(pruneText(value), 'initial');
    } catch { return value; }
  }

  function applyInitial(input, clean, depth = 0) {
    if (input === clean || !input || typeof input !== 'object' || depth > 8) return clean;
    const changes = [
      ...AD_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(input, key) && !Object.prototype.hasOwnProperty.call(clean, key)),
      ...['playerResponse', 'player_response'].filter(key => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== clean[key])
    ];
    // Frozen/non-configurable payloads use a stable clean copy. Do not partially
    // rewrite an object when one of the required property changes is forbidden.
    for (const key of changes) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || (!Object.prototype.hasOwnProperty.call(clean, key) && !descriptor.configurable) ||
          (Object.prototype.hasOwnProperty.call(clean, key) &&
           (descriptor.writable === false || (descriptor.get && !descriptor.set)))) return clean;
    }
    let backups = initialBackups.get(input);
    if (!backups) { backups = new Map(); initialBackups.set(input, backups); }
    for (const key of changes) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!Object.prototype.hasOwnProperty.call(clean, key)) {
        backups.set(key, { descriptor, deleted: true });
        delete input[key];
      } else {
        const next = typeof input[key] === 'object' && input[key] !== null ? applyInitial(input[key], clean[key], depth + 1) : clean[key];
        if (next === input[key]) continue;
        // A string player response can be restored without touching any ordinary
        // metadata written by the page. Object replacements need a reload.
        if (typeof input[key] === 'string') backups.set(key, { descriptor, cleanedValue: next });
        input[key] = next;
      }
    }
    return input;
  }
  function restoreInitial(input, depth = 0, seen = new WeakSet()) {
    if (!input || typeof input !== 'object' || depth > 8 || seen.has(input)) return;
    seen.add(input);
    const backups = initialBackups.get(input);
    if (backups) {
      for (const [key, entry] of backups) {
        try {
          if (entry.deleted ? !Object.prototype.hasOwnProperty.call(input, key) : input[key] === entry.cleanedValue) {
            Object.defineProperty(input, key, entry.descriptor);
          }
        } catch { /* The page may have frozen or replaced the property afterward. */ }
      }
      initialBackups.delete(input);
    }
    for (const key of ['playerResponse', 'player_response']) restoreInitial(input[key], depth + 1, seen);
  }

  // Preserve existing accessors and property flags. If another script owns a
  // non-configurable or read-only property, leave it alone rather than breaking it.
  function interceptProperty(object, key, transform) {
    if (!object || typeof object !== 'object') return;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && (!descriptor.configurable || descriptor.writable === false ||
          (descriptor.get && !descriptor.set))) return;
      let value = descriptor?.value;
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          const current = descriptor?.get ? Reflect.apply(descriptor.get, this, []) : value;
          return transform(current);
        },
        set(next) {
          const transformed = transform(next);
          if (descriptor?.set) Reflect.apply(descriptor.set, this, [transformed]);
          else value = transformed;
        }
      });
    } catch { /* Unsupported page-owned property: fetch/XHR remain available. */ }
  }
  interceptProperty(window, 'ytInitialPlayerResponse', initialValue);
  interceptProperty(window, 'playerResponse', initialValue);
  const prepared = new WeakSet();
  function prepareArgs(args) {
    if (!args || typeof args !== 'object' || prepared.has(args)) return args;
    prepared.add(args);
    interceptProperty(args, 'player_response', initialValue);
    interceptProperty(args, 'raw_player_response', initialValue);
    return args;
  }
  function prepareConfig(config) {
    if (!config || typeof config !== 'object' || prepared.has(config)) return config;
    prepared.add(config);
    interceptProperty(config, 'args', prepareArgs);
    return config;
  }
  function prepareYTPlayer(player) {
    if (!player || typeof player !== 'object' || prepared.has(player)) return player;
    prepared.add(player);
    interceptProperty(player, 'config', prepareConfig);
    return player;
  }
  interceptProperty(window, 'ytplayer', prepareYTPlayer);

  function isPlayerURL(value) {
    try {
      const url = new URL(value, location.href);
      if (!/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(url.hostname)) return false;
      return /^\/youtubei\/v1\/(?:player|next|get_watch)\/?$/.test(url.pathname) ||
        (url.pathname === '/watch' && url.searchParams.has('v')) ||
        (url.pathname === '/playlist' && url.searchParams.has('list'));
    } catch { return false; }
  }

  function preserveResponseMetadata(response, original) {
    for (const key of ['url', 'redirected', 'type']) {
      Object.defineProperty(response, key, { value: original[key], configurable: true });
    }
    const clone = response.clone;
    Object.defineProperty(response, 'clone', {
      configurable: true, value: function cloneResponse() {
        return preserveResponseMetadata(Reflect.apply(clone, this, []), original);
      }
    });
    return response;
  }
  try { if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch;
    window.fetch = new Proxy(nativeFetch, {
      apply(target, receiver, args) {
        let requestURL;
        try { requestURL = args[0]?.url ?? String(args[0]); } catch { /* Native fetch reports invalid input. */ }
        const promise = Reflect.apply(target, receiver, args);
        if (!isPlayerURL(requestURL)) return promise;
        return promise.then(async response => {
          if (!enabled || !isPlayerURL(response.url || requestURL)) return response;
          try {
            const text = await response.clone().text();
            // A disable request can arrive while the body is being read.
            if (!enabled) return response;
            const clean = pruneText(text);
            if (!clean.removed) return response;
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            const replacement = new Response(clean.value, { status: response.status,
              statusText: response.statusText, headers });
            preserveResponseMetadata(replacement, response);
            record(clean, 'fetch');
            return replacement;
          } catch { return response; }
        });
      }
    });
  } } catch { /* A page-owned immutable fetch must retain its original semantics. */ }

  // Intercept native getters, not xhr instances/proxies. This retains native
  // receiver checks and makes the cleaned body visible to the first page handler,
  // even if that handler was registered before open(). Never touch binary XHR.
  try { if (typeof window.XMLHttpRequest === 'function') {
    const prototype = window.XMLHttpRequest.prototype;
    const open = prototype.open;
    const tracked = new WeakMap();
    prototype.open = new Proxy(open, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        tracked.set(receiver, { eligible: isPlayerURL(args[1]), raw: undefined, clean: undefined });
        return result;
      }
    });
    for (const property of ['responseText', 'response']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor?.get || !descriptor.configurable) continue;
      const nativeGetter = descriptor.get;
      Object.defineProperty(prototype, property, { ...descriptor,
        get() {
          const raw = Reflect.apply(nativeGetter, this, []);
          const state = tracked.get(this);
          if (!enabled || !state?.eligible || this.readyState !== 4 ||
              (this.responseURL && !isPlayerURL(this.responseURL)) ||
              !['', 'text', 'json'].includes(this.responseType)) return raw;
          if (state.raw === raw && state.clean !== undefined) return state.clean;
          try {
            const clean = typeof raw === 'string' ? pruneText(raw) : prunePayload(raw);
            state.raw = raw;
            state.clean = record(clean, 'xhr');
            return state.clean;
          } catch { return raw; }
        }
      });
    }
  } } catch { /* A page-owned immutable XHR prototype must remain untouched. */ }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== 'quietbrowse-control') return;
    if (typeof event.data.enabled === 'boolean') enabled = event.data.enabled;
    status();
  });
  status();
})();

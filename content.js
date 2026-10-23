(() => {
  'use strict';
  const youtube = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(location.hostname);
  const css = `
    ins.adsbygoogle, iframe[id^="google_ads_iframe"], div[id^="div-gpt-ad"],
    ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer,
    ytd-promoted-video-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer,
    ytd-action-companion-ad-renderer, ytd-video-masthead-ad-v3-renderer,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-rich-section-renderer:has(ytd-ad-slot-renderer), .ytp-ad-overlay-container,
    #player-ads, #masthead-ad { display: none !important; }
  `;
  let settings = QuietBrowse.normalize();
  let style;
  let observer;
  let player;
  let playerObserver;
  let discoveryTimer = null;
  let checkTimer = null;
  let retryTimer = null;
  let playerFilter = { active: false, removed: 0, filteredResponses: null };
  let lastSkip;
  let lastSkipTime = 0;
  function hasPlayer() {
    return player?.isConnected && player.id === 'movie_player';
  }
  function clearSkipWork() {
    clearTimeout(checkTimer);
    clearTimeout(retryTimer);
    checkTimer = retryTimer = null;
  }
  function scheduleDiscovery() {
    if (!observer || discoveryTimer !== null) return;
    discoveryTimer = setTimeout(discoverPlayer, 50);
  }
  function scheduleCheck() {
    if (checkTimer === null) checkTimer = setTimeout(handleAd, 50);
  }
  function handleAd() {
    clearSkipWork();
    if (!hasPlayer()) { scheduleDiscovery(); return; }
    const isAd = player?.classList.contains('ad-showing');
    if (!isAd) { lastSkip = null; return; }
    const buttons = player.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    for (const button of buttons) {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true' ||
          !button.getClientRects().length || getComputedStyle(button).visibility === 'hidden') continue;
      const now = performance.now();
      if (lastSkip !== button || now - lastSkipTime >= 1000) {
        lastSkip = button;
        lastSkipTime = now;
        button.click();
      }
      break;
    }
    // Retry only when an ad has skip controls. This also catches a control
    // revealed by a CSS animation without a new DOM mutation. Normal playback
    // and pages without a player have no periodic scanning timer.
    if (buttons.length && hasPlayer() && player.classList.contains('ad-showing')) {
      retryTimer = setTimeout(handleAd, 1000);
    }
  }
  function discoverPlayer() {
    discoveryTimer = null;
    if (!observer) return;
    const next = document.getElementById('movie_player');
    if (next === player) return;
    playerObserver?.disconnect();
    playerObserver = null;
    clearSkipWork();
    lastSkip = null;
    player = next;
    if (!player) return;
    playerObserver = new MutationObserver(() => {
      if (!hasPlayer()) { scheduleDiscovery(); return; }
      if (player.classList.contains('ad-showing')) scheduleCheck();
      else { clearSkipWork(); lastSkip = null; }
    });
    playerObserver.observe(player, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled'] });
    handleAd();
  }
  function refresh() {
    const active = settings.enabled && !QuietBrowse.isAllowed(location.hostname, settings);
    if (youtube) window.postMessage({ source: 'quietbrowse-control', enabled: active }, location.origin);
    if (!active) {
      style?.remove();
      style = null;
      observer?.disconnect();
      observer = null;
      playerObserver?.disconnect();
      playerObserver = null;
      player = null;
      clearTimeout(discoveryTimer);
      discoveryTimer = null;
      clearSkipWork();
      lastSkip = null;
      return;
    }
    if (!style) {
      if (!document.documentElement) {
        document.addEventListener('DOMContentLoaded', refresh, { once: true });
        return;
      }
      style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).append(style);
    }
    if (youtube && !observer) {
      // Keep the player reference while comments/recommendations change. Track
      // ID reassignment too: YouTube can retain the old node after a new node
      // becomes movie_player. Unrelated page classes never trigger discovery.
      observer = new MutationObserver(() => {
        if (!hasPlayer()) scheduleDiscovery();
      });
      observer.observe(document.documentElement, { subtree: true, childList: true,
        attributes: true, attributeFilter: ['id'] });
      discoverPlayer();
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = QuietBrowse.normalize(changes.settings.newValue);
      refresh();
    }
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'quietbrowse-youtube-status') return;
    const report = event.data;
    playerFilter = { active: report.active === true,
      removed: Number.isSafeInteger(report.removed) && report.removed >= 0 ? report.removed : 0,
      filteredResponses: Number.isSafeInteger(report.filteredResponses) && report.filteredResponses >= 0 ? report.filteredResponses : null };
  });
  chrome.runtime?.onMessage?.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'GET_PAGE_STATUS') return false;
    respond({ enabled: settings.enabled && !QuietBrowse.isAllowed(location.hostname, settings),
      youtube, playerFilter });
    return false;
  });
  chrome.storage.local.get('settings').then(result => {
    settings = QuietBrowse.normalize(result.settings);
    refresh();
  });
})();

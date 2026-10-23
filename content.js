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
  let timer;
  let playerFilter = { active: false, removed: 0, filteredResponses: null };
  let lastSkip;
  let lastSkipTime = 0;
  function handleAd() {
    const player = document.querySelector('#movie_player');
    const isAd = player?.classList.contains('ad-showing');
    if (!isAd) { lastSkip = null; return; }
    const skip = [...player.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')]
      .find(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
        button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
    if (!skip) return;
    const now = performance.now();
    if (lastSkip === skip && now - lastSkipTime < 1000) return;
    lastSkip = skip;
    lastSkipTime = now;
    skip.click();
  }
  function refresh() {
    const active = settings.enabled && !QuietBrowse.isAllowed(location.hostname, settings);
    if (youtube) window.postMessage({ source: 'quietbrowse-control', enabled: active }, location.origin);
    if (!active) {
      style?.remove();
      style = null;
      observer?.disconnect();
      observer = null;
      clearInterval(timer);
      timer = null;
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
      observer = new MutationObserver(handleAd);
      observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
      timer = setInterval(handleAd, 250);
      handleAd();
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

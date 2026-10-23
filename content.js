(() => {
  'use strict';
  const youtube = location.hostname === 'youtube.com' || location.hostname.endsWith('.youtube.com');
  const css = `
    ins.adsbygoogle, iframe[id^="google_ads_iframe"], div[id^="div-gpt-ad"],
    ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer,
    ytd-promoted-video-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer,
    #player-ads, #masthead-ad { display: none !important; }
  `;
  let settings = QuietBrowse.normalize();
  let style;
  let observer;
  let timer;
  let mutedVideo;
  let previousMute;
  function restoreAudio() {
    if (mutedVideo) mutedVideo.muted = previousMute;
    mutedVideo = null;
  }
  function handleAd() {
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video');
    const isAd = player?.classList.contains('ad-showing');
    if (!isAd || !video) { restoreAudio(); return; }
    if (mutedVideo !== video) {
      restoreAudio();
      mutedVideo = video;
      previousMute = video.muted;
      video.muted = true;
    }
    const skip = player.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (skip && !skip.disabled && skip.getClientRects().length) skip.click();
  }
  function refresh() {
    const active = settings.enabled && !QuietBrowse.isAllowed(location.hostname, settings);
    if (!active) {
      style?.remove();
      style = null;
      observer?.disconnect();
      observer = null;
      clearInterval(timer);
      timer = null;
      restoreAudio();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).append(style);
    }
    if (youtube && !observer) {
      observer = new MutationObserver(handleAd);
      observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
      timer = setInterval(handleAd, 1000);
      handleAd();
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = QuietBrowse.normalize(changes.settings.newValue);
      refresh();
    }
  });
  chrome.storage.local.get('settings').then(result => {
    settings = QuietBrowse.normalize(result.settings);
    refresh();
  });
  addEventListener('pagehide', restoreAudio);
})();

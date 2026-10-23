# QuietBrowse

A dependency-free Chrome extension (Manifest V3, Chrome 111+) for reducing ads while preserving normal browsing and playback. YouTube support is best effort; live YouTube compatibility has not been verified in this cloud environment.

## Install in Chrome

1. [Download the current GitHub ZIP](https://github.com/WasayRizwani/Ad-Blocker/archive/refs/heads/main.zip) and extract it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin **QuietBrowse** in Chrome's extensions menu, then reload existing website tabs.

To upgrade, replace the files in the folder you previously loaded, click **Reload**
on the extension card, and confirm **0.3.0** appears on the card and in the popup.
Allow the extension access to YouTube in Chrome's extension settings, then reload
YouTube. If you choose a different folder, remove the old copy first so two copies
do not run together.

There is no build step, account, API key, or npm installation required. Changes to these files take effect after pressing **Reload** on the extension card and refreshing affected pages. Chrome's Web Store and internal `chrome://` pages cannot be filtered.

## Controls

- **Block ads** enables or disables blocking everywhere.
- **Allow ads on this site** exempts the current hostname and its subdomains from both request blocking and cosmetic filtering. Use it if videos, login, checkout, or another feature stops working.
- **Allowed websites** lists exceptions and lets you remove them.
- **Reload this tab** applies request changes to the whole page. Already blocked resources cannot be restored without reloading.
- The popup shows whether the YouTube player filter is registered and active on the current tab. Its removed-field count is a diagnostic for response filtering, not a count of ads blocked. If the filter is inactive, reload the tab and check extension site access.

## Behavior and limitations

Chrome's declarative network rules block known advertising domains and specific advertising endpoints. The packaged EasyList ad-server subset adds third-party domain coverage; conditional rules and allowlists are not imported. Common ad containers are hidden, including containers inserted while scrolling. Broad selectors such as `.ad` are avoided because ordinary content can use them. Top-level navigation is not blocked. See [third-party attribution](THIRD_PARTY.md).

On YouTube, version 0.3.0 uses an early page-world script to remove the known `adPlacements`, `playerAds`, and `adSlots` fields before the player selects an ad. It handles supported initial player-response properties and explicit player-response wrappers, plus JSON responses from YouTube's `player`, `next`, `get_watch`, `watch`, and `playlist` endpoints. It leaves signed video streams, normal video metadata, captions, playback tracking, authentication, DRM, and playability fields intact. Unrelated API responses and general JSON parsing are untouched.

The `scripting` permission registers this script in YouTube's MAIN world at `document_start`, with registration persisted across browser sessions. Disabling protection or allowing a site updates the registration and its exclusions for future documents. Existing tabs receive preference changes, but a reload is needed to apply early interception from the start or to recover resources already filtered. Registration is for top-level `youtube.com` and `youtube-nocookie.com` documents; embedded frames on other websites are not covered by this player-response filter.

The fallback only clicks a visible, enabled Skip button. The extension never changes video time, playback speed, volume, or mute state. The automatic seeking used in 0.2.0 was removed because stale ad markers during a source transition could cause regular content to be skipped.

YouTube can change its response structure or deliver ads within a normal media stream. Server-stitched ads, unsupported payloads, Shorts, embedded players, and anti-adblock messages may remain. Removing known response fields cannot guarantee that every ad disappears or every website stays compatible. If a site has trouble, allow ads on that site and reload.

Field and endpoint selection was researched against [uAssets filtering references](https://github.com/uBlockOrigin/uAssets/blob/66966686c3c8ce74a08fa0d4ff99329367220c93/filters/filters.txt). No uAssets code or rules are bundled by this implementation.

The bundled list does not update remotely. To reproduce it, run `python3 scripts/update_ad_domains.py`; its source revision, SHA-256, and rule counts are recorded in `rules/easylist-source.json`. Updating the pinned revision requires reviewing and rebuilding the list. The derived list is licensed under CC BY-SA 3.0; source and attribution are in [THIRD_PARTY.md](THIRD_PARTY.md).

The extension has no analytics or remote backend. Preferences stay in `chrome.storage.local` and do not sync between devices. Website access is needed for filtering; `activeTab` identifies the current website when you open the popup.

## Development and checks

Node.js 22 or newer and Python 3 are needed only for tests:

```sh
npm test
npm run test:browser
npm run test:extension
```

The browser checks also require `chromium` on PATH (or a `CHROMIUM` executable override). They run a disposable headless browser profile against local fixtures and clean it up afterward. On Linux they use `--no-sandbox`, intended only for a trusted development container.

The unit suite checks response pruning and native API behavior, registration/exclusions, site boundaries, preference persistence, error recovery, sender validation, and filter conversion safety.

`test:browser` runs the production page script and isolated content script in separate Chromium worlds. A synthetic YouTube origin is served entirely from local fixtures through DevTools request interception: no live YouTube page or advertising server is contacted. Tests exercise inline player bootstrap, native fetch/XHR, preservation of normal response data, the preference bridge, visible Skip buttons, cosmetics, popup diagnostics, and playable media transitioning under stale ad markers. These fixtures do **not** validate installed-extension permissions, real network-rule enforcement, or live YouTube compatibility.

`test:extension` separately loads the actual unpacked extension and checks real request blocking, site exceptions, the global switch, early MAIN-world registration, and content diagnostics against local fixtures. It intentionally fails when browser administration prevents extension loading. It still does not establish live YouTube compatibility.

[GitHub Actions](https://github.com/WasayRizwani/Ad-Blocker/actions/workflows/test.yml) is configured to run all three commands in a fresh Chrome runner on pushes and pull requests. Its result must be checked separately; adding the workflow does not establish that it passed or that live YouTube ads were tested.

In this cloud environment, unpacked installation is blocked by `ExtensionInstallBlocklist: ["*"]` and returns “Loading of unpacked extensions is disabled by the administrator.” No policy was changed. Direct YouTube access also returned HTTP 403 from the egress proxy. The reported [YouTube video](https://www.youtube.com/watch?v=tMwTz2a72cw) remains unverified live. No shared-desktop or additional-computer launcher is available in this chat.

For live validation in a Chrome profile that permits developer extensions:

1. Load version 0.3.0, grant YouTube site access, and reload the tab. Confirm the popup says the player filter is running; check the extension card and service worker console for errors.
2. On a page making a request to an included advertising domain, verify DevTools Network reports `ERR_BLOCKED_BY_CLIENT`, while the main content and normal controls work.
3. Allow that site and reload; verify the same request is allowed and hidden containers return. Remove the exception to restore filtering. Repeat with the global switch off and on.
4. Test YouTube playback, navigation between videos, captions, seeking, volume, playback speed, and visible Skip buttons. Verify regular content starts normally and a previously muted video stays muted.
5. Restart Chrome and verify the switches and site exceptions persist.

For future cloud work, use the existing checkout at `/workspace/Ad-Blocker`; tasks already have isolated environments, so no Git worktree is needed. No background application server needs to run.

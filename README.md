# QuietBrowse

A dependency-free Chrome extension (Manifest V3) for reducing ads while keeping normal browsing usable. This is an initial implementation, not a guarantee of blocking every ad or keeping every website compatible.

## Install in Chrome

1. Download this project to your computer (or extract the provided extension ZIP).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin **QuietBrowse** in Chrome's extensions menu, then reload existing website tabs.

There is no build step, account, API key, or npm installation required. Changes to these files take effect after pressing **Reload** on the extension card and refreshing affected pages. Chrome's Web Store and internal `chrome://` pages cannot be filtered.

## Controls

- **Block ads** enables or disables blocking everywhere.
- **Allow ads on this site** exempts the current hostname and its subdomains from both request blocking and cosmetic filtering. Use it if videos, login, checkout, or another feature stops working.
- **Allowed websites** lists exceptions and lets you remove them.
- **Reload this tab** applies request changes to the whole page. Already blocked resources cannot be restored without reloading.

## Behavior and limitations

Chrome's declarative network rules block a small, bundled list of known advertising domains and specific YouTube advertising endpoints. Common, explicit ad containers are hidden, including containers inserted while scrolling. Broad selectors such as `.ad` are deliberately avoided because ordinary content can use them. Top-level navigation is not blocked.

On YouTube, the extension detects the player's ad state, mutes an identified ad, and clicks an available Skip button. It restores the previous mute setting when the ad ends or filtering is disabled. It does not seek through video, remove the player, block the video CDN, or replace playback requests.

YouTube can deliver ads through the same infrastructure as regular video and can change its page structure. Unskippable ads may play silently for their full duration; first-party ads, Shorts ads, embedded players, and anti-adblock messages may remain. Live YouTube playback has not been verified in this cloud environment. If playback fails, allow ads on YouTube and reload. No ad blocker can promise universal blocking and perfect compatibility.

The bundled list is intentionally small and does not update remotely. Additional ad networks will require reviewed rule changes. The extension has no analytics or remote backend. Preferences stay in `chrome.storage.local` and do not sync between devices. Permission to access websites is needed for filtering; `activeTab` identifies the current website when you open the popup.

## Development and checks

Node.js 22 or newer is needed only for tests:

```sh
npm test
npm run test:browser
```

The browser checks also require `chromium` on PATH (or a `CHROMIUM` executable override). They run a disposable headless browser profile against local fixtures and clean it up afterward. On Linux they use `--no-sandbox`, intended only for a trusted development container.

The unit suite covers hostname boundaries, generated exception rules, background preference changes, persistence failure recovery, and message sender checks. The browser suite exercises real DOM/CSS, dynamically inserted ad containers, a simulated YouTube ad player, audio restoration, and popup controls, with mocked Chrome extension APIs. These checks do **not** validate Chrome's live extension installation or declarative network enforcement.

Cloud Chromium refused unpacked extension loading with “Loading of unpacked extensions is disabled by the administrator.” No policy was changed. Complete these manual checks in a Chrome profile that permits developer extensions:

1. Load the extension and confirm its card shows no errors; inspect the service worker console as well.
2. On a page making a request to an included advertising domain, verify DevTools Network reports `ERR_BLOCKED_BY_CLIENT`, while the main content and normal controls work.
3. Allow that site and reload; verify the same request is allowed and hidden containers return. Remove the exception to restore filtering. Repeat with the global switch off and on.
4. Test YouTube browsing, playback, seeking, volume controls, navigation between videos, and ad skipping where available. Verify audio is restored after an ad. Test with a previously muted video too.
5. Restart Chrome and verify the switches and site exceptions persist.

For future cloud work, use the existing checkout at `/workspace/Ad-Blocker`; tasks already have isolated environments, so no Git worktree is needed. No background application server needs to run.

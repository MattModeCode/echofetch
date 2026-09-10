# Recon: Echo360 stream delivery

**Status: not yet performed.** The Claude browser extension was not connected when
this build ran, so no live Echo360 lecture was inspected.

## What this means for the code

The build did not guess. Instead of hard-coding one delivery shape, the extension
detects at runtime what recon would have told us up front:

| Unknown | How the code resolves it |
|---|---|
| MPEG-TS vs fMP4 | `containerFor()` in `src/hls.js` — presence of `EXT-X-MAP`, then segment extension. Picks `.ts` or `.mp4` accordingly |
| DRM vs plain AES-128 | `parseMedia()` reads `EXT-X-KEY`. Widevine/PlayReady/FairPlay/SAMPLE-AES → hard stop with a plain-language error. `METHOD=AES-128` with an `identity` keyformat → decrypted with WebCrypto |
| Which host serves media | `host_permissions` covers the five Echo360 regional domains; anything else is requested at click time via `chrome.permissions.request` |
| Token expiry | On a 401/403 the playlist is re-read and the fresh URL for that index is swapped in |
| One stream or two | Every captured `.m3u8` for the tab becomes an entry in the picker |

## Still worth confirming on a real lecture

1. **Whether the master playlist is requested from an Echo360 domain or a CDN.**
   This is the one that can leave the extension seeing nothing at all. MV3 delivers
   `webRequest` events only for URLs the extension already holds host permission
   for — registering the listener on `<all_urls>` does not widen that. If the
   playlist comes from an institution-owned or CDN host, capture silently returns
   empty until the user takes the "Allow EchoFetch to watch all sites" button in the
   popup's waiting state. Confirm which path a real lecture takes.
2. Whether the presenter and screen feeds are genuinely separate master playlists,
   or variants inside one. The picker handles both, but the labels ("Stream 1",
   "Stream 2") will read better once the real shape is known.
3. Actual token lifetime, to confirm the single-refresh retry is enough for a
   90-minute lecture.
4. Whether McMaster's Echo360 instance has DRM enabled at all. If it does, the
   extension will say so on first run and nothing else here matters.

## How to complete it

Connect the Claude browser extension, open a real lecture, and record: the host, the
playlist request chain, segment container, `EXT-X-KEY` lines, and whether segment
URLs carry a signed query string. Replace this file with the findings.

# Recon: Echo360 stream delivery

**Status: partially complete, 2026-09-17.** Not performed against a live player —
derived from the files EchoFetch 0.1.0 actually produced, which turn out to describe
the delivery shape precisely.

## What the downloaded files proved

Six lectures downloaded with 0.1.0 were 14.5 GB on disk and held about 55 MB of
video between them. Walking the MP4 box chain explains why:

| Lecture | On disk | `moov` boxes | Fragments per copy |
|---|---|---|---|
| SOCPSY L01 | 1.83 GB | 261 | 260 |
| SOCPSY L02 | 3.87 GB | 361 | 360 |
| SOCPSY L03 | 1.46 GB | 234 | 233 |

Every file is the same complete video repeated, and in each case
**copies = fragments + 1**. That is exactly one whole-file fetch for the
`EXT-X-MAP` init segment plus one whole-file fetch per media segment, which is what
`download()` does when every segment resolves to the same URL.

It follows that Echo360 serves **byte-range HLS**: one `.mp4` per rendition, with the
media playlist addressing each fragment by `#EXT-X-BYTERANGE` rather than by a
distinct URL. `parseMedia()` in 0.1.0 ignored that tag — it fell through the generic
`if (line.startsWith('#')) continue;` — so the ranges were dropped and every segment
kept the file's own URL.

Fixed in 0.2.0: ranges are parsed (including the offset-less continuation form and
`BYTERANGE` on `EXT-X-MAP`), sent as `Range` headers, and sliced client-side if a
server answers `200` instead of `206`. `download()` also refuses outright to fetch a
playlist whose segments share one URL with no ranges published, so this failure can
only ever recur loudly.

## Confirmed incidentally

- **Container**: fragmented MP4 (`ftyp` / `moov` / repeating `sidx` + `moof` + `mdat`),
  so `containerFor()` correctly chooses `.mp4`.
- **No DRM** on McMaster's instance — the files decode with no `EXT-X-KEY` handling.
- **Video is 640×360 at roughly 24 kbps** for a slide capture. An hour of lecture is
  about 10 MB, which is why the quality cap matters far less than the range bug did.
- **Token expiry** never triggered the 401/403 path across six downloads.

## Still unconfirmed

1. **Whether the master playlist comes from an Echo360 domain or a CDN.** Unchanged
   from the original note: if it is a CDN host, capture returns empty until the user
   grants all-sites access from the popup.
2. **Whether presenter and screen feeds are separate masters or variants in one.**
3. **Audio.** Every file downloaded so far is video-only, with no audio track at all,
   which means the audio is a separate `EXT-X-MEDIA` rendition and a video download
   never includes it. EchoFetch offers audio as its own row but never muxes the two,
   so a downloaded lecture is silent. Not yet fixed. Echo360's own Transcript tab
   (`.vtt` / `.txt`) is the practical workaround for anything text-based.

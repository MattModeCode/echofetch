# EchoFetch

A Chrome extension (Manifest V3) that saves Echo360 lectures for offline viewing,
using the session you are already signed into.

## Install

There is no store listing. Load it unpacked:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

## Use

1. Open a lecture on Echo360 and press play for a second. EchoFetch reads the
   playlist as the player requests it, so nothing is detected until playback starts.
2. Click the EchoFetch icon.
3. Pick a stream and click **Download**.

Each row shows the resolution, aspect ratio, and an estimated file size, so you can
tell what you are committing to before you start. Where a lecture publishes two
feeds — a presenter camera and a screen capture — EchoFetch labels which is likely
which from the aspect ratio and resolution. That label is a guess and says so; the
resolution and size beside it are not.

**Audio only** appears as its own row when the lecture publishes a separate audio
track, at roughly 60 MB an hour instead of several GB. If no separate track exists,
the picker says so rather than hiding the option, and the fix is to take the
smallest video and strip the picture with the ffmpeg command offered afterwards.

The first download from a new lecture host asks for permission to read that host.
Echo360 serves media from CDN domains that are not known ahead of time, so the
extension requests them at the moment they are needed rather than claiming broad
access up front.

## Settings

Right-click the icon and choose Options, or use the Settings link in the popup.

- **Default quality** (default 720p) — pre-selects the largest stream at or below
  this height. This is the setting that matters. Capping quality at download time is
  the only thing that reliably keeps lectures off multiple gigabytes; nothing done
  afterwards can undo having fetched the 1080p variant.
- **Prefer audio only** — select the audio track by default when one exists.
- **Filename** — supports `{title}` and `{date}`.
- **Parallel segment downloads** (default 6) — lower it if the campus network
  throttles you or transfers keep failing partway.

Settings sync across the Chrome profiles you are signed into.

## Output

Files land in your normal downloads folder.

- Audio-only saves as `.m4a`, or `.aac` for non-fragmented streams.
- Streams packaged as fragmented MP4 save as `.mp4` and play anywhere.
- Streams packaged as MPEG-TS save as `.ts`. VLC and IINA play these directly.
  QuickTime does not. To convert without re-encoding:

  ```
  ffmpeg -i "Lecture.ts" -c copy "Lecture.mp4"
  ```

## Keeping files small

Solve it at download time, not afterwards. The default quality cap and the
audio-only option between them handle almost every case, and both cost nothing.

EchoFetch deliberately does not transcode in the browser. ffmpeg.wasm carries no
H.265 encoder in any standard build, and re-encoding a 90-minute lecture in a tab
would run for hours and exhaust memory long before it finished. Instead, the
completed-download screen offers a **Copy ffmpeg command** button that puts a
command tailored to the file you just saved on the clipboard, to run locally:

```
ffmpeg -i "Lecture.mp4" -c:v libx265 -crf 28 -preset slow -c:a aac -b:a 96k -ac 1 "Lecture-small.mp4"
```

Lecture video compresses extremely well — static slides, little motion — so this
typically lands somewhere near a tenth of the original with no visible difference.
It is not fast; run a batch overnight.

## Limits

- **DRM-protected lectures cannot be downloaded.** If your institution enabled
  Widevine or PlayReady, EchoFetch detects it and says so instead of writing a
  broken file. No extension can decrypt those streams.
- Standard AES-128 HLS encryption is not DRM and is handled normally.
- One lecture at a time. There is no bulk or whole-course download.
- Live lectures are not supported; the recording must have finished processing.
- The lecture is assembled in memory before it is written to disk, so a very long
  recording at high bitrate — past roughly 2 GB — can exhaust the tab's memory.
  Pick a lower-resolution stream if that happens. Streaming straight to disk needs
  the File System Access API and a save dialog, which is not built yet.

## How it works

`background.js` watches network requests for `.m3u8` playlists and remembers which
tab they belong to. The popup fetches the master playlist and lists the variants.

The download itself runs in an **offscreen document**, not the service worker.
This matters: MV3 shuts a service worker down after roughly 30 seconds idle, which
would kill a lecture-length transfer partway through and leave a truncated file.
The offscreen document has no such timer.

Segments are fetched six at a time, each retried up to three times. If a segment
URL's token expires mid-download, the playlist is re-read and the fresh URL is
swapped in rather than failing the whole run. Segments are concatenated in order
and handed to `chrome.downloads` as a single blob.

## Scope

Use it for lectures in courses you are enrolled in. Redistributing recorded
lectures generally breaches an institution's terms of use.

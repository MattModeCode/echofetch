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
3. Pick a stream — or a transcript — and click **Download**.

Each row shows the resolution and a file size, so you can tell what you are
committing to before you start. The size is worked out from the stream's bitrate
and the lecture's length, so treat it as close rather than exact. Where a lecture
publishes two feeds — a presenter camera and a screen capture — EchoFetch labels
which is likely which from the aspect ratio and resolution. That label is a guess.

**Audio only** gets one row when the lecture publishes a separate audio track, at
roughly 60 MB an hour instead of several GB. Echo360 often publishes that track
more than once; every copy is the same sound, so the picker shows it once. If no
separate track exists, the picker says so rather than hiding the option, and the
fix is to take the smallest video and strip the picture with the ffmpeg command
offered afterwards.

While a download runs, the popup shows one bar and one percentage.

The first download from a new lecture host asks for permission to read that host.
Echo360 serves media from CDN domains that are not known ahead of time, so the
extension requests them at the moment they are needed rather than claiming broad
access up front. A download that fetches audio asks for the audio host too, up
front, so the second stream cannot fail halfway through.

## Audio

Echo360 publishes audio as its own rendition, so a video stream fetched on its own is
**completely silent** — not quiet, but carrying no audio track at all. Every lecture
downloaded with 0.2.0 and earlier has this problem.

From 0.4.0 a video download fetches the companion audio track and **muxes it into the
video**, so one file arrives and it has sound:

```
SOCPSY 1Z03 What Is Social Psych.mp4    video and audio, one file
```

Muxing is a byte-level rewrite, not a re-encode: the samples are already in the codecs
the file will carry, so the two streams are combined by writing a header that
describes both tracks and interleaving the fragments in time order. It costs about a
second and loses nothing. Each row in the picker says whether sound is coming with it.

Two shapes cannot be combined this way, and both fall back to the old pair of files
side by side rather than failing:

- **MPEG-TS packaging.** Muxing works on fragmented MP4. A lecture served as `.ts`
  saves as `.ts` plus `.aac`.
- **Anything the muxer does not recognize** — a stream with no timed fragments, a
  multi-track rendition. It says so in the console and writes the pair.

When a pair lands, the finished screen offers a **Copy merge command**, and files
already on disk from earlier versions can be combined in bulk:

```
node tools/merge-audio.mjs ~/Downloads                      # report only
node tools/merge-audio.mjs --apply ~/Downloads              # write the merged files
node tools/merge-audio.mjs --apply --replace ~/Downloads    # and delete the pair
```

It matches files by name, stream-copies with no re-encode, verifies the result
actually has an audio stream before touching anything, and tells you which lectures
are still silent because their audio was never downloaded. For those, take the
**Audio only** row for that lecture and run it again.

Turn the fetching off under Options if you only ever want the picture.

## Transcript

Echo360 writes a transcript for most lectures. EchoFetch downloads that transcript —
it does not transcribe anything itself, and nothing is sent anywhere.

Open the transcript panel on the lecture page once so the player requests it; the same
detection that finds the video finds the transcript. Two rows then appear in the
picker:

- **Transcript (.vtt)** — timestamps kept. Save it beside the video with the same name
  and VLC or IINA will show it as subtitles.
- **Transcript (.txt)** — plain text, timestamps stripped, joined back into paragraphs
  where the lecturer paused. For reading and searching.

Both come from one request; picking the other format afterwards costs nothing. If no
transcript has been seen yet the picker says so rather than hiding the option.

## Settings

Right-click the icon and choose Options, or use the Settings link in the popup.

- **Default quality** (default 720p) — pre-selects the largest stream at or below
  this height. This is the setting that matters. Capping quality at download time is
  the only thing that reliably keeps lectures off multiple gigabytes; nothing done
  afterwards can undo having fetched the 1080p variant.
- **Include the sound in the video file** (default on) — fetch the companion audio
  track and mux it into the video. Without it a downloaded lecture is silent.
- **Prefer audio only** — select the audio track by default when one exists.
- **Save to** — **Choose folder…** opens your computer's own folder picker, and
  everything afterwards saves straight there. Without it files go to your Downloads
  folder, which is the only place a Chrome extension can reach on its own.
- **Subfolder** — an optional path inside whichever folder is in effect, created for
  you. Per-course rules override it.
- **Filename** — supports `{title}` and `{date}`.
- **Parallel segment downloads** (default 6) — lower it if the campus network
  throttles you or transfers keep failing partway.

Settings sync across the Chrome profiles you are signed into. The chosen folder does
not: it is a handle to your own disk, so it stays on the computer you picked it on.
Chrome can also drop its permission to write there — usually after a restart. When
that happens the download still lands in Downloads, the popup says so, and choosing
the folder again in Settings reconnects it.

## Output

Files land in the folder you chose in Settings, or in your normal downloads folder
when you have not chosen one.

- A video with its audio muxed in saves as one `.mp4` and plays anywhere.
- Audio-only saves as `.m4a`, or `.aac` for non-fragmented streams.
- Transcripts save as `.vtt` or `.txt`, sharing the lecture's name.
- Streams packaged as MPEG-TS save as `.ts`. VLC and IINA play these directly.
  QuickTime does not. To convert without re-encoding:

  ```
  ffmpeg -i "Lecture.ts" -c copy "Lecture.mp4"
  ```

## Keeping files small

Solve it at download time, not afterwards. The default quality cap and the
audio-only option between them handle almost every case, and both cost nothing.

### If you used 0.1.0, your files are far bigger than they should be

Echo360 publishes one MP4 per stream and points every segment in the playlist at it
with `#EXT-X-BYTERANGE`. Version 0.1.0 did not parse that tag, so every segment
resolved to the same whole-file URL and the downloader fetched the entire lecture
once per segment. A 59-minute lecture whose real stream is 10.7 MB was written as
**3.87 GB — 361 identical copies end to end**.

0.2.0 honours the ranges, and refuses to start a download that would repeat the old
mistake. To repair files already on disk:

```
node tools/repair-duplicated-mp4.mjs ~/Downloads            # report only
node tools/repair-duplicated-mp4.mjs --apply ~/Downloads    # truncate to one copy
```

It takes files or directories, verifies the copies are byte-identical before
touching anything, and leaves anything it does not recognize alone. The first copy
is a complete, valid MP4, so nothing is lost — duration and last frame are
unchanged.

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

- **MPEG-TS lectures still arrive as two files.** Muxing operates on fragmented MP4.
  Where a lecture is packaged as MPEG-TS the video and audio save side by side, and
  `tools/merge-audio.mjs` or the offered ffmpeg command combines them in about a
  second. See **Audio** above.
- **A transcript is only found once the page has asked for it.** EchoFetch watches
  what the player fetches rather than guessing an API URL, so the transcript panel has
  to be opened once per lecture. A lecture Echo360 never transcribed has none to
  fetch.
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

The transcript is found the same way: the request the player's own transcript panel
makes is recorded per tab, and the popup fetches that URL when a transcript row is
chosen. Whatever comes back — WebVTT, SubRip, or the player's JSON cue list — is
parsed into cues and written out as `.vtt` or `.txt`.

The download itself runs in an **offscreen document**, not the service worker.
This matters: MV3 shuts a service worker down after roughly 30 seconds idle, which
would kill a lecture-length transfer partway through and leave a truncated file.
The offscreen document has no such timer.

Segments are fetched six at a time, each retried up to three times. If a segment
URL's token expires mid-download, the playlist is re-read and the fresh URL and byte
range are swapped in rather than failing the whole run. Segments are concatenated in
order, the audio track is muxed in, and the result is handed to `chrome.downloads` as
a single blob. `src/mp4.js` does the muxing: it reads the box structure of both init
segments, builds one `moov` carrying both tracks with the audio renumbered to track 2,
and emits the fragments interleaved by decode time. Fragments are patched and
referenced in place rather than copied, so muxing does not add a second copy of the
lecture to the tab's memory.

Where the playlist uses `#EXT-X-BYTERANGE` — as Echo360's does — every segment shares
one URL and is fetched with a `Range` header instead. If a server ignores the header
and returns the whole file with `200`, the window is sliced out client-side, so a
non-compliant CDN cannot quietly turn one lecture into hundreds of copies of itself.

## Development

No build step and no dependencies. The parser has tests:

```
npm test
```

## Scope

Use it for lectures in courses you are enrolled in. Redistributing recorded
lectures generally breaches an institution's terms of use.

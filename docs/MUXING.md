# Muxing audio into the video

## The problem

Echo360 publishes audio as a separate HLS rendition. A video variant fetched on its
own carries no audio track at all, so up to 0.3.0 EchoFetch downloaded both and saved
them side by side, leaving the user to run `tools/merge-audio.mjs` or an ffmpeg
command. Most people never did, and a folder of silent lectures is the result.

## What was considered

| Option | Why not |
|---|---|
| **ffmpeg.wasm** | Correct, and enormous — tens of megabytes of WASM shipped in the extension, plus a loader that wants a build step. The job is a container rewrite, not transcoding, and this brings a whole transcoder to do it. |
| **mp4box.js** | Capable of exactly this, but it is a large UMD bundle built for a different lifecycle (it wants to own segmentation), and vendoring it means carrying ~1 MB of code and its API surface for one function. |
| **mux.js** | Aimed at MPEG-TS → fMP4 for MSE playback, not at combining two existing fMP4 renditions. Wrong end of the problem. |
| **Purpose-built remuxer** (chosen) | About 300 lines, no dependency, no build step, and testable under `node --test` like the playlist parser already is. |

The deciding factor is that both inputs are *already* fragmented MP4 in the codecs the
output will carry. No decoding, no sample-table work and no bitstream parsing is
required — only box surgery.

## How it works

`src/mp4.js`:

1. Reads both init segments: `ftyp`, `moov`, the single `trak`, its `trex`, and the
   `mdhd` timescale.
2. Builds one `moov` — the video's `mvhd` with `next_track_ID` bumped, both `trak`
   boxes with track ids forced to 1 (video) and 2 (audio), and an `mvex` holding both
   `trex` boxes, likewise renumbered.
3. Walks the fragments of each stream, reading `tfdt` for the decode time and treating
   everything from a `moof` up to the next `moof` as one movable unit.
4. Emits `ftyp`, the combined `moov`, then the fragments merged by decode time, each
   with its `tfhd` track id and `mfhd` sequence number rewritten.

A `trun`'s `data_offset` is relative to the start of its own `moof`, so a moof/mdat
pair stays valid wherever it is placed as long as the two travel together. That is the
property the whole approach rests on.

Fragments are patched in place in the buffer the download already allocated and then
referenced by `subarray`, never copied. Copying them would hold a second copy of a
multi-gigabyte lecture in the tab, which is the failure mode the ~2 GB ceiling in the
README already sits close to.

## When it does not apply

`muxAudioIntoVideo` throws instead of guessing when either input is not a
single-track fragmented MP4, or carries no `tfdt`. MPEG-TS lectures are the common
case. The caller answers every one of those the same way: save the two files side by
side as before, and let `tools/merge-audio.mjs` finish the job.

# Transcripts

Echo360's transcript endpoint is not a documented, stable URL — its shape differs
between institutions and player versions. Rather than hardcode a guess,
`background.js` records transcript-looking requests the page makes (`transcript` or
`caption` in the path, or a `.vtt`/`.srt` file) the same way it already records
`.m3u8` playlists, and the popup fetches whichever it captured.

The cost is that the transcript panel has to be opened once per lecture before the
option appears, which is the same bargain playback already makes for the video. The
benefit is that no institution's variation on the endpoint can break it.

`src/transcript.js` accepts WebVTT, SubRip and the player's JSON cue list, because all
three have been seen in the wild, and writes either `.vtt` (timestamps kept) or `.txt`
(paragraphs, no timestamps).

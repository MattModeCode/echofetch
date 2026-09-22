// What a lecture offers, worked out from its playlists: the video renditions, the one
// audio rendition worth showing, the transcript, and which of them to pick by default.
//
// Shared by the popup, where a person chooses, and by the watcher, where nobody is
// there to choose and the same rules have to hold unattended.

import {
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  audioRenditions,
  audioForVariant,
  aspectLabel,
  guessFeed
} from './hls.js';
import { TRANSCRIPT_FORMATS } from './transcript.js';

export const ECHO_HOST = /(^|\.)echo360\.(org|ca|net\.au|org\.au|org\.uk)$/i;
const ASSUMED_AUDIO_BITRATE = 128_000;

export const fetchText = (url) =>
  fetch(url, { credentials: 'include', cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });

export function cleanTitle(raw) {
  return (raw || 'Lecture').replace(/\s*[|–-]\s*Echo\s*360.*$/i, '').trim() || 'Lecture';
}

/**
 * Duration is identical across a master's variants, so probe one media playlist per
 * master rather than one per variant — the difference is eight fetches versus two.
 */
async function probeDuration(variantUrl, get) {
  try {
    return parseMedia(await get(variantUrl), variantUrl).totalDuration;
  } catch {
    return 0;
  }
}

/**
 * Echo360 publishes captions under several names and sometimes more than one URL per
 * lecture. The one whose path says transcript is the full text; a .vtt caption file
 * is the same content and an acceptable second choice.
 */
export function pickTranscript(entries) {
  if (!entries.length) return null;
  return (
    entries.find((entry) => /transcript/i.test(new URL(entry.url).pathname)) ||
    entries.find((entry) => /\.vtt|\.srt/i.test(new URL(entry.url).pathname)) ||
    entries[0]
  );
}

export function transcriptOptions(entries) {
  const source = pickTranscript(entries || []);
  if (!source) return [];

  return Object.entries(TRANSCRIPT_FORMATS).map(([format, spec]) => ({
    kind: 'transcript',
    url: source.url,
    format,
    label: spec.label,
    sub: spec.sub,
    height: 0,
    bytes: 0
  }));
}

/** Plain words for what the camera was pointed at, and only when there is a choice. */
function describeFeed(option, allOptions) {
  const feed = guessFeed(option, allOptions);
  if (feed === 'likely screen capture') return 'Slides';
  if (feed === 'likely presenter camera') return 'Presenter camera';
  return null;
}

export async function buildOptions(playlists, transcripts, { get = fetchText } = {}) {
  const video = [];
  const audio = [];
  let duration = 0;

  for (const [index, entry] of (playlists || []).entries()) {
    let text;
    try {
      text = await get(entry.url);
    } catch {
      continue;
    }

    const source = playlists.length > 1 ? `Recording ${index + 1}` : '';

    if (!isMasterPlaylist(text)) {
      video.push({ kind: 'video', url: entry.url, label: 'Video', source, height: 0 });
      continue;
    }

    const { variants, audioGroups } = parseMaster(text, entry.url);
    if (!variants.length) continue;

    if (!duration) duration = await probeDuration(variants[0].url, get);

    for (const variant of variants) {
      const aspect = aspectLabel(variant.resolution);
      const companion = audioForVariant(variant, audioGroups);
      const videoBytes = duration && variant.bandwidth ? (variant.bandwidth / 8) * duration : 0;
      video.push({
        kind: 'video',
        url: variant.url,
        audioUrl: companion ? companion.url : null,
        source,
        height: variant.height || 0,
        aspect,
        label: variant.height ? `${variant.height}p` : 'Video',
        bytes: videoBytes + (companion && duration ? (ASSUMED_AUDIO_BITRATE / 8) * duration : 0)
      });
    }

    // A lecture has one soundtrack. Echo360 often publishes it several times over —
    // once per rendition group, once per recording — and every copy sounds the same,
    // so showing more than one row is a choice nobody can make.
    const [rendition] = audioRenditions(audioGroups);
    if (rendition && !audio.length) {
      audio.push({
        kind: 'audio',
        url: rendition.url,
        label: 'Audio only',
        height: 0,
        bytes: duration ? (ASSUMED_AUDIO_BITRATE / 8) * duration : 0
      });
    }
  }

  // A video rendition with no companion audio downloads silently, which is never what
  // anyone wants. Hiding those is only safe while something with sound remains, so a
  // lecture published without any audio at all keeps its options and gets a warning.
  const withSound = video.filter((option) => option.audioUrl);
  const silentOnly = withSound.length === 0;
  const offered = silentOnly ? video : withSound;

  for (const option of offered) {
    option.sub = [option.source, describeFeed(option, offered)].filter(Boolean).join(' · ');
  }

  return {
    video: offered,
    audio,
    transcript: transcriptOptions(transcripts),
    duration,
    silentOnly
  };
}

/**
 * The largest rendition at or below the cap, which is the one decision that keeps a
 * term of lectures off multiple gigabytes. Falls back to the smallest available when
 * every rendition is above the cap, rather than refusing to download anything.
 */
export function pickDefault({ video, audio, transcript }, { maxHeight, audioOnly } = {}) {
  if (audioOnly && audio.length) return audio[0];
  if (!video.length && !audio.length) return transcript[0] || null;
  if (!video.length) return audio[0];

  const withinCap = video.filter((option) => option.height && option.height <= maxHeight);
  const pool = withinCap.length ? withinCap : video;
  return withinCap.length
    ? pool.reduce((a, b) => ((b.height || 0) > (a.height || 0) ? b : a), pool[0])
    : pool.reduce((a, b) => ((b.height || Infinity) < (a.height || Infinity) ? b : a), pool[0]);
}

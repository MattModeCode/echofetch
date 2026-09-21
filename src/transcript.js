// Transcript parsing. Echo360 already has a transcript for most lectures; EchoFetch
// fetches whatever the player fetched and reshapes it. Nothing here transcribes.
//
// Three input shapes are handled because the endpoint serves different ones
// depending on the institution's Echo360 version: WebVTT, SubRip, and the player's
// own JSON cue list. All three collapse to the same cue array, which is then written
// out as either WebVTT — timestamps kept, loads beside the video in VLC or IINA —
// or plain text for reading and searching.

const VTT_HEADER = 'WEBVTT';

/** "00:01:02.500", "01:02.500" and SubRip's comma variant all mean the same thing. */
function parseTimestamp(raw) {
  const match = String(raw).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours || 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, '0')) / 1000
  );
}

export function formatTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function cleanText(raw) {
  return String(raw ?? '')
    // Cue payloads carry inline tags like <v Speaker> and <i>; they mean nothing in
    // a text file and clutter the VTT no player will style.
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCueBlock(block) {
  const lines = block.split(/\r?\n/).filter((line) => line.trim());
  const arrowIndex = lines.findIndex((line) => line.includes('-->'));
  if (arrowIndex === -1) return null;

  const [from, to] = lines[arrowIndex].split('-->');
  const start = parseTimestamp(from);
  // Cue settings ("align:start line:90%") trail the end timestamp.
  const end = parseTimestamp(String(to).trim().split(/\s+/)[0]);
  if (start === null) return null;

  const text = cleanText(lines.slice(arrowIndex + 1).join(' '));
  return text ? { start, end: end === null ? start : end, text } : null;
}

/** WebVTT and SubRip differ in ways that do not matter once the cues are out. */
function parseCueList(text) {
  return String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n\s*\r?\n/)
    .map(parseCueBlock)
    .filter(Boolean);
}

const NUMBER_KEYS = { start: ['start', 'startTime', 'startTimeMs', 'begin'], end: ['end', 'endTime', 'endTimeMs'] };

function pickTime(entry, keys) {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'number') return key.endsWith('Ms') ? value / 1000 : value;
    if (typeof value === 'string') {
      const parsed = value.includes(':') ? parseTimestamp(value) : Number(value);
      if (parsed !== null && Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parseJsonCues(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.cues || payload?.transcript || payload?.data?.cues || payload?.results || [];
  if (!Array.isArray(list)) return [];

  return list
    .map((entry) => {
      const start = pickTime(entry, NUMBER_KEYS.start);
      const text = cleanText(entry?.text ?? entry?.content ?? entry?.transcript ?? entry?.caption);
      if (start === null || !text) return null;
      const end = pickTime(entry, NUMBER_KEYS.end);
      return { start, end: end === null ? start : end, text };
    })
    .filter(Boolean);
}

/**
 * Cues from whatever the endpoint returned, in time order. Throws rather than
 * returning an empty transcript, because a zero-byte .txt on disk looks like a
 * download that worked.
 */
export function parseTranscript(raw) {
  const body = String(raw ?? '').trim();
  if (!body) throw new Error('The transcript came back empty.');

  let cues = [];
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      cues = parseJsonCues(JSON.parse(body));
    } catch {
      cues = [];
    }
  } else {
    cues = parseCueList(body);
  }

  // A transcript served as bare prose has no cues to find, and is already the text
  // file one of the two formats asks for.
  if (!cues.length && !body.startsWith('{') && !body.startsWith('[') && !body.includes('-->')) {
    const text = cleanText(body.replace(new RegExp(`^${VTT_HEADER}.*`, 'i'), ''));
    if (text) return [{ start: 0, end: 0, text }];
  }

  if (!cues.length) throw new Error('Could not read the transcript Echo360 returned.');
  return cues.sort((a, b) => a.start - b.start);
}

export function toVtt(cues) {
  const blocks = cues.map(
    (cue, index) =>
      `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(Math.max(cue.end, cue.start))}\n${cue.text}`
  );
  return `${VTT_HEADER}\n\n${blocks.join('\n\n')}\n`;
}

const SENTENCE_END = /[.!?]["')\]]?$/;
const PARAGRAPH_GAP_SECONDS = 3;
const LONG_PAUSE_SECONDS = 8;
const PARAGRAPH_MAX_CHARS = 600;

/**
 * Plain text for reading. Cues arrive a few words at a time, so joining them back
 * into paragraphs is the whole job: a new paragraph where the speaker paused and the
 * previous cue finished a sentence.
 *
 * The two escape hatches matter more than the main rule. Echo360's transcripts are
 * machine-made and often carry no punctuation at all, and without them such a
 * lecture would come out as one unbroken block of an hour's speech.
 */
export function toText(cues) {
  const paragraphs = [];
  let current = [];
  let length = 0;
  let previousEnd = null;

  for (const cue of cues) {
    const gap = previousEnd === null ? 0 : cue.start - previousEnd;
    const finished = current.length && SENTENCE_END.test(current[current.length - 1]);
    const shouldBreak =
      current.length &&
      ((gap >= PARAGRAPH_GAP_SECONDS && finished) ||
        gap >= LONG_PAUSE_SECONDS ||
        length >= PARAGRAPH_MAX_CHARS);

    if (shouldBreak) {
      paragraphs.push(current.join(' '));
      current = [];
      length = 0;
    }
    current.push(cue.text);
    length += cue.text.length + 1;
    previousEnd = Math.max(cue.end, cue.start);
  }

  if (current.length) paragraphs.push(current.join(' '));
  return `${paragraphs.join('\n\n')}\n`;
}

export const TRANSCRIPT_FORMATS = {
  vtt: { extension: 'vtt', mime: 'text/vtt', label: 'Transcript (.vtt)', sub: 'Timestamps kept' },
  txt: { extension: 'txt', mime: 'text/plain', label: 'Transcript (.txt)', sub: 'Plain text, no timestamps' }
};

export function renderTranscript(raw, format) {
  const cues = parseTranscript(raw);
  return format === 'txt' ? toText(cues) : toVtt(cues);
}

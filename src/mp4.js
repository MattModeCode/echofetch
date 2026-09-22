// ISO BMFF surgery, enough of it to put two fragmented-MP4 renditions into one file.
//
// Echo360 publishes audio as its own rendition, so a video stream fetched on its own
// is silent. Both are fragmented MP4: an init segment (ftyp + moov) followed by
// moof/mdat fragment pairs. Combining them needs no decoding and no re-encoding —
// the samples are already in the codecs the output will carry. What it needs is a
// moov describing both tracks, the audio track renumbered so its id does not collide
// with the video's, and the fragments interleaved in decode order.
//
// Nothing here parses sample tables or codec payloads. A trun's data_offset is
// relative to the start of its own moof, so as long as each moof stays immediately
// in front of its own mdat, moving the pair anywhere in the file leaves it valid.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf']);

const textDecoder = new TextDecoder('latin1');

export function readU32(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

export function writeU32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readU64(bytes, offset) {
  // Media timestamps stay far inside the safe integer range; a lecture would have to
  // run for millions of years at any sane timescale to leave it.
  return readU32(bytes, offset) * 2 ** 32 + readU32(bytes, offset + 4);
}

/** Top-level boxes in [start, end). Stops at the first truncated or nonsensical one. */
export function parseBoxes(bytes, start = 0, end = bytes.length) {
  const boxes = [];
  let offset = start;

  while (end - offset >= 8) {
    let size = readU32(bytes, offset);
    const type = textDecoder.decode(bytes.subarray(offset + 4, offset + 8));
    let header = 8;

    if (size === 1) {
      if (end - offset < 16) break;
      size = readU64(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < header || offset + size > end) break;
    boxes.push({ type, start: offset, end: offset + size, contentStart: offset + header });
    offset += size;
  }

  return boxes;
}

function children(bytes, box) {
  return parseBoxes(bytes, box.contentStart, box.end);
}

/** First box reachable by path, e.g. ['moov', 'trak', 'mdia', 'mdhd']. */
export function findPath(bytes, boxes, path) {
  let level = boxes;
  let found = null;

  for (const type of path) {
    found = level.find((box) => box.type === type);
    if (!found) return null;
    level = CONTAINERS.has(found.type) ? children(bytes, found) : [];
  }

  return found;
}

function findAll(bytes, boxes, type, out = []) {
  for (const box of boxes) {
    if (box.type === type) out.push(box);
    else if (CONTAINERS.has(box.type)) findAll(bytes, children(bytes, box), type, out);
  }
  return out;
}

function versionOf(bytes, box) {
  return bytes[box.contentStart];
}

/** tkhd, trex and tfhd all carry a track id; only the offset to it differs. */
function trackIdOffset(bytes, box) {
  switch (box.type) {
    case 'tkhd':
      return box.contentStart + 4 + (versionOf(bytes, box) === 1 ? 16 : 8);
    case 'trex':
    case 'tfhd':
      return box.contentStart + 4;
    default:
      return -1;
  }
}

function setTrackId(bytes, box, id) {
  const offset = trackIdOffset(bytes, box);
  if (offset >= 0) writeU32(bytes, offset, id);
}

function readTrackId(bytes, box) {
  const offset = trackIdOffset(bytes, box);
  return offset >= 0 ? readU32(bytes, offset) : 0;
}

function mdhdTimescale(bytes, mdhd) {
  return readU32(bytes, mdhd.contentStart + 4 + (versionOf(bytes, mdhd) === 1 ? 16 : 8));
}

function baseMediaDecodeTime(bytes, tfdt) {
  return versionOf(bytes, tfdt) === 1
    ? readU64(bytes, tfdt.contentStart + 4)
    : readU32(bytes, tfdt.contentStart + 4);
}

function box(type, payloads) {
  const body = payloads.reduce((sum, part) => sum + part.length, 0);
  const header = new Uint8Array(8);
  writeU32(header, 0, body + 8);
  for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);
  return [header, ...payloads];
}

function flatten(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function slice(bytes, b) {
  return bytes.subarray(b.start, b.end);
}

/**
 * The parts of an init segment the muxer needs. Returns null for anything that is
 * not a single-track fragmented MP4 init — MPEG-TS, a multi-track init, a truncated
 * download — so the caller can fall back rather than write a broken file.
 */
export function readInit(bytes) {
  const boxes = parseBoxes(bytes);
  const ftyp = boxes.find((b) => b.type === 'ftyp');
  const moov = boxes.find((b) => b.type === 'moov');
  if (!ftyp || !moov) return null;

  const moovChildren = children(bytes, moov);
  const mvhd = moovChildren.find((b) => b.type === 'mvhd');
  const traks = moovChildren.filter((b) => b.type === 'trak');
  if (!mvhd || traks.length !== 1) return null;

  const trak = traks[0];
  const tkhd = findPath(bytes, [trak], ['trak', 'tkhd']);
  const mdhd = findPath(bytes, [trak], ['trak', 'mdia', 'mdhd']);
  const handler = findPath(bytes, [trak], ['trak', 'mdia', 'hdlr']);
  if (!tkhd || !mdhd) return null;

  const mvex = moovChildren.find((b) => b.type === 'mvex');
  const trex = mvex ? children(bytes, mvex).find((b) => b.type === 'trex') : null;
  if (!trex) return null;

  return {
    bytes,
    ftyp,
    moov,
    mvhd,
    trak,
    tkhd,
    trex,
    trackId: readTrackId(bytes, tkhd),
    timescale: mdhdTimescale(bytes, mdhd),
    handler: handler ? textDecoder.decode(bytes.subarray(handler.contentStart + 8, handler.contentStart + 12)) : ''
  };
}

/**
 * Every moof in a stream, with the decode time it starts at and the bytes of the
 * moof plus everything up to the next moof (its mdat, and any padding the server
 * put between them, which must travel with it for the trun offsets to hold).
 */
export function readFragments(bytes, { from = 0, timescale = 1 } = {}) {
  const boxes = parseBoxes(bytes, from);
  const fragments = [];

  for (const [index, current] of boxes.entries()) {
    if (current.type !== 'moof') continue;

    const traf = findPath(bytes, [current], ['moof', 'traf']);
    const tfdt = traf ? children(bytes, traf).find((b) => b.type === 'tfdt') : null;
    if (!tfdt) return null;

    let end = current.end;
    for (let next = index + 1; next < boxes.length; next++) {
      if (boxes[next].type === 'moof') break;
      end = boxes[next].end;
    }

    fragments.push({
      start: current.start,
      end,
      moof: current,
      time: baseMediaDecodeTime(bytes, tfdt) / timescale
    });
  }

  return fragments.length ? fragments : null;
}

/**
 * Patches the track id and fragment sequence number in place and hands back a view
 * of the fragment. In place because the alternative — copying every fragment —
 * would hold a second copy of a multi-gigabyte lecture in the tab's memory, and the
 * buffer being patched is one this download allocated and nothing else reads.
 */
function rewriteFragment(bytes, fragment, trackId, sequence) {
  const moofChildren = children(bytes, fragment.moof);
  const mfhd = moofChildren.find((b) => b.type === 'mfhd');
  if (mfhd) writeU32(bytes, mfhd.contentStart + 4, sequence);
  for (const tfhd of findAll(bytes, moofChildren, 'tfhd')) setTrackId(bytes, tfhd, trackId);

  return bytes.subarray(fragment.start, fragment.end);
}

const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;

/**
 * One fragmented MP4 carrying both renditions, as a list of byte ranges to write in
 * order. Throws with a plain reason when the inputs are not shapes this can combine;
 * the caller answers every one of those the same way, by saving the two files side
 * by side instead.
 */
export function muxAudioIntoVideo(videoBytes, audioBytes) {
  const video = readInit(videoBytes);
  if (!video) throw new Error('The video stream is not a fragmented MP4.');
  const audio = readInit(audioBytes);
  if (!audio) throw new Error('The audio stream is not a fragmented MP4.');

  const videoFragments = readFragments(videoBytes, { from: video.moov.end, timescale: video.timescale });
  const audioFragments = readFragments(audioBytes, { from: audio.moov.end, timescale: audio.timescale });
  if (!videoFragments) throw new Error('The video stream carries no timed fragments.');
  if (!audioFragments) throw new Error('The audio stream carries no timed fragments.');

  // Renumbering both tracks rather than only the audio one keeps the output's ids
  // predictable whatever the source used, and costs two writes.
  const videoTrak = videoBytes.slice(video.trak.start, video.trak.end);
  const videoTkhd = findPath(videoTrak, parseBoxes(videoTrak), ['trak', 'tkhd']);
  setTrackId(videoTrak, videoTkhd, VIDEO_TRACK_ID);

  const audioTrak = audioBytes.slice(audio.trak.start, audio.trak.end);
  const audioTkhd = findPath(audioTrak, parseBoxes(audioTrak), ['trak', 'tkhd']);
  setTrackId(audioTrak, audioTkhd, AUDIO_TRACK_ID);

  const videoTrex = videoBytes.slice(video.trex.start, video.trex.end);
  setTrackId(videoTrex, parseBoxes(videoTrex)[0], VIDEO_TRACK_ID);
  const audioTrex = audioBytes.slice(audio.trex.start, audio.trex.end);
  setTrackId(audioTrex, parseBoxes(audioTrex)[0], AUDIO_TRACK_ID);

  const mvhd = videoBytes.slice(video.mvhd.start, video.mvhd.end);
  // next_track_ID is the last field of mvhd, and a player that adds a track trusts it.
  writeU32(mvhd, mvhd.length - 4, AUDIO_TRACK_ID + 1);

  const moov = flatten(
    box('moov', [mvhd, videoTrak, audioTrak, ...box('mvex', [videoTrex, audioTrex])])
  );

  const parts = [slice(videoBytes, video.ftyp), moov];
  let v = 0;
  let a = 0;
  let sequence = 1;

  // Interleaved by decode time so a player reading the file straight through always
  // has the audio for the picture it is about to show.
  while (v < videoFragments.length || a < audioFragments.length) {
    const takeVideo =
      a >= audioFragments.length ||
      (v < videoFragments.length && videoFragments[v].time <= audioFragments[a].time);

    parts.push(
      takeVideo
        ? rewriteFragment(videoBytes, videoFragments[v++], VIDEO_TRACK_ID, sequence++)
        : rewriteFragment(audioBytes, audioFragments[a++], AUDIO_TRACK_ID, sequence++)
    );
  }

  return parts;
}

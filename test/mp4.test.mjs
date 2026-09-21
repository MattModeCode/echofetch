import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBoxes, findPath, readInit, readFragments, muxAudioIntoVideo, readU32 } from '../src/mp4.js';

function box(type, payload = new Uint8Array(0)) {
  const out = new Uint8Array(payload.length + 8);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function join(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return out;
}

function fill(length) {
  return new Uint8Array(length);
}

function initSegment({ trackId, timescale, handler }) {
  const mvhd = box('mvhd', join(u32(0, 0, 0, 1000, 0), fill(76), u32(trackId + 1)));
  const tkhd = box('tkhd', join(u32(0, 0, 0, trackId), fill(60)));
  const mdhd = box('mdhd', join(u32(0, 0, 0, timescale), fill(8)));
  const hdlr = box('hdlr', join(u32(0, 0), new Uint8Array([...handler].map((c) => c.charCodeAt(0))), fill(12)));
  const mdia = box('mdia', join(mdhd, hdlr));
  const trak = box('trak', join(tkhd, mdia));
  const trex = box('trex', u32(0, trackId, 1, 0, 0, 0));
  const mvex = box('mvex', trex);

  return join(box('ftyp', u32(0x69736f35, 0, 0)), box('moov', join(mvhd, trak, mvex)));
}

function fragment({ trackId, decodeTime, payloadSize = 16, sequence = 7 }) {
  const mfhd = box('mfhd', u32(0, sequence));
  const tfhd = box('tfhd', u32(0, trackId));
  // Version 1: a 64-bit base media decode time, which is what real fMP4 uses.
  const tfdt = box('tfdt', join(new Uint8Array([1, 0, 0, 0]), u32(0, decodeTime)));
  const trun = box('trun', u32(0, 1, 0));
  const moof = box('moof', join(mfhd, box('traf', join(tfhd, tfdt, trun))));
  return join(moof, box('mdat', fill(payloadSize)));
}

function videoStream(times) {
  return join(
    initSegment({ trackId: 1, timescale: 90000, handler: 'vide' }),
    ...times.map((seconds) => fragment({ trackId: 1, decodeTime: seconds * 90000 }))
  );
}

function audioStream(times, { trackId = 1 } = {}) {
  return join(
    initSegment({ trackId, timescale: 48000, handler: 'soun' }),
    ...times.map((seconds) => fragment({ trackId, decodeTime: seconds * 48000 }))
  );
}

function topLevelTypes(bytes) {
  return parseBoxes(bytes).map((b) => b.type);
}

function flattenParts(parts) {
  return join(...parts.map((part) => new Uint8Array(part)));
}

test('parses top-level boxes and stops at a truncated one', () => {
  const good = join(box('ftyp', u32(1)), box('moov', u32(2)));
  assert.deepEqual(topLevelTypes(good), ['ftyp', 'moov']);

  const truncated = good.subarray(0, good.length - 4);
  assert.deepEqual(topLevelTypes(truncated), ['ftyp']);
});

test('reads track id, timescale and handler from an init segment', () => {
  const init = readInit(initSegment({ trackId: 3, timescale: 48000, handler: 'soun' }));
  assert.equal(init.trackId, 3);
  assert.equal(init.timescale, 48000);
  assert.equal(init.handler, 'soun');
});

test('rejects anything that is not a single-track fragmented MP4 init', () => {
  // MPEG-TS: sync bytes, no boxes at all.
  assert.equal(readInit(new Uint8Array([0x47, 0, 0, 0, 0x47, 0, 0, 0])), null);
  // Fragments with no init in front of them.
  assert.equal(readInit(fragment({ trackId: 1, decodeTime: 0 })), null);
});

test('reads every fragment with the time it starts at', () => {
  const stream = videoStream([0, 2, 4]);
  const init = readInit(stream);
  const fragments = readFragments(stream, { from: init.moov.end, timescale: init.timescale });

  assert.equal(fragments.length, 3);
  assert.deepEqual(fragments.map((f) => f.time), [0, 2, 4]);
});

test('muxes audio into the video as one file with two tracks', () => {
  const output = flattenParts(muxAudioIntoVideo(videoStream([0, 2]), audioStream([0, 2])));

  assert.deepEqual(topLevelTypes(output), ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);

  const boxes = parseBoxes(output);
  const moov = boxes.find((b) => b.type === 'moov');
  const moovChildren = parseBoxes(output, moov.contentStart, moov.end);
  const traks = moovChildren.filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);

  const trackIds = traks.map((trak) => {
    const tkhd = findPath(output, [trak], ['trak', 'tkhd']);
    return readU32(output, tkhd.contentStart + 12);
  });
  assert.deepEqual(trackIds, [1, 2]);

  const mvex = moovChildren.find((b) => b.type === 'mvex');
  const trexIds = parseBoxes(output, mvex.contentStart, mvex.end).map((trex) =>
    readU32(output, trex.contentStart + 4)
  );
  assert.deepEqual(trexIds, [1, 2]);

  const mvhd = moovChildren.find((b) => b.type === 'mvhd');
  assert.equal(readU32(output, mvhd.end - 4), 3, 'next_track_ID leaves room for the audio track');
});

test('fragments come out interleaved by decode time, renumbered and retagged', () => {
  const output = flattenParts(muxAudioIntoVideo(videoStream([0, 2, 4]), audioStream([1, 3])));

  const moofs = parseBoxes(output).filter((b) => b.type === 'moof');
  assert.equal(moofs.length, 5);

  const tagged = moofs.map((moof) => {
    const mfhd = findPath(output, [moof], ['moof', 'mfhd']);
    const tfhd = findPath(output, [moof], ['moof', 'traf', 'tfhd']);
    return {
      sequence: readU32(output, mfhd.contentStart + 4),
      trackId: readU32(output, tfhd.contentStart + 4)
    };
  });

  assert.deepEqual(tagged.map((f) => f.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(tagged.map((f) => f.trackId), [1, 2, 1, 2, 1]);
});

test('an audio rendition that already uses track id 1 is renumbered, not collided', () => {
  const output = flattenParts(muxAudioIntoVideo(videoStream([0]), audioStream([0], { trackId: 1 })));
  const moofs = parseBoxes(output).filter((b) => b.type === 'moof');
  const ids = moofs.map((moof) => readU32(output, findPath(output, [moof], ['moof', 'traf', 'tfhd']).contentStart + 4));
  assert.deepEqual(ids, [1, 2]);
});

test('refuses shapes it cannot combine instead of writing a broken file', () => {
  assert.throws(
    () => muxAudioIntoVideo(new Uint8Array([0x47, 0, 0, 0]), audioStream([0])),
    /not a fragmented MP4/
  );
  assert.throws(
    () => muxAudioIntoVideo(videoStream([0]), initSegment({ trackId: 1, timescale: 48000, handler: 'soun' })),
    /no timed fragments/
  );
});

// Run with: node --test
//
// These cover the byte-range playlist shape that Echo360 actually serves. Before
// EXT-X-BYTERANGE was parsed, every segment resolved to the same whole-file URL and
// the downloader fetched the entire lecture once per segment: a 59-minute lecture
// whose real stream is 10.7 MB was written to disk as 3.87 GB, 361 identical copies.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseMedia, parseMaster, rangeHeader, containerFor } from '../src/hls.js';

const BASE = 'https://cdn.example.edu/lecture/index.m3u8';

const BYTE_RANGE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="lecture.mp4",BYTERANGE="1024@0"
#EXTINF:10.0,
#EXT-X-BYTERANGE:20000@1024
lecture.mp4
#EXTINF:10.0,
#EXT-X-BYTERANGE:21000
lecture.mp4
#EXTINF:10.0,
#EXT-X-BYTERANGE:22000
lecture.mp4
#EXT-X-ENDLIST
`;

test('byte ranges are parsed, including the offset-less continuation form', () => {
  const parsed = parseMedia(BYTE_RANGE_PLAYLIST, BASE);

  assert.equal(parsed.segments.length, 3);
  assert.equal(parsed.byteRanged, true);

  assert.deepEqual(parsed.initSegment.byteRange, { offset: 0, length: 1024 });

  // An omitted offset continues from the end of the previous sub-range of that URL.
  assert.deepEqual(
    parsed.segments.map((s) => s.byteRange),
    [
      { offset: 1024, length: 20000 },
      { offset: 21024, length: 21000 },
      { offset: 42024, length: 22000 }
    ]
  );
});

test('every segment shares one URL, which is what made the old bug possible', () => {
  const parsed = parseMedia(BYTE_RANGE_PLAYLIST, BASE);
  const distinct = new Set(parsed.segments.map((s) => s.url));

  assert.equal(distinct.size, 1);
  assert.equal([...distinct][0], 'https://cdn.example.edu/lecture/lecture.mp4');
});

test('expectedBytes is the real file size, not a bandwidth guess', () => {
  const parsed = parseMedia(BYTE_RANGE_PLAYLIST, BASE);
  assert.equal(parsed.expectedBytes, 1024 + 20000 + 21000 + 22000);
});

test('the assembled size is the sum of the ranges, not the file once per segment', () => {
  const parsed = parseMedia(BYTE_RANGE_PLAYLIST, BASE);
  const fileSize = parsed.expectedBytes;

  const fixed =
    parsed.segments.reduce((n, s) => n + s.byteRange.length, 0) +
    parsed.initSegment.byteRange.length;
  const broken = fileSize * (parsed.segments.length + 1); // init + one file per segment

  assert.equal(fixed, fileSize);
  assert.equal(broken, fileSize * 4);
  assert.ok(fixed < broken);
});

test('a playlist with no byte ranges is unchanged', () => {
  const plain = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10.0,
seg0.ts
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;
  const parsed = parseMedia(plain, BASE);

  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.byteRanged, false);
  assert.equal(parsed.expectedBytes, 0);
  assert.equal(parsed.segments[0].byteRange, null);
  assert.equal(parsed.segments[0].url, 'https://cdn.example.edu/lecture/seg0.ts');
  assert.equal(containerFor(parsed).extension, 'ts');
});

test('the guard condition fires on identical URLs with no ranges, and not otherwise', () => {
  const identicalNoRanges = `#EXTM3U
#EXTINF:10.0,
lecture.mp4
#EXTINF:10.0,
lecture.mp4
#EXT-X-ENDLIST
`;
  const suspect = parseMedia(identicalNoRanges, BASE);
  const trips = (p) =>
    p.segments.length > 1 &&
    new Set(p.segments.map((s) => s.url)).size === 1 &&
    !p.byteRanged;

  assert.equal(trips(suspect), true);
  assert.equal(trips(parseMedia(BYTE_RANGE_PLAYLIST, BASE)), false);
});

test('malformed ranges are dropped rather than producing a bad Range header', () => {
  const malformed = `#EXTM3U
#EXTINF:10.0,
#EXT-X-BYTERANGE:notanumber@0
lecture.mp4
#EXTINF:10.0,
#EXT-X-BYTERANGE:5000
other.mp4
#EXT-X-ENDLIST
`;
  const parsed = parseMedia(malformed, BASE);

  // No usable length -> no range at all.
  assert.equal(parsed.segments[0].byteRange, null);
  // Offset omitted with no prior sub-range for that URL -> no range rather than NaN.
  assert.equal(parsed.segments[1].byteRange, null);
});

test('rangeHeader is inclusive at both ends', () => {
  assert.equal(rangeHeader({ offset: 0, length: 1024 }), 'bytes=0-1023');
  assert.equal(rangeHeader({ offset: 1024, length: 20000 }), 'bytes=1024-21023');
});

test('fMP4 byte-range streams still resolve to an mp4 container', () => {
  const parsed = parseMedia(BYTE_RANGE_PLAYLIST, BASE);
  assert.equal(containerFor(parsed, 'video').extension, 'mp4');
  assert.equal(containerFor(parsed, 'audio').extension, 'm4a');
});

test('master playlists still list variants and audio renditions', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e",AUDIO="aac"
video/360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f",AUDIO="aac"
video/720/index.m3u8
`;
  const { variants, audioGroups } = parseMaster(master, BASE);

  assert.equal(variants.length, 2);
  assert.equal(variants[0].height, 720); // sorted by bandwidth, highest first
  assert.equal(variants[0].audioGroup, 'aac');
  assert.equal(audioGroups.get('aac').length, 1);
});

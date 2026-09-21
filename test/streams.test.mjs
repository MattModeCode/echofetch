import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, cleanTitle, pickDefault } from '../src/streams.js';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Audio",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080,AUDIO="a1"
fhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,AUDIO="a1"
hd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,AUDIO="a1"
sd.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
segment.mp4
#EXT-X-ENDLIST
`;

const get = async (url) => (url.includes('master.m3u8') ? MASTER : MEDIA);

test('cleanTitle drops the site name the tab title carries', () => {
  assert.equal(cleanTitle('SOCPSY 1Z03 Conformity | Echo360'), 'SOCPSY 1Z03 Conformity');
  assert.equal(cleanTitle(''), 'Lecture');
});

test('buildOptions lists each rendition with its companion audio', async () => {
  const groups = await buildOptions([{ url: 'https://cdn.example/master.m3u8' }], [], { get });

  assert.deepEqual(groups.video.map((option) => option.height), [1080, 720, 360]);
  assert.ok(groups.video.every((option) => option.audioUrl), 'every row carries sound');
  assert.equal(groups.audio.length, 1, 'one audio row, however many groups publish it');
  assert.equal(groups.silentOnly, false);
});

test('buildOptions survives a playlist it cannot fetch', async () => {
  const groups = await buildOptions([{ url: 'https://cdn.example/master.m3u8' }], [], {
    get: async () => {
      throw new Error('offline');
    }
  });
  assert.deepEqual(groups.video, []);
});

test('pickDefault takes the largest rendition at or below the cap', async () => {
  const groups = await buildOptions([{ url: 'https://cdn.example/master.m3u8' }], [], { get });
  assert.equal(pickDefault(groups, { maxHeight: 720 }).height, 720);
  assert.equal(pickDefault(groups, { maxHeight: 1080 }).height, 1080);
});

test('pickDefault takes the smallest when every rendition is above the cap', async () => {
  const groups = await buildOptions([{ url: 'https://cdn.example/master.m3u8' }], [], { get });
  // Unattended this is the difference between a term of lectures and a full disk: a
  // cap that cannot be met is still a request for the smallest file, not the largest.
  assert.equal(pickDefault(groups, { maxHeight: 240 }).height, 360);
});

test('pickDefault honours audio only when the lecture publishes it', async () => {
  const groups = await buildOptions([{ url: 'https://cdn.example/master.m3u8' }], [], { get });
  assert.equal(pickDefault(groups, { maxHeight: 720, audioOnly: true }).kind, 'audio');
  assert.equal(
    pickDefault({ video: groups.video, audio: [], transcript: [] }, { audioOnly: true }).kind,
    'video',
    'asking for audio that does not exist still downloads the lecture'
  );
});

test('pickDefault returns nothing when a lecture offers nothing', () => {
  assert.equal(pickDefault({ video: [], audio: [], transcript: [] }, { maxHeight: 720 }), null);
});

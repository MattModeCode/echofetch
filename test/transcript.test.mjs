import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTranscript, toVtt, toText, renderTranscript, formatTimestamp } from '../src/transcript.js';

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Right, so the first thing.

2
00:00:03.500 --> 00:00:06.000
<v Lecturer>Social psychology asks</v>

3
00:00:20.000 --> 00:00:22.000
A new thought entirely.
`;

const SRT = `1
00:00:01,000 --> 00:00:03,500
Right, so the first thing.

2
00:00:03,500 --> 00:00:06,000
Social psychology asks
`;

test('parses WebVTT into ordered cues and strips inline tags', () => {
  const cues = parseTranscript(VTT);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { start: 1, end: 3.5, text: 'Right, so the first thing.' });
  assert.equal(cues[1].text, 'Social psychology asks');
});

test('parses SubRip, whose only difference is the comma', () => {
  const cues = parseTranscript(SRT);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].end, 6);
});

test("parses the player's JSON cue list, including millisecond keys", () => {
  const cues = parseTranscript(
    JSON.stringify({ cues: [{ startTimeMs: 1500, endTimeMs: 2500, content: 'From JSON' }] })
  );
  assert.deepEqual(cues, [{ start: 1.5, end: 2.5, text: 'From JSON' }]);
});

test('cues come back in time order whatever order they arrived in', () => {
  const cues = parseTranscript(
    JSON.stringify([
      { start: 9, end: 10, text: 'second' },
      { start: 1, end: 2, text: 'first' }
    ])
  );
  assert.deepEqual(cues.map((c) => c.text), ['first', 'second']);
});

test('an empty or unreadable transcript throws rather than saving nothing', () => {
  assert.throws(() => parseTranscript(''), /empty/);
  assert.throws(() => parseTranscript('   '), /empty/);
  assert.throws(() => parseTranscript('{"cues":[]}'), /Could not read/);
});

test('writes WebVTT with timestamps a player will accept', () => {
  const vtt = toVtt(parseTranscript(VTT));
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.500/);
  assert.equal(vtt.trim().split(/\n\s*\n/).length, 4, 'header plus one block per cue');
});

test('writes plain text as paragraphs, broken where the speaker paused', () => {
  const text = toText(parseTranscript(VTT));
  assert.equal(
    text.trim(),
    'Right, so the first thing. Social psychology asks\n\nA new thought entirely.'
  );
  assert.doesNotMatch(text, /-->/);
});

test('a short pause mid-sentence does not start a new paragraph', () => {
  const text = toText([
    { start: 0, end: 1, text: 'the thing about this is' },
    { start: 5, end: 6, text: 'that it continues.' }
  ]);
  assert.equal(text.trim(), 'the thing about this is that it continues.');
});

test('a long silence breaks the paragraph even with no punctuation to go on', () => {
  const text = toText([
    { start: 0, end: 1, text: 'no punctuation anywhere in this one' },
    { start: 30, end: 31, text: 'but the lecturer clearly stopped' }
  ]);
  assert.equal(text.trim().split(/\n\n/).length, 2);
});

test('renderTranscript picks the format the picker asked for', () => {
  assert.match(renderTranscript(VTT, 'vtt'), /^WEBVTT/);
  assert.doesNotMatch(renderTranscript(VTT, 'txt'), /WEBVTT/);
});

test('formats timestamps as hours, minutes, seconds and milliseconds', () => {
  assert.equal(formatTimestamp(0), '00:00:00.000');
  assert.equal(formatTimestamp(3661.25), '01:01:01.250');
  assert.equal(formatTimestamp(-5), '00:00:00.000');
});

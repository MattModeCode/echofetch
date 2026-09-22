import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignOrdinals,
  dateOnly,
  destinationsFor,
  lectureStem,
  pad2,
  slugifyCourse
} from '../src/naming.js';

test('slugifyCourse replaces spaces with dashes, matching the files already on disk', () => {
  assert.equal(slugifyCourse('SOCPSY 1Z03'), 'SOCPSY-1Z03');
  assert.equal(slugifyCourse('PHYSICS 1D03'), 'PHYSICS-1D03');
});

test('slugifyCourse strips characters that are unsafe in a filename', () => {
  assert.equal(slugifyCourse('MATH/1ZA3'), 'MATH1ZA3');
  assert.equal(slugifyCourse('  ENGINEER 1P13  '), 'ENGINEER-1P13');
});

test('slugifyCourse rejects an empty course folder', () => {
  assert.throws(() => slugifyCourse(''), TypeError);
  assert.throws(() => slugifyCourse('   '), TypeError);
});

test('dateOnly reads the calendar day off an ISO timestamp', () => {
  assert.equal(dateOnly('2026-09-15T13:30:00.000Z'), '2026-09-15');
});

test('dateOnly accepts a bare date and falls back to Date parsing otherwise', () => {
  assert.equal(dateOnly('2026-09-15'), '2026-09-15');
  assert.equal(dateOnly('September 15 2026 13:30 UTC'), '2026-09-15');
});

test('dateOnly rejects a date it cannot make sense of', () => {
  assert.throws(() => dateOnly('not a date'), TypeError);
  assert.throws(() => dateOnly(''), TypeError);
});

test('pad2 zero-pads to two digits and leaves larger numbers alone', () => {
  assert.equal(pad2(1), '01');
  assert.equal(pad2(9), '09');
  assert.equal(pad2(23), '23');
});

test('lectureStem builds <COURSE>-L<NN>-<date>', () => {
  const stem = lectureStem({
    courseFolder: 'SOCPSY 1Z03',
    publishedAt: '2026-09-15T13:30:00.000Z',
    ordinal: 2
  });
  assert.equal(stem, 'SOCPSY-1Z03-L02-2026-09-15');
});

test('lectureStem rejects a non-positive or non-integer ordinal', () => {
  const base = { courseFolder: 'SOCPSY 1Z03', publishedAt: '2026-09-15' };
  assert.throws(() => lectureStem({ ...base, ordinal: 0 }), TypeError);
  assert.throws(() => lectureStem({ ...base, ordinal: -1 }), TypeError);
  assert.throws(() => lectureStem({ ...base, ordinal: 1.5 }), TypeError);
  assert.throws(() => lectureStem({ ...base, ordinal: undefined }), TypeError);
});

test('assignOrdinals sorts by calendar day, one-based, matching the term order', () => {
  const lectures = [
    { lessonId: 'c', publishedAt: '2026-09-22T13:30:00.000Z' },
    { lessonId: 'a', publishedAt: '2026-09-08T13:30:00.000Z' },
    { lessonId: 'b', publishedAt: '2026-09-15T13:30:00.000Z' }
  ];
  const ordinals = assignOrdinals(lectures);
  assert.equal(ordinals.get('a'), 1);
  assert.equal(ordinals.get('b'), 2);
  assert.equal(ordinals.get('c'), 3);
});

test('assignOrdinals breaks a same-day tie by start time, not by list order', () => {
  const lectures = [
    { lessonId: 'later', publishedAt: '2026-09-08T15:30:00.000Z' },
    { lessonId: 'earlier', publishedAt: '2026-09-08T09:30:00.000Z' }
  ];
  const ordinals = assignOrdinals(lectures);
  assert.equal(ordinals.get('earlier'), 1);
  assert.equal(ordinals.get('later'), 2);
});

test('assignOrdinals is idempotent: the same list always produces the same ordinals', () => {
  const lectures = [
    { lessonId: 'x', publishedAt: '2026-09-08T13:30:00.000Z' },
    { lessonId: 'y', publishedAt: '2026-09-15T13:30:00.000Z' },
    { lessonId: 'z', publishedAt: '2026-09-22T13:30:00.000Z' }
  ];
  const first = assignOrdinals(lectures);
  const second = assignOrdinals([...lectures].reverse());
  assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());
});

test('assignOrdinals throws for a lecture with no id to key on', () => {
  assert.throws(() => assignOrdinals([{ publishedAt: '2026-09-08' }]), TypeError);
});

test('destinationsFor lays out video, transcript and audio under _media/', () => {
  const dest = destinationsFor({
    courseFolder: 'PHYSICS 1D03',
    publishedAt: '2026-09-15T13:30:00.000Z',
    ordinal: 3
  });
  assert.equal(dest.stem, 'PHYSICS-1D03-L03-2026-09-15');
  assert.equal(dest.video.path, '_media/recordings/PHYSICS-1D03-L03-2026-09-15.mp4');
  assert.equal(dest.transcript.path, '_media/transcripts/PHYSICS-1D03-L03-2026-09-15.vtt');
  assert.equal(dest.audio.path, '_media/audio/PHYSICS-1D03-L03-2026-09-15.m4a');
});

test('destinationsFor matches the naming already on disk for SOCPSY transcripts', () => {
  const dest = destinationsFor({
    courseFolder: 'SOCPSY 1Z03',
    publishedAt: '2026-09-15T13:30:00.000Z',
    ordinal: 2
  });
  assert.equal(dest.transcript.filename, 'SOCPSY-1Z03-L02-2026-09-15.vtt');
});

test('destinationsFor is a pure function: identical input, identical output, every call', () => {
  const input = { courseFolder: 'MATH 1ZA3', publishedAt: '2026-09-08T13:30:00.000Z', ordinal: 1 };
  assert.deepEqual(destinationsFor(input), destinationsFor({ ...input }));
});

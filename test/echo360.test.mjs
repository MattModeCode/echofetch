import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NotFoundError,
  SessionExpiredError,
  assertContent,
  classroomUrl,
  optionsFromMediaFiles,
  parseMediaFiles,
  getText,
  isDownloadable,
  looksLikeHtml,
  originOf,
  parseEnrollments,
  parseSyllabus,
  syllabusUrl,
  transcriptUrl
} from '../src/echo360.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const SECTION = '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';

test('originOf accepts a host, a URL, and nothing else', () => {
  assert.equal(originOf('echo360.ca'), 'https://echo360.ca');
  assert.equal(originOf('https://echo360.org/section/x/home'), 'https://echo360.org');
  assert.throws(() => originOf(''), TypeError);
});

test('the endpoint URLs are built from the course host, not a hard-coded one', () => {
  assert.equal(syllabusUrl('echo360.ca', SECTION), `https://echo360.ca/section/${SECTION}/syllabus`);
  assert.equal(
    transcriptUrl('echo360.ca', 'lesson-1', 'media-1', 'vtt'),
    'https://echo360.ca/api/ui/echoplayer/lessons/lesson-1/medias/media-1/transcript-file?format=vtt'
  );
  assert.equal(classroomUrl('echo360.org', 'lesson-1'), 'https://echo360.org/lesson/lesson-1/classroom');
});

test('parseSyllabus reads a lesson, its media and its date', () => {
  const lectures = parseSyllabus(fixture('syllabus'), { sectionId: SECTION });
  const first = lectures[0];

  assert.equal(first.lessonId, '11111111-1111-1111-1111-111111111111');
  assert.equal(first.mediaId, 'aaaaaaaa-1111-1111-1111-111111111111');
  assert.equal(first.title, 'What Is Social Psych', 'displayName wins over name');
  assert.equal(first.publishedAt, '2026-09-08T13:30:00.000Z');
  assert.equal(first.sectionId, SECTION);
});

test('parseSyllabus flattens a group instead of skipping what is inside it', () => {
  const lectures = parseSyllabus(fixture('syllabus'), { sectionId: SECTION });
  const grouped = lectures.find((l) => l.lessonId.startsWith('2222'));

  assert.ok(grouped, 'the lesson inside the Week 2 group is found');
  assert.equal(grouped.title, 'Attitudes and Persuasion');
});

test('parseSyllabus drops an entry with no lesson id', () => {
  const lectures = parseSyllabus(fixture('syllabus'), { sectionId: SECTION });
  assert.equal(lectures.length, 4);
  assert.ok(lectures.every((lecture) => lecture.lessonId));
});

test('parseSyllabus marks a lecture still processing, and one with no media', () => {
  const lectures = parseSyllabus(fixture('syllabus'), { sectionId: SECTION });
  const processing = lectures.find((l) => l.lessonId.startsWith('3333'));
  const empty = lectures.find((l) => l.lessonId.startsWith('4444'));

  assert.equal(processing.isProcessing, true);
  assert.equal(isDownloadable(processing), false, 'it is deferred, not queued');
  assert.equal(empty.mediaId, '');
  assert.equal(empty.isProcessing, true, 'hasContent false reads as not ready yet');
  assert.equal(isDownloadable(lectures[0]), true);
});

test('parseSyllabus tolerates an empty or unrecognized payload', () => {
  assert.deepEqual(parseSyllabus(null), []);
  assert.deepEqual(parseSyllabus({ data: [] }), []);
  assert.deepEqual(parseSyllabus({ nothing: true }), []);
});

test('parseEnrollments reads both field spellings and lowercases the id', () => {
  const sections = parseEnrollments(fixture('enrollments'));

  assert.equal(sections.length, 2, 'a section with no id is dropped');
  assert.equal(sections[0].sectionId, SECTION);
  assert.equal(sections[0].courseCode, 'SOCPSY 1Z03');
  assert.equal(sections[1].courseCode, 'MATH 1ZA3', 'read through course.code');
  assert.equal(sections[1].courseName, 'Calculus');
});

test('parseMediaFiles keeps the size published beside each rendition', () => {
  const files = parseMediaFiles(fixture('player-properties'));

  assert.equal(files.length, 4);
  assert.deepEqual(
    files.filter((file) => !file.isAudio).map((file) => file.height),
    [1080, 720, 360]
  );
  assert.equal(files.filter((file) => file.isAudio).length, 1, 'the audio track has no size');
  assert.deepEqual(parseMediaFiles({ nothing: 'here' }), []);
});

test('optionsFromMediaFiles pairs every rendition with the one soundtrack', () => {
  const groups = optionsFromMediaFiles(parseMediaFiles(fixture('player-properties')));

  assert.deepEqual(groups.video.map((option) => option.height), [1080, 720, 360]);
  assert.ok(groups.video.every((option) => option.audioUrl.includes('audio.m3u8')));
  assert.equal(groups.audio.length, 1);
  assert.equal(groups.silentOnly, false);
});

test('optionsFromMediaFiles warns rather than lies when a lecture has no sound', () => {
  const groups = optionsFromMediaFiles([{ url: 'a.m3u8', height: 720, width: 1280, isAudio: false }]);
  assert.equal(groups.video[0].audioUrl, null);
  assert.equal(groups.silentOnly, true);
});

test('a login page answered as 200 is treated as an expired session', () => {
  assert.equal(looksLikeHtml('<!DOCTYPE html><html>'), true);
  assert.equal(looksLikeHtml('WEBVTT\n\n00:00.000 --> 00:02.000'), false);
  assert.throws(() => assertContent('<html><body>Sign in</body></html>'), SessionExpiredError);
  assert.throws(() => assertContent('   '), NotFoundError);
  assert.equal(assertContent('WEBVTT'), 'WEBVTT');
});

const response = (status, body = '', headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (key) => headers[key] ?? null },
  text: async () => body
});

test('getText returns the body of a plain success', async () => {
  const fetchImpl = async () => response(200, 'WEBVTT');
  assert.equal(await getText('https://echo360.ca/x', { fetchImpl }), 'WEBVTT');
});

test('getText never retries a signed-out response', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(403);
  };
  await assert.rejects(() => getText('https://echo360.ca/x', { fetchImpl }), SessionExpiredError);
  assert.equal(calls, 1, 'asking again does not sign anyone back in');
});

test('getText reports a missing transcript as not found, without retrying', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(404);
  };
  await assert.rejects(() => getText('https://echo360.ca/x', { fetchImpl }), NotFoundError);
  assert.equal(calls, 1);
});

test('getText retries a rate limit and then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? response(429, '', { 'Retry-After': '0' }) : response(200, 'WEBVTT');
  };
  assert.equal(await getText('https://echo360.ca/x', { fetchImpl, attempts: 2 }), 'WEBVTT');
  assert.equal(calls, 2);
});

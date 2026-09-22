import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/settings.js';
import {
  findCourse,
  isWatchableUrl,
  normalizeCourse,
  parseSectionId,
  readCourses,
  removeCourse,
  resolveCourseFolder,
  resolveCourseSettings,
  upsertCourse
} from '../src/watchlist.js';

const SECTION = '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';

test('parseSectionId reads the section id and host from a course URL', () => {
  const parsed = parseSectionId(`https://echo360.ca/section/${SECTION}/home`);
  assert.deepEqual(parsed, { sectionId: SECTION, host: 'echo360.ca' });
});

test('parseSectionId handles the hash-routed form older institutions serve', () => {
  const parsed = parseSectionId(`https://echo360.org/#/section/${SECTION.toUpperCase()}/syllabus`);
  assert.equal(parsed.sectionId, SECTION);
});

test('parseSectionId returns null for a page that names no section', () => {
  assert.equal(parseSectionId('https://echo360.org/lesson/abc/classroom'), null);
  assert.equal(parseSectionId('https://example.com'), null);
  assert.equal(parseSectionId(undefined), null);
  assert.equal(isWatchableUrl(`https://echo360.org/section/${SECTION}/home`), true);
});

test('normalizeCourse fills the defaults and keeps overrides unset', () => {
  const course = normalizeCourse({ sectionId: SECTION, label: ' SOCPSY 1Z03 ' });
  assert.equal(course.label, 'SOCPSY 1Z03');
  assert.equal(course.maxHeight, null);
  assert.equal(course.includeAudio, null);
  assert.equal(course.enabled, true);
  assert.equal(course.pollMinutes, 60);
  assert.equal(course.courseFolder, '');
  assert.equal(course.courseCode, '');
});

test('normalizeCourse trims a courseFolder/courseCode pair when given one', () => {
  const course = normalizeCourse({
    sectionId: SECTION,
    courseFolder: ' PHYSICS 1D03 ',
    courseCode: ' PHYSICS 1D03 '
  });
  assert.equal(course.courseFolder, 'PHYSICS 1D03');
  assert.equal(course.courseCode, 'PHYSICS 1D03');
});

test('normalizeCourse derives the section id from a URL when none is given', () => {
  const course = normalizeCourse({ url: `https://echo360.ca/section/${SECTION}/home` });
  assert.equal(course.sectionId, SECTION);
  assert.equal(course.host, 'echo360.ca');
});

test('normalizeCourse sanitizes the folder and coerces the overrides', () => {
  const course = normalizeCourse({
    sectionId: SECTION,
    folder: '../../School/Psych/',
    maxHeight: '1080',
    includeAudio: false,
    transcript: 1
  });
  assert.equal(course.folder, 'School/Psych');
  assert.equal(course.maxHeight, 1080);
  assert.equal(course.includeAudio, false);
  assert.equal(course.transcript, true);
});

test('normalizeCourse refuses a course with no section id', () => {
  assert.throws(() => normalizeCourse({ label: 'Psych' }), TypeError);
  assert.throws(() => normalizeCourse({ sectionId: 'not-a-uuid' }), TypeError);
});

test('readCourses drops rows an older version may have written', () => {
  const courses = readCourses([{ sectionId: SECTION }, { label: 'broken' }, null]);
  assert.equal(courses.length, 1);
  assert.equal(readCourses(undefined).length, 0);
});

test('upsertCourse adds once and then merges without mutating the list', () => {
  const first = upsertCourse([], { sectionId: SECTION, label: 'Psych' });
  const second = upsertCourse(first, { sectionId: SECTION, maxHeight: 360 });

  assert.equal(second.length, 1);
  assert.equal(second[0].label, 'Psych');
  assert.equal(second[0].maxHeight, 360);
  assert.equal(first[0].maxHeight, null, 'the original list is untouched');
});

test('findCourse matches by id, by URL, and is case-insensitive', () => {
  const courses = upsertCourse([], { sectionId: SECTION });
  assert.ok(findCourse(courses, { sectionId: SECTION.toUpperCase() }));
  assert.ok(findCourse(courses, `https://echo360.org/section/${SECTION}/home`));
  assert.equal(findCourse(courses, 'https://example.com'), null);
});

test('removeCourse leaves the other courses alone', () => {
  const other = '11111111-2222-3333-4444-555555555555';
  const courses = upsertCourse(upsertCourse([], { sectionId: SECTION }), { sectionId: other });
  const left = removeCourse(courses, SECTION);
  assert.deepEqual(left.map((course) => course.sectionId), [other]);
});

const settings = { ...DEFAULTS, maxHeight: 720, includeAudio: true, audioOnlyDefault: false };

test('resolveCourseSettings follows the global default when nothing is overridden', () => {
  const course = normalizeCourse({ sectionId: SECTION });
  assert.deepEqual(resolveCourseSettings(course, settings), {
    maxHeight: 720,
    includeAudio: true,
    audioOnly: false,
    transcript: false,
    concurrency: DEFAULTS.concurrency
  });
});

test('resolveCourseSettings lets a course override beat the global default', () => {
  const course = normalizeCourse({ sectionId: SECTION, maxHeight: 360, audioOnly: true });
  const resolved = resolveCourseSettings(course, settings);
  assert.equal(resolved.maxHeight, 360);
  assert.equal(resolved.audioOnly, true);
  assert.equal(resolved.includeAudio, true, 'an unset override still follows the global');
});

test('resolveCourseSettings keeps a false override distinct from unset', () => {
  const course = normalizeCourse({ sectionId: SECTION, includeAudio: false });
  assert.equal(resolveCourseSettings(course, settings).includeAudio, false);
});

test("resolveCourseFolder prefers the course's own folder over a matching rule", () => {
  const withRules = {
    ...settings,
    downloadFolder: 'Lectures',
    folderRules: [{ match: 'psych', matchKind: 'title', folder: 'Rule/Psych' }]
  };
  const course = normalizeCourse({ sectionId: SECTION, folder: 'School/SOCPSY' });
  const context = { title: 'Psych lecture 4', url: '' };

  assert.equal(resolveCourseFolder(course, context, withRules), 'School/SOCPSY');
  assert.equal(
    resolveCourseFolder(normalizeCourse({ sectionId: SECTION }), context, withRules),
    'Rule/Psych',
    'a course with no folder still falls through to the rules'
  );
});

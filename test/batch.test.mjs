import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSyllabus } from '../src/echo360.js';
import { TARGET_COURSES, planBatch, planCourseBatch, summarizeBatch } from '../src/batch.js';

const SECTION = '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const syllabus = JSON.parse(readFileSync(new URL('./fixtures/syllabus.json', import.meta.url), 'utf8'));
const lectures = parseSyllabus(syllabus, { sectionId: SECTION });

function course(overrides = {}) {
  return { sectionId: SECTION, courseFolder: 'SOCPSY 1Z03', courseCode: 'SOCPSY 1Z03', ...overrides };
}

test('TARGET_COURSES is exactly the five First Year courses', () => {
  assert.deepEqual(
    [...TARGET_COURSES].sort(),
    ['ENGINEER 1P13', 'MATH 1ZA3', 'MATH 1ZC3', 'PHYSICS 1D03', 'SOCPSY 1Z03'].sort()
  );
});

test('planCourseBatch only plans downloadable lectures', () => {
  // The fixture has 5 rows: available, available (grouped), still processing, no
  // media at all, and no lesson id. Only the first two are downloadable.
  const plan = planCourseBatch(course(), lectures);
  assert.equal(plan.length, 2);
});

test('planCourseBatch assigns ordinals by date across the whole course', () => {
  const plan = planCourseBatch(course(), lectures);
  const byLesson = Object.fromEntries(plan.map((item) => [item.lessonId, item.ordinal]));
  assert.equal(byLesson['11111111-1111-1111-1111-111111111111'], 1);
  assert.equal(byLesson['22222222-2222-2222-2222-222222222222'], 2);
});

test('planCourseBatch fills in video and transcript destinations for an in-term match', () => {
  const plan = planCourseBatch(course(), lectures);
  const first = plan.find((item) => item.ordinal === 1);
  assert.equal(first.quarantine.quarantine, false);
  assert.equal(first.video.path, '_media/recordings/SOCPSY-1Z03-L01-2026-09-08.mp4');
  assert.equal(first.transcript.path, '_media/transcripts/SOCPSY-1Z03-L01-2026-09-08.vtt');
});

test('planCourseBatch quarantines a course-code mismatch and still names the file', () => {
  const plan = planCourseBatch(course({ courseFolder: 'MATH 1ZC3', courseCode: 'MATH 1ZA3' }), lectures);
  const first = plan.find((item) => item.ordinal === 1);
  assert.equal(first.quarantine.quarantine, true);
  assert.equal(first.video.folder, '_media/_quarantine');
  assert.equal(first.video.path, '_media/_quarantine/MATH-1ZC3-L01-2026-09-08.mp4');
  assert.equal(first.video.reasonPath, '_media/_quarantine/MATH-1ZC3-L01-2026-09-08.mp4.reason.txt');
});

test('planCourseBatch never quarantines SOCPSY 1Z03 regardless of course-code mismatch', () => {
  const plan = planCourseBatch(course({ courseFolder: 'SOCPSY 1Z03', courseCode: 'MATH 1ZC3' }), lectures);
  assert.ok(plan.every((item) => item.quarantine.quarantine === false));
});

test('planCourseBatch is idempotent: re-planning the same list gives the same plan', () => {
  const first = planCourseBatch(course(), lectures);
  const second = planCourseBatch(course(), [...lectures]);
  assert.deepEqual(first, second);
});

test('planBatch plans every course keyed by section id', () => {
  const other = { sectionId: '11111111-1111-1111-1111-111111111111', courseFolder: 'PHYSICS 1D03' };
  const plans = planBatch([course(), other], { [SECTION]: lectures, [other.sectionId]: [] });
  assert.equal(plans[SECTION].length, 2);
  assert.equal(plans[other.sectionId].length, 0);
});

test('summarizeBatch counts queued versus quarantined across every course', () => {
  const mismatched = planCourseBatch(course({ courseFolder: 'MATH 1ZC3', courseCode: 'MATH 1ZA3' }), lectures);
  const clean = planCourseBatch(course(), lectures);
  const summary = summarizeBatch({ a: mismatched, b: clean });
  assert.equal(summary.quarantined, 2);
  assert.equal(summary.queued, 2);
  assert.equal(summary.total, 4);
});

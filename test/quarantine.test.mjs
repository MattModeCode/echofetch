import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALL_2026_TERM,
  QUARANTINE_DIR,
  evaluateQuarantine,
  isExempt,
  normalizeCourseCode,
  quarantineDestination,
  reasonDestination,
  termWindowFor
} from '../src/quarantine.js';

test('normalizeCourseCode collapses punctuation and case differences', () => {
  assert.equal(normalizeCourseCode('SOCPSY 1Z03'), normalizeCourseCode('socpsy-1z03'));
  assert.equal(normalizeCourseCode('SOCPSY 1Z03'), normalizeCourseCode('SOCPSY1Z03'));
  assert.equal(normalizeCourseCode('  PHYSICS  1D03 '), 'PHYSICS1D03');
});

test('isExempt is true only for SOCPSY 1Z03', () => {
  assert.equal(isExempt('SOCPSY 1Z03'), true);
  assert.equal(isExempt('PHYSICS 1D03'), false);
  assert.equal(isExempt(''), false);
});

test('termWindowFor falls back to Fall 2026 with no override', () => {
  assert.deepEqual(termWindowFor('MATH 1ZA3'), FALL_2026_TERM);
});

test('termWindowFor honours a per-course override', () => {
  const overrides = { 'MATH 1ZA3': { start: '2026-01-01', end: '2026-04-30' } };
  assert.deepEqual(termWindowFor('MATH 1ZA3', overrides), overrides['MATH 1ZA3']);
  assert.deepEqual(termWindowFor('PHYSICS 1D03', overrides), FALL_2026_TERM);
});

test('evaluateQuarantine passes a lecture inside the term with a matching course code', () => {
  const result = evaluateQuarantine({
    courseFolder: 'PHYSICS 1D03',
    sectionCourseCode: 'PHYSICS 1D03',
    date: '2026-09-15'
  });
  assert.deepEqual(result, { quarantine: false, reason: null });
});

test('evaluateQuarantine quarantines a date outside the term window', () => {
  const result = evaluateQuarantine({
    courseFolder: 'PHYSICS 1D03',
    sectionCourseCode: 'PHYSICS 1D03',
    date: '2020-10-30'
  });
  assert.equal(result.quarantine, true);
  assert.match(result.reason, /2020-10-30/);
  assert.match(result.reason, /PHYSICS 1D03/);
});

test('evaluateQuarantine quarantines a course-code mismatch', () => {
  const result = evaluateQuarantine({
    courseFolder: 'MATH 1ZC3',
    sectionCourseCode: 'MATH 1ZA3',
    date: '2026-09-15'
  });
  assert.equal(result.quarantine, true);
  assert.match(result.reason, /MATH 1ZA3/);
});

test('evaluateQuarantine treats a blank section course code as unknown, not a mismatch', () => {
  const result = evaluateQuarantine({
    courseFolder: 'MATH 1ZC3',
    sectionCourseCode: '',
    date: '2026-09-15'
  });
  assert.equal(result.quarantine, false);
});

test('evaluateQuarantine never quarantines SOCPSY 1Z03, even outside the term or mismatched', () => {
  const badDate = evaluateQuarantine({
    courseFolder: 'SOCPSY 1Z03',
    sectionCourseCode: 'SOCPSY 1Z03',
    date: '2020-01-01'
  });
  const badCourse = evaluateQuarantine({
    courseFolder: 'SOCPSY 1Z03',
    sectionCourseCode: 'MATH 1ZC3',
    date: '2026-09-15'
  });
  assert.deepEqual(badDate, { quarantine: false, reason: null });
  assert.deepEqual(badCourse, { quarantine: false, reason: null });
});

test('evaluateQuarantine respects a per-course term override', () => {
  const overrides = { 'MATH 1ZA3': { start: '2026-01-01', end: '2026-04-30' } };
  const inOwnWindow = evaluateQuarantine(
    { courseFolder: 'MATH 1ZA3', sectionCourseCode: 'MATH 1ZA3', date: '2026-02-01' },
    { termWindows: overrides }
  );
  const outsideFallDefault = evaluateQuarantine(
    { courseFolder: 'MATH 1ZA3', sectionCourseCode: 'MATH 1ZA3', date: '2026-09-15' },
    { termWindows: overrides }
  );
  assert.equal(inOwnWindow.quarantine, false);
  assert.equal(outsideFallDefault.quarantine, true);
});

test('quarantineDestination keeps the original filename under _media/_quarantine', () => {
  assert.equal(
    quarantineDestination('phys-1d03-2020-10-30--lec01-center-of-masses.mp4'),
    `${QUARANTINE_DIR}/phys-1d03-2020-10-30--lec01-center-of-masses.mp4`
  );
});

test('reasonDestination is the quarantined file plus .reason.txt', () => {
  assert.equal(
    reasonDestination('PHYSICS-1D03-L03-2026-09-15.mp4'),
    `${QUARANTINE_DIR}/PHYSICS-1D03-L03-2026-09-15.mp4.reason.txt`
  );
});

test('quarantineDestination rejects an empty filename', () => {
  assert.throws(() => quarantineDestination(''), TypeError);
});

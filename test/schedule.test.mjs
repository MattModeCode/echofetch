import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKER_THRESHOLD,
  DEFAULT_POLL_MINUTES,
  MAX_POLL_MINUTES,
  MIN_POLL_MINUTES,
  afterPoll,
  clampPollMinutes,
  dueCourses,
  failureBackoffMs,
  forgetState,
  isDue,
  readState,
  resumeCourse,
  scheduleNow,
  withJitter
} from '../src/schedule.js';

const course = (extra = {}) => ({
  sectionId: 'section-1',
  enabled: true,
  pollMinutes: 60,
  ...extra
});
const steady = () => 0.5;

test('clampPollMinutes holds the floor and the ceiling', () => {
  assert.equal(clampPollMinutes(1), MIN_POLL_MINUTES);
  assert.equal(clampPollMinutes(0), DEFAULT_POLL_MINUTES);
  assert.equal(clampPollMinutes('nonsense'), DEFAULT_POLL_MINUTES);
  assert.equal(clampPollMinutes(99_999), MAX_POLL_MINUTES);
  assert.equal(clampPollMinutes(60), 60);
});

test('withJitter stays within a tenth of the interval either way', () => {
  const base = 60_000;
  assert.equal(withJitter(base, () => 0), 54_000);
  assert.equal(withJitter(base, () => 1), 66_000);
  assert.equal(withJitter(base, steady), base);
});

test('a course with no state yet is due immediately', () => {
  assert.equal(isDue(course(), {}, 1000), true);
});

test('a disabled or paused course is never due', () => {
  assert.equal(isDue(course({ enabled: false }), {}, 1000), false);
  assert.equal(isDue(course(), { 'section-1': { paused: true, nextRunAt: 0 } }, 1000), false);
});

test('dueCourses returns only the ones whose time has come', () => {
  const courses = [course(), course({ sectionId: 'section-2' })];
  const states = { 'section-2': { nextRunAt: 5000 } };
  assert.deepEqual(
    dueCourses(courses, states, 1000).map((c) => c.sectionId),
    ['section-1']
  );
  assert.equal(dueCourses(courses, states, 6000).length, 2);
});

test('a successful poll schedules the next one an interval away', () => {
  const states = afterPoll({}, course(), { ok: true, now: 1000, rand: steady });
  const state = readState(states, 'section-1');

  assert.equal(state.lastCheckedAt, 1000);
  assert.equal(state.nextRunAt, 1000 + 60 * 60_000);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastError, null);
  assert.equal(state.paused, false);
});

test('a poll interval below the floor is raised to it', () => {
  const states = afterPoll({}, course({ pollMinutes: 2 }), { ok: true, now: 0, rand: steady });
  assert.equal(readState(states, 'section-1').nextRunAt, MIN_POLL_MINUTES * 60_000);
});

test('a failing poll backs off further each time', () => {
  let states = {};
  const first = afterPoll(states, course(), { ok: false, error: new Error('502'), now: 0, rand: steady });
  states = afterPoll(first, course(), { ok: false, error: new Error('502'), now: 0, rand: steady });

  assert.equal(readState(first, 'section-1').lastError, '502');
  assert.ok(readState(states, 'section-1').nextRunAt > readState(first, 'section-1').nextRunAt);
  assert.ok(failureBackoffMs(99) === failureBackoffMs(100), 'the backoff has a ceiling');
});

test('a run of failures pauses the course and keeps the reason', () => {
  let states = {};
  for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
    states = afterPoll(states, course(), { ok: false, error: 'Sign in again', now: i, rand: steady });
  }
  const state = readState(states, 'section-1');

  assert.equal(state.paused, true);
  assert.equal(state.lastError, 'Sign in again');
  assert.equal(isDue(course(), states, Number.MAX_SAFE_INTEGER), false);
});

test('one success clears the breaker', () => {
  const failed = afterPoll({}, course(), { ok: false, error: 'x', now: 0, rand: steady });
  const recovered = afterPoll(failed, course(), { ok: true, now: 1, rand: steady });
  assert.equal(readState(recovered, 'section-1').consecutiveFailures, 0);
});

test('resuming a paused course checks it straight away', () => {
  let states = {};
  for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
    states = afterPoll(states, course(), { ok: false, error: 'x', now: i, rand: steady });
  }
  const resumed = resumeCourse(states, 'section-1', 9000);

  assert.equal(readState(resumed, 'section-1').paused, false);
  assert.equal(isDue(course(), resumed, 9000), true);
});

test('scheduleNow and forgetState do not mutate what they were given', () => {
  const states = afterPoll({}, course(), { ok: true, now: 1000, rand: steady });
  const asap = scheduleNow(states, 'section-1', 2000);

  assert.equal(readState(asap, 'section-1').nextRunAt, 2000);
  assert.ok(readState(states, 'section-1').nextRunAt > 2000, 'the original is unchanged');
  assert.deepEqual(forgetState(states, 'section-1'), {});
});

test('readState fills in a missing or malformed record', () => {
  assert.equal(readState(undefined, 'x').consecutiveFailures, 0);
  assert.equal(readState({ x: 'broken' }, 'x').paused, false);
});

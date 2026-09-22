// When to poll a course, and when to stop.
//
// The floor and the jitter are not politeness. This fetches an institution's own
// listing endpoint with the user's own session, from an extension the institution did
// not install; a tight, perfectly periodic poll across a term is what makes that
// traffic look like something worth blocking.

export const MIN_POLL_MINUTES = 15;
export const MAX_POLL_MINUTES = 24 * 60;
export const DEFAULT_POLL_MINUTES = 60;
// After this many polls in a row fail, the course stops polling and says so. A watcher
// that has been quietly failing for three weeks is worse than one that admits it.
export const BREAKER_THRESHOLD = 5;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CEILING_MS = 6 * 60 * 60_000;
const JITTER = 0.1;

export function clampPollMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_POLL_MINUTES;
  return Math.min(MAX_POLL_MINUTES, Math.max(MIN_POLL_MINUTES, Math.round(minutes)));
}

/** Spreads several watched courses out instead of firing them all on the hour. */
export function withJitter(ms, rand = Math.random) {
  const spread = ms * JITTER;
  return Math.max(0, Math.round(ms - spread + rand() * spread * 2));
}

export function readState(states, sectionId) {
  const state = (states || {})[sectionId];
  return {
    lastCheckedAt: 0,
    nextRunAt: 0,
    consecutiveFailures: 0,
    lastError: null,
    paused: false,
    ...(state && typeof state === 'object' ? state : {})
  };
}

export function failureBackoffMs(consecutiveFailures) {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

export function isDue(course, states, now = Date.now()) {
  if (!course?.enabled) return false;
  const state = readState(states, course.sectionId);
  if (state.paused) return false;
  return (state.nextRunAt || 0) <= now;
}

export function dueCourses(courses, states, now = Date.now()) {
  return (courses || []).filter((course) => isDue(course, states, now));
}

/**
 * Folds one poll's outcome back into the course's schedule. A success resets the
 * breaker; a failure backs off and, at the threshold, pauses the course outright and
 * leaves the reason where the options page can show it.
 */
export function afterPoll(states, course, { ok, error = null, now = Date.now(), rand = Math.random } = {}) {
  const state = readState(states, course.sectionId);
  const consecutiveFailures = ok ? 0 : state.consecutiveFailures + 1;
  const paused = !ok && consecutiveFailures >= BREAKER_THRESHOLD;
  const interval = ok
    ? withJitter(clampPollMinutes(course.pollMinutes) * 60_000, rand)
    : withJitter(failureBackoffMs(consecutiveFailures), rand);

  return {
    ...(states || {}),
    [course.sectionId]: {
      ...state,
      lastCheckedAt: now,
      nextRunAt: paused ? 0 : now + interval,
      consecutiveFailures,
      lastError: ok ? null : String(error?.message ?? error ?? 'Could not check this course.'),
      paused
    }
  };
}

/** Resume clears the breaker and checks immediately, because the user just fixed it. */
export function resumeCourse(states, sectionId, now = Date.now()) {
  const state = readState(states, sectionId);
  return {
    ...(states || {}),
    [sectionId]: { ...state, paused: false, consecutiveFailures: 0, lastError: null, nextRunAt: now }
  };
}

/** A newly watched course is checked on the next tick rather than an hour from now. */
export function scheduleNow(states, sectionId, now = Date.now()) {
  return { ...(states || {}), [sectionId]: { ...readState(states, sectionId), nextRunAt: now } };
}

export function forgetState(states, sectionId) {
  const next = { ...(states || {}) };
  delete next[sectionId];
  return next;
}

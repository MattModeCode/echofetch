// The cross-course duplicate guard.
//
// A fetched lecture — or a file already sitting in `_media/recordings/` from before
// this existed — is quarantined rather than filed when it does not actually belong
// where it is about to land: its date falls outside the course's term, or Echo360's
// own section reports a different course than the one being fetched. Quarantine never
// deletes anything. It moves the file (or writes it) into `_media/_quarantine/` with a
// sibling `<name>.reason.txt` explaining why, so a person can look and decide.
//
// SOCPSY 1Z03 is exempt from all of it, unconditionally: its recordings are never
// deleted, and that means never routed to quarantine either, however wrong its date or
// course code would otherwise look.

export const QUARANTINE_DIR = '_media/_quarantine';

/** Fall 2026, the term every course folder in First Year is currently running. */
export const FALL_2026_TERM = Object.freeze({ start: '2026-09-02', end: '2026-12-23' });

export const NEVER_QUARANTINE = new Set(['SOCPSY 1Z03']);

/**
 * Strips everything but letters and digits and upper-cases what remains, so
 * "SOCPSY 1Z03", "SOCPSY-1Z03", "socpsy1z03" and "SOCPSY  1Z03 " all compare equal.
 * Course codes drift in punctuation far more than they drift in the letters and
 * digits that actually identify the course.
 */
export function normalizeCourseCode(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function isExempt(courseFolder) {
  return NEVER_QUARANTINE.has(String(courseFolder ?? '').trim());
}

/** The term window for a course: its own override if one was given, else Fall 2026. */
export function termWindowFor(courseFolder, overrides) {
  const own = overrides && Object.prototype.hasOwnProperty.call(overrides, courseFolder)
    ? overrides[courseFolder]
    : null;
  return own || FALL_2026_TERM;
}

function inWindow(day, window) {
  return day >= window.start && day <= window.end;
}

/**
 * Decides whether one lecture belongs where it is about to be filed.
 *
 * `date` is a plain YYYY-MM-DD (see naming.js's `dateOnly`). `sectionCourseCode` is
 * whatever Echo360's own section record says the course is — left blank, no course
 * mismatch can be detected, which is correct: a file with no declared course cannot
 * disagree with anything.
 */
export function evaluateQuarantine(
  { courseFolder, sectionCourseCode, date },
  { termWindows, now } = {}
) {
  void now; // reserved for a future "quarantine anything from the future" rule

  if (isExempt(courseFolder)) return { quarantine: false, reason: null };

  const window = termWindowFor(courseFolder, termWindows);
  if (!inWindow(date, window)) {
    return {
      quarantine: true,
      reason: `${date} falls outside the ${courseFolder} term window (${window.start} to ${window.end}).`
    };
  }

  const expected = normalizeCourseCode(courseFolder);
  const actual = normalizeCourseCode(sectionCourseCode);
  if (actual && expected && actual !== expected) {
    return {
      quarantine: true,
      reason: `Echo360 reports this section's course as "${sectionCourseCode}", not ${courseFolder}.`
    };
  }

  return { quarantine: false, reason: null };
}

/** Where a quarantined file lands, keeping its own filename. */
export function quarantineDestination(filename) {
  const name = String(filename ?? '').trim();
  if (!name) throw new TypeError('A filename is required to quarantine something.');
  return `${QUARANTINE_DIR}/${name}`;
}

/** Its sibling reason file, named after the quarantined file plus `.reason.txt`. */
export function reasonDestination(filename) {
  return `${quarantineDestination(filename)}.reason.txt`;
}

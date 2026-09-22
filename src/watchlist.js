// A watched course: the settings that decide what gets downloaded, and where, when a
// new lecture appears in it without anyone pressing play.
//
// The key is the Echo360 section id from the URL, not the course name. Lecture titles
// change week to week and a course's display name is not unique across terms, so a
// substring rule is fine for filing a file the user asked for and far too loose to
// drive an automatic write to disk.

import { DEFAULTS, sanitizeFolder, resolveFolder } from './settings.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Echo360 routes both ways depending on the institution's version: /section/<id>/home
// on the current UI, and the same path behind a hash fragment on older installs.
const SECTION_PATH = new RegExp(`/section/(${UUID.source})`, 'i');

export const COURSE_DEFAULTS = {
  sectionId: '',
  host: '',
  label: '',
  folder: '',
  // null means "follow the global setting", which is not the same as a value that
  // happens to equal today's global setting: changing the default later should move
  // an unconfigured course with it.
  maxHeight: null,
  includeAudio: null,
  audioOnly: null,
  transcript: false,
  enabled: true,
  pollMinutes: 60,
  // The First Year course folder this course maps to — e.g. "SOCPSY 1Z03" — and the
  // course code Echo360's own section record reports for it. Set together: leaving
  // courseFolder blank keeps this course on the old template/rule-based filename and
  // folder behaviour untouched. Set, it switches to the deterministic
  // <COURSE>-L<NN>-<date> naming in src/naming.js and the quarantine guard in
  // src/quarantine.js. See src/batch.js for the five recognised course folders.
  courseFolder: '',
  courseCode: ''
};

/**
 * Pulls the section id out of any Echo360 URL that names one. Returns null rather
 * than throwing: it runs against whatever tab happens to be open.
 */
export function parseSectionId(url) {
  const raw = String(url ?? '');
  const match = raw.replace('#', '').match(SECTION_PATH);
  if (!match) return null;

  let host = '';
  try {
    host = new URL(raw).host;
  } catch {
    host = '';
  }
  return { sectionId: match[1].toLowerCase(), host };
}

export function isWatchableUrl(url) {
  return parseSectionId(url) !== null;
}

function coerceHeight(value) {
  if (value === null || value === undefined || value === '') return null;
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? Math.round(height) : null;
}

function coerceFlag(value) {
  if (value === null || value === undefined || value === '') return null;
  return Boolean(value);
}

/**
 * Validates at the boundary: everything that reaches here came from storage or from
 * the options page, and a course with no section id would poll nothing forever while
 * looking enabled.
 */
export function normalizeCourse(raw) {
  const url = raw?.sectionId ? null : raw?.url;
  const fromUrl = url ? parseSectionId(url) : null;
  const sectionId = String(raw?.sectionId ?? fromUrl?.sectionId ?? '')
    .trim()
    .toLowerCase();
  if (!UUID.test(sectionId)) {
    throw new TypeError('A watched course needs an Echo360 section id.');
  }

  return {
    ...COURSE_DEFAULTS,
    sectionId,
    host: String(raw?.host ?? fromUrl?.host ?? '').trim(),
    label: String(raw?.label ?? '').trim(),
    folder: sanitizeFolder(raw?.folder),
    maxHeight: coerceHeight(raw?.maxHeight),
    includeAudio: coerceFlag(raw?.includeAudio),
    audioOnly: coerceFlag(raw?.audioOnly),
    transcript: Boolean(raw?.transcript),
    enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
    pollMinutes: Number(raw?.pollMinutes) || COURSE_DEFAULTS.pollMinutes,
    courseFolder: String(raw?.courseFolder ?? '').trim(),
    courseCode: String(raw?.courseCode ?? '').trim()
  };
}

/** Storage can hold anything an older version wrote; a bad row is dropped, not fatal. */
export function readCourses(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((course) => {
    try {
      return [normalizeCourse(course)];
    } catch {
      return [];
    }
  });
}

export function findCourse(courses, target) {
  const wanted = String(target?.sectionId ?? parseSectionId(target)?.sectionId ?? target ?? '')
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  return (courses || []).find((course) => course.sectionId === wanted) || null;
}

/** Immutable: returns a new list with the course added or its fields merged in. */
export function upsertCourse(courses, patch) {
  const next = normalizeCourse({ ...(findCourse(courses, patch) || {}), ...patch });
  const existing = (courses || []).some((course) => course.sectionId === next.sectionId);
  return existing
    ? courses.map((course) => (course.sectionId === next.sectionId ? next : course))
    : [...(courses || []), next];
}

export function removeCourse(courses, sectionId) {
  const wanted = String(sectionId ?? '').toLowerCase();
  return (courses || []).filter((course) => course.sectionId !== wanted);
}

/**
 * What to actually download for this course. A course override wins over the global
 * setting; an unset override follows it.
 */
export function resolveCourseSettings(course, settings) {
  const base = { ...DEFAULTS, ...(settings || {}) };
  return {
    maxHeight: course?.maxHeight ?? base.maxHeight,
    includeAudio: course?.includeAudio ?? base.includeAudio,
    audioOnly: course?.audioOnly ?? base.audioOnlyDefault,
    transcript: Boolean(course?.transcript),
    concurrency: base.concurrency
  };
}

/**
 * Where it lands. The course's own folder beats the substring rules, which beat the
 * default folder — the rule list stays useful for manual downloads and never
 * overrides a destination the user set for this exact course.
 */
export function resolveCourseFolder(course, { title, url } = {}, settings) {
  const own = sanitizeFolder(course?.folder);
  return own || resolveFolder(title, url, settings);
}

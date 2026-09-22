// Echo360's own web API, as the player's pages use it. GET only, with the session the
// browser already holds — nothing here signs anything in.
//
// Field names drift between institutions and versions, so every value is read through
// a fallback chain rather than one hard-coded path. See docs/WATCHER.md for where the
// shapes come from and what has actually been verified.

export class SessionExpiredError extends Error {
  constructor(message = 'Echo360 signed you out. Open it and sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
    this.expired = true;
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found.') {
    super(message);
    this.name = 'NotFoundError';
    this.notFound = true;
  }
}

export function originOf(hostOrUrl) {
  const raw = String(hostOrUrl ?? '').trim();
  if (!raw) throw new TypeError('An Echo360 host is required.');
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
  } catch {
    throw new TypeError(`Not a usable Echo360 host: ${raw}`);
  }
}

export const meUrl = (origin) => `${originOf(origin)}/api/ui/me`;
export const enrollmentsUrl = (origin) => `${originOf(origin)}/user/enrollments`;
export const syllabusUrl = (origin, sectionId) =>
  `${originOf(origin)}/section/${encodeURIComponent(sectionId)}/syllabus`;
export const classroomUrl = (origin, lessonId) =>
  `${originOf(origin)}/lesson/${encodeURIComponent(lessonId)}/classroom`;
export const transcriptUrl = (origin, lessonId, mediaId, format = 'vtt') =>
  `${originOf(origin)}/api/ui/echoplayer/lessons/${encodeURIComponent(lessonId)}` +
  `/medias/${encodeURIComponent(mediaId)}/transcript-file?format=${encodeURIComponent(format)}`;
export const playerPropertiesUrl = (origin, lessonId, mediaId) =>
  `${originOf(origin)}/api/ui/echoplayer/lessons/${encodeURIComponent(lessonId)}` +
  `/medias/${encodeURIComponent(mediaId)}/player-properties`;

/**
 * A signed-out request does not reliably answer 401: Echo360 returns 200 carrying the
 * single sign-on page for some of these. Saved unchecked, that becomes a transcript
 * full of HTML, so markup where content was expected means the session is gone.
 */
export function looksLikeHtml(text) {
  return /^\s*(?:\uFEFF)?<(?:!|html|head|body)/i.test(String(text ?? ''));
}

function pick(source, ...paths) {
  for (const path of paths) {
    let value = source;
    for (const key of path.split('.')) value = value == null ? value : value[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Enrolled sections, so a course can be picked from a list instead of a pasted URL. */
export function parseEnrollments(payload) {
  const sections = [];
  for (const block of asArray(pick(payload, 'data') ?? payload)) {
    for (const section of asArray(pick(block, 'userSections', 'sections'))) {
      const sectionId = pick(section, 'sectionId', 'id');
      if (!sectionId) continue;
      sections.push({
        sectionId: String(sectionId).toLowerCase(),
        courseCode: String(pick(section, 'courseCode', 'course.courseCode', 'course.code') || ''),
        courseName: String(pick(section, 'courseName', 'course.courseName', 'course.name') || ''),
        sectionName: String(pick(section, 'sectionName', 'name') || ''),
        termName: String(pick(section, 'termName', 'term.name', 'termId') || '')
      });
    }
  }
  return sections;
}

function readLesson(entry, sectionId, out) {
  // A group is a folder of lessons, not a lesson. Recurse rather than skip: a
  // multi-part recording lives inside one.
  const grouped = pick(entry, 'lessons');
  if (Array.isArray(grouped)) {
    for (const child of grouped) readLesson(child, sectionId, out);
    return;
  }

  const lesson = pick(entry, 'lesson.lesson', 'lesson');
  const lessonId = pick(lesson, 'id', 'lessonId', 'lesson_id');
  if (!lessonId) return;

  const medias = asArray(pick(entry, 'lesson.medias', 'medias', 'lesson.media', 'media'));
  const media = medias.find((candidate) => pick(candidate, 'id', 'mediaId', 'media_id')) || null;
  const mediaId = media ? pick(media, 'id', 'mediaId', 'media_id') : pick(entry, 'lesson.video.mediaId');

  out.push({
    sectionId,
    lessonId: String(lessonId),
    mediaId: mediaId ? String(mediaId) : '',
    title: String(pick(lesson, 'displayName', 'name', 'title') || 'Lecture'),
    publishedAt: pick(lesson, 'timing.start', 'startTime', 'createdAt'),
    // Echo360 publishes a lesson before its recording has finished processing. That is
    // a wait, not a failure, and the two must not be confused downstream.
    isProcessing: Boolean(pick(media, 'isProcessing')) || pick(entry, 'lesson.hasContent') === false,
    isFailed: Boolean(pick(media, 'isFailed')),
    isAudioOnly: Boolean(pick(media, 'isAudioOnly')),
    isAvailable: pick(media, 'isAvailable') !== false
  });
}

/**
 * The lectures in a section. Anything without a lesson id is dropped rather than
 * carried as a half-parsed entry: the ledger keys on that id.
 */
export function parseSyllabus(payload, { sectionId = '' } = {}) {
  const entries = asArray(pick(payload, 'data', 'lessons', 'data.lessons'));
  const lectures = [];
  for (const entry of entries) readLesson(entry, sectionId, lectures);
  return lectures;
}

/** A lecture worth queueing: it has media, it is available, and it did not fail. */
export function isDownloadable(lecture) {
  return Boolean(lecture?.mediaId) && lecture.isAvailable && !lecture.isFailed && !lecture.isProcessing;
}

/**
 * Some instances answer the transcript request with the player's own JSON cue list
 * rather than WebVTT. src/transcript.js already parses all three shapes, so this only
 * has to hand it something that is not an error page.
 */
export function assertContent(text, { what = 'response' } = {}) {
  const body = String(text ?? '');
  if (!body.trim()) throw new NotFoundError(`Echo360 returned an empty ${what}.`);
  if (looksLikeHtml(body)) throw new SessionExpiredError();
  return body;
}

const M3U8 = /\.m3u8(\?|$)/i;
const URL_KEYS = ['s3Url', 'url', 'uri', 'httpUrl', 'hlsUrl'];

/**
 * The renditions out of player-properties. Each file is taken with the width and height
 * published beside it — without those the quality cap silently does nothing, which is
 * the one setting that keeps a term of lectures off a full disk.
 */
export function parseMediaFiles(properties) {
  const byUrl = new Map();

  const walk = (node, depth = 0) => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    const url = URL_KEYS.map((key) => node[key]).find(
      (value) => typeof value === 'string' && M3U8.test(value)
    );
    if (url && !byUrl.has(url)) {
      const height = Number(node.height) || 0;
      const width = Number(node.width) || 0;
      byUrl.set(url, {
        url,
        width,
        height,
        // An audio rendition publishes no picture to have a size.
        isAudio: node.isAudio === true || /audio/i.test(String(node.mediaType ?? '')) || (!width && !height)
      });
    }

    for (const value of Object.values(node)) walk(value, depth + 1);
  };

  walk(properties);
  return [...byUrl.values()];
}

/**
 * The same shape src/streams.js produces from a master playlist, so the watcher can
 * choose a rendition the same way whichever route the URLs arrived by.
 */
export function optionsFromMediaFiles(files) {
  const video = files.filter((file) => !file.isAudio);
  const audio = files.filter((file) => file.isAudio);
  const audioUrl = audio.length ? audio[0].url : null;

  return {
    video: video.map((file) => ({
      kind: 'video',
      url: file.url,
      audioUrl,
      height: file.height,
      label: file.height ? `${file.height}p` : 'Video'
    })),
    audio: audioUrl ? [{ kind: 'audio', url: audioUrl, label: 'Audio only', height: 0 }] : [],
    transcript: [],
    duration: 0,
    silentOnly: !audioUrl
  };
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One GET, with the browser's session, retried only for the statuses that mean "later"
 * rather than "no". A 401 or 403 is never retried — asking again does not sign anyone
 * back in, and hammering a login wall is what gets an account noticed.
 */
export async function getText(url, { attempts = 3, fetchImpl = fetch, signal } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', credentials: 'include', signal });
    } catch (error) {
      lastError = error;
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (response.status === 401 || response.status === 403) throw new SessionExpiredError();
    if (response.status === 404) throw new NotFoundError();
    if (RETRY_STATUSES.has(response.status) && attempt < attempts - 1) {
      const retryAfter = Number(response.headers?.get?.('Retry-After'));
      await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000);
      continue;
    }
    if (!response.ok) throw new Error(`Echo360 answered ${response.status}.`);

    return assertContent(await response.text(), { what: 'response' });
  }
  throw lastError || new Error('Echo360 did not answer.');
}

export async function getJson(url, options) {
  const text = await getText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Echo360 answered with something that is not JSON.');
  }
}

export async function isSignedIn(origin, options) {
  try {
    await getJson(meUrl(origin), { attempts: 1, ...options });
    return true;
  } catch (error) {
    if (error instanceof SessionExpiredError) return false;
    throw error;
  }
}

export async function listEnrollments(origin, options) {
  return parseEnrollments(await getJson(enrollmentsUrl(origin), options));
}

export async function listLectures(origin, sectionId, options) {
  const payload = await getJson(syllabusUrl(origin, sectionId), options);
  return parseSyllabus(payload, { sectionId });
}

export async function fetchTranscript(origin, lessonId, mediaId, { format = 'vtt', ...options } = {}) {
  return getText(transcriptUrl(origin, lessonId, mediaId, format), options);
}

/**
 * The renditions, when the API will give them up. It often will not — see
 * docs/WATCHER.md — and the caller falls back to opening the lesson page, which is the
 * mechanism this extension was built on and is known to work.
 */
export async function fetchMediaOptions(origin, lessonId, mediaId, options) {
  try {
    const properties = await getJson(playerPropertiesUrl(origin, lessonId, mediaId), {
      attempts: 1,
      ...options
    });
    const files = parseMediaFiles(properties);
    // A rendition list with no sizes cannot honour the quality cap, so it is refused
    // in favour of the master playlist the page itself fetches.
    if (!files.some((file) => file.height > 0)) return null;
    return optionsFromMediaFiles(files);
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    return null;
  }
}

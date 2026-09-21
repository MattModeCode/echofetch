// The watcher: what runs while nobody is looking.
//
// An alarm wakes the service worker every few minutes. Every course whose own interval
// has come round is polled through Echo360's own listing API — no page has to be open,
// nothing is reloaded, and the lecture does not have to be played. New lectures go into
// the ledger; one at a time they are fetched, the transcript beside the video, into the
// folder that course was given.
//
// MV3 can tear this worker down between any two lines, so nothing is kept in memory
// between ticks: every tick reads the ledger, decides one thing, and writes it back.

import {
  NotFoundError,
  SessionExpiredError,
  classroomUrl,
  fetchMediaOptions,
  isDownloadable,
  listLectures,
  originOf,
  transcriptUrl
} from './echo360.js';
import * as queue from './queue.js';
import * as schedule from './schedule.js';
import { readCourses, resolveCourseFolder, resolveCourseSettings } from './watchlist.js';
import { buildOptions, pickDefault } from './streams.js';
import { getSettings } from './settings.js';

export const ALARM = 'echofetch-watch';
export const TICK_MINUTES = 5;
const STATE_KEY = 'watch';
const DEFAULT_HOST = 'echo360.org';
// How long to leave a hidden lesson page open waiting for the player to ask for its
// playlist. Long enough for a slow campus network, short enough that a lecture which
// will never yield one does not hold the queue.
const SNIFF_TIMEOUT_MS = 45_000;
const SNIFF_POLL_MS = 500;

/** Ledger and poll state are local, not synced: a term of lectures does not fit in sync. */
export async function readState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  return {
    ledger: queue.readLedger(stored.ledger),
    states: stored.states && typeof stored.states === 'object' ? stored.states : {}
  };
}

export async function writeState(patch) {
  const current = await readState();
  await chrome.storage.local.set({ [STATE_KEY]: { ...current, ...patch } });
}

export async function readWatchedCourses() {
  const { courses } = await getSettings();
  return readCourses(courses);
}

export function originFor(course) {
  return originOf(course?.host || DEFAULT_HOST);
}

async function notify(id, title, message) {
  if (!chrome.notifications) return;
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message
    });
  } catch {
    // A notification that cannot be shown must never fail a download.
  }
}

/**
 * What a lecture offers, for a lecture nobody has opened. The API is asked first and
 * usually declines; the fallback is the mechanism this extension is built on — open the
 * lesson page out of sight, let the request sniffer in background.js record what the
 * player asks for, and close it again.
 */
export async function resolveOptions(course, entry, { getCaptured }) {
  const origin = originFor(course);
  const viaApi = await fetchMediaOptions(origin, entry.lessonId, entry.mediaId);
  if (viaApi) return viaApi;

  const tab = await chrome.tabs.create({
    url: classroomUrl(origin, entry.lessonId),
    active: false
  });

  try {
    const deadline = Date.now() + SNIFF_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SNIFF_POLL_MS));
      const playlists = await getCaptured(tab.id);
      if (playlists.length) return buildOptions(playlists, []);
    }
    return null;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** One course: ask what it holds, queue what is new, park what is not ready. */
export async function pollCourse(course, ledger, { now = Date.now() } = {}) {
  const lectures = await listLectures(originFor(course), course.sectionId);
  const withMedia = lectures.filter((lecture) => lecture.mediaId);
  let next = queue.ingest(ledger, withMedia, { sectionId: course.sectionId, now });

  for (const lecture of withMedia) {
    if (isDownloadable(lecture)) continue;
    const key = queue.entryKey(lecture);
    // Only park something that has not already been decided; a finished or failed
    // entry is not reopened by a stale flag on the next poll.
    if (next[key]?.state === queue.QUEUED && !next[key].attempts) {
      next = queue.defer(next, key, { reason: 'Echo360 is still processing this lecture.', now });
    }
  }

  return { ledger: next, found: withMedia.length };
}

export async function pollDue({ now = Date.now() } = {}) {
  const courses = await readWatchedCourses();
  if (!courses.length) return { polled: 0 };

  let { ledger, states } = await readState();
  const due = schedule.dueCourses(courses, states, now);

  for (const course of due) {
    try {
      const result = await pollCourse(course, ledger, { now });
      ledger = result.ledger;
      states = schedule.afterPoll(states, course, { ok: true, now });
    } catch (error) {
      states = schedule.afterPoll(states, course, { ok: false, error, now });
      if (error instanceof SessionExpiredError) {
        await notify(
          'echofetch-signed-out',
          'EchoFetch needs you to sign in',
          'Echo360 signed you out, so watched courses are not being checked. Open Echo360 and sign in.'
        );
      }
    }
  }

  await writeState({ ledger, states });
  return { polled: due.length };
}

async function currentJob() {
  const { job } = await chrome.storage.session.get('job');
  return job || null;
}

/**
 * Starts at most one download. A manual download from the popup holds the same slot,
 * so the watcher waits its turn rather than competing for the offscreen document.
 */
export async function pump({ startDownload, getCaptured, now = Date.now() } = {}) {
  const running = await currentJob();
  if (running && ['starting', 'running'].includes(running.state)) return { started: false };

  let { ledger, states } = await readState();

  // No job is in flight, so anything still marked downloading was orphaned — the
  // worker was torn down, or the browser closed, between starting it and settling it.
  // Left alone it would hold the queue shut for the rest of the term.
  if (Object.values(ledger).some((entry) => entry.state === queue.DOWNLOADING)) {
    ledger = queue.recoverInterrupted(ledger, now);
    await writeState({ ledger, states });
  }

  const entry = queue.nextEntry(ledger, now);
  if (!entry) return { started: false };

  const courses = await readWatchedCourses();
  const course = courses.find((candidate) => candidate.sectionId === entry.sectionId);
  if (!course || !course.enabled) {
    await writeState({ ledger: queue.markSkipped(ledger, entry.key, 'not watched', { now }), states });
    return { started: false };
  }

  await writeState({ ledger: queue.markDownloading(ledger, entry.key, now), states });

  try {
    const settings = await getSettings();
    const resolved = resolveCourseSettings(course, settings);
    const origin = originFor(course);

    const groups = await resolveOptions(course, entry, { getCaptured });
    if (!groups) throw new Error('No playlist was published for this lecture.');

    const chosen = pickDefault(groups, {
      maxHeight: resolved.maxHeight,
      audioOnly: resolved.audioOnly
    });
    if (!chosen) throw new Error('Found a playlist but could not read it.');

    await startDownload({
      variantUrl: chosen.url,
      audioUrl: resolved.includeAudio ? chosen.audioUrl || null : null,
      // The transcript rides along with the video in one job, so a lecture and its
      // words land together under one name instead of needing a second pass.
      transcriptUrl: resolved.transcript
        ? transcriptUrl(origin, entry.lessonId, entry.mediaId, 'vtt')
        : null,
      transcriptFormats: resolved.transcript ? ['vtt', 'txt'] : null,
      title: entry.title,
      pageUrl: classroomUrl(origin, entry.lessonId),
      folder: resolveCourseFolder(course, { title: entry.title, url: classroomUrl(origin, entry.lessonId) }, settings),
      kind: chosen.kind,
      ledgerKey: entry.key,
      concurrency: resolved.concurrency
    });
    return { started: true, key: entry.key };
  } catch (error) {
    await settle(entry.key, { ok: false, error });
    return { started: false, error };
  }
}

/**
 * Called by background.js when a job the watcher started reaches its end, whichever
 * end that is. Nothing else moves an entry out of downloading, so a crash mid-job is
 * recovered by recoverInterrupted on the next startup rather than being lost.
 */
export async function settle(key, { ok, error = null, filenames = [], savedTo = null } = {}) {
  const { ledger, states } = await readState();
  if (!ledger[key]) return;

  if (ok) {
    await writeState({ ledger: queue.markDone(ledger, key, { filenames, savedTo }), states });
    const { notifyOnDownload } = await getSettings();
    if (notifyOnDownload) {
      await notify(
        `echofetch-done-${key}`,
        'Lecture downloaded',
        `${ledger[key].title}${savedTo ? ` — saved to ${savedTo}` : ''}`
      );
    }
    return;
  }

  const permanent = error instanceof NotFoundError;
  await writeState({
    ledger: permanent
      ? queue.markSkipped(ledger, key, error?.message || 'not available')
      : queue.markFailed(ledger, key, error),
    states
  });
}

/** One tick: poll whatever is due, then move the queue along by one lecture. */
export async function tick(deps) {
  await pollDue();
  return pump(deps);
}

export async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (existing) return;
  await chrome.alarms.create(ALARM, { periodInMinutes: TICK_MINUTES, delayInMinutes: 1 });
}

/** A download the browser closed on is mid-flight in the ledger and nowhere else. */
export async function recover(now = Date.now()) {
  const { ledger, states } = await readState();
  await writeState({ ledger: queue.recoverInterrupted(ledger, now), states });
}

/** Watching a course checks it on the next tick rather than an hour from now. */
export async function watchNow(sectionId, now = Date.now()) {
  const { ledger, states } = await readState();
  await writeState({ ledger, states: schedule.scheduleNow(states, sectionId, now) });
}

export async function resume(sectionId, now = Date.now()) {
  const { ledger, states } = await readState();
  await writeState({ ledger, states: schedule.resumeCourse(states, sectionId, now) });
}

export async function forgetLecture(key) {
  const { ledger, states } = await readState();
  await writeState({ ledger: queue.forget(ledger, key), states });
}

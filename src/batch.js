// Course-scoped batch fetch: given a course and the lectures Echo360's own listing
// says it has, work out — for every one of them worth downloading — its lecture
// number, where its video and transcript belong, and whether either should be
// quarantined instead of filed. It does not talk to the network or to storage; that
// stays in watcher.js, which already owns polling, the ledger and the download queue.
// This only makes the plan those pieces then carry out, so the same lecture list
// always produces the same plan.
//
// "Best video stream" is judged entirely by src/streams.js — this module never
// re-implements that ranking, it only decides names and destinations for whatever
// streams.js already chose.

import { isDownloadable } from './echo360.js';
import { entryKey } from './queue.js';
import { assignOrdinals, dateOnly, destinationsFor } from './naming.js';
import { QUARANTINE_DIR, evaluateQuarantine, quarantineDestination, reasonDestination } from './quarantine.js';

/** The five First Year courses a scheduled run fetches for. */
export const TARGET_COURSES = Object.freeze([
  'MATH 1ZC3',
  'PHYSICS 1D03',
  'SOCPSY 1Z03',
  'MATH 1ZA3',
  'ENGINEER 1P13'
]);

function destinationFor(built, quarantine) {
  if (!quarantine.quarantine) return built;
  return {
    folder: QUARANTINE_DIR,
    filename: built.filename,
    path: quarantineDestination(built.filename),
    reasonPath: reasonDestination(built.filename)
  };
}

/**
 * The batch plan for one course: every downloadable lecture from `lectures`, in no
 * particular order, each carrying its ordinal, its video/transcript destinations (or
 * its quarantine destination and reason when it does not belong), and the ledger key
 * the existing queue already uses to dedupe it.
 */
export function planCourseBatch(course, lectures, { now = Date.now(), termWindows } = {}) {
  const courseFolder = String(course?.courseFolder || course?.label || '').trim();
  const downloadable = (lectures || []).filter(isDownloadable);
  const ordinals = assignOrdinals(downloadable);

  return downloadable.map((lecture) => {
    const ordinal = ordinals.get(String(lecture.lessonId ?? lecture.id));
    const date = dateOnly(lecture.publishedAt);
    const built = destinationsFor({ courseFolder, publishedAt: lecture.publishedAt, ordinal });
    const quarantine = evaluateQuarantine(
      { courseFolder, sectionCourseCode: course?.courseCode, date },
      { termWindows, now }
    );

    return {
      key: entryKey(lecture),
      lessonId: lecture.lessonId,
      mediaId: lecture.mediaId,
      title: lecture.title,
      courseFolder,
      ordinal,
      date,
      stem: built.stem,
      quarantine,
      video: destinationFor(built.video, quarantine),
      transcript: destinationFor(built.transcript, quarantine),
      audio: destinationFor(built.audio, quarantine)
    };
  });
}

/** Every course's plan in one call, keyed by section id — one batch run, five courses. */
export function planBatch(courses, lecturesBySection, options) {
  const plans = {};
  for (const course of courses || []) {
    plans[course.sectionId] = planCourseBatch(course, (lecturesBySection || {})[course.sectionId] || [], options);
  }
  return plans;
}

/** How a batch run went, for the one line a schedule tick reports. */
export function summarizeBatch(plans) {
  let queued = 0;
  let quarantined = 0;
  for (const plan of Object.values(plans || {})) {
    for (const item of plan) {
      if (item.quarantine.quarantine) quarantined += 1;
      else queued += 1;
    }
  }
  return { queued, quarantined, total: queued + quarantined };
}

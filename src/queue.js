// The ledger of every lecture the watcher has ever seen, and the state machine that
// decides what to download next.
//
// Two things make this more than a list. A lecture must be downloaded exactly once
// even though polling sees it again every hour for the rest of the term, and MV3 can
// tear the service worker down mid-download — so the ledger is the only durable record
// and every transition has to survive a round trip through storage.

export const QUEUED = 'queued';
export const DOWNLOADING = 'downloading';
export const DONE = 'done';
export const FAILED = 'failed';
export const SKIPPED = 'skipped';

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
const RETRY_CEILING_MS = 30 * 60_000;
// A lecture Echo360 has not finished processing is not a failure, it is an
// appointment. Checking every attempt would burn the retry budget in three minutes.
const NOT_READY_RETRY_MS = 60 * 60_000;

/**
 * One lecture can publish several media, and a lesson id alone would collapse them.
 * The pair is what uniquely names a downloadable thing.
 */
export function entryKey(lecture) {
  const lessonId = String(lecture?.lessonId ?? '').trim();
  const mediaId = String(lecture?.mediaId ?? '').trim();
  if (!lessonId) throw new TypeError('A ledger entry needs a lesson id.');
  return mediaId ? `${lessonId}:${mediaId}` : lessonId;
}

export function readLedger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([key, entry]) => key && entry && typeof entry === 'object')
  );
}

/**
 * Folds a poll's results into the ledger. Anything already known is left exactly as it
 * is — including a failure, which must not be resurrected by the next poll, and a
 * forgotten-then-reappearing lecture, which must be re-queued because forgetting is
 * how the user asks for that.
 */
export function ingest(ledger, lectures, { sectionId, now = Date.now() } = {}) {
  const next = { ...readLedger(ledger) };
  for (const lecture of lectures || []) {
    let key;
    try {
      key = entryKey(lecture);
    } catch {
      continue;
    }
    if (next[key]) continue;
    next[key] = {
      key,
      sectionId: sectionId ?? lecture.sectionId ?? '',
      lessonId: String(lecture.lessonId),
      mediaId: lecture.mediaId ? String(lecture.mediaId) : '',
      title: String(lecture.title ?? 'Lecture'),
      publishedAt: lecture.publishedAt ?? null,
      state: QUEUED,
      attempts: 0,
      lastError: null,
      nextAttemptAt: 0,
      addedAt: now,
      updatedAt: now
    };
  }
  return next;
}

function patch(ledger, key, fields, now) {
  const entry = readLedger(ledger)[key];
  if (!entry) return readLedger(ledger);
  return { ...ledger, [key]: { ...entry, ...fields, updatedAt: now } };
}

export function retryDelay(attempt) {
  return Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * The next thing to download, or null. Serial by construction: while any entry is
 * downloading nothing else is offered, because the offscreen document assembles a
 * lecture in memory and two at once is how a tab runs out of it.
 */
export function nextEntry(ledger, now = Date.now()) {
  const entries = Object.values(readLedger(ledger));
  if (entries.some((entry) => entry.state === DOWNLOADING)) return null;
  return (
    entries
      .filter((entry) => entry.state === QUEUED && (entry.nextAttemptAt || 0) <= now)
      // Oldest first, so a backlog drains in the order the lectures were published
      // rather than the order the poll happened to list them.
      .sort((a, b) => a.addedAt - b.addedAt || a.key.localeCompare(b.key))[0] || null
  );
}

export function markDownloading(ledger, key, now = Date.now()) {
  return patch(ledger, key, { state: DOWNLOADING, startedAt: now }, now);
}

export function markDone(ledger, key, { filenames = [], savedTo = null, now = Date.now() } = {}) {
  return patch(ledger, key, { state: DONE, filenames, savedTo, lastError: null }, now);
}

/**
 * A failure is retried until the budget runs out and then stops for good. It stops
 * rather than retrying forever because the common causes — an expired session, a
 * lecture that is not really there — do not fix themselves by being asked again.
 */
export function markFailed(ledger, key, error, { now = Date.now() } = {}) {
  const entry = readLedger(ledger)[key];
  if (!entry) return readLedger(ledger);
  const attempts = (entry.attempts || 0) + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  return patch(
    ledger,
    key,
    {
      state: exhausted ? FAILED : QUEUED,
      attempts,
      lastError: String(error?.message ?? error ?? 'Download failed.'),
      nextAttemptAt: exhausted ? 0 : now + retryDelay(attempts)
    },
    now
  );
}

/** Terminal, and for a reason that will never change: DRM, or too big to assemble. */
export function markSkipped(ledger, key, reason, { now = Date.now() } = {}) {
  return patch(ledger, key, { state: SKIPPED, reason: String(reason ?? 'skipped') }, now);
}

/** Not terminal: the lecture exists but is still processing, or is still being given. */
export function defer(ledger, key, { until = null, reason = 'not ready', now = Date.now() } = {}) {
  return patch(
    ledger,
    key,
    { state: QUEUED, nextAttemptAt: until ?? now + NOT_READY_RETRY_MS, lastError: reason },
    now
  );
}

/**
 * Deliberate re-download. The entry is removed rather than re-queued so the next poll
 * rediscovers it naturally, which is also what makes a deleted file recoverable.
 */
export function forget(ledger, key) {
  const next = { ...readLedger(ledger) };
  delete next[key];
  return next;
}

/** A download interrupted by the browser closing is left mid-flight; re-queue it. */
export function recoverInterrupted(ledger, now = Date.now()) {
  const entries = Object.entries(readLedger(ledger));
  return Object.fromEntries(
    entries.map(([key, entry]) =>
      entry.state === DOWNLOADING
        ? [key, { ...entry, state: QUEUED, nextAttemptAt: now, updatedAt: now }]
        : [key, entry]
    )
  );
}

export function counts(ledger) {
  const tally = { queued: 0, downloading: 0, done: 0, failed: 0, skipped: 0 };
  for (const entry of Object.values(readLedger(ledger))) {
    if (entry.state in tally) tally[entry.state] += 1;
  }
  return tally;
}

export function entriesFor(ledger, sectionId) {
  return Object.values(readLedger(ledger))
    .filter((entry) => entry.sectionId === sectionId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function recent(ledger, limit = 20) {
  return Object.values(readLedger(ledger))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

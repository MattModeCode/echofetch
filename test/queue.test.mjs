import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DONE,
  DOWNLOADING,
  FAILED,
  MAX_ATTEMPTS,
  QUEUED,
  SKIPPED,
  counts,
  defer,
  entriesFor,
  entryKey,
  forget,
  ingest,
  markDone,
  markDownloading,
  markFailed,
  markSkipped,
  nextEntry,
  readLedger,
  recent,
  recoverInterrupted,
  retryDelay
} from '../src/queue.js';

const SECTION = 'section-1';
const lecture = (n, extra = {}) => ({
  lessonId: `lesson-${n}`,
  mediaId: `media-${n}`,
  title: `Lecture ${n}`,
  ...extra
});

test('entryKey names a lesson and its media, and refuses a nameless one', () => {
  assert.equal(entryKey({ lessonId: 'a', mediaId: 'b' }), 'a:b');
  assert.equal(entryKey({ lessonId: 'a' }), 'a');
  assert.throws(() => entryKey({ mediaId: 'b' }), TypeError);
});

test('ingest queues everything it has not seen before', () => {
  const ledger = ingest({}, [lecture(1), lecture(2)], { sectionId: SECTION, now: 1000 });
  assert.equal(Object.keys(ledger).length, 2);
  assert.equal(ledger['lesson-1:media-1'].state, QUEUED);
  assert.equal(ledger['lesson-1:media-1'].sectionId, SECTION);
});

test('a second poll over the same course adds nothing', () => {
  const first = ingest({}, [lecture(1)], { sectionId: SECTION, now: 1000 });
  const done = markDone(first, 'lesson-1:media-1', { filenames: ['a.mp4'], now: 2000 });
  const second = ingest(done, [lecture(1), lecture(2)], { sectionId: SECTION, now: 3000 });

  assert.equal(Object.keys(second).length, 2);
  assert.equal(second['lesson-1:media-1'].state, DONE, 'a finished lecture is not re-queued');
  assert.equal(second['lesson-2:media-2'].state, QUEUED);
});

test('ingest does not mutate the ledger it was given', () => {
  const before = ingest({}, [lecture(1)], { sectionId: SECTION, now: 1000 });
  ingest(before, [lecture(2)], { sectionId: SECTION, now: 2000 });
  assert.equal(Object.keys(before).length, 1);
});

test('ingest skips a malformed lecture rather than failing the whole poll', () => {
  const ledger = ingest({}, [{ title: 'no ids' }, lecture(1)], { sectionId: SECTION, now: 1 });
  assert.deepEqual(Object.keys(ledger), ['lesson-1:media-1']);
});

test('nextEntry hands out the oldest queued lecture first', () => {
  let ledger = ingest({}, [lecture(2)], { sectionId: SECTION, now: 1000 });
  ledger = ingest(ledger, [lecture(1)], { sectionId: SECTION, now: 2000 });
  assert.equal(nextEntry(ledger, 3000).key, 'lesson-2:media-2');
});

test('nextEntry offers nothing while a download is in flight', () => {
  let ledger = ingest({}, [lecture(1), lecture(2)], { sectionId: SECTION, now: 1000 });
  ledger = markDownloading(ledger, 'lesson-1:media-1', 1500);
  assert.equal(nextEntry(ledger, 2000), null);
});

test('nextEntry respects a scheduled retry', () => {
  let ledger = ingest({}, [lecture(1)], { sectionId: SECTION, now: 1000 });
  ledger = markFailed(ledger, 'lesson-1:media-1', new Error('timeout'), { now: 2000 });

  assert.equal(nextEntry(ledger, 2000), null, 'not yet');
  assert.ok(nextEntry(ledger, 2000 + retryDelay(1) + 1), 'once the delay has passed');
});

test('a failure retries until the budget is spent and then stops', () => {
  let ledger = ingest({}, [lecture(1)], { sectionId: SECTION, now: 0 });
  const key = 'lesson-1:media-1';

  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    ledger = markFailed(ledger, key, new Error('flaky'), { now: attempt });
    assert.equal(ledger[key].state, QUEUED);
  }
  ledger = markFailed(ledger, key, new Error('flaky'), { now: MAX_ATTEMPTS });

  assert.equal(ledger[key].state, FAILED);
  assert.equal(ledger[key].attempts, MAX_ATTEMPTS);
  assert.equal(ledger[key].lastError, 'flaky');
  assert.equal(nextEntry(ledger, Number.MAX_SAFE_INTEGER), null, 'a dead entry is never offered');
});

test('retryDelay grows and then stops growing', () => {
  assert.ok(retryDelay(2) > retryDelay(1));
  assert.equal(retryDelay(99), retryDelay(100));
});

test('a DRM lecture is skipped permanently', () => {
  let ledger = ingest({}, [lecture(1)], { sectionId: SECTION, now: 0 });
  ledger = markSkipped(ledger, 'lesson-1:media-1', 'drm', { now: 1 });

  assert.equal(ledger['lesson-1:media-1'].state, SKIPPED);
  assert.equal(ledger['lesson-1:media-1'].reason, 'drm');
  assert.equal(nextEntry(ledger, Number.MAX_SAFE_INTEGER), null);
});

test('a lecture still processing is deferred, not failed', () => {
  let ledger = ingest({}, [lecture(1)], { sectionId: SECTION, now: 0 });
  ledger = defer(ledger, 'lesson-1:media-1', { until: 10_000, reason: 'still processing', now: 1 });

  assert.equal(ledger['lesson-1:media-1'].state, QUEUED);
  assert.equal(ledger['lesson-1:media-1'].attempts, 0, 'waiting costs no retry budget');
  assert.equal(nextEntry(ledger, 9_999), null);
  assert.ok(nextEntry(ledger, 10_001));
});

test('forgetting a lecture lets the next poll fetch it again', () => {
  let ledger = ingest({}, [lecture(1)], { sectionId: SECTION, now: 0 });
  ledger = markDone(ledger, 'lesson-1:media-1', { filenames: ['a.mp4'], now: 1 });
  ledger = forget(ledger, 'lesson-1:media-1');

  assert.equal(Object.keys(ledger).length, 0);
  const again = ingest(ledger, [lecture(1)], { sectionId: SECTION, now: 2 });
  assert.equal(again['lesson-1:media-1'].state, QUEUED);
});

test('a download interrupted by the browser closing is re-queued', () => {
  let ledger = ingest({}, [lecture(1)], { sectionId: SECTION, now: 0 });
  ledger = markDownloading(ledger, 'lesson-1:media-1', 1);
  ledger = recoverInterrupted(ledger, 500);

  assert.equal(ledger['lesson-1:media-1'].state, QUEUED);
  assert.ok(nextEntry(ledger, 500));
});

test('recoverInterrupted leaves finished work alone', () => {
  let ledger = ingest({}, [lecture(1)], { sectionId: SECTION, now: 0 });
  ledger = markDone(ledger, 'lesson-1:media-1', { now: 1 });
  assert.equal(recoverInterrupted(ledger, 2)['lesson-1:media-1'].state, DONE);
});

test('a ledger survives a round trip through storage', () => {
  let ledger = ingest({}, [lecture(1), lecture(2)], { sectionId: SECTION, now: 1000 });
  ledger = markDownloading(ledger, 'lesson-1:media-1', 1100);

  const restored = recoverInterrupted(readLedger(JSON.parse(JSON.stringify(ledger))), 2000);
  assert.deepEqual(counts(restored), { queued: 2, downloading: 0, done: 0, failed: 0, skipped: 0 });
});

test('readLedger tolerates whatever storage hands back', () => {
  assert.deepEqual(readLedger(null), {});
  assert.deepEqual(readLedger([1, 2]), {});
  assert.deepEqual(readLedger({ a: null }), {});
});

test('entriesFor and recent report newest first', () => {
  let ledger = ingest({}, [lecture(1), lecture(2)], { sectionId: SECTION, now: 1000 });
  ledger = markDone(ledger, 'lesson-2:media-2', { now: 5000 });

  assert.equal(entriesFor(ledger, SECTION)[0].key, 'lesson-2:media-2');
  assert.equal(entriesFor(ledger, 'other').length, 0);
  assert.equal(recent(ledger, 1).length, 1);
});

// The watcher end to end, against a fake browser and a fake Echo360: poll a course,
// queue what is new, download one lecture with its transcript, and prove the next poll
// does nothing at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SECTION = '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const syllabus = readFileSync(new URL('./fixtures/syllabus.json', import.meta.url), 'utf8');
const playerProperties = readFileSync(
  new URL('./fixtures/player-properties.json', import.meta.url),
  'utf8'
);

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Audio",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080,AUDIO="a1"
hd1.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,AUDIO="a1"
sd1.m3u8
`;
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nsegment.mp4\n#EXT-X-ENDLIST\n';

function area() {
  let store = {};
  return {
    get: async (key) => (key in store ? { [key]: store[key] } : {}),
    set: async (patch) => {
      store = { ...store, ...patch };
    },
    dump: () => store
  };
}

function fakeBrowser() {
  const tabs = { created: [], removed: [] };
  return {
    notifications: { created: [], create: async function (id, options) { this.created.push({ id, options }); } },
    alarms: { created: [], get: async () => null, create: async function (name, spec) { this.created.push({ name, spec }); } },
    tabs: {
      created: tabs.created,
      removed: tabs.removed,
      create: async (spec) => {
        tabs.created.push(spec);
        return { id: 99 };
      },
      remove: async (id) => tabs.removed.push(id)
    },
    runtime: { getURL: (path) => path },
    storage: { local: area(), sync: area(), session: area() }
  };
}

function fakeFetch({ playerPropertiesStatus = 200 } = {}) {
  const calls = [];
  const body = (text, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => text
  });

  return {
    calls,
    fetch: async (url) => {
      calls.push(String(url));
      if (url.includes('/syllabus')) return body(syllabus);
      if (url.includes('player-properties')) {
        return playerPropertiesStatus === 200
          ? body(playerProperties)
          : body('', playerPropertiesStatus);
      }
      if (/fhd1\.m3u8|hd1\.m3u8|sd1\.m3u8|audio\.m3u8/.test(url)) {
        return body(MEDIA);
      }
      if (url.includes('.m3u8')) return body(MASTER);
      return body('', 404);
    }
  };
}

async function harness(options = {}) {
  globalThis.chrome = fakeBrowser();
  const net = fakeFetch(options);
  globalThis.fetch = net.fetch;

  // Fresh module state per test: the watcher keeps nothing in memory, but the fake
  // browser it binds to has to be the one this test can inspect.
  const watcher = await import(`../src/watcher.js?case=${Math.random()}`);
  const { saveSettings } = await import(`../src/settings.js?case=${Math.random()}`);

  await saveSettings({
    maxHeight: 720,
    courses: [
      {
        sectionId: SECTION,
        host: 'echo360.ca',
        label: 'SOCPSY 1Z03',
        folder: 'School/SOCPSY',
        transcript: true,
        ...(options.course || {})
      }
    ]
  });

  const started = [];
  const deps = {
    // Faithful to background.js: starting a download writes the job into session
    // storage, which is the only thing that says one is in flight.
    startDownload: async (job) => {
      started.push(job);
      await globalThis.chrome.storage.session.set({
        job: { id: `job-${started.length}`, state: 'running', ledgerKey: job.ledgerKey }
      });
    },
    getCaptured: async () => [{ url: 'https://cdn.example/master.m3u8' }]
  };

  return { watcher, deps, started, net, browser: globalThis.chrome };
}

test('a poll queues the lectures that are ready and parks the one that is not', async () => {
  const { watcher } = await harness();
  await watcher.pollDue();

  const { ledger } = await watcher.readState();
  const entries = Object.values(ledger);

  assert.equal(entries.length, 3, 'three lectures publish media; the reading week does not');
  assert.equal(entries.filter((entry) => entry.nextAttemptAt === 0).length, 2, 'two are ready');
  const parked = entries.find((entry) => entry.nextAttemptAt > 0);
  assert.match(parked.lastError, /still processing/);
});

test('the queue starts one download, with the course quality, folder and transcript', async () => {
  const { watcher, deps, started } = await harness();
  await watcher.tick(deps);

  assert.equal(started.length, 1, 'one lecture at a time');
  const job = started[0];

  assert.match(job.variantUrl, /\/hd1\.m3u8/, 'the 720p rendition, at the cap');
  assert.doesNotMatch(job.variantUrl, /fhd1/, 'not the 1080p one above it');
  assert.ok(job.audioUrl, 'the companion audio comes with it');
  assert.equal(job.folder, 'School/SOCPSY');
  assert.deepEqual(job.transcriptFormats, ['vtt', 'txt']);
  assert.match(job.transcriptUrl, /transcript-file\?format=vtt$/);
  assert.match(job.transcriptUrl, /echo360\.ca/, 'the course host, not a hard-coded one');
  assert.equal(job.title, 'What Is Social Psych');
});

test('nothing else starts while one download is in flight', async () => {
  const { watcher, deps, started } = await harness();
  await watcher.tick(deps);
  await watcher.tick(deps);

  assert.equal(started.length, 1);
});

test('a finished lecture is never downloaded again, however often it is polled', async () => {
  const { watcher, deps, started } = await harness();
  await watcher.tick(deps);
  await watcher.settle(started[0].ledgerKey, {
    ok: true,
    filenames: ['What Is Social Psych.mp4'],
    savedTo: 'Lectures'
  });
  await globalThis.chrome.storage.session.set({ job: null });

  const { ledger } = await watcher.readState();
  assert.equal(ledger[started[0].ledgerKey].state, 'done');

  // A second tick takes the next lecture, and a third has nothing left to take.
  await watcher.tick(deps);
  await watcher.settle(started[1].ledgerKey, { ok: true, filenames: ['x.mp4'] });
  await globalThis.chrome.storage.session.set({ job: null });
  await watcher.tick(deps);

  assert.equal(started.length, 2, 'the two ready lectures, once each');
});

test('a download orphaned by the worker shutting down does not hold the queue shut', async () => {
  const { watcher, deps, started } = await harness();
  await watcher.tick(deps);

  // The job vanished without ever settling, which is what a torn-down service worker
  // leaves behind. The next tick has to notice and pick it back up.
  await globalThis.chrome.storage.session.set({ job: null });
  await watcher.tick(deps);

  assert.equal(started.length, 2);
  assert.equal(started[1].ledgerKey, started[0].ledgerKey, 'the same lecture, retried');
});

test('a failed download is retried, and the ledger says why', async () => {
  const { watcher, deps, started } = await harness();
  await watcher.tick(deps);
  await watcher.settle(started[0].ledgerKey, { ok: false, error: new Error('segment timed out') });
  await globalThis.chrome.storage.session.set({ job: null });

  const { ledger } = await watcher.readState();
  const entry = ledger[started[0].ledgerKey];

  assert.equal(entry.state, 'queued');
  assert.equal(entry.attempts, 1);
  assert.equal(entry.lastError, 'segment timed out');
  assert.ok(entry.nextAttemptAt > Date.now(), 'and not immediately');
});

test('a signed-out session pauses politely and says so once', async () => {
  const { watcher } = await harness();
  globalThis.fetch = async () => ({
    status: 403,
    ok: false,
    headers: { get: () => null },
    text: async () => ''
  });

  await watcher.pollDue();

  const { states, ledger } = await watcher.readState();
  assert.equal(Object.keys(ledger).length, 0);
  assert.equal(states[SECTION].consecutiveFailures, 1);
  assert.match(states[SECTION].lastError, /sign in/i);
  assert.equal(globalThis.chrome.notifications.created.length, 1);
});

test('when the API will not give up the playlist, the lesson page is opened out of sight', async () => {
  const { watcher, deps, started, browser } = await harness({ playerPropertiesStatus: 404 });
  await watcher.tick(deps);

  assert.equal(browser.tabs.created.length, 1);
  assert.equal(browser.tabs.created[0].active, false, 'the user is not interrupted');
  assert.match(browser.tabs.created[0].url, /\/lesson\/.+\/classroom$/);
  assert.deepEqual(browser.tabs.removed, [99], 'and it is closed again');
  assert.equal(started.length, 1);
});

test('watching a course arms the alarm and asks for a check now', async () => {
  const { watcher } = await harness();
  await watcher.ensureAlarm();
  assert.equal(globalThis.chrome.alarms.created[0].name, watcher.ALARM);
  assert.equal(globalThis.chrome.alarms.created[0].spec.periodInMinutes, watcher.TICK_MINUTES);
});

test('a course with courseFolder set downloads under the deterministic naming scheme', async () => {
  const { watcher, deps, started } = await harness({
    course: { courseFolder: 'SOCPSY 1Z03', courseCode: 'SOCPSY 1Z03' }
  });
  await watcher.tick(deps);

  const job = started[0];
  const { ledger } = await watcher.readState();
  const entry = ledger[job.ledgerKey];

  assert.ok(entry.ordinal === 1 || entry.ordinal === 2, 'one of the two ready lectures');
  assert.equal(job.destinations.video.folder, '_media/recordings');
  assert.match(job.destinations.video.filename, /^SOCPSY-1Z03-L0[12]-2026-09-(08|15)\.mp4$/);
  assert.equal(job.destinations.transcript.folder, '_media/transcripts');
  assert.equal(job.quarantineReason, null, 'course code matches, so nothing is quarantined');
});

test('pollDue reports how many lectures a batch run newly queued', async () => {
  const { watcher } = await harness({
    course: { courseFolder: 'SOCPSY 1Z03', courseCode: 'SOCPSY 1Z03' }
  });
  const result = await watcher.pollDue();
  assert.equal(result.polled, 1);
  // Two lectures are ready and one is still processing; all three get a ledger
  // entry, and none of them is quarantined against this course.
  assert.equal(result.newlyQueued, 3);
  assert.equal(result.quarantined, 0);

  // Polling again finds nothing new — the ledger already knows all three.
  const again = await watcher.pollDue();
  assert.equal(again.newlyQueued, 0);
});

test('a course-code mismatch quarantines the lecture instead of filing it', async () => {
  const { watcher, deps, started } = await harness({
    course: { courseFolder: 'MATH 1ZC3', courseCode: 'SOCPSY 1Z03', folder: 'School/MATH1ZC3' }
  });
  const polled = await watcher.pollDue();
  // The two ready lectures are quarantined for the course-code mismatch; the
  // still-processing lecture is not covered by the batch plan at all, so it is
  // ledgered normally and counts as queued, not quarantined.
  assert.equal(polled.newlyQueued, 1);
  assert.equal(polled.quarantined, 2);

  await watcher.tick(deps);
  const job = started[0];
  assert.equal(job.destinations.video.folder, '_media/_quarantine');
  assert.match(job.quarantineReason, /SOCPSY 1Z03/);
});

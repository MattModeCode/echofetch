import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPlan,
  detectCourse,
  detectDate,
  planFile,
  quarantineRootFor
} from '../tools/quarantine-recordings.mjs';

test('detectCourse reads the course out of a real-world filename', () => {
  assert.equal(detectCourse('MATH 1ZC3 (C02) - Fall 2026 2026-09-10.mp4'), 'MATH 1ZC3');
  assert.equal(detectCourse('phys-1d03-2020-10-30--lec01-center-of-masses.mp4'), 'PHYSICS 1D03');
  assert.equal(detectCourse('SOCPSY 1Z03 - Intro To The Course 2026-09-10.mp4'), 'SOCPSY 1Z03');
});

test('detectCourse returns null for a filename that names no recognized course', () => {
  assert.equal(detectCourse('random-clip.mp4'), null);
});

test('detectDate reads the first ISO date in a filename', () => {
  assert.equal(detectDate('phys-1d03-2020-10-30--lec01-center-of-masses.mp4'), '2020-10-30');
  assert.equal(detectDate('MATH 1ZC3 (C02) - Fall 2026 2026-09-10.mp4'), '2026-09-10');
});

test('detectDate returns null when a filename carries no date', () => {
  assert.equal(detectDate('Math 1ZA3 C02 (Dr Shuang) - Fall 2026.mp4'), null);
});

test('planFile quarantines the known stale cross-course 2020 clip', () => {
  const plan = planFile('phys-1d03-2020-10-30--lec01-center-of-masses.mp4');
  assert.equal(plan.status, 'quarantine');
  assert.equal(plan.courseFolder, 'PHYSICS 1D03');
  assert.match(plan.reason, /2020-10-30/);
  assert.equal(plan.destination, '_media/_quarantine/phys-1d03-2020-10-30--lec01-center-of-masses.mp4');
  assert.equal(
    plan.reasonFile,
    '_media/_quarantine/phys-1d03-2020-10-30--lec01-center-of-masses.mp4.reason.txt'
  );
});

test('planFile leaves a MATH 1ZC3 file from within the term alone', () => {
  const plan = planFile('MATH 1ZC3 (C02) - Fall 2026 2026-09-10.mp4');
  assert.equal(plan.status, 'clean');
});

test('planFile never quarantines a SOCPSY 1Z03 file, even with a bad date', () => {
  const plan = planFile('SOCPSY 1Z03 - some old clip 2019-01-01.mp4');
  assert.equal(plan.status, 'clean');
});

test('planFile skips a file with no recognizable course rather than guessing', () => {
  const plan = planFile('random-clip-2026-09-10.mp4');
  assert.equal(plan.status, 'skipped');
  assert.match(plan.reason, /no recognized course/);
});

test('planFile skips a file with no date rather than guessing', () => {
  const plan = planFile('Math 1ZA3 C02 (Dr Shuang) - Fall 2026.mp4');
  assert.equal(plan.status, 'skipped');
  assert.match(plan.reason, /no date/);
});

test('quarantineRootFor places _quarantine beside recordings, not inside it', () => {
  const root = quarantineRootFor('/course/_media/recordings');
  assert.equal(root, '/course/_media/_quarantine');
});

test('applyPlan moves the file and writes its reason as a sibling of recordings, not nested under it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'echofetch-quarantine-'));
  const recordings = join(base, '_media', 'recordings');
  await mkdir(recordings, { recursive: true });

  const filename = 'phys-1d03-2020-10-30--lec01-center-of-masses.mp4';
  await writeFile(join(recordings, filename), 'fake video bytes');

  const plan = planFile(filename);
  assert.equal(plan.status, 'quarantine');
  await applyPlan(recordings, plan);

  // The file must not still be under recordings/, and must not have created a
  // recordings/_media/ nesting — the exact bug this test guards against.
  const remaining = await readdir(recordings);
  assert.deepEqual(remaining, []);

  const quarantineDir = join(base, '_media', '_quarantine');
  const moved = await readdir(quarantineDir);
  assert.deepEqual(moved.sort(), [filename, `${filename}.reason.txt`].sort());

  const reason = await readFile(join(quarantineDir, `${filename}.reason.txt`), 'utf8');
  assert.match(reason, /2020-10-30/);
});

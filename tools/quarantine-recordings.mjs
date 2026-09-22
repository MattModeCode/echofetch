#!/usr/bin/env node
//
// Applies the cross-course duplicate guard (src/quarantine.js) to files already
// sitting in a `_media/recordings/` directory, from before that guard existed.
//
// A recording's course and date are read off its own filename — there is no other
// record for a file that predates this tool — using a small set of patterns for the
// five First Year courses, plus the first ISO date (`YYYY-MM-DD`) anywhere in the
// name. A file that names none of the five courses, or carries no date, is left
// alone rather than guessed at: quarantine is a guard against a wrong destination,
// not a filter that swallows anything it does not recognize.
//
// SOCPSY 1Z03 is never quarantined by anything, this tool included — src/quarantine.js
// already enforces that, but it is worth saying twice given what this tool is for.
//
// Usage:
//   node tools/quarantine-recordings.mjs <_media/recordings dir>              # report only
//   node tools/quarantine-recordings.mjs --apply <_media/recordings dir>      # move + write reasons

import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { evaluateQuarantine, quarantineDestination, reasonDestination } from '../src/quarantine.js';

const RECORDING_EXTENSIONS = ['.mp4', '.m4a', '.ts', '.aac', '.mov'];

// Order matters where one pattern is a substring of another's match text — none are
// here, but longest-code-first keeps it that way if a course code ever changes.
const COURSE_PATTERNS = [
  ['MATH 1ZA3', /1za3/i],
  ['MATH 1ZC3', /1zc3/i],
  ['PHYSICS 1D03', /1d03/i],
  ['SOCPSY 1Z03', /1z03/i],
  ['ENGINEER 1P13', /1p13/i]
];

const DATE = /(\d{4}-\d{2}-\d{2})/;

/** The course a filename declares, or null when none of the five match. */
export function detectCourse(filename) {
  const match = COURSE_PATTERNS.find(([, pattern]) => pattern.test(filename));
  return match ? match[0] : null;
}

/** The first ISO date anywhere in a filename, or null. */
export function detectDate(filename) {
  const match = String(filename ?? '').match(DATE);
  return match ? match[1] : null;
}

/**
 * What this tool would do (or did) about one file: quarantine it and why, skip it and
 * why, or leave it alone because it is fine.
 */
export function planFile(filename, { termWindows, now } = {}) {
  const courseFolder = detectCourse(filename);
  const date = detectDate(filename);

  if (!courseFolder) return { filename, status: 'skipped', reason: 'names no recognized course' };
  if (!date) return { filename, status: 'skipped', reason: 'carries no date' };

  // There is no separate "course being fetched" for a file already on disk — the
  // course it declares is the only course there is to check it against — so only the
  // term-window half of the guard can ever fire here. That is exactly what is needed:
  // it is precisely what flags a stale cross-course clip like the 2020 archive file.
  const result = evaluateQuarantine(
    { courseFolder, sectionCourseCode: courseFolder, date },
    { termWindows, now }
  );

  if (!result.quarantine) return { filename, status: 'clean', courseFolder, date };
  return {
    filename,
    status: 'quarantine',
    courseFolder,
    date,
    reason: result.reason,
    destination: quarantineDestination(filename),
    reasonFile: reasonDestination(filename)
  };
}

async function listRecordings(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => RECORDING_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)));
}

/**
 * `_media/_quarantine/`, as a sibling of the `_media/recordings/` directory being
 * cleaned up — never inside it. `plan.destination` (from src/quarantine.js) is
 * relative to the course directory's root for exactly this reason: it names where
 * the file belongs, not where it happens to be run from.
 */
export function quarantineRootFor(recordingsDir) {
  return join(dirname(recordingsDir), '_quarantine');
}

export async function applyPlan(recordingsDir, plan) {
  const quarantineRoot = quarantineRootFor(recordingsDir);
  await mkdir(quarantineRoot, { recursive: true });
  await rename(join(recordingsDir, plan.filename), join(quarantineRoot, plan.filename));
  await writeFile(join(quarantineRoot, `${plan.filename}.reason.txt`), `${plan.reason}\n`, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const targets = args.filter((arg) => arg !== '--apply');

  if (!targets.length) {
    console.error('usage: quarantine-recordings.mjs [--apply] <_media/recordings dir>...');
    process.exitCode = 1;
    return;
  }

  for (const dir of targets) {
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) {
      console.error(`  skipped   ${dir} — not a directory`);
      continue;
    }

    const files = await listRecordings(dir);
    for (const filename of files) {
      const plan = planFile(filename);

      if (plan.status === 'clean') {
        console.log(`  ok        ${filename} — ${plan.courseFolder}, ${plan.date}, in term`);
        continue;
      }
      if (plan.status === 'skipped') {
        console.log(`  skipped   ${filename} — ${plan.reason}`);
        continue;
      }

      console.log(`  ${apply ? 'quarantined' : 'would quarantine'} ${filename}`);
      console.log(`              -> ${plan.destination}`);
      console.log(`              reason: ${plan.reason}`);
      if (apply) await applyPlan(dir, plan);
    }
  }

  if (!apply) console.log('\nDry run. Re-run with --apply to move the files and write the reasons.');
}

// Only run as a CLI, not when the pure functions above are imported by the tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

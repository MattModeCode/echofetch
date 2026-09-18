#!/usr/bin/env node
//
// Merges a downloaded video with its companion audio into one playable file.
//
// EchoFetch saves a paired download as two files sharing one stem — "Lecture.mp4"
// and "Lecture.m4a" — because muxing two fragmented-MP4 renditions inside a browser
// tab needs a full container muxer. ffmpeg does it by stream copy in about a second,
// with no re-encode and no quality loss.
//
// Usage:
//   node tools/merge-audio.mjs <file-or-directory>...            # report only
//   node tools/merge-audio.mjs --apply <file-or-directory>...    # write the merges
//   node tools/merge-audio.mjs --apply --replace <dir>           # and delete the pair
//
// Files downloaded before 0.2.0 have no audio anywhere on disk — it was never
// fetched. Download the "Audio only" row for that lecture first, then run this.

import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const VIDEO_EXTENSIONS = ['.mp4', '.ts'];
const AUDIO_EXTENSIONS = ['.m4a', '.aac'];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr.trim().split('\n').slice(-3).join('\n')))
    );
  });
}

async function hasFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Does this file already carry an audio stream? */
function hasAudio(path) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      path
    ]);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.includes('audio')));
  });
}

async function collect(target) {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(target, entry.name));
}

/** Group files by stem so "Lecture.mp4" finds "Lecture.m4a" beside it. */
function pair(files) {
  const byStem = new Map();
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.includes(extension);
    const isAudio = AUDIO_EXTENSIONS.includes(extension);
    if (!isVideo && !isAudio) continue;

    const stem = join(dirname(file), basename(file, extname(file)));
    const entry = byStem.get(stem) || { stem, video: null, audio: null };
    if (isVideo) entry.video = file;
    else entry.audio = file;
    byStem.set(stem, entry);
  }
  return [...byStem.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const replace = args.includes('--replace');
  const targets = args.filter((arg) => !arg.startsWith('--'));

  if (!targets.length) {
    console.error('usage: merge-audio.mjs [--apply] [--replace] <file-or-directory>...');
    process.exitCode = 1;
    return;
  }
  if (apply && !(await hasFfmpeg())) {
    console.error('ffmpeg is not on PATH. Install it, or run without --apply to see the pairs.');
    process.exitCode = 1;
    return;
  }

  const files = (await Promise.all(targets.map(collect))).flat();
  const pairs = pair(files);
  let merged = 0;

  for (const entry of pairs) {
    const name = basename(entry.stem);

    if (!entry.video) {
      console.log(`  waiting   ${name} — audio only, no video beside it`);
      continue;
    }
    if (!entry.audio) {
      const already = await hasAudio(entry.video);
      console.log(
        already
          ? `  ok        ${name} — already has an audio stream`
          : `  silent    ${name} — no companion audio on disk; download the "Audio only" row`
      );
      continue;
    }

    const output = `${entry.stem}-with-audio.mp4`;
    console.log(
      `  ${apply ? 'merging  ' : 'would fix'} ${name} — video + audio -> ${basename(output)}`
    );
    if (!apply) {
      merged++;
      continue;
    }

    await run('ffmpeg', [
      '-v', 'error', '-y',
      '-i', entry.video,
      '-i', entry.audio,
      '-c', 'copy',
      '-movflags', '+faststart',
      output
    ]);
    if (!(await hasAudio(output))) {
      throw new Error(
        `${basename(output)} came out with no audio stream; leaving the pair alone.`
      );
    }
    if (replace) await Promise.all([rm(entry.video), rm(entry.audio)]);
    merged++;
  }

  if (!merged) {
    console.log('\nNothing to merge.');
    return;
  }
  console.log(`\n${apply ? 'Merged' : 'Would merge'} ${merged} lecture${merged === 1 ? '' : 's'}.`);
  if (!apply) console.log('Re-run with --apply to write them.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

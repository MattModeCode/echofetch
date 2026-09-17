#!/usr/bin/env node
//
// Repairs files produced by EchoFetch before 0.2.0.
//
// Versions up to 0.1.0 ignored EXT-X-BYTERANGE, so every segment in a byte-range
// playlist resolved to the same whole-file URL. The downloader then wrote the whole
// lecture once per segment: one init fetch plus N segment fetches, all identical.
// A 59-minute lecture whose real stream is 10.7 MB landed as 3.87 GB in 361 copies.
//
// The first copy is a complete, valid MP4. This truncates the file to it, after
// proving the copies really are identical.
//
// Usage:
//   node tools/repair-duplicated-mp4.mjs <file-or-directory>...   # report only
//   node tools/repair-duplicated-mp4.mjs --apply <file-or-dir>... # rewrite in place

import { open, readdir, stat, truncate } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const COMPARE_CHUNK = 1 << 20; // 1 MiB
const REPAIRABLE_EXTENSIONS = ['.mp4', '.m4a', '.m4s'];

/** Walk the top-level box chain, recording where each `moov` starts. */
async function scanBoxes(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    const moovOffsets = [];
    let offset = 0;

    while (offset < size) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;

      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < 8) break;

      if (type === 'moov') moovOffsets.push(offset);
      offset += boxSize;
    }
    return { size, moovOffsets };
  } finally {
    await handle.close();
  }
}

/** Byte-compare two windows of the same file. */
async function regionsMatch(path, aStart, bStart, length) {
  const handle = await open(path, 'r');
  try {
    const a = Buffer.alloc(COMPARE_CHUNK);
    const b = Buffer.alloc(COMPARE_CHUNK);
    for (let read = 0; read < length; read += COMPARE_CHUNK) {
      const span = Math.min(COMPARE_CHUNK, length - read);
      await handle.read(a, 0, span, aStart + read);
      await handle.read(b, 0, span, bStart + read);
      if (!a.subarray(0, span).equals(b.subarray(0, span))) return false;
    }
    return true;
  } finally {
    await handle.close();
  }
}

function describe(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

async function inspect(path) {
  const { size, moovOffsets } = await scanBoxes(path);
  if (moovOffsets.length <= 1) return { path, size, status: 'clean' };

  const stride = moovOffsets[1] - moovOffsets[0];
  const evenlySpaced = moovOffsets.every((at, i) => at === moovOffsets[0] + i * stride);
  const wholeCopies = size === stride * moovOffsets.length;

  if (!evenlySpaced || !wholeCopies) {
    return { path, size, status: 'unrecognized', copies: moovOffsets.length };
  }
  if (!(await regionsMatch(path, moovOffsets[0], moovOffsets[1], stride))) {
    return { path, size, status: 'copies-differ', copies: moovOffsets.length };
  }
  return { path, size, status: 'duplicated', copies: moovOffsets.length, keep: stride };
}

async function collect(target) {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && REPAIRABLE_EXTENSIONS.includes(extname(entry.name).toLowerCase())
    )
    .map((entry) => join(target, entry.name));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const targets = args.filter((arg) => arg !== '--apply');

  if (!targets.length) {
    console.error('usage: repair-duplicated-mp4.mjs [--apply] <file-or-directory>...');
    process.exitCode = 1;
    return;
  }

  const files = (await Promise.all(targets.map(collect))).flat();
  let reclaimed = 0;

  for (const file of files) {
    const result = await inspect(file);
    const name = basename(file);

    if (result.status === 'clean') {
      console.log(`  ok        ${name} — ${describe(result.size)}, single copy`);
      continue;
    }
    if (result.status !== 'duplicated') {
      console.log(
        `  skipped   ${name} — ${result.status}, ${result.copies} moov boxes; left alone`
      );
      continue;
    }

    const saved = result.size - result.keep;
    console.log(
      `  ${apply ? 'repaired ' : 'would fix'} ${name} — ${result.copies} identical copies, ` +
        `${describe(result.size)} -> ${describe(result.keep)} (saves ${describe(saved)})`
    );
    if (apply) await truncate(file, result.keep);
    reclaimed += saved;
  }

  if (reclaimed) {
    console.log(`\n${apply ? 'Reclaimed' : 'Would reclaim'} ${describe(reclaimed)}.`);
    if (!apply) console.log('Re-run with --apply to rewrite the files.');
  } else {
    console.log('\nNothing to repair.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

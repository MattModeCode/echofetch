# The cross-course duplicate guard

`src/quarantine.js` decides whether a lecture — about to be fetched, or already
sitting on disk from before this existed — actually belongs where it is about to be
filed. It never deletes anything. A lecture that fails the check is quarantined:
written into `_media/_quarantine/` with a sibling `<name>.reason.txt` explaining why,
so a person can look and decide instead of the file silently landing in, or
disappearing from, the wrong place.

## The two checks

A lecture is quarantined when either is true:

1. **Its date falls outside the course's term window.** The default is
   `FALL_2026_TERM` — 2026-09-02 to 2026-12-23 — exported as a named constant, with a
   per-course override available (`termWindows` in `evaluateQuarantine`'s options).
2. **Echo360's own section reports a different course than the one being fetched.**
   Course codes are compared with `normalizeCourseCode`, which strips everything but
   letters and digits and upper-cases what remains, so `"SOCPSY 1Z03"`,
   `"socpsy-1z03"` and `"SOCPSY1Z03"` all agree. A blank section course code is
   treated as unknown, not as a mismatch — nothing can disagree with nothing.

## The one exemption

**SOCPSY 1Z03 is never quarantined, unconditionally.** `src/quarantine.js`'s
`NEVER_QUARANTINE` set is checked first, before either rule runs, so a SOCPSY 1Z03
lecture with an impossible date or a mismatched course code still files normally.
This matches the course directory's own rule that SOCPSY 1Z03 recordings are never
deleted — quarantine and deletion are different actions, but a course exempt from one
is exempt from anything that could lead toward the other.

## During a batch fetch

For a course fetched through batch mode (`docs/BATCH.md`), `src/batch.js`'s
`planCourseBatch` runs `evaluateQuarantine` on every lecture, comparing its date
against the course's term window and the section's own course code against the
`courseFolder` the course was set up with. A quarantined lecture still downloads —
quarantine only ever means "file it somewhere else and say why", never "do not fetch
it" — it lands in `_media/_quarantine/<name>` instead of `_media/recordings/<name>`,
with `<name>.reason.txt` alongside it, written by the offscreen document
(`src/offscreen.js`) as an ordinary small text file in the same job.

## Cleaning up files that already exist

`tools/quarantine-recordings.mjs` applies the same rule to files already sitting in
`_media/recordings/`, from before this guard existed. A file that predates the guard
has no separate record of which course it was fetched for, so its course and date are
read off its own filename — a small set of patterns for the five recognised First
Year courses, plus the first `YYYY-MM-DD` anywhere in the name. Because there is no
separate "course being fetched" for an existing file, only the term-window check can
ever fire here; the course-code check needs two course codes to compare and an
existing file only carries one. That is exactly the check that catches
`phys-1d03-2020-10-30--lec01-center-of-masses.mp4` — a 2020 clip sitting among 2026
recordings.

A file naming none of the five courses, or carrying no date, is left alone rather than
guessed at.

```
node tools/quarantine-recordings.mjs "_media/recordings"              # report only
node tools/quarantine-recordings.mjs --apply "_media/recordings"      # move + write reasons
```

It is a dry run by default. `--apply` is required to actually move anything, and even
then nothing is ever deleted — a moved file and its reason can always be moved back.

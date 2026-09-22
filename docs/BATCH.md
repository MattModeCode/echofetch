# Batch mode: fetching a whole course without clicking through it lecture by lecture

Batch mode is not a second download engine. It is the existing watcher (see
`docs/WATCHER.md` and `src/watcher.js`), extended so it knows how to name and place
what it finds instead of always following the filename template. Everything about
polling, retrying, the ledger and one-lecture-at-a-time still applies exactly as it
did before this existed.

## What turns it on

A watched course opts into batch behaviour by setting `courseFolder` — the exact name
of a First Year course folder, e.g. `"SOCPSY 1Z03"` — on its entry in Settings. This
is stored alongside the other per-course settings in `src/watchlist.js`.

`src/options.js`'s **Find my courses** does this automatically: when a section's own
course code matches one of the five recognised First Year courses
(`src/batch.js`'s `TARGET_COURSES` — `MATH 1ZC3`, `PHYSICS 1D03`, `SOCPSY 1Z03`,
`MATH 1ZA3`, `ENGINEER 1P13`), `courseFolder` and `courseCode` are filled in for you.
Any other course you watch keeps the old folder-rule/template behaviour untouched —
setting `courseFolder` is what changes anything, and nothing sets it for you unless
the course is recognisably one of the five.

## What happens on a poll

For a course with `courseFolder` set, every poll (`watcher.pollCourse`) does three
things beyond what it always did:

1. **Enumerates** the course's lectures from Echo360's own syllabus endpoint — the
   same request `docs/WATCHER.md` describes, no page has to be opened.
2. **Plans** each downloadable one with `src/batch.js`'s `planCourseBatch`: its
   lecture number for the term (`src/naming.js`'s `assignOrdinals`, sorted by date),
   where its video and transcript belong (`_media/recordings/…`,
   `_media/transcripts/…`), and whether either should be quarantined instead
   (`src/quarantine.js` — see `docs/QUARANTINE.md`).
3. **Queues** what is new into the same ledger the watcher has always used, so
   `src/queue.js`'s dedup, retry and one-at-a-time rules apply unchanged.

"Best video stream" is still decided entirely by `src/streams.js` / `src/hls.js`'s
`pickDefault` and `guessFeed` — batch mode never re-implements that judgement, it only
decides names and destinations for whichever stream that logic already picked.

## Where files land

Both video and transcript for one lecture share a stem —
`<COURSE>-L<NN>-<YYYY-MM-DD>` — matching the convention already on disk in
`_media/transcripts/` (`SOCPSY-1Z03-L02.vtt`):

```
_media/recordings/SOCPSY-1Z03-L02-2026-09-15.mp4
_media/transcripts/SOCPSY-1Z03-L02-2026-09-15.vtt
```

This requires the folder you chose in Settings (`src/folder-handle.js`) to be the
course directory's own root, so `_media/recordings` and `_media/transcripts` resolve
where the course directory's `GUIDE.md` says they should.

## Scheduled runs

The existing alarm (`watcher.ALARM`, `src/schedule.js`) drives batch mode exactly the
way it always drove ordinary watching — nothing new was added to the alarm system.
Each tick (`watcher.tick`) polls whatever is due and returns how many lectures were
newly queued and how many were quarantined, so a scheduled run can be summarised as
"3 new, 1 quarantined" without a second poll. Only lectures the ledger has not already
seen are ever queued — a lecture downloaded last week does not download again because
the course was polled again this week.

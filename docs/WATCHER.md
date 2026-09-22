# Recon: how a course lists its lectures

**Status: derived from public implementations, 2026-09-21. Not yet verified against a
live McMaster session.** Every request below is a GET made with the session cookies the
browser already holds; nothing here signs anything in, and nothing is sent anywhere.

The watcher needs something EchoFetch has never had: a list of a course's lectures
obtained *without* anyone opening them. Detection until now has been passive —
`background.js` learns a lecture exists only when the player requests its `.m3u8` — and
a watcher cannot press play.

## Sources

Four independent implementations agree on the same endpoints, which is why this is
written down as a plan rather than a guess:

- `soraxas/echo360` (345 stars) — `/section/{id}/syllabus`, with a documented fallback
  to scraping the section home page when the JSON endpoint is unavailable.
- `Simbov/unihub` — `/user/enrollments`, `/section/{id}/syllabus`,
  `/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file`, verified
  against a live QUT session on 2026-07-27.
- `matthewcks-prog/Lock-in` — the same syllabus endpoint parsed defensively in a
  browser extension, with the full set of field-name variants across instances.
- EchoFetch's own `docs/RECON.md` — how the media itself is packaged once a playlist
  URL is in hand.

## The endpoints

`{origin}` is the host the course is served from — `echo360.org`, `echo360.ca`, and so
on. It is read from the tab the course was added from, never assumed.

| Request | Purpose |
|---|---|
| `GET {origin}/api/ui/me` | Is the session alive. 200 with a body, or 403 when signed out |
| `GET {origin}/user/enrollments` | Every section the user is enrolled in, for picking courses without pasting a URL |
| `GET {origin}/section/{sectionId}/syllabus` | That section's lessons and their media ids |
| `GET {origin}/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt` | The transcript, as WebVTT or as plain text |
| `GET {origin}/lesson/{lessonId}/classroom` | The player page, opened only as the video fallback below |

### Syllabus shape

`{ status, data: [ entry ] }`. An entry is a lesson, or a group that holds its own
`lessons` array and has to be flattened. The field names differ between instances and
versions, so every field is read through a fallback chain rather than one path:

- lesson: `entry.lesson.lesson` or `entry.lesson`
- id: `lesson.id`
- title: `lesson.displayName`, then `lesson.name`
- date: `lesson.timing.start`, then `startTime`, then `createdAt`
- media: `entry.lesson.medias[0].id`, then `entry.medias[0].id`, then
  `lesson.video.mediaId`

A media record also carries `isAvailable`, `isProcessing`, `isFailed` and
`isAudioOnly`. A lecture still processing is not a failure — it is an appointment, and
the ledger defers it rather than spending retry budget on it.

### The silent failure to guard

A signed-out request does not always return 401. Echo360 answers some of these with
**200 and the SSO login page**, which would be written to disk as a transcript full of
HTML. Anything whose body starts like markup is treated as an expired session, not as
content. `unihub` hit this in practice; it is the single most important check here.

## Video, and why the fallback stays

The transcript has a clean API. The video does not: `soraxas/echo360`, after years of
maintenance, still loads `/lesson/{id}/classroom` in a real browser and watches for the
`.m3u8`. There is likely a
`/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/player-properties` carrying the
media URIs — the secure-link form of exactly that path is verified — but it is not
confirmed for enrolled media, so the watcher must not depend on it.

So the video path is: **probe the API first, fall back to the page**. The fallback
opens the classroom page in a background tab, lets the sniffer EchoFetch already has
record the playlist, and closes the tab. That fallback is not a compromise — it is the
mechanism this extension has been built around from the start, and it is known to work
on this institution's instance.

## Rate posture

GET only. One poll per course no more often than every 15 minutes, jittered, backing
off on 429 with `Retry-After` and on 5xx, pausing the course after five consecutive
failures. Lessons within one poll are fetched a few at a time, not all at once. This is
a student's own session against their own institution; it should look like a person
reading their course page, because that is what it is.

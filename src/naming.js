// Deterministic filenames for fetched lecture media.
//
// Matches the convention already on disk in the First Year course directory's
// `_media/transcripts/` (`SOCPSY-1Z03-L02.vtt`): `<COURSE>-L<NN>-<YYYY-MM-DD>`, one
// stem shared by a lecture's video, transcript and audio-only file, differing only by
// extension and by which `_media/` subfolder they land in.
//
// Every function here is pure. Given the same lecture facts it produces the same name
// every time, which is what makes a re-run of a batch fetch, or a scheduled poll that
// sees the same lecture again, write to the same path instead of a new one.

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

export const KIND_EXTENSION = { video: 'mp4', transcript: 'vtt', audio: 'm4a' };
export const KIND_DIR = { video: 'recordings', transcript: 'transcripts', audio: 'audio' };

/** "SOCPSY 1Z03" -> "SOCPSY-1Z03", matching the transcripts already on disk. */
export function slugifyCourse(courseFolder) {
  const cleaned = String(courseFolder ?? '')
    .trim()
    .replace(ILLEGAL, '')
    .replace(/\s+/g, '-');
  if (!cleaned) throw new TypeError('A course folder name is required.');
  return cleaned;
}

/** The calendar day a timestamp falls on, as the vault's plain YYYY-MM-DD. */
export function dateOnly(publishedAt) {
  const raw = String(publishedAt ?? '').trim();
  const leading = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (leading) return leading[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Not a usable lecture date: ${raw || '(empty)'}`);
  return parsed.toISOString().slice(0, 10);
}

function ordinalKey(lecture) {
  const id = String(lecture?.lessonId ?? lecture?.id ?? '');
  if (!id) throw new TypeError('A lecture needs a lesson id to be ordered.');
  return id;
}

/**
 * Lecture ordinals for one course's term, 1-based and zero-padded to two digits.
 * Sorted by calendar day first — "lecture 7" means the seventh day the course met,
 * which is what a student means by the phrase — and by the full published timestamp
 * second, so two lectures posted on the same day still land in the order they
 * actually happened rather than in whatever order the API listed them. A final
 * tie-break on the lesson id only fires when both are identical, which should never
 * happen for two distinct lectures, and exists purely so the sort is total.
 */
export function assignOrdinals(lectures) {
  const rows = (lectures || []).map((lecture) => ({
    key: ordinalKey(lecture),
    day: dateOnly(lecture.publishedAt),
    at: String(lecture.publishedAt ?? '')
  }));
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.at.localeCompare(b.at) || a.key.localeCompare(b.key));

  const ordinals = new Map();
  rows.forEach((row, index) => ordinals.set(row.key, index + 1));
  return ordinals;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** `<COURSE>-L<NN>-<YYYY-MM-DD>`, the stem every file for one lecture shares. */
export function lectureStem({ courseFolder, publishedAt, ordinal }) {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new TypeError('A lecture ordinal must be a positive integer.');
  }
  return `${slugifyCourse(courseFolder)}-L${pad2(ordinal)}-${dateOnly(publishedAt)}`;
}

/**
 * The video, transcript and audio destinations for one lecture, relative to the
 * course directory's root — `_media/recordings/…`, `_media/transcripts/…`,
 * `_media/audio/…` — plus the shared stem, so a caller that needs to rename a
 * quarantined pair can do it without re-deriving the stem itself.
 */
export function destinationsFor({ courseFolder, publishedAt, ordinal }) {
  const stem = lectureStem({ courseFolder, publishedAt, ordinal });
  const build = (kind) => {
    const filename = `${stem}.${KIND_EXTENSION[kind]}`;
    const folder = `_media/${KIND_DIR[kind]}`;
    return { folder, filename, path: `${folder}/${filename}` };
  };
  return { stem, video: build('video'), transcript: build('transcript'), audio: build('audio') };
}

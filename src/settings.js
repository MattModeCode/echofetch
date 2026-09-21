export const DEFAULTS = {
  // Capping resolution at download time is what actually prevents multi-GB files;
  // nothing downstream can undo having fetched the 1080p variant.
  maxHeight: 720,
  // Echo360 publishes audio as its own rendition, so a video stream on its own is
  // silent. Fetching the companion track and muxing it in is the only way a
  // downloaded lecture has sound without a second trip to the site.
  includeAudio: true,
  audioOnlyDefault: false,
  filenameTemplate: '{title}',
  concurrency: 6,
  // A relative subfolder. Where the user picked a folder in Settings it sits inside
  // that one; otherwise it sits inside the browser's download directory, which is as
  // far as chrome.downloads reaches on its own. Absolute paths are rejected either way.
  downloadFolder: '',
  askEachTime: false,
  // [{ match, matchKind: 'title' | 'url', folder }] — first match wins.
  folderRules: [],
  // Watched courses: see watchlist.js for the shape. Small enough to sync; the ledger
  // of what has been downloaded is far too big for it and lives in storage.local.
  courses: [],
  notifyOnDownload: true
};

const ILLEGAL = /[<>:"|?*\u0000-\u001f]/g;

/**
 * chrome.downloads.download only accepts a relative filename: an absolute path, a
 * leading slash, or a `..` segment makes the browser reject the download outright.
 * Rather than refuse the input we reduce it to the nearest safe relative path, so a
 * pasted "C:\Users\me\Lectures" still lands somewhere sensible.
 */
export function sanitizeFolder(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .split('/')
    .map((segment) => segment.replace(ILLEGAL, '').replace(/^[\s.]+|[\s.]+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/**
 * The extension never sees a course object — only the lecture title and the tab URL —
 * so a rule matches on whichever of those the user points it at. The Echo360 section
 * id lives in the URL, which is the stable key when titles vary week to week.
 */
export function resolveFolder(title, url, settings) {
  for (const rule of settings?.folderRules || []) {
    const needle = String(rule?.match ?? '').trim().toLowerCase();
    if (!needle) continue;
    const haystack = String((rule.matchKind === 'url' ? url : title) ?? '').toLowerCase();
    if (haystack.includes(needle)) return sanitizeFolder(rule.folder);
  }
  return sanitizeFolder(settings?.downloadFolder);
}

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

export function applyTemplate(template, { title, date }) {
  return (template || DEFAULTS.filenameTemplate)
    .replace(/\{title\}/g, title || 'Lecture')
    .replace(/\{date\}/g, date || new Date().toISOString().slice(0, 10));
}

export const DEFAULTS = {
  // Capping resolution at download time is what actually prevents multi-GB files;
  // nothing downstream can undo having fetched the 1080p variant.
  maxHeight: 720,
  audioOnlyDefault: false,
  filenameTemplate: '{title}',
  concurrency: 6
};

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

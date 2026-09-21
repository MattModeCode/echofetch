// Service worker: captures playlist URLs per tab, owns the offscreen document,
// and hands finished blobs to chrome.downloads.
//
// The SW itself never downloads. MV3 tears the worker down after ~30s idle, which
// would kill a lecture-length transfer partway through; the offscreen document is
// the only place a long-running fetch loop survives.

import { getSettings, applyTemplate, resolveFolder } from './settings.js';

const OFFSCREEN_PATH = 'src/offscreen.html';
const PLAYLIST_PATTERN = /\.m3u8(\?|$)/i;

/** tabId -> Map<url, {url, seenAt}> */
const captured = new Map();

function recordPlaylist(tabId, url) {
  if (tabId < 0) return;
  if (!PLAYLIST_PATTERN.test(url)) return;
  const forTab = captured.get(tabId) || new Map();
  if (!forTab.has(url)) forTab.set(url, { url, seenAt: Date.now() });
  captured.set(tabId, forTab);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => recordPlaylist(details.tabId, details.url),
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }
);

chrome.tabs.onRemoved.addListener((tabId) => captured.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) captured.delete(tabId);
});

async function readJob() {
  const { job } = await chrome.storage.session.get('job');
  return job || null;
}

async function writeJob(job) {
  await chrome.storage.session.set({ job });
  // Popup may be closed; a missing receiver is expected and not an error.
  chrome.runtime.sendMessage({ type: 'jobUpdate', job }).catch(() => {});
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: 'Assembles HLS media segments into a single downloadable file.'
  });
}

/**
 * createDocument resolves before the offscreen module script has run, so the first
 * send can land with no listener attached. Retry until it is received.
 */
async function sendToOffscreen(message, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('The download worker did not start.');
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

function sanitizeFilename(name) {
  return (name || 'lecture')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'lecture';
}

async function startDownload({ variantUrl, audioUrl = null, title, pageUrl = '', kind = 'video' }) {
  const job = {
    id: `job-${Date.now()}`,
    title,
    // Kept so folder rules can match on the Echo360 section id, which outlives the
    // lecture title from week to week.
    url: pageUrl,
    kind,
    withAudio: Boolean(audioUrl),
    done: 0,
    total: 0,
    bytes: 0,
    state: 'starting',
    error: null
  };
  await writeJob(job);
  try {
    const { concurrency } = await getSettings();
    await ensureOffscreen();
    await sendToOffscreen({
      type: 'download',
      variantUrl,
      audioUrl,
      jobId: job.id,
      kind,
      concurrency
    });
  } catch (error) {
    await writeJob({ ...job, state: 'error', error: error.message });
    await closeOffscreen();
  }
}

function saveFile(url, filename, saveAs) {
  return chrome.downloads.download({ url, filename, saveAs }).then(
    (downloadId) =>
      new Promise((resolve, reject) => {
        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            resolve(filename);
          }
          if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error(delta.error?.current || 'Download interrupted by the browser.'));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      })
  );
}

/**
 * A video and its companion audio arrive as two files. They share one stem and differ
 * only by extension, so `tools/merge-audio.mjs` and the offered ffmpeg command can
 * pair them without guessing.
 */
async function deliver({ files }) {
  const job = await readJob();
  const settings = await getSettings();
  const stem = sanitizeFilename(
    applyTemplate(settings.filenameTemplate, {
      title: job?.title,
      date: new Date().toISOString().slice(0, 10)
    })
  );
  // A per-course rule beats the default folder; both are relative to the browser's
  // download directory, which is as far as chrome.downloads lets an extension reach.
  const folder = resolveFolder(job?.title, job?.url, settings);
  const prefix = folder ? `${folder}/` : '';

  try {
    const filenames = [];
    for (const file of files) {
      // Sequential: two concurrent downloads land in an unpredictable order, and the
      // second can inherit a " (1)" suffix that breaks the shared stem.
      filenames.push(
        await saveFile(file.blobUrl, `${prefix}${stem}.${file.extension}`, settings.askEachTime)
      );
    }
    await writeJob({ ...job, state: 'complete', filename: filenames[0], filenames });
  } catch (error) {
    await writeJob({ ...job, state: 'error', error: error.message });
  } finally {
    // Closing the document revokes its blob URLs, so an explicit revoke is redundant.
    await closeOffscreen();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages addressed to the offscreen document are not ours to handle.
  if (message.target === 'offscreen') return false;

  switch (message.type) {
    case 'getPlaylists': {
      const forTab = captured.get(message.tabId);
      sendResponse({ playlists: forTab ? [...forTab.values()] : [] });
      return false;
    }
    case 'getJob': {
      readJob().then((job) => sendResponse({ job }));
      return true;
    }
    case 'startDownload': {
      startDownload(message).then(() => sendResponse({ ok: true }));
      return true;
    }
    case 'progress': {
      readJob().then((job) => {
        if (!job || job.id !== message.jobId) return;
        writeJob({ ...job, ...message.patch, state: 'running' });
      });
      return false;
    }
    case 'assembled': {
      deliver(message);
      return false;
    }
    case 'failed': {
      readJob()
        .then((job) => writeJob({ ...job, state: 'error', error: message.error }))
        .then(closeOffscreen);
      return false;
    }
    case 'cancel': {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel' }).catch(() => {});
      readJob()
        .then((job) => writeJob({ ...job, state: 'cancelled' }))
        .then(closeOffscreen);
      return false;
    }
    default:
      return false;
  }
});

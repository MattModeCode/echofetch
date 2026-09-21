// The download engine. Lives in an offscreen document so a lecture-length transfer
// is not killed by the service worker's ~30s idle teardown.

import {
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  containerFor,
  rangeHeader
} from './hls.js';
import { readRoot, hasWriteAccess, writeInto } from './folder-handle.js';

const DEFAULT_CONCURRENCY = 6;
const MAX_ATTEMPTS = 3;
const PROGRESS_INTERVAL_MS = 250;

let cancelled = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

/** HLS defaults the IV to the segment's media sequence number, big-endian. */
function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence);
  return iv;
}

async function fetchWithSession(url, { asText = false, byteRange = null } = {}) {
  const init = { credentials: 'include', cache: 'no-store' };
  if (byteRange) init.headers = { Range: rangeHeader(byteRange) };

  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
    error.status = response.status;
    throw error;
  }
  if (asText) return response.text();

  const buffer = await response.arrayBuffer();
  if (!byteRange || response.status === 206) return buffer;

  // 200 means the server ignored the Range header and sent the whole file. Slicing
  // here is what keeps that from becoming one whole lecture per segment on disk.
  const end = byteRange.offset + byteRange.length;
  if (buffer.byteLength < end) {
    throw new Error(
      `Server ignored the byte range and returned ${buffer.byteLength} bytes, ` +
        `too short for bytes ${byteRange.offset}-${end - 1}.`
    );
  }
  return buffer.slice(byteRange.offset, end);
}

const keyCache = new Map();

async function decryptSegment(buffer, key, sequence) {
  if (!keyCache.has(key.url)) {
    const raw = await fetchWithSession(key.url);
    keyCache.set(key.url, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
  }
  const iv = key.iv ? hexToBytes(key.iv) : sequenceIv(sequence);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyCache.get(key.url), buffer);
}

async function loadMediaPlaylist(url) {
  const text = await fetchWithSession(url, { asText: true });
  if (!isMasterPlaylist(text)) return { parsed: parseMedia(text, url), mediaUrl: url };

  const { variants } = parseMaster(text, url);
  if (!variants.length) throw new Error('Master playlist listed no video streams.');
  const best = variants[0];
  const mediaText = await fetchWithSession(best.url, { asText: true });
  return { parsed: parseMedia(mediaText, best.url), mediaUrl: best.url };
}

/**
 * Segment URLs can carry expiring tokens. On an auth failure we re-read the
 * playlist once and swap in the fresh URL and byte range for the same index rather
 * than failing a download that is otherwise healthy.
 */
async function fetchSegment(segment, index, refreshSegments) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (cancelled) throw new Error('cancelled');
    try {
      const buffer = await fetchWithSession(segment.url, { byteRange: segment.byteRange });
      return segment.key ? await decryptSegment(buffer, segment.key, segment.sequence) : buffer;
    } catch (error) {
      lastError = error;
      if (error.status === 401 || error.status === 403) {
        const fresh = await refreshSegments();
        if (fresh[index]) {
          segment.url = fresh[index].url;
          segment.byteRange = fresh[index].byteRange;
        }
      }
      if (attempt < MAX_ATTEMPTS) await sleep(400 * attempt);
    }
  }
  throw new Error(`Segment ${index + 1} failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

async function runPool(segments, refreshSegments, onProgress, concurrency) {
  const results = new Array(segments.length);
  let nextIndex = 0;
  let done = 0;
  let bytes = 0;

  async function worker() {
    while (nextIndex < segments.length) {
      if (cancelled) return;
      const index = nextIndex++;
      const buffer = await fetchSegment(segments[index], index, refreshSegments);
      results[index] = buffer;
      done++;
      bytes += buffer.byteLength;
      onProgress(done, bytes);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));
  if (cancelled) throw new Error('cancelled');
  return results;
}

/** Read a playlist and refuse the shapes that cannot produce a usable file. */
async function prepareStream(url) {
  const { parsed, mediaUrl } = await loadMediaPlaylist(url);

  if (parsed.drm) {
    throw new Error(
      `This lecture is DRM-protected (${parsed.drm.method}). No extension can decrypt it — ` +
        'the stream would have to be re-encoded from playback, which EchoFetch does not do.'
    );
  }
  if (!parsed.segments.length) throw new Error('Playlist contained no media segments.');

  // A byte-range playlist points every segment at one file and distinguishes them by
  // EXT-X-BYTERANGE. Downloading it without honouring those ranges fetches the whole
  // lecture once per segment — the 3.9 GB failure this guard exists to make loud.
  const distinctUrls = new Set(parsed.segments.map((s) => s.url)).size;
  if (parsed.segments.length > 1 && distinctUrls === 1 && !parsed.byteRanged) {
    throw new Error(
      `This playlist lists ${parsed.segments.length} segments that all share one URL but ` +
        'publishes no byte ranges. Downloading it would fetch the whole lecture once per ' +
        'segment, so EchoFetch stopped instead.'
    );
  }

  return { parsed, mediaUrl };
}

async function assembleStream({ parsed, mediaUrl }, kind, concurrency, onProgress) {
  const refreshSegments = async () => {
    const refreshed = await loadMediaPlaylist(mediaUrl);
    return refreshed.parsed.segments.map((s) => ({ url: s.url, byteRange: s.byteRange }));
  };

  const parts = [];
  if (parsed.initSegment) {
    parts.push(
      await fetchWithSession(parsed.initSegment.url, {
        byteRange: parsed.initSegment.byteRange
      })
    );
  }
  parts.push(...(await runPool(parsed.segments, refreshSegments, onProgress, concurrency)));

  const { extension, mime } = containerFor(parsed, kind);
  const blob = new Blob(parts, { type: mime });
  return { blob, blobUrl: URL.createObjectURL(blob), extension };
}

/**
 * Echo360 publishes audio as its own rendition, so a video stream on its own is
 * silent. When the picker passes an audio URL alongside the video one, both are
 * fetched in the same job and delivered as a matched pair.
 */
// Blobs cannot travel through runtime.sendMessage, so the finished files stay here
// and the service worker addresses them by index when it asks for a disk write.
let assembled = [];

async function download({ variantUrl, audioUrl, jobId, kind, concurrency }) {
  cancelled = false;
  keyCache.clear();
  assembled = [];

  const video = await prepareStream(variantUrl);
  const audio = audioUrl ? await prepareStream(audioUrl) : null;

  const total = video.parsed.segments.length + (audio ? audio.parsed.segments.length : 0);
  let lastPost = 0;
  let baseDone = 0;
  let baseBytes = 0;
  let streamBytes = 0;

  const post = (done, bytes) => {
    streamBytes = bytes;
    const cumulativeDone = baseDone + done;
    const now = Date.now();
    if (now - lastPost < PROGRESS_INTERVAL_MS && cumulativeDone < total) return;
    lastPost = now;
    chrome.runtime.sendMessage({
      type: 'progress',
      jobId,
      patch: { done: cumulativeDone, total, bytes: baseBytes + bytes }
    });
  };
  post(0, 0);

  const files = [];
  const primary = await assembleStream(video, kind, concurrency, post);
  files.push({ ...primary, role: kind });

  if (audio) {
    // The second stream restarts its own counters, so carry the first one's totals.
    baseDone = video.parsed.segments.length;
    baseBytes = streamBytes;
    const companion = await assembleStream(audio, 'audio', concurrency, post);
    files.push({ ...companion, role: 'audio' });
  }

  assembled = files.map((file) => file.blob);
  chrome.runtime.sendMessage({
    type: 'assembled',
    jobId,
    files: files.map(({ blobUrl, extension, role }) => ({ blobUrl, extension, role }))
  });
}

/**
 * Writes the assembled files into the folder the user chose in Settings. Every way
 * this can fail — no folder chosen, permission lapsed since the browser restarted, a
 * read-only disk — is reported rather than thrown, because the caller answers all of
 * them the same way: fall back to the browser's own download directory.
 */
async function writeFiles(paths) {
  const root = await readRoot();
  if (!root) return { written: false, reason: 'no-folder' };
  if (!(await hasWriteAccess(root))) return { written: false, reason: 'no-permission' };

  try {
    const filenames = [];
    for (const [index, path] of paths.entries()) {
      filenames.push(await writeInto(root, path, assembled[index]));
    }
    return { written: true, filenames, folder: root.name };
  } catch (error) {
    return { written: false, reason: error?.message || 'write-failed' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'cancel') {
    cancelled = true;
    return false;
  }
  if (message.type === 'writeFiles') {
    writeFiles(message.paths).then(sendResponse);
    return true;
  }
  if (message.type === 'download') {
    download({
      variantUrl: message.variantUrl,
      audioUrl: message.audioUrl || null,
      jobId: message.jobId,
      kind: message.kind || 'video',
      concurrency: message.concurrency || DEFAULT_CONCURRENCY
    }).catch((error) => {
      // Stop any sibling workers still in flight before reporting.
      cancelled = true;
      if (error.message === 'cancelled') return;
      chrome.runtime.sendMessage({ type: 'failed', jobId: message.jobId, error: error.message });
    });
  }
  return false;
});

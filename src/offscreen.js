// The download engine. Lives in an offscreen document so a lecture-length transfer
// is not killed by the service worker's ~30s idle teardown.

import { isMasterPlaylist, parseMaster, parseMedia, containerFor } from './hls.js';

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

async function fetchWithSession(url, asText = false) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
    error.status = response.status;
    throw error;
  }
  return asText ? response.text() : response.arrayBuffer();
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
  const text = await fetchWithSession(url, true);
  if (!isMasterPlaylist(text)) return { parsed: parseMedia(text, url), mediaUrl: url };

  const { variants } = parseMaster(text, url);
  if (!variants.length) throw new Error('Master playlist listed no video streams.');
  const best = variants[0];
  const mediaText = await fetchWithSession(best.url, true);
  return { parsed: parseMedia(mediaText, best.url), mediaUrl: best.url };
}

/**
 * Segment URLs can carry expiring tokens. On an auth failure we re-read the
 * playlist once and swap in the fresh URL for the same index rather than failing
 * a download that is otherwise healthy.
 */
async function fetchSegment(segment, index, refreshUrls) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (cancelled) throw new Error('cancelled');
    try {
      const buffer = await fetchWithSession(segment.url);
      return segment.key ? await decryptSegment(buffer, segment.key, segment.sequence) : buffer;
    } catch (error) {
      lastError = error;
      if (error.status === 401 || error.status === 403) {
        const fresh = await refreshUrls();
        if (fresh[index]) segment.url = fresh[index];
      }
      if (attempt < MAX_ATTEMPTS) await sleep(400 * attempt);
    }
  }
  throw new Error(`Segment ${index + 1} failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

async function runPool(segments, refreshUrls, onProgress, concurrency) {
  const results = new Array(segments.length);
  let nextIndex = 0;
  let done = 0;
  let bytes = 0;

  async function worker() {
    while (nextIndex < segments.length) {
      if (cancelled) return;
      const index = nextIndex++;
      const buffer = await fetchSegment(segments[index], index, refreshUrls);
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

async function download(variantUrl, jobId, kind, concurrency) {
  cancelled = false;
  keyCache.clear();

  const { parsed, mediaUrl } = await loadMediaPlaylist(variantUrl);

  if (parsed.drm) {
    throw new Error(
      `This lecture is DRM-protected (${parsed.drm.method}). No extension can decrypt it — ` +
        'the stream would have to be re-encoded from playback, which EchoFetch does not do.'
    );
  }
  if (!parsed.segments.length) throw new Error('Playlist contained no media segments.');

  const total = parsed.segments.length;
  let lastPost = 0;
  const post = (done, bytes) => {
    const now = Date.now();
    if (now - lastPost < PROGRESS_INTERVAL_MS && done < total) return;
    lastPost = now;
    chrome.runtime.sendMessage({ type: 'progress', jobId, patch: { done, total, bytes } });
  };
  post(0, 0);

  const refreshUrls = async () => {
    const refreshed = await loadMediaPlaylist(mediaUrl);
    return refreshed.parsed.segments.map((s) => s.url);
  };

  const parts = [];
  if (parsed.initSegment) parts.push(await fetchWithSession(parsed.initSegment.url));
  parts.push(...(await runPool(parsed.segments, refreshUrls, post, concurrency)));

  const { extension, mime } = containerFor(parsed, kind);
  const blobUrl = URL.createObjectURL(new Blob(parts, { type: mime }));
  chrome.runtime.sendMessage({ type: 'assembled', jobId, blobUrl, extension });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'cancel') {
    cancelled = true;
    return false;
  }
  if (message.type === 'download') {
    const concurrency = message.concurrency || DEFAULT_CONCURRENCY;
    download(message.variantUrl, message.jobId, message.kind || 'video', concurrency).catch((error) => {
      // Stop any sibling workers still in flight before reporting.
      cancelled = true;
      if (error.message === 'cancelled') return;
      chrome.runtime.sendMessage({ type: 'failed', jobId: message.jobId, error: error.message });
    });
  }
  return false;
});

// HLS playlist parsing. Shared by popup (variant listing) and offscreen (download).

const DRM_KEYFORMATS = ['widevine', 'playready', 'fairplay', 'urn:uuid'];

export function resolveUrl(base, ref) {
  return new URL(ref, base).href;
}

function parseAttributes(line) {
  const attrs = {};
  // Split on commas not inside double quotes.
  const parts = line.match(/(?:[^,"]|"[^"]*")+/g) || [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[key] = value;
  }
  return attrs;
}

export function isMasterPlaylist(text) {
  return text.includes('#EXT-X-STREAM-INF');
}

/**
 * Parse a master playlist into its variant streams, highest bandwidth first.
 */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audioGroups = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO' && attrs.URI) {
        const list = audioGroups.get(attrs['GROUP-ID']) || [];
        list.push({
          name: attrs.NAME || 'audio',
          url: resolveUrl(baseUrl, attrs.URI),
          isDefault: attrs.DEFAULT === 'YES'
        });
        audioGroups.set(attrs['GROUP-ID'], list);
      }
      continue;
    }

    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    // The URI is the next non-comment line.
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;

    const resolution = attrs.RESOLUTION || null;
    variants.push({
      url: resolveUrl(baseUrl, uri),
      bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
      resolution,
      height: resolution ? parseInt(resolution.split('x')[1], 10) : null,
      codecs: attrs.CODECS || null,
      audioGroup: attrs.AUDIO || null
    });
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { variants, audioGroups };
}

/**
 * Parse a media playlist into an ordered segment list plus encryption info.
 * Detects DRM (unusable) vs plain AES-128 (decryptable in-extension).
 */
export function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let initSegment = null;
  let currentKey = null;
  let drm = null;
  let mediaSequence = 0;
  let totalDuration = 0;
  let pendingDuration = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) initSegment = { url: resolveUrl(baseUrl, attrs.URI) };
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD || 'NONE').toUpperCase();
      const keyFormat = (attrs.KEYFORMAT || 'identity').toLowerCase();

      if (method === 'NONE') {
        currentKey = null;
        continue;
      }
      if (DRM_KEYFORMATS.some((f) => keyFormat.includes(f)) || method.startsWith('SAMPLE-AES')) {
        drm = { method, keyFormat };
        continue;
      }
      if (method === 'AES-128') {
        currentKey = {
          method,
          url: resolveUrl(baseUrl, attrs.URI),
          iv: attrs.IV || null
        };
        continue;
      }
      // Unknown encryption method — treat as unusable rather than producing a corrupt file.
      drm = { method, keyFormat };
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
      continue;
    }

    if (line.startsWith('#')) continue;

    segments.push({
      url: resolveUrl(baseUrl, line),
      duration: pendingDuration,
      sequence: mediaSequence + segments.length,
      key: currentKey
    });
    totalDuration += pendingDuration;
    pendingDuration = 0;
  }

  return { segments, initSegment, drm, totalDuration };
}

/**
 * fMP4 streams carry an EXT-X-MAP init segment; MPEG-TS streams do not.
 * The container decides the extension the assembled file must carry.
 */
export function containerFor(parsed, kind = 'video') {
  const fragmented =
    Boolean(parsed.initSegment) ||
    /\.mp4|\.m4s/i.test(parsed.segments[0] ? new URL(parsed.segments[0].url).pathname : '');

  if (kind === 'audio') {
    return fragmented
      ? { extension: 'm4a', mime: 'audio/mp4' }
      : { extension: 'aac', mime: 'audio/aac' };
  }
  return fragmented
    ? { extension: 'mp4', mime: 'video/mp4' }
    : { extension: 'ts', mime: 'video/mp2t' };
}

/** Flatten the master playlist's audio rendition groups, one entry per distinct URL. */
export function audioRenditions(audioGroups) {
  const byUrl = new Map();
  for (const list of audioGroups.values()) {
    for (const rendition of list) {
      if (!byUrl.has(rendition.url)) byUrl.set(rendition.url, rendition);
    }
  }
  return [...byUrl.values()];
}

const ASPECT_NAMES = [
  [16 / 9, '16:9'],
  [4 / 3, '4:3'],
  [3 / 2, '3:2'],
  [1, '1:1']
];

export function aspectLabel(resolution) {
  if (!resolution) return null;
  const [w, h] = resolution.split('x').map(Number);
  if (!w || !h) return null;
  const ratio = w / h;
  const match = ASPECT_NAMES.find(([value]) => Math.abs(ratio - value) < 0.02);
  return match ? match[1] : `${ratio.toFixed(2)}:1`;
}

/** Exactly 16:9 at the higher resolution is usually the screen capture. Usually. */
export function guessFeed(option, allOptions) {
  if (allOptions.length < 2) return null;
  const tallest = Math.max(...allOptions.map((o) => o.height || 0));
  if (!option.height) return null;
  if (option.aspect === '16:9' && option.height === tallest) return 'likely screen capture';
  if (option.aspect && option.aspect !== '16:9') return 'likely presenter camera';
  return null;
}

export function formatSize(bytes) {
  if (!bytes || !isFinite(bytes)) return null;
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

import {
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  audioRenditions,
  audioForVariant,
  aspectLabel,
  guessFeed,
  formatSize,
  formatDuration
} from './hls.js';
import { getSettings } from './settings.js';

const ECHO_HOST = /(^|\.)echo360\.(org|ca|net\.au|org\.au|org\.uk)$/i;
const ASSUMED_AUDIO_BITRATE = 128_000;

const view = document.getElementById('view');
const send = (message) => chrome.runtime.sendMessage(message);

function show(templateId) {
  view.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
  return view;
}

const fetchText = (url) =>
  fetch(url, { credentials: 'include', cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });

function cleanTitle(raw) {
  return (raw || 'Lecture').replace(/\s*[|–-]\s*Echo\s*360.*$/i, '').trim() || 'Lecture';
}

/**
 * Duration is identical across a master's variants, so probe one media playlist per
 * master rather than one per variant — the difference is eight fetches versus two.
 */
async function probeDuration(variantUrl) {
  try {
    return parseMedia(await fetchText(variantUrl), variantUrl).totalDuration;
  } catch {
    return 0;
  }
}

async function buildOptions(playlists) {
  const video = [];
  const audio = [];
  let duration = 0;

  for (const [index, entry] of playlists.entries()) {
    let text;
    try {
      text = await fetchText(entry.url);
    } catch {
      continue;
    }

    const source = playlists.length > 1 ? `Recording ${index + 1}` : '';

    if (!isMasterPlaylist(text)) {
      video.push({ kind: 'video', url: entry.url, label: 'Video', source, height: 0 });
      continue;
    }

    const { variants, audioGroups } = parseMaster(text, entry.url);
    if (!variants.length) continue;

    if (!duration) duration = await probeDuration(variants[0].url);

    for (const variant of variants) {
      const aspect = aspectLabel(variant.resolution);
      const companion = audioForVariant(variant, audioGroups);
      const videoBytes = duration && variant.bandwidth ? (variant.bandwidth / 8) * duration : 0;
      video.push({
        kind: 'video',
        url: variant.url,
        audioUrl: companion ? companion.url : null,
        source,
        height: variant.height || 0,
        aspect,
        label: variant.height ? `${variant.height}p` : 'Video',
        bytes: videoBytes + (companion && duration ? (ASSUMED_AUDIO_BITRATE / 8) * duration : 0)
      });
    }

    // A lecture has one soundtrack. Echo360 often publishes it several times over —
    // once per rendition group, once per recording — and every copy sounds the same,
    // so showing more than one row is a choice nobody can make.
    const [rendition] = audioRenditions(audioGroups);
    if (rendition && !audio.length) {
      audio.push({
        kind: 'audio',
        url: rendition.url,
        label: 'Audio only',
        height: 0,
        bytes: duration ? (ASSUMED_AUDIO_BITRATE / 8) * duration : 0
      });
    }
  }

  // A video rendition with no companion audio downloads silently, which is never what
  // anyone wants. Hiding those is only safe while something with sound remains, so a
  // lecture published without any audio at all keeps its options and gets a warning.
  const withSound = video.filter((option) => option.audioUrl);
  const silentOnly = withSound.length === 0;
  const offered = silentOnly ? video : withSound;

  for (const option of offered) {
    option.sub = [option.source, describeFeed(option, offered)].filter(Boolean).join(' · ');
  }

  return { video: offered, audio, duration, silentOnly };
}

/** Plain words for what the camera was pointed at, and only when there is a choice. */
function describeFeed(option, allOptions) {
  const feed = guessFeed(option, allOptions);
  if (feed === 'likely screen capture') return 'Slides';
  if (feed === 'likely presenter camera') return 'Presenter camera';
  return null;
}

function pickDefault({ video, audio }, settings) {
  if (settings.audioOnlyDefault && audio.length) return audio[0];
  const withinCap = video.filter((o) => o.height && o.height <= settings.maxHeight);
  const pool = withinCap.length ? withinCap : video;
  return pool.reduce((a, b) => ((b.height || 0) > (a.height || 0) ? b : a), pool[0]);
}

function buildRow(option, index, isDefault) {
  const li = document.createElement('li');
  const label = document.createElement('label');

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'stream';
  input.value = String(index);
  input.checked = isDefault;

  const stack = document.createElement('span');
  stack.className = 'stack';

  const primary = document.createElement('span');
  primary.textContent = option.label;

  const secondary = document.createElement('span');
  secondary.className = 'sub';
  secondary.textContent = option.sub || '';

  stack.append(primary, secondary);

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = formatSize(option.bytes) || '';

  label.append(input, stack, size);
  li.append(label);
  return li;
}

function renderPicker(title, pageUrl, groups, settings) {
  const options = [...groups.video, ...groups.audio];
  const root = show('tpl-picker');
  const preselected = pickDefault(groups, settings);

  root.querySelector('[data-title]').textContent = title;
  root.querySelector('[data-meta]').textContent = [
    formatDuration(groups.duration),
    options.length > 1 ? 'Pick a size' : null
  ]
    .filter(Boolean)
    .join(' · ');

  const list = root.querySelector('[data-streams]');
  options.forEach((option, index) => list.append(buildRow(option, index, option === preselected)));

  const note = root.querySelector('[data-note]');
  if (groups.silentOnly) {
    note.textContent =
      'This lecture was published without sound, so these downloads have no audio.';
  } else if (!groups.audio.length) {
    note.textContent =
      'This lecture has no audio-only version. Take the smallest size instead.';
  } else {
    note.textContent = '';
  }

  root.querySelector('[data-start]').addEventListener('click', async (event) => {
    const chosen = options[Number(view.querySelector('input[name=stream]:checked').value)];
    const audioUrl = settings.includeAudio ? chosen.audioUrl || null : null;
    const host = new URL(chosen.url).host;

    // The audio rendition can sit on a different origin, and both must be granted
    // before the job starts or the second stream fails halfway through.
    const origins = [
      ...new Set(
        [chosen.url, audioUrl].filter(Boolean).map((url) => `${new URL(url).origin}/*`)
      )
    ];

    // request() must be the first await here or Chrome stops counting the click as a
    // user gesture. It resolves true without prompting when already granted.
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      return renderError(`EchoFetch needs permission to read ${host} to fetch the media.`);
    }

    event.target.disabled = true;
    await send({
      type: 'startDownload',
      variantUrl: chosen.url,
      audioUrl,
      title,
      pageUrl,
      kind: chosen.kind
    });
    renderJob({ title, done: 0, total: 0, bytes: 0, state: 'starting' });
  });
}

function shrinkCommand(filename) {
  return `ffmpeg -i "${filename}" -c:v libx265 -crf 28 -preset slow -c:a aac -b:a 96k -ac 1 "${filename.replace(/\.[^.]+$/, '')}-small.mp4"`;
}

/** Stream copy, no re-encode: the two files are already in the right codecs. */
function mergeCommand([video, audio]) {
  return `ffmpeg -i "${video}" -i "${audio}" -c copy "${video.replace(/\.[^.]+$/, '')}-with-audio.mp4"`;
}

function renderDone(job) {
  const root = show('tpl-done');
  const filenames = job.filenames?.length ? job.filenames : [job.filename].filter(Boolean);
  root.querySelector('[data-filename]').textContent = filenames.join('  +  ');

  const copy = root.querySelector('[data-copy]');
  const paired = filenames.length > 1;

  // A paired download is two files until they are merged, so that command comes
  // first. Audio on its own is already small, and a transcode command would be noise.
  if (paired) {
    copy.textContent = 'Copy merge command';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(mergeCommand(filenames));
      copy.textContent = 'Copied';
    });
  } else if (job.kind === 'audio' || !filenames.length) {
    copy.remove();
  } else {
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(shrinkCommand(filenames[0]));
      copy.textContent = 'Copied';
    });
  }

  root.querySelector('[data-again]').addEventListener('click', start);
}

function renderJob(job) {
  if (job.state === 'complete') return renderDone(job);
  if (job.state === 'error') return renderError(job.error);
  if (job.state === 'cancelled') return start();

  const root = show('tpl-progress');
  root.querySelector('[data-title]').textContent = job.title;
  const ratio = job.total ? Math.min(1, Math.max(0, job.done / job.total)) : 0;
  root.querySelector('[data-fill]').style.transform = `scaleX(${ratio})`;
  root.querySelector('[data-detail]').textContent = job.total
    ? `${Math.floor(ratio * 100)}%`
    : 'Reading the playlist…';
  root.querySelector('[data-cancel]').addEventListener('click', () => send({ type: 'cancel' }));
}

function renderError(message) {
  const root = show('tpl-error');
  root.querySelector('[data-message]').textContent = message || 'Unknown error.';
  root.querySelector('[data-again]').addEventListener('click', start);
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !ECHO_HOST.test(new URL(tab.url).hostname)) return show('tpl-offsite');

  const { job } = await send({ type: 'getJob' });
  if (job && ['starting', 'running'].includes(job.state)) return renderJob(job);

  const { playlists } = await send({ type: 'getPlaylists', tabId: tab.id });
  if (!playlists.length) {
    const root = show('tpl-waiting');
    root.querySelector('[data-widen]').addEventListener('click', async () => {
      // webRequest only reports URLs the extension holds host permission for, so a
      // playlist on an institution-owned domain is invisible until this is granted.
      if (await chrome.permissions.request({ origins: ['*://*/*'] })) {
        chrome.tabs.reload(tab.id);
        window.close();
      }
    });
    return root;
  }

  const [groups, settings] = await Promise.all([buildOptions(playlists), getSettings()]);
  if (!groups.video.length && !groups.audio.length) {
    return renderError('Found a playlist but could not read it. Try replaying the lecture.');
  }

  renderPicker(cleanTitle(tab.title), tab.url, groups, settings);
}

document.getElementById('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'jobUpdate' && message.job) renderJob(message.job);
});

start();

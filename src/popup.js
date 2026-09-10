import {
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  audioRenditions,
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

    const source = playlists.length > 1 ? `Stream ${index + 1}` : 'Lecture';

    if (!isMasterPlaylist(text)) {
      video.push({ kind: 'video', url: entry.url, label: source, sub: 'single quality', height: 0 });
      continue;
    }

    const { variants, audioGroups } = parseMaster(text, entry.url);
    if (!variants.length) continue;

    if (!duration) duration = await probeDuration(variants[0].url);

    for (const variant of variants) {
      const aspect = aspectLabel(variant.resolution);
      video.push({
        kind: 'video',
        url: variant.url,
        source,
        height: variant.height || 0,
        aspect,
        label: variant.height ? `${variant.height}p${aspect ? ` · ${aspect}` : ''}` : source,
        bytes: duration && variant.bandwidth ? (variant.bandwidth / 8) * duration : 0
      });
    }

    for (const rendition of audioRenditions(audioGroups)) {
      audio.push({
        kind: 'audio',
        url: rendition.url,
        label: 'Audio only',
        sub: `${rendition.name} · separate track`,
        height: 0,
        bytes: duration ? (ASSUMED_AUDIO_BITRATE / 8) * duration : 0,
        estimated: true
      });
    }
  }

  for (const option of video) {
    const feed = guessFeed(option, video);
    option.sub = [option.source, feed].filter(Boolean).join(' — ');
  }

  return { video, audio, duration };
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
  const formatted = formatSize(option.bytes);
  size.textContent = formatted ? `${option.estimated ? '~' : ''}${formatted}` : '';

  label.append(input, stack, size);
  li.append(label);
  return li;
}

function renderPicker(title, groups, settings) {
  const options = [...groups.video, ...groups.audio];
  const root = show('tpl-picker');
  const preselected = pickDefault(groups, settings);

  root.querySelector('[data-title]').textContent = title;
  root.querySelector('[data-meta]').textContent = [
    formatDuration(groups.duration),
    groups.video.length > 1 ? `${groups.video.length} qualities` : null
  ]
    .filter(Boolean)
    .join(' · ');

  const list = root.querySelector('[data-streams]');
  options.forEach((option, index) => list.append(buildRow(option, index, option === preselected)));

  const note = root.querySelector('[data-note]');
  note.textContent = groups.audio.length
    ? ''
    : 'No separate audio track is published for this lecture. For audio only, take the smallest video and strip the picture with the ffmpeg command offered after the download.';

  root.querySelector('[data-start]').addEventListener('click', async (event) => {
    const chosen = options[Number(view.querySelector('input[name=stream]:checked').value)];
    const host = new URL(chosen.url).host;

    // request() must be the first await here or Chrome stops counting the click as a
    // user gesture. It resolves true without prompting when already granted.
    const granted = await chrome.permissions.request({
      origins: [`${new URL(chosen.url).origin}/*`]
    });
    if (!granted) {
      return renderError(`EchoFetch needs permission to read ${host} to fetch the media.`);
    }

    event.target.disabled = true;
    await send({ type: 'startDownload', variantUrl: chosen.url, title, kind: chosen.kind });
    renderJob({ title, done: 0, total: 0, bytes: 0, state: 'starting' });
  });
}

function shrinkCommand(filename) {
  return `ffmpeg -i "${filename}" -c:v libx265 -crf 28 -preset slow -c:a aac -b:a 96k -ac 1 "${filename.replace(/\.[^.]+$/, '')}-small.mp4"`;
}

function renderDone(job) {
  const root = show('tpl-done');
  root.querySelector('[data-filename]').textContent = job.filename || '';

  const copy = root.querySelector('[data-copy]');
  // Audio files are already small; a transcode command would be noise.
  if (job.kind === 'audio' || !job.filename) {
    copy.remove();
  } else {
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(shrinkCommand(job.filename));
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
  const ratio = job.total ? job.done / job.total : 0;
  root.querySelector('[data-fill]').style.transform = `scaleX(${ratio})`;
  root.querySelector('[data-detail]').textContent = job.total
    ? `${job.done} / ${job.total} segments · ${formatSize(job.bytes) || '0 MB'}`
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

  renderPicker(cleanTitle(tab.title), groups, settings);
}

document.getElementById('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'jobUpdate' && message.job) renderJob(message.job);
});

start();

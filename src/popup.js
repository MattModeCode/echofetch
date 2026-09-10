import { isMasterPlaylist, parseMaster } from './hls.js';

const ECHO_HOST = /(^|\.)echo360\.(org|ca|net\.au|org\.au|org\.uk)$/i;
const view = document.getElementById('view');

const send = (message) => chrome.runtime.sendMessage(message);

function show(templateId) {
  const node = document.getElementById(templateId).content.cloneNode(true);
  view.replaceChildren(node);
  return view;
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function cleanTitle(raw) {
  return (raw || 'Lecture').replace(/\s*[|–-]\s*Echo\s*360.*$/i, '').trim() || 'Lecture';
}

/**
 * Echo360 typically publishes each camera angle as its own master playlist, so a
 * lecture with a presenter feed and a screen capture shows up as two captures.
 */
async function buildOptions(playlists) {
  const options = [];

  for (const [index, entry] of playlists.entries()) {
    let text;
    try {
      text = await fetch(entry.url, { credentials: 'include', cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
    } catch {
      continue;
    }

    const source = playlists.length > 1 ? `Stream ${index + 1}` : 'Lecture';

    if (!isMasterPlaylist(text)) {
      options.push({ label: source, detail: 'single quality', url: entry.url, height: 0 });
      continue;
    }

    for (const variant of parseMaster(text, entry.url).variants) {
      options.push({
        label: variant.height ? `${source} · ${variant.height}p` : source,
        detail: variant.bandwidth ? `${(variant.bandwidth / 1e6).toFixed(1)} Mbps` : '',
        url: variant.url,
        height: variant.height || 0
      });
    }
  }

  return options;
}

function renderPicker(title, options) {
  const root = show('tpl-picker');
  root.querySelector('[data-title]').textContent = title;
  root.querySelector('[data-meta]').textContent =
    options.length > 1
      ? 'Pick a stream. The higher resolution is usually the screen capture.'
      : 'One stream available.';

  const list = root.querySelector('[data-streams]');
  const best = options.reduce((a, b) => (b.height > a.height ? b : a), options[0]);

  options.forEach((option, index) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'stream';
    input.value = String(index);
    input.checked = option === best;

    const text = document.createElement('span');
    text.textContent = option.label;

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = option.detail;

    label.append(input, text, size);
    li.append(label);
    list.append(li);
  });

  root.querySelector('[data-start]').addEventListener('click', async (event) => {
    const chosen = options[Number(view.querySelector('input[name=stream]:checked').value)];
    const host = new URL(chosen.url).host;
    const origin = `${new URL(chosen.url).origin}/*`;

    // Segments are often served from a CDN outside the Echo360 hosts in the
    // manifest. request() must be the first await in this handler or Chrome no
    // longer counts the click as a user gesture; it resolves true without a prompt
    // when the origin is already granted, so no contains() check first.
    const granted = await chrome.permissions.request({ origins: [origin] });

    if (!granted) {
      renderError(`EchoFetch needs permission to read ${host} to fetch the video.`);
      return;
    }

    event.target.disabled = true;
    await send({ type: 'startDownload', variantUrl: chosen.url, title });
    renderJob({ title, done: 0, total: 0, bytes: 0, state: 'starting' });
  });
}

function renderJob(job) {
  if (job.state === 'complete') {
    const root = show('tpl-done');
    root.querySelector('[data-filename]').textContent = job.filename || '';
    root.querySelector('[data-again]').addEventListener('click', start);
    return;
  }
  if (job.state === 'error') return renderError(job.error);
  if (job.state === 'cancelled') return start();

  const root = show('tpl-progress');
  root.querySelector('[data-title]').textContent = job.title;
  const ratio = job.total ? job.done / job.total : 0;
  root.querySelector('[data-fill]').style.transform = `scaleX(${ratio})`;
  root.querySelector('[data-detail]').textContent = job.total
    ? `${job.done} / ${job.total} segments · ${formatBytes(job.bytes)}`
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

  const options = await buildOptions(playlists);
  if (!options.length) {
    return renderError('Found a playlist but could not read it. Try replaying the lecture.');
  }

  renderPicker(cleanTitle(tab.title), options);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'jobUpdate' && message.job) renderJob(message.job);
});

start();

import { formatSize, formatDuration } from './hls.js';
import { buildOptions, cleanTitle, pickDefault, ECHO_HOST } from './streams.js';
import { parseSectionId } from './watchlist.js';
import { getSettings } from './settings.js';

const view = document.getElementById('view');
const send = (message) => chrome.runtime.sendMessage(message);

function show(templateId) {
  view.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
  return view;
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
  const options = [...groups.video, ...groups.audio, ...groups.transcript];
  const root = show('tpl-picker');
  const preselected = pickDefault(groups, {
    maxHeight: settings.maxHeight,
    audioOnly: settings.audioOnlyDefault
  });

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
  const notes = [];
  if (groups.silentOnly) {
    notes.push('This lecture was published without sound, so these downloads have no audio.');
  } else if (!groups.audio.length) {
    notes.push('This lecture has no audio-only version. Take the smallest size instead.');
  }
  if (!groups.transcript.length) {
    notes.push(
      'No transcript found yet. Open the transcript panel on the lecture page, then reopen this popup.'
    );
  }
  note.textContent = notes.join(' ');

  root.querySelector('[data-start]').addEventListener('click', async (event) => {
    const chosen = options[Number(view.querySelector('input[name=stream]:checked').value)];
    const isTranscript = chosen.kind === 'transcript';
    const audioUrl = !isTranscript && settings.includeAudio ? chosen.audioUrl || null : null;
    const host = new URL(chosen.url).host;

    // The audio rendition and the transcript can each sit on a different origin, and
    // every one must be granted before the job starts or a fetch fails halfway through.
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
      variantUrl: isTranscript ? null : chosen.url,
      transcriptUrl: isTranscript ? chosen.url : null,
      format: chosen.format || null,
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

  if (job.savedTo) root.querySelector('[data-lead]').textContent = `Saved to ${job.savedTo}.`;

  const note = root.querySelector('[data-note]');
  note.textContent = job.note || '';
  note.hidden = !job.note;

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
  } else if (job.kind === 'audio' || job.kind === 'transcript' || !filenames.length) {
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

/**
 * A course page has no lecture to download, so the popup offers the thing that page is
 * actually for: watching the course from now on.
 */
async function renderCourse(tab, section) {
  const root = show('tpl-course');
  const { courses = [], states = {} } = (await send({ type: 'getWatchState' })) || {};
  const watched = courses.find((course) => course.sectionId === section.sectionId);

  const button = root.querySelector('[data-watch]');
  const status = root.querySelector('[data-status]');

  if (watched) {
    root.querySelector('[data-lead]').textContent = 'Watching this course.';
    button.textContent = 'Check for new lectures now';
    const state = states[section.sectionId];
    status.textContent = state?.paused
      ? `Checking stopped: ${state.lastError || 'too many failures'}.`
      : 'New lectures download on their own while Chrome is open.';
  }

  button.addEventListener('click', async () => {
    // Must be the first await or Chrome stops counting this as a user gesture. An
    // unattended download cannot ask for a host it has never seen, and Echo360 serves
    // media from CDN domains that are not knowable ahead of time, so the permission has
    // to be granted now or the first automatic download fails halfway through.
    const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
    if (!granted && !watched) {
      status.textContent =
        'Without permission to read the media hosts, automatic downloads will fail. ' +
        'Press Watch again to grant it.';
      return;
    }

    button.disabled = true;
    await send(
      watched
        ? { type: 'checkNow', sectionId: section.sectionId }
        : { type: 'watchCourse', course: { ...section, label: cleanTitle(tab.title) } }
    );
    status.textContent = 'Checking now. Anything new will download in the background.';
  });

  root.querySelector('[data-settings]').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !ECHO_HOST.test(new URL(tab.url).hostname)) return show('tpl-offsite');

  const { job } = await send({ type: 'getJob' });
  if (job && ['starting', 'running'].includes(job.state)) return renderJob(job);

  const section = parseSectionId(tab.url);
  const { playlists: seen } = await send({ type: 'getPlaylists', tabId: tab.id });
  // A lecture that is already playing wins: the section id is in the URL on the
  // classroom page too, and the picker is what the user came for there.
  if (section && !seen.length) return renderCourse(tab, section);

  const { playlists, transcripts } = await send({ type: 'getPlaylists', tabId: tab.id });
  if (!playlists.length && !transcripts.length) {
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

  const [groups, settings] = await Promise.all([
    buildOptions(playlists, transcripts),
    getSettings()
  ]);
  if (!groups.video.length && !groups.audio.length && !groups.transcript.length) {
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

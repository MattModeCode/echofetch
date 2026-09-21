import { getSettings, saveSettings, sanitizeFolder, DEFAULTS } from './settings.js';
import { listEnrollments, SessionExpiredError } from './echo360.js';
import { normalizeCourse, parseSectionId, removeCourse, upsertCourse } from './watchlist.js';
import {
  canPickFolder,
  chooseRoot,
  clearRoot,
  hasWriteAccess,
  readRoot
} from './folder-handle.js';

const fields = {
  maxHeight: { el: document.getElementById('maxHeight'), read: (el) => Number(el.value) },
  includeAudio: { el: document.getElementById('includeAudio'), read: (el) => el.checked },
  audioOnlyDefault: { el: document.getElementById('audioOnlyDefault'), read: (el) => el.checked },
  askEachTime: { el: document.getElementById('askEachTime'), read: (el) => el.checked },
  notifyOnDownload: { el: document.getElementById('notifyOnDownload'), read: (el) => el.checked },
  downloadFolder: {
    el: document.getElementById('downloadFolder'),
    read: (el) => sanitizeFolder(el.value)
  },
  filenameTemplate: {
    el: document.getElementById('filenameTemplate'),
    read: (el) => el.value.trim() || DEFAULTS.filenameTemplate
  },
  concurrency: {
    el: document.getElementById('concurrency'),
    read: (el) => Math.min(12, Math.max(1, Number(el.value) || DEFAULTS.concurrency))
  }
};

const rootName = document.getElementById('rootName');
const rootHint = document.getElementById('rootHint');
const rootButtons = {
  chooseRoot: document.getElementById('chooseRoot'),
  clearRoot: document.getElementById('clearRoot')
};

const rulesList = document.getElementById('rules');
const rulesEmpty = document.getElementById('rules-empty');
const ruleTemplate = document.getElementById('tpl-rule');
const saved = document.getElementById('saved');
let hideTimer;

function flashSaved() {
  saved.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    saved.hidden = true;
  }, 1600);
}

/** The folder fields only decide anything when Chrome is not asking for the location. */
function syncFolderEnabled() {
  const asking = fields.askEachTime.el.checked;
  fields.downloadFolder.el.disabled = asking;
  rootButtons.chooseRoot.disabled = asking || !canPickFolder();
}

/**
 * Shows which folder is in effect. A handle can outlive its permission — closing
 * Chrome is enough — so the name is only claimed while the write is still allowed.
 */
async function showRoot() {
  const root = await readRoot();
  const usable = await hasWriteAccess(root);

  rootName.textContent = usable ? root.name : 'Your Downloads folder';
  rootButtons.clearRoot.hidden = !root;
  rootButtons.chooseRoot.textContent = usable ? 'Change folder…' : 'Choose folder…';

  if (root && !usable) {
    rootHint.textContent = `Chrome has lost access to ${root.name}. Choose it again to reconnect.`;
  } else if (usable) {
    rootHint.textContent = 'Downloads go straight here, with no save dialog.';
  } else {
    rootHint.textContent = canPickFolder()
      ? 'Pick any folder on your computer. EchoFetch will keep saving there.'
      : 'This browser cannot open a folder picker, so files go to your Downloads folder.';
  }
}

function readRules() {
  return [...rulesList.querySelectorAll('.rule')]
    .map((row) => ({
      matchKind: row.querySelector('.rule-kind').value,
      match: row.querySelector('.rule-match').value.trim(),
      folder: sanitizeFolder(row.querySelector('.rule-folder').value)
    }))
    // A half-typed rule is kept on screen but never stored: an empty needle would
    // otherwise match every lecture the moment it was saved.
    .filter((rule) => rule.match && rule.folder);
}

async function persistRules() {
  rulesEmpty.hidden = rulesList.children.length > 0;
  await saveSettings({ folderRules: readRules() });
  flashSaved();
}

function addRule(rule = { matchKind: 'title', match: '', folder: '' }) {
  const row = ruleTemplate.content.cloneNode(true).firstElementChild;
  row.querySelector('.rule-kind').value = rule.matchKind === 'url' ? 'url' : 'title';
  row.querySelector('.rule-match').value = rule.match;
  row.querySelector('.rule-folder').value = rule.folder;

  row.querySelector('.rule-folder').addEventListener('change', (event) => {
    event.target.value = sanitizeFolder(event.target.value);
  });
  row.addEventListener('change', persistRules);
  row.querySelector('.remove').addEventListener('click', () => {
    row.remove();
    persistRules();
  });

  rulesList.append(row);
  rulesEmpty.hidden = true;
  return row;
}


// --- Watched courses ---------------------------------------------------------------

const coursesList = document.getElementById('courses');
const coursesEmpty = document.getElementById('courses-empty');
const courseTemplate = document.getElementById('tpl-course');
const foundTemplate = document.getElementById('tpl-found');
const activityList = document.getElementById('activity');
const activityEmpty = document.getElementById('activity-empty');
const activityTemplate = document.getElementById('tpl-activity');
const courseUrl = document.getElementById('courseUrl');
const addHint = document.getElementById('addHint');
const findHint = document.getElementById('findHint');

// Every Echo360 host the extension already holds permission for. Which one an
// institution uses is not knowable ahead of time, so the enrolment lookup asks all of
// them and keeps whichever answers with a session.
const ECHO_HOSTS = ['echo360.ca', 'echo360.org', 'echo360.org.uk', 'echo360.net.au', 'echo360.org.au'];

const send = (message) => chrome.runtime.sendMessage(message);
const ago = (timestamp) => {
  if (!timestamp) return 'not yet';
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

function describeCourse(course, state, entries) {
  if (!course.enabled) return 'Not being checked.';
  if (state?.paused) {
    return `Checking stopped: ${state.lastError || 'too many failures'}.`;
  }
  const waiting = entries.filter((entry) => entry.state === 'queued').length;
  const done = entries.filter((entry) => entry.state === 'done').length;
  const failed = entries.filter((entry) => entry.state === 'failed').length;

  return [
    `Checked ${ago(state?.lastCheckedAt)}`,
    `${done} downloaded`,
    waiting ? `${waiting} waiting` : null,
    failed ? `${failed} failed` : null,
    state?.lastError && !state.paused ? state.lastError : null
  ]
    .filter(Boolean)
    .join(' · ');
}

async function persistCourses(courses) {
  await saveSettings({ courses });
  flashSaved();
}

function renderCourse(course, state, entries, courses) {
  const row = courseTemplate.content.cloneNode(true).firstElementChild;
  row.querySelector('[data-label]').textContent =
    course.label || course.sectionId.slice(0, 8);
  row.querySelector('.course-toggle').checked = course.enabled;
  row.querySelector('.course-folder').value = course.folder;
  row.querySelector('.course-quality').value = course.maxHeight ? String(course.maxHeight) : '';
  row.querySelector('.course-poll').value = String(course.pollMinutes);
  row.querySelector('.course-transcript').checked = course.transcript;
  row.querySelector('[data-status]').textContent = describeCourse(course, state, entries);

  const resume = row.querySelector('[data-resume]');
  resume.hidden = !state?.paused;
  resume.addEventListener('click', async () => {
    await send({ type: 'resumeCourse', sectionId: course.sectionId });
    await showCourses();
  });

  const read = () => ({
    sectionId: course.sectionId,
    enabled: row.querySelector('.course-toggle').checked,
    folder: sanitizeFolder(row.querySelector('.course-folder').value),
    maxHeight: row.querySelector('.course-quality').value || null,
    pollMinutes: Number(row.querySelector('.course-poll').value),
    transcript: row.querySelector('.course-transcript').checked
  });

  row.addEventListener('change', async () => {
    const patch = read();
    row.querySelector('.course-folder').value = patch.folder;
    await persistCourses(upsertCourse(courses, patch));
  });

  row.querySelector('[data-remove]').addEventListener('click', async () => {
    await persistCourses(removeCourse(courses, course.sectionId));
    await send({ type: 'unwatchCourse', sectionId: course.sectionId });
    await showCourses();
  });

  return row;
}

function renderActivity(entries) {
  activityList.replaceChildren();
  const recent = entries
    .filter((entry) => entry.state !== 'queued' || entry.attempts)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);

  for (const entry of recent) {
    const row = activityTemplate.content.cloneNode(true).firstElementChild;
    row.querySelector('[data-title]').textContent = entry.title;
    row.querySelector('[data-detail]').textContent = {
      done: entry.savedTo ? `Saved to ${entry.savedTo} · ${ago(entry.updatedAt)}` : `Downloaded ${ago(entry.updatedAt)}`,
      downloading: 'Downloading now',
      failed: `Gave up: ${entry.lastError}`,
      skipped: `Skipped: ${entry.reason || 'not available'}`,
      queued: entry.lastError || 'Waiting'
    }[entry.state] || entry.state;

    const forget = row.querySelector('[data-forget]');
    forget.hidden = entry.state !== 'done' && entry.state !== 'skipped';
    forget.addEventListener('click', async () => {
      await send({ type: 'forgetLecture', key: entry.key });
      await showCourses();
    });

    activityList.append(row);
  }
  activityEmpty.hidden = recent.length > 0;
}

async function showCourses() {
  const { ledger = {}, states = {}, courses = [] } = (await send({ type: 'getWatchState' })) || {};
  const entries = Object.values(ledger);

  coursesList.replaceChildren();
  for (const course of courses) {
    coursesList.append(
      renderCourse(
        course,
        states[course.sectionId],
        entries.filter((entry) => entry.sectionId === course.sectionId),
        courses
      )
    );
  }
  coursesEmpty.hidden = courses.length > 0;
  renderActivity(entries);
}

async function watchCourse(course) {
  // First await, so Chrome still counts the click as a user gesture. Echo360 serves
  // media from CDN domains that cannot be listed ahead of time, and a download running
  // with nobody watching has no way to ask for one.
  const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
  if (!granted) {
    findHint.textContent =
      'Without permission to read the media hosts, automatic downloads will fail. Try again to grant it.';
    return;
  }

  await send({ type: 'watchCourse', course });
  await showCourses();
}

/** Asks every known Echo360 host and keeps the first that answers with a session. */
async function findCourses() {
  findHint.textContent = 'Looking…';
  const attempts = await Promise.all(
    ECHO_HOSTS.map(async (host) => {
      try {
        return { host, sections: await listEnrollments(host, { attempts: 1 }) };
      } catch (error) {
        return { host, sections: [], expired: error instanceof SessionExpiredError };
      }
    })
  );

  const hit = attempts.find((attempt) => attempt.sections.length);
  if (!hit) {
    findHint.textContent = attempts.some((attempt) => attempt.expired)
      ? 'Echo360 signed you out. Open it, sign in, and try again.'
      : 'No enrolled courses came back. Paste the course address instead.';
    return;
  }

  const { courses = [] } = (await send({ type: 'getWatchState' })) || {};
  const watched = new Set(courses.map((course) => course.sectionId));
  const unwatched = hit.sections.filter((section) => !watched.has(section.sectionId));

  findHint.textContent = unwatched.length
    ? `${unwatched.length} from ${hit.host}.`
    : `Everything from ${hit.host} is already watched.`;

  for (const section of unwatched) {
    const row = foundTemplate.content.cloneNode(true).firstElementChild;
    const label = [section.courseCode, section.courseName].filter(Boolean).join(' — ');
    row.querySelector('[data-label]').textContent = label || section.sectionId;
    row.querySelector('[data-watch]').addEventListener('click', () =>
      watchCourse({ sectionId: section.sectionId, host: hit.host, label })
    );
    coursesList.append(row);
  }
  coursesEmpty.hidden = true;
}

function initWatcher() {
  document.getElementById('findCourses').addEventListener('click', () => {
    findCourses().catch((error) => {
      findHint.textContent = `Could not read your courses: ${error.message}`;
    });
  });

  document.getElementById('addCourse').addEventListener('click', async () => {
    const parsed = parseSectionId(courseUrl.value);
    if (!parsed) {
      addHint.textContent = 'That is not a course address — it should contain /section/.';
      return;
    }
    await watchCourse(normalizeCourse({ ...parsed, label: '' }));
    courseUrl.value = '';
    addHint.textContent = 'Watching. It will be checked within a few minutes.';
  });

  // The watcher writes its ledger from the service worker, so the page has to follow
  // that rather than its own actions — otherwise a download that finished while this
  // tab was open would never show up without a reload.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.watch) showCourses();
    if (areaName === 'sync' && changes.settings) showCourses();
  });

  return showCourses();
}

async function init() {
  const settings = await getSettings();

  fields.maxHeight.el.value = String(settings.maxHeight);
  fields.includeAudio.el.checked = settings.includeAudio;
  fields.audioOnlyDefault.el.checked = settings.audioOnlyDefault;
  fields.askEachTime.el.checked = settings.askEachTime;
  fields.notifyOnDownload.el.checked = settings.notifyOnDownload;
  fields.downloadFolder.el.value = settings.downloadFolder;
  fields.filenameTemplate.el.value = settings.filenameTemplate;
  fields.concurrency.el.value = String(settings.concurrency);

  settings.folderRules.forEach((rule) => addRule(rule));
  rulesEmpty.hidden = settings.folderRules.length > 0;
  await showRoot();
  syncFolderEnabled();

  for (const [key, field] of Object.entries(fields)) {
    field.el.addEventListener('change', async () => {
      const value = field.read(field.el);
      // Write the coerced value back so a clamped, emptied, or sanitized input shows
      // what was actually stored.
      if (typeof value === 'string' || key === 'concurrency') field.el.value = String(value);
      if (key === 'askEachTime') syncFolderEnabled();
      await saveSettings({ [key]: value });
      flashSaved();
    });
  }

  rootButtons.chooseRoot.addEventListener('click', async () => {
    try {
      if (await chooseRoot()) flashSaved();
    } catch (error) {
      rootHint.textContent = `Could not open the folder picker: ${error.message}`;
    }
    await showRoot();
  });

  rootButtons.clearRoot.addEventListener('click', async () => {
    await clearRoot();
    await showRoot();
    flashSaved();
  });

  document.getElementById('add-rule').addEventListener('click', () => {
    addRule().querySelector('.rule-match').focus();
  });

  await initWatcher();
}

init();

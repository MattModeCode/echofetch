import { getSettings, saveSettings, sanitizeFolder, DEFAULTS } from './settings.js';

const fields = {
  maxHeight: { el: document.getElementById('maxHeight'), read: (el) => Number(el.value) },
  includeAudio: { el: document.getElementById('includeAudio'), read: (el) => el.checked },
  audioOnlyDefault: { el: document.getElementById('audioOnlyDefault'), read: (el) => el.checked },
  askEachTime: { el: document.getElementById('askEachTime'), read: (el) => el.checked },
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

/** The folder field only decides anything when Chrome is not asking for the location. */
function syncFolderEnabled() {
  fields.downloadFolder.el.disabled = fields.askEachTime.el.checked;
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

async function init() {
  const settings = await getSettings();

  fields.maxHeight.el.value = String(settings.maxHeight);
  fields.includeAudio.el.checked = settings.includeAudio;
  fields.audioOnlyDefault.el.checked = settings.audioOnlyDefault;
  fields.askEachTime.el.checked = settings.askEachTime;
  fields.downloadFolder.el.value = settings.downloadFolder;
  fields.filenameTemplate.el.value = settings.filenameTemplate;
  fields.concurrency.el.value = String(settings.concurrency);

  settings.folderRules.forEach((rule) => addRule(rule));
  rulesEmpty.hidden = settings.folderRules.length > 0;
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

  document.getElementById('add-rule').addEventListener('click', () => {
    addRule().querySelector('.rule-match').focus();
  });
}

init();

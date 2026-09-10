import { getSettings, saveSettings, DEFAULTS } from './settings.js';

const fields = {
  maxHeight: { el: document.getElementById('maxHeight'), read: (el) => Number(el.value) },
  audioOnlyDefault: { el: document.getElementById('audioOnlyDefault'), read: (el) => el.checked },
  filenameTemplate: {
    el: document.getElementById('filenameTemplate'),
    read: (el) => el.value.trim() || DEFAULTS.filenameTemplate
  },
  concurrency: {
    el: document.getElementById('concurrency'),
    read: (el) => Math.min(12, Math.max(1, Number(el.value) || DEFAULTS.concurrency))
  }
};

const saved = document.getElementById('saved');
let hideTimer;

function flashSaved() {
  saved.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    saved.hidden = true;
  }, 1600);
}

async function init() {
  const settings = await getSettings();

  fields.maxHeight.el.value = String(settings.maxHeight);
  fields.audioOnlyDefault.el.checked = settings.audioOnlyDefault;
  fields.filenameTemplate.el.value = settings.filenameTemplate;
  fields.concurrency.el.value = String(settings.concurrency);

  for (const [key, field] of Object.entries(fields)) {
    field.el.addEventListener('change', async () => {
      const value = field.read(field.el);
      // Write the coerced value back so a clamped or emptied input shows what was stored.
      if (key === 'concurrency') field.el.value = String(value);
      if (key === 'filenameTemplate') field.el.value = value;
      await saveSettings({ [key]: value });
      flashSaved();
    });
  }
}

init();

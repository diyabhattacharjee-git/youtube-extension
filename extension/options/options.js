/** Options page: every field id matches a key in DEFAULT_SETTINGS and autosaves. */
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
let savedTimer;

async function init() {
  const settings = await getSettings();
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const input = $(key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!settings[key];
    else input.value = settings[key];
    input.addEventListener('change', () => save(key, input));
  }
  $('test').addEventListener('click', testBackend);
  testBackend();
}

async function save(key, input) {
  let value = input.type === 'checkbox' ? input.checked : input.value.trim();
  if (key === 'backendUrl') {
    value = value.replace(/\/+$/, '') || DEFAULT_SETTINGS.backendUrl;
    const url = new URL(value);
    const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname);
    // Remote backends need an extra host permission (requested only when used).
    if (!isLocal) {
      const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
      if (!granted) {
        $('health').textContent = 'Permission for that host was not granted.';
        $('health').className = 'hint bad';
        return;
      }
    }
  }
  await saveSettings({ [key]: value });
  $('saved').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').hidden = true), 1400);
  if (key === 'backendUrl') testBackend();
}

async function testBackend() {
  const base = ($('backendUrl').value || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, '');
  const out = $('health');
  out.textContent = 'Checking…';
  out.className = 'hint';
  try {
    const h = await (await fetch(`${base}/api/health`)).json();
    out.className = 'hint ok';
    out.textContent = `✓ Online — LLM: ${h.llm} · embeddings: ${h.embeddings} · Whisper: ${h.whisper ? 'yes' : 'no'} · keyframes: ${h.keyframes ? 'yes' : 'no'} · Notion: ${h.notion ? 'yes' : 'no'}`;
    $('serverKeyframes').disabled = !h.keyframes;
    $('allowWhisper').disabled = !h.whisper;
  } catch {
    out.className = 'hint bad';
    out.textContent = `✗ Cannot reach ${base}. Start the backend: cd backend && python -m app.main`;
  }
}

init();

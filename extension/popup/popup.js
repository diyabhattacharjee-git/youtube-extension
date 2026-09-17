/** Toolbar popup: generate for the active video (or any URL) with mode/profile choices. */
import { getSettings, parseVideoId, saveSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);

async function init() {
  const settings = await getSettings();
  $('mode').value = settings.mode;
  $('profile').value = settings.profile;
  $('mode').addEventListener('change', (e) => saveSettings({ mode: e.target.value }));
  $('profile').addEventListener('change', (e) => saveSettings({ profile: e.target.value }));

  // backend status
  fetch(`${settings.backendUrl.replace(/\/+$/, '')}/api/health`)
    .then((r) => r.json())
    .then((h) => {
      $('status').classList.add('online');
      $('status').title = `Backend online · LLM: ${h.llm}`;
      if (!h.groq) $('hint').textContent = 'Tip: add GROQ_API_KEY to .env for LLM-quality nodes.';
    })
    .catch(() => {
      $('status').title = 'Backend offline';
      $('hint').textContent = `Backend offline at ${settings.backendUrl} — start it with "python -m app.main".`;
    });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = parseVideoId(tab?.url);
  if (videoId) {
    $('video-card').hidden = false;
    $('video-thumb').src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    $('video-title').textContent = (tab.title || '').replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
    $('video-channel').textContent = 'Current tab';
    $('generate').disabled = false;
  } else {
    $('generate').textContent = '🧠 Open a YouTube video first';
  }

  $('generate').addEventListener('click', async () => {
    $('generate').disabled = true;
    $('generate').textContent = '✍️ Reading the video…';
    try {
      // The content script scrapes transcript/chapters, then asks the service worker to open the viewer.
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'TM_COLLECT_CONTEXT' });
      if (!res?.ok) throw new Error(res?.error || 'no response');
      await chrome.runtime.sendMessage({ type: 'TM_GENERATE', context: res.context });
    } catch {
      // Content script missing (tab opened before install): let the backend fetch everything.
      await chrome.runtime.sendMessage({ type: 'TM_GENERATE', context: { videoId, title: $('video-title').textContent } });
    }
    window.close();
  });

  const fromUrl = async () => {
    const id = parseVideoId($('url').value);
    if (!id) {
      $('hint').textContent = 'That does not look like a YouTube link.';
      return;
    }
    await chrome.runtime.sendMessage({ type: 'TM_OPEN_VIEWER', params: { url: $('url').value, mode: $('mode').value } });
    window.close();
  };
  $('generate-url').addEventListener('click', fromUrl);
  $('url').addEventListener('keydown', (e) => e.key === 'Enter' && fromUrl());

  const open = (params) => chrome.runtime.sendMessage({ type: 'TM_OPEN_VIEWER', params }).then(() => window.close());
  $('library').addEventListener('click', () => open({}));
  $('demo').addEventListener('click', () => open({ demo: '1' }));
  $('join').addEventListener('click', () => {
    const code = prompt('Room code');
    if (code) open({ room: code.trim() });
  });
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init();

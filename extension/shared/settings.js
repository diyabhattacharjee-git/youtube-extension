/**
 * Extension settings shared by the service worker, popup, options page and viewer.
 * Stored in chrome.storage.sync so they follow the user across browsers.
 * (No API keys live here — the Groq key stays in the backend's .env file.)
 */

export const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: 'http://127.0.0.1:8765',
  mode: 'revision', // revision (Short, exam revision) | academic (Standard) | deep (Detailed)
  theme: 'chalk', // chalk (Blackboard) | sketch | doodle
  layout: 'balanced', // balanced (clockwise, default) | right (logical tree) | radial
  useLLM: true, // one AI call per map to rewrite labels (the map itself is built from the transcript)
  prefetch: true, // prepare the map in the background while the video page is open (no AI)
  devMode: false, // show pipeline details, model names and demo data
  allowWhisper: true,
  serverKeyframes: false, // backend slide/chart extraction (needs opencv + yt-dlp)
  storyboardImages: true, // free thumbnails from YouTube storyboards
  switchToVideoOnJump: true,
  followAlong: true, // highlight the node matching the current playback time
  voiceLang: 'en-US',
  userId: '',
  userName: '',
  userColor: '#9d9cc4',
});

/** User-facing names for the summarization modes (internal values stay the same). */
export const MODE_LABELS = Object.freeze({ revision: 'Short', academic: 'Standard', deep: 'Detailed' });

const COLORS = ['#e8b7b1', '#9d9cc4', '#8fa878', '#d9b98a', '#7c4a5e', '#6aa6c9'];

/** Keys of features that no longer exist (the visual / balanced / text-heavy learning profiles). */
export const REMOVED_KEYS = Object.freeze(['profile', 'adaptiveProfile']);
const ALLOWED = { mode: ['revision', 'academic', 'deep'], theme: ['chalk', 'sketch', 'doodle'], layout: ['balanced', 'right', 'radial'] };

/**
 * Make settings stored by older versions safe: drop removed keys and reset any value that is
 * no longer offered. A saved valid choice (theme, layout, mode) wins.
 * Pure function: returns the clean settings plus what to remove / rewrite in storage.
 */
export function migrateSettings(stored = {}) {
  const clean = { ...stored };
  const remove = REMOVED_KEYS.filter((key) => key in clean);
  for (const key of remove) delete clean[key];
  const patch = {};
  for (const [key, values] of Object.entries(ALLOWED)) {
    if (key in clean && !(key in patch) && !values.includes(clean[key])) patch[key] = DEFAULT_SETTINGS[key];
  }
  return { settings: { ...DEFAULT_SETTINGS, ...clean, ...patch }, remove, patch };
}

export async function getSettings() {
  let stored = {};
  try {
    stored = (await chrome.storage.sync.get(null)) || {};
  } catch {
    /* storage unavailable: defaults */
  }
  const { settings, remove, patch } = migrateSettings(stored);
  if (remove.length) {
    chrome.storage.sync.remove(remove).catch?.(() => {});
    chrome.storage.local?.remove('tm-profile-signals').catch?.(() => {}); // counters of the removed adaptive profile
  }
  if (Object.keys(patch).length) chrome.storage.sync.set(patch).catch?.(() => {});
  if (!settings.userId) {
    settings.userId = crypto.randomUUID().slice(0, 12);
    settings.userColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    settings.userName = `Learner ${settings.userId.slice(0, 4).toUpperCase()}`;
    await chrome.storage.sync.set({
      userId: settings.userId,
      userColor: settings.userColor,
      userName: settings.userName,
    });
  }
  return settings;
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.newValue]));
    callback(patch);
  });
}

/** Parse a YouTube URL (watch, youtu.be, shorts, embed, live) or bare id. */
export function parseVideoId(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  const match = text.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Extension settings shared by the service worker, popup, options page and viewer.
 * Stored in chrome.storage.sync so they follow the user across browsers.
 * (No API keys live here — the Groq key stays in the backend's .env file.)
 */

export const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: 'http://127.0.0.1:8765',
  mode: 'academic', // academic | revision | deep  (context-aware summarization)
  profile: 'balanced', // visual | balanced | text  (adaptive learning profile)
  adaptiveProfile: true, // learn the profile from how the user interacts
  theme: 'sketch', // sketch | doodle | chalk
  layout: 'balanced', // balanced | radial | right
  useLLM: true,
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

const COLORS = ['#e8b7b1', '#9d9cc4', '#8fa878', '#d9b98a', '#7c4a5e', '#6aa6c9'];

export async function getSettings() {
  const stored = await chrome.storage.sync.get(null);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
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

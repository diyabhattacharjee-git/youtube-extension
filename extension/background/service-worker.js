/**
 * TubeMind service worker (Manifest V3).
 *
 * Responsibilities — deliberately small, because MV3 service workers are
 * short-lived and long pipelines run in the viewer page instead:
 *   • open the viewer tab for a generation request
 *   • prefetch: forward a video's context to the backend so its map is ready before the click
 *   • route timestamp jumps / frame captures to the right YouTube tab
 *   • context menus + keyboard command
 */
import { getSettings, parseVideoId } from '../shared/settings.js';

const VIEWER = 'viewer/viewer.html';

chrome.runtime.onInstalled.addListener(async () => {
  await getSettings(); // creates user id / defaults
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tm-page',
      title: 'Generate mindmap for this video',
      contexts: ['page'],
      documentUrlPatterns: ['https://www.youtube.com/watch*'],
    });
    chrome.contextMenus.create({
      id: 'tm-link',
      title: 'Generate mindmap for linked video',
      contexts: ['link'],
      targetUrlPatterns: ['https://www.youtube.com/watch*', 'https://youtu.be/*', 'https://www.youtube.com/shorts/*'],
    });
  }); 
});

/** Store the request in session storage (can be large: full transcript) and open the viewer. */
async function openViewerForRequest(context, openerTab) {
  const requestId = crypto.randomUUID();
  await chrome.storage.session.set({ [`req:${requestId}`]: { ...context, requestedAt: Date.now() } });
  const url = chrome.runtime.getURL(`${VIEWER}?req=${requestId}`);
  const tab = await chrome.tabs.create({ url, index: openerTab ? openerTab.index + 1 : undefined, openerTabId: openerTab?.id });
  return { requestId, tabId: tab.id };
}

/** Warm the backend cache for a video (map built from the transcript, no AI). Best effort. */
async function prefetch(context) {
  const settings = await getSettings();
  if (!settings.prefetch || !context?.videoId) return { ok: false };
  const { videoId, title, channel, description, duration, chapters, transcript, languages } = context;
  try {
    const res = await fetch(`${settings.backendUrl.replace(/\/+$/, '')}/api/prefetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, title, channel, description, duration, chapters, transcript, languages, mode: settings.mode }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, ...(res.ok ? await res.json() : {}) };
  } catch {
    return { ok: false };
  }
}

async function findVideoTabs(videoId) {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/watch*', 'https://m.youtube.com/watch*'] });
  return tabs.filter((t) => parseVideoId(t.url) === videoId);
}

async function seek(videoId, seconds) {
  const settings = await getSettings();
  const tabs = await findVideoTabs(videoId);
  const t = Math.max(0, Math.floor(seconds || 0));
  if (tabs.length) {
    const tab = tabs[0];
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TM_SEEK', seconds: t });
    } catch {
      // content script not injected yet (tab restored from session): reload at timestamp
      await chrome.tabs.update(tab.id, { url: `https://www.youtube.com/watch?v=${videoId}&t=${t}s` });
    }
    if (settings.switchToVideoOnJump) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return { ok: true, tabId: tab.id };
  }
  const created = await chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${videoId}&t=${t}s`,
    active: settings.switchToVideoOnJump,
  });
  return { ok: true, tabId: created.id, opened: true };
}

async function captureFrame(videoId) {
  const tabs = await findVideoTabs(videoId);
  if (!tabs.length) return { ok: false, error: 'Open the video in a tab to capture a frame.' };
  try {
    return await chrome.tabs.sendMessage(tabs[0].id, { type: 'TM_CAPTURE_FRAME' });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = async () => {
    switch (msg?.type) {
      case 'TM_GENERATE':
        return openViewerForRequest(msg.context, sender.tab);
      case 'TM_SEEK':
        return seek(msg.videoId, msg.seconds);
      case 'TM_CAPTURE':
        return captureFrame(msg.videoId);
      case 'TM_PREFETCH':
        return prefetch(msg.context);
      case 'TM_OPEN_VIEWER': {
        const query = new URLSearchParams(msg.params || {}).toString();
        await chrome.tabs.create({ url: chrome.runtime.getURL(`${VIEWER}${query ? `?${query}` : ''}`) });
        return { ok: true };
      }
      default:
        return undefined; // not for us (e.g. TM_TIMEUPDATE is consumed by viewer pages)
    }
  };
  const known = ['TM_GENERATE', 'TM_SEEK', 'TM_CAPTURE', 'TM_OPEN_VIEWER', 'TM_PREFETCH'];
  if (!known.includes(msg?.type)) return false;
  handle()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tm-page' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'TM_COLLECT_AND_GENERATE' }).catch(() => {
      const videoId = parseVideoId(tab.url);
      if (videoId) openViewerForRequest({ videoId, title: tab.title?.replace(/ - YouTube$/, '') }, tab);
    });
  }
  if (info.menuItemId === 'tm-link') {
    const videoId = parseVideoId(info.linkUrl);
    if (videoId) openViewerForRequest({ videoId, title: info.selectionText || '' }, tab);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'generate-mindmap') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && parseVideoId(tab.url)) {
    chrome.tabs.sendMessage(tab.id, { type: 'TM_COLLECT_AND_GENERATE' }).catch(() => {});
  }
});

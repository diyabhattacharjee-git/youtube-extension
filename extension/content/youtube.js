/**
 * TubeMind content script for youtube.com.
 *
 *  • Injects the "Mindmap" button next to the video.
 *  • Collects video context: title, channel, duration, description, chapters,
 *    storyboard spec and — when possible — the transcript, scraped the same way
 *    YouTube's own "Show transcript" panel does (innertube get_transcript), with
 *    the caption-track JSON as a second attempt. The backend has its own
 *    fallbacks (youtube-transcript-api → Whisper) if both fail.
 *  • Executes timestamp jumps and frame captures requested by the viewer.
 *  • Broadcasts playback time so the viewer can "follow along".
 *
 * Plain script (content scripts cannot be ES modules).
 */
(() => {
  if (window.__tubemindLoaded) return;
  window.__tubemindLoaded = true;

  const BUTTON_ID = 'tubemind-generate';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const currentVideoId = () => new URL(location.href).searchParams.get('v');

  /** Extract the JSON object assigned after `marker` in a script-bearing HTML string. */
  function extractJsonAfter(html, marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.indexOf('{', at);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  /** Depth-first search for every value stored under `key` inside a JSON tree. */
  function findAll(obj, key, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) {
      for (const item of obj) findAll(item, key, out);
      return out;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) out.push(v);
      if (v && typeof v === 'object') findAll(v, key, out);
    }
    return out;
  }

  const textOf = (node) => node?.simpleText ?? (node?.runs || []).map((r) => r.text).join('') ?? '';

  // ---------------------------------------------------------------------------
  // Context collection
  // ---------------------------------------------------------------------------
  async function fetchWatchPage(videoId) {
    // A fresh fetch avoids stale ytInitial* globals after SPA navigation.
    const res = await fetch(`/watch?v=${videoId}&hl=en`, { credentials: 'include' });
    const html = await res.text();
    return {
      player: extractJsonAfter(html, 'ytInitialPlayerResponse = ') || extractJsonAfter(html, 'ytInitialPlayerResponse='),
      data: extractJsonAfter(html, 'ytInitialData = ') || extractJsonAfter(html, 'ytInitialData='),
      cfg: {
        apiKey: html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1],
        clientVersion: html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20250101.00.00',
        visitorData: html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1],
      },
    };
  }

  async function transcriptFromInnertube(data, cfg) {
    const endpoint = findAll(data, 'getTranscriptEndpoint')[0];
    if (!endpoint?.params) return null;
    const url = `/youtubei/v1/get_transcript?prettyPrint=false${cfg.apiKey ? `&key=${cfg.apiKey}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-youtube-client-name': '1',
        'x-youtube-client-version': cfg.clientVersion,
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: cfg.clientVersion, hl: 'en', visitorData: cfg.visitorData } },
        params: endpoint.params,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const segments = findAll(json, 'transcriptSegmentRenderer')
      .map((s) => ({
        start: Number(s.startMs) / 1000,
        end: Number(s.endMs) / 1000,
        text: textOf(s.snippet),
      }))
      .filter((s) => s.text && s.text.trim() && Number.isFinite(s.start));
    return segments.length ? segments : null;
  }

  async function transcriptFromCaptionTrack(player) {
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return null;
    const pick =
      tracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') ||
      tracks.find((t) => t.languageCode?.startsWith('en')) ||
      tracks[0];
    const res = await fetch(`${pick.baseUrl}&fmt=json3`, { credentials: 'include' });
    const body = await res.text();
    if (!body) return null; // YouTube may require a PO token; the backend will try other routes
    const json = JSON.parse(body);
    const segments = (json.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        start: e.tStartMs / 1000,
        end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
        text: e.segs.map((s) => s.utf8).join('').replace(/\n/g, ' '),
      }))
      .filter((s) => s.text.trim());
    return segments.length ? { segments, language: pick.languageCode } : null;
  }

  function chaptersFrom(data) {
    const chapters = findAll(data, 'chapterRenderer').map((c) => ({
      title: textOf(c.title),
      start: Number(c.timeRangeStartMillis) / 1000,
    }));
    const unique = [];
    const seen = new Set();
    for (const c of chapters) {
      if (!seen.has(c.start) && c.title) {
        seen.add(c.start);
        unique.push(c);
      }
    }
    return unique.sort((a, b) => a.start - b.start);
  }

  async function collectContext() {
    const videoId = currentVideoId();
    if (!videoId) throw new Error('Not on a YouTube video page');
    const context = { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
    const notes = [];
    try {
      const { player, data, cfg } = await fetchWatchPage(videoId);
      const details = player?.videoDetails || {};
      Object.assign(context, {
        title: details.title || document.title.replace(/ - YouTube$/, ''),
        channel: details.author || '',
        duration: Number(details.lengthSeconds) || document.querySelector('video')?.duration || null,
        description: details.shortDescription || '',
        keywords: details.keywords || [],
        chapters: chaptersFrom(data),
        storyboardSpec: player?.storyboards?.playerStoryboardSpecRenderer?.spec || null,
      });
      try {
        context.transcript = await transcriptFromInnertube(data, cfg);
        if (context.transcript) context.transcriptSource = 'innertube';
      } catch (err) {
        notes.push(`innertube: ${err.message}`);
      }
      if (!context.transcript) {
        try {
          const track = await transcriptFromCaptionTrack(player);
          if (track) {
            context.transcript = track.segments;
            context.transcriptSource = 'caption-track';
            context.languages = [track.language];
          }
        } catch (err) {
          notes.push(`captions: ${err.message}`);
        }
      }
    } catch (err) {
      notes.push(`watch page: ${err.message}`);
      context.title = document.title.replace(/ - YouTube$/, '');
    }
    if (!context.chapters?.length) delete context.chapters;
    context.collectNotes = notes;
    return context;
  }

  async function generate() {
    const button = document.getElementById(BUTTON_ID);
    button?.classList.add('tm-busy');
    try {
      const context = await collectContext();
      await chrome.runtime.sendMessage({ type: 'TM_GENERATE', context });
    } catch (err) {
      alert(`TubeMind: ${err.message}`);
    } finally {
      button?.classList.remove('tm-busy');
    }
  }

  // ---------------------------------------------------------------------------
  // UI: the hand-drawn "Mindmap" button
  // ---------------------------------------------------------------------------
  function injectButton() {
    if (!currentVideoId() || document.getElementById(BUTTON_ID)) return;
    const anchor =
      document.querySelector('ytd-watch-metadata #top-level-buttons-computed') ||
      document.querySelector('ytd-watch-metadata #actions-inner') ||
      document.querySelector('#above-the-fold #title');
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'Generate an interactive mindmap (Alt+M)';
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <circle cx="12" cy="12" r="3.2"/><path d="M9.3 10.2 5 6.5M14.7 10.2 19 6.5M9.3 13.8 5 17.5M14.7 13.8 19 17.5"/>
        <circle cx="4" cy="5.5" r="1.6"/><circle cx="20" cy="5.5" r="1.6"/><circle cx="4" cy="18.5" r="1.6"/><circle cx="20" cy="18.5" r="1.6"/></g></svg>
      <span>Mindmap</span>`;
    button.addEventListener('click', generate);
    if (anchor) {
      anchor.prepend(button);
    } else {
      button.classList.add('tm-floating');
      document.body.appendChild(button);
    }
  }

  const refresh = () => {
    document.getElementById(BUTTON_ID)?.remove();
    setTimeout(injectButton, 800);
  };
  document.addEventListener('yt-navigate-finish', refresh);
  injectButton();
  // The metadata area renders late; keep trying for a few seconds.
  let tries = 0;
  const retry = setInterval(() => {
    injectButton();
    if (++tries > 15) clearInterval(retry);
  }, 1000);

  // ---------------------------------------------------------------------------
  // Messages from the viewer / service worker
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const video = document.querySelector('video');
    switch (msg?.type) {
      case 'TM_SEEK':
        if (video) {
          video.currentTime = msg.seconds;
          video.play().catch(() => {});
          flashSeek(msg.seconds);
        }
        sendResponse({ ok: !!video });
        return false;
      case 'TM_CAPTURE_FRAME':
        sendResponse(captureFrame(video));
        return false;
      case 'TM_GET_TIME':
        sendResponse({ ok: !!video, t: video?.currentTime ?? 0, videoId: currentVideoId() });
        return false;
      case 'TM_COLLECT_AND_GENERATE':
        generate();
        sendResponse({ ok: true });
        return false;
      case 'TM_COLLECT_CONTEXT':
        collectContext()
          .then((context) => sendResponse({ ok: true, context }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      default:
        return false;
    }
  });

  function captureFrame(video) {
    if (!video || !video.videoWidth) return { ok: false, error: 'No playing video found' };
    try {
      const scale = Math.min(1, 640 / video.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return { ok: true, dataUrl: canvas.toDataURL('image/jpeg', 0.82), t: video.currentTime };
    } catch (err) {
      return { ok: false, error: `Frame capture blocked: ${err.message}` };
    }
  }

  function flashSeek(seconds) {
    const tag = document.createElement('div');
    tag.className = 'tm-seek-flash';
    const m = Math.floor(seconds / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, '0');
    tag.textContent = `🧠 jumped to ${m}:${s}`;
    (document.querySelector('#movie_player') || document.body).appendChild(tag);
    setTimeout(() => tag.remove(), 1800);
  }

  // Follow-along: broadcast playback time to open viewer pages every 2 s while playing.
  setInterval(() => {
    const video = document.querySelector('video');
    const videoId = currentVideoId();
    if (!video || !videoId || video.paused || !chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'TM_TIMEUPDATE', videoId, t: video.currentTime }).catch(() => {});
  }, 2000);
})();

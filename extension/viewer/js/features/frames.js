/**
 * Multimodal layer (client side): embed video visuals into nodes.
 *
 *  • Storyboard frames — YouTube publishes sprite sheets of thumbnails for seeking
 *    previews. We crop the frame for a node's timestamp: free, instant, no download,
 *    and it never interrupts playback.
 *  • Capture current frame — grabs the exact frame playing in the YouTube tab at
 *    full resolution (great for slides, charts, whiteboards).
 *  • Upload — any local image.
 * (Server-side slide/chart detection lives in backend/app/pipeline/multimodal.py.)
 */

const sheetCache = new Map();

/** Parse `playerStoryboardSpecRenderer.spec` → levels with URL builders. */
export function parseStoryboard(spec, duration) {
  if (!spec) return null;
  const parts = spec.split('|');
  const base = parts[0];
  const levels = parts.slice(1).map((part, i) => {
    const [w, h, count, cols, rows, interval, name, sigh] = part.split('#');
    const n = Number(count);
    return {
      level: i,
      w: Number(w),
      h: Number(h),
      count: n,
      cols: Number(cols),
      rows: Number(rows),
      interval: Number(interval) || (duration ? (duration * 1000) / Math.max(n, 1) : 0),
      urlFor: (sheet) => {
        const file = name.includes('$M') ? name.replace('$M', String(sheet)) : name;
        const url = base.replace('$L', String(i)).replace('$N', file);
        return sigh ? `${url}${url.includes('?') ? '&' : '?'}sigh=${sigh}` : url;
      },
    };
  });
  return levels.filter((l) => l.w && l.h && l.cols && l.rows && l.interval);
}

async function loadSheet(url) {
  if (!sheetCache.has(url)) {
    sheetCache.set(
      url,
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`storyboard HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) => createImageBitmap(blob)),
    );
  }
  return sheetCache.get(url);
}

/** Data URL of the storyboard thumbnail closest to `seconds` (highest available quality). */
export async function storyboardFrame(spec, duration, seconds) {
  const levels = parseStoryboard(spec, duration);
  if (!levels?.length) throw new Error('This video has no storyboard');
  const level = levels[levels.length - 1];
  const perSheet = level.cols * level.rows;
  const index = Math.min(level.count - 1, Math.max(0, Math.floor((seconds * 1000) / level.interval)));
  const sheet = Math.floor(index / perSheet);
  const local = index % perSheet;
  const bitmap = await loadSheet(level.urlFor(sheet));
  const cellW = bitmap.width / level.cols;
  const cellH = bitmap.height / level.rows;
  const canvas = new OffscreenCanvas(Math.round(cellW), Math.round(cellH));
  canvas.getContext('2d').drawImage(bitmap, (local % level.cols) * cellW, Math.floor(local / level.cols) * cellH, cellW, cellH, 0, 0, cellW, cellH);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return blobToDataUrl(blob);
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Attach storyboard frames to section (and optionally concept) nodes that have no image yet. */
export async function attachStoryboardFrames(model, { includeConcepts = false, onProgress } = {}) {
  const { storyboardSpec, duration } = model.meta || {};
  if (!storyboardSpec) return 0;
  const targets = [];
  model.walk((node) => {
    const wanted = node.type === 'section' || (includeConcepts && node.type === 'concept');
    if (wanted && !node.image && node.start !== null && node.start !== undefined) targets.push(node);
  });
  const ops = [];
  let done = 0;
  for (const node of targets) {
    try {
      // a couple of seconds in usually skips transition frames
      const t = Math.min((node.start || 0) + 3, (duration || node.start + 3) - 1);
      const src = await storyboardFrame(storyboardSpec, duration, t);
      ops.push({ type: 'update', id: node.id, patch: { image: { src, t, source: 'storyboard' } } });
    } catch {
      break; // spec expired or blocked: stop quietly
    }
    onProgress?.(++done, targets.length);
  }
  if (ops.length) model.apply(ops, { origin: 'ai', record: false });
  return ops.length;
}

export async function captureCurrentFrame(videoId) {
  const res = await chrome.runtime.sendMessage({ type: 'TM_CAPTURE', videoId });
  if (!res?.ok) throw new Error(res?.error || 'Could not capture frame');
  return { src: res.dataUrl, t: res.t, source: 'capture' };
}

export function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 640 / bitmap.width);
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      resolve({ src: await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })), source: 'upload' });
    };
    input.click();
  });
}

/** Ask the YouTube tab for the current playback time (for "set timestamp to now"). */
export async function currentVideoTime(videoId) {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/watch*'] });
  const tab = tabs.find((t) => new URL(t.url).searchParams.get('v') === videoId);
  if (!tab) return null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'TM_GET_TIME' });
    return res?.ok ? res.t : null;
  } catch {
    return null;
  }
}

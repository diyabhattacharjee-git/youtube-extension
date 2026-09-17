/** Tiny DOM + formatting helpers (no framework). */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** el('button', {class: 'x', onclick}, 'text' | Node | [children]) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function fmtTime(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const uid = (prefix = 'n') => `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export const clone = (value) => structuredClone(value);

export const plain = (text) => String(text || '').replace(/^[“"]|[”"]$/g, '').trim();

/** Deterministic PRNG (mulberry32) so hand-drawn wobble is stable between renders. */
export function seededRandom(seed) {
  let a = typeof seed === 'number' ? seed : hashString(String(seed));
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function download(content, filename, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function slugify(text) {
  return (
    String(text || 'mindmap')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'mindmap'
  );
}

/** Hand-drawn toast notifications. */
export function toast(message, { type = 'info', timeout = 3200, action } = {}) {
  let host = $('#toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const item = el('div', { class: `toast toast-${type}`, role: 'status' }, [el('span', {}, message)]);
  if (action) {
    item.append(
      el('button', {
        class: 'btn btn-small',
        onclick: () => {
          action.run();
          item.remove();
        },
      }, action.label),
    );
  }
  host.append(item);
  setTimeout(() => item.classList.add('out'), timeout);
  setTimeout(() => item.remove(), timeout + 400);
  return item;
}

/** Simple modal dialog built on <dialog>. Returns {dialog, body, close}. */
export function modal(title, { wide = false, onClose } = {}) {
  const body = el('div', { class: 'modal-body' });
  const dialog = el('dialog', { class: `modal ${wide ? 'modal-wide' : ''}` }, [
    el('header', { class: 'modal-head' }, [
      el('h2', {}, title),
      el('button', { class: 'icon-btn', title: 'Close', onclick: () => close() }, '✕'),
    ]),
    body,
  ]);
  const close = () => {
    dialog.close();
    dialog.remove();
    onClose?.();
  };
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, close };
}

/** Fuzzy score of `query` against `text` (0..1). */
export function fuzzyScore(query, text) {
  const q = String(query || '').toLowerCase().trim();
  const t = plain(text).toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 1;
  if (t.includes(q)) return 0.85 - Math.min(0.3, (t.length - q.length) / 400);
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return 0;
  const hits = words.filter((w) => t.includes(w)).length;
  return (hits / words.length) * 0.7;
}

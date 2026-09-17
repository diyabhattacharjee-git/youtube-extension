/** Re-exports + small helpers shared by feature modules. */
export { el, fmtTime, fuzzyScore, modal, plain, toast, uid } from '../lib/util.js';

export function truncateText(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;: ]+$/, '')}…`;
}

export const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

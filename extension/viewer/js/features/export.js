/**
 * Export & "Knowledge export to other tools".
 *   JSON      lossless TubeMind document (re-importable)
 *   PNG / SVG hand-drawn image with embedded fonts
 *   Markdown  nested outline with ▶ timestamp links
 *   Obsidian  frontmatter + [[wikilinks]] + callouts + related:: links
 *   Roam      Roam Research JSON import format
 *   Notion    Markdown that Notion imports cleanly, or direct push via backend API
 *   OPML      opens in XMind, MindNode, Logseq, Workflowy, OmniOutliner…
 */
import { GOOGLE_FONTS_URL } from '../mindmap/themes.js';
import { download, fmtTime, plain, slugify, toast } from '../lib/util.js';

const tsUrl = (map, node) => {
  const videoId = node.videoId || map.meta?.videoId;
  return videoId && node.start !== null && node.start !== undefined ? `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(node.start)}s` : null;
};

const fileBase = (map) => slugify(map.meta?.title || map.root?.text);

export function exportJSON(map) {
  download(JSON.stringify(map, null, 2), `${fileBase(map)}.tubemind.json`, 'application/json');
}

// ---------------------------------------------------------------------------
export function toMarkdown(map, { flavor = 'markdown' } = {}) {
  const lines = [];
  const meta = map.meta || {};
  const title = plain(meta.title || map.root.text);
  const obsidian = flavor === 'obsidian';

  if (obsidian) {
    lines.push('---', `title: "${title.replace(/"/g, "'")}"`);
    if (meta.url) lines.push(`source: ${meta.url}`);
    if (meta.channel) lines.push(`channel: "${meta.channel.replace(/"/g, "'")}"`);
    lines.push(`created: ${new Date(meta.createdAt || Date.now()).toISOString().slice(0, 10)}`);
    lines.push(`tags: [tubemind, mindmap${(map.root.tone || []).map((t) => `, tone/${t}`).join('')}]`, '---', '');
  }

  lines.push(`# ${plain(map.root.text)}`, '');
  if (meta.url) lines.push(`> 🎬 [${title}](${meta.url})${meta.channel ? ` — ${meta.channel}` : ''}`, '');
  if (map.root.summary) lines.push(map.root.summary, '');

  const label = (node) => {
    const text = plain(node.text);
    if (!obsidian || !['concept', 'section'].includes(node.type)) return text;
    const term = text.includes(':') ? text.split(':')[0].trim() : text;
    return text.includes(':') ? `[[${term}]]:${text.slice(text.indexOf(':') + 1)}` : `[[${term}]]`;
  };

  const writeNode = (node, depth) => {
    const url = tsUrl(map, node);
    const ts = url ? ` [▶ ${fmtTime(node.start)}](${url})` : '';
    const tone = node.tone?.length ? ` \`${node.tone.join('` `')}\`` : '';
    if (node.type === 'section') {
      lines.push(`## ${label(node)}${ts}${tone}`);
      if (node.summary) lines.push('', `*${node.summary}*`);
      lines.push('');
    } else {
      const indent = '  '.repeat(Math.max(0, depth - 2));
      const text = node.type === 'transcript' ? `*${label(node)}*` : label(node);
      lines.push(`${indent}- ${text}${ts}`);
      if (node.summary && node.type !== 'transcript') lines.push(`${indent}  - ${node.summary}`);
    }
    const indent = '  '.repeat(Math.max(0, depth - 1));
    if (node.image?.src && !node.image.src.startsWith('data:')) lines.push(`${indent}  ![](${node.image.src})`);
    if (node.notes) {
      if (obsidian) lines.push(`${indent}  > [!note] My note`, ...node.notes.split('\n').map((l) => `${indent}  > ${l}`));
      else lines.push(...node.notes.split('\n').map((l) => `${indent}  > ${l}`));
    }
    for (const link of node.links || []) lines.push(`${indent}  - 🔗 [${link.title || link.url}](${link.url})`);
    for (const child of node.children || []) writeNode(child, depth + 1);
    if (node.type === 'section') lines.push('');
  };
  for (const section of map.root.children || []) writeNode(section, 1);

  if (map.edges?.length) {
    const byId = new Map();
    const index = (n) => {
      byId.set(n.id, n);
      (n.children || []).forEach(index);
    };
    index(map.root);
    lines.push('## Connections', '');
    for (const edge of map.edges) {
      const a = byId.get(edge.source);
      const b = byId.get(edge.target);
      if (!a || !b) continue;
      const an = plain(a.text).split(':')[0];
      const bn = plain(b.text).split(':')[0];
      lines.push(obsidian ? `- [[${an}]] — ${edge.label} → related:: [[${bn}]]` : `- **${an}** — ${edge.label} → **${bn}**`);
    }
    lines.push('');
  }
  lines.push('', `<sub>Generated with TubeMind · ${meta.mode || ''} mode · ${meta.llm || ''}</sub>`);
  return lines.join('\n');
}

export function toRoam(map) {
  const convert = (node) => {
    const url = tsUrl(map, node);
    const string = `${node.type === 'concept' ? `[[${plain(node.text).split(':')[0]}]]${plain(node.text).includes(':') ? `:${plain(node.text).split(':').slice(1).join(':')}` : ''}` : plain(node.text)}${url ? ` [▶ ${fmtTime(node.start)}](${url})` : ''}`;
    const children = [];
    if (node.summary) children.push({ string: node.summary });
    if (node.notes) children.push({ string: `Note:: ${node.notes}` });
    for (const link of node.links || []) children.push({ string: `[${link.title || link.url}](${link.url})` });
    children.push(...(node.children || []).map(convert));
    return children.length ? { string, children } : { string };
  };
  return JSON.stringify(
    [
      {
        title: plain(map.meta?.title || map.root.text),
        children: [
          ...(map.meta?.url ? [{ string: `Source:: ${map.meta.url}` }] : []),
          ...(map.root.summary ? [{ string: map.root.summary }] : []),
          ...(map.root.children || []).map(convert),
        ],
      },
    ],
    null,
    2,
  );
}

export function toOPML(map) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const outline = (node, depth) => {
    const url = tsUrl(map, node);
    const attrs = `text="${esc(plain(node.text))}"${node.notes || node.summary ? ` _note="${esc([node.summary, node.notes].filter(Boolean).join('\n'))}"` : ''}${url ? ` url="${esc(url)}"` : ''}`;
    const kids = (node.children || []).map((c) => outline(c, depth + 1)).join('');
    const pad = '  '.repeat(depth);
    return kids ? `${pad}<outline ${attrs}>\n${kids}${pad}</outline>\n` : `${pad}<outline ${attrs}/>\n`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>${esc(map.meta?.title)}</title></head>\n<body>\n${outline(map.root, 1)}</body>\n</opml>\n`;
}

// ---------------------------------------------------------------------------
let fontCssPromise;
/** Inline Google Fonts as data URLs so the exported SVG/PNG keeps the handwriting. */
async function embeddedFontCss() {
  fontCssPromise ??= (async () => {
    try {
      const css = await (await fetch(GOOGLE_FONTS_URL)).text();
      const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))];
      let out = css;
      await Promise.all(
        urls.map(async (url) => {
          const blob = await (await fetch(url)).blob();
          const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          out = out.split(url).join(dataUrl);
        }),
      );
      // keep only latin subsets to limit size
      return out.replace(/\/\* (?!latin \*\/)[a-z-]+ \*\/\s*@font-face\s*{[^}]*}/g, '');
    } catch {
      return ''; // offline: system handwriting fallbacks are used
    }
  })();
  return fontCssPromise;
}

export async function exportSVG(renderer, map) {
  const { markup } = renderer.exportSvg({ fontCss: await embeddedFontCss() });
  download(markup, `${fileBase(map)}.svg`, 'image/svg+xml');
}

export async function exportPNG(renderer, map, scale = 2) {
  const { markup, width, height } = renderer.exportSvg({ fontCss: await embeddedFontCss() });
  const maxSide = 16000;
  const s = Math.min(scale, maxSide / width, maxSide / height);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG rasterisation failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * s);
    canvas.height = Math.ceil(height * s);
    const ctx = canvas.getContext('2d');
    ctx.scale(s, s);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    download(blob, `${fileBase(map)}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Menu entries used by the toolbar. */
export function exportActions({ getMap, renderer, api }) {
  return [
    { id: 'png', label: 'PNG image', icon: '🖼️', run: () => exportPNG(renderer, getMap()) },
    { id: 'svg', label: 'SVG (vector)', icon: '✒️', run: () => exportSVG(renderer, getMap()) },
    { id: 'json', label: 'JSON (TubeMind)', icon: '🧾', run: () => exportJSON(getMap()) },
    { id: 'md', label: 'Markdown', icon: '📝', run: () => download(toMarkdown(getMap()), `${fileBase(getMap())}.md`, 'text/markdown') },
    { id: 'obsidian', label: 'Obsidian note', icon: '💎', run: () => download(toMarkdown(getMap(), { flavor: 'obsidian' }), `${fileBase(getMap())}.md`, 'text/markdown') },
    { id: 'roam', label: 'Roam Research JSON', icon: '🌀', run: () => download(toRoam(getMap()), `${fileBase(getMap())}.roam.json`, 'application/json') },
    { id: 'opml', label: 'OPML (XMind, Logseq…)', icon: '🌳', run: () => download(toOPML(getMap()), `${fileBase(getMap())}.opml`, 'text/x-opml') },
    {
      id: 'notion-md',
      label: 'Notion (import .md)',
      icon: '📓',
      run: () => {
        download(toMarkdown(getMap()), `${fileBase(getMap())}.md`, 'text/markdown');
        toast('In Notion: ⋯ → Import → Markdown & CSV, then pick this file.');
      },
    },
    {
      id: 'notion-api',
      label: 'Push to Notion (API)',
      icon: '🚀',
      enabled: () => !!api.health?.notion,
      run: async () => {
        const res = await api.notion(getMap());
        toast('Sent to Notion ✓', { action: res.url ? { label: 'Open', run: () => window.open(res.url, '_blank') } : undefined });
      },
    },
  ];
}

/**
 * MindMapRenderer — draws the model as a hand-drawn SVG mindmap and handles
 * direct manipulation (pan, zoom, select, expand/collapse, inline edit).
 *
 * Emits CustomEvents:
 *   select {ids}            selection changed
 *   seek {node}             timestamp chip clicked
 *   toggle {node}           branch expanded/collapsed
 *   image {node}            node image clicked
 *   contextmenu {node, x, y}
 *   edge {edge}             cross-link clicked
 *   rendered {positions}
 */
import { fmtTime, seededRandom, svg } from '../lib/util.js';
import { boundsOf, computeLayout } from './layout.js';
import * as S from './sketch.js';
import { getTheme } from './themes.js';

const MAX_LINES = { root: 3, section: 3, concept: 5, detail: 5, transcript: 4 };
// [horizontal, vertical] distance a shape's outline extends beyond the node's text box
const SHAPE_EXTENT = {
  none: [0, 0], underline: [0, 2], highlight: [0, 0], 'burst-text': [30, 0],
  cloud: [18, 17], circle: [14, 14], bubble: [10, 16], burst: [34, 26], heart: [17, 16],
  arrowBox: [14, 8], tent: [12, 6], note: [8, 6], sign: [8, 22], brace: [10, 6], banner: [18, 10], box: [8, 6],
};

export class MindMapRenderer extends EventTarget {
  constructor(container, model, options = {}) {
    super();
    this.container = container;
    this.model = model;
    this.options = { theme: 'sketch', layout: 'balanced', maxLayer: 4, profile: 'balanced', ...options };
    this.selection = new Set();
    this.hits = new Set();
    this.mastered = new Set();
    this.presence = [];
    this.playingId = null;
    this.view = { x: 0, y: 0, k: 1 };
    this.positions = new Map();
    this.prevVisible = new Set();
    this.textCache = new Map();
    this.measureCtx = document.createElement('canvas').getContext('2d');
    this.#buildDom();
    this.#bindPointer();
    model.addEventListener('change', () => this.scheduleRender());
    model.addEventListener('load', () => {
      this.selection.clear();
      this.render();
      this.fit(false);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  setOptions(patch) {
    Object.assign(this.options, patch);
    this.textCache.clear();
    this.render();
  }

  get theme() {
    return getTheme(this.options.theme);
  }

  scheduleRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  select(ids, { additive = false, silent = false } = {}) {
    if (!additive) this.selection.clear();
    for (const id of [].concat(ids)) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else if (id) this.selection.add(id);
    }
    this.#syncClasses();
    if (!silent) this.dispatchEvent(new CustomEvent('select', { detail: { ids: [...this.selection] } }));
  }

  get selectedId() {
    return [...this.selection].pop() || null;
  }

  setHits(ids) {
    this.hits = new Set(ids);
    this.#syncClasses();
  }

  setPlaying(id) {
    if (this.playingId === id) return;
    this.playingId = id;
    this.#syncClasses();
  }

  setPresence(users) {
    this.presence = users || [];
    this.#drawPresence();
  }

  setMastered(ids) {
    this.mastered = new Set(ids);
    this.scheduleRender();
  }

  /** Make sure a node is visible: expand ancestors and raise the layer filter if needed. */
  reveal(id) {
    const path = this.model.path(id);
    const ops = path.slice(0, -1).filter((n) => n.collapsed).map((n) => ({ type: 'update', id: n.id, patch: { collapsed: false } }));
    if (ops.length) this.model.apply(ops);
    const node = this.model.get(id);
    if (node && (node.layer ?? 0) > this.options.maxLayer) {
      this.options.maxLayer = node.layer;
      this.dispatchEvent(new CustomEvent('layer', { detail: { maxLayer: node.layer } }));
    }
    this.render();
  }

  centerOn(id, { zoom = null, animate = true } = {}) {
    const pos = this.positions.get(id);
    if (!pos) return;
    const { width, height } = this.container.getBoundingClientRect();
    const k = zoom ?? Math.max(this.view.k, 0.7);
    this.#animateTo({ x: width / 2 - pos.x * k, y: height / 2 - pos.y * k, k }, animate);
  }

  fit(animate = true) {
    const b = this.bounds || boundsOf(this.positions);
    const { width, height } = this.container.getBoundingClientRect();
    if (!width || !height) return;
    const k = Math.min(Math.max(Math.min(width / b.w, height / b.h), 0.12), 1.1);
    this.#animateTo({ x: width / 2 - (b.x + b.w / 2) * k, y: height / 2 - (b.y + b.h / 2) * k, k }, animate);
  }

  zoomBy(factor, cx, cy) {
    const rect = this.container.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const k = Math.min(3, Math.max(0.08, this.view.k * factor));
    const wx = (px - this.view.x) / this.view.k;
    const wy = (py - this.view.y) / this.view.k;
    this.view = { x: px - wx * k, y: py - wy * k, k };
    this.#applyView();
  }

  visibleChildren(node) {
    if (node.collapsed) return [];
    return (node.children || []).filter((c) => (c.layer ?? 0) <= this.options.maxLayer);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  render() {
    if (!this.model.map) return;
    const theme = this.theme;
    this.container.style.setProperty('--canvas-bg', theme.background);
    this.container.dataset.theme = theme.id;
    document.documentElement.dataset.canvasTheme = theme.id;

    // 1. walk visible tree, remember section colour/index for styling
    const info = new Map();
    const visit = (node, depth, ctx) => {
      info.set(node.id, { depth, ...ctx });
      this.visibleChildren(node).forEach((child, i) => {
        const childCtx = depth === 0 ? { index: i, color: child.color ?? i } : ctx;
        visit(child, depth + 1, childCtx);
      });
    };
    visit(this.model.root, 0, { index: 0, color: 0 });

    // 2. measure
    const metrics = new Map();
    for (const id of info.keys()) {
      const node = this.model.get(id);
      metrics.set(id, this.#measure(node, info.get(id), theme));
    }

    // 3. layout — reserve room for outlines drawn outside the text box (bursts, clouds, signs…)
    const layoutSizes = new Map();
    for (const [id, m] of metrics) {
      const [ex, ey] = SHAPE_EXTENT[m.style.shape] || [8, 6];
      layoutSizes.set(id, { w: m.w + ex * 2, h: m.h + ey * 2 });
    }
    const positions = computeLayout(this.model.root, (n) => layoutSizes.get(n.id), (n) => this.visibleChildren(n), { layout: this.options.layout, gaps: theme.gaps });
    this.positions = positions;
    this.bounds = boundsOf(positions);
    this.metrics = metrics;

    // 4. draw
    const links = [];
    const nodes = [];
    for (const pos of positions.values()) {
      if (pos.parentId) links.push(this.#drawLink(positions.get(pos.parentId), pos, theme));
      nodes.push(this.#drawNode(pos, metrics.get(pos.node.id), info.get(pos.node.id), theme));
    }
    const cross = (this.model.map.edges || []).map((e) => this.#drawCrossEdge(e, positions, theme)).filter(Boolean);
    this.layers.links.replaceChildren(...links);
    this.layers.cross.replaceChildren(...cross);
    this.layers.nodes.replaceChildren(...nodes);
    this.prevVisible = new Set(positions.keys());
    this.#drawPresence();
    this.#drawDecorations(theme);
    this.#syncClasses();
    this.dispatchEvent(new CustomEvent('rendered', { detail: { positions } }));
  }

  #wrap(text, font, size, maxWidth, { accent = false, maxLines = 6 } = {}) {
    const key = `${font}|${size}|${maxWidth}|${accent}|${maxLines}|${text}`;
    if (this.textCache.has(key)) return this.textCache.get(key);
    const ctx = this.measureCtx;
    ctx.font = font;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    let accentWords = 0;
    if (accent) {
      const m = String(text).match(/^([^:]{2,60}):\s/);
      if (m) accentWords = m[1].split(/\s+/).length;
    }
    const space = ctx.measureText(' ').width;
    const lines = [];
    let cur = [];
    let curW = 0;
    words.forEach((word, i) => {
      const ww = ctx.measureText(word).width;
      if (cur.length && curW + space + ww > maxWidth) {
        lines.push({ words: cur, w: curW });
        cur = [];
        curW = 0;
      }
      cur.push({ t: word, accent: i < accentWords });
      curW += (cur.length > 1 ? space : 0) + ww;
    });
    if (cur.length) lines.push({ words: cur, w: curW });
    if (lines.length > maxLines) {
      lines.length = maxLines;
      const last = lines[maxLines - 1];
      last.words[last.words.length - 1].t += '…';
    }
    const lineHeight = size * 1.2;
    const result = { lines, lineHeight, width: Math.max(0, ...lines.map((l) => l.w)), height: lines.length * lineHeight };
    this.textCache.set(key, result);
    return result;
  }

  #measure(node, ctx, theme) {
    const style = theme.node(node, ctx);
    const profile = this.options.profile;
    const scale = profile === 'visual' && node.type !== 'root' ? 1.06 : 1;
    const size = style.size * scale;
    const maxW = (theme.maxWidth[node.type] || 220) * (profile === 'visual' ? 0.85 : 1);
    const font = `${style.italic ? 'italic ' : ''}${style.weight || 400} ${size}px ${style.font}`;
    const raw = style.upper ? String(node.text || '').toUpperCase() : node.text || ' ';
    const text = this.#wrap(raw, font, size, maxW, { accent: !!style.accent, maxLines: MAX_LINES[node.type] || 5 });

    let summary = null;
    const wantsSummary = node.summary && (profile === 'text' ? ['section', 'concept', 'detail'] : ['root']).includes(node.type);
    if (wantsSummary) {
      const sSize = Math.max(12, size * (node.type === 'root' ? 0.3 : 0.78));
      summary = { ...this.#wrap(node.summary, `400 ${sSize}px ${theme.fonts.body}`, sSize, Math.max(maxW, 260), { maxLines: node.type === 'root' ? 2 : 4 }), size: sSize };
    }

    const showImage = node.image?.src && (profile === 'visual' ? node.type !== 'transcript' : node.type === 'section' || node.type === 'concept');
    const img = showImage ? { w: profile === 'visual' ? 190 : 140, h: 0 } : null;
    if (img) img.h = Math.round((img.w * 9) / 16);

    const chips = [];
    this.measureCtx.font = `400 12px ${theme.fonts.body}`;
    if (node.start !== null && node.start !== undefined && node.type !== 'root') {
      const label = `▶ ${fmtTime(node.start)}`;
      chips.push({ kind: 'seek', label, w: this.measureCtx.measureText(label).width + 16 });
    }
    if (['section', 'root'].includes(node.type)) {
      for (const tone of (node.tone || []).slice(0, 2)) chips.push({ kind: 'tone', tone, label: `● ${tone}`, w: this.measureCtx.measureText(`● ${tone}`).width + 6 });
    }
    if (node.notes) chips.push({ kind: 'notes', label: '✎', w: 16 });
    if (node.links?.length) chips.push({ kind: 'links', label: `🔗${node.links.length}`, w: 30 });
    const chipW = chips.reduce((s, c) => s + c.w + 6, 0);
    const chipH = chips.length ? 20 : 0;

    const contentW = Math.max(text.width, summary?.width || 0, img?.w || 0, chipW, 24);
    const w = contentW + style.padX * 2;
    const h = style.padY * 2 + (img ? img.h + 8 : 0) + text.height + (summary ? summary.height + 6 : 0) + (chipH ? chipH + 5 : 0);
    return { style, font, size, text, summary, img, chips, w, h };
  }

  #drawNode(pos, m, ctx, theme) {
    const { node } = pos;
    const { w, h, style } = m;
    const rng = seededRandom(node.id);
    const classes = ['node', `type-${node.type}`];
    if (!this.prevVisible.has(node.id) && this.prevVisible.size) classes.push('enter');
    const g = svg('g', { class: classes.join(' '), 'data-node-id': node.id, transform: `translate(${(pos.x - w / 2).toFixed(1)},${(pos.y - h / 2).toFixed(1)})` });

    g.append(svg('path', { class: 'sel-ring', 'data-ui': '1', d: S.rect(-12, -9, w + 24, h + 18, rng, { r: 14, passes: 1 }), fill: 'none' }));
    g.append(svg('rect', { class: 'hit-area', 'data-ui': '1', x: -6, y: -4, width: w + 12, height: h + 8, fill: 'transparent' }));
    this.#drawShape(g, style, w, h, rng, pos.side, theme, m);

    const align = ['root', 'section'].includes(node.type) || style.shape !== 'none' && style.shape !== 'underline' || this.options.layout === 'radial' ? 'middle' : pos.side < 0 ? 'end' : 'start';
    const ax = align === 'middle' ? w / 2 : align === 'end' ? w - style.padX : style.padX;
    let y = style.padY;

    if (m.img) {
      const ix = (w - m.img.w) / 2;
      g.append(svg('rect', { x: ix + 6, y: y + 6, width: m.img.w, height: m.img.h, fill: 'url(#tm-hatch)', 'data-export': 'keep' }));
      g.append(svg('image', { href: node.image.src, x: ix, y, width: m.img.w, height: m.img.h, preserveAspectRatio: 'xMidYMid slice', 'data-action': 'image', class: 'node-image' }));
      g.append(svg('path', { d: S.rect(ix, y, m.img.w, m.img.h, rng, { r: 2, passes: 1, jitter: 1 }), fill: 'none', stroke: theme.ink, 'stroke-width': 1.6 }));
      y += m.img.h + 8;
    }

    const textEl = svg('text', {
      'font-family': style.font,
      'font-size': m.size,
      'font-weight': style.weight || 400,
      'font-style': style.italic ? 'italic' : null,
      fill: style.color,
      'text-anchor': align,
    });
    if (style.outline) {
      Object.assign(textEl.style, {});
      textEl.setAttribute('stroke', style.outline);
      textEl.setAttribute('stroke-width', '7');
      textEl.setAttribute('stroke-linejoin', 'round');
      textEl.setAttribute('paint-order', 'stroke');
    }
    m.text.lines.forEach((line, i) => {
      const ty = y + m.text.lineHeight * (i + 0.78);
      const groups = [];
      for (const word of line.words) {
        const last = groups[groups.length - 1];
        if (last && last.accent === word.accent) last.text += ` ${word.t}`;
        else groups.push({ accent: word.accent, text: word.t });
      }
      groups.forEach((grp, gi) => {
        const attrs = gi === 0 ? { x: ax, y: ty } : {};
        if (grp.accent) Object.assign(attrs, { fill: style.accent, 'font-weight': 700 });
        textEl.append(svg('tspan', attrs, (gi ? ' ' : '') + grp.text));
      });
    });
    g.append(textEl);
    y += m.text.height;

    if (style.shape === 'underline') {
      const lw = m.text.lines.at(-1)?.w || 0;
      const x1 = align === 'end' ? w - style.padX - lw : align === 'middle' ? (w - lw) / 2 : style.padX;
      g.append(svg('path', { d: S.squiggle(x1, x1 + lw, y + 2, rng), fill: 'none', stroke: style.stroke || theme.ink, 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
    }

    if (m.summary) {
      y += 6;
      const sEl = svg('text', { 'font-family': theme.fonts.body, 'font-size': m.summary.size, fill: theme.muted, 'text-anchor': align });
      m.summary.lines.forEach((line, i) => {
        sEl.append(svg('tspan', { x: ax, y: y + m.summary.lineHeight * (i + 0.78) }, line.words.map((wd) => wd.t).join(' ')));
      });
      g.append(sEl);
      y += m.summary.height;
    }

    if (m.chips.length) {
      y += 5;
      const total = m.chips.reduce((s, c) => s + c.w + 6, -6);
      let cx = align === 'middle' ? (w - total) / 2 : align === 'end' ? w - style.padX - total : style.padX;
      for (const chip of m.chips) {
        const cg = svg('g', { class: `chip chip-${chip.kind}`, transform: `translate(${cx.toFixed(1)},${y.toFixed(1)})`, 'data-action': chip.kind });
        if (chip.kind === 'seek') {
          cg.append(svg('path', { d: S.rect(0, 1, chip.w, 18, rng, { r: 9, passes: 1, jitter: 0.6 }), fill: theme.dark ? 'rgba(255,255,255,.08)' : theme.paper, stroke: theme.ink, 'stroke-width': 1.2 }));
          cg.append(svg('text', { x: chip.w / 2, y: 14.5, 'text-anchor': 'middle', 'font-family': theme.fonts.body, 'font-size': 12, fill: theme.ink }, chip.label));
          cg.append(svg('title', {}, 'Jump to this moment in the video'));
        } else {
          const color = chip.kind === 'tone' ? theme.toneColors[chip.tone] || theme.muted : theme.muted;
          cg.append(svg('text', { x: 0, y: 14.5, 'font-family': theme.fonts.body, 'font-size': 12, fill: color }, chip.label));
        }
        g.append(cg);
        cx += chip.w + 6;
      }
    }

    if (this.mastered.has(node.id)) {
      g.append(svg('path', { d: S.checkMark(-18, -4, 16, rng), fill: 'none', stroke: theme.accent, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }

    if (style.badge && this.options.layout !== 'radial') {
      const bx = pos.side < 0 ? w + 16 : -22;
      g.append(svg('path', { d: S.starburst(bx, -12, 13, rng, 9), fill: theme.paper, stroke: theme.ink, 'stroke-width': 1.4 }));
      g.append(svg('text', { x: bx, y: -7, 'text-anchor': 'middle', 'font-family': theme.fonts.body, 'font-size': 14, fill: theme.ink }, style.badge));
    }

    const hasKids = (node.children || []).some((c) => (c.layer ?? 0) <= this.options.maxLayer);
    if (hasKids && node.type !== 'root') {
      const radial = this.options.layout === 'radial';
      const tx = radial ? w / 2 : pos.side < 0 ? -16 : w + 16;
      const ty = radial ? h + 14 : h / 2;
      const tg = svg('g', { class: 'toggle', 'data-action': 'toggle', 'data-ui': '1', transform: `translate(${tx},${ty})` });
      tg.append(svg('path', { d: S.ellipse(0, 0, 9, 9, rng, { passes: 1, points: 10 }), fill: theme.dark ? theme.paper : '#fff', stroke: theme.ink, 'stroke-width': 1.4 }));
      tg.append(svg('text', { x: 0, y: 4.5, 'text-anchor': 'middle', 'font-size': node.collapsed ? 11 : 15, 'font-family': 'system-ui, sans-serif', fill: theme.ink }, node.collapsed ? String(node.children.length) : '−'));
      tg.append(svg('title', {}, node.collapsed ? 'Expand' : 'Collapse'));
      g.append(tg);
    }
    return g;
  }

  #drawShape(g, style, w, h, rng, side, theme) {
    const stroke = style.stroke || theme.ink;
    const outline = (d, width = 2.2) => g.append(svg('path', { d, fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    switch (style.shape) {
      case 'none':
      case 'underline':
        return;
      case 'highlight':
        g.append(svg('path', { d: S.highlighter(0, h * 0.1, w, h * 0.8, rng), fill: style.fill, opacity: 0.95 }));
        return;
      case 'burst-text':
        outline(S.burstTicks(w / 2, h / 2, w / 2, h / 2, rng), 2.4);
        return;
      default: {
        const dir = side || 1;
        if (style.shadow) g.append(svg('path', { d: S.fillPath(style.shape, 5, 7, w, h, rng, dir), fill: style.shadow, 'data-export': 'keep' }));
        if (style.fill) g.append(svg('path', { d: S.fillPath(style.shape, 0, 0, w, h, rng, dir), fill: style.fill }));
        const shapes = {
          cloud: () => S.cloud(w / 2, h / 2, w + 36, h + 34, rng),
          circle: () => S.ellipse(w / 2, h / 2, w / 2 + 14, h / 2 + 14, rng),
          bubble: () => S.bubble(-2, -2, w + 4, h + 4, rng),
          burst: () => S.starburst(w / 2, h / 2, w / 2 + 34, rng, 14, h / 2 + 26),
          heart: () => S.heart(w / 2, h / 2 + 4, w + 34, h + 30, rng),
          arrowBox: () => S.arrowBox(-6, -4, w + 12, h + 8, rng, dir),
          tent: () => S.tent(-6, -6, w + 20, h + 12, rng),
          note: () => S.note(-8, -6, w + 16, h + 12, rng),
          sign: () => S.sign(-8, -6, w + 16, h + 12, rng),
          brace: () => S.braceBox(-10, -6, w + 20, h + 12, rng),
          banner: () => S.banner(-6, -4, w + 12, h + 8, rng),
          box: () => S.rect(-8, -6, w + 16, h + 12, rng, { r: 8 }),
        };
        outline((shapes[style.shape] || shapes.box)());
      }
    }
  }

  #drawLink(p, c, theme) {
    const style = theme.link(p.node, c.node);
    const rng = seededRandom(`${c.node.id}:link`);
    const radial = this.options.layout === 'radial';
    let x1;
    let y1;
    let x2;
    let y2;
    if (radial || p.node.type === 'root') {
      const angle = Math.atan2(c.y - p.y, c.x - p.x);
      const pr = ellipseEdge(p, angle, p.node.type === 'root' ? 0.95 : 1);
      [x1, y1] = [p.x + pr.dx, p.y + pr.dy];
      if (radial) {
        const cr = boxEdge(c, angle + Math.PI);
        [x2, y2] = [c.x + cr.dx, c.y + cr.dy];
      } else {
        x2 = c.x - c.side * (c.w / 2 + 4);
        y2 = c.y;
      }
    } else {
      // pos.w already includes the shape outline (see SHAPE_EXTENT)
      x1 = p.x + c.side * (p.w / 2 + 4);
      y1 = p.y;
      x2 = c.x - c.side * (c.w / 2 + 2);
      y2 = c.y;
    }
    const g = svg('g', { class: 'link' });
    const attrs = { fill: 'none', stroke: style.stroke, 'stroke-width': style.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': style.dash || null };
    if (style.double) {
      g.append(svg('path', { ...attrs, d: S.doubleArrow(x1, y1, x2, y2, rng) }));
      return g;
    }
    const conn = S.connector(x1, y1, x2, y2, rng, { axis: radial ? 'free' : 'h', curl: p.node.type === 'root' ? 0.35 : 0.5, passes: style.width > 2.3 ? 2 : 1 });
    g.append(svg('path', { ...attrs, d: conn.d }));
    if (style.arrow) g.append(svg('path', { ...attrs, 'stroke-dasharray': null, d: S.arrowHead(x2, y2, conn.endAngle, rng, 9 + style.width * 1.5) }));
    return g;
  }

  #drawCrossEdge(edge, positions, theme) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) return null;
    const rng = seededRandom(edge.id || `${edge.source}${edge.target}`);
    const conn = S.connector(a.x, a.y + a.h / 2, b.x, b.y - b.h / 2, rng, { axis: 'free' });
    const g = svg('g', { class: 'cross-edge', 'data-edge-id': edge.id });
    const color = theme.dark ? 'rgba(243,217,138,.55)' : theme.id === 'doodle' ? 'rgba(90,50,10,.45)' : 'rgba(127,157,102,.75)';
    g.append(svg('path', { d: conn.d, fill: 'none', stroke: 'transparent', 'stroke-width': 14, 'data-ui': '1' }));
    g.append(svg('path', { d: conn.d, fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-dasharray': '2 7', 'stroke-linecap': 'round' }));
    if (edge.label) {
      this.measureCtx.font = `400 12px ${theme.fonts.body}`;
      const lw = this.measureCtx.measureText(edge.label).width + 12;
      g.append(svg('rect', { x: conn.mid.x - lw / 2, y: conn.mid.y - 10, width: lw, height: 18, rx: 9, fill: theme.background, opacity: 0.9 }));
      g.append(svg('text', { x: conn.mid.x, y: conn.mid.y + 3.5, 'text-anchor': 'middle', 'font-family': theme.fonts.body, 'font-size': 12, fill: theme.muted }, edge.label));
    }
    g.append(svg('title', {}, `${edge.label || 'related'} (cross-link)`));
    return g;
  }

  #drawPresence() {
    if (!this.layers) return;
    const items = [];
    const perNode = new Map();
    for (const user of this.presence) {
      const pos = user.nodeId && this.positions.get(user.nodeId);
      if (!pos) continue;
      const n = perNode.get(user.nodeId) || 0;
      perNode.set(user.nodeId, n + 1);
      const x = pos.x + pos.w / 2 + 6 - n * 18;
      const y = pos.y - pos.h / 2 - 14;
      items.push(
        svg('g', { class: 'presence-dot', transform: `translate(${x},${y})` }, [
          svg('circle', { r: 10, fill: user.color || '#9d9cc4', stroke: '#fff', 'stroke-width': 2 }),
          svg('text', { y: 4, 'text-anchor': 'middle', 'font-size': 11, 'font-family': 'system-ui, sans-serif', fill: '#fff' }, (user.name || '?').slice(0, 1).toUpperCase()),
          svg('title', {}, `${user.name} is here`),
        ]),
      );
    }
    this.layers.presence.replaceChildren(...items);
  }

  #drawDecorations(theme) {
    const { width, height } = this.container.getBoundingClientRect();
    this.decor.setAttribute('viewBox', `0 0 ${width} ${height}`);
    if (theme.decorations !== 'corners') {
      this.decor.replaceChildren();
      return;
    }
    const rng = seededRandom('corners');
    const hatch = (cx, cy, r, start) => {
      let d = '';
      for (let i = 0; i < 26; i++) {
        const a = start + (i / 26) * (Math.PI / 2);
        const len = r * (0.55 + rng() * 0.45);
        d += S.line(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len), cx + Math.cos(a) * r, cy + Math.sin(a) * r, rng, { passes: 1 });
      }
      return d;
    };
    const r = Math.min(140, width * 0.12);
    const d = hatch(0, 0, r, 0) + hatch(width, 0, r, Math.PI / 2) + hatch(width, height, r, Math.PI) + hatch(0, height, r, Math.PI * 1.5);
    this.decor.replaceChildren(svg('path', { d, fill: 'none', stroke: '#b8861b', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.8 }));
  }

  #syncClasses() {
    if (!this.layers) return;
    for (const g of this.layers.nodes.children) {
      const id = g.dataset.nodeId;
      g.classList.toggle('selected', this.selection.has(id));
      g.classList.toggle('hit', this.hits.has(id));
      g.classList.toggle('playing', this.playingId === id);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM + interaction
  // ---------------------------------------------------------------------------
  #buildDom() {
    this.container.classList.add('mm-canvas');
    this.decor = svg('svg', { class: 'mm-decor', 'aria-hidden': 'true' });
    this.svgEl = svg('svg', { class: 'mm-svg', role: 'img', 'aria-label': 'Mindmap' });
    const defs = svg('defs', {}, [
      svg('pattern', { id: 'tm-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, [
        svg('rect', { width: 6, height: 6, fill: 'transparent' }),
        svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#8a8aad', 'stroke-width': 2.2 }),
      ]),
    ]);
    this.viewport = svg('g', { class: 'mm-viewport' });
    this.layers = {
      cross: svg('g', { class: 'mm-cross' }),
      links: svg('g', { class: 'mm-links' }),
      nodes: svg('g', { class: 'mm-nodes' }),
      presence: svg('g', { class: 'mm-presence', 'data-ui': '1' }),
    };
    this.viewport.append(this.layers.links, this.layers.cross, this.layers.nodes, this.layers.presence);
    this.svgEl.append(defs, this.viewport);
    this.container.append(this.decor, this.svgEl);
    new ResizeObserver(() => this.#drawDecorations(this.theme)).observe(this.container);
  }

  #applyView() {
    const { x, y, k } = this.view;
    this.viewport.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${k.toFixed(4)})`);
    this.dispatchEvent(new CustomEvent('viewchange', { detail: { ...this.view } }));
  }

  #animateTo(target, animate) {
    cancelAnimationFrame(this.viewAnim);
    if (!animate) {
      this.view = target;
      this.#applyView();
      return;
    }
    const from = { ...this.view };
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 380);
      const e = 1 - (1 - t) ** 3;
      this.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      this.#applyView();
      if (t < 1) this.viewAnim = requestAnimationFrame(step);
    };
    this.viewAnim = requestAnimationFrame(step);
  }

  #bindPointer() {
    const el = this.svgEl;
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events (tests, automation) have no capturable pointer */
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: this.view.k };
        drag = null;
      } else {
        drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, target: e.target };
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const rect = this.container.getBoundingClientRect();
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomBy((pinch.k * dist) / pinch.dist / this.view.k, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.container.classList.add('panning');
      this.view.x = drag.vx + dx;
      this.view.y = drag.vy + dy;
      this.#applyView();
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      this.container.classList.remove('panning');
      if (!drag || drag.moved || e.type === 'pointercancel') {
        drag = null;
        return;
      }
      const target = drag.target;
      drag = null;
      this.#handleClick(target, e);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('dblclick', (e) => {
      const g = e.target.closest?.('[data-node-id]');
      if (g && !e.target.closest('[data-action]')) this.startEdit(g.dataset.nodeId);
    });

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.container.getBoundingClientRect();
        if (e.shiftKey && !e.ctrlKey) {
          this.view.x -= e.deltaY;
          this.#applyView();
          return;
        }
        this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false },
    );

    el.addEventListener('contextmenu', (e) => {
      const g = e.target.closest?.('[data-node-id]');
      if (!g) return;
      e.preventDefault();
      if (!this.selection.has(g.dataset.nodeId)) this.select(g.dataset.nodeId);
      this.dispatchEvent(new CustomEvent('contextmenu', { detail: { node: this.model.get(g.dataset.nodeId), x: e.clientX, y: e.clientY } }));
    });
  }

  #handleClick(target, e) {
    const actionEl = target.closest?.('[data-action]');
    const nodeEl = target.closest?.('[data-node-id]');
    const edgeEl = target.closest?.('[data-edge-id]');
    const node = nodeEl && this.model.get(nodeEl.dataset.nodeId);
    if (actionEl && node) {
      const action = actionEl.dataset.action;
      if (action === 'toggle') {
        this.model.toggle(node.id);
        this.dispatchEvent(new CustomEvent('toggle', { detail: { node } }));
        return;
      }
      if (action === 'seek') {
        this.dispatchEvent(new CustomEvent('seek', { detail: { node } }));
        this.select(node.id);
        return;
      }
      if (action === 'image') {
        this.dispatchEvent(new CustomEvent('image', { detail: { node } }));
        return;
      }
    }
    if (node) {
      this.select(node.id, { additive: e.shiftKey || e.ctrlKey || e.metaKey });
      return;
    }
    if (edgeEl) {
      const edge = (this.model.map.edges || []).find((x) => x.id === edgeEl.dataset.edgeId);
      if (edge) this.dispatchEvent(new CustomEvent('edge', { detail: { edge } }));
      return;
    }
    this.select([]);
  }

  /** Inline text editing over the node. Resolves when editing ends. */
  startEdit(id) {
    const node = this.model.get(id);
    const g = this.layers.nodes.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    const m = this.metrics?.get(id);
    if (!node || !g || !m) return;
    this.select(id, { silent: true });
    const box = g.getBoundingClientRect();
    const host = this.container.getBoundingClientRect();
    const ta = document.createElement('textarea');
    ta.className = 'inline-editor';
    ta.value = node.text;
    Object.assign(ta.style, {
      left: `${box.left - host.left - 6}px`,
      top: `${box.top - host.top - 6}px`,
      width: `${Math.max(box.width + 12, 180)}px`,
      minHeight: `${Math.max(box.height + 12, 40)}px`,
      fontFamily: m.style.font,
      fontSize: `${Math.max(12, m.size * this.view.k)}px`,
    });
    this.container.append(ta);
    ta.focus();
    ta.select();
    let done = false;
    const finish = (commit, next) => {
      if (done) return;
      done = true;
      const value = ta.value.replace(/\s+/g, ' ').trim();
      ta.remove();
      if (commit && value && value !== node.text) this.model.update(id, { text: value });
      if (next) this.dispatchEvent(new CustomEvent('edit-next', { detail: { id, next } }));
      this.svgEl.focus?.();
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, 'child');
      }
    });
    ta.addEventListener('blur', () => finish(true));
  }

  /** Stand-alone SVG markup of the whole map (used by PNG/SVG export). */
  exportSvg({ fontCss = '' } = {}) {
    const b = this.bounds;
    const theme = this.theme;
    const clone = this.viewport.cloneNode(true);
    clone.removeAttribute('transform');
    clone.querySelectorAll('[data-ui]').forEach((n) => n.remove());
    clone.querySelectorAll('.node').forEach((n) => n.classList.remove('selected', 'hit', 'playing', 'enter'));
    const root = svg('svg', { xmlns: 'http://www.w3.org/2000/svg', width: Math.ceil(b.w), height: Math.ceil(b.h), viewBox: `${b.x} ${b.y} ${b.w} ${b.h}` });
    root.append(svg('style', {}, fontCss));
    root.append(this.svgEl.querySelector('defs').cloneNode(true));
    root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: theme.background }));
    root.append(clone);
    return { markup: new XMLSerializer().serializeToString(root), width: b.w, height: b.h };
  }
}

function ellipseEdge(pos, angle, factor = 1) {
  return { dx: Math.cos(angle) * (pos.w / 2) * factor, dy: Math.sin(angle) * (pos.h / 2) * factor };
}

function boxEdge(pos, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const sx = Math.abs(cos) > 1e-6 ? pos.w / 2 / Math.abs(cos) : Infinity;
  const sy = Math.abs(sin) > 1e-6 ? pos.h / 2 / Math.abs(sin) : Infinity;
  const s = Math.min(sx, sy) + 8;
  return { dx: cos * s, dy: sin * s };
}

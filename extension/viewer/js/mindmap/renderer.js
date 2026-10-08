/**
 * MindMapRenderer — draws the model as a hand-drawn SVG mindmap and handles
 * direct manipulation (pan, zoom, select, expand/collapse, inline edit).
 *
 * Emits CustomEvents:
 *   select {ids}            selection changed
 *   seek {node}             timestamp clicked
 *   toggle {node}           branch expanded/collapsed
 *   contextmenu {node, x, y}
 *   edge {edge}             cross-link clicked
 *   more {node}             "+" on a node whose children are generated lazily
 *   rendered {positions}
 *
 * Node content is TEXT ONLY: the label, a plain clickable timestamp ("12:40" or a section's
 * "12:40–18:05"), a plain "+" / "−" toggle and small text tags. The only drawn shapes are
 * the hand-drawn outlines and connectors from sketch.js (class "outline") and the
 * selection ring / hit area (data-ui), which are interaction affordances.
 *
 * Nodes can be dragged onto another node (re-parent) or next to a sibling (reorder);
 * every re-layout glides nodes from their old to their new place (FLIP).
 */
import { fmtTime, seededRandom, svg } from '../lib/util.js';
import { boundsOf, computeLayout } from './layout.js';
import * as S from './sketch.js';
import { DEFAULT_THEME, getTheme } from './themes.js';

const MAX_LINES = { root: 3, section: 3, concept: 4, detail: 4, transcript: 4 };
const LINE_HEIGHT = { root: 1.15, section: 1.2 }; // everything else: comfortable 1.3
const META_FONT = 14; // timestamps, toggles, cross-link labels
export const MAX_LAYER = 3; // layer 4 (verbatim transcript quotes) stays in the JSON, never on the map
const GLIDE_MS = 380;
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
    this.options = { theme: DEFAULT_THEME, layout: 'balanced', maxLayer: MAX_LAYER, ...options };
    this.options.maxLayer = Math.min(this.options.maxLayer, MAX_LAYER);
    this.selection = new Set();
    this.hits = new Set();
    this.mastered = new Set();
    this.presence = [];
    this.playingId = null;
    this.discussingId = null;
    this.flashIds = new Set();
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
    this.options.maxLayer = Math.min(this.options.maxLayer, MAX_LAYER);
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

  /** Highlight the node the chat assistant is talking about. */
  setDiscussing(id) {
    if (this.discussingId === id) return;
    this.discussingId = id;
    this.#syncClasses();
  }

  /** Briefly animate nodes whose labels were patched in (background AI polishing). */
  flash(ids) {
    for (const id of ids) this.flashIds.add(id);
    this.scheduleRender();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashIds.clear();
      this.layers.nodes.querySelectorAll('.relabel').forEach((n) => n.classList.remove('relabel'));
    }, 1300);
  }

  /** Fonts changed (e.g. finished loading): drop cached text metrics and lay out again. */
  remeasure() {
    this.textCache.clear();
    if (this.model.map) this.render();
  }

  setPresence(users) {
    this.presence = users || [];
    this.#drawPresence();
  }

  setMastered(ids) {
    this.mastered = new Set(ids);
    this.scheduleRender();
  }

  /**
   * Make sure a node is visible: expand ancestors and raise the layer filter if needed.
   * Returns the id that is actually shown (a hidden transcript quote resolves to its parent).
   */
  reveal(id) {
    let node = this.model.get(id);
    while (node && (node.layer ?? 0) > MAX_LAYER) node = this.model.parentOf(node.id);
    if (!node) return id;
    const path = this.model.path(node.id);
    const ops = path.slice(0, -1).filter((n) => n.collapsed).map((n) => ({ type: 'update', id: n.id, patch: { collapsed: false } }));
    if (ops.length) this.model.apply(ops);
    if ((node.layer ?? 0) > this.options.maxLayer) {
      this.options.maxLayer = node.layer;
      this.dispatchEvent(new CustomEvent('layer', { detail: { maxLayer: node.layer } }));
    }
    this.render();
    return node.id;
  }

  /** "1." … "N." for sections in video order; the Quick recall branch is not numbered. */
  sectionNumber(node) {
    if (node?.type !== 'section' || node.recall) return null;
    const sections = (this.model.root?.children || []).filter((c) => c.type === 'section' && !c.recall);
    const i = sections.findIndex((c) => c.id === node.id);
    return i < 0 ? null : i + 1;
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
    const previous = this.prevVisible.size ? this.drawn : null;
    this.layers.links.replaceChildren(...links);
    this.layers.cross.replaceChildren(...cross);
    this.layers.nodes.replaceChildren(...nodes);
    this.#glide(previous, nodes, metrics);
    this.prevVisible = new Set(positions.keys());
    this.#drawPresence();
    this.#drawDecorations(theme);
    this.#syncClasses();
    this.dispatchEvent(new CustomEvent('rendered', { detail: { positions } }));
  }

  /**
   * FLIP: nodes that already existed start at their previous top-left corner and glide to
   * the new one, so collapse/expand, drag & drop and relabelling never "jump".
   */
  #glide(previous, nodes, metrics) {
    this.drawn = new Map();
    for (const g of nodes) {
      const id = g.dataset.nodeId;
      const pos = this.positions.get(id);
      const m = metrics.get(id);
      this.drawn.set(id, { x: pos.x - m.w / 2, y: pos.y - m.h / 2 });
    }
    if (!previous || nodes.length > 600 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const moving = [];
    for (const g of nodes) {
      const from = previous.get(g.dataset.nodeId);
      const to = this.drawn.get(g.dataset.nodeId);
      if (!from || (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1)) continue;
      g.style.transform = `translate(${from.x}px, ${from.y}px)`;
      moving.push([g, to]);
    }
    if (!moving.length) return;
    for (const layer of [this.layers.links, this.layers.cross]) {
      layer.style.opacity = '0';
    }
    this.svgEl.getBoundingClientRect(); // commit the start positions
    requestAnimationFrame(() => {
      for (const [g, to] of moving) {
        g.classList.add('gliding');
        g.style.transform = `translate(${to.x}px, ${to.y}px)`;
      }
      for (const layer of [this.layers.links, this.layers.cross]) {
        layer.style.transition = `opacity ${GLIDE_MS}ms ease ${GLIDE_MS * 0.4}ms`;
        layer.style.opacity = '1';
      }
    });
    clearTimeout(this.glideTimer);
    this.glideTimer = setTimeout(() => {
      for (const [g] of moving) {
        g.classList.remove('gliding');
        g.style.transform = ''; // the transform attribute (same position) takes over again
      }
    }, GLIDE_MS + 60);
  }

  #wrap(text, font, size, maxWidth, { accent = false, maxLines = 6, lineFactor = 1.3 } = {}) {
    const key = `${font}|${size}|${maxWidth}|${accent}|${maxLines}|${lineFactor}|${text}`;
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
    const bold = font.replace(/\b[1-9]00\b/, '700'); // the accented "Term:" is drawn bold: measure it bold
    const lines = [];
    let cur = [];
    let curW = 0;
    words.forEach((word, i) => {
      ctx.font = i < accentWords ? bold : font;
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
    const lineHeight = size * lineFactor;
    const result = { lines, lineHeight, width: Math.max(0, ...lines.map((l) => l.w)), height: lines.length * lineHeight };
    this.textCache.set(key, result);
    return result;
  }

  /** Text shown for a node: sections carry their number ("2. Superposition"). */
  displayText(node) {
    const n = this.sectionNumber(node);
    return n ? `${n}. ${node.text || ''}` : node.text || ' ';
  }

  /** Hidden children a collapsed node would show (verbatim transcript quotes never count). */
  #hiddenCount(node) {
    return (node.children || []).filter((c) => (c.layer ?? 0) <= this.options.maxLayer).length;
  }

  #measure(node, ctx, theme) {
    const style = theme.node(node, ctx);
    const size = style.size;
    const maxW = theme.maxWidth[node.type] || 220;
    const font = `${style.italic ? 'italic ' : ''}${style.weight || 400} ${size}px ${style.font}`;
    const shown = this.displayText(node);
    const raw = style.upper ? shown.toUpperCase() : shown;
    const text = this.#wrap(raw, font, size, maxW, { accent: !!style.accent, maxLines: MAX_LINES[node.type] || 4, lineFactor: LINE_HEIGHT[node.type] || 1.3 });

    let summary = null; // only the topic carries its one-line summary on the map
    if (node.summary && node.type === 'root') {
      const sSize = Math.max(14, size * 0.42);
      summary = { ...this.#wrap(node.summary, `400 ${sSize}px ${theme.fonts.body}`, sSize, Math.max(maxW, 280), { maxLines: 2 }), size: sSize };
    }

    // meta line: plain text only (a clickable timestamp and small words), no icons or badges
    const chips = [];
    this.measureCtx.font = `400 ${META_FONT}px ${theme.fonts.body}`;
    const add = (kind, label) => chips.push({ kind, label, w: this.measureCtx.measureText(label).width });
    if (node.start !== null && node.start !== undefined && node.type !== 'root' && !(node.recall && (node.type === 'section' || node.oneline))) {
      add('seek', node.type === 'section' && node.end > node.start ? `${fmtTime(node.start)}–${fmtTime(node.end)}` : fmtTime(node.start));
    }
    if (this.mastered.has(node.id)) add('mastered', 'mastered');
    if (node.notes) add('notes', 'note');
    if (node.links?.length) add('links', `${node.links.length} link${node.links.length > 1 ? 's' : ''}`);
    // compact rows: a concept's / detail's timestamp sits at the end of its last line when it fits
    let inline = null;
    const lastW = text.lines.at(-1)?.w || 0;
    if (chips[0]?.kind === 'seek' && ['concept', 'detail'].includes(node.type) && this.options.layout !== 'radial' && lastW + 10 + chips[0].w <= maxW) {
      inline = { ...chips.shift(), x: style.padX + lastW + 10 };
    }
    const chipW = chips.reduce((s, c) => s + c.w + 10, -10);
    const chipH = chips.length ? 18 : 0;

    const contentW = Math.max(text.width, inline ? lastW + 10 + inline.w : 0, summary?.width || 0, chipW, 24);
    const w = contentW + style.padX * 2;
    const h = style.padY * 2 + text.height + (summary ? summary.height + 6 : 0) + (chipH ? chipH + 3 : 0);
    return { style, font, size, text, summary, chips, inline, w, h };
  }

  #drawNode(pos, m, ctx, theme) {
    const { node } = pos;
    const { w, h, style } = m;
    const rng = seededRandom(node.id);
    const classes = ['node', `type-${node.type}`];
    if (node.recall) classes.push('recall');
    if (!this.prevVisible.has(node.id) && this.prevVisible.size) classes.push('enter');
    if (this.flashIds.has(node.id)) classes.push('relabel');
    const g = svg('g', { class: classes.join(' '), 'data-node-id': node.id, transform: `translate(${(pos.x - w / 2).toFixed(1)},${(pos.y - h / 2).toFixed(1)})` });

    // interaction affordances (not content): dashed selection ring + invisible hit area
    g.append(svg('path', { class: 'sel-ring', 'data-ui': '1', d: S.rect(-12, -9, w + 24, h + 18, rng, { r: 14, passes: 1 }), fill: 'none' }));
    g.append(svg('rect', { class: 'hit-area', 'data-ui': '1', x: -6, y: -4, width: w + 12, height: h + 8, fill: 'transparent' }));
    this.#drawShape(g, style, w, h, rng, pos.side, theme, m);

    const align = ['root', 'section'].includes(node.type) || style.shape !== 'none' && style.shape !== 'underline' || this.options.layout === 'radial' ? 'middle' : pos.side < 0 ? 'end' : 'start';
    const ax = align === 'middle' ? w / 2 : align === 'end' ? w - style.padX : style.padX;
    let y = style.padY;

    const textEl = svg('text', {
      class: 'label',
      'font-family': style.font,
      'font-size': m.size,
      'font-weight': style.weight || 400,
      'font-style': style.italic ? 'italic' : null,
      fill: style.color,
      'text-anchor': align,
    });
    if (style.outline) {
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
    if (m.inline) {
      const baseline = y + m.text.lineHeight * (m.text.lines.length - 1 + 0.78);
      // right-aligned rows (left side of the balanced layout): the timestamp goes before the last line
      const x = align === 'end' ? w - style.padX - (m.text.lines.at(-1)?.w || 0) - 10 - m.inline.w : m.inline.x;
      g.append(this.#chipText(m.inline, x, baseline, theme));
    }
    y += m.text.height;

    if (style.shape === 'underline') {
      const lw = m.text.lines.at(-1)?.w || 0;
      const x1 = align === 'end' ? w - style.padX - lw : align === 'middle' ? (w - lw) / 2 : style.padX;
      g.append(svg('path', { class: 'outline', d: S.squiggle(x1, x1 + lw, y + 2, rng), fill: 'none', stroke: style.stroke || theme.ink, 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
    }

    if (m.summary) {
      y += 6;
      const sEl = svg('text', { class: 'summary', 'font-family': theme.fonts.body, 'font-size': m.summary.size, fill: theme.muted, 'text-anchor': align });
      m.summary.lines.forEach((line, i) => {
        sEl.append(svg('tspan', { x: ax, y: y + m.summary.lineHeight * (i + 0.78) }, line.words.map((wd) => wd.t).join(' ')));
      });
      g.append(sEl);
      y += m.summary.height;
    }

    if (m.chips.length) {
      y += 3;
      const total = m.chips.reduce((s, c) => s + c.w + 10, -10);
      let cx = align === 'middle' ? (w - total) / 2 : align === 'end' ? w - style.padX - total : style.padX;
      for (const chip of m.chips) {
        g.append(this.#chipText(chip, cx, y + 13.5, theme));
        cx += chip.w + 10;
      }
    }

    // expand / collapse / lazy "+": a plain character, no drawn circle
    const hidden = this.#hiddenCount(node);
    const lazy = node.more && !(node.children || []).length;
    if ((hidden || lazy) && node.type !== 'root') {
      const radial = this.options.layout === 'radial';
      const tx = radial ? w / 2 : pos.side < 0 ? -12 : w + 12;
      const ty = radial ? h + 16 : h / 2 + 6;
      const glyph = lazy ? '+' : node.collapsed ? `+${hidden}` : '−';
      g.append(svg('text', {
        class: 'toggle',
        'data-action': lazy ? 'more' : 'toggle',
        'data-ui': '1',
        x: tx,
        y: ty,
        'text-anchor': radial ? 'middle' : pos.side < 0 ? 'end' : 'start',
        'font-size': 17,
        'font-weight': 700,
        'font-family': theme.fonts.body,
        fill: theme.accent,
      }, [glyph, svg('title', {}, lazy ? 'Show more from the video here' : node.collapsed ? 'Expand' : 'Collapse')]));
    }
    return g;
  }

  /** A meta word as plain text: the timestamp is underlined and clickable (seeks the video). */
  #chipText(chip, x, y, theme) {
    const seek = chip.kind === 'seek';
    return svg('text', {
      class: `chip chip-${chip.kind}`,
      'data-action': seek ? 'seek' : null,
      x: Number(x).toFixed(1),
      y: Number(y).toFixed(1),
      'font-family': theme.fonts.body,
      'font-size': META_FONT,
      'font-weight': seek ? 700 : 400,
      'text-decoration': seek ? 'underline' : null,
      fill: seek ? theme.ink : chip.kind === 'mastered' ? theme.accent : theme.muted,
      opacity: 0.9,
    }, seek ? [chip.label, svg('title', {}, 'Play this moment in the video')] : chip.label);
  }

  #drawShape(g, style, w, h, rng, side, theme) {
    const stroke = style.stroke || theme.ink;
    // the hand-drawn outline is the sketch look itself (class "outline"), not node content
    const outline = (d, width = 2.2) => g.append(svg('path', { class: 'outline', d, fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    switch (style.shape) {
      case 'none':
      case 'underline':
        return;
      case 'highlight':
        g.append(svg('path', { class: 'outline', d: S.highlighter(0, h * 0.1, w, h * 0.8, rng), fill: style.fill, opacity: 0.95 }));
        return;
      case 'burst-text':
        outline(S.burstTicks(w / 2, h / 2, w / 2, h / 2, rng), 2.4);
        return;
      default: {
        const dir = side || 1;
        if (style.shadow) g.append(svg('path', { class: 'outline', d: S.fillPath(style.shape, 5, 7, w, h, rng, dir), fill: style.shadow, 'data-export': 'keep' }));
        if (style.fill) g.append(svg('path', { class: 'outline', d: S.fillPath(style.shape, 0, 0, w, h, rng, dir), fill: style.fill }));
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
    if (edge.label && edge.label !== 'related to') { // generic links stay unlabelled: less clutter on a compact map
      this.measureCtx.font = `400 ${META_FONT}px ${theme.fonts.body}`;
      const lw = this.measureCtx.measureText(edge.label).width + 12;
      g.append(svg('rect', { x: conn.mid.x - lw / 2, y: conn.mid.y - 11, width: lw, height: 20, rx: 10, fill: theme.background, opacity: 0.9 }));
      g.append(svg('text', { x: conn.mid.x, y: conn.mid.y + 4.5, 'text-anchor': 'middle', 'font-family': theme.fonts.body, 'font-size': META_FONT, fill: theme.muted }, edge.label));
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
      g.classList.toggle('discussing', this.discussingId === id);
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
        const nodeEl = e.target.closest?.('[data-node-id]');
        const grabbable = nodeEl && !e.target.closest('[data-action]') && this.model.get(nodeEl.dataset.nodeId)?.type !== 'root';
        drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, target: e.target, nodeEl: grabbable ? nodeEl : null };
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
      if (!drag.moved && Math.hypot(dx, dy) < (drag.nodeEl ? 7 : 4)) return;
      drag.moved = true;
      if (drag.nodeEl) {
        this.#dragNode(drag, e, dx, dy);
        return;
      }
      this.container.classList.add('panning');
      this.view.x = drag.vx + dx;
      this.view.y = drag.vy + dy;
      this.#applyView();
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      this.container.classList.remove('panning');
      if (drag?.nodeEl && drag.moved) {
        this.#dropNode(drag, e.type === 'pointercancel');
        drag = null;
        return;
      }
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

  #toWorld(clientX, clientY) {
    const rect = this.container.getBoundingClientRect();
    return { x: (clientX - rect.left - this.view.x) / this.view.k, y: (clientY - rect.top - this.view.y) / this.view.k };
  }

  #dragNode(drag, e, dx, dy) {
    const id = drag.nodeEl.dataset.nodeId;
    const pos = this.positions.get(id);
    const m = this.metrics.get(id);
    if (!drag.started) {
      drag.started = true;
      drag.origin = { x: pos.x - m.w / 2, y: pos.y - m.h / 2 };
      drag.nodeEl.classList.add('dragging');
      this.svgEl.classList.add('drag-active');
      const skip = new Set();
      const collect = (n) => (skip.add(n.id), (n.children || []).forEach(collect));
      collect(this.model.get(id));
      drag.skip = skip;
    }
    const k = this.view.k;
    drag.current = { x: drag.origin.x + dx / k, y: drag.origin.y + dy / k };
    drag.nodeEl.style.transform = `translate(${drag.current.x}px, ${drag.current.y}px)`;
    const world = this.#toWorld(e.clientX, e.clientY);
    drag.world = world;
    let target = null;
    for (const [pid, p] of this.positions) {
      if (drag.skip.has(pid)) continue;
      if (Math.abs(world.x - p.x) <= p.w / 2 + 6 && Math.abs(world.y - p.y) <= p.h / 2 + 6) {
        target = pid;
        break;
      }
    }
    if (target !== drag.target) {
      this.layers.nodes.querySelector('.drop-target')?.classList.remove('drop-target');
      if (target) this.layers.nodes.querySelector(`[data-node-id="${CSS.escape(target)}"]`)?.classList.add('drop-target');
      drag.target = target;
    }
  }

  /** Drop on a node = re-parent; drop beside a sibling = reorder; anywhere else = snap back. */
  #dropNode(drag, cancelled) {
    const id = drag.nodeEl.dataset.nodeId;
    drag.nodeEl.classList.remove('dragging');
    this.svgEl.classList.remove('drag-active');
    this.layers.nodes.querySelector('.drop-target')?.classList.remove('drop-target');
    const parent = this.model.parentOf(id);
    let op = null;
    if (!cancelled && drag.target && drag.target !== parent?.id) {
      const target = this.model.get(drag.target);
      op = { type: 'move', id, parentId: target.id, index: (target.children || []).length };
      if (target.collapsed) this.model.setCollapsed(target.id, false);
    } else if (!cancelled && parent && drag.world) {
      const siblings = this.visibleChildren(parent).filter((c) => c.id !== id && this.positions.has(c.id));
      const near = siblings
        .map((c) => ({ c, p: this.positions.get(c.id) }))
        .sort((a, b) => Math.hypot(a.p.x - drag.world.x, a.p.y - drag.world.y) - Math.hypot(b.p.x - drag.world.x, b.p.y - drag.world.y))[0];
      if (near && Math.abs(near.p.x - drag.world.x) < near.p.w + 80) {
        let after = drag.world.y > near.p.y;
        if (near.p.depth === 1 && near.p.side < 0 && this.options.layout === 'balanced') after = !after; // left side reads bottom→top
        const others = parent.children.filter((c) => c.id !== id);
        const index = others.findIndex((c) => c.id === near.c.id) + (after ? 1 : 0);
        if (parent.children.findIndex((c) => c.id === id) !== index) op = { type: 'move', id, parentId: parent.id, index };
      }
    }
    if (op) this.drawn?.set(id, drag.current); // glide onward from where it was dropped
    if (op && this.model.apply(op).length) {
      this.dispatchEvent(new CustomEvent('moved', { detail: { id, parentId: op.parentId } }));
      return;
    }
    // snap back with the same glide
    const from = drag.nodeEl.style.transform;
    drag.nodeEl.classList.add('gliding');
    requestAnimationFrame(() => (drag.nodeEl.style.transform = `translate(${drag.origin.x}px, ${drag.origin.y}px)`));
    setTimeout(() => {
      drag.nodeEl.classList.remove('gliding');
      drag.nodeEl.style.transform = '';
    }, from ? GLIDE_MS + 40 : 0);
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
      if (action === 'more') {
        this.dispatchEvent(new CustomEvent('more', { detail: { node } }));
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

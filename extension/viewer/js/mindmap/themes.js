/**
 * Themes.
 *
 *  chalk  — Blackboard (DEFAULT): chalk-white strokes and text on a dark green-charcoal board,
 *           yellow chalk for terms, one chalk colour per level-3 tag (Def / Eg / Formula / Tip /
 *           Watch-out). Compact spacing so a whole revision map fits on one screen.
 *  sketch — "sketch-notes" look: off-white paper, plum ink, pastel highlighter
 *           labels behind uppercase headers, a script central idea with radiating
 *           ticks, dashed beige arrows to transcript leaves. Limited 5-colour palette.
 *  doodle — marker doodles on warm yellow paper: the central idea in a cloud,
 *           first-level ideas in varied shapes (sign, arrow, brace box, burst, note,
 *           tent card, heart, circle) with offset shadows and hollow double arrows.
 *
 * Typeface: every theme uses the bundled, highly legible Atkinson Hyperlegible
 * (extension/fonts, loaded by shared/fonts.css). The hand-drawn look comes from the
 * sketch strokes, not the letters. Sizes are chosen so each text's WIDTH matches what
 * the former handwriting fonts produced, which keeps node boxes and layouts unchanged.
 */

export const FONT_READABLE = "'Atkinson Hyperlegible', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const FONT_FACES = ['400 16px', 'italic 400 16px', '700 16px', 'italic 700 16px'].map((f) => `${f} 'Atkinson Hyperlegible'`);
export const FONT_FILES = ['400-normal', '400-italic', '700-normal', '700-italic'].map((f) => `fonts/atkinson-hyperlegible-latin-${f}.woff2`);

const FONT_SCRIPT = FONT_READABLE;
const FONT_HAND = FONT_READABLE;
const FONT_HAND_SC = FONT_READABLE;
const FONT_MARKER = FONT_READABLE;
const FONT_CHALK = FONT_READABLE;

const base = {
  sizes: { root: 40, section: 16.5, concept: 15, detail: 14, transcript: 14 },
  maxWidth: { root: 380, section: 250, concept: 240, detail: 220, transcript: 250 },
  gaps: { h: [0, 120, 80, 56, 48], v: [0, 34, 16, 10, 8] },
  // level-3 type tags ("Def: …", "Eg: …") are coloured text, never icons
  tagColors: { Def: '#3f6fa3', Eg: '#4f7f3a', Formula: '#9c3f6f', Tip: '#a2461d', 'Watch-out': '#b0525e' },
};

export const THEMES = {
  sketch: {
    ...base,
    id: 'sketch',
    name: 'Sketch notes',
    dark: false,
    background: '#fbfaf6',
    ink: '#5b3043',
    text: '#3a2f33',
    muted: '#8a7b7f',
    accent: '#7f9d66',
    paper: '#fffdf8',
    palette: ['#eab8b1', '#a9a8cc', '#9fb888', '#e9dccb', '#b98aa0'],
    paletteText: ['#3a2530', '#2d2945', '#26331d', '#3a3025', '#2c1822'],
    toneColors: { enthusiastic: '#d98b5f', critical: '#b0525e', controversial: '#8e5bb5', cautionary: '#c79a2b', humorous: '#5f9fd9', instructional: '#6f9160', inspirational: '#d07aa0', analytical: '#5d7fa3', skeptical: '#8a6d5a', optimistic: '#6fae8c' },
    fonts: { root: FONT_SCRIPT, section: FONT_HAND_SC, body: FONT_HAND },
    node(node, ctx) {
      switch (node.type) {
        case 'root':
          return { shape: 'burst-text', font: this.fonts.root, size: this.sizes.root, weight: 700, color: '#2f2a2c', outline: '#cfe0c2', padX: 30, padY: 18 };
        case 'section': {
          const i = ctx.color % this.palette.length;
          return { shape: 'highlight', fill: this.palette[i], font: this.fonts.section, size: this.sizes.section, weight: 700, color: this.paletteText[i], upper: true, padX: 14, padY: 6 };
        }
        case 'concept':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.concept, color: this.text, accent: this.accent, padX: 6, padY: 4 };
        case 'transcript':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.transcript, color: this.muted, italic: true, padX: 6, padY: 3 };
        default:
          return { shape: 'none', font: this.fonts.body, size: this.sizes.detail, color: '#4d4044', accent: this.tagColors[node.tag] || this.accent, padX: 6, padY: 3 };
      }
    },
    link(parent, child) {
      if (child.type === 'transcript') return { stroke: '#d9cdbd', width: 2, dash: '5 7', arrow: true };
      if (parent.type === 'root') return { stroke: this.ink, width: 2.6, arrow: true };
      if (parent.type === 'section') return { stroke: this.ink, width: 2.1 };
      return { stroke: '#7a5566', width: 1.6 };
    },
  },

  doodle: {
    ...base,
    sizes: { root: 34, section: 21, concept: 17, detail: 15, transcript: 14 },
    gaps: { h: [0, 130, 84, 58, 48], v: [0, 44, 18, 10, 8] },
    id: 'doodle',
    name: 'Yellow doodle',
    dark: false,
    background: '#f7cd52',
    ink: '#1f1c17',
    text: '#1f1c17',
    muted: '#5d4a1c',
    accent: '#a2461d',
    paper: '#fffdf4',
    shadow: '#e2a322',
    palette: ['#fffdf4', '#fffdf4', '#fffdf4', '#fffdf4', '#fffdf4'],
    paletteText: ['#1f1c17', '#1f1c17', '#1f1c17', '#1f1c17', '#1f1c17'],
    toneColors: { enthusiastic: '#b8401a', critical: '#7c1d1d', controversial: '#5b2a86', cautionary: '#7a5200', humorous: '#1d5c8a', instructional: '#2f5d24', inspirational: '#9c2f63', analytical: '#244a70', skeptical: '#5a4030', optimistic: '#2c6e4f' },
    fonts: { root: FONT_MARKER, section: FONT_MARKER, body: FONT_MARKER },
    shapes: ['sign', 'arrowBox', 'brace', 'circle', 'note', 'burst', 'tent', 'bubble', 'heart', 'banner'],
    node(node, ctx) {
      switch (node.type) {
        case 'root':
          return { shape: 'cloud', fill: this.paper, stroke: this.ink, font: this.fonts.root, size: this.sizes.root, weight: 700, color: this.text, upper: true, padX: 26, padY: 18, shadow: this.shadow };
        case 'section': {
          let shape = this.shapes[ctx.index % this.shapes.length];
          if (shape === 'heart' && (node.text || '').length > 18) shape = 'note';
          if (shape === 'burst' && (node.text || '').length > 24) shape = 'circle';
          return { shape, fill: this.paper, stroke: this.ink, font: this.fonts.section, size: this.sizes.section, color: this.text, padX: 18, padY: 12, shadow: this.shadow };
        }
        case 'concept':
          return { shape: 'underline', stroke: this.ink, font: this.fonts.body, size: this.sizes.concept, color: this.text, accent: this.accent, padX: 6, padY: 5 };
        case 'transcript':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.transcript, color: this.muted, italic: true, padX: 6, padY: 3 };
        default:
          return { shape: 'none', font: this.fonts.body, size: this.sizes.detail, color: this.text, accent: this.tagColors[node.tag] || this.accent, padX: 6, padY: 3 };
      }
    },
    link(parent, child) {
      if (parent.type === 'root') return { stroke: this.ink, width: 2.2, double: true };
      if (child.type === 'transcript') return { stroke: '#6b5520', width: 1.6, dash: '4 6', arrow: true };
      return { stroke: this.ink, width: 2.1, arrow: parent.type === 'section' };
    },
    decorations: 'corners',
  },

  chalk: {
    ...base,
    sizes: { root: 32, section: 18, concept: 16, detail: 15, transcript: 14.5 },
    maxWidth: { root: 320, section: 230, concept: 440, detail: 440, transcript: 260 }, // one-line "Term: meaning" rows
    gaps: { h: [0, 70, 54, 40, 36], v: [0, 16, 6, 5, 5] }, // compact: the whole revision map on one screen
    id: 'chalk',
    name: 'Blackboard',
    dark: true,
    background: '#1f2d27', // dark green-charcoal board
    ink: '#f2f0e6', // chalk white
    text: '#f6f4ec',
    muted: '#b9c4b8',
    accent: '#f5dc8c', // yellow chalk for terms
    paper: '#2a3a33',
    palette: ['#f2f0e6', '#f2f0e6', '#f2f0e6', '#f2f0e6', '#f2f0e6'],
    paletteText: ['#f6f4ec', '#f6f4ec', '#f6f4ec', '#f6f4ec', '#f6f4ec'],
    tagColors: { Def: '#9fd3f2', Eg: '#a8dd9a', Formula: '#f6a9c8', Tip: '#f5dc8c', 'Watch-out': '#ffad85' },
    toneColors: { enthusiastic: '#ffb38a', critical: '#ff8d8d', controversial: '#d4a5ff', cautionary: '#ffd66b', humorous: '#8fd0ff', instructional: '#b6e3a0', inspirational: '#ffa8d2', analytical: '#9cc6ef', skeptical: '#d9b8a0', optimistic: '#9fe0bf' },
    fonts: { root: FONT_CHALK, section: FONT_CHALK, body: FONT_CHALK },
    node(node) {
      switch (node.type) {
        case 'root':
          return { shape: 'circle', stroke: this.ink, font: this.fonts.root, size: this.sizes.root, weight: 700, color: this.text, padX: 22, padY: 16 };
        case 'section':
          return node.recall
            ? { shape: 'box', stroke: this.accent, font: this.fonts.section, size: this.sizes.section, weight: 700, color: this.accent, padX: 14, padY: 8 }
            : { shape: 'box', stroke: this.ink, font: this.fonts.section, size: this.sizes.section, weight: 700, color: this.text, padX: 14, padY: 8 };
        case 'concept':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.concept, color: this.text, accent: this.accent, padX: 6, padY: 3 };
        case 'transcript':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.transcript, color: this.muted, italic: true, padX: 6, padY: 3 };
        default:
          return { shape: 'none', font: this.fonts.body, size: this.sizes.detail, color: '#e3e6dc', accent: this.tagColors[node.tag] || this.accent, padX: 6, padY: 2 };
      }
    },
    link(parent, child) {
      if (child.type === 'transcript') return { stroke: 'rgba(242,240,230,.45)', width: 1.6, dash: '4 7', arrow: true };
      if (parent.type === 'root') return { stroke: this.ink, width: 2.4, arrow: true };
      return { stroke: 'rgba(242,240,230,.85)', width: 1.8 };
    },
  },
};

/** Blackboard is the default; a saved user choice still wins. */
export const DEFAULT_THEME = 'chalk';

export const getTheme = (id) => THEMES[id] || THEMES[DEFAULT_THEME];

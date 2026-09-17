/**
 * Visual themes.
 *
 *  sketch — "sketch-notes" look: off-white paper, plum ink, pastel highlighter
 *           labels behind uppercase headers, a script central idea with radiating
 *           ticks, dashed beige arrows to transcript leaves. Limited 5-colour palette.
 *  doodle — marker doodles on warm yellow paper: the central idea in a cloud,
 *           first-level ideas in varied shapes (sign, arrow, brace box, burst, note,
 *           tent card, heart, circle) with offset shadows and hollow double arrows.
 *  chalk  — dark blackboard variant (good for dark mode).
 */

const FONT_SCRIPT = "'Caveat', 'Segoe Print', 'Bradley Hand', cursive";
const FONT_HAND = "'Patrick Hand', 'Segoe Print', 'Comic Sans MS', cursive";
const FONT_HAND_SC = "'Patrick Hand SC', 'Patrick Hand', 'Segoe Print', cursive";
const FONT_MARKER = "'Gochi Hand', 'Patrick Hand', 'Segoe Print', cursive";
const FONT_CHALK = "'Kalam', 'Patrick Hand', 'Segoe Print', cursive";

export const GOOGLE_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=Gochi+Hand&family=Kalam:wght@400;700&family=Patrick+Hand&family=Patrick+Hand+SC&display=swap';

const base = {
  sizes: { root: 60, section: 23, concept: 18, detail: 16, transcript: 14.5 },
  maxWidth: { root: 380, section: 250, concept: 240, detail: 220, transcript: 250 },
  gaps: { h: [0, 120, 80, 56, 48], v: [0, 34, 16, 10, 8] },
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
          return { shape: 'highlight', fill: this.palette[i], font: this.fonts.section, size: this.sizes.section, weight: 400, color: this.paletteText[i], upper: true, padX: 14, padY: 6 };
        }
        case 'concept':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.concept, color: this.text, accent: this.accent, padX: 6, padY: 4 };
        case 'transcript':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.transcript, color: this.muted, italic: true, padX: 6, padY: 3 };
        default:
          return { shape: 'none', font: this.fonts.body, size: this.sizes.detail, color: '#4d4044', accent: this.accent, padX: 6, padY: 3 };
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
    sizes: { root: 38, section: 24, concept: 19, detail: 16.5, transcript: 14.5 },
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
          return { shape: 'cloud', fill: this.paper, stroke: this.ink, font: this.fonts.root, size: this.sizes.root, color: this.text, upper: true, padX: 26, padY: 18, shadow: this.shadow };
        case 'section': {
          let shape = this.shapes[ctx.index % this.shapes.length];
          if (shape === 'heart' && (node.text || '').length > 18) shape = 'note';
          if (shape === 'burst' && (node.text || '').length > 24) shape = 'circle';
          return { shape, fill: this.paper, stroke: this.ink, font: this.fonts.section, size: this.sizes.section, color: this.text, padX: 18, padY: 12, shadow: this.shadow, badge: ctx.index + 1 };
        }
        case 'concept':
          return { shape: 'underline', stroke: this.ink, font: this.fonts.body, size: this.sizes.concept, color: this.text, accent: this.accent, padX: 6, padY: 5 };
        case 'transcript':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.transcript, color: this.muted, italic: true, padX: 6, padY: 3 };
        default:
          return { shape: 'none', font: this.fonts.body, size: this.sizes.detail, color: this.text, accent: this.accent, padX: 6, padY: 3 };
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
    id: 'chalk',
    name: 'Blackboard',
    dark: true,
    background: '#22302b',
    ink: '#e9e6d8',
    text: '#f3f1e7',
    muted: '#b7c2b5',
    accent: '#f3d98a',
    paper: '#2b3b35',
    palette: ['#f4aaa4', '#b9b6ff', '#a6d69d', '#f1dd9b', '#8fd0e6'],
    paletteText: ['#f4aaa4', '#b9b6ff', '#a6d69d', '#f1dd9b', '#8fd0e6'],
    toneColors: { enthusiastic: '#ffb38a', critical: '#ff8d8d', controversial: '#d4a5ff', cautionary: '#ffd66b', humorous: '#8fd0ff', instructional: '#b6e3a0', inspirational: '#ffa8d2', analytical: '#9cc6ef', skeptical: '#d9b8a0', optimistic: '#9fe0bf' },
    fonts: { root: FONT_CHALK, section: FONT_CHALK, body: FONT_CHALK },
    node(node, ctx) {
      switch (node.type) {
        case 'root':
          return { shape: 'circle', stroke: this.ink, font: this.fonts.root, size: 40, weight: 700, color: this.text, padX: 26, padY: 20 };
        case 'section': {
          const c = this.palette[ctx.color % this.palette.length];
          return { shape: 'box', stroke: c, font: this.fonts.section, size: this.sizes.section, weight: 700, color: c, padX: 16, padY: 9 };
        }
        case 'concept':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.concept - 1, color: this.text, accent: this.accent, padX: 6, padY: 4 };
        case 'transcript':
          return { shape: 'none', font: this.fonts.body, size: this.sizes.transcript - 0.5, color: this.muted, italic: true, padX: 6, padY: 3 };
        default:
          return { shape: 'none', font: this.fonts.body, size: this.sizes.detail - 1, color: '#dcdccf', accent: this.accent, padX: 6, padY: 3 };
      }
    },
    link(parent, child) {
      if (child.type === 'transcript') return { stroke: 'rgba(233,230,216,.45)', width: 1.6, dash: '4 7', arrow: true };
      if (parent.type === 'root') return { stroke: this.ink, width: 2.4, arrow: true };
      return { stroke: 'rgba(233,230,216,.8)', width: 1.8 };
    },
  },
};

export const getTheme = (id) => THEMES[id] || THEMES.sketch;

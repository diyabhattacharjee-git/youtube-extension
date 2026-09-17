/**
 * Adaptive Learning Profiles.
 *
 *  visual   — bigger shapes, video frames on nodes, short labels, summaries hidden
 *  balanced — frames on sections, summaries in the inspector
 *  text     — summaries rendered under every concept, fewer images
 *
 * The profile adapts: interaction signals (opening images, capturing frames, voice,
 * zooming vs. reading summaries, writing notes, Markdown exports, transcript layer)
 * are counted, and when a clear preference emerges the viewer switches (or suggests
 * switching) the profile. The chosen profile is also sent to the backend so the
 * LLM writes shorter visual labels or richer text nodes.
 */

const VISUAL = new Set(['image-open', 'frame-added', 'voice', 'layout-radial', 'theme-doodle', 'zoom']);
const TEXT = new Set(['summary-read', 'notes-written', 'panel-read', 'export-md', 'layer-transcript', 'search']);
const KEY = 'tm-profile-signals';

export class AdaptiveProfile extends EventTarget {
  constructor() {
    super();
    this.signals = { visual: 0, text: 0, lastSuggested: 0 };
    this.ready = chrome.storage.local.get(KEY).then((r) => {
      this.signals = { ...this.signals, ...(r[KEY] || {}) };
    });
  }

  async track(signal) {
    await this.ready;
    if (VISUAL.has(signal)) this.signals.visual += 1;
    else if (TEXT.has(signal)) this.signals.text += 1;
    else return;
    // exponential decay keeps the profile responsive to recent behaviour
    const total = this.signals.visual + this.signals.text;
    if (total > 60) {
      this.signals.visual *= 0.8;
      this.signals.text *= 0.8;
    }
    chrome.storage.local.set({ [KEY]: this.signals });
    this.#evaluate();
  }

  recommended() {
    const { visual, text } = this.signals;
    const total = visual + text;
    if (total < 12) return null;
    if (visual / total > 0.68) return 'visual';
    if (text / total > 0.68) return 'text';
    return 'balanced';
  }

  #evaluate() {
    const profile = this.recommended();
    if (!profile || Date.now() - this.signals.lastSuggested < 10 * 60 * 1000) return;
    this.signals.lastSuggested = Date.now();
    this.dispatchEvent(new CustomEvent('suggest', { detail: { profile } }));
  }
}

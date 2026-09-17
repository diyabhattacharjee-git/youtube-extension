/**
 * Semantic search: instant local fuzzy matching while typing, then (on Enter)
 * embedding-based semantic search on the backend — "entangled particles" finds
 * "Entanglement: linked quantum states" even without shared words.
 */
import { debounce, el, fmtTime, fuzzyScore, plain } from '../lib/util.js';

const TYPE_ICON = { root: '◎', section: '▣', concept: '◆', detail: '•', transcript: '❝' };

export class SearchController {
  constructor({ input, results, model, renderer, api, onPick }) {
    Object.assign(this, { input, results, model, renderer, api, onPick });
    this.items = [];
    this.active = -1;
    input.addEventListener('input', debounce(() => this.local(), 120));
    input.addEventListener('keydown', (e) => this.#keys(e));
    input.addEventListener('focus', () => this.input.value && this.local());
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.search')) this.hide();
    });
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  local() {
    const q = this.input.value.trim();
    if (!q) {
      this.clear();
      return;
    }
    const scored = this.model
      .nodes()
      .map((node) => ({ node, score: Math.max(fuzzyScore(q, node.text), fuzzyScore(q, node.summary) * 0.8, fuzzyScore(q, node.notes) * 0.7) }))
      .filter((r) => r.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    this.show(scored.map((r) => ({ id: r.node.id, score: r.score, via: 'text' })), q);
    this.renderer.setHits(scored.map((r) => r.node.id));
  }

  async semantic() {
    const q = this.input.value.trim();
    if (!q) return;
    if (!this.api.online) {
      this.local();
      return;
    }
    this.results.classList.add('loading');
    try {
      const { results } = await this.api.search(this.model.toJSON(), q, 12);
      const localHits = this.items.filter((i) => !results.some((r) => r.id === i.id));
      const merged = [...results.map((r) => ({ id: r.id, score: r.score, via: 'semantic' })), ...localHits].filter((r) => this.model.get(r.id));
      this.show(merged.slice(0, 12), q);
      this.renderer.setHits(merged.map((r) => r.id));
      if (merged[0]) this.pick(merged[0].id, false);
    } catch {
      this.local();
    } finally {
      this.results.classList.remove('loading');
    }
  }

  show(items, query) {
    this.items = items;
    this.active = items.length ? 0 : -1;
    this.results.replaceChildren(
      ...(items.length
        ? items.map((item, i) => {
            const node = this.model.get(item.id);
            return el(
              'button',
              { class: `result ${i === this.active ? 'active' : ''}`, onclick: () => this.pick(item.id) },
              [
                el('span', { class: 'result-icon', title: node.type }, TYPE_ICON[node.type] || '•'),
                el('span', { class: 'result-text' }, highlight(plain(node.text), query)),
                node.start !== null && node.start !== undefined ? el('span', { class: 'result-ts' }, fmtTime(node.start)) : null,
                item.via === 'semantic' ? el('span', { class: 'result-via', title: 'semantic match' }, '≈') : null,
              ],
            );
          })
        : [el('div', { class: 'result-empty' }, 'No match — press Enter for semantic search')]),
    );
    this.results.hidden = false;
  }

  pick(id, close = true) {
    this.renderer.reveal(id);
    this.renderer.select(id);
    this.renderer.centerOn(id, { zoom: Math.max(this.renderer.view.k, 0.85) });
    this.onPick?.(id);
    if (close) this.hide();
  }

  hide() {
    this.results.hidden = true;
  }

  clear() {
    this.items = [];
    this.renderer.setHits([]);
    this.hide();
  }

  #keys(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.altKey || !this.items.length || this.results.hidden) this.semantic();
      else if (this.active >= 0) this.pick(this.items[this.active].id);
    } else if (e.key === 'Escape') {
      this.input.value = '';
      this.clear();
      this.input.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.items.length) return;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
      [...this.results.children].forEach((c, i) => c.classList.toggle('active', i === this.active));
    }
  }
}

function highlight(text, query) {
  const frag = document.createDocumentFragment();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  text.split(re).forEach((part, i) => frag.append(i % 2 ? el('mark', {}, part) : part));
  return frag;
}

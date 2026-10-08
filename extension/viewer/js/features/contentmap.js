/**
 * Content map — the whole video as a numbered revision outline, readable in under a minute.
 * It replaces the old Overview and Transcript views (YouTube already shows both).
 *
 *   Topic + "In one line"
 *   Quick recall      3–6 must-remember points
 *   Jump to           every section: click = focus its node on the map + play the video there
 *   1. Section title  12:40–18:05
 *      1–2 line summary (summary retriever, rewritten by the AI) · key terms
 *      Term: meaning
 *        Def / Eg / Formula / Tip / Watch-out lines
 *
 * Selecting a node on the map highlights its entry here, and the reverse.
 * `outline(map)` is pure (no DOM): the Markdown export and the tests use it too.
 */
import { el, fmtTime, plain } from './shared.js';

const PREF_KEY = 'tm-content-map-open';

/** Plain data for the outline of a map. */
export function outline(map) {
  const root = map?.root || { children: [] };
  const sections = (root.children || []).filter((s) => s.type === 'section');
  const recall = sections.find((s) => s.recall);
  const untag = (node) => {
    const text = plain(node.text);
    return node.tag && text.startsWith(`${node.tag}:`) ? text.slice(node.tag.length + 1).trim() : text;
  };
  const item = (node) => ({ id: node.id, text: plain(node.text), start: node.start ?? null });
  return {
    topic: plain(root.text),
    oneLine: plain(recall?.summary || root.summary || ''),
    recall: recall ? (recall.children || []).filter((c) => !c.oneline).map(item) : [],
    sections: sections
      .filter((s) => !s.recall)
      .map((s, i) => {
        const concepts = (s.children || []).filter((c) => c.type === 'concept');
        const terms = [...new Set(concepts.map((c) => plain(c.text).split(':')[0].trim()).filter(Boolean))].slice(0, 5);
        return {
          ...item(s),
          title: plain(s.text),
          n: i + 1,
          end: s.end ?? null,
          summary: plain(s.summary || ''),
          terms: terms.length ? terms : (s.keywords || []).slice(0, 5),
          concepts: concepts.map((c) => ({
            ...item(c),
            items: (c.children || []).filter((d) => d.type === 'detail').map((d) => ({ ...item(d), tag: d.tag || null, text: untag(d) })),
          })),
        };
      }),
  };
}

export function timeRange(start, end) {
  if (start === null || start === undefined) return '';
  return end !== null && end !== undefined && end > start ? `${fmtTime(start)}–${fmtTime(end)}` : fmtTime(start);
}

export class ContentMap {
  constructor({ host, stage, toggle, model, renderer, seek }) {
    Object.assign(this, { host, stage, toggle, model, renderer, seek });
    renderer.addEventListener('select', (e) => this.highlight(e.detail.ids));
    model.addEventListener('load', () => this.render());
    model.addEventListener('change', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.render(), 120);
    });
    toggle.addEventListener('click', () => this.setOpen(!this.open));
    let saved = null;
    try {
      saved = localStorage.getItem(PREF_KEY);
    } catch {
      /* storage blocked: open by default */
    }
    this.setOpen(saved !== '0', { fit: false });
  }

  setOpen(open, { fit = true } = {}) {
    this.open = open;
    this.host.hidden = !open;
    this.stage.classList.toggle('cm-open', open);
    this.toggle.setAttribute('aria-pressed', String(open));
    try {
      localStorage.setItem(PREF_KEY, open ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
    if (fit && this.model.map) requestAnimationFrame(() => this.renderer.fit());
  }

  render() {
    const map = this.model.map;
    if (!map) {
      this.host.replaceChildren();
      return;
    }
    const scroll = this.host.querySelector('.cm-body')?.scrollTop || 0;
    const o = outline(map);
    const time = (node, start, end) =>
      start === null || start === undefined ? null : el('button', { class: 'cm-time', title: 'Play this moment in the video', onclick: (e) => (e.stopPropagation(), this.#focus(node, { play: true })) }, timeRange(start, end));
    const entry = (cls, id, children, { play = false, after = null } = {}) =>
      el('li', { class: cls, dataset: { nodeId: id } }, [el('button', { class: 'cm-entry', onclick: () => this.#focus(id, { play }) }, children), after]);

    const body = el('div', { class: 'cm-body' }, [
      el('div', { class: 'cm-topic' }, [el('h2', {}, o.topic), o.oneLine ? el('p', { class: 'cm-oneline' }, [el('b', {}, 'In one line: '), o.oneLine.replace(/^In one line:\s*/i, '')]) : null]),
      o.recall.length
        ? el('section', { class: 'cm-block cm-recall' }, [
            el('h3', {}, 'Quick recall'),
            el('ul', {}, o.recall.map((r) => entry('cm-point', r.id, r.text, { after: time(r.id, r.start) }))),
          ])
        : null,
      el('section', { class: 'cm-block cm-jump' }, [
        el('h3', {}, 'Jump to'),
        el('ol', { class: 'cm-jump-list' }, o.sections.map((s) => entry('cm-jump-item', s.id, `${s.n}. ${s.title}`, { play: true }))),
      ]),
      el('ol', { class: 'cm-sections' }, o.sections.map((s) =>
        el('li', { class: 'cm-section', dataset: { nodeId: s.id } }, [
          el('div', { class: 'cm-sec-head' }, [
            el('button', { class: 'cm-entry cm-title', onclick: () => this.#focus(s.id, { play: true }) }, [el('span', { class: 'cm-num' }, `${s.n}.`), s.title]),
            time(s.id, s.start, s.end),
          ]),
          s.summary ? el('p', { class: 'cm-summary' }, s.summary) : null,
          s.terms.length ? el('p', { class: 'cm-terms' }, [el('span', {}, 'Key terms: '), s.terms.join(' · ')]) : null,
          el('ul', { class: 'cm-concepts' }, s.concepts.map((c) => {
            const [term, ...rest] = c.text.split(':');
            const li = entry('cm-concept', c.id, rest.length ? [el('b', {}, `${term.trim()}:`), ` ${rest.join(':').trim()}`] : c.text);
            if (c.items.length) {
              li.append(el('ul', { class: 'cm-items' }, c.items.map((d) =>
                entry('cm-item', d.id, [d.tag ? el('span', { class: `cm-tag tag-${d.tag.toLowerCase()}` }, d.tag) : null, d.text]),
              )));
            }
            return li;
          })),
        ]),
      )),
    ]);
    this.host.replaceChildren(
      el('header', { class: 'cm-head' }, [
        el('strong', {}, 'Content map'),
        el('button', { class: 'icon-btn', title: 'Hide the content map', 'aria-label': 'Hide the content map', onclick: () => this.setOpen(false) }, '×'),
      ]),
      body,
    );
    body.scrollTop = scroll;
    this.highlight([...this.renderer.selection]);
  }

  /** Map → content map: mark the entries of the selected nodes and scroll the last one into view. */
  highlight(ids) {
    const wanted = new Set(ids);
    let last = null;
    for (const li of this.host.querySelectorAll('[data-node-id]')) {
      const on = wanted.has(li.dataset.nodeId);
      li.classList.toggle('cm-active', on);
      if (on && !li.classList.contains('cm-jump-item')) last = li;
    }
    last?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Content map → map: select and centre the node; sections (and timestamps) also play the video. */
  #focus(id, { play = false } = {}) {
    const node = this.model.get(id);
    if (!node) return;
    const shown = this.renderer.reveal(id);
    this.renderer.select(shown);
    this.renderer.centerOn(shown, { zoom: Math.max(this.renderer.view.k, 0.8) });
    if (play && node.start !== null && node.start !== undefined) this.seek(node);
  }
}

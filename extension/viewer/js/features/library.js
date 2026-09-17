/**
 * Library of saved mindmaps + Cross-Video Knowledge Linking.
 *   • open / delete / import maps
 *   • select several videos → "Link knowledge" builds a Knowledge Hub map where
 *     overlapping concepts from different videos are merged, each leaf jumping to
 *     its own video moment
 *   • "Merge maps" unifies several maps (e.g. two students' versions) into one
 */
import { deleteMap, getMap, listMaps, saveMap } from '../lib/storage.js';
import { el, modal, toast } from './shared.js';

export class Library {
  constructor({ api, openMap }) {
    Object.assign(this, { api, openMap });
  }

  async open() {
    const { body, close } = modal('📚 My mindmaps', { wide: true });
    this.close = close;
    this.body = body;
    await this.#render();
  }

  async #render() {
    const maps = await listMaps();
    const selected = new Set();
    const actions = el('div', { class: 'panel-row wrap library-actions' });
    const refreshActions = () => {
      actions.replaceChildren(
        el('button', { class: 'btn btn-small', onclick: () => this.#import() }, '⬆ Import JSON'),
        el('button', { class: 'btn btn-small', disabled: selected.size < 2 ? true : null, title: 'Find shared concepts across videos', onclick: () => this.#link([...selected]) }, `🔗 Link knowledge (${selected.size})`),
        el('button', { class: 'btn btn-small', disabled: selected.size < 2 ? true : null, onclick: () => this.#merge([...selected]) }, `⊕ Merge maps (${selected.size})`),
        el('button', { class: 'btn btn-small btn-danger', disabled: selected.size < 1 ? true : null, onclick: () => this.#delete([...selected]) }, '🗑 Delete'),
      );
    };
    refreshActions();

    const list = maps.length
      ? el(
          'ul',
          { class: 'library-list' },
          maps.map((m) => {
            const box = el('input', { type: 'checkbox', 'aria-label': `Select ${m.title}` });
            box.addEventListener('change', () => {
              if (box.checked) selected.add(m.id);
              else selected.delete(m.id);
              refreshActions();
            });
            return el('li', { class: 'library-item' }, [
              box,
              m.videoId ? el('img', { src: `https://i.ytimg.com/vi/${m.videoId}/mqdefault.jpg`, alt: '', loading: 'lazy' }) : el('div', { class: 'library-thumb' }, m.kind === 'hub' ? '🕸' : '🧠'),
              el('div', { class: 'library-meta' }, [
                el('strong', {}, m.title),
                el('small', {}, [m.channel, m.mode, `${m.nodeCount} nodes`, m.roomId ? `room ${m.roomId}` : '', new Date(m.updatedAt).toLocaleString()].filter(Boolean).join(' · ')),
              ]),
              el('button', {
                class: 'btn btn-small',
                onclick: async () => {
                  this.close();
                  this.openMap(await getMap(m.id));
                },
              }, 'Open'),
            ]);
          }),
        )
      : el('p', { class: 'hint' }, 'No saved mindmaps yet. Generate one from a YouTube video or open the demo.');
    this.body.replaceChildren(actions, list);
  }

  async #import() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const map = JSON.parse(await file.text());
        if (!map.root) throw new Error('Not a TubeMind mindmap');
        await saveMap(map);
        this.close();
        this.openMap(map);
      } catch (err) {
        toast(`Import failed: ${err.message}`, { type: 'error' });
      }
    };
    input.click();
  }

  async #link(ids) {
    if (!this.api.online) return toast('Cross-video linking needs the backend.', { type: 'error' });
    const maps = (await Promise.all(ids.map(getMap))).filter(Boolean);
    const busy = toast('🔗 Finding shared concepts across videos…', { timeout: 60000 });
    try {
      const { links, hub } = await this.api.link(maps);
      if (!hub || !links.length) {
        toast('No overlapping concepts found between these videos.');
        return;
      }
      // remember links on each source map for later reference
      for (const map of maps) {
        map.meta.crossVideoLinks = links.filter((l) => l.a.mapId === map.id || l.b.mapId === map.id).length;
        await saveMap(map);
      }
      await saveMap(hub);
      this.close();
      this.openMap(hub);
      toast(`Knowledge Hub: ${hub.root.children.length} shared concepts from ${links.length} links`, { type: 'success' });
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      busy.remove();
    }
  }

  async #merge(ids) {
    if (!this.api.online) return toast('Merging needs the backend.', { type: 'error' });
    const maps = (await Promise.all(ids.map(getMap))).filter(Boolean);
    try {
      const { map } = await this.api.merge(maps);
      await saveMap(map);
      this.close();
      this.openMap(map);
      toast('Maps merged ✓', { type: 'success' });
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  async #delete(ids) {
    if (!confirm(`Delete ${ids.length} mindmap(s)? This cannot be undone.`)) return;
    await Promise.all(ids.map(deleteMap));
    await this.#render();
  }
}

/**
 * Node inspector (right-hand panel): edit text & summary, notes, external links,
 * images (storyboard / captured frame / upload), tone tags, timestamps,
 * cross-links and AI refinement for the selected node(s).
 */
import { captureCurrentFrame, currentVideoTime, pickImageFile, storyboardFrame } from './frames.js';
import { REFINE_ACTIONS, runRefine } from './refine.js';
import { el, fmtTime, isHttpUrl, plain, toast } from './shared.js';

const TONES = ['enthusiastic', 'critical', 'controversial', 'cautionary', 'humorous', 'instructional', 'inspirational', 'analytical', 'skeptical', 'optimistic'];
const TYPE_LABEL = { root: 'Central idea', section: 'Section · overview layer', concept: 'Concept · cluster layer', detail: 'Detail', transcript: 'Transcript leaf' };

export class InspectorPanel {
  constructor({ host, model, renderer, api, seek, gamify, profile }) {
    Object.assign(this, { host, model, renderer, api, seek, gamify, profile });
    this.ids = [];
    renderer.addEventListener('select', (e) => this.show(e.detail.ids));
    model.addEventListener('change', (e) => {
      if (e.detail.origin !== 'local-panel' && this.ids.length) this.#refreshSoon();
    });
    model.addEventListener('load', () => this.show([]));
  }

  #refreshSoon() {
    if (this.host.contains(document.activeElement) && document.activeElement.matches('textarea, input')) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.show(this.ids), 60);
  }

  show(ids) {
    this.ids = ids.filter((id) => this.model.get(id));
    if (!this.ids.length) {
      this.host.hidden = true;
      return;
    }
    this.host.hidden = false;
    this.openedAt = performance.now();
    const node = this.model.get(this.ids.at(-1));
    this.host.replaceChildren(this.#render(node));
  }

  close() {
    if (this.openedAt && performance.now() - this.openedAt > 6000) this.profile?.track('panel-read');
    this.renderer.select([]);
  }

  #commit(id, patch) {
    this.model.apply({ type: 'update', id, patch }, { origin: 'local' });
  }

  #render(node) {
    const meta = this.model.meta || {};
    const videoId = node.videoId || meta.videoId;
    const frag = document.createDocumentFragment();

    frag.append(
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'panel-type' }, TYPE_LABEL[node.type] || node.type),
        el('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => this.close() }, '✕'),
      ]),
    );

    if (this.ids.length > 1) frag.append(el('p', { class: 'panel-multi' }, `${this.ids.length} nodes selected — Merge or add a cross-link below.`));

    // --- text ---------------------------------------------------------------
    const title = el('textarea', { class: 'panel-title', rows: 2, 'aria-label': 'Node text' });
    title.value = node.text;
    title.addEventListener('change', () => title.value.trim() && this.#commit(node.id, { text: title.value.trim() }));
    frag.append(title);

    const summary = el('textarea', { class: 'panel-summary', rows: 3, placeholder: 'Summary / explanation…' });
    summary.value = node.summary || '';
    summary.addEventListener('change', () => this.#commit(node.id, { summary: summary.value.trim() }));
    summary.addEventListener('focus', () => this.profile?.track('summary-read'));
    frag.append(summary);

    // --- timestamp ------------------------------------------------------------
    const tsRow = el('div', { class: 'panel-row' });
    if (node.start !== null && node.start !== undefined) {
      tsRow.append(el('button', { class: 'btn btn-accent', onclick: () => this.seek(node) }, `▶ Watch at ${fmtTime(node.start)}`));
    }
    if (videoId) {
      tsRow.append(
        el('button', {
          class: 'btn btn-ghost',
          title: 'Use the current playback time of the YouTube tab',
          onclick: async () => {
            const t = await currentVideoTime(videoId);
            if (t === null) toast('Open the video in a YouTube tab first.');
            else this.#commit(node.id, { start: Math.round(t * 10) / 10 });
          },
        }, '⏱ Set to now'),
      );
    }
    if (tsRow.children.length) frag.append(tsRow);
    if (node.videoId && node.videoId !== meta.videoId) frag.append(el('p', { class: 'panel-note' }, '🔗 From another video in the Knowledge Hub.'));

    // --- tone -------------------------------------------------------------------
    frag.append(el('h4', {}, 'Tone'));
    frag.append(
      el(
        'div',
        { class: 'chips' },
        TONES.map((tone) => {
          const on = (node.tone || []).includes(tone);
          return el('button', {
            class: `chip ${on ? 'on' : ''} tone-${tone}`,
            onclick: () => this.#commit(node.id, { tone: on ? node.tone.filter((t) => t !== tone) : [...(node.tone || []), tone].slice(-3) }),
          }, tone);
        }),
      ),
    );

    // --- image --------------------------------------------------------------------
    frag.append(el('h4', {}, 'Visual'));
    const imgBox = el('div', { class: 'panel-image' });
    if (node.image?.src) {
      imgBox.append(
        el('img', { src: node.image.src, alt: 'Frame from the video', onclick: () => this.profile?.track('image-open') }),
        el('small', {}, `${node.image.source || 'image'}${node.image.t ? ` @ ${fmtTime(node.image.t)}` : ''}`),
      );
    }
    const imgActions = el('div', { class: 'panel-row wrap' });
    if (meta.storyboardSpec && node.start !== null && node.start !== undefined) {
      imgActions.append(
        el('button', {
          class: 'btn btn-small',
          onclick: async () => {
            try {
              const src = await storyboardFrame(meta.storyboardSpec, meta.duration, node.start + 2);
              this.#commit(node.id, { image: { src, t: node.start + 2, source: 'storyboard' } });
              this.profile?.track('frame-added');
            } catch (err) {
              toast(err.message, { type: 'error' });
            }
          },
        }, '🎞 Storyboard'),
      );
    }
    if (videoId) {
      imgActions.append(
        el('button', {
          class: 'btn btn-small',
          title: 'Grab the frame currently shown in the YouTube tab',
          onclick: async () => {
            try {
              this.#commit(node.id, { image: await captureCurrentFrame(videoId) });
              this.profile?.track('frame-added');
            } catch (err) {
              toast(err.message, { type: 'error' });
            }
          },
        }, '📸 Capture frame'),
      );
    }
    imgActions.append(
      el('button', {
        class: 'btn btn-small',
        onclick: async () => {
          const image = await pickImageFile();
          if (image) this.#commit(node.id, { image });
        },
      }, '⬆ Upload'),
    );
    if (node.image) imgActions.append(el('button', { class: 'btn btn-small btn-ghost', onclick: () => this.#commit(node.id, { image: null }) }, 'Remove'));
    imgBox.append(imgActions);
    frag.append(imgBox);

    // --- notes -------------------------------------------------------------------------
    frag.append(el('h4', {}, 'My notes'));
    const notes = el('textarea', { class: 'panel-notes', rows: 4, placeholder: 'Write your own notes, questions, examples…' });
    notes.value = node.notes || '';
    let notesTimer;
    notes.addEventListener('input', () => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => {
        if (notes.value !== (node.notes || '')) {
          const firstNote = !node.notes;
          this.#commit(node.id, { notes: notes.value });
          if (firstNote) {
            this.gamify?.track('note_added');
            this.profile?.track('notes-written');
          }
        }
      }, 700);
    });
    frag.append(notes);

    // --- links -----------------------------------------------------------------------------
    frag.append(el('h4', {}, 'Links'));
    const list = el(
      'ul',
      { class: 'panel-links' },
      (node.links || []).map((link, i) =>
        el('li', {}, [
          el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.title || link.url),
          el('button', { class: 'icon-btn', title: 'Remove link', onclick: () => this.#commit(node.id, { links: node.links.filter((_, j) => j !== i) }) }, '✕'),
        ]),
      ),
    );
    const urlInput = el('input', { type: 'url', placeholder: 'https://…' });
    const titleInput = el('input', { type: 'text', placeholder: 'Title (optional)' });
    const addLink = () => {
      const url = urlInput.value.trim();
      if (!isHttpUrl(url)) {
        toast('Enter a valid http(s) link.', { type: 'error' });
        return;
      }
      this.#commit(node.id, { links: [...(node.links || []), { url, title: titleInput.value.trim() }] });
      this.gamify?.track('link_added');
    };
    urlInput.addEventListener('keydown', (e) => e.key === 'Enter' && addLink());
    frag.append(list, el('div', { class: 'panel-row link-form' }, [urlInput, titleInput, el('button', { class: 'btn btn-small', onclick: addLink }, 'Add')]));

    // --- structure -------------------------------------------------------------------------------
    frag.append(el('h4', {}, 'Structure'));
    const structure = el('div', { class: 'panel-row wrap' }, [
      el('button', { class: 'btn btn-small', onclick: () => this.#addChild(node) }, '＋ Child (Tab)'),
      node.type !== 'root' ? el('button', { class: 'btn btn-small', onclick: () => this.#addSibling(node) }, '＋ Sibling (Enter)') : null,
      node.type !== 'root' ? el('button', { class: 'btn btn-small btn-danger', onclick: () => this.model.remove(this.ids) }, '🗑 Delete') : null,
    ]);
    if (this.ids.length === 2) {
      structure.append(
        el('button', {
          class: 'btn btn-small',
          onclick: () => {
            const label = prompt('Relationship label (e.g. "leads to", "contrasts with")', 'related to');
            if (label !== null) this.model.addEdge(this.ids[0], this.ids[1], label || 'related to');
          },
        }, '⤳ Cross-link'),
      );
    }
    frag.append(structure);

    // --- AI -------------------------------------------------------------------------------------------
    frag.append(el('h4', {}, `AI refinement ${this.api.online ? `· ${this.api.health?.llm || ''}` : '· offline'}`));
    const instruction = el('input', { type: 'text', class: 'panel-instruction', placeholder: 'Optional instruction, e.g. "add real-world examples"' });
    frag.append(instruction);
    frag.append(
      el(
        'div',
        { class: 'panel-row wrap' },
        REFINE_ACTIONS.map((action) =>
          el('button', {
            class: 'btn btn-small btn-ai',
            title: action.hint,
            disabled: this.ids.length < action.min ? true : null,
            onclick: () => runRefine({ api: this.api, model: this.model, action: action.id, ids: this.ids, instruction: instruction.value, gamify: this.gamify, renderer: this.renderer }),
          }, `${action.icon} ${action.label}`),
        ),
      ),
    );

    if (node.sources?.length > 1) {
      frag.append(el('h4', {}, 'Merged from'), el('ul', { class: 'panel-sources' }, node.sources.map((s) => el('li', {}, `${s.videoId || 'map'} ${s.start !== null && s.start !== undefined ? `@ ${fmtTime(s.start)}` : ''}`))));
    }
    frag.append(el('p', { class: 'panel-foot' }, `${(node.children || []).length} children · layer ${node.layer ?? 0} · ${plain(node.text).length} chars`));
    return frag;
  }

  #addChild(node) {
    const child = this.model.addChild(node.id);
    this.renderer.render();
    this.renderer.select(child.id);
    this.renderer.startEdit(child.id);
    this.gamify?.track('node_added');
  }

  #addSibling(node) {
    const sibling = this.model.addSibling(node.id);
    this.renderer.render();
    this.renderer.select(sibling.id);
    this.renderer.startEdit(sibling.id);
    this.gamify?.track('node_added');
  }
}

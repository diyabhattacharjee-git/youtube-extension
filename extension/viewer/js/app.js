/**
 * TubeMind viewer — application shell.
 *
 * Data flow:
 *   YouTube tab (content script) → service worker → this page
 *   → backend: complete map built from the transcript (returned at once, no AI)
 *   → MindMapModel → MindMapRenderer → interaction features → collaboration
 *   → optional single AI call that renames labels, applied later as `update` ops
 */
import { MODE_LABELS, getSettings, onSettingsChanged, parseVideoId, saveSettings } from '../../shared/settings.js';
import { Assistant } from './features/assistant.js';
import { ContentMap } from './features/contentmap.js';
import { attachStoryboardFrames } from './features/frames.js';
import { exportActions } from './features/export.js';
import { CollabClient } from './features/collab.js';
import { Gamify } from './features/gamify.js';
import { Library } from './features/library.js';
import { InspectorPanel } from './features/panel.js';
import { REFINE_ACTIONS, runRefine } from './features/refine.js';
import { SearchController } from './features/search.js';
import { StudyMode } from './features/study.js';
import { VoiceController } from './features/voice.js';
import { Api } from './lib/api.js';
import { getMap, listMaps, saveMap } from './lib/storage.js';
import { $, $$, debounce, el, fmtTime, modal, toast } from './lib/util.js';
import { MindMapModel, createNode } from './mindmap/model.js';
import { MindMapRenderer } from './mindmap/renderer.js';
import { DEFAULT_THEME, FONT_FACES, THEMES, getTheme } from './mindmap/themes.js';

// What the map shows. Sections + "Quick recall" are always there; the Content map panel is the
// outline view (the old Overview and Transcript views are gone: YouTube already has both).
const LAYERS = [
  { label: 'Concepts', max: 2, key: '1', hint: 'Sections + key concepts (Term: meaning)' },
  { label: 'Details', max: 3, key: '2', hint: '+ Def / Eg / Formula / Tip / Watch-out lines' },
];
const MODES = MODE_LABELS; // Short / Standard / Detailed (internal values revision / academic / deep)
const LAYOUTS = { balanced: 'Balanced (clockwise)', right: 'Logical tree', radial: 'Radial' };
const STEPS = ['Reading the video', 'Building your map', 'Polishing'];

/** The renderer measures text with canvas: the bundled fonts must be ready before the first layout. */
async function fontsReady() {
  try {
    await Promise.all(FONT_FACES.map((face) => document.fonts.load(face)));
    await document.fonts.ready;
  } catch {
    /* system fallback fonts are measured instead */
  }
}

async function main() {
  let settings = await getSettings();
  const setDev = (on) => document.documentElement.classList.toggle('dev', !!on);
  setDev(settings.devMode);
  // blackboard chrome from the first paint (a saved theme choice still wins)
  document.documentElement.dataset.canvasTheme = getTheme(settings.theme).id;
  await fontsReady();
  const api = new Api(settings.backendUrl);
  const model = new MindMapModel();
  const renderer = new MindMapRenderer($('#canvas'), model, {
    theme: settings.theme || DEFAULT_THEME,
    layout: settings.layout,
    maxLayer: 3, // concepts start collapsed: each shows "+N" for its Def / Eg / Formula / Tip / Watch-out lines
  });
  // If a face arrives late (or the user zooms to a size whose glyphs load lazily), re-measure.
  document.fonts.addEventListener('loadingdone', () => renderer.remeasure());

  const seek = (node) => {
    const videoId = node.videoId || model.meta?.videoId;
    if (!videoId) return toast('This map is not linked to a video.');
    if (node.start === null || node.start === undefined) return toast('This node has no timestamp.');
    chrome.runtime.sendMessage({ type: 'TM_SEEK', videoId, seconds: node.start });
  };

  const gamify = new Gamify({ model, renderer, hud: $('#hud') });
  const collab = new CollabClient({ api, model, renderer, settings });
  gamify.attachCollab(collab);
  const study = new StudyMode({ api, model, renderer, seek, gamify });
  const assistant = new Assistant({ host: $('#assistant'), model, renderer, api, seek });
  const ask = (id) => assistant.open(id);
  new InspectorPanel({ host: $('#inspector'), model, renderer, api, seek, gamify, ask });
  new ContentMap({ host: $('#content-map'), stage: $('#stage'), toggle: $('#btn-content-map'), model, renderer, seek });
  const search = new SearchController({ input: $('#search'), results: $('#search-results'), model, renderer, api });
  const setLayer = (max) => {
    renderer.setOptions({ maxLayer: max });
    if (max >= 3) expandAll(); // "Details" shows the whole map: no concept stays folded behind "+N"
    renderer.fit();
    syncLayerButtons();
  };
  /** Unfold every collapsed node (a view change only: not undoable, not sent to collaborators). */
  function expandAll() {
    if (!model.map) return;
    const ops = model.nodes().filter((n) => n.collapsed).map((n) => ({ type: 'update', id: n.id, patch: { collapsed: false } }));
    if (ops.length) model.apply(ops);
  }
  const voice = new VoiceController({ model, renderer, seek, search: (q) => ((search.input.value = q), search.semantic()), setLayer, lang: settings.voiceLang, indicator: $('#voice-indicator') });
  const library = new Library({ api, openMap });

  // -------------------------------------------------------------------------
  // Map lifecycle
  // -------------------------------------------------------------------------
  function openMap(map, { save = true } = {}) {
    model.load(map);
    $('#empty-state').hidden = true;
    $('#map-title').value = map.meta?.title || map.root.text;
    document.title = `${map.meta?.title || 'Mindmap'} · TubeMind`;
    renderMeta();
    const params = new URLSearchParams(location.search);
    if (!params.get('room')) history.replaceState(null, '', `?map=${map.id}`);
    if (save) saveMap(model.toJSON());
    study.loadProgress();
    setTimeout(() => renderer.fit(), 50);
  }

  function renderMeta() {
    const meta = model.meta || {};
    const link = $('#video-link');
    if (meta.videoId) {
      link.hidden = false;
      link.href = `https://www.youtube.com/watch?v=${meta.videoId}`;
      link.textContent = `▶ ${meta.channel || 'YouTube'}${meta.duration ? ` · ${fmtTime(meta.duration)}` : ''}`;
    } else link.hidden = true;
    const dev = settings.devMode; // pipeline internals only for developers
    const chips = [
      meta.kind === 'hub' ? '🕸 Knowledge Hub' : null,
      dev && meta.mode ? `${MODES[meta.mode] || meta.mode} (${meta.mode})` : null,
      dev && meta.llm ? `✦ ${meta.llm}` : null,
      dev && meta.transcriptSource ? `❝ ${meta.transcriptSource}` : null,
      dev && meta.buildSeconds !== undefined ? `⏱ ${meta.buildSeconds}s` : null,
      dev && meta.sample ? '🧪 sample data' : null,
    ].filter(Boolean);
    $('#meta-chips').replaceChildren(...chips.map((c) => el('span', { class: 'meta-chip' }, c)));
  }

  const autosave = debounce(() => model.map && saveMap(model.toJSON()), 900);
  model.addEventListener('change', (e) => {
    autosave();
    if (!e.detail.localOnly && e.detail.origin === 'local') {
      if (e.detail.ops.some((o) => o.type === 'update' && 'text' in (o.patch || {}))) gamify.track('node_edited');
    }
  });

  $('#map-title').addEventListener('change', (e) => {
    if (!model.map) return;
    model.map.meta.title = e.target.value.trim() || model.root.text;
    autosave();
  });

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------
  async function generate(context) {
    const overlay = $('#progress-overlay');
    $('#empty-state').hidden = true;
    $('#progress-title').textContent = context.title || 'Your video';
    const steps = $('#progress-steps');
    steps.replaceChildren(...STEPS.map((label) => el('li', {}, label)));
    const bar = $('#progress-bar span');
    const setStep = (index, pct, detail = '') => {
      bar.style.width = `${Math.round(pct * 100)}%`;
      $('#progress-stage').textContent = `${STEPS[index]}…`;
      $('#progress-detail').textContent = detail; // backend stage names: developer mode only
      [...steps.children].forEach((li, i) => (li.className = i < index ? 'done' : i === index ? 'active' : ''));
    };
    // Only show the progress card if the map is not there almost instantly (cache / prefetch hits).
    const overlayTimer = setTimeout(() => (overlay.hidden = false), 180);
    const finishOverlay = () => {
      clearTimeout(overlayTimer);
      overlay.hidden = true;
    };
    setStep(0, 0.05);

    await (api.online ? Promise.resolve() : api.checkHealth());
    renderHealth();
    if (!api.online) {
      finishOverlay();
      showBackendHelp(context);
      return;
    }
    try {
      const payload = {
        videoId: context.videoId,
        title: context.title,
        channel: context.channel,
        description: context.description,
        duration: context.duration,
        chapters: context.chapters,
        transcript: context.transcript,
        languages: context.languages,
        storyboardSpec: context.storyboardSpec,
        mode: context.mode || settings.mode,
        useLLM: settings.useLLM,
        allowWhisper: settings.allowWhisper,
        frames: settings.serverKeyframes,
        noCache: !!context.noCache,
      };
      const started = performance.now();
      let res = await api.startJob(payload);
      if (!res.map) {
        // slow path (e.g. speech-to-text): long-poll until the map exists
        setStep(1, 0.4);
        const job = await api.waitJob(res.jobId, { onProgress: (j) => setStep(j.progress < 0.3 ? 0 : 1, Math.max(0.1, j.progress * 0.9), j.stage) });
        res = { ...res, map: job.map, pending: job.labels && job.status !== 'done', done: job };
      }
      const map = res.map;
      map.meta.storyboardSpec ||= context.storyboardSpec;
      setStep(2, 0.95);
      openMap(map);
      finishOverlay();
      console.info(`[TubeMind] map visible after ${Math.round(performance.now() - started)} ms${res.cached ? ' (cached)' : ''}`);
      const coverage = map.meta.translation?.coverage ?? 1;
      if (coverage < 1) {
        // non-English video whose English translation is still running: this is a quick map
        toast(`Quick map from ${Math.round(coverage * 100)}% of the video (spread over all of it) — the full English version is still being prepared.`, {
          timeout: 12000,
          action: { label: 'Refresh', run: () => generate({ ...context }) },
        });
      } else toast(`Mindmap ready — ${countNodes(map.root)} nodes`, { type: 'success' });
      if (settings.storyboardImages && map.meta.storyboardSpec) {
        attachStoryboardFrames(model).then((n) => n && saveMap(model.toJSON())); // section thumbnails, shown in the node panel
      }
      if (res.done?.ops?.length) applyLabels(map, res.done);
      else if (res.pending && res.jobId) polish(map, res.jobId, started);
    } catch (err) {
      finishOverlay();
      $('#empty-state').hidden = !!model.map;
      toast(`Could not make the mindmap: ${err.message}`, { type: 'error', timeout: 9000, action: { label: 'Retry', run: () => generate({ ...context, noCache: true }) } });
    }
  }

  /** Wait (one long-poll) for the single AI label call, then patch labels in place. */
  async function polish(map, jobId, started) {
    const pill = $('#polish-pill');
    pill.hidden = false;
    try {
      const job = await api.waitJob(jobId, { hasMap: true });
      applyLabels(map, job);
      console.info(`[TubeMind] labels polished after ${Math.round(performance.now() - started)} ms`, job.meta?.labelStats || '');
    } catch {
      /* the map is already complete: polishing is optional */
    } finally {
      pill.hidden = true;
    }
  }

  function applyLabels(map, job) {
    if (model.map?.id !== map.id || !job.ops?.length) return;
    // never overwrite a label the user edited while the AI was working
    const ops = job.ops.filter((op) => op.type !== 'update' || model.get(op.id)?.text === findText(map.root, op.id));
    model.apply(ops, { origin: 'ai', record: false });
    Object.assign(model.map.meta, { labelled: !!job.meta?.labelled, llm: job.meta?.llm || model.map.meta.llm });
    renderer.flash(ops.filter((o) => o.type === 'update').map((o) => o.id));
    $('#map-title').value = model.meta.title || model.root.text;
    saveMap(model.toJSON());
  }

  async function generateFromUrl(value, extra = {}) {
    const videoId = parseVideoId(value);
    if (!videoId) return toast('Paste a valid YouTube link.', { type: 'error' });
    let title = '';
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
      if (res.ok) {
        const data = await res.json();
        title = data.title;
        extra.channel ||= data.author_name;
      }
    } catch {
      /* title is optional */
    }
    generate({ videoId, title, ...extra });
  }

  function showBackendHelp(context) {
    const { body, close } = modal('🔌 TubeMind is not connected');
    body.append(
      el('p', {}, 'TubeMind could not reach its server, so it cannot read the video right now. Your saved maps still work.'),
      el('div', { class: 'dev-only' }, [
        el('p', {}, `Backend: ${api.base}. Start it with:`),
        el('pre', { class: 'code' }, 'cd backend\npython -m venv .venv\n.venv\\Scripts\\activate      (Windows)   |   source .venv/bin/activate\npip install -r requirements.txt\npython -m app.main'),
        el('p', {}, 'Put your Groq key in the .env file at the project root (GROQ_API_KEY=...).'),
      ]),
      el('div', { class: 'panel-row' }, [
        el('button', { class: 'btn btn-accent', onclick: () => (close(), generate(context)) }, '↻ Retry'),
        settings.devMode ? el('button', { class: 'btn', onclick: () => (close(), openDemo()) }, '🧪 Open demo map') : null,
        el('button', { class: 'btn btn-ghost', onclick: () => chrome.runtime.openOptionsPage() }, '⚙ Settings'),
      ]),
    );
  }

  async function openDemo() {
    const map = await (await fetch(chrome.runtime.getURL('viewer/demo/sample-map.json'))).json();
    const existing = await getMap(map.id);
    openMap(existing || map);
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------
  const layerSeg = $('#layer-seg');
  LAYERS.forEach((layer) => layerSeg.append(el('button', { role: 'radio', title: layer.hint, dataset: { max: layer.max }, onclick: () => setLayer(layer.max) }, layer.label)));
  function syncLayerButtons() {
    $$('button', layerSeg).forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.max) === renderer.options.maxLayer)));
  }
  renderer.addEventListener('layer', syncLayerButtons);
  syncLayerButtons();

  $('#btn-study').addEventListener('click', () => (model.map ? study.open() : toast('Open a mindmap first.')));
  $('#btn-voice').addEventListener('click', () => voice.toggle());
  voice.addEventListener('state', () => $('#btn-voice').classList.toggle('on', !!voice.listening));
  $('#btn-share').addEventListener('click', () => openShare());
  $('#zoom-in').addEventListener('click', () => renderer.zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => renderer.zoomBy(0.8));
  $('#zoom-fit').addEventListener('click', () => renderer.fit());

  const exportMenu = $('#export-menu');
  $('#btn-export').addEventListener('click', () => {
    if (!model.map) return toast('Open a mindmap first.');
    exportMenu.replaceChildren(
      ...exportActions({ getMap: () => model.toJSON(), renderer, api }).map((action) =>
        el('button', {
          class: 'menu-item',
          disabled: action.enabled && !action.enabled() ? true : null,
          onclick: async () => {
            exportMenu.hidden = true;
            try {
              await action.run();
            } catch (err) {
              toast(`Export failed: ${err.message}`, { type: 'error' });
            }
          },
        }, [el('span', {}, action.icon), action.label]),
      ),
    );
    toggleMenu(exportMenu);
  });

  const moreMenu = $('#more-menu');
  $('#btn-more').addEventListener('click', () => {
    const section = (title) => el('div', { class: 'menu-title' }, title);
    const radio = (group, current, options, apply) =>
      Object.entries(options).map(([id, label]) => el('button', { class: `menu-item ${current === id ? 'checked' : ''}`, onclick: () => (moreMenu.hidden = true, apply(id)) }, [el('span', {}, current === id ? '●' : '○'), label]));
    moreMenu.replaceChildren(
      el('button', { class: 'menu-item', onclick: () => ((moreMenu.hidden = true), library.open()) }, [el('span', {}, '📚'), 'Library & cross-video links']),
      el('button', { class: 'menu-item', onclick: () => ((moreMenu.hidden = true), promptNewVideo()) }, [el('span', {}, '＋'), 'New mindmap from URL']),
      settings.devMode ? el('button', { class: 'menu-item', onclick: () => ((moreMenu.hidden = true), openDemo()) }, [el('span', {}, '🧪'), 'Open demo map']) : null,
      section('Theme'),
      ...radio('theme', renderer.options.theme, Object.fromEntries(themeOrder().map((t) => [t.id, t.name])), (id) => applyView({ theme: id })),
      section('Layout'),
      ...radio('layout', renderer.options.layout, LAYOUTS, (id) => applyView({ layout: id })),
      section('Regenerate as'),
      ...Object.entries(MODES).map(([id, label]) => el('button', { class: 'menu-item', disabled: model.meta?.videoId ? null : true, onclick: () => ((moreMenu.hidden = true), regenerate(id)) }, [el('span', {}, '↻'), label])),
      section('Edit'),
      el('button', { class: 'menu-item', onclick: () => model.undo() }, [el('span', {}, '↶'), 'Undo  (Ctrl+Z)']),
      el('button', { class: 'menu-item', onclick: () => model.redo() }, [el('span', {}, '↷'), 'Redo  (Ctrl+Y)']),
      el('button', { class: 'menu-item', onclick: () => ((moreMenu.hidden = true), showHelp()) }, [el('span', {}, '?'), 'Shortcuts & voice commands']),
      el('button', { class: 'menu-item', onclick: () => chrome.runtime.openOptionsPage() }, [el('span', {}, '⚙'), 'Settings']),
    );
    toggleMenu(moreMenu);
  });

  function toggleMenu(menu) {
    const willOpen = menu.hidden;
    $$('.dropdown').forEach((d) => (d.hidden = true));
    menu.hidden = !willOpen;
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu, .dropdown')) $$('.dropdown').forEach((d) => (d.hidden = true));
  });

  async function applyView(patch) {
    renderer.setOptions(patch);
    settings = await saveSettings(patch);
    setTimeout(() => renderer.fit(), 30);
  }

  /** Blackboard (the default) first in the theme menu. */
  function themeOrder() {
    return Object.values(THEMES).sort((a, b) => (b.id === DEFAULT_THEME) - (a.id === DEFAULT_THEME));
  }

  function regenerate(mode) {
    const meta = model.meta;
    generate({
      videoId: meta.videoId,
      title: meta.title,
      channel: meta.channel,
      duration: meta.duration,
      storyboardSpec: meta.storyboardSpec,
      transcript: model.map.transcript,
      mode,
      noCache: true,
    });
  }

  function promptNewVideo() {
    const { body, close } = modal('＋ New mindmap');
    const input = el('input', { type: 'url', class: 'wide-input', placeholder: 'https://www.youtube.com/watch?v=…' });
    const mode = el('select', {}, Object.entries(MODES).map(([id, label]) => el('option', { value: id, selected: id === settings.mode ? true : null }, label)));
    const go = () => (close(), generateFromUrl(input.value, { mode: mode.value }));
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    body.append(input, el('div', { class: 'panel-row' }, [mode, el('button', { class: 'btn btn-accent', onclick: go }, 'Generate')]));
    input.focus();
  }

  // -------------------------------------------------------------------------
  // Collaboration UI
  // -------------------------------------------------------------------------
  let preJoinCopy = null;
  function openShare() {
    const { body, close } = modal('👥 Collaborate');
    const render = () => {
      body.replaceChildren();
      if (collab.status === 'online') {
        body.append(
          el('p', {}, 'Share this room code. Anyone with TubeMind and access to the same backend can join and edit live.'),
          el('div', { class: 'room-code' }, [
            el('code', {}, collab.roomId),
            el('button', { class: 'btn btn-small', onclick: () => navigator.clipboard.writeText(collab.roomId).then(() => toast('Room code copied')) }, '⧉ Copy'),
          ]),
          el('h4', {}, 'In this room'),
          el('ul', { class: 'user-list' }, collab.users.map((u) => el('li', {}, [el('span', { class: 'dot', style: `background:${u.color}` }), u.name, u.id === settings.userId ? ' (you)' : '']))),
          el('div', { class: 'panel-row wrap' }, [
            preJoinCopy ? el('button', { class: 'btn', title: 'Merge the map you had open before joining into the shared map', onclick: () => (collab.mergeIntoRoom(preJoinCopy), (preJoinCopy = null), toast('Merging your version…')) }, '⊕ Merge my version') : null,
            el('button', { class: 'btn', onclick: () => gamify.openBoard() }, '🏅 Leaderboard'),
            el('button', { class: 'btn btn-danger', onclick: () => (collab.leave(), close()) }, 'Leave room'),
          ]),
        );
        return;
      }
      const code = el('input', { type: 'text', placeholder: 'Room code', class: 'wide-input' });
      body.append(
        el('p', {}, `Real-time editing, presence and team challenges via your backend (${api.base}). Name: ${settings.userName}.`),
        el('div', { class: 'panel-row' }, [
          el('button', {
            class: 'btn btn-accent',
            disabled: model.map ? null : true,
            onclick: async () => {
              try {
                const roomId = await collab.share();
                history.replaceState(null, '', `?room=${roomId}`);
                render();
              } catch (err) {
                toast(err.message, { type: 'error' });
              }
            },
          }, '✦ Share current map'),
        ]),
        el('h4', {}, 'Join a room'),
        el('div', { class: 'panel-row' }, [code, el('button', { class: 'btn', onclick: () => joinRoom(code.value).then(render) }, 'Join')]),
      );
    };
    collab.addEventListener('presence', render);
    render();
  }

  async function joinRoom(roomId) {
    if (!roomId?.trim()) return;
    preJoinCopy = model.map ? model.toJSON() : null;
    try {
      await collab.connect(roomId);
      $('#empty-state').hidden = true;
      history.replaceState(null, '', `?room=${roomId.trim()}`);
      toast(`Joined room ${roomId.trim()}`, { type: 'success' });
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  collab.addEventListener('snapshot', () => {
    $('#empty-state').hidden = true;
    $('#map-title').value = model.meta.title;
    renderMeta();
    saveMap(model.toJSON());
  });
  collab.addEventListener('status', (e) => {
    const btn = $('#btn-share');
    btn.classList.toggle('on', e.detail.status === 'online');
    btn.textContent = e.detail.status === 'online' ? `👥 ${e.detail.roomId}` : '👥 Share';
  });
  collab.addEventListener('presence', (e) => {
    $('#presence-bar').replaceChildren(...e.detail.users.map((u) => el('span', { class: 'avatar', style: `background:${u.color}`, title: u.name }, (u.name || '?').slice(0, 1).toUpperCase())));
  });

  // -------------------------------------------------------------------------
  // Renderer events, context menu, follow-along
  // -------------------------------------------------------------------------
  renderer.addEventListener('seek', (e) => seek(e.detail.node));
  renderer.addEventListener('edge', (e) => {
    if (confirm(`Remove cross-link “${e.detail.edge.label}”?`)) model.apply({ type: 'edge:remove', id: e.detail.edge.id });
  });
  // Lazy children: "+" on a node generates its deeper children from the transcript (no AI);
  // "Improve" then asks the AI once, only if the user wants it.
  renderer.addEventListener('more', (e) => expandMore(e.detail.node));
  function expandMore(node) {
    const transcript = model.map.transcript || [];
    const start = node.start ?? 0;
    const end = Math.max(node.end ?? start, start) + 45;
    const known = new Set();
    model.walk((n) => known.add(plain(n.source || n.text).slice(0, 60)));
    const picks = transcript.filter((t) => t.start >= start - 1 && t.start <= end && t.text.length > 25 && !known.has(plain(t.text).slice(0, 60))).slice(0, 3);
    const ops = [{ type: 'update', id: node.id, patch: { more: false } }];
    picks.forEach((t, i) => ops.push({ type: 'add', parentId: node.id, index: i, node: createNode({ text: t.text, type: 'detail', layer: 3, start: t.start, end: t.end, source: t.text }) }));
    model.apply(ops);
    gamify.track('node_added');
    toast(picks.length ? `Added ${picks.length} moments from the video` : 'Nothing more was said here.', {
      timeout: 6000,
      action: api.online ? { label: '✦ Improve', run: () => runRefine({ api, model, action: 'expand', ids: [node.id], gamify, renderer }) } : undefined,
    });
  }
  renderer.addEventListener('moved', () => gamify.track('node_edited'));

  renderer.addEventListener('edit-next', (e) => {
    const child = model.addChild(e.detail.id);
    renderer.render();
    renderer.select(child.id);
    renderer.startEdit(child.id);
  });

  const ctxMenu = $('#context-menu');
  renderer.addEventListener('contextmenu', (e) => {
    const { node, x, y } = e.detail;
    const ids = [...renderer.selection];
    const item = (icon, label, run, disabled = false) => el('button', { class: 'menu-item', disabled: disabled ? true : null, onclick: () => ((ctxMenu.hidden = true), run()) }, [el('span', {}, icon), label]);
    ctxMenu.replaceChildren(
      node.start !== null && node.start !== undefined ? item('▶', `Play from ${fmtTime(node.start)}`, () => seek(node)) : null,
      node.children?.length ? item(node.collapsed ? '⊞' : '⊟', node.collapsed ? 'Expand' : 'Collapse', () => model.toggle(node.id)) : null,
      item('💬', 'Ask about this node', () => ask(node.id)),
      item('✎', 'Edit text', () => renderer.startEdit(node.id)),
      item('＋', 'Add child', () => renderer.dispatchEvent(new CustomEvent('edit-next', { detail: { id: node.id } }))),
      el('div', { class: 'menu-title' }, 'AI'),
      ...REFINE_ACTIONS.map((a) => item(a.icon, a.label, () => runRefine({ api, model, action: a.id, ids, gamify, renderer }), ids.length < a.min)),
      item('🎓', 'Study this branch', () => study.open({ focusIds: collectIds(node) })),
      el('div', { class: 'menu-title' }, ''),
      node.type !== 'root' ? item('🗑', 'Delete', () => model.remove(ids)) : null,
    );
    ctxMenu.hidden = false;
    ctxMenu.style.left = `${Math.min(x, innerWidth - 240)}px`;
    ctxMenu.style.top = `${Math.min(y, innerHeight - ctxMenu.offsetHeight - 10)}px`;
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'TM_TIMEUPDATE' || !settings.followAlong || !model.map || msg.videoId !== model.meta.videoId) return;
    let best = null;
    for (const pos of renderer.positions.values()) {
      const n = pos.node;
      if (n.type === 'root' || n.start === null || n.start === undefined || n.start > msg.t + 0.5) continue;
      if (!best || n.start > best.start || (n.start === best.start && pos.depth > renderer.positions.get(best.id).depth)) best = n;
    }
    renderer.setPlaying(best?.id || null);
  });

  gamify.addEventListener('badge', (e) => toast(`${e.detail.emoji} Badge unlocked: ${e.detail.title}!`, { type: 'success', timeout: 5000 }));

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      return search.focus();
    }
    if (typing || !model.map || document.querySelector('dialog[open]')) return;
    const id = renderer.selectedId;
    const node = id && model.get(id);
    const key = e.key;

    if (mod && key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? model.redo() : model.undo();
    }
    if (mod && key.toLowerCase() === 'y') {
      e.preventDefault();
      return model.redo();
    }
    if (key === '/' ) {
      e.preventDefault();
      return search.focus();
    }
    if (key === 'Escape') return renderer.select([]);
    if (key === '?') return showHelp();
    const layer = LAYERS.find((l) => l.key === key);
    if (layer) return setLayer(layer.max);
    if (key === 'f') return renderer.fit();
    if (key === '+' || key === '=') return renderer.zoomBy(1.2);
    if (key === '-') return renderer.zoomBy(1 / 1.2);
    if (!node) {
      if (key.startsWith('Arrow') || key === 'Enter') renderer.select(model.root.id);
      return;
    }
    const focus = (n) => {
      if (!n) return;
      renderer.select(n.id);
      renderer.centerOn(n.id);
    };
    switch (key) {
      case 'Tab':
        e.preventDefault();
        renderer.dispatchEvent(new CustomEvent('edit-next', { detail: { id } }));
        gamify.track('node_added');
        break;
      case 'Enter': {
        e.preventDefault();
        if (node.type === 'root') break;
        const sib = model.addSibling(id);
        renderer.render();
        renderer.select(sib.id);
        renderer.startEdit(sib.id);
        gamify.track('node_added');
        break;
      }
      case 'F2':
      case 'e':
        e.preventDefault();
        renderer.startEdit(id);
        break;
      case 'Delete':
      case 'Backspace':
        if (node.type !== 'root') {
          const parent = model.parentOf(id);
          model.remove([...renderer.selection]);
          focus(parent);
        }
        break;
      case ' ':
        e.preventDefault();
        model.toggle(id);
        break;
      case 'p':
        seek(node);
        break;
      case 'a':
        ask(node.id);
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        e.preventDefault();
        const pos = renderer.positions.get(id);
        const outward = (key === 'ArrowRight') === ((pos?.side ?? 1) >= 0);
        if (node.type === 'root') {
          const kids = renderer.visibleChildren(node);
          focus(kids.find((k) => (renderer.positions.get(k.id)?.side ?? 1) === (key === 'ArrowRight' ? 1 : -1)) || kids[0]);
        } else if (outward) {
          if (node.collapsed) model.setCollapsed(id, false);
          focus(renderer.visibleChildren(model.get(id))[0]);
        } else focus(model.parentOf(id));
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const parent = model.parentOf(id);
        if (!parent) break;
        const siblings = renderer.visibleChildren(parent).filter((s) => renderer.positions.get(s.id)?.side === renderer.positions.get(id)?.side);
        const i = siblings.findIndex((s) => s.id === id);
        focus(siblings[i + (key === 'ArrowDown' ? 1 : -1)]);
        break;
      }
      default:
    }
  });

  // drag & drop JSON import
  $('#canvas').addEventListener('dragover', (e) => e.preventDefault());
  $('#canvas').addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    try {
      const map = JSON.parse(await file.text());
      if (!map.root) throw new Error('Not a TubeMind mindmap file');
      openMap(map);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  });

  function showHelp() {
    const { body } = modal('⌨ Shortcuts & 🎙 voice', { wide: true });
    const rows = [
      ['Click / Shift+click', 'select / multi-select'], ['Double-click, F2, e', 'edit text'], ['Tab', 'add child'], ['Enter', 'add sibling'],
      ['Space', 'expand / collapse'], ['Arrows', 'navigate'], ['Delete', 'delete node'], ['p', 'play node in video'], ['a', 'ask about the node'], ['Drag a node', 'move it onto another node or next to a sibling'],
      ['1 / 2', 'concepts only / with Def · Eg · Formula · Tip · Watch-out'], ['/, Ctrl+F', 'search (Enter = semantic)'], ['f, +, −', 'fit / zoom'], ['Ctrl+Z / Ctrl+Y', 'undo / redo'],
      ['Right-click', 'node menu with AI actions'], ['Wheel / pinch', 'zoom · drag to pan · Shift+wheel pans'],
    ];
    const voiceRows = ['expand <topic>', 'collapse <topic>', 'go to <topic>', 'play [topic]', 'read [topic]', 'next / previous / parent / child', 'zoom in / zoom out / fit', 'search <query>', 'layer concepts | details', 'add note <text>', 'add child <text>', 'undo / redo', 'stop listening'];
    body.append(
      el('div', { class: 'help-grid' }, [
        el('div', {}, [el('h4', {}, 'Keyboard & mouse'), el('table', { class: 'help-table' }, rows.map(([k, v]) => el('tr', {}, [el('td', {}, el('kbd', {}, k)), el('td', {}, v)])))]),
        el('div', {}, [el('h4', {}, 'Voice commands'), el('ul', { class: 'voice-list' }, voiceRows.map((v) => el('li', {}, v)))]),
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // Health + settings sync
  // -------------------------------------------------------------------------
  function renderHealth() {
    const dot = $('#backend-status');
    dot.classList.toggle('online', api.online);
    dot.title = settings.devMode
      ? api.online ? `Backend online · LLM: ${api.health.llm} · embeddings: ${api.health.embeddings}` : `Backend offline (${api.base}) — offline features only`
      : api.online ? 'Connected' : 'Not connected — you can still view and edit saved maps';
  }
  api.checkHealth().then(renderHealth);
  setInterval(() => api.checkHealth().then(renderHealth), 30000);

  onSettingsChanged(async (patch) => {
    settings = await getSettings();
    collab.settings = settings;
    if (patch.backendUrl) {
      api.setBase(patch.backendUrl);
      api.checkHealth().then(renderHealth);
    }
    if ('devMode' in patch) {
      setDev(settings.devMode);
      renderMeta();
      renderHealth();
    }
    const view = Object.fromEntries(Object.entries(patch).filter(([k]) => ['theme', 'layout'].includes(k)));
    if (Object.keys(view).length) renderer.setOptions(view);
    if (patch.voiceLang && voice.rec) voice.rec.lang = voice.lang = patch.voiceLang;
  });

  // -------------------------------------------------------------------------
  // Empty state + boot
  // -------------------------------------------------------------------------
  $('#empty-generate').addEventListener('click', () => generateFromUrl($('#empty-url').value));
  $('#empty-url').addEventListener('keydown', (e) => e.key === 'Enter' && generateFromUrl(e.target.value));
  $('#empty-demo').addEventListener('click', openDemo);
  $('#empty-library').addEventListener('click', () => library.open());
  $('#empty-join').addEventListener('click', () => joinRoom(prompt('Room code') || ''));

  const params = new URLSearchParams(location.search);
  if (params.get('req')) {
    const key = `req:${params.get('req')}`;
    const stored = (await chrome.storage.session.get(key))[key];
    if (stored) {
      await chrome.storage.session.remove(key);
      history.replaceState(null, '', location.pathname);
      generate(stored);
    } else toast('This generation request expired — generate again from the video.', { type: 'error' });
  } else if (params.get('map')) {
    const map = await getMap(params.get('map'));
    if (map) openMap(map, { save: false });
    else $('#empty-state').hidden = false;
  } else if (params.get('room')) {
    joinRoom(params.get('room'));
  } else if (params.get('url')) {
    generateFromUrl(params.get('url'), { mode: params.get('mode') || undefined });
  } else if (params.get('demo')) {
    openDemo();
  } else {
    $('#empty-state').hidden = false;
    const recent = (await listMaps()).slice(0, 5);
    $('#empty-recent').replaceChildren(
      ...recent.map((m) => el('button', { class: 'recent-item', onclick: async () => openMap(await getMap(m.id), { save: false }) }, [el('strong', {}, m.title), el('small', {}, `${m.nodeCount} nodes`)])),
    );
  }
}

function findText(node, id) {
  if (node.id === id) return node.text;
  for (const child of node.children || []) {
    const found = findText(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

const plain = (text) => String(text || '').replace(/^[“"]|[”"]$/g, '').trim();

function countNodes(node) {
  return 1 + (node.children || []).reduce((s, c) => s + countNodes(c), 0);
}

function collectIds(node) {
  const ids = [];
  const walk = (n) => {
    ids.push(n.id);
    (n.children || []).forEach(walk);
  };
  walk(node);
  return ids;
}

main().catch((err) => {
  console.error(err);
  toast(`TubeMind failed to start: ${err.message}`, { type: 'error', timeout: 10000 });
});

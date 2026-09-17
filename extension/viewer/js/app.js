/**
 * TubeMind viewer — application shell.
 *
 * Data flow:
 *   YouTube tab (content script) → service worker → this page
 *   → backend pipeline (transcript → segmentation → concepts → Groq LLM → mindmap JSON)
 *   → MindMapModel → MindMapRenderer → interaction features → collaboration
 */
import { getSettings, onSettingsChanged, parseVideoId, saveSettings } from '../../shared/settings.js';
import { attachStoryboardFrames } from './features/frames.js';
import { exportActions } from './features/export.js';
import { CollabClient } from './features/collab.js';
import { Gamify } from './features/gamify.js';
import { Library } from './features/library.js';
import { InspectorPanel } from './features/panel.js';
import { AdaptiveProfile } from './features/profile.js';
import { REFINE_ACTIONS, runRefine } from './features/refine.js';
import { SearchController } from './features/search.js';
import { StudyMode } from './features/study.js';
import { VoiceController } from './features/voice.js';
import { Api } from './lib/api.js';
import { getMap, listMaps, saveMap } from './lib/storage.js';
import { $, $$, debounce, el, fmtTime, modal, toast } from './lib/util.js';
import { MindMapModel } from './mindmap/model.js';
import { MindMapRenderer } from './mindmap/renderer.js';
import { THEMES } from './mindmap/themes.js';

const LAYERS = [
  { label: 'Overview', max: 1, hint: 'Central idea + sections' },
  { label: 'Clusters', max: 2, hint: '+ key concepts' },
  { label: 'Concepts', max: 3, hint: '+ supporting details' },
  { label: 'Transcript', max: 4, hint: '+ verbatim transcript leaves' },
];
const MODES = { revision: 'Quick revision', academic: 'Academic research', deep: 'Deep exploration' };
const PROFILES = { visual: 'Visual', balanced: 'Balanced', text: 'Text-heavy' };
const LAYOUTS = { balanced: 'Balanced (clockwise)', radial: 'Radial', right: 'Logical tree' };
const PIPELINE_STEPS = [
  { label: 'Transcript', until: 0.28 },
  { label: 'Segmentation', until: 0.38 },
  { label: 'Concept graph', until: 0.42 },
  { label: 'LLM node writing', until: 0.9 },
  { label: 'Mindmap', until: 1.01 },
];

async function main() {
  let settings = await getSettings();
  const api = new Api(settings.backendUrl);
  const model = new MindMapModel();
  const renderer = new MindMapRenderer($('#canvas'), model, {
    theme: settings.theme,
    layout: settings.layout,
    profile: settings.profile,
    maxLayer: 3,
  });

  const seek = (node) => {
    const videoId = node.videoId || model.meta?.videoId;
    if (!videoId) return toast('This map is not linked to a video.');
    if (node.start === null || node.start === undefined) return toast('This node has no timestamp.');
    chrome.runtime.sendMessage({ type: 'TM_SEEK', videoId, seconds: node.start });
  };

  const profile = new AdaptiveProfile();
  const gamify = new Gamify({ model, renderer, hud: $('#hud') });
  const collab = new CollabClient({ api, model, renderer, settings });
  gamify.attachCollab(collab);
  const study = new StudyMode({ api, model, renderer, seek, gamify });
  const panel = new InspectorPanel({ host: $('#inspector'), model, renderer, api, seek, gamify, profile });
  const search = new SearchController({ input: $('#search'), results: $('#search-results'), model, renderer, api, onPick: () => profile.track('search') });
  const setLayer = (max) => {
    renderer.setOptions({ maxLayer: max });
    renderer.fit();
    syncLayerButtons();
    if (max === 4) profile.track('layer-transcript');
  };
  const voice = new VoiceController({ model, renderer, seek, search: (q) => ((search.input.value = q), search.semantic()), setLayer, lang: settings.voiceLang, indicator: $('#voice-indicator'), profile });
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
    const chips = [
      meta.kind === 'hub' ? '🕸 Knowledge Hub' : null,
      meta.mode ? MODES[meta.mode] || meta.mode : null,
      meta.llm ? `✦ ${meta.llm}` : null,
      meta.transcriptSource ? `❝ ${meta.transcriptSource}` : null,
      meta.sample ? '🧪 sample data' : null,
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
    overlay.hidden = false;
    $('#empty-state').hidden = true;
    $('#progress-title').textContent = context.title || 'Your video';
    const steps = $('#progress-steps');
    steps.replaceChildren(...PIPELINE_STEPS.map((s) => el('li', {}, s.label)));
    const bar = $('#progress-bar span');
    const stage = $('#progress-stage');
    const setProgress = (p, text) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      stage.textContent = text;
      PIPELINE_STEPS.forEach((s, i) => {
        const prev = PIPELINE_STEPS[i - 1]?.until ?? 0;
        steps.children[i].className = p >= s.until ? 'done' : p >= prev ? 'active' : '';
      });
    };

    await api.checkHealth();
    renderHealth();
    if (!api.online) {
      overlay.hidden = true;
      showBackendHelp(context);
      return;
    }
    setProgress(0.02, 'Sending video to the pipeline…');
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
        profile: context.profile || settings.profile,
        useLLM: settings.useLLM,
        allowWhisper: settings.allowWhisper,
        frames: settings.serverKeyframes,
        noCache: !!context.noCache,
      };
      const map = await api.generate(payload, (job) => setProgress(job.progress, job.stage));
      map.meta.storyboardSpec ||= context.storyboardSpec;
      setProgress(1, 'Drawing your mindmap…');
      openMap(map);
      overlay.hidden = true;
      toast(`Mindmap ready — ${countNodes(map.root)} nodes from ${map.meta.transcriptSource} transcript`, { type: 'success' });
      if (settings.storyboardImages && map.meta.storyboardSpec) {
        attachStoryboardFrames(model, { includeConcepts: settings.profile === 'visual' }).then((n) => n && saveMap(model.toJSON()));
      }
    } catch (err) {
      overlay.hidden = true;
      $('#empty-state').hidden = !!model.map;
      toast(`Generation failed: ${err.message}`, { type: 'error', timeout: 9000, action: { label: 'Retry', run: () => generate({ ...context, noCache: true }) } });
    }
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
    const { body, close } = modal('🔌 Backend not reachable');
    body.append(
      el('p', {}, `TubeMind could not reach the pipeline at ${api.base}. Start it with:`),
      el('pre', { class: 'code' }, 'cd backend\npython -m venv .venv\n.venv\\Scripts\\activate      (Windows)   |   source .venv/bin/activate\npip install -r requirements.txt\npython -m app.main'),
      el('p', {}, 'Put your Groq key in the .env file at the project root (GROQ_API_KEY=...).'),
      el('div', { class: 'panel-row' }, [
        el('button', { class: 'btn btn-accent', onclick: () => (close(), generate(context)) }, '↻ Retry'),
        el('button', { class: 'btn', onclick: () => (close(), openDemo()) }, '🧪 Open demo map'),
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
  $('#zoom-in').addEventListener('click', () => (renderer.zoomBy(1.25), profile.track('zoom')));
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
              if (['md', 'obsidian', 'notion-md'].includes(action.id)) profile.track('export-md');
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
      el('button', { class: 'menu-item', onclick: () => ((moreMenu.hidden = true), openDemo()) }, [el('span', {}, '🧪'), 'Open demo map']),
      section('Theme'),
      ...radio('theme', renderer.options.theme, Object.fromEntries(Object.values(THEMES).map((t) => [t.id, t.name])), (id) => applyView({ theme: id })),
      section('Layout'),
      ...radio('layout', renderer.options.layout, LAYOUTS, (id) => applyView({ layout: id })),
      section('Learning profile'),
      ...radio('profile', renderer.options.profile, PROFILES, (id) => applyView({ profile: id })),
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
    if (patch.layout === 'radial') profile.track('layout-radial');
    if (patch.theme === 'doodle') profile.track('theme-doodle');
    if (patch.profile === 'visual' && model.map && settings.storyboardImages) attachStoryboardFrames(model, { includeConcepts: true });
    setTimeout(() => renderer.fit(), 30);
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
  renderer.addEventListener('image', (e) => {
    profile.track('image-open');
    const { body } = modal('🎞 Frame');
    body.append(el('img', { src: e.detail.node.image.src, class: 'frame-preview', alt: '' }));
    if (e.detail.node.image.t !== undefined) body.append(el('button', { class: 'btn btn-accent', onclick: () => seek({ ...e.detail.node, start: e.detail.node.image.t }) }, `▶ Watch at ${fmtTime(e.detail.node.image.t)}`));
  });
  renderer.addEventListener('edge', (e) => {
    if (confirm(`Remove cross-link “${e.detail.edge.label}”?`)) model.apply({ type: 'edge:remove', id: e.detail.edge.id });
  });
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

  profile.addEventListener('suggest', (e) => {
    const next = e.detail.profile;
    if (!settings.adaptiveProfile || next === renderer.options.profile) return;
    toast(`You seem to learn best with a ${PROFILES[next].toLowerCase()} layout.`, { timeout: 9000, action: { label: 'Switch', run: () => applyView({ profile: next }) } });
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
    if (['1', '2', '3', '4'].includes(key)) return setLayer(Number(key));
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
      ['Space', 'expand / collapse'], ['Arrows', 'navigate'], ['Delete', 'delete node'], ['p', 'play node in video'],
      ['1 – 4', 'semantic layers: overview → transcript'], ['/, Ctrl+F', 'search (Enter = semantic)'], ['f, +, −', 'fit / zoom'], ['Ctrl+Z / Ctrl+Y', 'undo / redo'],
      ['Right-click', 'node menu with AI actions'], ['Wheel / pinch', 'zoom · drag to pan · Shift+wheel pans'],
    ];
    const voiceRows = ['expand <topic>', 'collapse <topic>', 'go to <topic>', 'play [topic]', 'read [topic]', 'next / previous / parent / child', 'zoom in / zoom out / overview', 'search <query>', 'layer overview | clusters | concepts | transcript', 'add note <text>', 'add child <text>', 'undo / redo', 'stop listening'];
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
    dot.title = api.online ? `Backend online · LLM: ${api.health.llm} · embeddings: ${api.health.embeddings}` : `Backend offline (${api.base}) — offline features only`;
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
    const view = Object.fromEntries(Object.entries(patch).filter(([k]) => ['theme', 'layout', 'profile'].includes(k)));
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

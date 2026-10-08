/**
 * Extension tests — no browser, no dependencies:   node --test extension/tests/
 *
 * Settings migration after removing the learning profiles, the balanced layout kept as an option,
 * Blackboard as the default theme, no Overview / Transcript UI, text-only node content (no SVG
 * icons or badges), and the Content map with two-way highlighting.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { descendants } from './dom-shim.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fixture = () => JSON.parse(read('tests/fixtures/sketchbook-map.json'));

const { DEFAULT_SETTINGS, REMOVED_KEYS, migrateSettings } = await import('../shared/settings.js');
const { DEFAULT_THEME, THEMES, getTheme } = await import('../viewer/js/mindmap/themes.js');
const { MindMapModel } = await import('../viewer/js/mindmap/model.js');
const { MAX_LAYER, MindMapRenderer } = await import('../viewer/js/mindmap/renderer.js');
const { ContentMap, outline } = await import('../viewer/js/features/contentmap.js');
const { toMarkdown } = await import('../viewer/js/features/export.js');

function mount(map = fixture(), options = {}) {
  const host = document.createElement('div');
  const model = new MindMapModel();
  const renderer = new MindMapRenderer(host, model, options);
  model.load(map);
  return { host, model, renderer };
}

// ---------------------------------------------------------------------------
// Settings: the learning profiles are gone, old stored settings migrate safely
// ---------------------------------------------------------------------------
test('defaults: Short mode, Blackboard theme, balanced layout, no profile keys', () => {
  assert.equal(DEFAULT_SETTINGS.mode, 'revision');
  assert.equal(DEFAULT_SETTINGS.theme, 'chalk');
  assert.equal(DEFAULT_SETTINGS.layout, 'balanced');
  for (const key of REMOVED_KEYS) assert.ok(!(key in DEFAULT_SETTINGS), key);
});

test('settings stored by an older version migrate without crashing', () => {
  const old = { profile: 'visual', adaptiveProfile: true, layout: 'balanced', theme: 'sketch', mode: 'academic', useLLM: false };
  const { settings, remove, patch } = migrateSettings(old);
  assert.deepEqual(remove.sort(), ['adaptiveProfile', 'profile']);
  assert.deepEqual(patch, {});
  assert.equal(settings.layout, 'balanced', 'a saved balanced layout is kept');
  assert.equal(settings.theme, 'sketch', 'a saved theme choice still wins');
  assert.equal(settings.mode, 'academic');
  assert.equal(settings.useLLM, false);
  assert.ok(!('profile' in settings) && !('adaptiveProfile' in settings));

  const junk = migrateSettings({ theme: 'neon', layout: 'zigzag', mode: 'huge' });
  assert.deepEqual(junk.patch, { theme: 'chalk', layout: 'balanced', mode: 'revision' });
  assert.equal(migrateSettings({ layout: 'right' }).settings.layout, 'right', 'a saved tree layout is kept');
  assert.deepEqual(migrateSettings({}).patch, {});
  assert.deepEqual(migrateSettings().remove, []);
});

test('options page and popup offer no profile; the balanced layout is still offered', () => {
  for (const page of ['options/options.html', 'popup/popup.html', 'options/options.js', 'popup/popup.js']) {
    const html = read(page);
    assert.ok(!/id="profile"|adaptiveProfile|value="visual"/.test(html), page);
  }
  const options = read('options/options.html');
  assert.match(options, /<select id="theme">\s*<option value="chalk">Blackboard<\/option>/);
  assert.match(options, /<select id="layout">\s*<option value="balanced">Balanced \(clockwise\)<\/option>/, 'balanced is listed first');
  assert.match(read('viewer/js/app.js'), /balanced: 'Balanced \(clockwise\)'/);
});

test('balanced layout: sections split left and right, clockwise in video order', () => {
  const { model, renderer } = mount(fixture(), { layout: 'balanced' });
  const sections = model.root.children;
  const side = (n) => renderer.positions.get(n.id).side;
  assert.ok(sections.some((s) => side(s) === 1) && sections.some((s) => side(s) === -1), 'both sides used');
  const right = sections.filter((s) => side(s) === 1);
  const left = sections.filter((s) => side(s) === -1);
  assert.deepEqual([...right, ...left], sections, 'right side first, then left (clockwise)');
  const y = (n) => renderer.positions.get(n.id).y;
  assert.ok(right.every((s, i) => i === 0 || y(s) > y(right[i - 1])), 'right side reads top → bottom');
  assert.ok(left.every((s, i) => i === 0 || y(s) < y(left[i - 1])), 'left side reads bottom → top');
  for (const s of sections) {
    for (const c of renderer.visibleChildren(s)) assert.equal(side(c), side(s), 'children grow away from the centre');
  }
});

// ---------------------------------------------------------------------------
// Blackboard is the default theme
// ---------------------------------------------------------------------------
test('Blackboard is the default theme: chalk on a dark board, text at least 14 px', () => {
  assert.equal(DEFAULT_THEME, 'chalk');
  assert.equal(getTheme(undefined).id, 'chalk');
  assert.equal(getTheme('no-such-theme').id, 'chalk');
  const chalk = THEMES.chalk;
  assert.ok(chalk.dark && /^#[0-3][0-9a-f]/i.test(chalk.background), 'dark green/charcoal board');
  for (const type of ['root', 'section', 'concept', 'detail']) {
    const style = chalk.node({ type, tag: 'Eg' }, { index: 0, color: 0 });
    assert.ok(style.size >= 14, `${type} text ≥ 14 px`);
  }
  const { renderer } = mount();
  assert.equal(renderer.theme.id, 'chalk', 'the viewer starts on the blackboard');
  assert.match(read('viewer/viewer.html'), /<html lang="en" data-canvas-theme="chalk">/);
});

// ---------------------------------------------------------------------------
// Overview / Transcript UI no longer exists
// ---------------------------------------------------------------------------
test('no Overview or Transcript tabs, panels or transcript block in the viewer', () => {
  const html = read('viewer/viewer.html');
  assert.ok(!/Overview|Transcript/.test(html));
  assert.match(html, /id="content-map"/);
  const app = read('viewer/js/app.js');
  const layers = app.slice(app.indexOf('const LAYERS'), app.indexOf('];', app.indexOf('const LAYERS')));
  assert.ok(!/label: '(Overview|Transcript)'/.test(layers), layers);
  assert.ok(!/From the video|panel-source\b|sourceText/.test(read('viewer/js/features/panel.js')));
  assert.ok(!/panel-source\b|panel-faith/.test(read('viewer/viewer.css')));
  assert.ok(!/overview: 1|transcript: 4/.test(read('viewer/js/features/voice.js')));
});

// ---------------------------------------------------------------------------
// Node content: text only (no SVG icons, badges or decorations)
// ---------------------------------------------------------------------------
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image', 'use', 'foreignObject']);

test('no SVG elements inside node content: only the hand-drawn outline remains', () => {
  for (const theme of ['chalk', 'sketch', 'doodle']) {
    const { model, renderer } = mount(fixture(), { theme });
    model.walk((n) => (n.collapsed = false)); // show every level-3 item too
    renderer.mastered = new Set([model.root.children[0].children[0].id]);
    model.root.children[0].notes = 'my note';
    renderer.render();
    const nodes = renderer.layers.nodes.children;
    assert.ok(nodes.length > 10);
    for (const g of nodes) {
      const content = descendants(g).filter((el) => !el.closest('.outline') && !el.closest('[data-ui]'));
      const shapes = content.filter((el) => SHAPES.has(el.tagName));
      assert.deepEqual(shapes.map((el) => el.tagName), [], `${theme}: ${g.dataset.nodeId} has drawn content`);
      for (const el of content) assert.ok(['text', 'tspan', 'title'].includes(el.tagName), el.tagName);
      for (const el of descendants(g).filter((e) => e.tagName === 'text')) {
        assert.ok(!/[▶≈🔗✎●]/u.test(el.textContent), `icon glyph in "${el.textContent}"`);
      }
      // toggles are a plain character too
      for (const t of g.querySelectorAll('.toggle')) assert.match(t.textContent.replace(t.querySelector('title')?.textContent || '', ''), /^(\+\d*|−)$/);
    }
  }
});

test('sketchbook rendering: numbered sections, plain-text time ranges, no transcript quotes on the map', () => {
  const { model, renderer } = mount();
  const sections = model.root.children.filter((s) => !s.recall);
  const label = (id) => renderer.layers.nodes.querySelector(`[data-node-id="${id}"]`).querySelector('.label').textContent;
  sections.forEach((s, i) => assert.ok(label(s.id).startsWith(`${i + 1}. `), label(s.id)));
  const recall = model.root.children.at(-1);
  assert.equal(label(recall.id), 'Quick recall', 'the recall branch is not numbered');
  const seek = renderer.layers.nodes.querySelector(`[data-node-id="${sections[0].id}"]`).querySelector('.chip-seek');
  assert.match(seek.textContent, /^\d+:\d{2}–\d+:\d{2}Play/, 'section time range as plain clickable text');
  assert.equal(seek.getAttribute('data-action'), 'seek');
  assert.equal(MAX_LAYER, 3);
  renderer.setOptions({ maxLayer: 4 });
  assert.equal(renderer.options.maxLayer, 3);
  assert.equal(renderer.layers.nodes.querySelectorAll('.type-transcript').length, 0);
  const quote = model.nodes().find((n) => n.type === 'transcript');
  assert.equal(renderer.reveal(quote.id), model.parentOf(quote.id).id, 'search hits on hidden quotes resolve to their parent');
});

// ---------------------------------------------------------------------------
// Content map
// ---------------------------------------------------------------------------
test('content map outline: Quick recall, numbered sections, Term: meaning, tagged lines', () => {
  const o = outline(fixture());
  assert.ok(o.recall.length >= 3 && o.recall.length <= 6);
  assert.ok(o.oneLine);
  assert.deepEqual(o.sections.map((s) => s.n), o.sections.map((_, i) => i + 1));
  for (const s of o.sections) {
    assert.ok(s.title && s.title !== 'undefined' && s.start !== null && s.end > s.start && s.summary && s.terms.length);
    for (const c of s.concepts) {
      assert.match(c.text, /^[^:]+: \S/);
      for (const item of c.items) assert.ok(['Def', 'Eg', 'Formula', 'Tip', 'Watch-out'].includes(item.tag) && !item.text.startsWith(`${item.tag}:`));
    }
  }
});

test('content map ⇄ map: selecting either side highlights the other; sections seek the video', () => {
  const { model, renderer } = mount();
  const host = document.createElement('aside');
  const stage = document.createElement('main');
  const toggle = document.createElement('button');
  const seeks = [];
  const cm = new ContentMap({ host, stage, toggle, model, renderer, seek: (node) => seeks.push(node.id) });
  cm.render();
  assert.ok(stage.classList.contains('cm-open') && toggle.getAttribute('aria-pressed') === 'true');
  assert.ok(!/Overview|Transcript/.test(host.textContent));
  assert.match(host.textContent, /Quick recall/);
  assert.match(host.textContent, /Jump to/);
  assert.ok(!host.textContent.includes('undefined'));
  assert.equal(host.querySelector('.cm-jump-item').textContent, `1. ${model.root.children[0].text}`);

  // map → content map
  const concept = model.root.children[1].children[0];
  renderer.select(concept.id);
  const entry = host.querySelector(`[data-node-id="${concept.id}"]`);
  assert.ok(entry.classList.contains('cm-active'));

  // content map → map (+ the video jumps for sections)
  const section = model.root.children[2];
  host.querySelector(`li.cm-jump-item[data-node-id="${section.id}"]`).querySelector('button').click();
  assert.deepEqual([...renderer.selection], [section.id]);
  assert.deepEqual(seeks, [section.id]);
  assert.ok(host.querySelector(`li.cm-section[data-node-id="${section.id}"]`).classList.contains('cm-active'));

  cm.setOpen(false, { fit: false });
  assert.ok(host.hidden && !stage.classList.contains('cm-open'));
});

test('Markdown export is a revision sketchbook', () => {
  const md = toMarkdown(fixture());
  const recall = md.indexOf('## Quick recall');
  assert.ok(recall > 0 && recall < md.indexOf('## 1. '), 'Quick recall comes first');
  assert.match(md, /## 2\. .+ · \[\d+:\d{2}–\d+:\d{2}\]\(https:\/\/www\.youtube\.com\/watch\?v=TESTVIDEO01&t=\d+s\)/);
  assert.match(md, /\*\*(Def|Eg|Formula|Tip|Watch-out):\*\* /);
  assert.ok(!/▶|“/.test(md), 'no icon glyphs, no transcript quotes');
});

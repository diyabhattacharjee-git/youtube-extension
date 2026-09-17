/**
 * AI-powered refinement: expand, rewrite, summarize, reorganize, merge.
 * The backend (Groq → HF fallback) returns ops that are applied as one undoable step
 * and automatically shared with collaborators. Offline fallbacks keep basic actions working.
 */
import { createNode } from '../mindmap/model.js';
import { plain, toast, truncateText } from './shared.js';

export const REFINE_ACTIONS = [
  { id: 'expand', label: 'Expand', icon: '✚', hint: 'Add missing sub-points from the transcript', min: 1 },
  { id: 'rewrite', label: 'Rewrite', icon: '✎', hint: 'Clearer, self-contained wording', min: 1 },
  { id: 'summarize', label: 'Summarize', icon: '≡', hint: 'Write a revision summary', min: 1 },
  { id: 'reorganize', label: 'Reorganize', icon: '⇅', hint: 'Group children into clusters', min: 1 },
  { id: 'merge', label: 'Merge', icon: '⊕', hint: 'Merge the selected nodes', min: 2 },
];

export async function runRefine({ api, model, action, ids, instruction = '', gamify, renderer }) {
  const spec = REFINE_ACTIONS.find((a) => a.id === action);
  if (!spec || ids.length < spec.min) {
    toast(spec?.min > 1 ? 'Select at least two nodes (Shift+click) to merge.' : 'Select a node first.');
    return null;
  }
  const busy = toast(`${spec.icon} ${spec.label}…`, { timeout: 60000 });
  try {
    let ops;
    if (api.online) {
      const res = await api.refine(model.toJSON(), action, ids, instruction);
      ops = res.ops;
    } else {
      ops = offlineRefine(model, action, ids);
    }
    if (!ops?.length) {
      toast('Nothing to change.');
      return [];
    }
    model.apply(ops, { origin: 'ai' });
    const added = ops.filter((o) => o.type === 'add');
    for (const pid of new Set(added.map((o) => o.parentId))) model.setCollapsed(pid, false);
    // new nodes may sit below the current semantic-layer filter: make them visible
    if (added.length && renderer) renderer.reveal(added[0].node.id);
    gamify?.track('ai_refine');
    toast(`${spec.label} applied — Ctrl+Z to undo`, { type: 'success' });
    return ops;
  } catch (err) {
    toast(`AI refinement failed: ${err.message}`, { type: 'error', timeout: 6000 });
    return null;
  } finally {
    busy.remove();
  }
}

/** Minimal refinements without a backend (uses the stored transcript). */
function offlineRefine(model, action, ids) {
  const node = model.get(ids[0]);
  const transcript = model.map.transcript || [];
  if (action === 'expand') {
    const start = node.start ?? 0;
    const end = node.end ?? start + 90;
    const existing = new Set((node.children || []).map((c) => plain(c.text)));
    return transcript
      .filter((e) => e.start >= start && e.start <= end && e.text.length > 30)
      .filter((e) => !existing.has(truncateText(e.text, 140)))
      .slice(0, 4)
      .map((e, i) => ({
        type: 'add',
        parentId: node.id,
        index: node.children.length + i,
        node: createNode({ text: `“${truncateText(e.text, 140)}”`, type: 'transcript', layer: 4, start: e.start, end: e.end }),
      }));
  }
  if (action === 'summarize') {
    const summary = (node.children || []).filter((c) => c.type !== 'transcript').map((c) => plain(c.text)).slice(0, 5).join('; ');
    return summary ? [{ type: 'update', id: node.id, patch: { summary } }] : [];
  }
  toast('This action needs the backend (AI).', { type: 'error' });
  return [];
}

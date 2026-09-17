/**
 * MindMapModel — the single source of truth for a mindmap document.
 *
 * All edits go through *operations* (identical to backend/app/collab/ops.py):
 *   add | update | remove | move | edge:add | edge:remove
 * Each applied op produces its inverse, which powers undo/redo. The same ops are
 * broadcast to collaborators and returned by the AI refinement endpoint.
 *
 * Events (EventTarget):
 *   'change'  detail: { ops, origin: 'local' | 'remote' | 'history' | 'ai', localOnly }
 *   'load'    detail: { map }
 */
import { clone, uid } from '../lib/util.js';

const PROTECTED = new Set(['id', 'children']);
// View-state fields: never recorded in history, never sent to collaborators.
const LOCAL_ONLY_FIELDS = new Set(['collapsed']);

export class MindMapModel extends EventTarget {
  constructor(map) {
    super();
    this.undoStack = [];
    this.redoStack = [];
    if (map) this.load(map);
  }

  load(map) {
    this.map = normalizeMap(clone(map));
    this.reindex();
    this.undoStack = [];
    this.redoStack = [];
    this.dispatchEvent(new CustomEvent('load', { detail: { map: this.map } }));
  }

  get root() {
    return this.map.root;
  }

  get meta() {
    return this.map.meta;
  }

  reindex() {
    this.index = new Map();
    const visit = (node, parent, depth) => {
      this.index.set(node.id, { node, parent, depth });
      (node.children || []).forEach((child) => visit(child, node, depth + 1));
    };
    visit(this.map.root, null, 0);
  }

  get(id) {
    return this.index.get(id)?.node || null;
  }

  parentOf(id) {
    return this.index.get(id)?.parent || null;
  }

  depthOf(id) {
    return this.index.get(id)?.depth ?? 0;
  }

  path(id) {
    const out = [];
    let cur = this.get(id);
    while (cur) {
      out.unshift(cur);
      cur = this.parentOf(cur.id);
    }
    return out;
  }

  walk(fn, node = this.map.root, parent = null, depth = 0) {
    if (fn(node, parent, depth) === false) return;
    for (const child of node.children || []) this.walk(fn, child, node, depth + 1);
  }

  nodes() {
    const out = [];
    this.walk((n) => out.push(n));
    return out;
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------
  /** Apply a list of ops as one undoable step. Returns the ops that applied. */
  apply(ops, { origin = 'local', record = true } = {}) {
    const list = [].concat(ops).filter(Boolean);
    const applied = [];
    const inverses = [];
    for (const op of list) {
      const inverse = this.#applyOne(op);
      if (inverse) {
        applied.push(op);
        inverses.unshift(...[].concat(inverse));
      }
    }
    if (!applied.length) return [];
    const localOnly = applied.every(isLocalOnly);
    // Remote ops, undo/redo replays and pure view-state changes never enter the history.
    if (record && !localOnly && origin !== 'remote' && origin !== 'history') {
      this.undoStack.push({ inverses });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastInverses = inverses;
    this.dispatchEvent(new CustomEvent('change', { detail: { ops: applied, origin, localOnly } }));
    return applied;
  }

  /** Undo = apply the stored inverses; their own inverses become the redo step. */
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    if (!this.apply(entry.inverses, { origin: 'history' }).length) return this.undo();
    this.redoStack.push({ inverses: this.lastInverses });
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    if (!this.apply(entry.inverses, { origin: 'history' }).length) return false;
    this.undoStack.push({ inverses: this.lastInverses });
    return true;
  }

  #applyOne(op) {
    switch (op?.type) {
      case 'add': {
        const parent = this.get(op.parentId);
        if (!parent || !op.node || this.get(op.node.id)) return null;
        const node = normalizeNode(op.node, parent);
        const children = (parent.children ||= []);
        const index = clampIndex(op.index, children.length);
        children.splice(index, 0, node);
        this.reindex();
        return { type: 'remove', id: node.id };
      }
      case 'update': {
        const node = this.get(op.id);
        if (!node) return null;
        const previous = {};
        for (const [key, value] of Object.entries(op.patch || {})) {
          if (PROTECTED.has(key)) continue;
          previous[key] = node[key] === undefined ? null : clone(node[key]);
          node[key] = value;
        }
        return { type: 'update', id: op.id, patch: previous };
      }
      case 'remove': {
        const entry = this.index.get(op.id);
        if (!entry?.parent) return null;
        const siblings = entry.parent.children;
        const index = siblings.findIndex((c) => c.id === op.id);
        const [removed] = siblings.splice(index, 1);
        const subtree = new Set();
        const collect = (n) => {
          subtree.add(n.id);
          (n.children || []).forEach(collect);
        };
        collect(removed);
        const droppedEdges = (this.map.edges || []).filter((e) => subtree.has(e.source) || subtree.has(e.target));
        this.map.edges = (this.map.edges || []).filter((e) => !droppedEdges.includes(e));
        this.reindex();
        return [
          { type: 'add', parentId: entry.parent.id, index, node: clone(removed) },
          ...droppedEdges.map((edge) => ({ type: 'edge:add', edge: clone(edge) })),
        ];
      }
      case 'move': {
        const entry = this.index.get(op.id);
        const target = this.get(op.parentId);
        if (!entry?.parent || !target || this.#isInSubtree(target.id, entry.node)) return null;
        const oldParent = entry.parent;
        const oldIndex = oldParent.children.findIndex((c) => c.id === op.id);
        oldParent.children.splice(oldIndex, 1);
        const children = (target.children ||= []);
        children.splice(clampIndex(op.index, children.length), 0, entry.node);
        this.reindex();
        return { type: 'move', id: op.id, parentId: oldParent.id, index: oldIndex };
      }
      case 'edge:add': {
        const edges = (this.map.edges ||= []);
        if (!op.edge?.id || edges.some((e) => e.id === op.edge.id)) return null;
        edges.push(op.edge);
        return { type: 'edge:remove', id: op.edge.id };
      }
      case 'edge:remove': {
        const edges = this.map.edges || [];
        const edge = edges.find((e) => e.id === op.id);
        if (!edge) return null;
        this.map.edges = edges.filter((e) => e !== edge);
        return { type: 'edge:add', edge: clone(edge) };
      }
      default:
        return null;
    }
  }

  #isInSubtree(id, node) {
    if (node.id === id) return true;
    return (node.children || []).some((c) => this.#isInSubtree(id, c));
  }

  // -------------------------------------------------------------------------
  // Convenience editing API (all produce ops)
  // -------------------------------------------------------------------------
  update(id, patch, opts) {
    return this.apply({ type: 'update', id, patch }, opts);
  }

  setCollapsed(id, collapsed) {
    const node = this.get(id);
    if (!node || !node.children?.length || !!node.collapsed === collapsed) return;
    this.apply({ type: 'update', id, patch: { collapsed } });
  }

  toggle(id) {
    const node = this.get(id);
    if (node) this.setCollapsed(id, !node.collapsed);
  }

  addChild(parentId, partial = {}) {
    const parent = this.get(parentId);
    if (!parent) return null;
    const node = createNode({ ...childDefaults(parent), ...partial });
    this.apply({ type: 'add', parentId, index: (parent.children || []).length, node });
    if (parent.collapsed) this.setCollapsed(parentId, false);
    return node;
  }

  addSibling(id, partial = {}) {
    const parent = this.parentOf(id);
    if (!parent) return this.addChild(id, partial);
    const index = parent.children.findIndex((c) => c.id === id) + 1;
    const self = this.get(id);
    const node = createNode({ type: self.type, layer: self.layer, start: self.start, ...partial });
    this.apply({ type: 'add', parentId: parent.id, index, node });
    return node;
  }

  remove(ids) {
    const list = [].concat(ids).filter((id) => this.parentOf(id));
    // remove deepest first so parents do not swallow already-queued children
    list.sort((a, b) => this.depthOf(b) - this.depthOf(a));
    return this.apply(list.map((id) => ({ type: 'remove', id })));
  }

  addEdge(source, target, label = 'related to') {
    const edge = { id: uid('e'), source, target, label, origin: 'user' };
    this.apply({ type: 'edge:add', edge });
    return edge;
  }

  toJSON() {
    return clone(this.map);
  }
}

export function isLocalOnly(op) {
  return op.type === 'update' && Object.keys(op.patch || {}).every((k) => LOCAL_ONLY_FIELDS.has(k));
}

function clampIndex(index, length) {
  const i = Number.isFinite(index) ? index : length;
  return Math.max(0, Math.min(i, length));
}

const CHILD_TYPES = { root: ['section', 1], section: ['concept', 2], concept: ['detail', 3], detail: ['detail', 3], transcript: ['detail', 4] };

function childDefaults(parent) {
  const [type, layer] = CHILD_TYPES[parent.type] || ['detail', 3];
  return { type, layer, start: parent.start ?? null };
}

export function createNode(partial = {}) {
  return normalizeNode({ id: uid(), text: 'New idea', ...partial });
}

function normalizeNode(node, parent = null) {
  node.id ||= uid();
  node.text ??= '';
  node.type ||= parent ? childDefaults(parent).type : 'root';
  node.layer ??= parent ? childDefaults(parent).layer : 0;
  node.start ??= null;
  node.end ??= null;
  node.summary ??= '';
  node.tone ||= [];
  node.keywords ||= [];
  node.notes ??= '';
  node.links ||= [];
  node.image ??= null;
  node.collapsed = !!node.collapsed;
  node.children ||= [];
  node.children.forEach((c) => normalizeNode(c, node));
  return node;
}

export function normalizeMap(map) {
  map.schema ||= 'tubemind/1';
  map.id ||= crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  map.version ||= 1;
  map.meta ||= {};
  map.meta.title ||= map.root?.text || 'Untitled mindmap';
  map.edges ||= [];
  map.root = normalizeNode(map.root || { text: map.meta.title, type: 'root' });
  map.root.type = 'root';
  map.root.layer = 0;
  return map;
}

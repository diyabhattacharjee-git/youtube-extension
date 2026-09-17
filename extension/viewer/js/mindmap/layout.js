/**
 * Layout algorithms. Input: visible tree + node sizes. Output: centre positions.
 *
 *  balanced — classic mind map: first-level branches split left/right so both sides
 *             have similar height, ordered CLOCKWISE (top-right → bottom-right →
 *             bottom-left → top-left) so reading order follows the video timeline.
 *  right    — logical tree growing to the right (good for long outlines).
 *  radial   — branches radiate around the centre, angle proportional to leaf count.
 */

/**
 * @param {object} root
 * @param {(node) => {w:number,h:number}} sizeOf
 * @param {(node) => object[]} childrenOf  visible children
 * @param {{layout:string, gaps:{h:number[], v:number[]}}} options
 * @returns {Map<string, {node, x, y, w, h, depth, side, parentId}>}
 */
export function computeLayout(root, sizeOf, childrenOf, options) {
  const positions = new Map();
  const gapH = (depth) => options.gaps.h[Math.min(depth, options.gaps.h.length - 1)];
  const gapV = (depth) => options.gaps.v[Math.min(depth, options.gaps.v.length - 1)];

  // --- subtree heights (memoised) -------------------------------------------
  const heights = new Map();
  const subtreeHeight = (node, depth) => {
    if (heights.has(node.id)) return heights.get(node.id);
    const { h } = sizeOf(node);
    const kids = childrenOf(node);
    let total = h;
    if (kids.length) {
      const stack = kids.reduce((sum, k) => sum + subtreeHeight(k, depth + 1), 0) + gapV(depth + 1) * (kids.length - 1);
      total = Math.max(h, stack);
    }
    heights.set(node.id, total);
    return total;
  };

  const placeSide = (node, x, y, depth, side, parentId) => {
    const { w, h } = sizeOf(node);
    positions.set(node.id, { node, x, y, w, h, depth, side, parentId });
    const kids = childrenOf(node);
    if (!kids.length) return;
    const total = kids.reduce((s, k) => s + subtreeHeight(k, depth + 1), 0) + gapV(depth + 1) * (kids.length - 1);
    let cursor = y - total / 2;
    for (const kid of kids) {
      const sh = subtreeHeight(kid, depth + 1);
      const kw = sizeOf(kid).w;
      const kx = x + side * (w / 2 + gapH(depth + 1) + kw / 2);
      placeSide(kid, kx, cursor + sh / 2, depth + 1, side, node.id);
      cursor += sh + gapV(depth + 1);
    }
  };

  const rootSize = sizeOf(root);
  const first = childrenOf(root);

  if (options.layout === 'radial') {
    radial(root, sizeOf, childrenOf, positions, gapH);
    return positions;
  }

  positions.set(root.id, { node: root, x: 0, y: 0, ...rootSize, depth: 0, side: 0, parentId: null });

  if (options.layout === 'right' || first.length <= 1) {
    const total = first.reduce((s, k) => s + subtreeHeight(k, 1), 0) + gapV(1) * Math.max(0, first.length - 1);
    let cursor = -total / 2;
    for (const kid of first) {
      const sh = subtreeHeight(kid, 1);
      placeSide(kid, rootSize.w / 2 + gapH(1) + sizeOf(kid).w / 2, cursor + sh / 2, 1, 1, root.id);
      cursor += sh + gapV(1);
    }
    return positions;
  }

  // --- balanced: choose the split that best equalises both sides --------------
  const hs = first.map((k) => subtreeHeight(k, 1));
  const total = hs.reduce((a, b) => a + b, 0);
  let split = Math.ceil(first.length / 2);
  let best = Infinity;
  let acc = 0;
  for (let i = 1; i < first.length; i++) {
    acc += hs[i - 1];
    const diff = Math.abs(acc - (total - acc));
    if (diff < best) {
      best = diff;
      split = i;
    }
  }
  // Clockwise reading order: right side top→bottom, then left side bottom→top.
  const rightTopDown = first.slice(0, split);
  const leftTopDown = first.slice(split).reverse();

  const stackSide = (kidsTopDown, side) => {
    const sideHeights = kidsTopDown.map((k) => subtreeHeight(k, 1));
    const sum = sideHeights.reduce((a, b) => a + b, 0) + gapV(1) * Math.max(0, kidsTopDown.length - 1);
    let cursor = -sum / 2;
    kidsTopDown.forEach((kid, i) => {
      const sh = sideHeights[i];
      // push middle branches outward a little so the map bulges organically
      const rel = sum ? (cursor + sh / 2) / (sum / 2) : 0;
      const fan = (1 - Math.abs(rel)) * 40;
      const kx = side * (rootSize.w / 2 + gapH(1) + fan + sizeOf(kid).w / 2);
      placeSide(kid, kx, cursor + sh / 2, 1, side, root.id);
      cursor += sh + gapV(1);
    });
  };
  stackSide(rightTopDown, 1);
  stackSide(leftTopDown, -1);
  return positions;
}

function radial(root, sizeOf, childrenOf, positions, gapH) {
  const leaves = new Map();
  const countLeaves = (node) => {
    const kids = childrenOf(node);
    const n = kids.length ? kids.reduce((s, k) => s + countLeaves(k), 0) : 1;
    leaves.set(node.id, n);
    return n;
  };
  countLeaves(root);

  // ring radius grows with depth and with how crowded the ring is
  const byDepth = [];
  const collect = (node, depth) => {
    (byDepth[depth] ||= []).push(node);
    childrenOf(node).forEach((k) => collect(k, depth + 1));
  };
  collect(root, 0);
  const rootSize = sizeOf(root);
  const radii = [0];
  for (let d = 1; d < byDepth.length; d++) {
    const nodes = byDepth[d];
    const maxW = Math.max(...nodes.map((n) => sizeOf(n).w));
    const need = nodes.reduce((s, n) => s + sizeOf(n).h + 26, 0) / (Math.PI * 2);
    const prevMax = d === 1 ? Math.max(rootSize.w, rootSize.h) / 2 : Math.max(...byDepth[d - 1].map((n) => sizeOf(n).w)) / 2;
    radii[d] = Math.max(radii[d - 1] + prevMax + gapH(d) + maxW / 2, need);
  }

  positions.set(root.id, { node: root, x: 0, y: 0, ...rootSize, depth: 0, side: 0, parentId: null });
  const place = (node, start, end, depth) => {
    const kids = childrenOf(node);
    const total = leaves.get(node.id) || 1;
    let a = start;
    for (const kid of kids) {
      const span = ((end - start) * (leaves.get(kid.id) || 1)) / total;
      const angle = a + span / 2;
      const r = radii[depth + 1];
      const { w, h } = sizeOf(kid);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      positions.set(kid.id, { node: kid, x, y, w, h, depth: depth + 1, side: Math.cos(angle) >= 0 ? 1 : -1, parentId: node.id, angle });
      place(kid, a, a + span, depth + 1);
      a += span;
    }
  };
  place(root, -Math.PI / 2, (Math.PI * 3) / 2, 0); // start at 12 o'clock, clockwise
}

export function boundsOf(positions, pad = 60) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x - p.w / 2 - 40);
    maxX = Math.max(maxX, p.x + p.w / 2 + 40);
    minY = Math.min(minY, p.y - p.h / 2 - 40);
    maxY = Math.max(maxY, p.y + p.h / 2 + 30);
  }
  if (!Number.isFinite(minX)) return { x: -200, y: -150, w: 400, h: 300 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

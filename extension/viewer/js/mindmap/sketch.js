/**
 * Hand-drawn SVG path generators (a tiny, dependency-free "rough" renderer).
 *
 * Every function takes a seeded `rng` so wobble is deterministic per node —
 * shapes do not jitter when the map re-renders. All return SVG path `d` strings.
 */

const TAU = Math.PI * 2;
const f = (n) => Math.round(n * 10) / 10;
const jit = (rng, amount) => (rng() - 0.5) * 2 * amount;

/** A slightly bowed line, drawn `passes` times like a pen going over it twice. */
export function line(x1, y1, x2, y2, rng, { bow = 0.015, jitter = 1.2, passes = 2 } = {}) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  let d = '';
  for (let p = 0; p < passes; p++) {
    const b = jit(rng, len * bow);
    const mx = (x1 + x2) / 2 + nx * b;
    const my = (y1 + y2) / 2 + ny * b;
    d += `M${f(x1 + jit(rng, jitter))},${f(y1 + jit(rng, jitter))} Q${f(mx)},${f(my)} ${f(x2 + jit(rng, jitter))},${f(y2 + jit(rng, jitter))} `;
  }
  return d;
}

/**
 * Organic connector between two points. `axis` = 'h' bends horizontally (tree layouts),
 * 'free' bends perpendicular to the direction (radial). Returns {d, end, endAngle, mid}.
 */
export function connector(x1, y1, x2, y2, rng, { axis = 'h', curl = 0.5, wobble = 3, passes = 1 } = {}) {
  let c1x;
  let c1y;
  let c2x;
  let c2y;
  if (axis === 'h') {
    const dx = (x2 - x1) * curl;
    c1x = x1 + dx + jit(rng, wobble * 2);
    c1y = y1 + jit(rng, wobble);
    c2x = x2 - dx + jit(rng, wobble * 2);
    c2y = y2 + jit(rng, wobble);
  } else {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const bend = len * 0.12 * (rng() > 0.5 ? 1 : -1);
    c1x = x1 + (x2 - x1) * 0.33 + nx * bend;
    c1y = y1 + (y2 - y1) * 0.33 + ny * bend;
    c2x = x1 + (x2 - x1) * 0.66 + nx * bend * 0.6;
    c2y = y1 + (y2 - y1) * 0.66 + ny * bend * 0.6;
  }
  let d = '';
  for (let p = 0; p < passes; p++) {
    const o = p ? 1.1 : 0;
    d += `M${f(x1 + jit(rng, o))},${f(y1 + jit(rng, o))} C${f(c1x + jit(rng, o))},${f(c1y + jit(rng, o))} ${f(c2x + jit(rng, o))},${f(c2y + jit(rng, o))} ${f(x2)},${f(y2)} `;
  }
  // point at t=0.5 on the cubic, used for labels
  const t = 0.5;
  const mt = 1 - t;
  const mid = {
    x: mt ** 3 * x1 + 3 * mt ** 2 * t * c1x + 3 * mt * t ** 2 * c2x + t ** 3 * x2,
    y: mt ** 3 * y1 + 3 * mt ** 2 * t * c1y + 3 * mt * t ** 2 * c2y + t ** 3 * y2,
  };
  return { d, endAngle: Math.atan2(y2 - c2y, x2 - c2x), mid };
}

/** Open arrow head at (x, y) pointing along `angle`. */
export function arrowHead(x, y, angle, rng, size = 11) {
  const spread = 0.48 + jit(rng, 0.06);
  const a1 = angle + Math.PI - spread;
  const a2 = angle + Math.PI + spread;
  return `M${f(x + Math.cos(a1) * size)},${f(y + Math.sin(a1) * size)} L${f(x)},${f(y)} L${f(x + Math.cos(a2) * size)},${f(y + Math.sin(a2) * size)}`;
}

/** Hollow "double-line" arrow like a marker-drawn ⇒ (doodle theme). */
export function doubleArrow(x1, y1, x2, y2, rng, gap = 4) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const nx = -uy * gap;
  const ny = ux * gap;
  const hx = x2 - ux * 12;
  const hy = y2 - uy * 12;
  const angle = Math.atan2(uy, ux);
  return (
    line(x1 + nx, y1 + ny, hx + nx, hy + ny, rng, { passes: 1, bow: 0.02 }) +
    line(x1 - nx, y1 - ny, hx - nx, hy - ny, rng, { passes: 1, bow: 0.02 }) +
    arrowHead(x2, y2, angle, rng, 16)
  );
}

/** Rounded rectangle with pen wobble. */
export function rect(x, y, w, h, rng, { r = 8, jitter = 1.6, passes = 2 } = {}) {
  let d = '';
  for (let p = 0; p < passes; p++) {
    const j = () => jit(rng, jitter);
    const x0 = x + j();
    const y0 = y + j();
    const x1 = x + w + j();
    const y1 = y + h + j();
    const rr = Math.min(r, w / 2, h / 2);
    d +=
      `M${f(x0 + rr)},${f(y0)} L${f(x1 - rr)},${f(y0 + j() * 0.5)} Q${f(x1)},${f(y0)} ${f(x1)},${f(y0 + rr)} ` +
      `L${f(x1 + j() * 0.5)},${f(y1 - rr)} Q${f(x1)},${f(y1)} ${f(x1 - rr)},${f(y1)} ` +
      `L${f(x0 + rr)},${f(y1 + j() * 0.5)} Q${f(x0)},${f(y1)} ${f(x0)},${f(y1 - rr)} ` +
      `L${f(x0 + j() * 0.5)},${f(y0 + rr)} Q${f(x0)},${f(y0)} ${f(x0 + rr + (p ? 6 : 0))},${f(y0 + (p ? j() : 0))} `;
  }
  return d;
}

/** Wobbly ellipse that overshoots its starting point, like a quick hand-drawn circle. */
export function ellipse(cx, cy, rx, ry, rng, { points = 16, jitter = 0.05, passes = 2 } = {}) {
  let d = '';
  for (let p = 0; p < passes; p++) {
    const start = rng() * TAU;
    const pts = [];
    const turns = 1.08;
    const n = Math.round(points * turns);
    for (let i = 0; i <= n; i++) {
      const a = start + (i / points) * TAU;
      const k = 1 + jit(rng, jitter);
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    d += smooth(pts);
  }
  return d;
}

/** Cloud outline made of outward arcs. */
export function cloud(cx, cy, w, h, rng) {
  const rx = w / 2;
  const ry = h / 2;
  const bumps = Math.max(8, Math.round((Math.PI * (rx + ry)) / 38));
  let d = '';
  let prev = null;
  for (let i = 0; i <= bumps; i++) {
    const a = (i / bumps) * TAU + 0.2;
    const x = cx + Math.cos(a) * rx * (1 + jit(rng, 0.03));
    const y = cy + Math.sin(a) * ry * (1 + jit(rng, 0.03));
    if (!prev) d += `M${f(x)},${f(y)} `;
    else {
      const chord = Math.hypot(x - prev[0], y - prev[1]);
      const r = chord * (0.55 + rng() * 0.15);
      d += `A${f(r)},${f(r)} 0 0 1 ${f(x)},${f(y)} `;
    }
    prev = [x, y];
  }
  return `${d}Z`;
}

/** Radiating tick marks on the left and right of the central idea (sketch-notes style). */
export function burstTicks(cx, cy, rx, ry, rng, { count = 5, length = 26 } = {}) {
  let d = '';
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const spread = (i / (count - 1) - 0.5) * 1.1;
      const a = (side > 0 ? 0 : Math.PI) + spread * side;
      const r0 = 1.06 + rng() * 0.05;
      const len = length * (0.6 + rng() * 0.5) * (i === Math.floor(count / 2) ? 1.3 : 1);
      const x0 = cx + Math.cos(a) * rx * r0;
      const y0 = cy + Math.sin(a) * ry * r0;
      d += line(x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, rng, { passes: 1, jitter: 0.6 });
    }
  }
  return d;
}

/** Highlighter-marker swipe behind text: slanted, with ragged rounded ends. */
export function highlighter(x, y, w, h, rng) {
  const s = jit(rng, 2);
  const r = h / 2;
  return (
    `M${f(x + r)},${f(y + s)} ` +
    `C${f(x + w * 0.35)},${f(y - 1 + jit(rng, 1.5))} ${f(x + w * 0.7)},${f(y + 1 + jit(rng, 1.5))} ${f(x + w - r)},${f(y - s)} ` +
    `Q${f(x + w + r * 0.9)},${f(y + h * 0.5 - s)} ${f(x + w - r * 0.8)},${f(y + h - s)} ` +
    `C${f(x + w * 0.66)},${f(y + h + 1 + jit(rng, 1.5))} ${f(x + w * 0.3)},${f(y + h - 1 + jit(rng, 1.5))} ${f(x + r * 0.8)},${f(y + h + s)} ` +
    `Q${f(x - r * 0.9)},${f(y + h * 0.5 + s)} ${f(x + r)},${f(y + s)} Z`
  );
}

/** Speech bubble with a tail at the bottom-left. */
export function bubble(x, y, w, h, rng) {
  const tail = `M${f(x + w * 0.22)},${f(y + h - 1)} L${f(x + w * 0.1 + jit(rng, 2))},${f(y + h + 16)} L${f(x + w * 0.36)},${f(y + h - 1)}`;
  return ellipse(x + w / 2, y + h / 2, w / 2 + 10, h / 2 + 8, rng, { passes: 1, jitter: 0.025 }) + tail;
}

/** Ribbon banner with notched, folded ends. */
export function banner(x, y, w, h, rng) {
  const e = 16;
  const notch = h * 0.35;
  return (
    rect(x, y, w, h, rng, { r: 2, passes: 1 }) +
    `M${f(x)},${f(y + 6)} L${f(x - e)},${f(y + 6)} L${f(x - e + notch)},${f(y + h / 2 + 6)} L${f(x - e)},${f(y + h + 6)} L${f(x + 6)},${f(y + h + 6)} L${f(x + 6)},${f(y + h)} ` +
    `M${f(x + w)},${f(y + 6)} L${f(x + w + e)},${f(y + 6)} L${f(x + w + e - notch)},${f(y + h / 2 + 6)} L${f(x + w + e)},${f(y + h + 6)} L${f(x + w - 6)},${f(y + h + 6)} L${f(x + w - 6)},${f(y + h)}`
  );
}

/** Hanging sign: board plus two strings to a nail. */
export function sign(x, y, w, h, rng) {
  const nailX = x + w / 2;
  const nailY = y - Math.min(34, h * 0.9);
  return (
    rect(x, y, w, h, rng, { r: 3 }) +
    rect(x + 5, y + 5, w - 10, h - 10, rng, { r: 2, passes: 1, jitter: 1 }) +
    line(x + w * 0.2, y + 5, nailX, nailY, rng, { passes: 1 }) +
    line(x + w * 0.8, y + 5, nailX, nailY, rng, { passes: 1 }) +
    ellipse(nailX, nailY, 3, 3, rng, { passes: 1, points: 8 })
  );
}

/** Block arrow pointing left (-1) or right (+1). */
export function arrowBox(x, y, w, h, rng, dir = 1) {
  const tip = Math.min(34, w * 0.25);
  const pts =
    dir > 0
      ? [[x, y + h * 0.12], [x + w - tip, y + h * 0.12], [x + w - tip, y - h * 0.12], [x + w + 8, y + h / 2], [x + w - tip, y + h * 1.12], [x + w - tip, y + h * 0.88], [x, y + h * 0.88]]
      : [[x + w, y + h * 0.12], [x + tip, y + h * 0.12], [x + tip, y - h * 0.12], [x - 8, y + h / 2], [x + tip, y + h * 1.12], [x + tip, y + h * 0.88], [x + w, y + h * 0.88]];
  return polygon(pts, rng);
}

/** Box with curly-brace sides. */
export function braceBox(x, y, w, h, rng) {
  const b = 10;
  const curly = (sx, dir) =>
    `M${f(sx + dir * b)},${f(y)} Q${f(sx)},${f(y)} ${f(sx)},${f(y + h * 0.25)} Q${f(sx)},${f(y + h * 0.5)} ${f(sx - dir * b * 0.9)},${f(y + h * 0.5)} ` +
    `Q${f(sx)},${f(y + h * 0.5)} ${f(sx)},${f(y + h * 0.75)} Q${f(sx)},${f(y + h)} ${f(sx + dir * b)},${f(y + h)} `;
  return (
    curly(x, 1) +
    curly(x + w, -1) +
    line(x + b, y, x + w - b, y, rng, { passes: 2 }) +
    line(x + b, y + h, x + w - b, y + h, rng, { passes: 2 })
  );
}

/** Spiky starburst badge; pass `ry` for an elliptical burst around wide labels. */
export function starburst(cx, cy, r, rng, spikes = 12, ry = r) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * TAU;
    const k = (i % 2 ? 0.72 : 1) * (1 + jit(rng, 0.06));
    pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * ry * k]);
  }
  return polygon(pts, rng, 0.6);
}

/** Paper note with a folded corner. */
export function note(x, y, w, h, rng) {
  const c = Math.min(18, h * 0.4);
  return (
    polygon([[x, y], [x + w - c, y], [x + w, y + c], [x + w, y + h], [x, y + h]], rng) +
    `M${f(x + w - c)},${f(y)} L${f(x + w - c + jit(rng, 1))},${f(y + c)} L${f(x + w)},${f(y + c)}`
  );
}

/** Tent card (folded table sign). */
export function tent(x, y, w, h, rng) {
  const lean = 14;
  return (
    polygon([[x + lean, y], [x + w, y], [x + w - lean, y + h], [x, y + h]], rng) +
    line(x + lean, y, x - 6, y + h * 0.85, rng, { passes: 1 })
  );
}

export function heart(cx, cy, w, h, rng) {
  const top = cy - h * 0.3;
  return (
    `M${f(cx)},${f(cy + h * 0.5)} ` +
    `C${f(cx - w * 0.75)},${f(cy + jit(rng, 2))} ${f(cx - w * 0.55)},${f(top - h * 0.45)} ${f(cx)},${f(top)} ` +
    `C${f(cx + w * 0.55)},${f(top - h * 0.45)} ${f(cx + w * 0.75)},${f(cy + jit(rng, 2))} ${f(cx)},${f(cy + h * 0.5)} Z`
  );
}

/** Wavy underline. */
export function squiggle(x1, x2, y, rng, amp = 2.2) {
  const steps = Math.max(3, Math.round((x2 - x1) / 14));
  let d = `M${f(x1)},${f(y)} `;
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    d += `Q${f(x - (x2 - x1) / steps / 2)},${f(y + (i % 2 ? -amp : amp) + jit(rng, 0.6))} ${f(x)},${f(y)} `;
  }
  return d;
}

export function checkMark(x, y, size, rng) {
  return `M${f(x)},${f(y + size * 0.55)} L${f(x + size * 0.38 + jit(rng, 1))},${f(y + size)} L${f(x + size + jit(rng, 1))},${f(y)}`;
}

export function polygon(pts, rng, jitter = 1.2) {
  let d = '';
  for (let p = 0; p < 2; p++) {
    const moved = pts.map(([x, y]) => [x + jit(rng, jitter), y + jit(rng, jitter)]);
    d += `M${f(moved[0][0])},${f(moved[0][1])} ` + moved.slice(1).map(([x, y]) => `L${f(x)},${f(y)}`).join(' ') + ' Z ';
  }
  return d;
}

/** Catmull-Rom spline through points -> cubic Béziers. */
function smooth(pts) {
  if (pts.length < 2) return '';
  let d = `M${f(pts[0][0])},${f(pts[0][1])} `;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])} `;
  }
  return d;
}

/** Closed shape paths suitable for `fill` (first pass only of the outline generators). */
export function fillPath(shape, x, y, w, h, rng, dir = 1) {
  switch (shape) {
    case 'cloud':
      return cloud(x + w / 2, y + h / 2, w + 36, h + 34, rng);
    case 'circle':
      return ellipse(x + w / 2, y + h / 2, w / 2 + 14, h / 2 + 14, rng, { passes: 1, jitter: 0.02 });
    case 'bubble':
      return ellipse(x + w / 2, y + h / 2, w / 2 + 10, h / 2 + 8, rng, { passes: 1, jitter: 0.02 });
    case 'burst':
      return starburst(x + w / 2, y + h / 2, w / 2 + 34, rng, 14, h / 2 + 26).split(' Z ')[0] + ' Z';
    case 'heart':
      return heart(x + w / 2, y + h / 2 + 4, w + 34, h + 30, rng);
    case 'arrowBox':
      return arrowBox(x - 6, y - 4, w + 12, h + 8, rng, dir).split(' Z ')[0] + ' Z';
    case 'tent':
      return polygon([[x + 8, y - 6], [x + w + 14, y - 6], [x + w, y + h + 6], [x - 6, y + h + 6]], rng, 0.5).split(' Z ')[0] + ' Z';
    default:
      return rect(x - 8, y - 6, w + 16, h + 12, rng, { r: 8, passes: 1, jitter: 0.8 });
  }
}

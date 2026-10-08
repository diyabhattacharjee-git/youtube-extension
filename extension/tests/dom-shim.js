/**
 * Just enough DOM for the renderer and the Content map to run under `node --test`
 * (no browser, no dependencies). Elements keep real parent/child links, attributes,
 * classList, dataset and events; selectors support compound tag/.class/[attr]/[attr="v"].
 */
const CHAR_WIDTH = 0.52; // em per character for canvas measureText

class ShimNode extends EventTarget {
  constructor() {
    super();
    this.parentNode = null;
    this.childNodes = [];
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
}

class ShimText extends ShimNode {
  constructor(text) {
    super();
    this.data = String(text);
  }

  get textContent() {
    return this.data;
  }

  cloneNode() {
    return new ShimText(this.data);
  }
}

class ShimElement extends ShimNode {
  constructor(tag, ns = null) {
    super();
    this.tagName = tag;
    this.localName = tag;
    this.namespaceURI = ns;
    this.attributes = new Map();
    this.style = { setProperty(k, v) { this[k] = v; } };
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, key) => el.getAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_, key, value) => (el.setAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value), true),
    });
    this.classList = {
      list: () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      add: (...names) => el.setAttribute('class', [...new Set([...el.classList.list(), ...names])].join(' ')),
      remove: (...names) => el.setAttribute('class', el.classList.list().filter((n) => !names.includes(n)).join(' ')),
      contains: (name) => el.classList.list().includes(name),
      toggle: (name, force) => {
        const on = force ?? !el.classList.contains(name);
        if (on) el.classList.add(name);
        else el.classList.remove(name);
        return on;
      },
    };
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof ShimElement);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get hidden() {
    return this.attributes.has('hidden');
  }

  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }

  hasAttribute(k) {
    return this.attributes.has(k);
  }

  removeAttribute(k) {
    this.attributes.delete(k);
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof ShimNode ? node : new ShimText(node);
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    child.parentNode = null;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  cloneNode(deep) {
    const copy = new ShimElement(this.tagName, this.namespaceURI);
    for (const [k, v] of this.attributes) copy.setAttribute(k, v);
    if (deep) copy.append(...this.childNodes.map((c) => c.cloneNode(true)));
    return copy;
  }

  set textContent(text) {
    this.replaceChildren(new ShimText(text));
  }

  get textContent() {
    return super.textContent;
  }

  matches(selector) {
    return selector.split(',').some((part) => matchCompound(this, part.trim()));
  }

  closest(selector) {
    for (let el = this; el instanceof ShimElement; el = el.parentNode) if (el.matches(selector)) return el;
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  click() {
    this.dispatchEvent(new Event('click', { bubbles: true }));
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
  }

  focus() {}

  scrollIntoView() {}

  getContext() {
    return {
      font: '16px sans-serif',
      measureText(text) {
        const size = Number((/(\d+(?:\.\d+)?)px/.exec(this.font) || [0, 16])[1]);
        return { width: String(text).length * size * CHAR_WIDTH };
      },
    };
  }
}

function matchCompound(el, selector) {
  const tokens = selector.match(/^[a-zA-Z][\w-]*|\.[\w-]+|\[[^\]]+\]|#[\w-]+/g) || [];
  if (tokens.join('') !== selector) throw new Error(`dom-shim: unsupported selector "${selector}"`);
  return tokens.every((t) => {
    if (t.startsWith('.')) return el.classList.contains(t.slice(1));
    if (t.startsWith('#')) return el.getAttribute('id') === t.slice(1);
    if (t.startsWith('[')) {
      const m = /^\[([\w-]+)(?:="?([^"]*)"?)?\]$/.exec(t);
      return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
    }
    return el.tagName.toLowerCase() === t.toLowerCase();
  });
}

const documentElement = new ShimElement('html');
const body = new ShimElement('body');
documentElement.append(body);

globalThis.Node = ShimNode;
globalThis.Element = ShimElement;
globalThis.document = {
  documentElement,
  body,
  createElement: (tag) => new ShimElement(tag),
  createElementNS: (ns, tag) => new ShimElement(tag, ns),
  createTextNode: (text) => new ShimText(text),
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now() + 10_000), 0); // animations finish in one frame
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.XMLSerializer = class {
  serializeToString(el) {
    return el.textContent;
  }
};

/** All elements below `root` (depth first). */
export function descendants(root) {
  const out = [];
  const walk = (el) => {
    for (const child of el.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

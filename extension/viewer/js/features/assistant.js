/**
 * Node assistant: a small, collapsible chat dock in the right rail. Ask anything about a
 * node; answers are grounded in the transcript and cite moments as ▶ chips that seek the
 * video. The backend makes ONE LLM call per message (streamed token by token) using only
 * the node's path, its summary and the best-matching transcript sentences. Without the
 * backend or an LLM it answers with the best-matching transcript lines themselves.
 */
import { el, fmtTime, plain, toast, truncateText } from './shared.js';

const STARTERS = [
  { label: 'Explain simply', ask: (t) => `Explain “${t}” simply.` },
  { label: 'Give an example', ask: (t) => `Give an example of “${t}” from the video.` },
  { label: 'Why does this matter?', ask: (t) => `Why does “${t}” matter?` },
];
const TS_RE = /\[(\d{1,2}(?::\d{2}){1,2})\]/g;
const STOP = new Set('about after again also because been before being could does doing from have into just like more most other over same should some such than that their them then there these they this those through under very what when where which while will with would your explain simply example matter video'.split(' '));
const HISTORY_MESSAGES = 8; // last 4 turns

export class Assistant {
  constructor({ host, model, renderer, api, seek }) {
    Object.assign(this, { host, model, renderer, api, seek });
    this.threads = new Map(); // nodeId -> [{role, text, sources}]
    this.nodeId = null;
    model.addEventListener('load', () => this.close());
    model.addEventListener('change', () => {
      if (!this.nodeId || this.host.hidden) return;
      if (!this.model.get(this.nodeId)) this.close();
      else this.#renderHead();
    });
  }

  /** Open the dock on a node (from the inspector's Ask button or the context menu). */
  open(nodeId) {
    if (!this.model.get(nodeId)) return;
    this.nodeId = nodeId;
    this.host.hidden = false;
    this.host.classList.remove('collapsed');
    this.renderer.setDiscussing(nodeId);
    this.#render();
    this.input?.focus();
  }

  close() {
    this.controller?.abort();
    this.host.hidden = true;
    this.nodeId = null;
    this.renderer.setDiscussing(null);
  }

  get node() {
    return this.nodeId ? this.model.get(this.nodeId) : null;
  }

  get thread() {
    if (!this.threads.has(this.nodeId)) this.threads.set(this.nodeId, []);
    return this.threads.get(this.nodeId);
  }

  // ---------------------------------------------------------------------------
  #render() {
    this.head = el('header', { class: 'chat-head', title: 'Collapse / expand', onclick: (e) => !e.target.closest('button') && this.host.classList.toggle('collapsed') }, []);
    this.log = el('div', { class: 'chat-log', 'aria-live': 'polite' });
    this.input = el('input', { type: 'text', placeholder: 'Ask about this node…', 'aria-label': 'Your question', maxlength: 500 });
    const form = el('form', { class: 'chat-form' }, [this.input, el('button', { class: 'btn btn-small btn-accent', type: 'submit' }, 'Ask')]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.input.value.trim();
      if (q) this.ask(q);
    });
    this.starters = el('div', { class: 'chat-starters' });
    this.host.replaceChildren(this.head, el('div', { class: 'chat-body' }, [this.log, this.starters, form]));
    this.#renderHead();
    this.#renderLog();
  }

  #renderHead() {
    const node = this.node;
    if (!node || !this.head) return;
    const label = truncateText(plain(node.text), 60);
    this.head.replaceChildren(
      el('span', {}, '💬'),
      el('strong', { title: plain(node.text) }, label),
      el('button', { class: 'icon-btn', title: 'Collapse', onclick: () => this.host.classList.toggle('collapsed') }, '▾'),
      el('button', { class: 'icon-btn', title: 'Close chat', onclick: () => this.close() }, '✕'),
    );
    this.starters?.replaceChildren(...STARTERS.map((s) => el('button', { type: 'button', onclick: () => this.ask(s.ask(label)) }, s.label)));
  }

  #renderLog() {
    const items = this.thread.map((m) => this.#bubble(m));
    if (!items.length) items.push(el('p', { class: 'chat-note' }, 'Answers come from what is said in the video, with ▶ links to the exact moments.'));
    this.log.replaceChildren(...items);
    this.log.scrollTop = this.log.scrollHeight;
  }

  #bubble(msg) {
    const bubble = el('div', { class: `chat-msg ${msg.role === 'user' ? 'user' : 'bot'}${msg.pending ? ' typing' : ''}` }, msg.role === 'user' ? msg.text : this.#rich(msg.text));
    if (msg.role !== 'user' && msg.sources?.length && !msg.pending) {
      const cited = new Set([...msg.text.matchAll(TS_RE)].map((m) => m[1]));
      const extra = msg.sources.filter((s) => !cited.has(fmtTime(s.start))).slice(0, 3);
      if (extra.length) bubble.append(el('div', { class: 'chat-note' }, ['Also in the video: ', ...extra.map((s) => this.#chip(s.start, s.text))]));
    }
    return bubble;
  }

  /** Text with [m:ss] citations turned into ▶ chips that seek the video. */
  #rich(text) {
    const out = [];
    let last = 0;
    for (const m of String(text || '').matchAll(TS_RE)) {
      out.push(text.slice(last, m.index), this.#chip(toSeconds(m[1])));
      last = m.index + m[0].length;
    }
    out.push(String(text || '').slice(last));
    return out.filter((x) => x !== '');
  }

  #chip(seconds, title) {
    return el('button', { type: 'button', class: 'ts-chip', title: title ? truncateText(title, 160) : 'Watch this moment', onclick: () => this.seek({ ...this.node, start: seconds }) }, `▶ ${fmtTime(seconds)}`);
  }

  // ---------------------------------------------------------------------------
  async ask(question) {
    const node = this.node;
    if (!node) return;
    this.input.value = '';
    const history = this.thread.slice(-HISTORY_MESSAGES).map(({ role, text }) => ({ role, text }));
    this.thread.push({ role: 'user', text: question });
    const answer = { role: 'assistant', text: '', sources: [], pending: true };
    this.thread.push(answer);
    this.#renderLog();
    const bubble = this.log.lastElementChild;
    const paint = () => {
      bubble.replaceChildren(...this.#rich(answer.text));
      this.log.scrollTop = this.log.scrollHeight;
    };

    this.controller?.abort();
    this.controller = new AbortController();
    try {
      if (!this.api.online) throw new Error('offline');
      await this.api.chat(this.model.toJSON(), node.id, question, history, (event) => {
        if (event.type === 'sources') answer.sources = event.sources || [];
        if (event.type === 'delta') {
          answer.text += event.text;
          paint();
        }
      }, { signal: this.controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') return;
      const local = localAnswer(this.model, node, question);
      answer.text = local.text;
      answer.sources = local.sources;
      if (err.message !== 'offline') toast('Answered from the transcript (the assistant is unavailable right now).');
    }
    answer.pending = false;
    if (!answer.text.trim()) answer.text = 'I could not find this in the video.';
    this.#renderLog();
  }
}

function toSeconds(stamp) {
  return stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** Offline fallback: transcript lines that share the most words with the question, near the node first. */
export function localAnswer(model, node, question) {
  const entries = model.map?.transcript || [];
  const words = [...new Set(`${question} ${plain(node.text)}`.toLowerCase().match(/[a-z0-9ऀ-ॿ]{4,}/g) || [])].filter((w) => !STOP.has(w));
  const start = node.start ?? null;
  const end = node.end ?? (start !== null ? start + 60 : null);
  const scored = entries
    .map((e) => {
      const low = e.text.toLowerCase();
      let score = words.reduce((s, w) => s + (low.includes(w) ? 1 : 0), 0);
      if (start !== null && e.start >= start - 20 && e.start <= end + 20) score += 1.5;
      return { e, score };
    })
    .filter((x) => x.score > 0 && x.e.text.length > 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .sort((a, b) => a.e.start - b.e.start);
  if (!scored.length) return { text: 'I could not find this in the video.', sources: [] };
  return {
    text: `Here is what the video says about this:\n${scored.map(({ e }) => `• [${fmtTime(e.start)}] ${truncateText(e.text, 220)}`).join('\n')}`,
    sources: scored.map(({ e }) => ({ start: e.start, end: e.end, text: e.text })),
  };
}

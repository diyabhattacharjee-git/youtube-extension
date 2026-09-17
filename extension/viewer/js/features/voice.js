/**
 * Voice-interactive mindmaps (Web Speech API, runs locally in the browser).
 *
 * Commands (say "help" to list them):
 *   expand / open <topic>        collapse / close <topic>
 *   go to / show / select <topic>
 *   play / watch [<topic>]        jump the video to the node
 *   read / explain [<topic>]      text-to-speech of the node + summary
 *   next / previous / parent / child
 *   zoom in / zoom out / overview (fit)
 *   search <query>                layer overview | clusters | concepts | transcript
 *   add note <text>               add child <text>
 *   undo / redo / stop listening
 */
import { fuzzyScore, plain, toast } from './shared.js';

const LAYERS = { overview: 1, clusters: 2, concepts: 3, transcript: 4, all: 4 };

export class VoiceController extends EventTarget {
  constructor({ model, renderer, seek, search, setLayer, lang = 'en-US', indicator, profile }) {
    super();
    Object.assign(this, { model, renderer, seek, search, setLayer, lang, indicator, profile });
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!Recognition;
    if (!this.supported) return;
    this.rec = new Recognition();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = lang;
    this.rec.onresult = (e) => this.#onResult(e);
    this.rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Microphone permission denied.', { type: 'error' });
        this.stop();
      }
    };
    this.rec.onend = () => this.listening && this.rec.start(); // keep listening until stopped
  }

  async start() {
    if (!this.supported) {
      toast('Voice commands need a browser with the Web Speech API (Chrome, Edge).', { type: 'error' });
      return;
    }
    try {
      // Extension pages must ask for the mic explicitly before recognition can use it.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      toast('Microphone permission is required for voice commands.', { type: 'error' });
      return;
    }
    this.listening = true;
    this.rec.start();
    this.#indicate('Listening… say "help"');
    this.profile?.track('voice');
    this.dispatchEvent(new Event('state'));
  }

  stop() {
    this.listening = false;
    this.rec?.stop();
    this.indicator.hidden = true;
    this.dispatchEvent(new Event('state'));
  }

  toggle() {
    return this.listening ? this.stop() : this.start();
  }

  #indicate(text) {
    this.indicator.hidden = false;
    this.indicator.textContent = `🎙 ${text}`;
  }

  #onResult(event) {
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else this.#indicate(`${res[0].transcript}…`);
    }
    if (finalText.trim()) this.execute(finalText.trim().toLowerCase());
  }

  findNode(query) {
    if (!query) return this.model.get(this.renderer.selectedId) || null;
    let best = null;
    let bestScore = 0.25;
    for (const node of this.model.nodes()) {
      const score = fuzzyScore(query, node.text) + (node.type === 'section' || node.type === 'concept' ? 0.05 : 0);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  }

  #focus(node) {
    this.renderer.reveal(node.id);
    this.renderer.select(node.id);
    this.renderer.centerOn(node.id);
  }

  execute(text) {
    this.#indicate(`“${text}”`);
    const m = (re) => text.match(re);
    let match;
    const selected = this.model.get(this.renderer.selectedId);

    if ((match = m(/^(?:expand|open|unfold)\s*(.*)$/))) {
      const node = this.findNode(match[1]);
      if (node) {
        this.#focus(node);
        this.model.setCollapsed(node.id, false);
      }
    } else if ((match = m(/^(?:collapse|close|fold|hide)\s*(.*)$/))) {
      const node = this.findNode(match[1]);
      if (node) this.model.setCollapsed(node.id, true);
    } else if ((match = m(/^(?:go to|goto|show|select|find|jump to)\s+(.+)$/))) {
      const node = this.findNode(match[1]);
      if (node) this.#focus(node);
      else toast(`No node matches “${match[1]}”`);
    } else if ((match = m(/^(?:play|watch)\s*(.*)$/))) {
      const node = this.findNode(match[1]) || selected;
      if (node) this.seek(node);
    } else if ((match = m(/^(?:read|explain|what is|tell me about)\s*(.*)$/))) {
      const node = this.findNode(match[1]) || selected;
      if (node) {
        this.#focus(node);
        this.speak(`${plain(node.text)}. ${node.summary || ''}`);
      }
    } else if (/^(next|previous|prev|back)$/.test(text) && selected) {
      const parent = this.model.parentOf(selected.id);
      if (parent) {
        const i = parent.children.indexOf(selected);
        const sibling = parent.children[(i + (text === 'next' ? 1 : -1) + parent.children.length) % parent.children.length];
        this.#focus(sibling);
      }
    } else if (/^(parent|up)$/.test(text) && selected) {
      const parent = this.model.parentOf(selected.id);
      if (parent) this.#focus(parent);
    } else if (/^(child|down|first child)$/.test(text) && selected?.children?.length) {
      this.#focus(selected.children[0]);
    } else if (/zoom in/.test(text)) {
      this.renderer.zoomBy(1.3);
    } else if (/zoom out/.test(text)) {
      this.renderer.zoomBy(1 / 1.3);
    } else if (/^(overview|fit|show all|reset view)$/.test(text)) {
      this.renderer.fit();
    } else if ((match = m(/^search (?:for )?(.+)$/))) {
      this.search(match[1]);
    } else if ((match = m(/^(?:layer|show layer|level)\s+(\w+)/))) {
      if (LAYERS[match[1]]) this.setLayer(LAYERS[match[1]]);
    } else if ((match = m(/^add note\s+(.+)$/)) && selected) {
      this.model.update(selected.id, { notes: [selected.notes, match[1]].filter(Boolean).join('\n') });
      toast('Note added ✎');
    } else if ((match = m(/^add (?:child|idea|node)\s+(.+)$/)) && selected) {
      const child = this.model.addChild(selected.id, { text: match[1] });
      this.#focus(child);
    } else if (/^undo$/.test(text)) {
      this.model.undo();
    } else if (/^redo$/.test(text)) {
      this.model.redo();
    } else if (/stop listening|stop voice|turn off/.test(text)) {
      this.stop();
    } else if (/^help/.test(text)) {
      this.speak('Try: expand quantum, go to summary, play, read, next, zoom in, search entanglement, layer overview, add note, stop listening.');
    } else {
      toast(`🎙 Didn’t catch a command: “${text}”`);
    }
  }

  speak(text) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.lang;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }
}

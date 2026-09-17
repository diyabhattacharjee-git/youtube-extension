/**
 * Collaboration client: real-time shared editing over the backend WebSocket,
 * presence (who is looking at which node), cloud sync of the room map and
 * merging a local copy into a shared room.
 *
 * Consistency model: the server applies ops in arrival order and stamps a room
 * version. Local ops are applied optimistically; if a remote op interleaves with
 * pending local ops, our ops are re-applied when their echo arrives so every
 * client converges on the server's order. Any version gap → full snapshot.
 */
import { isLocalOnly } from '../mindmap/model.js';
import { toast } from './shared.js';

export class CollabClient extends EventTarget {
  constructor({ api, model, renderer, settings }) {
    super();
    Object.assign(this, { api, model, renderer, settings });
    this.status = 'offline';
    this.roomId = null;
    this.version = 0;
    this.pending = new Map(); // clientOpId -> ops
    this.interleaved = false;
    this.users = [];
    this.leaderboard = null;

    model.addEventListener('change', (e) => {
      const { ops, origin, localOnly } = e.detail;
      if (this.status !== 'online' || origin === 'remote' || localOnly) return;
      const shareable = ops.filter((op) => !isLocalOnly(op));
      if (shareable.length) this.#sendOps(shareable);
    });
    renderer.addEventListener('select', (e) => this.send({ type: 'presence', nodeId: e.detail.ids.at(-1) || null }));
  }

  /** Create a room from the current map and join it. */
  async share() {
    const { roomId } = await this.api.createRoom(this.model.toJSON());
    await this.connect(roomId);
    return roomId;
  }

  connect(roomId) {
    this.disconnect();
    this.roomId = roomId.trim();
    this.#setStatus('connecting');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.api.wsBase}/ws/rooms/${encodeURIComponent(this.roomId)}`);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', user: { id: this.settings.userId, name: this.settings.userName, color: this.settings.userColor } }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'error' && !settled) {
          settled = true;
          reject(new Error(msg.message));
          return;
        }
        this.#onMessage(msg);
        if (msg.type === 'snapshot' && !settled) {
          settled = true;
          resolve(this.roomId);
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not connect to collaboration server'));
        }
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.#setStatus('offline');
        if (this.roomId && !this.closing) {
          toast('Collaboration disconnected — reconnecting…', { type: 'error' });
          setTimeout(() => this.roomId && !this.closing && this.connect(this.roomId).catch(() => {}), 2500);
        }
      };
    });
  }

  disconnect() {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
    this.closing = false;
    this.#setStatus('offline');
    this.renderer.setPresence([]);
  }

  leave() {
    this.roomId = null;
    this.disconnect();
    this.dispatchEvent(new Event('left'));
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendEvent(event, detail) {
    this.send({ type: 'event', event, detail });
  }

  /** Merge a (possibly offline-edited) map into the shared room map. */
  mergeIntoRoom(map) {
    this.send({ type: 'merge', map });
  }

  #sendOps(ops) {
    const clientOpId = crypto.randomUUID().slice(0, 12);
    this.pending.set(clientOpId, ops);
    this.send({ type: 'op', ops, clientOpId });
  }

  #setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, roomId: this.roomId } }));
  }

  #onMessage(msg) {
    switch (msg.type) {
      case 'snapshot': {
        const collapsed = new Map();
        if (this.model.map) this.model.walk((n) => collapsed.set(n.id, n.collapsed));
        const map = msg.map;
        const restore = (n) => {
          if (collapsed.has(n.id)) n.collapsed = collapsed.get(n.id);
          (n.children || []).forEach(restore);
        };
        restore(map.root);
        map.meta = { ...(map.meta || {}), roomId: this.roomId };
        this.model.load(map);
        this.version = msg.version;
        this.pending.clear();
        this.interleaved = false;
        this.#setStatus('online');
        this.#presence(msg.users);
        this.dispatchEvent(new CustomEvent('snapshot', { detail: { map } }));
        break;
      }
      case 'op': {
        const own = msg.clientOpId && this.pending.has(msg.clientOpId);
        if (own) {
          const sent = this.pending.get(msg.clientOpId);
          this.pending.delete(msg.clientOpId);
          if (msg.ops.length !== sent.length) this.send({ type: 'sync' }); // server rejected something
          else if (this.interleaved) this.model.apply(msg.ops, { origin: 'remote' });
          if (!this.pending.size) this.interleaved = false;
          this.version = msg.version;
          break;
        }
        if (msg.version !== this.version + 1) {
          this.send({ type: 'sync' });
          break;
        }
        if (this.pending.size) this.interleaved = true;
        this.model.apply(msg.ops, { origin: 'remote' });
        this.version = msg.version;
        break;
      }
      case 'presence':
        this.#presence(msg.users);
        break;
      case 'leaderboard':
        this.leaderboard = msg;
        this.dispatchEvent(new CustomEvent('leaderboard', { detail: msg }));
        break;
      case 'badge':
        toast(`${msg.emoji} ${msg.userId === this.settings.userId ? 'You' : msg.name} earned “${msg.title}”!`, { type: 'success', timeout: 5000 });
        this.dispatchEvent(new CustomEvent('badge', { detail: msg }));
        break;
      case 'error':
        toast(`Collaboration: ${msg.message}`, { type: 'error' });
        break;
      default:
    }
  }

  #presence(users = []) {
    this.users = users;
    this.renderer.setPresence(users.filter((u) => u.id !== this.settings.userId));
    this.dispatchEvent(new CustomEvent('presence', { detail: { users } }));
  }
}

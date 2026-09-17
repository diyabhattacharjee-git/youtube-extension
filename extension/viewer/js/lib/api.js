/** Client for the TubeMind Python backend (see backend/app/main.py). */

export class BackendError extends Error {}

export class Api {
  constructor(baseUrl) {
    this.setBase(baseUrl);
    this.health = null;
  }

  setBase(baseUrl) {
    this.base = String(baseUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  }

  get wsBase() {
    return this.base.replace(/^http/, 'ws');
  }

  async request(path, { method = 'GET', body, timeout = 120000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new BackendError(data.detail || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      if (err instanceof BackendError) throw err;
      if (err.name === 'AbortError') throw new BackendError('Backend request timed out');
      throw new BackendError(`Backend unreachable at ${this.base} — is it running? (${err.message})`);
    } finally {
      clearTimeout(timer);
    }
  }

  async checkHealth() {
    try {
      this.health = await this.request('/api/health', { timeout: 4000 });
    } catch {
      this.health = null;
    }
    return this.health;
  }

  get online() {
    return !!this.health?.ok;
  }

  /** Start the pipeline and poll until done. `onProgress({stage, progress, log})`. */
  async generate(payload, onProgress, { interval = 1200, signal } = {}) {
    const { jobId } = await this.request('/api/jobs', { method: 'POST', body: payload });
    for (;;) {
      if (signal?.aborted) throw new BackendError('Cancelled');
      const job = await this.request(`/api/jobs/${jobId}`, { timeout: 15000 });
      onProgress?.(job);
      if (job.status === 'done') return job.result;
      if (job.status === 'error') throw new BackendError(job.error || 'Pipeline failed');
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  refine(map, action, nodeIds, instruction = '') {
    return this.request('/api/refine', { method: 'POST', body: { map: slim(map), action, nodeIds, instruction } });
  }

  search(map, query, limit = 12) {
    return this.request('/api/search', { method: 'POST', body: { map: slim(map, false), query, limit } });
  }

  study(map, count = 12, focusIds = null) {
    return this.request('/api/study', { method: 'POST', body: { map: slim(map, false), count, focusIds } });
  }

  merge(maps) {
    return this.request('/api/merge', { method: 'POST', body: { maps } });
  }

  link(maps) {
    return this.request('/api/link', { method: 'POST', body: { maps: maps.map((m) => slim(m, false)) } });
  }

  notion(map) {
    return this.request('/api/export/notion', { method: 'POST', body: { map: slim(map, false) } });
  }

  createRoom(map) {
    return this.request('/api/rooms', { method: 'POST', body: { map } });
  }

  getRoom(roomId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}`);
  }

  putRoom(roomId, map, baseVersion) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'PUT', body: { map, baseVersion } });
  }
}

/** Drop heavy fields the server does not need (images, knowledge graph; optionally transcript). */
export function slim(map, keepTranscript = true) {
  const strip = (node) => ({
    ...node,
    image: node.image ? { t: node.image.t, source: node.image.source } : null,
    children: (node.children || []).map(strip),
  });
  const out = { ...map, root: strip(map.root) };
  delete out.graph;
  if (!keepTranscript) delete out.transcript;
  return out;
}

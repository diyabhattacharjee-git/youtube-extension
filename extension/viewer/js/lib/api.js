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

  /**
   * Skeleton-first generation. POST /api/jobs returns the complete map (built from the
   * transcript, no AI) in the same response, plus a jobId when the single AI label call
   * is still running. `{ map, jobId, pending, cached }`
   */
  startJob(payload) {
    return this.request('/api/jobs', { method: 'POST', body: payload, timeout: 60000 });
  }

  /**
   * Long-poll a job: each request returns as soon as the skeleton (hasMap=false) or the
   * label ops (hasMap=true) are ready, so there is no fixed polling interval.
   * Resolves with the job once `status` is done; `onProgress(job)` sees interim states.
   */
  async waitJob(jobId, { hasMap = false, onProgress, signal } = {}) {
    for (;;) {
      if (signal?.aborted) throw new BackendError('Cancelled');
      const job = await this.request(`/api/jobs/${jobId}?wait=20&hasMap=${hasMap ? 1 : 0}`, { timeout: 30000 });
      onProgress?.(job);
      if (job.status === 'error') throw new BackendError(job.error || 'Pipeline failed');
      if (job.status === 'done' || (!hasMap && job.map)) return job;
    }
  }

  /**
   * Node chatbot. Streams NDJSON events: {type:'sources'|'delta'|'done'}.
   * `onEvent(event)` is called for each one; resolves when the stream ends.
   */
  async chat(map, nodeId, question, history, onEvent, { signal } = {}) {
    let res;
    try {
      res = await fetch(`${this.base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ map: slim(map), nodeId, question, history }),
        signal,
      });
    } catch (err) {
      throw new BackendError(`Backend unreachable (${err.message})`);
    }
    if (!res.ok || !res.body) throw new BackendError(`HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
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

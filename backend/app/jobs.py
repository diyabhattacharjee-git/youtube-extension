"""
In-memory background jobs + an on-disk result cache.

A job goes through two phases:
  1. skeleton — the complete map built from the transcript (published as `job.map`)
  2. labels   — optional single LLM call; published as `job.ops` (update / edge ops)
Clients long-poll `GET /api/jobs/{id}?wait=…`: one request returns as soon as the
phase they are waiting for is finished.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import settings

log = logging.getLogger("tubemind.jobs")
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="tubemind-job")


@dataclass
class Job:
    id: str
    key: str = ""
    status: str = "queued"  # queued | running | done | error
    stage: str = "Queued"
    progress: float = 0.0
    map: dict | None = None
    ops: list[dict] | None = None
    meta: dict = field(default_factory=dict)
    error: str | None = None
    labels: bool = False  # run the label call after the skeleton
    created: float = field(default_factory=time.time)
    log: list[dict] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    map_ready: threading.Event = field(default_factory=threading.Event)
    finished: threading.Event = field(default_factory=threading.Event)

    def report(self, stage: str, pct: float) -> None:
        self.stage, self.progress = stage, max(self.progress, min(pct, 1.0))
        self.log.append({"t": round(time.time() - self.created, 2), "stage": stage})

    def publish_map(self, mindmap: dict) -> bool:
        """Expose the skeleton. Returns whether labels should run (read under the lock)."""
        with self.lock:
            self.map = mindmap
            self.map_ready.set()
            return self.labels

    def request_labels(self) -> bool:
        """Ask a still-running job to label its skeleton. False when it is too late (map already out)."""
        with self.lock:
            if self.map is None and not self.finished.is_set():
                self.labels = True
                return True
            return self.labels

    def to_dict(self, include_map: bool = True) -> dict:
        out = {
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "progress": round(self.progress, 3),
            "error": self.error,
            "hasMap": self.map is not None,
            "labels": self.labels,
            "log": self.log[-20:],
        }
        if include_map and self.map is not None:
            out["map"] = self.map
        if self.status == "done":
            out["ops"] = self.ops or []
            out["meta"] = self.meta
        return out


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(self, fn: Callable[[Job], Any], key: str = "", labels: bool = False) -> Job:
        job = Job(uuid.uuid4().hex[:12], key=key, labels=labels)
        with self._lock:
            self._jobs[job.id] = job
            self._gc()

        def run() -> None:
            job.status = "running"
            try:
                fn(job)
                job.status, job.progress, job.stage = "done", 1.0, "Done"
            except Exception as exc:  # noqa: BLE001
                log.error("job %s failed: %s\n%s", job.id, exc, traceback.format_exc())
                job.status, job.error = "error", str(exc)
            finally:
                job.map_ready.set()
                job.finished.set()

        _pool.submit(run)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def running(self, key: str, *, labels_only: bool = False) -> Job | None:
        """A still-running job for this cache key (dedupes prefetch + click)."""
        with self._lock:
            for job in self._jobs.values():
                if job.key == (f"labels:{key}" if labels_only else key) and not job.finished.is_set():
                    return job
        return None

    def _gc(self, max_age: float = 3600) -> None:
        now = time.time()
        for jid in [j.id for j in self._jobs.values() if now - j.created > max_age]:
            self._jobs.pop(jid, None)


jobs = JobStore()


# -- cache ------------------------------------------------------------------------
# Only what changes the map's CONTENT is part of the key. Presentation options
# (theme, layout…) and whether AI polishing was on do not cause misses.
# MAP_VERSION changes when the map format changes (2 = English-only revision sketchbook, 3 = Detailed maps fully expanded), so maps
# cached by an older pipeline — e.g. built from untranslated Hindi text — are rebuilt once.
MAP_VERSION = 3


def cache_key(request: dict) -> str:
    relevant = {**{k: request.get(k) for k in ("videoId", "mode")}, "v": MAP_VERSION}
    return hashlib.sha1(json.dumps(relevant, sort_keys=True).encode()).hexdigest()[:20]


_memory: OrderedDict[str, str] = OrderedDict()  # key -> raw JSON text (hot entries)
_memory_lock = threading.Lock()
MEMORY_ENTRIES = 24


def _path(key: str):
    return settings.data_dir / "cache" / f"{key}.json"


def cache_get_raw(key: str) -> str | None:
    """Raw JSON text of a cached map (served as-is: no parse/re-encode on the hot path)."""
    with _memory_lock:
        if key in _memory:
            _memory.move_to_end(key)
            return _memory[key]
    path = _path(key)
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    _remember(key, raw)
    return raw


def cache_get(key: str) -> dict | None:
    raw = cache_get_raw(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def cache_put(key: str, value: dict) -> None:
    raw = json.dumps(value, ensure_ascii=False)
    _remember(key, raw)
    _path(key).write_text(raw, encoding="utf-8")


def _remember(key: str, raw: str) -> None:
    with _memory_lock:
        _memory[key] = raw
        _memory.move_to_end(key)
        while len(_memory) > MEMORY_ENTRIES:
            _memory.popitem(last=False)

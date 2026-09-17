"""In-memory background jobs with progress reporting + an on-disk result cache."""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import settings

log = logging.getLogger("tubemind.jobs")
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tubemind-job")


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error
    stage: str = "Queued"
    progress: float = 0.0
    result: Any = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    log: list[dict] = field(default_factory=list)

    def to_dict(self, include_result: bool = True) -> dict:
        out = {"id": self.id, "status": self.status, "stage": self.stage, "progress": round(self.progress, 3), "error": self.error, "log": self.log[-20:]}
        if include_result and self.status == "done":
            out["result"] = self.result
        return out


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(self, fn: Callable[[Callable[[str, float], None]], Any]) -> Job:
        job = Job(uuid.uuid4().hex[:12])
        with self._lock:
            self._jobs[job.id] = job
            self._gc()

        def progress(stage: str, pct: float) -> None:
            job.stage, job.progress = stage, max(job.progress, min(pct, 1.0))
            job.log.append({"t": round(time.time() - job.created, 1), "stage": stage})

        def run() -> None:
            job.status = "running"
            try:
                job.result = fn(progress)
                job.status, job.progress, job.stage = "done", 1.0, "Done"
            except Exception as exc:  # noqa: BLE001
                log.error("job %s failed: %s\n%s", job.id, exc, traceback.format_exc())
                job.status, job.error = "error", str(exc)

        _pool.submit(run)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def _gc(self, max_age: float = 3600) -> None:
        now = time.time()
        for jid in [j.id for j in self._jobs.values() if now - j.created > max_age]:
            self._jobs.pop(jid, None)


jobs = JobStore()


# -- cache ------------------------------------------------------------------------
def cache_key(request: dict) -> str:
    relevant = {k: request.get(k) for k in ("videoId", "mode", "profile", "useLLM", "frames")}
    return hashlib.sha1(json.dumps(relevant, sort_keys=True).encode()).hexdigest()[:20]


def cache_get(key: str) -> dict | None:
    path = settings.data_dir / "cache" / f"{key}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
    return None


def cache_put(key: str, value: dict) -> None:
    path = settings.data_dir / "cache" / f"{key}.json"
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

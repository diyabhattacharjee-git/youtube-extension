"""
TubeMind backend — FastAPI application.

Run:  cd backend && python -m app.main      (or: uvicorn app.main:app --port 8765)

Endpoints
---------
GET  /api/health                     capabilities (LLM provider, embeddings, whisper, keyframes)
POST /api/jobs                       Video → Mindmap: returns the complete skeleton map inline (≈0.1–0.5 s)
                                     plus a jobId whose single label call yields `update` ops
GET  /api/jobs/{id}?wait=&hasMap=    long-poll: returns when the skeleton / the label ops are ready
POST /api/prefetch                   warm the cache while the user is still on YouTube (no LLM)
POST /api/chat                       node chatbot (streamed NDJSON, one LLM call per message)
POST /api/transcript                 transcript only (layer 1)
POST /api/refine                     AI refinement -> ops (expand, rewrite, summarize, reorganize, merge)
POST /api/search                     semantic node search
POST /api/study                      flashcards + quiz
POST /api/merge                      merge several mindmaps
POST /api/link                       cross-video knowledge linking (+ Knowledge Hub map)
POST /api/export/notion              push a map to Notion
POST /api/rooms                      create collaboration room (cloud sync)
GET  /api/rooms/{id}                 fetch room snapshot
PUT  /api/rooms/{id}                 replace room map (optimistic version check)
POST /api/rooms/{id}/merge           merge a map into the room
WS   /ws/rooms/{id}                  real-time collaboration channel
"""
from __future__ import annotations

import copy
from contextlib import asynccontextmanager
import json
import logging
import re
import threading
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .collab.rooms import manager
from .config import has_module, settings
from .features.chat import chat_stream
from .features.merge import link_videos, merge_maps
from .features.notion import push_to_notion
from .features.refine import refine
from .features.search import semantic_search
from .features.study import generate_study_set
from .jobs import Job, cache_get, cache_get_raw, cache_key, cache_put, jobs
from .pipeline import labels, llm, multimodal, translate
from .pipeline.builder import DEFAULT_MODE, build_skeleton
from .pipeline.embeddings import backend_name
from .pipeline.transcript import TranscriptUnavailable, get_transcript

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tubemind")

WARMUP_TOPICS = [
    "Vector stores keep document embeddings so similar passages can be retrieved quickly. A vector database adds persistence and access control.",
    "Neural networks learn weights with gradient descent. The learning rate controls how far each weight update moves.",
    "Supply chains depend on reliable shipping routes. When a port closes, freight costs rise and delivery times grow.",
    "Photosynthesis turns sunlight, water and carbon dioxide into glucose. Chlorophyll absorbs the light energy inside the leaf.",
    "Interest rates shape borrowing costs. When the central bank raises rates, mortgage payments and business loans become expensive.",
]
WARMUP_TRANSCRIPT = [
    {"start": float(i * 6), "duration": 6.0, "text": sentence}
    for i, sentence in enumerate(sentence for topic in WARMUP_TOPICS for _ in range(4) for sentence in topic.split(". "))
]


def warm_up() -> None:
    """
    Import/JIT the heavy libraries and open the LLM connection before the first click.
    The NLLB translation model is loaded ONCE here, in its own thread (plus one dummy
    translation); requests that arrive meanwhile wait for that same load, never a second one.
    """
    threading.Thread(target=translate.warm_up, name="tubemind-nllb", daemon=True).start()

    def run() -> None:
        started = time.perf_counter()
        try:
            from .pipeline import embeddings

            if embeddings.has_module("sentence_transformers"):
                embeddings._bert_model()
            # a small but realistic lecture, so every stage (TF-IDF, LSA, concept graph,
            # PageRank, communities, LDA, grounding) runs once before the first real click
            for mode in ("academic", "revision"):
                build_skeleton({"videoId": "WARMUPVIDEO", "title": "Warm up", "transcript": WARMUP_TRANSCRIPT, "mode": mode, "useLLM": False, "allowWhisper": False})
        except Exception as exc:  # noqa: BLE001 - warm-up is best effort
            log.warning("warm-up (pipeline) failed: %s", exc)
        llm.warm_up()
        log.info("warm-up done in %.0f ms", (time.perf_counter() - started) * 1000)

    threading.Thread(target=run, name="tubemind-warmup", daemon=True).start()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    warm_up()
    yield


app = FastAPI(title="TubeMind", version="1.0.0", description="YouTube → interactive mindmap pipeline", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins) or ["*"],
    allow_origin_regex=r"^(chrome|moz|edge)-extension://.*$",
    allow_methods=["*"],
    allow_headers=["*"],
)

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class MindmapRequest(BaseModel):
    videoId: str
    title: str | None = None
    channel: str | None = None
    description: str | None = ""
    duration: float | None = None
    chapters: list[dict] | None = None
    transcript: list[dict] | None = None
    languages: list[str] | None = None
    storyboardSpec: str | None = None
    mode: str = DEFAULT_MODE  # revision (Short) | academic (Standard) | deep (Detailed)
    useLLM: bool = True
    allowWhisper: bool = True
    frames: bool = False  # server-side slide/chart keyframes (needs opencv + yt-dlp)
    noCache: bool = False


class MapBody(BaseModel):
    map: dict[str, Any]


class ChatBody(MapBody):
    nodeId: str
    question: str
    history: list[dict] = Field(default_factory=list)


class RefineBody(MapBody):
    action: str
    nodeIds: list[str]
    instruction: str = ""


class SearchBody(MapBody):
    query: str
    limit: int = 12


class StudyBody(MapBody):
    count: int = Field(12, ge=1, le=40)
    focusIds: list[str] | None = None


class MapsBody(BaseModel):
    maps: list[dict[str, Any]]
    threshold: float | None = None


class RoomPut(MapBody):
    baseVersion: int | None = None


def extract_video_id(value: str) -> str:
    value = value.strip()
    if VIDEO_ID_RE.match(value):
        return value
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})", value)
    if not m:
        raise HTTPException(400, "Not a YouTube video id or URL")
    return m.group(1)


# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "version": app.version,
        "llm": llm.provider_name(),
        "groq": settings.groq_enabled,
        "embeddings": backend_name(),
        "translation": translate.status(),
        "whisper": has_module("faster_whisper") or has_module("whisper"),
        "keyframes": multimodal.available(),
        "spacy": has_module("spacy"),
        "notion": bool(settings.notion_token and settings.notion_parent_page_id),
    }


SKELETON_WAIT = 25.0  # seconds POST /api/jobs waits for the skeleton before handing back a jobId


def _payload(req: MindmapRequest) -> dict:
    payload = req.model_dump()
    payload["videoId"] = extract_video_id(req.videoId)
    return payload


def _pipeline(job: Job, payload: dict, key: str) -> None:
    """Skeleton (cached immediately) → optional single label call → optional keyframes."""
    skeleton = build_skeleton(payload, job.report)
    _cache_map(key, skeleton)
    if job.publish_map(skeleton):
        _label(job, skeleton, key)
    else:
        _log_timing(job, skeleton)
    if payload.get("frames") and multimodal.available():
        try:
            frames = multimodal.extract_keyframes(payload["videoId"], progress=lambda m, p: job.report(m, 0.9 + p * 0.09))
            latest = cache_get(key) or skeleton
            latest["meta"]["keyframes"] = multimodal.attach_frames(latest, frames)
            cache_put(key, latest)
        except Exception as exc:  # noqa: BLE001 - keyframes are a bonus, never fatal
            log.warning("keyframe extraction failed: %s", exc)


def _label(job: Job, skeleton: dict, key: str) -> None:
    job.report("Polishing", 0.9)
    outcome = labels.label_map(skeleton)
    job.ops, job.meta = outcome["ops"], {**outcome["meta"], "labelStats": outcome["stats"]}
    started = time.perf_counter()
    if outcome["ops"] or outcome["meta"].get("labelled"):
        _cache_map(key, labels.apply_outcome(copy.deepcopy(skeleton), outcome))
    _log_timing(job, skeleton, outcome["stats"], (time.perf_counter() - started) * 1000)


def _coverage(mindmap: dict) -> float:
    """Share of the video the map was built from (< 1: a quick map from a partly translated transcript)."""
    return float(((mindmap.get("meta") or {}).get("translation") or {}).get("coverage", 1.0))


def _cache_map(key: str, mindmap: dict) -> None:
    """Cache a map unless a more complete one (full translation) is already there."""
    if _coverage(mindmap) < 1:
        current = cache_get(key)
        if current is not None and _coverage(current) > _coverage(mindmap):
            return
    cache_put(key, mindmap)


def _log_timing(job: Job, skeleton: dict, stats: dict | None = None, cache_ms: float = 0.0) -> None:
    """One line per map: where the time went between the request and the fully labelled map."""
    t = skeleton.get("meta", {}).get("timings") or {}
    stats = stats or {}
    log.info(
        "timing %s lang=%s detect=%dms translate=%dms skeleton=%dms summary=%dms llm=%dms apply=%dms total=%dms (llm_calls=%d%s)",
        skeleton["meta"].get("videoId"), skeleton["meta"].get("sourceLanguage", "en"), t.get("detect", 0), t.get("translate", 0), t.get("skeleton", 0),
        t.get("summary", 0), stats.get("llm_ms", 0), stats.get("apply_ms", 0) + cache_ms, (time.time() - job.created) * 1000,
        stats.get("calls", 0), f", errors={stats['errors']}" if stats.get("errors") else "",
    )


def _label_job(key: str, skeleton: dict) -> Job:
    running = jobs.running(key, labels_only=True)
    if running:
        return running
    job = jobs.submit(lambda j: _label(j, skeleton, key), key=f"labels:{key}", labels=True)
    job.publish_map(skeleton)
    return job


@app.post("/api/jobs")
def start_job(req: MindmapRequest) -> Response:
    started = time.perf_counter()
    payload = _payload(req)
    key = cache_key(payload)
    want_llm = req.useLLM and llm.fast_available()

    raw = None if req.noCache else cache_get_raw(key)
    cached = json.loads(raw) if raw is not None else None
    if cached is not None and _coverage(cached) < 1 and translate.is_complete(payload["videoId"], cached["meta"].get("sourceLanguage", "")):
        raw = cached = None  # a quick map whose full translation has finished since: rebuild it in full (~0.5 s)
    if cached is not None:
        job = _label_job(key, cached) if want_llm and not cached["meta"].get("labelled") else None
        # the cached JSON text is spliced in as-is: no re-encoding on the hot path
        body = f'{{"jobId": {json.dumps(job.id if job else None)}, "cached": true, "pending": {json.dumps(bool(job))}, "map": {raw}}}'
        log.info("POST /api/jobs %s cache hit in %.1f ms (labels %s)", payload["videoId"], (time.perf_counter() - started) * 1000, "pending" if job else "done/off")
        return Response(body, media_type="application/json")

    pipe = None if req.noCache else jobs.running(key)
    if pipe is not None and pipe.map is None and not pipe.labels and translate.in_progress(payload["videoId"]):
        pipe = None  # the prefetch is still translating the whole video: build a quick map from what is ready
    if pipe is None:
        # a click does not wait for the whole translation: 1/8 of the video, spread evenly, is enough to start
        click = {**payload, "minCoverage": translate.CLICK_COVERAGE}
        pipe = jobs.submit(lambda j: _pipeline(j, click, key), key=key, labels=want_llm)
    elif want_llm:
        pipe.request_labels()  # attach to a running prefetch
    pipe.map_ready.wait(SKELETON_WAIT)
    if pipe.status == "error":
        raise HTTPException(422, pipe.error or "pipeline failed")
    if pipe.map is None:  # still transcribing (e.g. Whisper): the client long-polls this job
        return _json({"jobId": pipe.id, "cached": False, "pending": True, "map": None})

    job = pipe if pipe.labels else (_label_job(key, pipe.map) if want_llm and not pipe.map["meta"].get("labelled") else None)
    log.info("POST /api/jobs %s skeleton in %.0f ms (labels %s)", payload["videoId"], (time.perf_counter() - started) * 1000, "pending" if job else "off")
    return _json({"jobId": job.id if job else None, "cached": False, "pending": bool(job), "map": pipe.map})


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str, wait: float = 0, hasMap: bool = False) -> Response:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    wait = max(0.0, min(wait, 25.0))
    if wait:
        (job.finished if hasMap else job.map_ready).wait(wait)
    return _json(job.to_dict(include_map=not hasMap))


@app.post("/api/prefetch")
def prefetch(req: MindmapRequest) -> dict:
    """Build + cache the skeleton while the user is still watching. Never calls the LLM."""
    payload = {**_payload(req), "useLLM": False, "allowWhisper": False, "frames": False}
    key = cache_key(payload)
    if cache_get_raw(key) is not None:
        return {"status": "cached"}
    if jobs.running(key):
        return {"status": "running"}
    jobs.submit(lambda j: _pipeline(j, payload, key), key=key, labels=False)
    return {"status": "started"}


@app.post("/api/chat")
def chat(body: ChatBody) -> StreamingResponse:
    try:
        stream = chat_stream(body.map, body.nodeId, body.question, body.history)
        first = next(stream)  # surfaces "node not found" as a 400 before streaming starts
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    def events():
        yield first
        yield from stream

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


def _json(obj: dict) -> Response:
    return Response(json.dumps(obj, ensure_ascii=False), media_type="application/json")


@app.post("/api/transcript")
def transcript(req: MindmapRequest) -> dict:
    try:
        t = get_transcript(extract_video_id(req.videoId), req.transcript, req.languages, req.allowWhisper)
    except TranscriptUnavailable as exc:
        raise HTTPException(404, str(exc)) from exc
    return t.to_dict()


@app.post("/api/refine")
def refine_nodes(body: RefineBody) -> dict:
    try:
        return refine(body.map, body.action, body.nodeIds, body.instruction)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/search")
def search(body: SearchBody) -> dict:
    return {"results": semantic_search(body.map, body.query, body.limit)}


@app.post("/api/study")
def study(body: StudyBody) -> dict:
    return generate_study_set(body.map, body.count, body.focusIds)


@app.post("/api/merge")
def merge(body: MapsBody) -> dict:
    try:
        return {"map": merge_maps(body.maps, body.threshold or 0.78)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/link")
def link(body: MapsBody) -> dict:
    return link_videos(body.maps, body.threshold or 0.72)


@app.post("/api/export/notion")
def export_notion(body: MapBody) -> dict:
    try:
        return push_to_notion(body.map)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


# -- collaboration / cloud sync ------------------------------------------------------
@app.post("/api/rooms")
def create_room(body: MapBody) -> dict:
    room = manager.create(body.map)
    return {"roomId": room.id, "version": room.version}


@app.get("/api/rooms/{room_id}")
def get_room(room_id: str) -> dict:
    room = manager.get(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    return {"roomId": room.id, "version": room.version, "map": room.map, "users": room.presence(), "leaderboard": room.leaderboard()}


@app.put("/api/rooms/{room_id}")
async def put_room(room_id: str, body: RoomPut) -> dict:
    room = manager.get(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    return await manager.replace(room, body.map, body.baseVersion)


@app.post("/api/rooms/{room_id}/merge")
async def merge_room(room_id: str, body: MapBody) -> dict:
    room = manager.get(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    return await manager.merge_into(room, body.map)


@app.websocket("/ws/rooms/{room_id}")
async def room_socket(ws: WebSocket, room_id: str) -> None:
    await manager.session(ws, room_id)


def run() -> None:
    import uvicorn

    log.info("TubeMind backend on http://%s:%s  (LLM: %s, embeddings: %s)", settings.host, settings.port, llm.provider_name(), backend_name())
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()

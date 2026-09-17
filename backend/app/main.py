"""
TubeMind backend — FastAPI application.

Run:  cd backend && python -m app.main      (or: uvicorn app.main:app --port 8765)

Endpoints
---------
GET  /api/health                     capabilities (LLM provider, embeddings, whisper, keyframes)
POST /api/jobs                       start Video → Mindmap pipeline, returns {jobId}
GET  /api/jobs/{id}                  progress + result
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

import logging
import re
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .collab.rooms import manager
from .config import has_module, settings
from .features.merge import link_videos, merge_maps
from .features.notion import push_to_notion
from .features.refine import refine
from .features.search import semantic_search
from .features.study import generate_study_set
from .jobs import cache_get, cache_key, cache_put, jobs
from .pipeline import llm, multimodal
from .pipeline.builder import generate_mindmap
from .pipeline.embeddings import backend_name
from .pipeline.transcript import TranscriptUnavailable, get_transcript

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tubemind")

app = FastAPI(title="TubeMind", version="1.0.0", description="YouTube → interactive mindmap pipeline")
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
    mode: str = "academic"  # academic | revision | deep
    profile: str = "balanced"  # visual | balanced | text
    useLLM: bool = True
    allowWhisper: bool = True
    frames: bool = False  # server-side slide/chart keyframes (needs opencv + yt-dlp)
    noCache: bool = False


class MapBody(BaseModel):
    map: dict[str, Any]


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
        "whisper": has_module("faster_whisper") or has_module("whisper"),
        "keyframes": multimodal.available(),
        "spacy": has_module("spacy"),
        "notion": bool(settings.notion_token and settings.notion_parent_page_id),
    }


@app.post("/api/jobs")
def start_job(req: MindmapRequest) -> dict:
    payload = req.model_dump()
    payload["videoId"] = extract_video_id(req.videoId)
    key = cache_key(payload)

    if not req.noCache and (cached := cache_get(key)):
        job = jobs.submit(lambda progress: cached)
        return {"jobId": job.id, "cached": True}

    def run(progress):
        result = generate_mindmap(payload, progress)
        if payload.get("frames") and multimodal.available():
            try:
                frames = multimodal.extract_keyframes(payload["videoId"], progress=lambda m, p: progress(m, 0.9 + p * 0.09))
                result["meta"]["keyframes"] = multimodal.attach_frames(result, frames)
            except Exception as exc:  # noqa: BLE001 - keyframes are a bonus, never fatal
                log.warning("keyframe extraction failed: %s", exc)
        cache_put(key, result)
        return result

    job = jobs.submit(run)
    return {"jobId": job.id, "cached": False}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job.to_dict()


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

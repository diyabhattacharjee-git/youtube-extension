"""
Layer 8 — Collaboration: real-time shared editing, cloud sync, gamification.

* Rooms hold one mindmap. State is persisted in SQLite (`backend/data/tubemind.db`),
  so the backend doubles as a self-hosted "cloud sync" (deploy it anywhere).
* WebSocket protocol (JSON messages):
    client -> server  hello | op | presence | event | sync | merge
    server -> client  snapshot | op | presence | leaderboard | badge | error
* Ordering: the server is the single source of truth. Ops are applied in arrival
  order, the room version increments, and each op batch is broadcast with the
  new version. Clients that detect a version gap request a fresh snapshot.
* Gamified collaboration: points, badges and shared group challenges.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import sqlite3
import time
from dataclasses import dataclass, field

from fastapi import WebSocket

from ..config import settings
from ..features.merge import merge_maps
from ..features.treeutil import walk
from .ops import apply_op

log = logging.getLogger("tubemind.collab")
DB_PATH = settings.data_dir / "tubemind.db"

POINTS = {
    "node_added": 5,
    "node_edited": 2,
    "note_added": 3,
    "link_added": 3,
    "node_explored": 1,
    "flashcard_correct": 2,
    "quiz_correct": 4,
    "ai_refine": 2,
    "map_merged": 5,
}

BADGES = [
    # id, title, emoji, predicate(counters)
    ("first-steps", "First Steps", "🌱", lambda c: c.get("points", 0) >= 1),
    ("explorer", "Explorer", "🧭", lambda c: len(c.get("explored", [])) >= 25),
    ("scribe", "Scribe", "✍️", lambda c: c.get("note_added", 0) >= 10),
    ("architect", "Architect", "🏗️", lambda c: c.get("node_added", 0) + c.get("node_edited", 0) >= 20),
    ("curator", "Curator", "🔗", lambda c: c.get("link_added", 0) >= 5),
    ("quiz-whiz", "Quiz Whiz", "🏆", lambda c: c.get("quiz_correct", 0) >= 10),
    ("memory-master", "Memory Master", "🧠", lambda c: c.get("flashcard_correct", 0) >= 25),
    ("team-player", "Team Player", "🤝", lambda c: c.get("team", 0) >= 1),
]


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, map TEXT NOT NULL, version INTEGER NOT NULL, updated_at REAL NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS stats (room_id TEXT, user_id TEXT, name TEXT, counters TEXT, PRIMARY KEY (room_id, user_id))")
    return conn


@dataclass
class Client:
    ws: WebSocket
    user_id: str
    name: str
    color: str
    node_id: str | None = None


@dataclass
class Room:
    id: str
    map: dict
    version: int
    clients: list[Client] = field(default_factory=list)
    stats: dict[str, dict] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    # -- persistence -------------------------------------------------------------
    def save(self) -> None:
        with _db() as conn:
            conn.execute("INSERT OR REPLACE INTO rooms VALUES (?, ?, ?, ?)", (self.id, json.dumps(self.map), self.version, time.time()))

    def save_stats(self, user_id: str) -> None:
        s = self.stats[user_id]
        with _db() as conn:
            conn.execute("INSERT OR REPLACE INTO stats VALUES (?, ?, ?, ?)", (self.id, user_id, s.get("name", ""), json.dumps(s)))

    # -- gamification ------------------------------------------------------------
    def record(self, user_id: str, name: str, event: str, detail: str | None = None) -> list[dict]:
        s = self.stats.setdefault(user_id, {"name": name, "points": 0, "badges": [], "explored": []})
        s["name"] = name
        if event == "node_explored":
            if not detail or detail in s["explored"]:
                return []
            s["explored"].append(detail)
        if event in POINTS:
            s[event] = s.get(event, 0) + 1
            s["points"] = s.get("points", 0) + POINTS[event]
        elif event == "team":
            s["team"] = 1
        awarded = []
        for badge_id, title, emoji, pred in BADGES:
            if badge_id not in s["badges"] and pred(s):
                s["badges"].append(badge_id)
                awarded.append({"id": badge_id, "title": title, "emoji": emoji, "userId": user_id, "name": name})
        self.save_stats(user_id)
        return awarded

    def leaderboard(self) -> dict:
        sections = [c["id"] for c in self.map["root"].get("children", [])]
        explored_all = {nid for s in self.stats.values() for nid in s.get("explored", [])}
        group_quiz = sum(s.get("quiz_correct", 0) for s in self.stats.values())
        total_nodes = sum(1 for _ in walk(self.map["root"]))
        entries = sorted(
            ({"userId": uid, "name": s.get("name", "?"), "points": s.get("points", 0), "badges": s.get("badges", []), "explored": len(s.get("explored", []))} for uid, s in self.stats.items()),
            key=lambda e: -e["points"],
        )
        return {
            "entries": entries,
            "badgeCatalog": [{"id": b[0], "title": b[1], "emoji": b[2]} for b in BADGES],
            "challenges": [
                {"id": "explore-sections", "title": "Explore every section together", "progress": sum(1 for s in sections if s in explored_all), "goal": len(sections)},
                {"id": "explore-map", "title": "Visit 75% of all nodes as a group", "progress": len(explored_all), "goal": max(1, int(total_nodes * 0.75))},
                {"id": "group-quiz", "title": "Answer 20 quiz questions correctly as a team", "progress": min(group_quiz, 20), "goal": 20},
            ],
        }

    def presence(self) -> list[dict]:
        seen, users = set(), []
        for c in self.clients:
            if c.user_id not in seen:
                seen.add(c.user_id)
                users.append({"id": c.user_id, "name": c.name, "color": c.color, "nodeId": c.node_id})
        return users

    async def broadcast(self, message: dict, exclude: Client | None = None) -> None:
        data = json.dumps(message)
        dead = []
        for c in self.clients:
            if c is exclude:
                continue
            try:
                await c.ws.send_text(data)
            except Exception:  # noqa: BLE001
                dead.append(c)
        for c in dead:
            if c in self.clients:
                self.clients.remove(c)


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    # -- REST helpers (cloud sync) -------------------------------------------------
    def create(self, mindmap: dict) -> Room:
        room_id = secrets.token_urlsafe(6).replace("-", "a").replace("_", "b")
        room = Room(room_id, mindmap, int(mindmap.get("version", 1)))
        room.map.setdefault("meta", {})["roomId"] = room_id
        self.rooms[room_id] = room
        room.save()
        return room

    def get(self, room_id: str) -> Room | None:
        if room_id in self.rooms:
            return self.rooms[room_id]
        with _db() as conn:
            row = conn.execute("SELECT map, version FROM rooms WHERE id = ?", (room_id,)).fetchone()
            stats_rows = conn.execute("SELECT user_id, counters FROM stats WHERE room_id = ?", (room_id,)).fetchall()
        if not row:
            return None
        room = Room(room_id, json.loads(row[0]), int(row[1]))
        room.stats = {uid: json.loads(counters) for uid, counters in stats_rows}
        self.rooms[room_id] = room
        return room

    async def replace(self, room: Room, mindmap: dict, base_version: int | None) -> dict:
        async with room.lock:
            if base_version is not None and base_version != room.version:
                return {"ok": False, "conflict": True, "version": room.version, "map": room.map}
            room.version += 1
            mindmap["version"] = room.version
            room.map = mindmap
            room.save()
        await room.broadcast({"type": "snapshot", "map": room.map, "version": room.version, "users": room.presence()})
        return {"ok": True, "version": room.version}

    async def merge_into(self, room: Room, incoming: dict, user_id: str = "rest", name: str = "Someone") -> dict:
        async with room.lock:
            room.map = merge_maps([room.map, incoming])
            room.version += 1
            room.map["version"] = room.version
            room.map.setdefault("meta", {})["roomId"] = room.id
            room.save()
            room.record(user_id, name, "map_merged")
        await room.broadcast({"type": "snapshot", "map": room.map, "version": room.version, "users": room.presence()})
        await room.broadcast({"type": "leaderboard", **room.leaderboard()})
        return {"ok": True, "version": room.version}

    # -- WebSocket session -------------------------------------------------------------
    async def session(self, ws: WebSocket, room_id: str) -> None:
        await ws.accept()
        room = self.get(room_id)
        if room is None:
            await ws.send_text(json.dumps({"type": "error", "message": f"Room {room_id} not found"}))
            await ws.close()
            return

        client: Client | None = None
        try:
            while True:
                msg = json.loads(await ws.receive_text())
                kind = msg.get("type")

                if kind == "hello":
                    user = msg.get("user") or {}
                    client = Client(ws, str(user.get("id") or secrets.token_hex(4)), str(user.get("name") or "Guest")[:40], str(user.get("color") or "#8a8aad"))
                    room.clients.append(client)
                    await ws.send_text(json.dumps({"type": "snapshot", "map": room.map, "version": room.version, "users": room.presence()}))
                    if len(room.presence()) >= 2:
                        for c in room.clients:
                            for badge in room.record(c.user_id, c.name, "team"):
                                await room.broadcast({"type": "badge", **badge})
                    await room.broadcast({"type": "presence", "users": room.presence()})
                    await ws.send_text(json.dumps({"type": "leaderboard", **room.leaderboard()}))
                    continue

                if client is None:
                    await ws.send_text(json.dumps({"type": "error", "message": "send hello first"}))
                    continue

                if kind == "op":
                    applied = []
                    async with room.lock:
                        for op in msg.get("ops") or []:
                            if apply_op(room.map, op):
                                applied.append(op)
                        if applied:
                            room.version += 1
                            room.map["version"] = room.version
                            room.save()
                    badges = []
                    for op in applied:
                        badges += room.record(client.user_id, client.name, _event_for(op))
                    await room.broadcast({"type": "op", "ops": applied, "version": room.version, "userId": client.user_id, "clientOpId": msg.get("clientOpId")})
                    for badge in badges:
                        await room.broadcast({"type": "badge", **badge})
                    if applied:
                        await room.broadcast({"type": "leaderboard", **room.leaderboard()})

                elif kind == "presence":
                    client.node_id = msg.get("nodeId")
                    await room.broadcast({"type": "presence", "users": room.presence()}, exclude=client)

                elif kind == "event":
                    badges = room.record(client.user_id, client.name, str(msg.get("event")), msg.get("detail"))
                    for badge in badges:
                        await room.broadcast({"type": "badge", **badge})
                    await room.broadcast({"type": "leaderboard", **room.leaderboard()})

                elif kind == "sync":
                    await ws.send_text(json.dumps({"type": "snapshot", "map": room.map, "version": room.version, "users": room.presence()}))

                elif kind == "merge" and isinstance(msg.get("map"), dict):
                    await self.merge_into(room, msg["map"], client.user_id, client.name)

        except Exception as exc:  # noqa: BLE001 - disconnects surface as various exceptions
            log.debug("websocket closed: %s", exc)
        finally:
            if client and client in room.clients:
                room.clients.remove(client)
                await room.broadcast({"type": "presence", "users": room.presence()})


def _event_for(op: dict) -> str:
    if op.get("type") == "add":
        return "node_added"
    patch = op.get("patch") or {}
    if "notes" in patch:
        return "note_added"
    if "links" in patch:
        return "link_added"
    return "node_edited"


manager = RoomManager()

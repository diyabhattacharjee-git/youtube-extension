"""
Merging mindmaps and Cross-Video Knowledge Linking.

* `merge_maps`   — merge several users' versions (or several videos) into one tree.
                   Children that mean the same thing (semantic similarity) are unified;
                   notes and links are combined; provenance is kept in `sources`.
* `link_videos`  — find overlapping concepts across maps of different videos and
                   build a "Knowledge Hub" map whose leaves jump to each video moment.
"""
from __future__ import annotations

import copy
import time
import uuid

import numpy as np

from ..pipeline.builder import SCHEMA, make_node
from ..pipeline.embeddings import Embedder, cosine_matrix
from ..pipeline.text_utils import truncate
from .treeutil import plain, walk


def merge_maps(maps: list[dict], threshold: float = 0.78) -> dict:
    if not maps:
        raise ValueError("no maps to merge")
    if len(maps) == 1:
        return copy.deepcopy(maps[0])

    all_texts = [plain(n.get("text", "")) for m in maps for n, _, _ in walk(m["root"])]
    encoder = Embedder(all_texts)

    base = copy.deepcopy(maps[0])
    _tag_sources(base["root"], base)
    for other in maps[1:]:
        o = copy.deepcopy(other)
        _tag_sources(o["root"], o)
        _merge_node(base["root"], o["root"], encoder, threshold)
        known = {e.get("id") for e in base.get("edges", [])}
        base.setdefault("edges", []).extend(e for e in o.get("edges", []) if e.get("id") not in known)

    titles = list(dict.fromkeys(m["meta"].get("title", "") for m in maps))
    base["id"] = uuid.uuid4().hex[:16]
    base["version"] = max(int(m.get("version", 1)) for m in maps) + 1
    base["meta"] = {**base["meta"], "mergedFrom": [m.get("id") for m in maps], "mergedAt": int(time.time() * 1000)}
    if len(titles) > 1:
        base["meta"]["title"] = " + ".join(t for t in titles if t)[:140]
    return base


def _tag_sources(root: dict, mindmap: dict) -> None:
    for node, _, _ in walk(root):
        node.setdefault("sources", [{"mapId": mindmap.get("id"), "videoId": mindmap.get("meta", {}).get("videoId"), "start": node.get("start")}])


def _merge_node(target: dict, incoming: dict, encoder: Embedder, threshold: float) -> None:
    # combine user content
    if incoming.get("notes") and incoming["notes"] not in (target.get("notes") or ""):
        target["notes"] = "\n\n".join(filter(None, [target.get("notes", ""), incoming["notes"]]))
    known_links = {l.get("url") for l in target.get("links", [])}
    target.setdefault("links", []).extend(l for l in incoming.get("links", []) if l.get("url") not in known_links)
    if not target.get("image") and incoming.get("image"):
        target["image"] = incoming["image"]
    target["sources"] = target.get("sources", []) + [s for s in incoming.get("sources", []) if s not in target.get("sources", [])]
    target["tone"] = list(dict.fromkeys((target.get("tone") or []) + (incoming.get("tone") or [])))[:3]

    t_children = target.setdefault("children", [])
    i_children = incoming.get("children", []) or []
    if not i_children:
        return
    if not t_children:
        t_children.extend(i_children)
        return

    ids = {c["id"] for c in t_children}
    t_vecs = encoder.encode([plain(c["text"]) for c in t_children])
    i_vecs = encoder.encode([plain(c["text"]) for c in i_children])
    sims = cosine_matrix(i_vecs, t_vecs)
    used: set[int] = set()
    for i, child in enumerate(i_children):
        if child["id"] in ids:  # same node edited by two users -> merge in place
            match = next(c for c in t_children if c["id"] == child["id"])
            _merge_node(match, child, encoder, threshold)
            continue
        order = np.argsort(-sims[i])
        j = next((int(j) for j in order if int(j) not in used and sims[i, int(j)] >= threshold and t_children[int(j)].get("type") == child.get("type")), None)
        if j is None:
            t_children.append(child)
        else:
            used.add(j)
            _merge_node(t_children[j], child, encoder, threshold)


def link_videos(maps: list[dict], threshold: float = 0.72, max_links: int = 60) -> dict:
    """Return cross-video links and a Knowledge Hub mindmap."""
    items = []
    for m in maps:
        vid = m.get("meta", {}).get("videoId")
        for node, parent, _ in walk(m["root"]):
            if node.get("type") in ("section", "concept"):
                items.append({"mapId": m.get("id"), "videoId": vid, "videoTitle": m["meta"].get("title", ""), "nodeId": node["id"], "text": plain(node["text"]), "summary": node.get("summary", ""), "start": node.get("start"), "type": node["type"]})
    if len(maps) < 2 or not items:
        return {"links": [], "hub": None}

    encoder = Embedder([i["text"] + " " + i["summary"] for i in items])
    vecs = encoder.encode([i["text"] for i in items])
    sims = cosine_matrix(vecs)

    links = []
    for a in range(len(items)):
        for b in range(a + 1, len(items)):
            if items[a]["mapId"] != items[b]["mapId"] and sims[a, b] >= threshold:
                links.append({"a": items[a], "b": items[b], "score": round(float(sims[a, b]), 3)})
    links.sort(key=lambda l: -l["score"])
    links = links[:max_links]

    # cluster linked items into shared concepts (union-find)
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    key = lambda it: (it["mapId"], it["nodeId"])
    for l in links:
        parent[find(key(l["a"]))] = find(key(l["b"]))
    clusters: dict = {}
    lookup = {key(i): i for i in items}
    for l in links:
        for side in ("a", "b"):
            k = key(l[side])
            clusters.setdefault(find(k), {})[k] = lookup[k]

    hub_root = make_node("Knowledge Hub", "root", 0, None, None, summary=f"Concepts shared across {len(maps)} videos")
    for ci, members in enumerate(sorted(clusters.values(), key=lambda c: -len(c))):
        members = list(members.values())
        head = min(members, key=lambda m: len(m["text"]))
        shared = make_node(truncate(head["text"], 80), "section", 1, None, None, color=ci % 5, summary=f"Appears in {len({m['videoId'] for m in members})} videos")
        for m in members:
            leaf = make_node(truncate(m["text"], 100), "concept", 2, m["start"], None, summary=m["videoTitle"], videoId=m["videoId"], sourceNodeId=m["nodeId"], sourceMapId=m["mapId"])
            shared["children"].append(leaf)
        hub_root["children"].append(shared)

    hub = {
        "schema": SCHEMA,
        "id": uuid.uuid4().hex[:16],
        "version": 1,
        "meta": {"title": "Knowledge Hub", "videoId": None, "kind": "hub", "sources": [{"mapId": m.get("id"), "videoId": m["meta"].get("videoId"), "title": m["meta"].get("title")} for m in maps], "createdAt": int(time.time() * 1000), "mode": "hub", "profile": "balanced"},
        "root": hub_root,
        "edges": [],
    }
    return {"links": links, "hub": hub}

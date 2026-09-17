"""Semantic search over mindmap nodes (embeddings + a lexical boost for exact words)."""
from __future__ import annotations

import re

import numpy as np

from ..pipeline.embeddings import Embedder, cosine_matrix
from .treeutil import plain, walk


def semantic_search(mindmap: dict, query: str, limit: int = 12, include_transcript: bool = True) -> list[dict]:
    query = (query or "").strip()
    if not query:
        return []
    items = []
    for node, _parent, depth in walk(mindmap["root"]):
        if node.get("type") == "transcript" and not include_transcript:
            continue
        text = " ".join(filter(None, [plain(node.get("text", "")), node.get("summary", ""), node.get("notes", ""), " ".join(node.get("keywords", []))]))
        items.append((node, text))
    if not items:
        return []

    texts = [t for _, t in items]
    encoder = Embedder(texts + [query])
    sims = cosine_matrix(encoder.encode([query]), encoder.encode(texts))[0]

    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2]
    results = []
    for (node, text), sim in zip(items, sims):
        low = text.lower()
        lexical = sum(1 for w in words if w in low) / max(len(words), 1)
        score = float(sim) * 0.75 + lexical * 0.35 + (0.05 if node.get("type") in ("section", "concept") else 0)
        results.append({"id": node["id"], "text": node.get("text", ""), "type": node.get("type"), "start": node.get("start"), "score": round(score, 4)})
    results.sort(key=lambda r: -r["score"])
    cutoff = max(0.15, results[0]["score"] * 0.45) if results else 0
    return [r for r in results[:limit] if r["score"] >= cutoff]


def node_vectors(texts: list[str]) -> np.ndarray:
    return Embedder(texts).encode(texts)

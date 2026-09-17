"""
AI-powered refinement: expand, rewrite, summarize, reorganize and merge nodes.

Every action returns a list of *operations* in exactly the format the extension's
tree model (and the collaboration server) understands, so AI edits are undoable
and sync to collaborators like any human edit:

    {"type": "add",    "parentId": ..., "index": ..., "node": {...}}
    {"type": "update", "id": ..., "patch": {...}}
    {"type": "remove", "id": ...}
    {"type": "move",   "id": ..., "parentId": ..., "index": ...}
"""
from __future__ import annotations

import numpy as np

from ..pipeline import llm
from ..pipeline.builder import make_node, new_id
from ..pipeline.embeddings import embed
from ..pipeline.text_utils import fmt_time, smart_title, truncate
from .treeutil import find, node_path, outline, plain

CHILD_LAYER = {"root": ("section", 1), "section": ("concept", 2), "concept": ("detail", 3), "detail": ("detail", 3)}

SYSTEM = """You are a meticulous mind-map editor. You improve mind-map nodes built from a video transcript.
Labels must be valid, meaningful and self-contained (e.g. "Qubits: fundamental unit of quantum computing"),
never meta-commentary. Only use facts supported by the provided transcript context."""


def refine(mindmap: dict, action: str, node_ids: list[str], instruction: str = "") -> dict:
    root = mindmap["root"]
    handlers = {
        "expand": _expand,
        "rewrite": _rewrite,
        "summarize": _summarize,
        "reorganize": _reorganize,
        "merge": _merge,
    }
    if action not in handlers:
        raise ValueError(f"unknown action {action!r}")
    nodes = [find(root, nid)[0] for nid in node_ids]
    if not nodes or any(n is None for n in nodes):
        raise ValueError("node not found")
    ops = handlers[action](mindmap, nodes, instruction)
    return {"ops": ops, "provider": llm.provider_name()}


# ---------------------------------------------------------------------------
def _context(mindmap: dict, node: dict, pad: float = 20.0, limit: int = 5000) -> str:
    entries = mindmap.get("transcript") or []
    start, end = node.get("start"), node.get("end")
    if start is None:
        return ""
    if end is None:
        end = start + 90
    lines = [f"[{fmt_time(e['start'])}] {e['text']}" for e in entries if start - pad <= e["start"] <= end + pad]
    return truncate("\n".join(lines), limit)


def _child_kind(node: dict) -> tuple[str, int]:
    return CHILD_LAYER.get(node.get("type", "detail"), ("detail", 3))


def _expand(mindmap: dict, nodes: list[dict], instruction: str) -> list[dict]:
    node = nodes[0]
    kind, layer = _child_kind(node)
    path = " > ".join(plain(n["text"]) for n in node_path(mindmap["root"], node["id"]))
    existing = [plain(c["text"]) for c in node.get("children", [])]
    ctx = _context(mindmap, node, pad=30, limit=6000)
    data = llm.chat_json(
        SYSTEM,
        f"Node path: {path}\nExisting children: {existing}\nUser instruction: {instruction or 'add the most useful missing sub-points'}\n"
        f"Transcript context:\n{ctx}\n\n"
        'Return {"children": [{"label": "...", "start": seconds_or_null, "detail": "optional one sentence"}]} with 3-5 NEW children.',
        max_tokens=900,
    )
    ops = []
    base_index = len(node.get("children", []))
    if isinstance(data, dict) and isinstance(data.get("children"), list):
        for i, child in enumerate(data["children"][:6]):
            if not isinstance(child, dict) or not child.get("label"):
                continue
            start = child.get("start") if isinstance(child.get("start"), (int, float)) else node.get("start")
            new = make_node(truncate(str(child["label"]), 120), kind, layer, start, None, summary=truncate(str(child.get("detail") or ""), 300))
            ops.append({"type": "add", "parentId": node["id"], "index": base_index + i, "node": new})
        return ops

    # Offline fallback: pull transcript sentences around the node as children.
    entries = [e for e in (mindmap.get("transcript") or []) if node.get("start") is not None and node["start"] <= e["start"] <= (node.get("end") or node["start"] + 90)]
    for i, e in enumerate([e for e in entries if len(e["text"]) > 30][:4]):
        new = make_node(f"“{truncate(e['text'], 140)}”", "transcript", 4, e["start"], e.get("end"))
        ops.append({"type": "add", "parentId": node["id"], "index": base_index + i, "node": new})
    return ops


def _rewrite(mindmap: dict, nodes: list[dict], instruction: str) -> list[dict]:
    ops = []
    for node in nodes:
        data = llm.chat_json(
            SYSTEM,
            f"Current label: {node['text']}\nSummary: {node.get('summary', '')}\nInstruction: {instruction or 'make it clearer and more precise'}\n"
            f"Transcript context:\n{_context(mindmap, node, limit=2500)}\n\n"
            'Return {"label": "...", "summary": "one sentence"}',
            max_tokens=300,
        )
        if isinstance(data, dict) and data.get("label"):
            ops.append({"type": "update", "id": node["id"], "patch": {"text": truncate(str(data["label"]), 120), "summary": truncate(str(data.get("summary") or node.get("summary", "")), 320)}})
        else:
            ops.append({"type": "update", "id": node["id"], "patch": {"text": smart_title(plain(node["text"]))}})
    return ops


def _summarize(mindmap: dict, nodes: list[dict], instruction: str) -> list[dict]:
    ops = []
    for node in nodes:
        sub = "\n".join(outline(node, max_depth=3))
        data = llm.chat_json(
            SYSTEM,
            f"Subtree:\n{sub}\nTranscript context:\n{_context(mindmap, node, limit=3000)}\n\n"
            'Return {"summary": "2-3 sentence summary for revision"}',
            max_tokens=300,
        )
        if isinstance(data, dict) and data.get("summary"):
            summary = str(data["summary"])
        else:
            summary = "; ".join(plain(c["text"]) for c in node.get("children", [])[:5])
        ops.append({"type": "update", "id": node["id"], "patch": {"summary": truncate(summary, 500)}})
    return ops


def _reorganize(mindmap: dict, nodes: list[dict], instruction: str) -> list[dict]:
    """Group a node's children under new intermediate headings."""
    node = nodes[0]
    children = [c for c in node.get("children", []) if c.get("type") != "transcript"]
    if len(children) < 4:
        return []
    kind, layer = _child_kind(node)
    listing = [{"id": c["id"], "label": plain(c["text"])} for c in children]
    data = llm.chat_json(
        SYSTEM,
        f"Parent: {node['text']}\nChildren: {llm.compact(listing)}\nInstruction: {instruction or 'group into 2-4 coherent clusters'}\n\n"
        'Return {"groups": [{"label": "group heading", "ids": ["child ids"]}]}. Every child id must appear exactly once.',
        max_tokens=700,
    )
    groups: list[tuple[str, list[str]]] = []
    valid_ids = {c["id"] for c in children}
    if isinstance(data, dict) and isinstance(data.get("groups"), list):
        for g in data["groups"]:
            ids = [i for i in (g.get("ids") or []) if i in valid_ids]
            if ids and g.get("label"):
                groups.append((truncate(str(g["label"]), 60), ids))
                valid_ids -= set(ids)
        if valid_ids and groups:
            groups[-1][1].extend(valid_ids)
    if len(groups) < 2:
        groups = _cluster_groups(children)

    ops = []
    for gi, (label, ids) in enumerate(groups):
        members = [c for c in children if c["id"] in ids]
        starts = [m["start"] for m in members if m.get("start") is not None]
        group = make_node(label, kind, layer, min(starts) if starts else node.get("start"), None)
        ops.append({"type": "add", "parentId": node["id"], "index": gi, "node": group})
        for mi, m in enumerate(members):
            ops.append({"type": "move", "id": m["id"], "parentId": group["id"], "index": mi})
    return ops


def _cluster_groups(children: list[dict]) -> list[tuple[str, list[str]]]:
    from sklearn.cluster import KMeans

    texts = [plain(c["text"]) + " " + c.get("summary", "") for c in children]
    k = max(2, min(4, len(children) // 2))
    vecs = embed(texts, corpus=texts)
    labels = KMeans(n_clusters=k, n_init=10, random_state=42).fit_predict(vecs)
    groups = []
    for g in range(k):
        members = [children[i] for i in np.nonzero(labels == g)[0]]
        if not members:
            continue
        head = plain(members[0]["text"]).split(":")[0]
        groups.append((smart_title(truncate(head, 40)), [m["id"] for m in members]))
    return groups


def _merge(mindmap: dict, nodes: list[dict], instruction: str) -> list[dict]:
    if len(nodes) < 2:
        return []
    keep, rest = nodes[0], nodes[1:]
    labels = [plain(n["text"]) for n in nodes]
    data = llm.chat_json(
        SYSTEM,
        f"Merge these mind-map nodes into one: {labels}\nSummaries: {[n.get('summary', '') for n in nodes]}\n\n"
        'Return {"label": "merged label", "summary": "one sentence"}',
        max_tokens=250,
    )
    if isinstance(data, dict) and data.get("label"):
        label, summary = str(data["label"]), str(data.get("summary") or "")
    else:
        label, summary = " / ".join(labels[:3]), " ".join(n.get("summary", "") for n in nodes).strip()
    starts = [n["start"] for n in nodes if n.get("start") is not None]
    notes = "\n".join(n.get("notes", "") for n in nodes if n.get("notes"))
    links = [l for n in nodes for l in n.get("links", [])]
    ops = [{"type": "update", "id": keep["id"], "patch": {"text": truncate(label, 120), "summary": truncate(summary, 400), "start": min(starts) if starts else keep.get("start"), "notes": notes, "links": links}}]
    index = len(keep.get("children", []))
    for n in rest:
        for c in list(n.get("children", [])):
            ops.append({"type": "move", "id": c["id"], "parentId": keep["id"], "index": index})
            index += 1
        ops.append({"type": "remove", "id": n["id"]})
    return ops


__all__ = ["refine", "new_id"]

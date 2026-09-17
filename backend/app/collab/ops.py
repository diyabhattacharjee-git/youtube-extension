"""
Tree operations shared by collaboration and AI refinement.
Mirrors `extension/viewer/js/mindmap/model.js` — keep both in sync.
"""
from __future__ import annotations

from ..features.treeutil import find, walk

PROTECTED = {"id", "children"}


def _is_descendant(node: dict, candidate_id: str) -> bool:
    return any(n["id"] == candidate_id for n, _, _ in walk(node))


def apply_op(mindmap: dict, op: dict) -> bool:
    """Apply one op in place. Returns False when the op no longer applies (e.g. node deleted)."""
    root = mindmap["root"]
    kind = op.get("type")

    if kind == "add":
        parent, _ = find(root, op.get("parentId", ""))
        node = op.get("node")
        if parent is None or not isinstance(node, dict) or find(root, node.get("id", ""))[0] is not None:
            return False
        node.setdefault("children", [])
        children = parent.setdefault("children", [])
        index = op.get("index", len(children))
        children.insert(max(0, min(int(index if index is not None else len(children)), len(children))), node)
        return True

    if kind == "update":
        node, _ = find(root, op.get("id", ""))
        if node is None:
            return False
        for key, value in (op.get("patch") or {}).items():
            if key not in PROTECTED:
                node[key] = value
        return True

    if kind == "remove":
        node, parent = find(root, op.get("id", ""))
        if node is None or parent is None:
            return False
        parent["children"] = [c for c in parent["children"] if c["id"] != node["id"]]
        mindmap["edges"] = [e for e in mindmap.get("edges", []) if not _edge_touches_subtree(e, node)]
        return True

    if kind == "move":
        node, old_parent = find(root, op.get("id", ""))
        new_parent, _ = find(root, op.get("parentId", ""))
        if node is None or old_parent is None or new_parent is None or _is_descendant(node, new_parent["id"]):
            return False
        old_parent["children"] = [c for c in old_parent["children"] if c["id"] != node["id"]]
        children = new_parent.setdefault("children", [])
        index = op.get("index", len(children))
        children.insert(max(0, min(int(index if index is not None else len(children)), len(children))), node)
        return True

    if kind == "edge:add":
        edge = op.get("edge") or {}
        if edge.get("id") and all(e.get("id") != edge["id"] for e in mindmap.setdefault("edges", [])):
            mindmap["edges"].append(edge)
            return True
        return False

    if kind == "edge:remove":
        before = len(mindmap.get("edges", []))
        mindmap["edges"] = [e for e in mindmap.get("edges", []) if e.get("id") != op.get("id")]
        return len(mindmap["edges"]) != before

    return False


def _edge_touches_subtree(edge: dict, node: dict) -> bool:
    ids = {n["id"] for n, _, _ in walk(node)}
    return edge.get("source") in ids or edge.get("target") in ids

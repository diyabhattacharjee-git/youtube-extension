"""Helpers for walking / editing mindmap trees (same shape as the extension's model)."""
from __future__ import annotations

from typing import Iterator


def walk(node: dict, parent: dict | None = None, depth: int = 0) -> Iterator[tuple[dict, dict | None, int]]:
    yield node, parent, depth
    for child in node.get("children", []) or []:
        yield from walk(child, node, depth + 1)


def find(root: dict, node_id: str) -> tuple[dict | None, dict | None]:
    for node, parent, _ in walk(root):
        if node.get("id") == node_id:
            return node, parent
    return None, None


def node_path(root: dict, node_id: str) -> list[dict]:
    def rec(n: dict, trail: list[dict]) -> list[dict] | None:
        trail = trail + [n]
        if n.get("id") == node_id:
            return trail
        for c in n.get("children", []) or []:
            got = rec(c, trail)
            if got:
                return got
        return None

    return rec(root, []) or []


def outline(node: dict, max_depth: int = 3, depth: int = 0) -> list[str]:
    lines = [f"{'  ' * depth}- [{node.get('id')}] {node.get('text', '')}"]
    if depth < max_depth:
        for c in node.get("children", []) or []:
            if c.get("type") != "transcript":
                lines.extend(outline(c, max_depth, depth + 1))
    return lines


def plain(text: str) -> str:
    return (text or "").strip("“”\" ")

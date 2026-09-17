"""
Knowledge export to Notion via the official API (optional).

Needs NOTION_TOKEN (an internal integration secret) and NOTION_PARENT_PAGE_ID
(a page shared with that integration) in `.env`. Obsidian, Roam and Markdown
exports are produced client-side and need no server.
"""
from __future__ import annotations

import httpx

from ..config import settings
from ..pipeline.text_utils import fmt_time, truncate
from .treeutil import plain

API = "https://api.notion.com/v1"
HEADERS_VERSION = "2022-06-28"


def _rich(text: str, url: str | None = None) -> list[dict]:
    item: dict = {"type": "text", "text": {"content": truncate(text, 1900)}}
    if url:
        item["text"]["link"] = {"url": url}
    return [item]


def _flatten(node: dict, video_url: str | None, depth: int = 0) -> list[dict]:
    """Notion nests only 2 levels per request, so deeper levels are indented with arrows."""
    blocks = []
    for child in node.get("children", []):
        label = ("↳ " * max(0, depth - 1)) + plain(child.get("text", ""))
        rich = _rich(label)
        if child.get("start") is not None and video_url:
            rich += _rich(f"  ▶ {fmt_time(child['start'])}", f"{video_url}&t={int(child['start'])}s")
        if child.get("notes"):
            rich += _rich(f"  — {child['notes']}")
        block = {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": rich}}
        sub = _flatten(child, video_url, depth + 1)
        if depth == 0 and sub:
            block["bulleted_list_item"]["children"] = sub[:100]
            blocks.append(block)
        else:
            blocks.append(block)
            blocks.extend(sub)
    return blocks


def push_to_notion(mindmap: dict) -> dict:
    if not (settings.notion_token and settings.notion_parent_page_id):
        raise RuntimeError("Set NOTION_TOKEN and NOTION_PARENT_PAGE_ID in .env to enable Notion export")
    meta = mindmap.get("meta", {})
    url = meta.get("url")
    headers = {"Authorization": f"Bearer {settings.notion_token}", "Notion-Version": HEADERS_VERSION}
    blocks = []
    if mindmap["root"].get("summary"):
        blocks.append({"object": "block", "type": "callout", "callout": {"rich_text": _rich(mindmap["root"]["summary"]), "icon": {"emoji": "🧠"}}})
    if url:
        blocks.append({"object": "block", "type": "bookmark", "bookmark": {"url": url}})
    for section in mindmap["root"].get("children", []):
        blocks.append({"object": "block", "type": "heading_2", "heading_2": {"rich_text": _rich(plain(section["text"]))}})
        blocks.extend(_flatten(section, url))

    with httpx.Client(timeout=60, headers=headers) as client:
        page = client.post(f"{API}/pages", json={
            "parent": {"page_id": settings.notion_parent_page_id},
            "properties": {"title": {"title": _rich(meta.get("title") or plain(mindmap["root"]["text"]))}},
            "children": blocks[:100],
        })
        page.raise_for_status()
        page_id = page.json()["id"]
        for i in range(100, len(blocks), 100):
            client.patch(f"{API}/blocks/{page_id}/children", json={"children": blocks[i : i + 100]}).raise_for_status()
    return {"pageId": page_id, "url": page.json().get("url")}

"""
Node chatbot: answer questions about one mind-map node, grounded in the transcript.

Retrieval, not the full transcript: the prompt carries only the node's path, its
summary and the 5–8 transcript sentences most similar to the question (≈1,500
tokens max). One LLM call per user message, streamed. Without an LLM (or when the
call fails) the answer is the best-matching transcript sentences themselves.

The stream is NDJSON, one event per line:
    {"type": "sources", "sources": [{"start", "end", "text"}], "mode": "llm" | "offline"}
    {"type": "delta", "text": "..."}          (repeated)
    {"type": "done", "usage": {...}}
"""
from __future__ import annotations

import json
import logging
import threading
from collections import OrderedDict
from typing import Iterator

import numpy as np

from ..config import settings
from ..pipeline import llm
from ..pipeline.embeddings import Embedder, cosine_matrix
from ..pipeline.text_utils import fmt_time, truncate
from ..pipeline.transcript import TranscriptEntry, sentences_with_time
from .treeutil import find, node_path, plain

log = logging.getLogger("tubemind.chat")

TOKEN_BUDGET = 1500
MAX_SENTENCES = 8
MIN_SENTENCES = 5
HISTORY_TURNS = 4

SYSTEM = """You are a friendly study assistant inside a mind map of a video.
Answer the question about the selected node using the transcript excerpts.
- Be concise: 2-5 short sentences, or a short list.
- Cite the moments you use as [m:ss], copied exactly from the excerpts.
- If the excerpts do not cover the question, say so in one short sentence, then give a brief general answer marked "(general knowledge)".
- Plain text only, no markdown headings."""


class _Index:
    def __init__(self, sents: list[TranscriptEntry]):
        self.sents = sents
        self.encoder = Embedder([s.text for s in sents] or ["empty"])
        self.vecs = self.encoder.encode([s.text for s in sents]) if sents else np.zeros((0, 1))
        self.starts = np.array([s.start for s in sents]) if sents else np.zeros(0)


_indexes: OrderedDict[str, _Index] = OrderedDict()
_lock = threading.Lock()


def _index_for(mindmap: dict) -> _Index:
    entries = mindmap.get("transcript") or []
    key = f"{mindmap.get('id')}:{len(entries)}:{entries[-1]['start'] if entries else 0}"
    with _lock:
        if key in _indexes:
            _indexes.move_to_end(key)
            return _indexes[key]
    raw = [TranscriptEntry(float(e["start"]), float(e.get("end") or e["start"] + 2), str(e["text"])) for e in entries if e.get("text")]
    index = _Index(sentences_with_time(raw))
    with _lock:
        _indexes[key] = index
        while len(_indexes) > 8:
            _indexes.popitem(last=False)
    return index


def retrieve(mindmap: dict, node_id: str, question: str) -> dict:
    node, _ = find(mindmap["root"], node_id)
    if node is None:
        raise ValueError("node not found")
    path = [plain(n.get("text", "")) for n in node_path(mindmap["root"], node_id)]
    index = _index_for(mindmap)
    picks: list[TranscriptEntry] = []
    if index.sents:
        query = f"{question} {plain(node.get('text', ''))} {node.get('summary', '')}"
        sims = cosine_matrix(index.encoder.encode([query]), index.vecs)[0]
        # prefer the node's own moment in the video, then its section
        start = node.get("start")
        if start is not None:
            end = node.get("end") or start + 60
            sims = sims + 0.15 * ((index.starts >= start - 30) & (index.starts <= end + 30))
        words = {w for w in question.lower().split() if len(w) > 3}
        lexical = np.array([sum(w in s.text.lower() for w in words) / max(len(words), 1) for s in index.sents])
        order = np.argsort(-(sims + 0.2 * lexical))
        used = 0
        for i in order[: MAX_SENTENCES * 2]:
            s = index.sents[int(i)]
            if len(s.text) < 20 and len(picks) >= MIN_SENTENCES:
                continue
            cost = llm.estimate_tokens(s.text) + 4
            if used + cost > TOKEN_BUDGET - 250 and len(picks) >= MIN_SENTENCES:
                break
            picks.append(s)
            used += cost
            if len(picks) >= MAX_SENTENCES:
                break
        picks.sort(key=lambda s: s.start)
    return {"node": node, "path": path, "sentences": picks}


def _prompt(ctx: dict, question: str) -> str:
    node = ctx["node"]
    lines = [
        f"Selected node: {' > '.join(ctx['path'])}",
        f"Node summary: {truncate(node.get('summary') or '', 300) or '-'}",
        "Transcript excerpts:",
        *[f"[{fmt_time(s.start)}] {truncate(s.text, 400)}" for s in ctx["sentences"]],
        "",
        f"Question: {question}",
    ]
    return "\n".join(lines)


def _offline_answer(ctx: dict) -> str:
    if not ctx["sentences"]:
        return "I could not find this in the transcript."
    best = ctx["sentences"][:4]
    return "Here is what the video says about this:\n" + "\n".join(f"• [{fmt_time(s.start)}] {truncate(s.text, 220)}" for s in best)


def chat_stream(mindmap: dict, node_id: str, question: str, history: list[dict] | None = None) -> Iterator[str]:
    question = (question or "").strip()[:500]
    ctx = retrieve(mindmap, node_id, question)
    use_llm = llm.fast_available()
    sources = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": truncate(s.text, 300)} for s in ctx["sentences"]]
    yield _event({"type": "sources", "sources": sources, "mode": "llm" if use_llm else "offline"})

    if not use_llm:
        yield _event({"type": "delta", "text": _offline_answer(ctx)})
        yield _event({"type": "done", "usage": {"calls": 0}})
        return

    messages = [{"role": "system", "content": SYSTEM}]
    for turn in (history or [])[-HISTORY_TURNS * 2 :]:
        role = "assistant" if turn.get("role") == "assistant" else "user"
        messages.append({"role": role, "content": truncate(str(turn.get("text", "")), 600)})
    messages.append({"role": "user", "content": _prompt(ctx, question)})

    result = llm.Completion("")
    got_text = False
    for delta in llm.stream(messages, max_tokens=450, temperature=0.3, timeout=settings.chat_timeout, result=result):
        got_text = True
        yield _event({"type": "delta", "text": delta})
    if not got_text:  # LLM failed before answering: fall back to the transcript itself
        yield _event({"type": "delta", "text": _offline_answer(ctx)})
    log.info("chat node=%s llm_calls=1 prompt_tokens=%d completion_tokens=%d ms=%.0f error=%s", node_id, result.prompt_tokens, result.completion_tokens, result.ms, result.error)
    yield _event({"type": "done", "usage": {"calls": 1, "prompt_tokens": result.prompt_tokens, "completion_tokens": result.completion_tokens}, "fallback": not got_text})


def _event(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"

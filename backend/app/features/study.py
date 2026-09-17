"""
Personalized Study Mode: flashcards + multiple-choice quizzes generated from nodes.

Uses the LLM when available; otherwise derives cards from "Term: meaning"
labels and builds distractors from other concepts' meanings.
"""
from __future__ import annotations

import random
import uuid

from ..pipeline import llm
from ..pipeline.text_utils import truncate
from .treeutil import plain, walk

SYSTEM = """You create high-quality study material from a mind map of a video lecture.
Flashcards test one fact each. Quiz questions have exactly 4 plausible options, one correct.
Use only facts in the provided nodes."""


def _concepts(mindmap: dict) -> list[dict]:
    out = []
    for node, parent, _ in walk(mindmap["root"]):
        if node.get("type") in ("concept", "detail") and plain(node.get("text", "")):
            out.append({"id": node["id"], "text": plain(node["text"]), "summary": node.get("summary", ""), "start": node.get("start"), "section": plain(parent.get("text", "")) if parent else ""})
    return out


def generate_study_set(mindmap: dict, count: int = 12, focus_ids: list[str] | None = None) -> dict:
    concepts = _concepts(mindmap)
    if focus_ids:
        concepts = [c for c in concepts if c["id"] in set(focus_ids)] or concepts
    concepts = concepts[:60]
    if not concepts:
        return {"flashcards": [], "quiz": [], "provider": "none"}

    cards, quiz = [], []
    if llm.available():
        listing = [{"id": c["id"], "node": c["text"], "summary": truncate(c["summary"], 200), "section": c["section"]} for c in concepts]
        data = llm.chat_json(
            SYSTEM,
            f"Nodes: {llm.compact(listing)}\n\nCreate {count} flashcards and {max(4, count // 2)} quiz questions.\n"
            'Return {"flashcards": [{"nodeId": "...", "front": "question", "back": "answer"}], '
            '"quiz": [{"nodeId": "...", "question": "...", "options": ["a","b","c","d"], "answer": 0, "explanation": "..."}]}',
            max_tokens=2500,
            temperature=0.4,
        )
        if isinstance(data, dict):
            by_id = {c["id"]: c for c in concepts}
            for f in data.get("flashcards") or []:
                if isinstance(f, dict) and f.get("front") and f.get("back"):
                    node = by_id.get(f.get("nodeId"))
                    cards.append(_card(f["front"], f["back"], node))
            for q in data.get("quiz") or []:
                opts = q.get("options") if isinstance(q, dict) else None
                if isinstance(opts, list) and len(opts) >= 3 and isinstance(q.get("answer"), int) and 0 <= q["answer"] < len(opts):
                    node = by_id.get(q.get("nodeId"))
                    quiz.append({"id": uuid.uuid4().hex[:8], "question": q.get("question", ""), "options": [str(o) for o in opts[:4]], "answer": q["answer"], "explanation": q.get("explanation", ""), "nodeId": node and node["id"], "start": node and node["start"]})

    if not cards:
        cards = _fallback_cards(concepts, count)
    if not quiz:
        quiz = _fallback_quiz(concepts, max(4, count // 2))
    return {"flashcards": cards[:count], "quiz": quiz, "provider": llm.provider_name() if llm.available() else "heuristic"}


def _card(front: str, back: str, node: dict | None) -> dict:
    return {"id": uuid.uuid4().hex[:8], "front": str(front), "back": str(back), "nodeId": node and node["id"], "start": node and node["start"]}


def _split(c: dict) -> tuple[str, str]:
    if ":" in c["text"]:
        term, meaning = c["text"].split(":", 1)
        return term.strip(), meaning.strip()
    return c["text"], c["summary"] or c["section"]


def _fallback_cards(concepts: list[dict], count: int) -> list[dict]:
    cards = []
    for c in concepts:
        term, meaning = _split(c)
        if meaning:
            cards.append(_card(f"What is meant by “{term}”?", meaning, c))
        if len(cards) >= count:
            break
    return cards


def _fallback_quiz(concepts: list[dict], count: int) -> list[dict]:
    rng = random.Random(42)
    pairs = [(c, *_split(c)) for c in concepts]
    pairs = [p for p in pairs if p[2]]
    quiz = []
    for c, term, meaning in pairs:
        distractors = [m for _, t, m in pairs if t != term and m != meaning]
        if len(distractors) < 3:
            break
        options = rng.sample(distractors, 3) + [meaning]
        rng.shuffle(options)
        quiz.append({"id": uuid.uuid4().hex[:8], "question": f"Which statement best describes “{term}”?", "options": [truncate(o, 140) for o in options], "answer": options.index(meaning), "explanation": meaning, "nodeId": c["id"], "start": c["start"]})
        if len(quiz) >= count:
            break
    return quiz

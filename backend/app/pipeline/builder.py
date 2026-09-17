"""
Layer 4 + 5 glue — turns segments + concepts into the hierarchical mindmap JSON.

Semantic layers of the produced tree:
    layer 0  root        central idea of the video
    layer 1  section     chapters / themes (from segmentation)
    layer 2  concept     key concepts, refined by the LLM ("Qubits: basic unit of quantum info")
    layer 3  detail      supporting sub-points
    layer 4  transcript  verbatim transcript leaves with timestamps (grounding)

Every node carries `start`/`end` seconds so the UI can jump to the video moment.
"""
from __future__ import annotations

import hashlib
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable

import numpy as np

from . import llm
from .concepts import ConceptGraph, extract_concepts
from .embeddings import Embedder, backend_name, cosine_matrix, embed
from .segmentation import Segment, segment_transcript
from .text_utils import fmt_time, parse_description_chapters, smart_title, truncate
from .tone import detect_tone, merge_tone
from .transcript import Transcript, TranscriptEntry, get_transcript, sentences_with_time

log = logging.getLogger("tubemind.builder")
ProgressFn = Callable[[str, float], None]

SCHEMA = "tubemind/1"


@dataclass(frozen=True)
class ModeConfig:
    concepts: int
    details: int
    leaves: int
    excerpt_chars: int
    detail_words: int


MODES = {
    # quick revision: few, punchy nodes
    "revision": ModeConfig(concepts=3, details=2, leaves=1, excerpt_chars=4500, detail_words=14),
    # academic research: definitions, more concepts, evidence leaves
    "academic": ModeConfig(concepts=5, details=3, leaves=2, excerpt_chars=6500, detail_words=22),
    # deep exploration: everything
    "deep": ModeConfig(concepts=7, details=4, leaves=3, excerpt_chars=8000, detail_words=28),
}


def new_id(prefix: str = "n") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def make_node(text: str, type_: str, layer: int, start: float | None = None, end: float | None = None, **extra) -> dict:
    node = {
        "id": new_id(),
        "text": text,
        "type": type_,
        "layer": layer,
        "start": None if start is None else round(float(start), 2),
        "end": None if end is None else round(float(end), 2),
        "summary": "",
        "tone": [],
        "keywords": [],
        "notes": "",
        "links": [],
        "image": None,
        "collapsed": False,
        "children": [],
    }
    node.update(extra)
    return node


# ---------------------------------------------------------------------------
def generate_mindmap(request: dict, progress: ProgressFn | None = None) -> dict:
    """End-to-end pipeline: Video → Transcript → Segments → Concepts → LLM → Mindmap JSON."""
    progress = progress or (lambda msg, pct: None)
    t0 = time.time()
    video_id = request["videoId"]
    mode = request.get("mode", "academic") if request.get("mode") in MODES else "academic"
    profile = request.get("profile", "balanced")
    cfg = MODES[mode]

    # 1. Transcript -----------------------------------------------------------
    progress("Fetching transcript", 0.05)
    transcript = get_transcript(
        video_id,
        provided=request.get("transcript"),
        languages=request.get("languages") or None,
        allow_whisper=request.get("allowWhisper", True),
        progress=lambda m, p: progress(m, 0.05 + p * 0.2),
    )
    duration = float(request.get("duration") or transcript.duration)

    # 2. Segmentation -----------------------------------------------------------
    progress(f"Segmenting {fmt_time(duration)} of transcript ({transcript.source})", 0.28)
    chapters = request.get("chapters") or parse_description_chapters(request.get("description", ""), duration)
    segments = segment_transcript(transcript, chapters, mode)

    # 3. Concepts + knowledge graph ------------------------------------------------
    progress(f"Extracting concepts from {len(segments)} sections", 0.38)
    graph = extract_concepts(segments, max_concepts=max(30, len(segments) * cfg.concepts * 2))

    # 4. LLM refinement (parallel per section) ---------------------------------------
    sentences = sentences_with_time(transcript.entries)
    title = request.get("title") or "YouTube video"
    use_llm = llm.available() and request.get("useLLM", True)
    done = 0

    def work(seg: Segment) -> dict:
        nonlocal done
        seg_sents = [s for s in sentences if seg.start - 0.5 <= s.start < seg.end + 0.5] or seg.blocks
        concepts = graph.for_segment(seg.id, limit=cfg.concepts * 2)
        result = None
        if use_llm:
            result = _llm_section(title, seg, concepts, seg_sents, cfg, profile, len(segments))
        section = _assemble_section(seg, concepts, seg_sents, result, cfg, profile)
        done += 1
        progress(f"Writing nodes for section {done}/{len(segments)}" + (" with " + llm.provider_name() if use_llm else ""), 0.42 + 0.45 * done / max(len(segments), 1))
        return section

    with ThreadPoolExecutor(max_workers=2) as pool:
        sections = list(pool.map(work, segments))

    # 5. Root + cross links -----------------------------------------------------------
    progress("Linking concepts across sections", 0.9)
    root_info = _llm_root(title, sections) if use_llm else None
    root = make_node(
        (root_info or {}).get("central_idea") or _short_title(title),
        "root",
        0,
        0,
        duration,
        summary=(root_info or {}).get("overview") or _heuristic_overview(sections),
        tone=merge_tone(detect_tone(transcript.full_text), (root_info or {}).get("tone")),
        keywords=[c.label for c in sorted(graph.concepts, key=lambda c: -c.centrality)[:8]],
    )
    root["children"] = sections
    for i, sec in enumerate(sections):
        sec["color"] = i % 5

    edges = _cross_edges(root, graph, (root_info or {}).get("links") or [])

    mindmap = {
        "schema": SCHEMA,
        "id": hashlib.sha1(f"{video_id}:{mode}:{profile}:{time.time()}".encode()).hexdigest()[:16],
        "version": 1,
        "meta": {
            "videoId": video_id,
            "title": title,
            "channel": request.get("channel", ""),
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "duration": duration,
            "mode": mode,
            "profile": profile,
            "language": transcript.language,
            "transcriptSource": transcript.source,
            "llm": llm.provider_name() if use_llm else "heuristic",
            "embeddings": backend_name(),
            "createdAt": int(time.time() * 1000),
            "buildSeconds": round(time.time() - t0, 1),
            "storyboardSpec": request.get("storyboardSpec"),
        },
        "root": root,
        "edges": edges,
        "segments": [s.to_dict() for s in segments],
        "graph": graph.to_dict(),
        "transcript": [{"start": round(e.start, 2), "end": round(e.end, 2), "text": e.text} for e in transcript.entries],
    }
    progress("Done", 1.0)
    return mindmap


# ---------------------------------------------------------------------------
# LLM prompts
# ---------------------------------------------------------------------------
SECTION_SYSTEM = """You are an expert study-note writer. You turn one section of a video transcript
into hierarchical mind-map nodes that are VALID, MEANINGFUL and SELF-CONTAINED.

Rules:
- Never write meta phrases like "the speaker mentions", "this section talks about", "quantum bits mentioned".
- Concept labels use the pattern "Term: short meaning" when a term is defined
  (e.g. "Qubits: fundamental unit of quantum computing"), otherwise a crisp claim.
- Keep labels short (max {label_words} words). Details add facts, examples, numbers or causes.
- Only use information present in the transcript. Fix obvious caption errors.
- `start` must be a number of seconds taken from the [mm:ss] markers where the idea is discussed.
- tone: zero or more of enthusiastic, critical, controversial, cautionary, humorous, instructional,
  inspirational, analytical, skeptical, optimistic."""

SECTION_SCHEMA = """{
  "title": "2-6 word section header",
  "summary": "one sentence overview of the section",
  "tone": ["..."],
  "concepts": [
    {"label": "Term: meaning", "start": 123, "detail": "1-2 sentence explanation",
     "children": [{"label": "supporting point", "start": 130}]}
  ]
}"""


def _llm_section(video_title: str, seg: Segment, concepts, sents: list[TranscriptEntry], cfg: ModeConfig, profile: str, n_sections: int) -> dict | None:
    excerpt = _compress_excerpt(sents, concepts, cfg.excerpt_chars)
    label_words = 7 if profile == "visual" else 12
    prompt = {
        "video_title": video_title,
        "section": f"{seg.id[1:]} of {n_sections}",
        "time_range": f"{fmt_time(seg.start)}-{fmt_time(seg.end)}",
        "chapter_title": seg.title if seg.from_chapter else None,
        "keywords_tfidf": seg.keywords,
        "candidate_concepts": [{"concept": c.label, "first_mention": fmt_time(c.first_ts)} for c in concepts],
        "want": {
            "concepts": cfg.concepts,
            "children_per_concept": cfg.details,
            "style": "short visual labels" if profile == "visual" else "informative text-rich labels",
        },
    }
    user = (
        f"Section metadata:\n{llm.compact(prompt)}\n\nTranscript excerpt:\n{excerpt}\n\n"
        f"Return JSON exactly in this shape:\n{SECTION_SCHEMA}"
    )
    data = llm.chat_json(SECTION_SYSTEM.format(label_words=label_words), user, max_tokens=1600)
    if not isinstance(data, dict) or not isinstance(data.get("concepts"), list):
        return None
    return data


ROOT_SYSTEM = """You write the central idea of a mind map for a video and link related concepts across sections.
The central idea is 1-5 words (like a poster title). Links connect concepts from DIFFERENT sections
with a short verb phrase label (max 4 words)."""


def _llm_root(title: str, sections: list[dict]) -> dict | None:
    outline = [
        {"section": s["text"], "concepts": [c["text"] for c in s["children"] if c["type"] == "concept"]}
        for s in sections
    ]
    user = (
        f"Video title: {title}\nOutline:\n{llm.compact(outline)}\n\n"
        'Return JSON: {"central_idea": "...", "overview": "2 sentence overview", "tone": ["..."], '
        '"links": [{"from": "exact concept text", "to": "exact concept text", "label": "..."}]} '
        "with at most 6 links."
    )
    data = llm.chat_json(ROOT_SYSTEM, user, max_tokens=900)
    return data if isinstance(data, dict) else None


def _compress_excerpt(sents: list[TranscriptEntry], concepts, budget: int) -> str:
    """Extractive compression: keep concept-bearing sentences (in time order) within a char budget."""
    lines = [(s, f"[{fmt_time(s.start)}] {s.text}") for s in sents]
    total = sum(len(line) + 1 for _, line in lines)
    if total <= budget:
        return "\n".join(line for _, line in lines)
    aliases = [a for c in concepts for a in c.aliases[:3]]
    scored = []
    for idx, (s, line) in enumerate(lines):
        low = s.text.lower()
        score = sum(2 for a in aliases if a in low) + min(len(s.text), 200) / 200
        scored.append((score, idx))
    keep, used = set(), 0
    for score, idx in sorted(scored, reverse=True):
        size = len(lines[idx][1]) + 1
        if used + size > budget:
            continue
        keep.add(idx)
        used += size
    return "\n".join(lines[i][1] for i in sorted(keep))


# ---------------------------------------------------------------------------
# Assembly + grounding
# ---------------------------------------------------------------------------
def _assemble_section(seg: Segment, concepts, sents: list[TranscriptEntry], result: dict | None, cfg: ModeConfig, profile: str) -> dict:
    lexicon_tone = detect_tone(seg.text)
    if seg.from_chapter:
        title = seg.title
    elif result and result.get("title"):
        title = result["title"]
    else:  # offline: name the section after the concepts that are most specific to it
        specific = sorted(concepts, key=lambda c: (len(c.segments), -c.score))
        picks = [c.label for c in specific if " " in c.label][:1]
        taken = {w.lower().removesuffix("'s") for p in picks for w in p.split()}
        picks += [c.label for c in specific if " " not in c.label and c.label.lower().removesuffix("'s") not in taken][:1]
        title = " & ".join(picks) if picks else seg.title
    section = make_node(
        truncate(str(title), 60),
        "section",
        1,
        seg.start,
        seg.end,
        summary=truncate(str((result or {}).get("summary") or _central_sentence(sents)), 260),
        tone=merge_tone(lexicon_tone, (result or {}).get("tone")),
        keywords=seg.keywords,
        segmentId=seg.id,
        theme=seg.theme,
    )

    grounding = _Grounder(sents)
    raw_concepts = (result or {}).get("concepts") or _heuristic_concepts(concepts, sents, cfg)
    used_leaves: set[int] = set()
    for rc in raw_concepts[: cfg.concepts]:
        if not isinstance(rc, dict) or not str(rc.get("label", "")).strip():
            continue
        label = truncate(str(rc["label"]).strip(), 110)
        detail = str(rc.get("detail") or "").strip()
        start = grounding.locate(label + " " + detail, rc.get("start"), seg)
        node = make_node(label, "concept", 2, start, None, summary=truncate(detail, 320))
        for child in (rc.get("children") or [])[: cfg.details]:
            text = child.get("label") if isinstance(child, dict) else child
            if not text:
                continue
            c_start = grounding.locate(str(text), child.get("start") if isinstance(child, dict) else None, seg)
            node["children"].append(make_node(truncate(str(text), 120), "detail", 3, c_start, None))
        for idx in grounding.best_sentences(label + " " + detail, k=cfg.leaves, exclude=used_leaves):
            used_leaves.add(idx)
            s = sents[idx]
            node["children"].append(make_node(f"“{truncate(s.text, 150)}”", "transcript", 4, s.start, s.end))
        node["collapsed"] = profile == "visual" or cfg.leaves == 1
        section["children"].append(node)

    section["children"].sort(key=lambda n: n["start"] if n["start"] is not None else 1e9)
    return section


class _Grounder:
    """Snaps LLM timestamps to real transcript sentences using semantic similarity."""

    def __init__(self, sents: list[TranscriptEntry]):
        self.sents = sents
        self.texts = [s.text for s in sents]
        self.encoder = Embedder(self.texts) if sents else None
        self.vecs = self.encoder.encode(self.texts) if sents else np.zeros((0, 1))

    def _sims(self, query: str) -> np.ndarray:
        if not self.sents:
            return np.zeros(0)
        return cosine_matrix(self.encoder.encode([query]), self.vecs)[0]

    def locate(self, query: str, llm_start, seg: Segment) -> float:
        sims = self._sims(query)
        if not len(sims):
            return seg.start
        if isinstance(llm_start, (int, float)) and seg.start - 5 <= llm_start <= seg.end + 5:
            # prefer sentences near the LLM's timestamp, weighted by similarity
            dist = np.array([abs(s.start - llm_start) for s in self.sents])
            score = sims - dist / max(seg.end - seg.start, 1.0) * 0.5
            return float(self.sents[int(np.argmax(score))].start)
        return float(self.sents[int(np.argmax(sims))].start)

    def best_sentences(self, query: str, k: int, exclude: set[int]) -> list[int]:
        sims = self._sims(query)
        order = [int(i) for i in np.argsort(-sims) if int(i) not in exclude and len(self.texts[int(i)]) > 25]
        return order[:k]


def _central_sentence(sents: list[TranscriptEntry]) -> str:
    if not sents:
        return ""
    texts = [s.text for s in sents if len(s.text) > 30] or [s.text for s in sents]
    vecs = embed(texts, corpus=texts)
    centroid = vecs.mean(axis=0, keepdims=True)
    return texts[int(np.argmax(cosine_matrix(centroid, vecs)[0]))]


def _heuristic_concepts(concepts, sents: list[TranscriptEntry], cfg: ModeConfig) -> list[dict]:
    """Offline fallback: concept label + the most relevant sentence as detail."""
    out = []
    for c in concepts[: cfg.concepts]:
        mentions = [s for s in sents if any(a in s.text.lower() for a in c.aliases[:3])]
        detail = truncate(mentions[0].text, cfg.detail_words * 7) if mentions else ""
        children = [{"label": truncate(m.text, 110), "start": m.start} for m in mentions[1 : 1 + cfg.details]]
        out.append({"label": c.label, "start": c.first_ts, "detail": detail, "children": children})
    return out


def _heuristic_overview(sections: list[dict]) -> str:
    return " · ".join(s["text"] for s in sections[:6])


def _short_title(title: str) -> str:
    # "How Quantum Computers Work | Full Lecture (2024)" -> "How Quantum Computers Work"
    import re

    core = re.split(r"\s[|\-–—:]\s|\(|\[", title)[0].strip()
    return smart_title(truncate(core or title, 48))


def _cross_edges(root: dict, graph: ConceptGraph, llm_links: list[dict]) -> list[dict]:
    concept_nodes = [(sec, c) for sec in root["children"] for c in sec["children"] if c["type"] == "concept"]
    if not concept_nodes:
        return []
    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(a: dict, b: dict, label: str, source: str):
        key = tuple(sorted((a["id"], b["id"])))
        if a["id"] == b["id"] or key in seen:
            return
        seen.add(key)
        edges.append({"id": new_id("e"), "source": a["id"], "target": b["id"], "label": truncate(label, 32), "origin": source})

    by_text = {c["text"].lower(): (sec, c) for sec, c in concept_nodes}
    for link in llm_links[:6]:
        if not isinstance(link, dict):
            continue
        a = by_text.get(str(link.get("from", "")).lower())
        b = by_text.get(str(link.get("to", "")).lower())
        if a and b and a[0]["id"] != b[0]["id"]:
            add(a[1], b[1], str(link.get("label") or "related to"), "llm")

    # knowledge-graph edges mapped onto nodes whose text mentions the concept
    def node_for(concept_id: str):
        concept = next((c for c in graph.concepts if c.id == concept_id), None)
        if not concept:
            return None
        for sec, node in concept_nodes:
            low = node["text"].lower()
            if any(alias in low for alias in concept.aliases[:4]):
                return sec, node
        return None

    for e in graph.edges:
        if len(edges) >= 10:
            break
        a, b = node_for(e["source"]), node_for(e["target"])
        if a and b and a[0]["id"] != b[0]["id"]:
            add(a[1], b[1], e["label"], "graph")
    return edges

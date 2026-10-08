"""
Select-then-rewrite: ONE LLM call turns an already built map into exam-ready English.

The pipeline has already SELECTED everything (sections, concepts, tagged level-3 items, their
timestamps, source sentences and the summary retriever's best sentences). This module sends a
compact numbered candidate list and asks for rewritten text back, one item per line:

    R|Topic of the whole video
    M|One-line summary of the whole video
    S|s1|Section title|What the section teaches
    C|c1|Term: one-line meaning
    D|d1|Eg|Short example
    X|c2>c5|leads to          (optional, at most 4)

Anything missing, malformed, non-English or duplicated keeps its heuristic (English) text,
so a timeout, a 429 or a garbled answer still yields a complete map. Results are cached per
section (keyed by a hash of that section's candidate list), so re-runs cost 0 tokens.

Input is built from the map JSON alone, so the rewrite can run later (e.g. on a cached
skeleton) and returns ops for the same `update` / `edge:add` path the extension and the
collaboration server already use. The LLM never writes the tree structure or timestamps.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from ..collab.ops import apply_op
from ..config import settings
from . import llm
from .builder import TAGS, new_id, score_faithfulness
from .embeddings import Embedder
from .text_utils import fmt_time, truncate
from .translate import needs_translation

log = logging.getLogger("tubemind.labels")

PROMPT_VERSION = "2"
MAX_CONCEPTS_PER_CALL = 60
MAX_PROMPT_TOKENS = 6000
MAX_CHUNKS = 3
MAX_LINKS = 4
MAX_DETAILS_PER_CONCEPT = 1  # level-3 items rewritten per concept (the rest keep their heuristic text)
SENTENCE_WORDS = 25
# The answer has to fit the deadline: ~350 output tokens/s on the fast model, after ~0.3 s to the
# first token. D lines are only asked for when the whole answer fits; otherwise the (already tagged)
# heuristic level-3 lines stay. Estimated answer tokens per line kind:
OUTPUT_TOKENS_PER_SECOND = 350
LINE_TOKENS = {"R": 8, "M": 22, "S": 18, "C": 13, "D": 14, "X": 8}

SYSTEM = """You turn a video's mind map into a last-minute revision sketchbook for a student in a hurry.
The structure and timestamps are fixed. You rewrite the given items into clear, concise, exam-ready English.

Reply with lines only, nothing else, in this order:
R|topic of the whole video (2-6 words)
M|one-line summary of the whole video (max 20 words)
S|<section id>|section title (2-6 words)|what the section teaches (max 12 words)
C|<concept id>|Term: one-line meaning (max 12 words)
D|<detail id>|<Def, Eg, Formula, Tip or Watch-out>|the point (max 12 words)
X|<concept id>><concept id>|relation (1-3 words)

Rules:
- One line for every id you are given. Keep the ids exactly. Fixed titles: repeat them unchanged.
- English only. Base every line on its sentence. Do not invent facts. Fix obvious caption typos.
- Self-contained lines. Never write "the speaker", "this section" or "the video".
- No timestamps, no quotes, no markdown, no duplicate lines.
- X lines are optional: at most 4, only between concepts of different sections."""


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------
@dataclass
class SectionCand:
    cid: str
    node: dict
    concepts: list["ConceptCand"] = field(default_factory=list)
    fixed: bool = False
    key: str = ""
    details: list["DetailCand"] = field(default_factory=list)
    recall: bool = False


@dataclass
class ConceptCand:
    cid: str
    sid: str
    node: dict


@dataclass
class DetailCand:
    cid: str  # d1, d2…
    concept: str  # c-id of its concept
    node: dict


def collect(mindmap: dict) -> list[SectionCand]:
    sections: list[SectionCand] = []
    c = d = 0
    for i, sec in enumerate(n for n in mindmap["root"].get("children", []) if n.get("type") == "section"):
        recall = bool(sec.get("recall"))
        cand = SectionCand(f"s{i + 1}", sec, fixed=bool(sec.get("chapter")) or recall, recall=recall)
        for node in sec.get("children", []):
            if node.get("type") != "concept" or node.get("oneline"):
                continue
            c += 1
            concept = ConceptCand(f"c{c}", cand.cid, node)
            cand.concepts.append(concept)
            for child in [ch for ch in node.get("children", []) if ch.get("type") == "detail" and ch.get("tag")][:MAX_DETAILS_PER_CONCEPT]:
                d += 1
                cand.details.append(DetailCand(f"d{d}", concept.cid, child))
        cand.key = _section_key(mindmap, cand)
        sections.append(cand)
    return sections


def _words(text: str, n: int = SENTENCE_WORDS) -> str:
    words = re.sub(r"\s+", " ", text or "").strip().split(" ")
    return " ".join(words[:n]) + ("…" if len(words) > n else "")


def _sentence(node: dict) -> str:
    return _words(node.get("source") or node.get("summary") or "")


def _untagged(node: dict) -> str:
    text = node.get("text") or ""
    tag = node.get("tag")
    return text[len(tag) + 1:].strip() if tag and text.startswith(f"{tag}:") else text


def _section_line(s: SectionCand) -> str:
    node = s.node
    if s.recall:
        return f"{s.cid} | Quick recall (fixed title; its concepts are must-remember points)"
    span = f"{fmt_time(node.get('start'))}-{fmt_time(node.get('end'))}"
    head = f"chapter: {node['text']} (fixed title)" if s.fixed else f"keywords: {', '.join((node.get('keywords') or [])[:5])}"
    return f'{s.cid} {span} | {head} | gist: "{_words(node.get("summary") or "", 30)}"'


def _concept_line(c: ConceptCand) -> str:
    return f'{c.cid} {c.sid} {fmt_time(c.node.get("start"))} | {c.node["text"]} | "{_sentence(c.node)}"'


def _detail_line(d: DetailCand) -> str:
    return f'{d.cid} {d.concept} {d.node.get("tag")} | {_untagged(d.node)} | "{_sentence(d.node)}"'


def _section_key(mindmap: dict, s: SectionCand) -> str:
    body = "\n".join(
        [PROMPT_VERSION, _section_line(s).split(" ", 1)[1]]
        + [_concept_line(c).split(" ", 2)[2] for c in s.concepts]
        + [_detail_line(d).split(" ", 2)[2] for d in s.details]
    )
    return hashlib.sha1(body.encode()).hexdigest()[:20]


def _root_key(mindmap: dict, sections: list[SectionCand]) -> str:
    body = "|".join([PROMPT_VERSION, mindmap["meta"].get("title", "")] + [s.key for s in sections])
    return hashlib.sha1(body.encode()).hexdigest()[:20]


def build_prompt(title: str, sections: list[SectionCand], want_root: bool, outline: list[str] | None = None, with_details: bool = True) -> str:
    # what a student reads first comes first: if the deadline cuts the answer, the tail is lost
    sections = [s for s in sections if s.recall] + [s for s in sections if not s.recall]
    details = [_detail_line(d) for s in sections for d in s.details] if with_details else []
    lines = [f"Video: {title}"]
    if want_root and outline:
        lines.append("Outline of the whole video: " + "; ".join(outline))
    todo = "one S line per section, one C line per concept" + (", one D line per detail" if details else "") + ", then up to 4 X lines"
    lines.append(f"Answer with: the R line, the M line, {todo}." if want_root else f"Answer with: {todo}. No R or M line.")
    lines.append("Sections:")
    lines += [_section_line(s) for s in sections]
    lines.append("Concepts:")
    lines += [_concept_line(c) for s in sections for c in s.concepts]
    if details:
        lines.append("Details:")
        lines += details
    return "\n".join(lines)


def answer_tokens(sections: list[SectionCand], want_root: bool, with_details: bool) -> int:
    """Estimated size of a complete answer (to decide whether D lines fit the deadline)."""
    n = (LINE_TOKENS["R"] + LINE_TOKENS["M"] if want_root else 0) + MAX_LINKS * LINE_TOKENS["X"]
    for s in sections:
        n += LINE_TOKENS["S"] + LINE_TOKENS["C"] * len(s.concepts) + (LINE_TOKENS["D"] * len(s.details) if with_details else 0)
    return n


def max_tokens(n_lines: int) -> int:
    """~13 tokens per answer line plus headroom for a reasoning model's (low-effort) thinking."""
    return min(1100, 150 + 13 * n_lines)


def plan_chunks(sections: list[SectionCand], title: str) -> list[list[SectionCand]]:
    """Whole video in one prompt; split into ≤3 contiguous chunks only when it is too big."""
    total = sum(len(s.concepts) for s in sections)
    tokens = llm.estimate_tokens(SYSTEM + build_prompt(title, sections, True))
    n = 1
    while n < MAX_CHUNKS and (total / n > MAX_CONCEPTS_PER_CALL or tokens / n > MAX_PROMPT_TOKENS):
        n += 1
    if n == 1:
        return [sections]
    per = total / n
    chunks: list[list[SectionCand]] = [[]]
    count = 0
    for s in sections:
        if chunks[-1] and count + len(s.concepts) / 2 > per * len(chunks) and len(chunks) < n:
            chunks.append([])
        chunks[-1].append(s)
        count += len(s.concepts)
    return [c for c in chunks if c]


# ---------------------------------------------------------------------------
# Tolerant line parser
# ---------------------------------------------------------------------------
@dataclass
class Parsed:
    root: str | None = None
    summary: str | None = None  # M line
    sections: dict[str, str] = field(default_factory=dict)
    section_summaries: dict[str, str] = field(default_factory=dict)
    concepts: dict[str, str] = field(default_factory=dict)
    details: dict[str, tuple[str | None, str]] = field(default_factory=dict)  # id -> (tag or None, text)
    links: list[tuple[str, str, str]] = field(default_factory=list)
    malformed: int = 0


LINE_RE = re.compile(r"^\s*(?:[-*•>]+|\d+[.)])?\s*(?:\*\*)?\s*([RSCXMD])\s*(?:\*\*)?\s*\|(.*)$", re.I)
BARE_ID_RE = re.compile(r"^\s*(?:[-*•]+\s*)?\[?([scd]\d+)\]?\s*\|(.*)$", re.I)
ID_RE = re.compile(r"^\[?([scd]\d+)\]?$", re.I)
LINK_RE = re.compile(r"^\[?(c\d+)\]?\s*(?:->|>|→|,|\s)\s*\[?(c\d+)\]?$", re.I)
TIME_RE = re.compile(r"\[?\(?\b\d{1,2}:\d{2}(?::\d{2})?\b\)?\]?")
META_RE = re.compile(r"\b(?:the speaker|this section|this video|the video|speaker (?:mentions|says|talks))\b", re.I)
TAG_ALIASES = {
    "def": "Def", "definition": "Def", "defn": "Def", "meaning": "Def",
    "eg": "Eg", "e.g": "Eg", "e.g.": "Eg", "example": "Eg", "ex": "Eg",
    "formula": "Formula", "equation": "Formula", "rule": "Formula",
    "tip": "Tip", "remember": "Tip", "note": "Tip", "key point": "Tip",
    "watch-out": "Watch-out", "watch out": "Watch-out", "watchout": "Watch-out", "caution": "Watch-out", "warning": "Watch-out", "pitfall": "Watch-out",
}


def clean_label(text: str, max_chars: int, max_words: int) -> str | None:
    text = TIME_RE.sub(" ", text.replace("**", "").replace("`", ""))
    text = re.sub(r"\s+", " ", text).strip().strip("\"'“”‘’").rstrip(".;,").strip()
    text = re.sub(r"\s+:", ":", text)
    if not text or META_RE.search(text) or not re.search(r"[A-Za-z0-9]", text) or needs_translation(text):
        return None
    if len(text.split()) > max_words or len(text) > max_chars:
        return None
    return text


def _tag(text: str) -> str | None:
    return TAG_ALIASES.get(text.strip().strip("[]()*").lower())


def parse_labels(text: str) -> Parsed:
    """Parse the pipe format. Never raises; anything unusable is counted as malformed and skipped."""
    out = Parsed()
    for raw in (text or "").replace("｜", "|").splitlines():
        if not raw.strip() or raw.strip().startswith("```"):
            continue
        m = LINE_RE.match(raw)
        if m:
            kind, rest = m.group(1).upper(), m.group(2)
        elif bm := BARE_ID_RE.match(raw):  # "c3|Label" without the C prefix
            kind, rest = bm.group(1)[0].upper(), f"{bm.group(1)}|{bm.group(2)}"
        else:
            out.malformed += 1
            continue
        parts = [p.strip() for p in rest.split("|")]
        if kind in "RM":
            label = clean_label(" ".join(p for p in parts if p), 60 if kind == "R" else 170, 8 if kind == "R" else 24)
            current = out.root if kind == "R" else out.summary
            if label and current is None:
                if kind == "R":
                    out.root = label
                else:
                    out.summary = label
            elif not label:
                out.malformed += 1
            continue
        if kind in "SCD":
            ident = ID_RE.match(parts[0]) if parts else None
            id_kind = ident.group(1)[0].upper() if ident else ""
            if not ident or len(parts) < 2 or not (id_kind == kind or kind == "D" and id_kind == "C"):
                out.malformed += 1
                continue
            key = ident.group(1).lower()
            if kind == "S":
                title = clean_label(parts[1], 60, 8)
                summary = clean_label(". ".join(p for p in parts[2:] if p), 140, 20) if len(parts) > 2 else None
                if title and key not in out.sections:
                    out.sections[key] = title
                if summary and key not in out.section_summaries:
                    out.section_summaries[key] = summary
                if not title and not summary:
                    out.malformed += 1
                continue
            if kind == "C":
                label = clean_label(": ".join(p for p in parts[1:] if p), 110, 16)
                if label and key not in out.concepts:
                    out.concepts[key] = label
                elif not label:
                    out.malformed += 1
                continue
            # D|d1|Eg|text  ·  D|d1|text  ·  D|c1|Def|text (detail addressed through its concept)
            tag = _tag(parts[1]) if len(parts) > 2 else None
            body = " ".join(p for p in parts[2:] if p) if tag else ": ".join(p for p in parts[1:] if p)
            inline = re.match(r"^(def|definition|eg|e\.g\.?|example|formula|equation|tip|remember|note|watch[- ]?out|caution|warning)\s*:\s*", body, re.I)
            if inline:  # "Watch out: …" written inside the text: that is the tag
                tag, body = tag or _tag(inline.group(1)), body[inline.end():]
            label = clean_label(body, 110, 16)
            target = f"{key}#{tag or ''}" if id_kind == "C" else key
            if label and target not in out.details:
                out.details[target] = (tag, label)
            elif not label:
                out.malformed += 1
            continue
        # X
        link = LINK_RE.match(parts[0]) if parts else None
        label = clean_label(parts[1], 32, 4) if len(parts) > 1 else None
        if link and label and len(out.links) < MAX_LINKS:
            out.links.append((link.group(1).lower(), link.group(2).lower(), label))
        elif not (link and label):
            out.malformed += 1
    return out


def _resolve_details(parsed: Parsed, details: dict[str, DetailCand]) -> dict[str, tuple[str | None, str]]:
    """Map 'c1#Def'-style answers onto the concept's detail with that tag (or its first one)."""
    out = {k: v for k, v in parsed.details.items() if k in details}
    for key, value in parsed.details.items():
        if "#" not in key:
            continue
        concept, tag = key.split("#", 1)
        owned = [d for d in details.values() if d.concept == concept]
        pick = next((d for d in owned if tag and d.node.get("tag") == tag), owned[0] if owned else None)
        if pick and pick.cid not in out:
            out[pick.cid] = value
    return out


# ---------------------------------------------------------------------------
# Cache (per section, keyed by its candidate list) — re-runs cost 0 tokens
# ---------------------------------------------------------------------------
def _cache_path(key: str):
    path = settings.data_dir / "cache" / "labels"
    path.mkdir(parents=True, exist_ok=True)
    return path / f"{key}.json"


def _cache_read(key: str) -> dict | None:
    try:
        return json.loads(_cache_path(key).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _cache_write(key: str, value: dict) -> None:
    try:
        _cache_path(key).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        log.warning("label cache write failed: %s", exc)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def label_map(mindmap: dict, timeout: float | None = None) -> dict:
    """
    Return {"ops": [...], "meta": {...}, "stats": {...}} for the one-call rewrite.
    Never raises; with no LLM, a failure or a timeout, `ops` only contains what arrived.
    """
    started = time.perf_counter()
    # The faithfulness encoder does not depend on the LLM answer: fit it while the call runs.
    texts = [e["text"] for e in mindmap.get("transcript") or []]
    encoder_pool = ThreadPoolExecutor(max_workers=1)
    encoder_future = encoder_pool.submit(Embedder, texts) if texts else None
    title = mindmap.get("meta", {}).get("title") or mindmap["root"]["text"]
    sections = collect(mindmap)
    by_cid = {s.cid: s for s in sections}
    concepts = {c.cid: c for s in sections for c in s.concepts}
    details = {d.cid: d for s in sections for d in s.details}
    stats = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "llm_ms": 0, "cached_sections": 0, "malformed": 0, "errors": []}
    merged = Parsed()

    # 1. cache lookup ----------------------------------------------------------------
    todo: list[SectionCand] = []
    for s in sections:
        hit = _cache_read(s.key)
        if hit is None:
            todo.append(s)
            continue
        stats["cached_sections"] += 1
        if hit.get("title") and not s.fixed:
            merged.sections[s.cid] = hit["title"]
        if hit.get("summary"):
            merged.section_summaries[s.cid] = hit["summary"]
        for c, label in zip(s.concepts, hit.get("concepts") or []):
            if label:
                merged.concepts[c.cid] = label
        for d, item in zip(s.details, hit.get("details") or []):
            if item:
                merged.details[d.cid] = (item[0], item[1])
    root_key = _root_key(mindmap, sections)
    root_hit = _cache_read(root_key)
    if root_hit:
        merged.root = root_hit.get("root")
        merged.summary = root_hit.get("summary")
        for a, b, label in root_hit.get("links") or []:
            merged.links.append((a, b, label))

    # 2. one call (≤3 parallel chunks for very long videos) ---------------------------
    want_root = root_hit is None
    if (todo or want_root) and llm.fast_available() and sections:
        chunks = plan_chunks(todo, title) if todo else [[]]
        outline = [s.node["text"] for s in sections] if (len(chunks) > 1 or not todo or len(todo) < len(sections)) else None

        deadline = timeout or settings.label_timeout
        budget = max(200, (deadline - 0.3) * OUTPUT_TOKENS_PER_SECOND)

        def run(i_chunk: tuple[int, list[SectionCand]]):
            i, chunk = i_chunk
            root_here = want_root and i == 0
            with_details = answer_tokens(chunk, root_here, True) <= budget
            prompt = build_prompt(title, chunk, root_here, outline, with_details=with_details)
            n_lines = 2 + 2 * len(chunk) + sum(len(s.concepts) + (len(s.details) if with_details else 0) for s in chunk) + MAX_LINKS
            return chunk, llm.complete(SYSTEM, prompt, max_tokens=max_tokens(n_lines), temperature=0.2, timeout=deadline)

        with ThreadPoolExecutor(max_workers=len(chunks)) as pool:
            results = list(pool.map(run, enumerate(chunks)))

        fresh_links: list[tuple[str, str, str]] = []
        for chunk, comp in results:
            stats["calls"] += 1 if comp.sent else 0
            stats["prompt_tokens"] += comp.prompt_tokens
            stats["completion_tokens"] += comp.completion_tokens
            stats["llm_ms"] = max(stats["llm_ms"], round(comp.ms))
            if comp.error:
                stats["errors"].append(comp.error)
            text = comp.text
            if not comp.ok and not text.endswith("\n"):  # cut off mid-line: drop the unfinished label
                text = text.rsplit("\n", 1)[0] if "\n" in text else ""
            parsed = parse_labels(text)
            parsed.details = _resolve_details(parsed, details)
            stats["malformed"] += parsed.malformed
            if want_root and merged.root is None and parsed.root:
                merged.root = parsed.root
            if want_root and merged.summary is None and parsed.summary:
                merged.summary = parsed.summary
            for sid, label in parsed.sections.items():
                if sid in by_cid and not by_cid[sid].fixed:
                    merged.sections.setdefault(sid, label)
            for sid, summary in parsed.section_summaries.items():
                if sid in by_cid:
                    merged.section_summaries.setdefault(sid, summary)
            for cid, label in parsed.concepts.items():
                if cid in concepts:
                    merged.concepts.setdefault(cid, label)
            for did, item in parsed.details.items():
                merged.details.setdefault(did, item)
            fresh_links += parsed.links
            for s in chunk:
                # a complete answer caches every section; a cut-off one only the sections that fully
                # arrived, so the next open asks only for the rest
                complete = (s.fixed or s.cid in parsed.sections) and all(c.cid in parsed.concepts for c in s.concepts)
                if comp.ok or (complete and s.concepts):
                    _cache_write(s.key, {
                        "title": parsed.sections.get(s.cid),
                        "summary": parsed.section_summaries.get(s.cid),
                        "concepts": [parsed.concepts.get(c.cid) for c in s.concepts],
                        "details": [list(parsed.details[d.cid]) if d.cid in parsed.details else None for d in s.details],
                    })
                    stats.setdefault("sections_cached", 0)
                    stats["sections_cached"] += 1
        merged.links += fresh_links
        if want_root and merged.root and (results[0][1].ok or merged.summary):
            _cache_write(root_key, {"root": merged.root, "summary": merged.summary, "links": [list(link) for link in fresh_links]})

    # 3. labels -> ops ---------------------------------------------------------------------
    apply_started = time.perf_counter()
    ops, changed = _to_ops(mindmap, sections, concepts, details, merged, encoder_future.result() if encoder_future else None)
    encoder_pool.shutdown(wait=False)
    stats["apply_ms"] = round((time.perf_counter() - apply_started) * 1000)
    stats["applied"] = len([o for o in ops if o["type"] == "update"])
    stats["candidates"] = 2 + sum(1 for s in sections if not s.fixed) + len(concepts) + len(details)
    stats["ms"] = round((time.perf_counter() - started) * 1000)
    # an answer cut by the deadline is accepted as it is (no re-call on every reopen);
    # hard failures (429, 5xx, network) leave the map unlabelled so a later open can retry
    labelled = bool(ops) and not [e for e in stats["errors"] if e != "deadline"]
    log.info(
        "labels %s llm_calls=%d prompt_tokens=%d completion_tokens=%d llm_ms=%d applied=%d/%d cached_sections=%d/%d malformed=%d errors=%s apply_ms=%d total_ms=%d",
        mindmap.get("meta", {}).get("videoId"), stats["calls"], stats["prompt_tokens"], stats["completion_tokens"], stats["llm_ms"],
        stats["applied"], stats["candidates"], stats["cached_sections"], len(sections), stats["malformed"], stats["errors"] or "none", stats["apply_ms"], stats["ms"],
    )
    meta = {"labelled": labelled or (not todo and root_hit is not None)}
    if stats["calls"] or stats["cached_sections"]:
        meta["llm"] = llm.fast_name()
    return {"ops": ops, "meta": meta, "stats": stats}


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _to_ops(mindmap: dict, sections: list[SectionCand], concepts: dict[str, ConceptCand], details: dict[str, DetailCand],
            parsed: Parsed, encoder: Embedder | None = None) -> tuple[list[dict], list[dict]]:
    root = mindmap["root"]
    patches: dict[str, dict] = {}  # node id -> patch (insertion order = display order)
    nodes: dict[str, dict] = {}

    def propose(node: dict, **patch) -> None:
        patch = {k: v for k, v in patch.items() if v is not None and v != node.get(k)}
        if patch:
            nodes[node["id"]] = node
            patches.setdefault(node["id"], {}).update(patch)

    new_titles = [parsed.sections.get(s.cid, s.node["text"]) for s in sections if not s.recall]
    if parsed.root:
        propose(root, text=parsed.root, summary=parsed.summary or " · ".join(new_titles[:6]))
    elif parsed.summary:
        propose(root, summary=parsed.summary)
    for s in sections:
        title = truncate(parsed.sections[s.cid], 60) if s.cid in parsed.sections and not s.fixed else None
        summary = parsed.section_summaries.get(s.cid)
        if s.recall:
            summary = parsed.summary
            line = next((c for c in s.node.get("children", []) if c.get("oneline")), None)
            if line is not None and parsed.summary:
                propose(line, text=f"In one line: {parsed.summary}")
        propose(s.node, text=title, summary=summary)
    for cid, label in parsed.concepts.items():
        propose(concepts[cid].node, text=truncate(label, 110))
    for did, (tag, text) in parsed.details.items():
        d = details[did]
        tag = tag if tag in TAGS else d.node.get("tag")
        propose(d.node, text=truncate(f"{tag}: {text}" if tag else text, 120), tag=tag)

    # no duplicate labels: a rewrite that repeats another node's text keeps its heuristic text
    seen: dict[str, str] = {}
    for node in [root, *(s.node for s in sections), *(c.node for c in concepts.values()), *(d.node for d in details.values())]:
        text = patches.get(node["id"], {}).get("text", node["text"])
        key = _norm(text)
        if key in seen and "text" in patches.get(node["id"], {}):
            patches[node["id"]].pop("text")
        else:
            seen.setdefault(key, node["id"])

    ops: list[dict] = []
    changed: list[dict] = []
    for nid, patch in patches.items():
        if not patch:
            continue
        ops.append({"type": "update", "id": nid, "patch": patch})
        if "text" in patch:
            changed.append({**nodes[nid], **patch})

    # faithfulness of the new labels against their own transcript spans
    if changed and encoder is not None:
        entries = mindmap.get("transcript") or []
        spans = {
            n["id"]: " ".join(e["text"] for e in entries if n["start"] - 0.5 <= e["start"] <= n["end"])[:6000]
            for n in changed
            if n.get("type") == "section" and n.get("start") is not None and n.get("end") is not None
        }
        score_faithfulness(changed, encoder, spans)
        faith = {n["id"]: n.get("faith") for n in changed}
        for op in ops:
            if faith.get(op["id"]) is not None:
                op["patch"]["faith"] = faith[op["id"]]

    # cross-links: LLM relation labels between concepts of different sections
    edges = mindmap.get("edges") or []
    for a, b, label in parsed.links[:MAX_LINKS]:
        ca, cb = concepts.get(a), concepts.get(b)
        if not ca or not cb or ca.sid == cb.sid or by_recall(ca, cb, sections):
            continue
        existing = next((e for e in edges if {e["source"], e["target"]} == {ca.node["id"], cb.node["id"]}), None)
        if existing and existing.get("label") != "related to":
            continue
        if existing:
            ops.append({"type": "edge:remove", "id": existing["id"]})
        ops.append({"type": "edge:add", "edge": {"id": new_id("e"), "source": ca.node["id"], "target": cb.node["id"], "label": label, "origin": "llm"}})
    return ops, changed


def by_recall(a: ConceptCand, b: ConceptCand, sections: list[SectionCand]) -> bool:
    recall = {s.cid for s in sections if s.recall}
    return a.sid in recall or b.sid in recall


def apply_outcome(mindmap: dict, outcome: dict) -> dict:
    """Apply label ops + meta to a map in place (server-side cache / CLI)."""
    for op in outcome.get("ops", []):
        apply_op(mindmap, op)
    mindmap.setdefault("meta", {}).update(outcome.get("meta", {}))
    stats = outcome.get("stats") or {}
    mindmap["meta"]["labelStats"] = {k: stats.get(k) for k in ("calls", "prompt_tokens", "completion_tokens", "llm_ms", "applied", "candidates")}
    return mindmap

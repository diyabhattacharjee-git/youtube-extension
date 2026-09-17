"""
Layer 2 — Content Segmentation.

Turns transcript blocks into logical sections (chapters / themes).

1. If the video has chapters (player markers or "0:00 Intro" description lines),
   they are used directly — the creator knows best.
2. Otherwise a TextTiling-style algorithm runs on block embeddings:
   cosine similarity between adjacent windows -> "depth scores" at valleys ->
   the deepest valleys become boundaries (with a minimum section length).
   Speaker turn changes (">>" markers in captions) boost boundary scores.
3. Topic modelling: LDA (scikit-learn) gives every section a dominant topic;
   BERTopic-style class-based TF-IDF (c-TF-IDF) gives each section its keywords.
4. Semantic clustering groups sections into higher-level *themes*
   (agglomerative clustering over section embeddings).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .embeddings import cosine_matrix, embed
from .text_utils import FILLER_WORDS, candidate_phrases, dedupe_keep_order, smart_title
from .transcript import Transcript, TranscriptEntry


@dataclass
class Segment:
    id: str
    start: float
    end: float
    text: str
    blocks: list[TranscriptEntry]
    title: str = ""
    keywords: list[str] = field(default_factory=list)
    topic: int = -1
    theme: int = 0
    speakers: int = 1
    from_chapter: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "start": self.start,
            "end": self.end,
            "title": self.title,
            "keywords": self.keywords,
            "topic": self.topic,
            "theme": self.theme,
            "speakers": self.speakers,
            "fromChapter": self.from_chapter,
        }


# Targets per summarisation mode: (seconds per section, min sections, max sections)
MODE_TARGETS = {
    "revision": (300, 3, 6),
    "academic": (200, 4, 9),
    "deep": (150, 4, 12),
}


def stop_words() -> list[str]:
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

    return sorted(set(ENGLISH_STOP_WORDS) | FILLER_WORDS)


def segment_transcript(
    transcript: Transcript,
    chapters: list[dict] | None = None,
    mode: str = "academic",
) -> list[Segment]:
    blocks = transcript.blocks
    if not blocks:
        return []

    if chapters and len(chapters) >= 2:
        segments = _from_chapters(blocks, chapters)
    else:
        segments = _texttiling(blocks, transcript.duration, mode)

    _label_topics(segments)
    _cluster_themes(segments)
    return segments


# ---------------------------------------------------------------------------
def _from_chapters(blocks: list[TranscriptEntry], chapters: list[dict]) -> list[Segment]:
    chapters = sorted(chapters, key=lambda c: float(c.get("start", 0)))
    segments: list[Segment] = []
    for i, ch in enumerate(chapters):
        start = float(ch.get("start", 0))
        end = float(chapters[i + 1]["start"]) if i + 1 < len(chapters) else math.inf
        members = [b for b in blocks if start - 1 <= b.start < end]
        if not members:
            continue
        segments.append(
            Segment(
                id=f"s{len(segments) + 1}",
                start=members[0].start,
                end=members[-1].end,
                text=" ".join(b.text for b in members),
                blocks=members,
                title=str(ch.get("title", "")).strip(),
                speakers=1 + sum(1 for b in members[1:] if b.speaker_change),
                from_chapter=True,
            )
        )
    return segments


def _texttiling(blocks: list[TranscriptEntry], duration: float, mode: str) -> list[Segment]:
    per, lo, hi = MODE_TARGETS.get(mode, MODE_TARGETS["academic"])
    n = len(blocks)
    target = int(np.clip(round(duration / per), lo, hi))
    target = max(1, min(target, n))
    if n <= 3 or target == 1:
        return [_make_segment(0, blocks)]

    texts = [b.text for b in blocks]
    vecs = embed(texts, corpus=texts)

    # Similarity between the window before and after each gap (window of 2 blocks).
    w = 2
    gap_scores = []
    for gap in range(1, n):
        left = vecs[max(0, gap - w) : gap].mean(axis=0, keepdims=True)
        right = vecs[gap : min(n, gap + w)].mean(axis=0, keepdims=True)
        gap_scores.append(float(cosine_matrix(_unit(left), _unit(right))[0, 0]))
    sims = np.array(gap_scores)
    if len(sims) >= 3:  # light smoothing
        sims = np.convolve(np.pad(sims, 1, mode="edge"), np.ones(3) / 3, mode="valid")

    # Depth score = how far the valley sits below the nearest peaks on both sides.
    depth = np.zeros_like(sims)
    for i in range(len(sims)):
        lpeak = sims[: i + 1].max()
        rpeak = sims[i:].max()
        depth[i] = (lpeak - sims[i]) + (rpeak - sims[i])
        if blocks[i + 1].speaker_change:
            depth[i] += 0.05  # speaker turns are natural boundaries

    min_len = max(45.0, duration / (target * 3))
    chosen: list[int] = []
    for gap_idx in np.argsort(-depth):
        cut = int(gap_idx) + 1  # boundary before block `cut`
        t = blocks[cut].start
        bounds = [0.0] + sorted(blocks[c].start for c in chosen) + [duration]
        if t - max(b for b in bounds if b <= t) < min_len or min(b for b in bounds if b >= t) - t < min_len:
            continue
        chosen.append(cut)
        if len(chosen) >= target - 1:
            break

    cuts = [0] + sorted(chosen) + [n]
    return [_make_segment(i, blocks[cuts[i] : cuts[i + 1]]) for i in range(len(cuts) - 1)]


def _unit(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v)
    return v / norm if norm else v


def _make_segment(i: int, members: list[TranscriptEntry]) -> Segment:
    return Segment(
        id=f"s{i + 1}",
        start=members[0].start,
        end=members[-1].end,
        text=" ".join(b.text for b in members),
        blocks=members,
        speakers=1 + sum(1 for b in members[1:] if b.speaker_change),
    )


# ---------------------------------------------------------------------------
def _label_topics(segments: list[Segment]) -> None:
    """LDA dominant topic + c-TF-IDF keywords for each segment."""
    from sklearn.feature_extraction.text import CountVectorizer

    docs = [s.text for s in segments]
    stops = set(stop_words())
    try:
        cv = CountVectorizer(analyzer=lambda doc: [p for p in candidate_phrases(doc, stops, max_n=2) if len(p) > 2], min_df=1)
        counts = cv.fit_transform(docs)
    except ValueError:
        return
    vocab = np.array(cv.get_feature_names_out())

    # --- c-TF-IDF (BERTopic): tf within class * log(1 + avg words per class / term frequency across classes)
    tf = counts.toarray().astype(float)
    avg_words = tf.sum() / max(len(docs), 1)
    term_freq = tf.sum(axis=0)
    idf = np.log(1 + avg_words / np.maximum(term_freq, 1))
    ctfidf = (tf / np.maximum(tf.sum(axis=1, keepdims=True), 1)) * idf
    for seg, row in zip(segments, ctfidf):
        top = [vocab[j] for j in np.argsort(-row)[:12] if row[j] > 0]
        seg.keywords = _prefer_phrases(top)[:6]
        if not seg.title:
            seg.title = _title_from_keywords(seg.keywords) or f"Part {seg.id[1:]}"

    # --- LDA dominant topic
    if len(segments) >= 3 and counts.shape[1] >= 5:
        from sklearn.decomposition import LatentDirichletAllocation

        n_topics = max(2, min(len(segments) // 2 + 1, 8))
        lda = LatentDirichletAllocation(n_components=n_topics, random_state=42, learning_method="batch", max_iter=25)
        dist = lda.fit_transform(counts)
        for seg, row in zip(segments, dist):
            seg.topic = int(np.argmax(row))


def _title_from_keywords(keywords: list[str]) -> str:
    """'entanglement' + 'quantum teleportation' -> 'Entanglement & Quantum Teleportation'."""
    if not keywords:
        return ""
    first = keywords[0]
    second = next((k for k in keywords[1:] if not set(k.split()) & set(first.split())), None)
    return smart_title(f"{first} & {second}" if second else first)


def _prefer_phrases(terms: list[str]) -> list[str]:
    """Drop unigrams already covered by a selected bigram ("neural" when "neural network" exists)."""
    phrases = [t for t in terms if " " in t]
    covered = {w for p in phrases for w in p.split()}
    merged = phrases + [t for t in terms if " " not in t and t not in covered]
    order = {t: i for i, t in enumerate(terms)}
    return dedupe_keep_order(sorted(merged, key=lambda t: order[t]))


def _cluster_themes(segments: list[Segment]) -> None:
    if len(segments) < 4:
        for s in segments:
            s.theme = 0
        return
    from sklearn.cluster import AgglomerativeClustering

    texts = [s.text for s in segments]
    vecs = embed([f"{s.title}. {' '.join(s.keywords)}. {s.text[:1500]}" for s in segments], corpus=texts)
    n_themes = max(2, min(len(segments) // 2, 5))
    labels = AgglomerativeClustering(n_clusters=n_themes, metric="cosine", linkage="average").fit_predict(vecs)
    for s, label in zip(segments, labels):
        s.theme = int(label)

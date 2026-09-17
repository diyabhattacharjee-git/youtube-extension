"""
Layer 3 — Key Concept Extraction.

Goal: real concepts, not raw captions.

1. Candidate phrases
   * spaCy noun chunks + named entities when `en_core_web_sm` is installed,
   * otherwise 1–3-gram TF-IDF features filtered by stop-word rules.
2. TF-IDF weighting across segments (a concept that is specific to one
   segment scores higher than one said everywhere).
3. Semantic grouping: near-duplicate phrases ("neural net", "neural networks")
   are merged by agglomerative clustering on (BERT or LSA) embeddings.
4. Knowledge graph (networkx): nodes = concepts, edges = co-occurrence inside
   the same transcript block + semantic similarity. PageRank gives global
   importance, greedy modularity gives concept communities, and simple lexical
   patterns ("X is a Y", "X uses Y") give edges a relation label.

Output: `ConceptGraph` with concept nodes and labelled, weighted edges.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from itertools import combinations

import networkx as nx
import numpy as np

from ..config import has_module
from .embeddings import cosine_matrix, embed
from .segmentation import Segment, stop_words
from .text_utils import FILLER_WORDS, candidate_phrases, smart_title, split_sentences

log = logging.getLogger("tubemind.concepts")


@dataclass
class Concept:
    id: str
    label: str
    score: float
    aliases: list[str] = field(default_factory=list)
    segments: list[str] = field(default_factory=list)
    first_ts: float = 0.0
    mentions: list[float] = field(default_factory=list)
    community: int = 0
    centrality: float = 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "score": round(self.score, 4),
            "aliases": self.aliases,
            "segments": self.segments,
            "firstTs": self.first_ts,
            "community": self.community,
            "centrality": round(self.centrality, 4),
        }


@dataclass
class ConceptGraph:
    concepts: list[Concept]
    edges: list[dict]

    def for_segment(self, seg_id: str, limit: int = 8) -> list[Concept]:
        items = [c for c in self.concepts if seg_id in c.segments]
        return sorted(items, key=lambda c: -(c.score + c.centrality))[:limit]

    def to_dict(self) -> dict:
        return {"concepts": [c.to_dict() for c in self.concepts], "edges": self.edges}


RELATION_PATTERNS = [
    (r"{a}\s+(?:is|are)\s+(?:a|an|the)?\s*(?:type|kind|form|example)\s+of\s+{b}", "is a type of"),
    (r"{a}\s+(?:is|are)\s+(?:a|an)\s+{b}", "is a"),
    (r"{a}\s+(?:uses?|relies on|depends on|requires?)\s+(?:the\s+)?{b}", "uses"),
    (r"{a}\s+(?:causes?|leads? to|results? in|produces?)\s+(?:the\s+)?{b}", "leads to"),
    (r"{a}\s+(?:contains?|includes?|consists? of|has|have)\s+(?:the\s+)?{b}", "contains"),
    (r"{a}\s+(?:vs\.?|versus|compared to|unlike)\s+(?:the\s+)?{b}", "contrasts with"),
    (r"{a}\s+(?:improves?|increases?|boosts?|enables?)\s+(?:the\s+)?{b}", "enables"),
    (r"{a}\s+(?:reduces?|decreases?|prevents?|limits?)\s+(?:the\s+)?{b}", "reduces"),
]


@lru_cache(maxsize=1)
def _spacy():
    if not has_module("spacy"):
        return None
    try:
        import spacy

        return spacy.load("en_core_web_sm", disable=["lemmatizer"])
    except Exception:  # noqa: BLE001 - model not downloaded
        return None


def _valid_phrase(phrase: str, stops: set[str]) -> bool:
    words = phrase.split()
    if not words or len(words) > 4:
        return False
    if words[0] in stops or words[-1] in stops:
        return False
    if all(w in FILLER_WORDS or w in stops for w in words):
        return False
    if len(phrase) < 3 or phrase.isdigit():
        return False
    return len(set(words)) == len(words)  # "data data" style caption stutter


def extract_concepts(segments: list[Segment], max_concepts: int = 60) -> ConceptGraph:
    if not segments:
        return ConceptGraph([], [])
    from sklearn.feature_extraction.text import TfidfVectorizer

    stops = set(stop_words())
    docs = [s.text for s in segments]

    # ---- 1+2. candidates weighted by TF-IDF --------------------------------
    vectorizer = TfidfVectorizer(
        # clause-bounded noun-phrase-like n-grams (inner "of" allowed: "theory of mind")
        analyzer=lambda doc: candidate_phrases(doc, stops),
        sublinear_tf=True,
        min_df=1,
        max_df=0.95 if len(docs) > 3 else 1.0,
    )
    try:
        tfidf = vectorizer.fit_transform(docs)
    except ValueError:
        return ConceptGraph([], [])
    vocab = vectorizer.get_feature_names_out()

    allowed: set[str] | None = None
    nlp = _spacy()
    if nlp is not None:
        allowed = set()
        for doc in nlp.pipe((d[:100_000] for d in docs), batch_size=4):
            for chunk in doc.noun_chunks:
                toks = [t.text.lower() for t in chunk if not t.is_stop and t.is_alpha]
                if toks:
                    allowed.add(" ".join(toks))
            for ent in doc.ents:
                if ent.label_ not in {"CARDINAL", "ORDINAL", "DATE", "TIME", "PERCENT", "QUANTITY", "MONEY"}:
                    allowed.add(ent.text.lower())

    col_scores = np.asarray(tfidf.max(axis=0).todense()).ravel()
    per_segment_hits = (tfidf > 0).toarray()
    candidates: list[tuple[str, float, list[int]]] = []
    for j in np.argsort(-col_scores):
        phrase = vocab[j]
        if not _valid_phrase(phrase, stops):
            continue
        if allowed is not None and phrase not in allowed and not any(phrase in a for a in allowed):
            continue
        # multi-word phrases are more "concept-like" than single words
        boost = 1.0 + 0.2 * (len(phrase.split()) - 1)
        segs = list(np.nonzero(per_segment_hits[:, j])[0])
        candidates.append((phrase, float(col_scores[j]) * boost, segs))
        if len(candidates) >= max_concepts * 3:
            break
    if not candidates:
        return ConceptGraph([], [])

    # ---- 3. semantic grouping of near-duplicates ---------------------------
    phrases = [c[0] for c in candidates]
    vecs = embed(phrases, corpus=docs)
    groups = _group_similar(phrases, vecs)

    concepts: list[Concept] = []
    for members in groups:
        members.sort(key=lambda i: -candidates[i][1])
        head = candidates[members[0]]
        seg_idx = sorted({s for i in members for s in candidates[i][2]})
        concepts.append(
            Concept(
                id=f"c{len(concepts) + 1}",
                label=smart_title(head[0]),
                score=sum(candidates[i][1] for i in members),
                aliases=[candidates[i][0] for i in members],
                segments=[segments[s].id for s in seg_idx],
            )
        )
    concepts.sort(key=lambda c: -c.score)
    concepts = concepts[:max_concepts]
    for i, c in enumerate(concepts):
        c.id = f"c{i + 1}"

    _locate_mentions(concepts, segments)
    edges = _build_graph(concepts, segments)
    return ConceptGraph(concepts, edges)


def _group_similar(phrases: list[str], vecs: np.ndarray, threshold: float = 0.82) -> list[list[int]]:
    """Union-find over pairs that are semantically or lexically near-identical."""
    parent = list(range(len(phrases)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    sims = cosine_matrix(vecs) if len(phrases) > 1 else np.ones((1, 1))
    stems = [re.sub(r"(ies|es|s|ing|ed)\b", "", p) for p in phrases]
    for i, j in combinations(range(len(phrases)), 2):
        same_stem = stems[i] == stems[j]
        contained = (phrases[i] in phrases[j] or phrases[j] in phrases[i]) and sims[i, j] > threshold - 0.1
        if same_stem or contained or sims[i, j] >= threshold:
            parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(phrases)):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def _locate_mentions(concepts: list[Concept], segments: list[Segment]) -> None:
    for c in concepts:
        pats = [re.compile(r"\b" + re.escape(a) + r"\b", re.I) for a in c.aliases[:5]]
        for seg in segments:
            for block in seg.blocks:
                if any(p.search(block.text) for p in pats):
                    c.mentions.append(block.start)
        c.mentions.sort()
        c.first_ts = c.mentions[0] if c.mentions else 0.0


def _build_graph(concepts: list[Concept], segments: list[Segment]) -> list[dict]:
    graph = nx.Graph()
    for c in concepts:
        graph.add_node(c.id)

    pats = {c.id: [re.compile(r"\b" + re.escape(a) + r"\b", re.I) for a in c.aliases[:5]] for c in concepts}
    sentences: list[str] = []
    for seg in segments:
        for block in seg.blocks:
            present = [cid for cid, ps in pats.items() if any(p.search(block.text) for p in ps)]
            for a, b in combinations(present, 2):
                w = graph.get_edge_data(a, b, {}).get("weight", 0.0)
                graph.add_edge(a, b, weight=w + 1.0)
            sentences.extend(split_sentences(block.text))

    # semantic similarity edges connect concepts that are never said together
    if len(concepts) > 1:
        vecs = embed([c.label for c in concepts], corpus=[s.text for s in segments])
        sims = cosine_matrix(vecs)
        for i, j in combinations(range(len(concepts)), 2):
            if 0.55 <= sims[i, j] < 0.82:
                a, b = concepts[i].id, concepts[j].id
                w = graph.get_edge_data(a, b, {}).get("weight", 0.0)
                graph.add_edge(a, b, weight=w + float(sims[i, j]))

    if graph.number_of_edges():
        pr = nx.pagerank(graph, weight="weight")
        communities = nx.algorithms.community.greedy_modularity_communities(graph, weight="weight")
        for idx, comm in enumerate(communities):
            for cid in comm:
                next(c for c in concepts if c.id == cid).community = idx
        for c in concepts:
            c.centrality = pr.get(c.id, 0.0)

    by_id = {c.id: c for c in concepts}
    edges = []
    for a, b, data in sorted(graph.edges(data=True), key=lambda e: -e[2]["weight"])[: len(concepts) * 2]:
        label, reverse = _relation_label(by_id[a], by_id[b], sentences)
        if reverse:
            a, b = b, a
        edges.append({"source": a, "target": b, "weight": round(data["weight"], 3), "label": label})
    return edges


def _relation_label(a: Concept, b: Concept, sentences: list[str]) -> tuple[str, bool]:
    """Return (label, reversed) — reversed means the relation reads "b <label> a"."""
    alias_a = "|".join(re.escape(x) for x in a.aliases[:3])
    alias_b = "|".join(re.escape(x) for x in b.aliases[:3])
    for sent in sentences:
        low = sent.lower()
        if not (re.search(alias_a, low) and re.search(alias_b, low)):
            continue
        for tpl, label in RELATION_PATTERNS:
            if re.search(tpl.format(a=f"(?:{alias_a})", b=f"(?:{alias_b})"), low):
                return label, False
            if re.search(tpl.format(a=f"(?:{alias_b})", b=f"(?:{alias_a})"), low):
                return label, True
    return "related to", False

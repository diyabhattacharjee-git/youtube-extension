"""
Sentence embeddings used by segmentation, concept grouping, semantic search and merging.

* With `sentence-transformers` installed -> real BERT embeddings (all-MiniLM-L6-v2 by default).
* Without it -> TF-IDF + truncated SVD (LSA), a surprisingly good lightweight substitute.

Every vector returned is L2-normalised, so cosine similarity == dot product.
"""
from __future__ import annotations

import logging
import threading
from functools import lru_cache

import numpy as np

from ..config import has_module, settings

log = logging.getLogger("tubemind.embeddings")
_lock = threading.Lock()


@lru_cache(maxsize=1)
def _bert_model():
    from sentence_transformers import SentenceTransformer

    log.info("Loading embedding model %s", settings.embedding_model)
    return SentenceTransformer(settings.embedding_model)


def backend_name() -> str:
    return f"bert:{settings.embedding_model}" if has_module("sentence_transformers") else "tfidf-lsa"


def _normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


def _bert_encode(texts: list[str]) -> np.ndarray | None:
    if not has_module("sentence_transformers"):
        return None
    try:
        with _lock:
            vecs = _bert_model().encode(texts, batch_size=32, show_progress_bar=False, normalize_embeddings=True)
        return np.asarray(vecs, dtype=np.float32)
    except Exception as exc:  # noqa: BLE001 - fall back to LSA on any model problem
        log.warning("BERT embeddings failed (%s); falling back to TF-IDF/LSA", exc)
        return None


class Embedder:
    """
    Encoder whose vectors are comparable across calls.

    BERT is stateless; the LSA fallback is fitted ONCE on `corpus`, so a query
    embedded later lives in the same space as the documents embedded earlier.
    """

    def __init__(self, corpus: list[str]):
        self._vectorizer = None
        self._svd = None
        self._use_bert = has_module("sentence_transformers")
        if not self._use_bert:
            self._fit_lsa(corpus)

    def _fit_lsa(self, corpus: list[str]) -> None:
        from sklearn.decomposition import TruncatedSVD
        from sklearn.feature_extraction.text import TfidfVectorizer

        docs = [d for d in corpus if d and d.strip()] or ["empty"]
        self._vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True, min_df=1)
        try:
            mat = self._vectorizer.fit_transform(docs)
        except ValueError:  # empty vocabulary (only stop words)
            self._vectorizer = TfidfVectorizer(ngram_range=(1, 1), min_df=1, token_pattern=r"(?u)\b\w+\b")
            mat = self._vectorizer.fit_transform(docs + ["placeholder"])
        n_components = min(128, mat.shape[1] - 1, len(docs) - 1)
        if n_components >= 2:
            self._svd = TruncatedSVD(n_components=n_components, random_state=42).fit(mat)

    def encode(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 1), dtype=np.float32)
        if self._use_bert:
            vecs = _bert_encode(texts)
            if vecs is not None:
                return vecs
            self._use_bert = False
            self._fit_lsa(texts)
        mat = self._vectorizer.transform(texts)
        dense = self._svd.transform(mat) if self._svd is not None else mat.toarray()
        return _normalize(np.asarray(dense, dtype=np.float32))


def embed(texts: list[str], corpus: list[str] | None = None) -> np.ndarray:
    """
    One-shot embedding of `texts` (all vectors from the same call are comparable).
    `corpus` lets the LSA fallback learn its vocabulary from more text than the items.
    """
    if not texts:
        return np.zeros((0, 1), dtype=np.float32)
    return Embedder(list(corpus or []) + list(texts)).encode(texts)


def cosine_matrix(a: np.ndarray, b: np.ndarray | None = None) -> np.ndarray:
    b = a if b is None else b
    if a.size == 0 or b.size == 0:
        return np.zeros((len(a), len(b)))
    return np.clip(a @ b.T, -1.0, 1.0)

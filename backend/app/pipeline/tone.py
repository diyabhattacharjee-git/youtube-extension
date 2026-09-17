"""
Emotion & tone detection.

A transparent lexicon scorer tags each segment with tones such as
`enthusiastic`, `critical`, `controversial`, `cautionary`, `humorous`,
`instructional`. When an LLM is available its tone judgement is merged in by
the builder; this module guarantees tags exist even fully offline.
"""
from __future__ import annotations

import re

from .text_utils import tokenize

LEXICON: dict[str, set[str]] = {
    "enthusiastic": {
        "amazing", "awesome", "incredible", "exciting", "excited", "love", "fantastic", "beautiful",
        "brilliant", "wonderful", "powerful", "cool", "impressive", "favorite", "favourite", "wow",
        "remarkable", "elegant", "mind-blowing", "breakthrough",
    },
    "critical": {
        "problem", "problems", "wrong", "bad", "fail", "fails", "failure", "flaw", "flawed", "mistake",
        "mistakes", "issue", "issues", "limitation", "limitations", "weakness", "poor", "worse", "worst",
        "broken", "misleading", "overrated", "downside", "drawback",
    },
    "controversial": {
        "controversial", "debate", "debated", "disagree", "argue", "argument", "myth", "myths", "claim",
        "claims", "skeptic", "skeptics", "critics", "contested", "polarizing", "conspiracy", "unpopular",
        "hot", "take", "opinion", "biased",
    },
    "cautionary": {
        "careful", "warning", "warn", "risk", "risks", "danger", "dangerous", "avoid", "beware",
        "caution", "never", "pitfall", "pitfalls", "trap", "harmful", "unsafe",
    },
    "humorous": {"funny", "joke", "jokes", "hilarious", "laugh", "lol", "haha", "silly", "ridiculous"},
    "instructional": {
        "step", "steps", "first", "next", "then", "finally", "how", "example", "formula", "define",
        "definition", "procedure", "method", "exercise", "practice", "tutorial",
    },
}

THRESHOLDS = {  # hits per 1,000 tokens needed to earn a tag
    "enthusiastic": 6.0,
    "critical": 6.0,
    "controversial": 3.0,
    "cautionary": 4.0,
    "humorous": 3.0,
    "instructional": 14.0,
}


def detect_tone(text: str, max_tags: int = 2) -> list[dict]:
    tokens = tokenize(text)
    if not tokens:
        return []
    per_k = 1000.0 / len(tokens)
    scores = {}
    for tone, words in LEXICON.items():
        hits = sum(1 for t in tokens if t in words)
        if tone == "enthusiastic":
            hits += 0.5 * len(re.findall(r"!", text))
        scores[tone] = hits * per_k
    tags = [
        {"tone": tone, "score": round(score / THRESHOLDS[tone], 2)}
        for tone, score in scores.items()
        if score >= THRESHOLDS[tone]
    ]
    tags.sort(key=lambda t: -t["score"])
    return tags[:max_tags]


def merge_tone(lexicon_tags: list[dict], llm_tags: list[str] | None) -> list[str]:
    valid = set(LEXICON) | {"neutral", "inspirational", "analytical", "skeptical", "optimistic"}
    out = [t.lower() for t in (llm_tags or []) if isinstance(t, str) and t.lower() in valid and t.lower() != "neutral"]
    for tag in lexicon_tags:
        if tag["tone"] not in out:
            out.append(tag["tone"])
    return out[:3]

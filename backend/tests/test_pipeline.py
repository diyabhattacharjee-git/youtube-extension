"""
Offline pipeline test (no network, no LLM): synthetic lecture transcript -> mindmap.

    cd backend && python -m pytest -q      (or: python -m tests.test_pipeline)
"""
from __future__ import annotations

import copy

from app.collab.ops import apply_op
from app.features.merge import link_videos, merge_maps
from app.features.search import semantic_search
from app.features.study import generate_study_set
from app.pipeline.builder import generate_mindmap
from app.pipeline.text_utils import extract_json, parse_description_chapters

LECTURE = [
    # (topic, sentences) — an original, made-up lecture about quantum computing
    ("intro", [
        "Welcome to this lecture on quantum computing and why it matters.",
        "Classical computers store information in bits that are either zero or one.",
        "Quantum computers store information in qubits instead of classical bits.",
        "A qubit is the fundamental unit of quantum information.",
    ]),
    ("superposition", [
        "Superposition means a qubit can be in a combination of zero and one at the same time.",
        "When we measure a qubit in superposition the state collapses to a single value.",
        "Superposition lets quantum algorithms explore many possibilities in parallel.",
        "The amplitude of each state determines the measurement probability.",
    ]),
    ("entanglement", [
        "Entanglement links qubits so that measuring one instantly tells you about the other.",
        "Entangled qubits share a joint quantum state that cannot be described separately.",
        "Entanglement is a key resource for quantum teleportation and quantum cryptography.",
        "Einstein famously called entanglement spooky action at a distance, and it is still debated.",
    ]),
    ("algorithms", [
        "Shor's algorithm factors large numbers exponentially faster than classical algorithms.",
        "This is a problem for RSA encryption, which relies on factoring being hard.",
        "Grover's algorithm searches an unsorted database with a quadratic speedup.",
        "Quantum algorithms use interference to amplify correct answers.",
    ]),
    ("hardware", [
        "Building quantum hardware is incredibly hard because qubits are fragile.",
        "Decoherence destroys quantum states when qubits interact with their environment.",
        "Superconducting qubits must be cooled to near absolute zero in dilution refrigerators.",
        "Quantum error correction uses many physical qubits to protect one logical qubit.",
    ]),
]


def synthetic_transcript(repeats: int = 4) -> list[dict]:
    entries, t = [], 0.0
    for _topic, sentences in LECTURE:
        for _ in range(repeats):
            for s in sentences:
                entries.append({"start": t, "duration": 6.0, "text": s})
                t += 6.0
    return entries


def build(mode: str = "academic") -> dict:
    return generate_mindmap({"videoId": "TESTVIDEO01", "title": "Quantum Computing Explained | Lecture 1", "transcript": synthetic_transcript(), "mode": mode, "useLLM": False, "allowWhisper": False})


def test_pipeline_builds_layers():
    mm = build()
    root = mm["root"]
    assert root["type"] == "root" and root["layer"] == 0
    assert len(root["children"]) >= 2, "segmentation should find several sections"
    types = set()

    def walk(n):
        types.add(n["type"])
        if n["type"] != "root":
            assert n["start"] is not None, f"node without timestamp: {n['text']}"
        for c in n["children"]:
            walk(c)

    walk(root)
    assert {"section", "concept", "transcript"} <= types
    assert mm["graph"]["concepts"], "concepts should be extracted"


def test_chapters_are_respected():
    chapters = parse_description_chapters("0:00 Intro\n1:36 Superposition\n3:12 Entanglement\n4:48 Algorithms\n6:24 Hardware", 480)
    assert len(chapters) == 5
    mm = generate_mindmap({"videoId": "TESTVIDEO01", "title": "Quantum", "transcript": synthetic_transcript(), "chapters": chapters, "useLLM": False, "allowWhisper": False})
    assert [s["text"] for s in mm["root"]["children"]][:2] == ["Intro", "Superposition"]


def test_features():
    mm = build("revision")
    assert semantic_search(mm, "entangled qubits")
    study = generate_study_set(mm, count=5)
    assert study["flashcards"]

    other = copy.deepcopy(mm)
    other["id"] = "other"
    other["meta"]["videoId"] = "OTHERVIDEO1"
    merged = merge_maps([mm, other])
    assert len(merged["root"]["children"]) == len(mm["root"]["children"]), "identical maps merge without duplicates"
    assert link_videos([mm, other])["links"]


def test_ops_roundtrip():
    mm = build("revision")
    section = mm["root"]["children"][0]
    new = {"id": "n-test", "text": "My note", "type": "concept", "layer": 2, "children": []}
    assert apply_op(mm, {"type": "add", "parentId": section["id"], "index": 0, "node": new})
    assert apply_op(mm, {"type": "update", "id": "n-test", "patch": {"notes": "hello", "id": "hack"}})
    assert section["children"][0]["notes"] == "hello" and section["children"][0]["id"] == "n-test"
    assert apply_op(mm, {"type": "move", "id": "n-test", "parentId": mm["root"]["children"][1]["id"], "index": 0})
    assert not apply_op(mm, {"type": "move", "id": mm["root"]["children"][1]["id"], "parentId": "n-test"}), "cannot move into own subtree"
    assert apply_op(mm, {"type": "remove", "id": "n-test"})


def test_extract_json():
    assert extract_json('Sure! ```json\n{"a": [1, 2]}\n```') == {"a": [1, 2]}
    assert extract_json('text {"b": "x}"} trailing') == {"b": "x}"}


if __name__ == "__main__":
    import json

    result = build()
    for sec in result["root"]["children"]:
        print("•", sec["text"], sec["start"], sec["tone"])
        for c in sec["children"]:
            print("   -", c["text"], c["start"])
    print(json.dumps(result["meta"], indent=2))

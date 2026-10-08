"""
Select-then-label, caching and the skeleton-first API — all offline (the LLM is a mock transport).

    cd backend && python -m pytest -q
"""
from __future__ import annotations

import json

import httpx
import pytest

from app import jobs as jobs_module
from app.features.chat import chat_stream
from app.jobs import cache_key
from app.pipeline import labels, llm
from app.pipeline.builder import build_skeleton

from test_pipeline import synthetic_transcript


def skeleton() -> dict:
    return build_skeleton({"videoId": "TESTVIDEO01", "title": "Quantum Computing Explained", "transcript": synthetic_transcript(), "mode": "academic", "useLLM": False, "allowWhisper": False})


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    """Keep test writes out of backend/data and start every test with a cold cache."""
    monkeypatch.setattr(jobs_module, "_path", lambda key: tmp_path / f"{key}.json")
    monkeypatch.setattr(labels, "_cache_path", lambda key: tmp_path / f"label-{key}.json")
    monkeypatch.setattr(llm, "_cooldown_until", 0.0)
    jobs_module._memory.clear()


def fake_llm(monkeypatch, handler):
    """Route the single-shot LLM call through `handler(request) -> httpx.Response`."""
    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(llm, "client", lambda: client)
    monkeypatch.setattr(llm, "fast_provider", lambda: ("https://llm.test/v1/chat/completions", "k", "test-model"))
    monkeypatch.setattr(llm, "fast_available", lambda: True)


def sse(text: str) -> httpx.Response:
    chunks = [{"choices": [{"delta": {"content": line + "\n"}}]} for line in text.splitlines()]
    chunks.append({"choices": [], "x_groq": {"usage": {"prompt_tokens": 1234, "completion_tokens": 99}}})
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
def test_parser_reads_all_line_kinds():
    parsed = labels.parse_labels(
        "R|Quantum Computing\n"
        "S|s1|Qubits and Bits\n"
        "C|c1|Qubit: basic unit of quantum information\n"
        "X|c1>c4|enables\n"
    )
    assert parsed.root == "Quantum Computing"
    assert parsed.sections == {"s1": "Qubits and Bits"}
    assert parsed.concepts == {"c1": "Qubit: basic unit of quantum information"}
    assert parsed.links == [("c1", "c4", "enables")]
    assert parsed.malformed == 0


def test_parser_tolerates_formatting_noise():
    parsed = labels.parse_labels(
        "Sure! Here are the labels:\n"          # chatter -> malformed, ignored
        "```\n"
        "- **R** | Quantum Computing.\n"         # bullet, bold, trailing period
        "1. S | S2 | Superposition [1:23]\n"     # numbering, uppercase id, timestamp stripped
        "c2|Entanglement|linked qubit states\n"  # missing C prefix, extra pipe instead of ':'
        "X|c2 -> c5|leads to\n"
        "```\n"
    )
    assert parsed.root == "Quantum Computing"
    assert parsed.sections == {"s2": "Superposition"}
    assert parsed.concepts == {"c2": "Entanglement: linked qubit states"}
    assert parsed.links == [("c2", "c5", "leads to")]
    assert parsed.malformed == 1


def test_parser_rejects_malformed_lines_without_raising():
    parsed = labels.parse_labels(
        "C|c1|\n"                                   # empty label
        "C|x9|Something\n"                          # bad id
        "S|c1|Wrong kind of id\n"                   # concept id on an S line
        "C|c2|The speaker mentions qubits\n"        # meta phrase
        "C|c3|" + "very long label " * 20 + "\n"    # too long
        "X|c1|no target\n"                          # malformed link
        "totally unrelated text\n"
        "C|c4|Decoherence: loss of quantum state\n"
        "C|c4|Duplicate wins nothing\n"             # first answer wins
    )
    assert parsed.concepts == {"c4": "Decoherence: loss of quantum state"}
    assert parsed.root is None and not parsed.sections and not parsed.links
    assert parsed.malformed == 7
    assert labels.parse_labels("").malformed == 0
    assert labels.parse_labels(None).concepts == {}


# ---------------------------------------------------------------------------
# Label call: one call, heuristic fallback, cache
# ---------------------------------------------------------------------------
def test_single_call_relabels_and_keeps_heuristics_for_missing_lines(monkeypatch):
    mm = skeleton()
    cands = labels.collect(mm)
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return sse("R|Quantum Computing Basics\nS|s1|Bits vs Qubits\nC|c1|Qubit: unit of quantum information\ngarbled ~~~ line\nX|c1>c4|enables")

    fake_llm(monkeypatch, handler)
    before = {c.cid: c.node["text"] for s in cands for c in s.concepts}
    outcome = labels.label_map(mm)

    assert len(calls) == 1, "exactly one LLM call per map"
    assert outcome["stats"]["calls"] == 1 and outcome["stats"]["prompt_tokens"] == 1234
    body = calls[0]
    assert body["stream"] is True and body["max_tokens"] <= 1100 and body["temperature"] == 0.2
    prompt = body["messages"][1]["content"]
    assert "c1 s1" in prompt and "Sections:" in prompt and '"' in prompt  # candidate list with source sentences

    updates = {op["id"]: op["patch"] for op in outcome["ops"] if op["type"] == "update"}
    assert updates[mm["root"]["id"]]["text"] == "Quantum Computing Basics"
    first_concept = cands[0].concepts[0].node
    assert updates[first_concept["id"]]["text"] == "Qubit: unit of quantum information"
    # concepts without an answer line keep their heuristic label (no op)
    for s in cands:
        for c in s.concepts[1:]:
            assert c.node["id"] not in updates and c.node["text"] == before[c.cid]
    assert outcome["stats"]["malformed"] == 1

    labels.apply_outcome(mm, outcome)
    assert mm["root"]["text"] == "Quantum Computing Basics" and mm["meta"]["labelled"]
    # LLM never touches timestamps / transcript leaves
    assert all(n.get("start") is not None for s in mm["root"]["children"] for n in s["children"])


def test_second_run_hits_the_label_cache(monkeypatch):
    calls = []

    def handler(request):
        calls.append(1)
        return sse("R|Quantum Computing Basics\n" + "\n".join(f"S|s{i}|Part {i} Title" for i in range(1, 8)))

    fake_llm(monkeypatch, handler)
    labels.label_map(skeleton())
    first = len(calls)
    again = labels.label_map(skeleton())
    assert first == 1 and len(calls) == 1, "re-run must cost 0 LLM calls"
    assert again["stats"]["calls"] == 0 and again["stats"]["cached_sections"] > 0
    assert any(op["patch"].get("text") == "Quantum Computing Basics" for op in again["ops"] if op["type"] == "update")


@pytest.mark.parametrize("failure", ["429", "timeout", "500"])
def test_llm_failure_still_produces_a_complete_map(monkeypatch, failure):
    def handler(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(429 if failure == "429" else 500, json={"error": {"message": "rate limited"}})

    fake_llm(monkeypatch, handler)
    mm = skeleton()
    texts = [n["text"] for s in mm["root"]["children"] for n in [s, *s["children"]]]
    outcome = labels.label_map(mm)
    assert outcome["ops"] == [] and outcome["stats"]["calls"] == 1 and outcome["stats"]["errors"]
    assert not outcome["meta"]["labelled"]
    labels.apply_outcome(mm, outcome)
    assert [n["text"] for s in mm["root"]["children"] for n in [s, *s["children"]]] == texts
    assert len(mm["root"]["children"]) >= 2


def test_after_a_429_the_next_map_costs_zero_calls(monkeypatch):
    hits = []

    def handler(request):
        hits.append(1)
        return httpx.Response(429, headers={"retry-after": "30"}, json={"error": {"message": "slow down"}})

    fake_llm(monkeypatch, handler)
    assert labels.label_map(skeleton())["stats"]["calls"] == 1
    again = labels.label_map(skeleton())
    assert len(hits) == 1 and again["stats"]["calls"] == 0 and again["ops"] == []


def test_no_llm_means_zero_calls(monkeypatch):
    monkeypatch.setattr(llm, "fast_available", lambda: False)
    outcome = labels.label_map(skeleton())
    assert outcome["stats"]["calls"] == 0 and outcome["ops"] == []


def test_large_input_is_split_into_at_most_three_chunks():
    sections = [labels.SectionCand(f"s{i}", {"text": f"S{i}", "start": i * 60, "end": i * 60 + 60, "keywords": []}) for i in range(1, 13)]
    n = 0
    for s in sections:
        for _ in range(12):
            n += 1
            s.concepts.append(labels.ConceptCand(f"c{n}", s.cid, {"text": f"Concept {n}", "start": 0, "source": "word " * 25}))
    chunks = labels.plan_chunks(sections, "Long video")
    assert 2 <= len(chunks) <= 3
    assert [s.cid for c in chunks for s in c] == [s.cid for s in sections]
    assert len(labels.plan_chunks(sections[:3], "Short video")) == 1


# ---------------------------------------------------------------------------
# Cache key, skeleton-first API, chat fallback
# ---------------------------------------------------------------------------
def test_cache_key_only_depends_on_video_and_mode():
    base = {"videoId": "abcdefghijk", "mode": "academic"}
    key = cache_key(base)
    for extra in ({"profile": "visual"}, {"useLLM": False}, {"frames": True}, {"theme": "chalk", "noCache": True}):
        assert cache_key({**base, **extra}) == key
    assert cache_key({**base, "mode": "deep"}) != key
    assert cache_key({**base, "videoId": "zzzzzzzzzzz"}) != key


def test_skeleton_first_api_and_cache_hit(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(llm, "fast_available", lambda: False)
    client = TestClient(app)
    body = {"videoId": "TESTVIDEO01", "title": "Quantum", "transcript": synthetic_transcript(), "useLLM": True, "allowWhisper": False}
    first = client.post("/api/jobs", json=body).json()
    assert first["map"]["root"]["children"] and first["pending"] is False and first["cached"] is False
    again = client.post("/api/jobs", json={**body, "profile": "visual"}).json()
    assert again["cached"] is True and again["map"]["id"] == first["map"]["id"]


def test_every_node_is_grounded_in_the_transcript():
    mm = skeleton()
    for sec in mm["root"]["children"]:
        for node in [sec, *sec["children"]]:
            assert node["start"] is not None and node["end"] is not None and node["end"] >= node["start"]
            assert node["source"], node["text"]
        for concept in sec["children"]:
            assert 0 <= concept["faith"] <= 1


def test_chat_offline_fallback_cites_transcript(monkeypatch):
    monkeypatch.setattr(llm, "fast_available", lambda: False)
    mm = skeleton()
    concept = mm["root"]["children"][1]["children"][0]
    events = [json.loads(line) for line in chat_stream(mm, concept["id"], "What does entanglement mean?")]
    assert events[0]["type"] == "sources" and 5 <= len(events[0]["sources"]) <= 8
    answer = "".join(e["text"] for e in events if e["type"] == "delta")
    assert "[" in answer and ":" in answer  # timestamp citations like [1:23]
    assert events[-1]["type"] == "done" and events[-1]["usage"]["calls"] == 0


# ---------------------------------------------------------------------------
# Revision sketchbook: structure, summary retriever, rewrite protocol
# ---------------------------------------------------------------------------
def test_sketchbook_structure_and_summary_retriever():
    from app.pipeline.builder import TAGS

    mm = skeleton()
    sections = [s for s in mm["root"]["children"] if not s.get("recall")]
    recall = mm["root"]["children"][-1]
    assert [s["start"] for s in sections] == sorted(s["start"] for s in sections), "sections in video order"
    for sec in sections:
        assert sec["end"] > sec["start"] and sec["summary"]
        assert 1 <= len(sec["points"]) <= 3 and all(p["start"] is not None and p["text"] for p in sec["points"])
        for concept in (c for c in sec["children"] if c["type"] == "concept"):
            assert ": " in concept["text"], "level 2 = 'Term: one-line meaning'"
            for item in (d for d in concept["children"] if d["type"] == "detail"):
                assert item["tag"] in TAGS and item["text"].startswith(f"{item['tag']}: ") and item["more"] is True
    assert recall.get("recall") and recall["text"] == "Quick recall"
    points = [c for c in recall["children"] if not c.get("oneline")]
    assert 3 <= len(points) <= 6 and recall["children"][0]["text"].startswith("In one line: ")
    assert mm["meta"]["timings"]["summary"] < 100, "summary retriever adds < 100 ms"


def test_parser_accepts_rewrite_and_type_tag_lines():
    parsed = labels.parse_labels(
        "M|Qubits use superposition and entanglement to beat classical computers on some problems\n"
        "S|s1|Bits vs Qubits|Why qubits hold more than classical bits\n"
        "S|s2||Fixed chapter, summary only\n"
        "D|d1|Eg|Grover search finds an item in a large database\n"
        "D|d2|Example|Teleportation uses entangled pairs\n"            # tag alias
        "D|d3|Watch out: decoherence ruins fragile qubits\n"           # tag written inside the text
        "D|c4|Def|Logical qubit: many physical qubits acting as one\n"  # addressed through its concept
        "C|c5|क्यूबिट: मूल इकाई\n"                                      # not English: rejected
    )
    assert parsed.summary.startswith("Qubits use superposition")
    assert parsed.sections == {"s1": "Bits vs Qubits"}
    assert parsed.section_summaries == {"s1": "Why qubits hold more than classical bits", "s2": "Fixed chapter, summary only"}
    assert parsed.details["d1"] == ("Eg", "Grover search finds an item in a large database")
    assert parsed.details["d2"] == ("Eg", "Teleportation uses entangled pairs")
    assert parsed.details["d3"] == ("Watch-out", "decoherence ruins fragile qubits")
    assert parsed.details["c4#Def"][0] == "Def"
    assert "c5" not in parsed.concepts and parsed.malformed == 1


def test_rewrite_patches_details_summaries_and_quick_recall(monkeypatch):
    mm = skeleton()
    cands = labels.collect(mm)
    detail = next(d for s in cands for d in s.details)
    recall = next(s for s in cands if s.recall)

    def handler(request):
        prompt = json.loads(request.content)["messages"][1]["content"]
        assert "Details:" in prompt and f"{detail.cid} {detail.concept} {detail.node['tag']}" in prompt
        return sse(
            "R|Quantum Computing\n"
            "M|Qubits, superposition and entanglement in one lecture\n"
            f"S|s1|Bits and Qubits|How qubits differ from bits\n"
            f"D|{detail.cid}|Tip|Remember: one qubit holds a mix of 0 and 1\n"
            f"C|{recall.concepts[0].cid}|Qubit: holds 0 and 1 at once\n"
        )

    fake_llm(monkeypatch, handler)
    outcome = labels.label_map(mm, timeout=3.0)  # roomy deadline: D lines fit
    labels.apply_outcome(mm, outcome)
    assert mm["root"]["summary"] == "Qubits, superposition and entanglement in one lecture"
    first = mm["root"]["children"][0]
    assert first["text"] == "Bits and Qubits" and first["summary"] == "How qubits differ from bits"
    assert detail.node["text"] == "Tip: one qubit holds a mix of 0 and 1" and detail.node["tag"] == "Tip"
    oneline = next(c for c in recall.node["children"] if c.get("oneline"))
    assert oneline["text"] == "In one line: Qubits, superposition and entanglement in one lecture"
    assert recall.node["text"] == "Quick recall", "the LLM never renames the fixed Quick recall title"
    assert all(n.get("start") is not None for s in mm["root"]["children"] for n in s["children"]), "timestamps untouched"


def test_duplicate_rewrites_keep_their_heuristic_label(monkeypatch):
    mm = skeleton()
    cands = labels.collect(mm)
    a, b = cands[0].concepts[0], cands[0].concepts[1]
    before = b.node["text"]
    fake_llm(monkeypatch, lambda request: sse(f"C|{a.cid}|Qubit: unit of quantum information\nC|{b.cid}|Qubit: unit of quantum information\n"))
    outcome = labels.label_map(mm)
    updates = {op["id"]: op["patch"] for op in outcome["ops"] if op["type"] == "update"}
    assert updates[a.node["id"]]["text"] == "Qubit: unit of quantum information"
    assert "text" not in updates.get(b.node["id"], {}) and b.node["text"] == before


def test_label_timeout_default_is_tight():
    from app.config import settings

    assert settings.label_timeout <= 1.2


def test_tight_deadline_drops_d_lines_and_caches_finished_sections(monkeypatch):
    mm = skeleton()
    cands = labels.collect(mm)
    first, second = [s for s in cands if not s.recall][:2]
    prompts = []

    def handler(request):
        prompts.append(json.loads(request.content)["messages"][1]["content"])
        lines = [f"S|{first.cid}|First Part|What comes first"] + [f"C|{c.cid}|Term{i}: meaning {i}" for i, c in enumerate(first.concepts)]
        body = "".join(f"data: {json.dumps({'choices': [{'delta': {'content': line + chr(10)}}]})}\n\n" for line in lines)
        return httpx.Response(200, text=body + 'data: {"choices": [{"delta": {"content": "C|' + second.concepts[0].cid + '|cut off mid"}}]}\n\n',
                              headers={"content-type": "text/event-stream"})  # stream ends without [DONE]: partial answer

    fake_llm(monkeypatch, handler)
    monkeypatch.setattr(llm, "complete", _partial(llm.complete))
    labels.label_map(mm)  # 1.2 s default deadline: the whole answer would not fit
    assert "Details:" not in prompts[0], "D lines are only requested when they fit the deadline"
    again = labels.label_map(skeleton())
    assert again["stats"]["cached_sections"] >= 1, "sections that fully arrived are cached"
    section_lines = [line.split(" ")[0] for line in prompts[1].split("Sections:")[1].split("Concepts:")[0].strip().splitlines()]
    assert first.cid not in section_lines and second.cid in section_lines, "only unfinished sections are asked again"


def _partial(complete):
    def wrapped(*args, **kwargs):
        result = complete(*args, **kwargs)
        result.partial, result.error = True, result.error or "deadline"
        return result
    return wrapped


def test_answer_cut_by_the_deadline_counts_as_labelled(monkeypatch):
    mm = skeleton()
    first = labels.collect(mm)[0]
    fake_llm(monkeypatch, lambda request: sse(f"R|Quantum Computing\nS|{first.cid}|Bits and Qubits|Why qubits differ"))
    monkeypatch.setattr(llm, "complete", _partial(llm.complete))
    outcome = labels.label_map(mm)
    assert outcome["stats"]["errors"] == ["deadline"] and outcome["meta"]["labelled"], "no re-call on every reopen"


def test_detailed_mode_shows_everything():
    mm = build_skeleton({"videoId": "TESTVIDEO01", "title": "Quantum", "transcript": __import__("test_pipeline").synthetic_transcript(), "mode": "deep", "useLLM": False, "allowWhisper": False})
    concepts = [c for s in mm["root"]["children"] for c in s["children"] if c["type"] == "concept"]
    details = [d for c in concepts for d in c["children"] if d["type"] == "detail"]
    assert details and not any(c["collapsed"] for c in concepts), "no concept is collapsed"
    assert not any(d.get("more") for d in details), "no lazy '+' placeholders"
    short = skeleton()  # Standard keeps level 3 behind "+N"
    assert any(c["collapsed"] for s in short["root"]["children"] for c in s["children"] if c["type"] == "concept")

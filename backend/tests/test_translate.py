"""
English-only maps: language detection, the load-once NLLB singleton, the translation cache,
timestamp mapping and the fallbacks — offline (a fake model stands in for NLLB-200).

    cd backend && python -m pytest -q
"""
from __future__ import annotations

import pytest

from app.pipeline import translate
from app.pipeline.builder import build_skeleton
from app.pipeline.transcript import Transcript, build_blocks, normalize_entries

from test_pipeline import LECTURE, synthetic_transcript

# The same made-up lecture, in Hindi (one sentence per caption line, like the English one).
HINDI = [
    "क्वांटम कंप्यूटिंग पर इस व्याख्यान में आपका स्वागत है और यह क्यों महत्वपूर्ण है।",
    "पारंपरिक कंप्यूटर जानकारी को बिट्स में संग्रहीत करते हैं जो या तो शून्य या एक होते हैं।",
    "क्वांटम कंप्यूटर पारंपरिक बिट्स के बजाय क्यूबिट्स में जानकारी संग्रहीत करते हैं।",
    "क्यूबिट क्वांटम जानकारी की मूल इकाई है।",
    "सुपरपोज़िशन का अर्थ है कि एक क्यूबिट एक ही समय में शून्य और एक के संयोजन में हो सकता है।",
    "जब हम सुपरपोज़िशन में किसी क्यूबिट को मापते हैं तो अवस्था एक ही मान में सिमट जाती है।",
    "सुपरपोज़िशन क्वांटम एल्गोरिदम को कई संभावनाओं को समानांतर में खोजने देता है।",
    "प्रत्येक अवस्था का आयाम मापन की संभावना निर्धारित करता है।",
    "एंटैंगलमेंट क्यूबिट्स को इस तरह जोड़ता है कि एक को मापने से दूसरे के बारे में तुरंत पता चल जाता है।",
    "उलझे हुए क्यूबिट्स एक साझा क्वांटम अवस्था रखते हैं जिसे अलग से वर्णित नहीं किया जा सकता।",
    "एंटैंगलमेंट क्वांटम टेलीपोर्टेशन और क्वांटम क्रिप्टोग्राफी के लिए एक प्रमुख संसाधन है।",
    "आइंस्टीन ने एंटैंगलमेंट को दूरी पर भूतिया क्रिया कहा था, और इस पर अब भी बहस होती है।",
    "शोर का एल्गोरिदम बड़ी संख्याओं के गुणनखंड पारंपरिक एल्गोरिदम से घातीय रूप से तेज़ करता है।",
    "यह आरएसए एन्क्रिप्शन के लिए एक समस्या है, जो गुणनखंडन के कठिन होने पर निर्भर करता है।",
    "ग्रोवर का एल्गोरिदम एक अव्यवस्थित डेटाबेस को द्विघात गति से खोजता है।",
    "क्वांटम एल्गोरिदम सही उत्तरों को बढ़ाने के लिए व्यतिकरण का उपयोग करते हैं।",
    "क्वांटम हार्डवेयर बनाना बेहद कठिन है क्योंकि क्यूबिट्स नाज़ुक होते हैं।",
    "डीकोहेरेंस क्वांटम अवस्थाओं को नष्ट कर देता है जब क्यूबिट्स अपने वातावरण से संपर्क करते हैं।",
    "सुपरकंडक्टिंग क्यूबिट्स को डाइल्यूशन रेफ्रिजरेटर में लगभग परम शून्य तक ठंडा करना पड़ता है।",
    "क्वांटम त्रुटि सुधार एक तार्किक क्यूबिट की रक्षा के लिए कई भौतिक क्यूबिट्स का उपयोग करता है।",
]
ENGLISH = [s for _, sentences in LECTURE for s in sentences]
TITLE_HI, TITLE_EN = "क्वांटम कंप्यूटिंग की व्याख्या", "Quantum Computing Explained"
EN_OF = dict(zip(HINDI, ENGLISH)) | {TITLE_HI: TITLE_EN}


def hindi_transcript(repeats: int = 4) -> list[dict]:
    """Same timing as `synthetic_transcript`, Hindi text."""
    english = synthetic_transcript(repeats)
    return [{**e, "text": HINDI[ENGLISH.index(e["text"])]} for e in english]


class FakeNLLB:
    """Stands in for the CTranslate2 model: looks sentences up instead of running a network."""

    name = "fake-nllb"
    loads = 0

    def __init__(self):
        FakeNLLB.loads += 1
        self.calls: list[tuple[str, int]] = []

    def tokenize(self, text):
        return text.split()

    def translate(self, pieces, src):
        self.calls.append((src, len(pieces)))
        return [EN_OF.get(" ".join(p), "an English sentence") for p in pieces]


@pytest.fixture(autouse=True)
def fake_model(tmp_path, monkeypatch):
    translate.reset()
    FakeNLLB.loads = 0
    monkeypatch.setattr(translate, "_cache_path", lambda key: tmp_path / "translated" / f"{key}.json")
    monkeypatch.setattr(translate, "enabled", lambda: True)
    monkeypatch.setattr(translate, "_load_backend", FakeNLLB)
    yield
    translate.reset()


def transcript_of(raw: list[dict], video_id: str = "HINDIVIDEO1") -> Transcript:
    t = Transcript(video_id, normalize_entries(raw), "extension")
    t.blocks = build_blocks(t.entries)
    return t


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


# ---------------------------------------------------------------------------
def test_detects_the_language_and_skips_english():
    assert translate.detect_language(ENGLISH) == "en"
    assert translate.detect_language(HINDI) == "hi"
    assert translate.detect_language(["আজ আমরা নিউটনের গতির সূত্র শিখব। বল হলো ভর এবং ত্বরণের গুণফল।"]) == "bn"
    assert translate.detect_language(HINDI, hint="mr") == "mr"  # caption metadata picks among Devanagari languages
    assert translate.detect_language(HINDI, hint="en") == "hi"  # …but never overrides the script
    assert translate.detect_language(["Hola a todos, hoy vamos a aprender cómo las plantas producen energía con la luz del sol."]) == "es"
    assert translate.normalize_lang("a.hi-IN") == "hi" and translate.normalize_lang("xx") is None

    t = transcript_of(synthetic_transcript(), "ENGLISHVID1")
    before = [(e.start, e.text) for e in t.entries]
    info = translate.to_english("ENGLISHVID1", t, hint="en")
    assert info.lang == "en" and info.status == "english" and info.translate_ms == 0
    assert [(e.start, e.text) for e in t.entries] == before
    assert translate.STATS["loads"] == 0 and FakeNLLB.loads == 0, "English videos never load the model"


def test_model_loads_once_across_two_videos():
    for video in ("HINDIVIDEO1", "HINDIVIDEO2"):
        info = translate.to_english(video, transcript_of(hindi_transcript(), video))
        assert info.status == "translated"
    assert translate.get() is translate.get()
    assert FakeNLLB.loads == 1 and translate.STATS["loads"] == 1


def test_translation_cache_hit_does_not_call_the_model():
    first = translate.to_english("HINDIVIDEO1", transcript_of(hindi_transcript()))
    calls = translate.STATS["model_calls"]
    assert first.status == "translated" and calls >= 1

    again = translate.to_english("HINDIVIDEO1", transcript_of(hindi_transcript()))  # memory cache
    assert again.status == "cached" and translate.STATS["model_calls"] == calls

    translate._units_memory.clear()  # disk cache (e.g. after a server restart)
    third = translate.to_english("HINDIVIDEO1", transcript_of(hindi_transcript()))
    assert third.status == "cached" and translate.STATS["model_calls"] == calls


def test_timestamps_survive_translation():
    raw = hindi_transcript(repeats=1)
    t = transcript_of(raw)
    translate.to_english("HINDIVIDEO1", t)
    assert [(e.start, e.end) for e in t.entries] == [(r["start"], r["start"] + r["duration"]) for r in raw]
    assert [e.text for e in t.entries] == ENGLISH


def test_mixed_language_units_are_translated_per_unit():
    raw = hindi_transcript(repeats=1)
    raw[3] = {**raw[3], "text": "This part of the lecture is in English, so it is kept as it is."}
    t = transcript_of(raw)
    model = translate.get()
    translate.to_english("HINDIVIDEO1", t)
    assert t.entries[3].text == raw[3]["text"]
    assert sum(n for _, n in model.calls) == len(raw) - 1, "the English unit never reaches the model"


def test_quick_map_coverage_is_spread_over_the_whole_video():
    order = translate.strided_order(80)
    first = sorted(order[:10])
    assert first == list(range(0, 80, 8)), "the first 1/8 covers the whole video evenly"
    assert sorted(order) == list(range(80))


def test_non_english_transcript_gives_english_only_nodes():
    mm = build_skeleton({"videoId": "HINDIVIDEO1", "title": TITLE_HI, "transcript": hindi_transcript(), "languages": ["hi"], "mode": "revision", "useLLM": False, "allowWhisper": False})
    assert mm["meta"]["sourceLanguage"] == "hi" and mm["meta"]["translation"]["status"] == "translated"
    assert mm["meta"]["language"] == "en" and mm["meta"]["title"] == TITLE_EN and mm["root"]["text"] == TITLE_EN
    for node in walk(mm["root"]):
        for field in ("text", "summary", "source"):
            assert not translate.needs_translation(node.get(field) or ""), (field, node.get(field))
    assert all(not translate.needs_translation(e["text"]) for e in mm["transcript"])
    # ▶ timestamps still point into the original video
    starts = {round(r["start"], 2) for r in hindi_transcript()}
    concepts = [c for s in mm["root"]["children"] if not s.get("recall") for c in s["children"]]
    assert concepts and all(c["start"] is not None and min(starts) <= c["start"] <= max(starts) for c in concepts)


def test_guard_retranslates_leftover_non_latin_text():
    translate.get()
    mm = {"root": {"text": "Quantum", "summary": "", "children": [{"text": HINDI[3], "summary": HINDI[4], "children": []}]}}
    assert translate.guard_map(mm, "hi") == 2
    assert mm["root"]["children"][0]["text"] == ENGLISH[3]


@pytest.mark.parametrize("failure", ["missing", "crash", "disabled"])
def test_map_is_still_built_when_nllb_is_missing_or_fails(monkeypatch, failure):
    if failure == "missing":
        def missing():
            raise translate.TranslationUnavailable("no model")
        monkeypatch.setattr(translate, "_load_backend", missing)
    elif failure == "crash":
        monkeypatch.setattr(FakeNLLB, "translate", lambda self, pieces, src: (_ for _ in ()).throw(RuntimeError("boom")))
    else:
        monkeypatch.setattr(translate, "enabled", lambda: False)
    mm = build_skeleton({"videoId": "HINDIVIDEO1", "title": "Quantum", "transcript": hindi_transcript(), "useLLM": False, "allowWhisper": False})
    expected = {"missing": "unavailable", "crash": "failed", "disabled": "disabled"}[failure]
    assert mm["meta"]["translation"]["status"] == expected
    assert len([s for s in mm["root"]["children"] if not s.get("recall")]) >= 1 and mm["transcript"]

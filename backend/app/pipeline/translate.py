"""
English-only maps: language detection + NLLB-200 translation (pretrained, inference only).

    detect     caption language metadata → Unicode script → English stop-word ratio → langdetect
               (≈1 ms; runs once per video)
    skip       English transcripts never touch the model (0 ms)
    load       ONE module-level model + tokenizer per process, loaded at server start-up (the
               warm-up runs one dummy translation); never reloaded per request or per video
    translate  sentence-sized units, batched, ONCE per video, right after the transcript fetch and
               before segmentation; every unit keeps the start/end of the caption lines it came
               from, so ▶ timestamps still point at the right moment
    cache      memory LRU + data/cache/translated/<videoId>-<lang>.json → re-runs cost 0 model calls

Model: facebook/nllb-200-distilled-600M converted to CTranslate2 int8 (scripts/convert_nllb.py).
At runtime only `ctranslate2` + `sentencepiece` are needed. Without a converted model, a locally
cached Hugging Face copy is used through `transformers` (if installed). With neither — or with
NLLB_ENABLED=0 — maps are built from the original text and `status` says why.
"""
from __future__ import annotations

import bisect
import hashlib
import json
import logging
import math
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import asdict, dataclass

from ..config import has_module, settings
from .transcript import Transcript, TranscriptEntry, build_blocks

log = logging.getLogger("tubemind.translate")

MODEL_NAME = "facebook/nllb-200-distilled-600M"
TARGET = "eng_Latn"
BEAM_SIZE = 1  # greedy decoding: caption-sized units gain little from beam 2 and it costs ~1.5x
MAX_PIECE_TOKENS = 160  # longer units are cut into chunks (NLLB was trained on ≤512 tokens)
MAX_BATCH = 32  # sentences per decoder batch (CTranslate2 sorts them by length to keep padding low)
UNIT_SECONDS = 10.0
UNIT_WORDS = 40
CACHE_VERSION = 2

# ISO 639-1 (and a few YouTube / langdetect variants) → NLLB-200 language codes
NLLB_CODES = {
    "af": "afr_Latn", "am": "amh_Ethi", "ar": "arb_Arab", "as": "asm_Beng", "az": "azj_Latn", "be": "bel_Cyrl",
    "bg": "bul_Cyrl", "bn": "ben_Beng", "bs": "bos_Latn", "ca": "cat_Latn", "cs": "ces_Latn", "cy": "cym_Latn",
    "da": "dan_Latn", "de": "deu_Latn", "el": "ell_Grek", "en": "eng_Latn", "es": "spa_Latn", "et": "est_Latn",
    "fa": "pes_Arab", "fi": "fin_Latn", "fr": "fra_Latn", "ga": "gle_Latn", "gl": "glg_Latn", "gu": "guj_Gujr",
    "ha": "hau_Latn", "he": "heb_Hebr", "iw": "heb_Hebr", "hi": "hin_Deva", "hr": "hrv_Latn", "hu": "hun_Latn",
    "hy": "hye_Armn", "id": "ind_Latn", "ig": "ibo_Latn", "is": "isl_Latn", "it": "ita_Latn", "ja": "jpn_Jpan",
    "jv": "jav_Latn", "ka": "kat_Geor", "kk": "kaz_Cyrl", "km": "khm_Khmr", "kn": "kan_Knda", "ko": "kor_Hang",
    "ky": "kir_Cyrl", "lo": "lao_Laoo", "lt": "lit_Latn", "lv": "lvs_Latn", "mk": "mkd_Cyrl", "ml": "mal_Mlym",
    "mn": "khk_Cyrl", "mr": "mar_Deva", "ms": "zsm_Latn", "my": "mya_Mymr", "ne": "npi_Deva", "nl": "nld_Latn",
    "no": "nob_Latn", "nb": "nob_Latn", "or": "ory_Orya", "pa": "pan_Guru", "pl": "pol_Latn", "ps": "pbt_Arab",
    "pt": "por_Latn", "ro": "ron_Latn", "ru": "rus_Cyrl", "si": "sin_Sinh", "sk": "slk_Latn", "sl": "slv_Latn",
    "so": "som_Latn", "sq": "als_Latn", "sr": "srp_Cyrl", "sv": "swe_Latn", "sw": "swh_Latn", "ta": "tam_Taml",
    "te": "tel_Telu", "th": "tha_Thai", "tl": "tgl_Latn", "fil": "tgl_Latn", "tr": "tur_Latn", "uk": "ukr_Cyrl",
    "ur": "urd_Arab", "uz": "uzn_Latn", "vi": "vie_Latn", "yo": "yor_Latn", "zh": "zho_Hans", "zh-cn": "zho_Hans",
    "zh-hans": "zho_Hans", "zh-tw": "zho_Hant", "zh-hant": "zho_Hant", "zh-hk": "zho_Hant", "zu": "zul_Latn",
}

# Unicode blocks of non-Latin scripts → (NLLB script tag, most likely language)
_SCRIPTS = [
    (0x0370, 0x03FF, "Grek", "el"), (0x0400, 0x04FF, "Cyrl", "ru"), (0x0530, 0x058F, "Armn", "hy"),
    (0x0590, 0x05FF, "Hebr", "he"), (0x0600, 0x06FF, "Arab", "ar"), (0x0900, 0x097F, "Deva", "hi"),
    (0x0980, 0x09FF, "Beng", "bn"), (0x0A00, 0x0A7F, "Guru", "pa"), (0x0A80, 0x0AFF, "Gujr", "gu"),
    (0x0B00, 0x0B7F, "Orya", "or"), (0x0B80, 0x0BFF, "Taml", "ta"), (0x0C00, 0x0C7F, "Telu", "te"),
    (0x0C80, 0x0CFF, "Knda", "kn"), (0x0D00, 0x0D7F, "Mlym", "ml"), (0x0D80, 0x0DFF, "Sinh", "si"),
    (0x0E00, 0x0E7F, "Thai", "th"), (0x0E80, 0x0EFF, "Laoo", "lo"), (0x1000, 0x109F, "Mymr", "my"),
    (0x10A0, 0x10FF, "Geor", "ka"), (0x1100, 0x11FF, "Hang", "ko"), (0x1200, 0x137F, "Ethi", "am"),
    (0x1780, 0x17FF, "Khmr", "km"), (0x3040, 0x30FF, "Jpan", "ja"), (0x3130, 0x318F, "Hang", "ko"),
    (0x3400, 0x4DBF, "Hans", "zh"), (0x4E00, 0x9FFF, "Hans", "zh"), (0xAC00, 0xD7AF, "Hang", "ko"),
]
_STARTS = [s[0] for s in _SCRIPTS]
SCRIPT_LANG = {tag: lang for _, _, tag, lang in _SCRIPTS}

# Frequent English function words: ≈25–45 % of the words in English speech, ≈0–5 % in other languages.
_EN_STOP = frozenset(
    "the a and is are was were to of in that it this you we for on with as be have has not what so can they "
    "but if or at from an by will how there about do which when your our its these their it's don't i'm".split()
)
_WORD_RE = re.compile(r"[a-z']+")
_SENT_END = (".", "?", "!", "।", "॥", "؟", "。", "？", "！")


class TranslationUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------
def _script(cp: int) -> str | None:
    i = bisect.bisect_right(_STARTS, cp) - 1
    return _SCRIPTS[i][2] if i >= 0 and cp <= _SCRIPTS[i][1] else None


def script_profile(text: str) -> tuple[int, dict[str, int]]:
    """(# Latin letters, {script tag: # letters}) — ASCII is skipped cheaply."""
    latin = 0
    other: dict[str, int] = {}
    for ch in text:
        if ch < "\x80":
            if ch.isalpha():
                latin += 1
            continue
        cp = ord(ch)
        if cp < 0x0250 or 0x1E00 <= cp <= 0x1EFF:  # accented Latin (é, ñ, ő, Vietnamese…)
            latin += ch.isalpha()
            continue
        tag = _script(cp)
        if tag:
            other[tag] = other.get(tag, 0) + 1
    if "Jpan" in other and "Hans" in other:  # kanji inside Japanese text
        other["Jpan"] += other.pop("Hans")
    return latin, other


def dominant_script(text: str) -> tuple[str | None, float]:
    """(non-Latin script tag or None, share of letters written in non-Latin scripts)."""
    latin, other = script_profile(text)
    total = latin + sum(other.values())
    if not other or not total:
        return None, 0.0
    tag = max(other, key=other.get)
    return tag, sum(other.values()) / total


def needs_translation(text: str) -> bool:
    """True when a string is (mostly) written in a non-Latin script."""
    return bool(text) and dominant_script(text)[1] > 0.2


def english_ratio(text: str) -> float:
    words = _WORD_RE.findall(text.lower())
    return sum(w in _EN_STOP for w in words) / len(words) if words else 0.0


def normalize_lang(code: str | None) -> str | None:
    if not code:
        return None
    code = code.strip().lower().replace("_", "-").removeprefix("a.")  # YouTube "a.en" = auto captions
    if code in NLLB_CODES:
        return code
    base = code.split("-")[0]
    return base if base in NLLB_CODES else None


def _matches_script(lang: str | None, tag: str) -> bool:
    return bool(lang) and NLLB_CODES.get(lang, "").endswith("_" + tag)


def _sample(texts: list[str], chars: int = 4000) -> str:
    """Spread a sample over the whole transcript (intro, middle, end)."""
    if sum(len(t) for t in texts) <= chars:
        return " ".join(texts)
    step = max(1, len(texts) // 40)
    out, size = [], 0
    for t in texts[::step]:
        out.append(t)
        size += len(t)
        if size >= chars:
            break
    return " ".join(out)


def detect_language(texts: list[str], hint: str | None = None) -> str:
    """ISO 639-1 code of a transcript. `hint` = caption-track language from YouTube, if known."""
    sample = _sample(texts)
    hint = normalize_lang(hint)
    tag, share = dominant_script(sample)
    if tag and share >= 0.3:  # the script decides; the hint only picks between languages sharing it
        return hint if _matches_script(hint, tag) else SCRIPT_LANG[tag]
    ratio = english_ratio(sample)
    if ratio >= 0.2:
        return "en"
    if hint and hint != "en":
        return hint
    if hint == "en" and ratio >= 0.1:
        return "en"
    guess = _langdetect(sample)
    return guess if guess in NLLB_CODES else "en"


def _langdetect(text: str) -> str | None:
    if not has_module("langdetect"):
        return None
    try:
        from langdetect import DetectorFactory, detect

        DetectorFactory.seed = 0  # deterministic
        return normalize_lang(detect(text[:2000]))
    except Exception:  # noqa: BLE001 - "no features in text" and friends
        return None


def unit_language(text: str, video_lang: str) -> str:
    """Language of one transcript unit (mixed-language videos: English parts are skipped)."""
    tag, share = dominant_script(text)
    if tag and share >= 0.3:
        return video_lang if _matches_script(video_lang, tag) else SCRIPT_LANG[tag]
    words = _WORD_RE.findall(text.lower())
    hits = sum(w in _EN_STOP for w in words)
    if hits >= 2 and hits / max(1, len(words)) >= 0.15:
        return "en"
    if video_lang == "en" or not NLLB_CODES.get(video_lang, "").endswith("_Latn"):
        # Latin text inside e.g. a Hindi video: English code-switching (or romanised speech NLLB cannot read)
        return "en"
    return video_lang


# ---------------------------------------------------------------------------
# The model: one instance per process
# ---------------------------------------------------------------------------
class _CT2Backend:
    name = "nllb-ct2-int8"

    def __init__(self, path):
        # Pre-packed int8 GEMM weights: ~2x faster decoding on Intel CPUs, identical output.
        os.environ.setdefault("CT2_USE_EXPERIMENTAL_PACKED_GEMM", "1")
        import ctranslate2
        import sentencepiece

        self.model = ctranslate2.Translator(str(path), device="cpu", compute_type="int8", inter_threads=1, intra_threads=max(1, os.cpu_count() or 1))
        self.sp = sentencepiece.SentencePieceProcessor(model_file=str(path / "sentencepiece.bpe.model"))

    def tokenize(self, text: str) -> list[str]:
        return self.sp.encode(text, out_type=str)

    def translate(self, pieces: list[list[str]], src: str) -> list[str]:
        longest = max(len(p) for p in pieces)
        results = self.model.translate_batch(
            [[src, *p, "</s>"] for p in pieces],
            target_prefix=[[TARGET]] * len(pieces),
            beam_size=BEAM_SIZE,
            max_batch_size=MAX_BATCH,
            max_decoding_length=min(320, int(longest * 1.6) + 12),
            repetition_penalty=1.1,
        )
        out = []
        for r in results:
            tokens = r.hypotheses[0]
            out.append(self.sp.decode(tokens[1:] if tokens[:1] == [TARGET] else tokens))
        return out


class _HFBackend:
    """Fallback when no CTranslate2 model exists: a locally cached transformers copy (never downloads)."""

    name = "nllb-transformers"

    def __init__(self):
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(MODEL_NAME, local_files_only=True)
        self.model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME, local_files_only=True).eval()

    def tokenize(self, text: str) -> list[str]:
        return self.tok.tokenize(text)

    def translate(self, pieces: list[list[str]], src: str) -> list[str]:
        import torch

        self.tok.src_lang = src
        texts = [self.tok.convert_tokens_to_string(p) for p in pieces]
        out: list[str] = []
        for i in range(0, len(texts), 16):
            batch = self.tok(texts[i : i + 16], return_tensors="pt", padding=True, truncation=True, max_length=256)
            with torch.inference_mode():
                generated = self.model.generate(**batch, forced_bos_token_id=self.tok.convert_tokens_to_ids(TARGET), num_beams=BEAM_SIZE, max_new_tokens=256)
            out += self.tok.batch_decode(generated, skip_special_tokens=True)
        return out


_backend = None
_state = "idle"  # idle | ready | unavailable
_error = ""
_load_lock = threading.Lock()
_run_lock = threading.Lock()  # one model, all cores: calls are serialised
STATS = {"loads": 0, "model_calls": 0, "load_ms": 0}


def enabled() -> bool:
    return settings.nllb_enabled


def _load_backend():
    path = settings.nllb_model_path
    if (path / "model.bin").exists() and has_module("ctranslate2") and has_module("sentencepiece"):
        return _CT2Backend(path)
    if has_module("transformers") and has_module("torch"):
        return _HFBackend()
    raise TranslationUnavailable(f"no NLLB model at {path} (run scripts/convert_nllb.py once)")


def get():
    """The process-wide model, loaded on first use (normally at start-up). None when unavailable."""
    global _backend, _state, _error
    if not enabled():
        return None
    if _state == "idle":
        with _load_lock:
            if _state == "idle":
                started = time.perf_counter()
                try:
                    _backend = _load_backend()
                    _state = "ready"
                    STATS["loads"] += 1
                    STATS["load_ms"] = round((time.perf_counter() - started) * 1000)
                    log.info("NLLB loaded once (%s) in %d ms", _backend.name, STATS["load_ms"])
                except Exception as exc:  # noqa: BLE001 - maps are still built from the original text
                    _state, _error = "unavailable", str(exc)
                    log.warning("NLLB unavailable: %s", exc)
    return _backend if _state == "ready" else None


def status() -> str:
    if not enabled():
        return "disabled"
    return _backend.name if _state == "ready" else ("unavailable" if _state == "unavailable" else "loading")


def warm_up() -> None:
    """Load the model and run one dummy translation so the first real video is not slow."""
    if get() is None:
        return
    started = time.perf_counter()
    try:
        translate_texts(["आज हम सीखेंगे कि यह कैसे काम करता है।"], "hi", use_cache=False)
    except Exception as exc:  # noqa: BLE001
        log.warning("NLLB warm-up failed: %s", exc)
    log.info("NLLB warm in %.0f ms", (time.perf_counter() - started) * 1000)


def reset() -> None:
    """Forget the loaded model and every cache (tests)."""
    global _backend, _state, _error
    with _load_lock:
        _backend, _state, _error = None, "idle", ""
    STATS.update(loads=0, model_calls=0, load_ms=0)
    _strings.clear()
    _units_memory.clear()
    with _tasks_lock:
        _tasks.clear()


# ---------------------------------------------------------------------------
# Translating text
# ---------------------------------------------------------------------------
def _split_tokens(tokens: list[str]) -> list[list[str]]:
    """Cut a long unit into ≤MAX_PIECE_TOKENS chunks, at word starts ("▁…")."""
    if len(tokens) <= MAX_PIECE_TOKENS:
        return [tokens]
    n = math.ceil(len(tokens) / MAX_PIECE_TOKENS)
    target = len(tokens) / n
    pieces, cur = [], []
    for tok in tokens:
        if len(cur) >= target and tok.startswith("▁") or len(cur) >= MAX_PIECE_TOKENS:
            pieces.append(cur)
            cur = []
        cur.append(tok)
    if cur:
        pieces.append(cur)
    return pieces


_strings: OrderedDict[tuple[str, str], str] = OrderedDict()  # (lang, text) -> English
_strings_lock = threading.Lock()


def translate_texts(texts: list[str], lang: str, *, use_cache: bool = True) -> list[str]:
    """Translate strings of one source language into English with ONE batched model call."""
    if not texts:
        return []
    src = NLLB_CODES.get(lang)
    if not src:
        raise TranslationUnavailable(f"language {lang!r} is not supported by NLLB-200")
    out: list[str | None] = [None] * len(texts)
    todo = []
    for i, text in enumerate(texts):
        hit = _strings.get((lang, text)) if use_cache else None
        if hit is not None or not text.strip():
            out[i] = hit if hit is not None else text
        else:
            todo.append(i)
    if todo:
        backend = get()
        if backend is None:
            raise TranslationUnavailable(_error or "NLLB is disabled")
        pieces, owners = [], []
        for i in todo:
            for piece in _split_tokens(backend.tokenize(texts[i])):
                pieces.append(piece)
                owners.append(i)
        with _run_lock:
            STATS["model_calls"] += 1
            translated = backend.translate(pieces, src)
        joined: dict[int, list[str]] = {}
        for i, text in zip(owners, translated):
            joined.setdefault(i, []).append(text.strip())
        with _strings_lock:
            for i in todo:
                english = re.sub(r"\s+", " ", " ".join(joined.get(i, []))).strip() or texts[i]
                out[i] = english
                if use_cache:
                    _strings[(lang, texts[i])] = english
                    while len(_strings) > 4096:
                        _strings.popitem(last=False)
    return [o or "" for o in out]


def to_english_texts(texts: list[str], video_lang: str) -> list[str]:
    """Titles, chapter names, single labels: each string detected on its own, English ones kept."""
    out = list(texts)
    by_lang: dict[str, list[int]] = {}
    for i, text in enumerate(texts):
        lang = unit_language(text, video_lang) if text else "en"
        if lang != "en" and lang in NLLB_CODES:
            by_lang.setdefault(lang, []).append(i)
    for lang, idx in by_lang.items():
        try:
            for i, english in zip(idx, translate_texts([texts[i] for i in idx], lang)):
                out[i] = english
        except Exception as exc:  # noqa: BLE001 - keep the original text
            log.info("label translation skipped: %s", exc)
    return out


# ---------------------------------------------------------------------------
# Transcripts: translated once per video (coarse-to-fine), timestamps kept, cached on disk
# ---------------------------------------------------------------------------
ROUND_UNITS = 24  # units per model call; progress is checkpointed after every round
CLICK_COVERAGE = 0.125  # a click builds a quick map once 1/8 of the video (spread evenly) is in English
WAIT_LIMIT = 900.0  # safety net for a stuck model (seconds)


@dataclass
class TranslationInfo:
    lang: str = "en"
    status: str = "english"  # english | translated | cached | partial | unavailable | disabled | failed
    detect_ms: float = 0.0
    translate_ms: float = 0.0
    units: int = 0
    translated: int = 0  # units that went through the model in this request
    coverage: float = 1.0  # share of the transcript available in English
    extras: list[str] | None = None  # title + chapter names in English (same task, same cache)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("extras")
        d["detect_ms"], d["translate_ms"], d["coverage"] = round(self.detect_ms, 1), round(self.translate_ms), round(self.coverage, 3)
        return d


_units_memory: OrderedDict[str, tuple[str, dict]] = OrderedDict()  # key -> (digest, {"units", "extras", "complete"})


def _cache_path(key: str):
    return settings.data_dir / "cache" / "translated" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', key)}.json"


def _cache_get(key: str, digest: str) -> dict | None:
    hit = _units_memory.get(key)
    if hit and hit[0] == digest:
        _units_memory.move_to_end(key)
        return hit[1]
    try:
        data = json.loads(_cache_path(key).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if data.get("v") != CACHE_VERSION or data.get("digest") != digest:
        return None
    value = {"units": data["units"], "extras": data.get("extras"), "complete": bool(data.get("complete"))}
    _remember(key, digest, value)
    return value


def _cache_put(key: str, digest: str, value: dict) -> None:
    _remember(key, digest, value)
    try:
        path = _cache_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"v": CACHE_VERSION, "digest": digest, **value}, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        log.warning("translation cache write failed: %s", exc)


def _remember(key: str, digest: str, value: dict) -> None:
    _units_memory[key] = (digest, value)
    _units_memory.move_to_end(key)
    while len(_units_memory) > 16:
        _units_memory.popitem(last=False)


def group_units(entries: list[TranscriptEntry]) -> list[list[TranscriptEntry]]:
    """Caption lines → sentence-sized units (a sentence end, ~10 s or ~40 words)."""
    groups: list[list[TranscriptEntry]] = []
    cur: list[TranscriptEntry] = []
    words = 0
    for e in entries:
        cur.append(e)
        words += len(e.text.split())
        span = e.end - cur[0].start
        if (e.text.rstrip().endswith(_SENT_END) and span >= 2.5) or span >= UNIT_SECONDS or words >= UNIT_WORDS:
            groups.append(cur)
            cur, words = [], 0
    if cur:
        groups.append(cur)
    return groups


def strided_order(n: int) -> list[int]:
    """0, 8, 16 … then 4, 12 … then 2, 6 … then the odd units: every prefix covers the whole video evenly."""
    order: list[int] = []
    seen: set[int] = set()
    for step in (8, 4, 2, 1):
        for i in range(0, n, step):
            if i not in seen:
                seen.add(i)
                order.append(i)
    return order


def _translate_mixed(texts: list[str], langs: list[str]) -> list[str]:
    """One model call per source language present (usually exactly one); English stays as is."""
    out = list(texts)
    by_lang: dict[str, list[int]] = {}
    for i, lang in enumerate(langs):
        if lang != "en" and lang in NLLB_CODES and texts[i]:
            by_lang.setdefault(lang, []).append(i)
    for lang, idx in by_lang.items():
        for i, text in zip(idx, translate_texts([texts[i] for i in idx], lang, use_cache=False)):
            out[i] = text
    return out


class _Task:
    """Background translation of one transcript, shared by prefetch and click, checkpointed every round."""

    def __init__(self, key: str, digest: str, lang: str, groups, sources: list[str], langs: list[str], extras: list[str], resume: dict | None):
        self.key, self.digest, self.lang, self.groups, self.sources, self.langs, self.extras = key, digest, lang, groups, sources, langs, extras
        self.english: list[str | None] = [u["text"] for u in resume["units"]] if resume else [s if l == "en" else None for s, l in zip(sources, langs)]
        self.extras_en: list[str] | None = (resume or {}).get("extras")
        self.cond = threading.Condition()
        self.finished = False
        self.error: Exception | None = None
        self.model_units = 0

    @property
    def coverage(self) -> float:
        return sum(e is not None for e in self.english) / len(self.english) if self.english else 1.0

    def snapshot(self) -> dict:
        units = [
            {"start": g[0].start, "end": g[-1].end, "text": self.english[i], "orig": self.sources[i], "lang": self.langs[i], "speaker": g[0].speaker_change}
            for i, g in enumerate(self.groups)
        ]
        return {"units": units, "extras": self.extras_en, "complete": all(e is not None for e in self.english)}

    def run(self) -> None:
        try:
            todo = [i for i in strided_order(len(self.english)) if self.english[i] is None]
            while todo or self.extras_en is None:
                batch, todo = todo[:ROUND_UNITS], todo[ROUND_UNITS:]
                texts = [self.sources[i] for i in batch]
                langs = [self.langs[i] for i in batch]
                with_extras = self.extras_en is None
                if with_extras:  # title + chapter names ride along with the first round
                    texts += self.extras
                    langs += [unit_language(t, self.lang) if t else "en" for t in self.extras]
                english = _translate_mixed(texts, langs)
                with self.cond:
                    for i, text in zip(batch, english):
                        self.english[i] = text or self.sources[i]
                    if with_extras:
                        self.extras_en = english[len(batch):]
                    self.model_units += sum(1 for l in langs[: len(batch)] if l != "en")
                    self.cond.notify_all()
                _cache_put(self.key, self.digest, self.snapshot())
        except Exception as exc:  # noqa: BLE001 - waiters decide what to do with partial progress
            self.error = exc
            log.warning("translation %s stopped at %.0f%%: %s", self.key, self.coverage * 100, exc)
        finally:
            with self.cond:
                self.finished = True
                self.cond.notify_all()
            with _tasks_lock:
                if _tasks.get(self.key) is self:
                    del _tasks[self.key]


_tasks: dict[str, _Task] = {}
_tasks_lock = threading.Lock()


def in_progress(video_id: str) -> bool:
    """True while a transcript of this video is still being translated in the background."""
    with _tasks_lock:
        return any(key.rsplit("-", 1)[0] == video_id for key in _tasks)


def to_english(video_id: str, transcript: Transcript, hint: str | None = None, extras: list[str] | None = None,
               min_coverage: float = 1.0) -> TranslationInfo:
    """
    Detect the transcript language once and, if it is not English, replace its entries with
    English units (same timestamps; untranslated units are left out). English transcripts
    return immediately and never touch the model.

    Translation runs in a shared background task, coarse-to-fine (every 8th unit first), so
    `min_coverage` < 1 returns as soon as that share of the video — spread evenly over its
    whole length — is in English. The task keeps going and caches the full result.
    `extras` (title, chapter names) are translated in the first round; `info.extras` holds
    them in English. Never raises: when NLLB is missing or fails, the original text is kept.
    """
    started = time.perf_counter()
    lang = detect_language([e.text for e in transcript.entries], hint)
    info = TranslationInfo(lang=lang, detect_ms=(time.perf_counter() - started) * 1000, extras=list(extras or []))
    transcript.language = lang
    if lang == "en":
        return info
    if not enabled():
        info.status = "disabled"
        return info

    started = time.perf_counter()
    try:
        value, task = _translation(video_id, transcript.entries, lang, list(extras or []))
        if task is not None:
            with task.cond:
                task.cond.wait_for(lambda: task.finished or task.coverage >= min_coverage, timeout=WAIT_LIMIT)
                if task.error is not None and task.coverage == 0:
                    raise task.error
                value = task.snapshot()
                info.translated = task.model_units
    except TranslationUnavailable as exc:
        info.status = "unavailable"
        log.warning("transcript %s (%s) kept untranslated: %s", video_id, lang, exc)
        return info
    except Exception as exc:  # noqa: BLE001
        info.status = "failed"
        log.warning("translation of %s (%s) failed: %s", video_id, lang, exc)
        return info
    finally:
        info.translate_ms = (time.perf_counter() - started) * 1000

    units = [u for u in value["units"] if u.get("text")]
    info.units = len(value["units"])
    info.coverage = len(units) / info.units if info.units else 1.0
    info.status = "cached" if task is None else ("translated" if info.coverage >= 1 else "partial")
    if value.get("extras"):
        info.extras = value["extras"]
    transcript.entries = [TranscriptEntry(u["start"], u["end"], u["text"], u.get("speaker", False)) for u in units]
    transcript.blocks = build_blocks(transcript.entries)
    transcript.language = "en"
    return info


def _translation(video_id: str, entries: list[TranscriptEntry], lang: str, extras: list[str]) -> tuple[dict | None, _Task | None]:
    """(complete cached value, None) or (None, the running/new background task)."""
    groups = group_units(entries)
    sources = [" ".join(e.text for e in g) for g in groups]
    digest = hashlib.sha1("\n".join([lang, *sources, "|", *extras]).encode()).hexdigest()[:16]
    key = f"{video_id}-{lang}"
    cached = _cache_get(key, digest)
    if cached is not None and cached.get("complete"):
        return cached, None  # cache hit: the model is not needed (nor loaded)
    with _tasks_lock:
        task = _tasks.get(key)
        if task is not None and task.digest == digest:
            return None, task
        if get() is None:
            raise TranslationUnavailable(_error or "NLLB is not loaded")
        task = _Task(key, digest, lang, groups, sources, [unit_language(s, lang) for s in sources], extras, cached)
        _tasks[key] = task
    threading.Thread(target=task.run, name=f"tubemind-translate-{video_id}", daemon=True).start()
    return None, task


def is_complete(video_id: str, lang: str) -> bool:
    """Whether the full English transcript of a video is cached (a quick map can then be rebuilt in full)."""
    key = f"{video_id}-{lang}"
    hit = _units_memory.get(key)
    if hit:
        return bool(hit[1].get("complete"))
    try:
        return bool(json.loads(_cache_path(key).read_text(encoding="utf-8")).get("complete"))
    except (OSError, json.JSONDecodeError):
        return False


# ---------------------------------------------------------------------------
# Final guard: no non-Latin text may reach a node
# ---------------------------------------------------------------------------
def guard_map(mindmap: dict, video_lang: str) -> int:
    """Re-translate any node text/summary still in a non-Latin script. Returns how many were fixed."""
    fixed = 0

    def walk(node: dict):
        yield node
        for child in node.get("children") or []:
            yield from walk(child)

    targets = [(node, f) for node in walk(mindmap["root"]) for f in ("text", "summary") if needs_translation(node.get(f) or "")]
    if not targets:
        return 0
    english = to_english_texts([node[f] for node, f in targets], video_lang)
    for (node, f), text in zip(targets, english):
        if not needs_translation(text):
            node[f] = text
            fixed += 1
    return fixed

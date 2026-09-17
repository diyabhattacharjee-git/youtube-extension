"""
Layer 1 — Video Transcription.

Order of preference:
  1. Transcript already scraped by the extension (sent with the request).
  2. YouTube captions via `youtube-transcript-api` (manual > auto, English preferred,
     otherwise auto-translated when YouTube allows it).
  3. Whisper fallback: `yt-dlp` downloads the audio track and `faster-whisper`
     (or `openai-whisper`) transcribes it locally.

Output: cleaned entries `{start, end, text, speaker_change}` plus "blocks"
(≈25 s windows) that the later layers treat as documents.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Callable

from ..config import has_module, settings
from .text_utils import clean_caption, is_speaker_change, split_sentences

log = logging.getLogger("tubemind.transcript")

ProgressFn = Callable[[str, float], None]


class TranscriptUnavailable(RuntimeError):
    pass


@dataclass
class TranscriptEntry:
    start: float
    end: float
    text: str
    speaker_change: bool = False


@dataclass
class Transcript:
    video_id: str
    entries: list[TranscriptEntry]
    source: str
    language: str = "en"
    blocks: list[TranscriptEntry] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.entries[-1].end if self.entries else 0.0

    @property
    def full_text(self) -> str:
        return " ".join(e.text for e in self.entries)

    def to_dict(self) -> dict:
        return {
            "videoId": self.video_id,
            "source": self.source,
            "language": self.language,
            "entries": [asdict(e) for e in self.entries],
        }


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------
def normalize_entries(raw: list[dict]) -> list[TranscriptEntry]:
    """Accept `{start, duration|end, text}` dicts from any source and clean them."""
    entries: list[TranscriptEntry] = []
    last_text = ""
    for item in raw:
        text_raw = str(item.get("text", ""))
        text = clean_caption(text_raw)
        if not text:
            continue
        start = float(item.get("start", 0) or 0)
        if item.get("end") is not None:
            end = float(item["end"])
        else:
            end = start + float(item.get("duration", 0) or 0)
        # Rolling auto-captions often repeat the previous line; skip exact repeats.
        if text.lower() == last_text.lower():
            continue
        entries.append(TranscriptEntry(start, max(end, start + 0.5), text, is_speaker_change(text_raw)))
        last_text = text
    entries.sort(key=lambda e: e.start)
    return entries


def build_blocks(entries: list[TranscriptEntry], window: float = 25.0) -> list[TranscriptEntry]:
    """Group caption lines into ~window-second blocks, cutting at sentence ends when possible."""
    blocks: list[TranscriptEntry] = []
    cur: list[TranscriptEntry] = []
    for e in entries:
        if cur:
            span = e.end - cur[0].start
            ends_sentence = cur[-1].text.rstrip().endswith((".", "?", "!"))
            if e.speaker_change or span > window * 1.6 or (span > window and ends_sentence):
                blocks.append(_merge(cur))
                cur = []
        cur.append(e)
    if cur:
        blocks.append(_merge(cur))
    return blocks


def _merge(group: list[TranscriptEntry]) -> TranscriptEntry:
    return TranscriptEntry(
        start=group[0].start,
        end=group[-1].end,
        text=" ".join(g.text for g in group),
        speaker_change=group[0].speaker_change,
    )


def sentences_with_time(entries: list[TranscriptEntry]) -> list[TranscriptEntry]:
    """Split the transcript into sentence-ish units that keep an approximate timestamp."""
    out: list[TranscriptEntry] = []
    for block in build_blocks(entries, window=12.0):
        parts = split_sentences(block.text)
        if len(parts) <= 1:
            out.append(block)
            continue
        total = sum(len(p) for p in parts) or 1
        t = block.start
        span = block.end - block.start
        for p in parts:
            dur = span * len(p) / total
            out.append(TranscriptEntry(t, t + dur, p))
            t += dur
    return out


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
def from_youtube_api(video_id: str, languages: list[str]) -> tuple[list[dict], str]:
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError as exc:  # pragma: no cover
        raise TranscriptUnavailable("youtube-transcript-api not installed") from exc

    if hasattr(YouTubeTranscriptApi, "list_transcripts"):  # legacy 0.6.x static API
        tlist = YouTubeTranscriptApi.list_transcripts(video_id)
    else:  # v1.x instance API
        tlist = YouTubeTranscriptApi().list(video_id)

    transcript = None
    for finder in ("find_manually_created_transcript", "find_generated_transcript"):
        try:
            transcript = getattr(tlist, finder)(languages)
            break
        except Exception:  # noqa: BLE001 - the library raises several custom types
            continue
    if transcript is None:
        available = list(tlist)
        if not available:
            raise TranscriptUnavailable("no captions")
        transcript = available[0]
        if getattr(transcript, "is_translatable", False) and languages:
            try:
                transcript = transcript.translate(languages[0])
            except Exception:  # noqa: BLE001
                pass

    fetched = transcript.fetch()
    raw = fetched.to_raw_data() if hasattr(fetched, "to_raw_data") else list(fetched)
    raw = [r if isinstance(r, dict) else {"text": r.text, "start": r.start, "duration": r.duration} for r in raw]
    return raw, getattr(transcript, "language_code", languages[0] if languages else "en")


def from_whisper(video_id: str, progress: ProgressFn | None = None) -> list[dict]:
    if not has_module("yt_dlp"):
        raise TranscriptUnavailable("Whisper fallback needs `yt-dlp` (pip install -r requirements-ml.txt)")
    import yt_dlp

    media_dir = settings.data_dir / "media"
    existing = list(media_dir.glob(f"{video_id}.audio.*"))
    if existing:
        audio_path = existing[0]
    else:
        if progress:
            progress("Downloading audio for Whisper", 0.05)
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": str(media_dir / f"{video_id}.audio.%(ext)s"),
            "quiet": True,
            "noprogress": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        found = list(media_dir.glob(f"{video_id}.audio.*"))
        if not found:
            raise TranscriptUnavailable("audio download failed")
        audio_path = found[0]

    if progress:
        progress("Transcribing audio with Whisper (this can take a while)", 0.1)

    if has_module("faster_whisper"):
        from faster_whisper import WhisperModel

        model = WhisperModel(settings.whisper_model, device="auto", compute_type="int8")
        segments, _info = model.transcribe(str(audio_path), vad_filter=True)
        return [{"start": s.start, "end": s.end, "text": s.text} for s in segments]
    if has_module("whisper"):
        import whisper  # openai-whisper (needs ffmpeg on PATH)

        model = whisper.load_model(settings.whisper_model)
        result = model.transcribe(str(audio_path))
        return [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in result["segments"]]
    raise TranscriptUnavailable("Install `faster-whisper` (or `openai-whisper`) for the Whisper fallback")


def get_transcript(
    video_id: str,
    provided: list[dict] | None = None,
    languages: list[str] | None = None,
    allow_whisper: bool = True,
    progress: ProgressFn | None = None,
) -> Transcript:
    languages = languages or ["en", "en-US", "en-GB"]
    errors: list[str] = []

    if provided:
        entries = normalize_entries(provided)
        if len(entries) >= 3:
            return _finish(Transcript(video_id, entries, "extension"))
        errors.append("extension transcript was empty")

    try:
        raw, lang = from_youtube_api(video_id, languages)
        entries = normalize_entries(raw)
        if entries:
            return _finish(Transcript(video_id, entries, "youtube-captions", lang))
        errors.append("youtube captions empty")
    except Exception as exc:  # noqa: BLE001
        log.info("YouTube captions unavailable for %s: %s", video_id, exc)
        errors.append(f"captions: {type(exc).__name__}: {str(exc)[:160]}")

    if allow_whisper:
        try:
            entries = normalize_entries(from_whisper(video_id, progress))
            if entries:
                return _finish(Transcript(video_id, entries, "whisper"))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"whisper: {exc}")

    raise TranscriptUnavailable("; ".join(errors))


def _finish(t: Transcript) -> Transcript:
    t.blocks = build_blocks(t.entries)
    return t

"""
Layer 7 — Multimodal integration (server side).

Downloads a low-resolution copy of the video (yt-dlp) and uses OpenCV to find
"visual keyframes": slide changes, charts and diagrams. A frame is kept when
  * it differs strongly from the last kept frame (scene / slide change), and
  * it is "information dense" (edge density typical of text, charts, slides).

Frames are returned as small base64 JPEG data URLs and attached to the node
whose timestamp is closest. (The extension additionally uses YouTube's own
storyboard thumbnails, which need no download at all.)
"""
from __future__ import annotations

import base64
import logging
from typing import Callable

from ..config import has_module, settings

log = logging.getLogger("tubemind.multimodal")


def available() -> bool:
    return has_module("cv2") and has_module("yt_dlp")


def extract_keyframes(
    video_id: str,
    max_frames: int = 24,
    sample_every: float = 2.0,
    progress: Callable[[str, float], None] | None = None,
) -> list[dict]:
    if not available():
        raise RuntimeError("Keyframe extraction needs opencv-python-headless and yt-dlp (requirements-ml.txt)")
    import cv2
    import numpy as np
    import yt_dlp

    media_dir = settings.data_dir / "media"
    found = list(media_dir.glob(f"{video_id}.video.*"))
    if not found:
        if progress:
            progress("Downloading low-res video for keyframes", 0.1)
        opts = {
            "format": "worst[ext=mp4][height>=240]/worstvideo[ext=mp4]/worst",
            "outtmpl": str(media_dir / f"{video_id}.video.%(ext)s"),
            "quiet": True,
            "noprogress": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        found = list(media_dir.glob(f"{video_id}.video.*"))
        if not found:
            raise RuntimeError("video download failed")

    cap = cv2.VideoCapture(str(found[0]))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    step = max(1, int(fps * sample_every))

    candidates: list[tuple[float, float, "np.ndarray"]] = []
    last_hist = None
    idx = 0
    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        change = 1.0 if last_hist is None else 1.0 - cv2.compareHist(last_hist, hist, cv2.HISTCMP_CORREL)
        if change > 0.25:
            edges = cv2.Canny(gray, 80, 160)
            density = float((edges > 0).mean())
            # slides/charts: many crisp edges, but not pure noise
            if 0.02 < density < 0.25:
                candidates.append((idx / fps, change * density, frame))
            last_hist = hist
        idx += step
        if progress and total and idx % (step * 30) == 0:
            progress("Scanning frames for slides and charts", min(0.95, idx / total))
    cap.release()

    candidates.sort(key=lambda c: -c[1])
    chosen = sorted(candidates[:max_frames], key=lambda c: c[0])
    frames = []
    for t, score, frame in chosen:
        h, w = frame.shape[:2]
        scale = 320 / max(w, 1)
        small = cv2.resize(frame, (320, int(h * scale)))
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 72])
        if ok:
            frames.append({
                "t": round(t, 1),
                "score": round(float(score), 4),
                "image": "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode(),
            })
    return frames


def attach_frames(mindmap: dict, frames: list[dict]) -> int:
    """Attach each keyframe to the closest concept/section node that starts before it."""
    nodes = []

    def walk(n):
        if n.get("type") in ("section", "concept") and n.get("start") is not None:
            nodes.append(n)
        for c in n.get("children", []):
            walk(c)

    walk(mindmap["root"])
    attached = 0
    for fr in frames:
        before = [n for n in nodes if n["start"] <= fr["t"] + 1 and not n.get("image")]
        if not before:
            continue
        target = max(before, key=lambda n: n["start"])
        target["image"] = {"src": fr["image"], "t": fr["t"], "source": "keyframe"}
        attached += 1
    return attached

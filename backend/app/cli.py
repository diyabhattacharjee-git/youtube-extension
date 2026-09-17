"""
Command-line demo: convert a YouTube lecture into a mindmap JSON without the extension.

    cd backend
    python -m app.cli "https://www.youtube.com/watch?v=VIDEO_ID" --mode academic --out ../examples/my-lecture.json

Then open the extension viewer → "Open file" and load the JSON (or drag it onto the canvas).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .main import extract_video_id
from .pipeline import llm
from .pipeline.builder import generate_mindmap
from .pipeline.embeddings import backend_name
from .pipeline.text_utils import fmt_time


def main() -> int:
    parser = argparse.ArgumentParser(description="TubeMind: YouTube → mindmap JSON")
    parser.add_argument("url", help="YouTube URL or 11-character video id")
    parser.add_argument("--mode", choices=["academic", "revision", "deep"], default="academic")
    parser.add_argument("--profile", choices=["visual", "balanced", "text"], default="balanced")
    parser.add_argument("--title", default=None, help="video title (optional, improves the central idea)")
    parser.add_argument("--no-llm", action="store_true", help="skip Groq/LLM, heuristics only")
    parser.add_argument("--no-whisper", action="store_true")
    parser.add_argument("--out", default="mindmap.json")
    args = parser.parse_args()

    video_id = extract_video_id(args.url)
    print(f"▶ video {video_id} | LLM: {llm.provider_name() if not args.no_llm else 'disabled'} | embeddings: {backend_name()}")
    started = time.time()

    def progress(stage: str, pct: float) -> None:
        bar = "█" * int(pct * 24)
        print(f"\r[{bar:<24}] {pct * 100:5.1f}%  {stage[:70]:<70}", end="", flush=True)

    result = generate_mindmap(
        {"videoId": video_id, "title": args.title, "mode": args.mode, "profile": args.profile, "useLLM": not args.no_llm, "allowWhisper": not args.no_whisper},
        progress,
    )
    print()
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    def show(node: dict, depth: int = 0) -> None:
        if node["type"] == "transcript":
            return
        ts = f" [{fmt_time(node['start'])}]" if node.get("start") is not None else ""
        print(f"{'   ' * depth}• {node['text']}{ts}")
        for child in node["children"]:
            show(child, depth + 1)

    show(result["root"])
    print(f"\n✔ wrote {args.out} in {time.time() - started:.1f}s ({result['meta']['transcriptSource']} transcript)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
Measure "click → fully labelled map" against a RUNNING backend, the way the viewer does it:
POST /api/jobs (map comes back inline), then one long-poll for the label ops.

    cd backend && python -m app.main                      # in one terminal (wait for "NLLB warm")
    python scripts/bench_sketchbook.py VIDEO_ID [...]      # transcripts come from backend/data/cache

Options:
    --cold        delete the translation + label caches of the video first (worst case)
    --no-cache    ignore the cached map (forces a rebuild; translation/label caches still apply)
    --prefetch    POST /api/prefetch first and wait until the video is fully translated
    --mode        revision (Short, default) | academic | deep
    --source      folder of cached maps with the original transcripts (default: backend/data/cache)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "backend" / "data" / "cache"


def cached_video(video_id: str, source: Path) -> dict:
    """Original transcript + title of a video from a cached map (the extension sends the same data)."""
    for path in sorted(source.glob("*.json")):
        try:
            mm = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if mm.get("meta", {}).get("videoId") == video_id and mm.get("transcript") and "translation" not in mm["meta"]:
            meta = mm["meta"]
            return {
                "title": meta.get("originalTitle") or meta.get("title"),
                "duration": meta.get("duration"),
                "transcript": [{"start": e["start"], "end": e["end"], "text": e["text"]} for e in mm["transcript"]],
                "language": meta.get("sourceLanguage") or meta.get("language"),
            }
    sys.exit(f"no original transcript for {video_id} in {source}")


def wait_job(client: httpx.Client, job_id: str, has_map: bool) -> dict:
    while True:
        job = client.get(f"/api/jobs/{job_id}", params={"wait": 20, "hasMap": int(has_map)}).json()
        if job["status"] in ("done", "error") or (not has_map and job.get("map")):
            return job


def click(client: httpx.Client, video_id: str, video: dict, mode: str, no_cache: bool) -> dict:
    body = {
        "videoId": video_id, "title": video["title"], "duration": video["duration"], "transcript": video["transcript"],
        "languages": [video["language"]] if video["language"] else None, "mode": mode, "useLLM": True, "allowWhisper": False, "noCache": no_cache,
    }
    started = time.perf_counter()
    res = client.post("/api/jobs", json=body).json()
    if res.get("map") is None:
        res["map"] = wait_job(client, res["jobId"], False)["map"]
    map_ms = (time.perf_counter() - started) * 1000
    done, stats = None, {}
    if res.get("pending") and res.get("jobId"):
        done = wait_job(client, res["jobId"], True)
        stats = (done.get("meta") or {}).get("labelStats") or {}
    total_ms = (time.perf_counter() - started) * 1000
    meta = res["map"]["meta"]
    return {
        "video": video_id, "lang": meta.get("sourceLanguage"), "cached": res.get("cached"), "map_ms": round(map_ms), "labelled_ms": round(total_ms),
        "coverage": (meta.get("translation") or {}).get("coverage", 1), "timings": meta.get("timings"), "llm_calls": stats.get("calls"),
        "tokens": f"{stats.get('prompt_tokens')}/{stats.get('completion_tokens')}" if stats else None, "llm_ms": stats.get("llm_ms"),
        "applied": f"{stats.get('applied')}/{stats.get('candidates')}" if stats else None, "errors": stats.get("errors"),
        "sections": sum(1 for s in res["map"]["root"]["children"] if not s.get("recall")),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("videos", nargs="+")
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    ap.add_argument("--mode", default="revision")
    ap.add_argument("--cold", action="store_true")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--prefetch", action="store_true")
    ap.add_argument("--source", type=Path, default=CACHE, help="folder of cached maps holding the original transcripts")
    args = ap.parse_args()
    client = httpx.Client(base_url=args.base, timeout=120)
    print("health:", client.get("/api/health").json())
    for vid in args.videos:
        video = cached_video(vid, args.source)
        if args.cold:
            for path in (CACHE / "translated").glob(f"{vid}-*.json"):
                path.unlink()
            for path in (CACHE / "labels").glob("*.json"):
                path.unlink()
        if args.prefetch:
            started = time.perf_counter()
            body = {"videoId": vid, "title": video["title"], "duration": video["duration"], "transcript": video["transcript"],
                    "languages": [video["language"]] if video["language"] else None, "mode": args.mode}
            print("prefetch:", client.post("/api/prefetch", json=body).json())
            time.sleep(1.0)  # language detection happens on the server; English videos create no translation file
            while list((CACHE / "translated").glob(f"{vid}-*.json")):
                try:
                    if any(json.loads(p.read_text(encoding="utf-8")).get("complete") for p in (CACHE / "translated").glob(f"{vid}-*.json")):
                        break
                except (OSError, json.JSONDecodeError):
                    pass
                time.sleep(1)
            print(f"prefetch translated the whole video in {time.perf_counter() - started:.1f} s")
            time.sleep(1.5)  # let the prefetch job finish building its skeleton
        print(json.dumps(click(client, vid, video, args.mode, args.no_cache)))


if __name__ == "__main__":
    main()

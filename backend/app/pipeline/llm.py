"""
Layer 4 — LLM integration (Groq first, open-source fallbacks second).

Provider chain:
  1. Groq (OpenAI-compatible REST API, free tier) — `GROQ_API_KEY` from `.env`.
     On rate limits / retired models it automatically retries with `GROQ_FALLBACK_MODEL`.
  2. Hugging Face Inference Providers router (`HF_TOKEN`, open-weight model `HF_MODEL`).
  3. Local open-source model via `transformers` (`HF_LOCAL_MODEL`).
  4. None -> callers use deterministic heuristics so the pipeline still works offline.

All calls ask for JSON and are parsed defensively.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from functools import lru_cache
from typing import Any

import httpx

from ..config import has_module, settings
from .text_utils import extract_json

log = logging.getLogger("tubemind.llm")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
HF_URL = "https://router.huggingface.co/v1/chat/completions"

# Free tiers are rate limited per minute: keep concurrency low.
_semaphore = threading.BoundedSemaphore(2)


class LLMError(RuntimeError):
    pass


def provider_name() -> str:
    if settings.groq_enabled:
        return f"groq:{settings.groq_model}"
    if settings.hf_token:
        return f"huggingface:{settings.hf_model}"
    if settings.hf_local_model and has_module("transformers"):
        return f"local:{settings.hf_local_model}"
    return "heuristic"


def available() -> bool:
    return provider_name() != "heuristic"


def chat_json(system: str, user: str, max_tokens: int = 1800, temperature: float = 0.3) -> Any | None:
    """Return parsed JSON from the best available LLM, or None if no LLM is usable."""
    messages = [
        {"role": "system", "content": system + "\nRespond with valid JSON only. No markdown fences."},
        {"role": "user", "content": user},
    ]
    errors = []
    with _semaphore:
        if settings.groq_enabled:
            for model in dict.fromkeys([settings.groq_model, settings.groq_fallback_model]):
                try:
                    return extract_json(_openai_compatible(GROQ_URL, settings.groq_api_key, model, messages, max_tokens, temperature, json_mode=True))
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"groq/{model}: {exc}")
                    log.warning("Groq %s failed: %s", model, exc)
        if settings.hf_token:
            try:
                return extract_json(_openai_compatible(HF_URL, settings.hf_token, settings.hf_model, messages, max_tokens, temperature, json_mode=False))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"hf: {exc}")
                log.warning("Hugging Face router failed: %s", exc)
        if settings.hf_local_model and has_module("transformers"):
            try:
                return extract_json(_local_generate(messages, max_tokens, temperature))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"local: {exc}")
                log.warning("Local model failed: %s", exc)
    if errors:
        log.error("All LLM providers failed: %s", " | ".join(errors))
    return None


def _openai_compatible(
    url: str,
    key: str,
    model: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    json_mode: bool,
    attempts: int = 4,
) -> str:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    delay = 2.0
    for attempt in range(attempts):
        with httpx.Client(timeout=90) as client:
            resp = client.post(url, headers=headers, json=payload)
        if resp.status_code == 200:
            return resp.json()["choices"][0]["message"]["content"]
        body = resp.text[:300]
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = _retry_after(resp) or delay
            if wait > 65 or attempt == attempts - 1:  # free tiers reset per minute
                raise LLMError(f"HTTP {resp.status_code} (rate limited/unavailable): {body}")
            time.sleep(wait)
            delay *= 2
            continue
        if resp.status_code == 400 and json_mode and "json" in body.lower() and attempt == 0:
            # Some models reject json mode or produce "json_validate_failed" -> retry without it.
            payload.pop("response_format", None)
            continue
        raise LLMError(f"HTTP {resp.status_code}: {body}")
    raise LLMError("exhausted retries")


def _retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("retry-after")
    try:
        return float(value) if value else None
    except ValueError:
        return None


@lru_cache(maxsize=1)
def _local_pipeline():
    from transformers import pipeline

    log.info("Loading local model %s", settings.hf_local_model)
    return pipeline("text-generation", model=settings.hf_local_model, device_map="auto")


def _local_generate(messages: list[dict], max_tokens: int, temperature: float) -> str:
    pipe = _local_pipeline()
    out = pipe(messages, max_new_tokens=max_tokens, do_sample=temperature > 0, temperature=max(temperature, 0.01))
    generated = out[0]["generated_text"]
    if isinstance(generated, list):  # chat format returns the whole conversation
        return generated[-1]["content"]
    return str(generated)


def compact(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

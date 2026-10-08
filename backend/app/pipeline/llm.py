"""
Layer 4 — LLM integration (Groq first, open-source fallbacks second).

Two kinds of calls:

* `complete()` / `stream()` — ONE attempt, streamed, with a hard deadline. Used by the
  map labeller (one call per map) and the node chatbot (one call per message).
  A timeout, 429 or any error returns what arrived so far (possibly nothing) —
  callers always have a heuristic fallback, so there are no sleeping retries.
* `chat_json()` — user-triggered actions (AI refine, study set). Provider chain:
  Groq main model → Groq fallback model → Hugging Face router → local transformers.

One module-level keep-alive `httpx.Client` is shared by every call, and every call
is counted (calls / prompt tokens / completion tokens) so usage is visible in logs.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable, Iterator

import httpx

from ..config import has_module, settings
from .text_utils import extract_json

log = logging.getLogger("tubemind.llm")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models"
HF_URL = "https://router.huggingface.co/v1/chat/completions"

# Fastest reliable first (id prefixes; the newest live version wins). Non-reasoning models are
# preferred; reasoning ones run with reasoning switched off / low (see `reasoning_params`).
FAST_MODEL_PREFERENCE = ["llama-3.1-8b-instant", "qwen/qwen3", "llama-3.3-70b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"]

_semaphore = threading.BoundedSemaphore(4)
_client: httpx.Client | None = None
_client_lock = threading.Lock()
_stats_lock = threading.Lock()
STATS = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "errors": 0}
_groq_models: list[str] | None = None
_cooldown_until = 0.0  # after a 429 the provider is skipped (0 calls) until this monotonic time
DEFAULT_COOLDOWN = 20.0


class LLMError(RuntimeError):
    pass


@dataclass
class Completion:
    text: str
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    ms: float = 0.0
    error: str | None = None
    partial: bool = False  # deadline hit mid-stream: `text` holds what arrived
    sent: bool = False  # a request actually went out (False: no LLM configured / cooling down)

    @property
    def ok(self) -> bool:
        return self.error is None and not self.partial


def client() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(
                timeout=httpx.Timeout(30.0, connect=5.0),
                limits=httpx.Limits(max_connections=16, max_keepalive_connections=8, keepalive_expiry=120),
            )
        return _client


# ---------------------------------------------------------------------------
# Provider / model selection
# ---------------------------------------------------------------------------
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


def fast_model() -> str:
    """Model used for map labels and the node chatbot (latency matters more than depth)."""
    if settings.groq_label_model:
        return settings.groq_label_model
    if _groq_models is None and settings.groq_enabled:
        warm_up()  # learn which models are live (normally already done at server start)
    live = _groq_models or []
    if not live:
        return FAST_MODEL_PREFERENCE[0]
    for prefix in FAST_MODEL_PREFERENCE:
        matches = sorted((m for m in live if m.startswith(prefix)), reverse=True)
        if matches:
            return matches[0]
    return settings.groq_model


def fast_provider() -> tuple[str, str, str] | None:
    """(url, key, model) for single-shot calls, or None when no remote LLM is configured."""
    if settings.groq_enabled:
        return GROQ_URL, settings.groq_api_key, fast_model()
    if settings.hf_token:
        return HF_URL, settings.hf_token, settings.hf_model
    return None


def fast_available() -> bool:
    return fast_provider() is not None


def fast_name() -> str:
    p = fast_provider()
    return f"{'groq' if p[0] == GROQ_URL else 'huggingface'}:{p[2]}" if p else "heuristic"


def warm_up() -> None:
    """Open the keep-alive connection (TLS handshake) and learn which Groq models are live."""
    global _groq_models
    if not settings.groq_enabled:
        return
    try:
        resp = client().get(GROQ_MODELS_URL, headers=_headers(settings.groq_api_key), timeout=5)
        _groq_models = sorted(m["id"] for m in resp.json().get("data", [])) if resp.status_code == 200 else []
    except Exception as exc:  # noqa: BLE001 - warm-up is best effort
        _groq_models = []
        log.info("LLM warm-up skipped: %s", exc)
    log.info("LLM warm: fast model %s", fast_model())


def reasoning_params(model: str) -> dict:
    """Keep hidden 'thinking' tokens (latency + cost) to a minimum on reasoning models."""
    m = model.lower()
    if "gpt-oss" in m:
        return {"reasoning_effort": "low", "include_reasoning": False}
    if "qwen3" in m:
        return {"reasoning_effort": "none"}
    if "deepseek-r1" in m:
        return {"reasoning_format": "hidden"}
    return {}


def _headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _count(c: Completion) -> None:
    with _stats_lock:
        STATS["calls"] += 1
        STATS["prompt_tokens"] += c.prompt_tokens
        STATS["completion_tokens"] += c.completion_tokens
        STATS["errors"] += 1 if c.error else 0


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


# ---------------------------------------------------------------------------
# Single-shot streamed calls (labels, chat)
# ---------------------------------------------------------------------------
def stream(
    messages: list[dict],
    *,
    max_tokens: int,
    temperature: float = 0.2,
    timeout: float = 3.0,
    result: Completion | None = None,
) -> Iterator[str]:
    """
    Yield text deltas from ONE streamed request. Never raises: errors, 429s and the
    deadline end the stream early and are recorded in `result` (pass one in to read
    usage/errors afterwards). No retries, no sleeping.
    """
    out = result if result is not None else Completion("")
    provider = fast_provider()
    if provider is None:
        out.error = "no LLM configured"
        return
    url, key, model = provider
    out.model = model
    if time.monotonic() < _cooldown_until:
        out.error = "rate limited (cooling down)"
        return
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        **reasoning_params(model),
    }
    started = time.monotonic()
    deadline = started + timeout
    parts: list[str] = []
    usage: dict = {}
    out.sent = True
    try:
        with _semaphore:
            for attempt in range(2):
                req_timeout = httpx.Timeout(max(0.5, deadline - time.monotonic()), connect=min(2.0, timeout))
                with client().stream("POST", url, headers=_headers(key), json=payload, timeout=req_timeout) as resp:
                    if resp.status_code == 400 and attempt == 0 and any(k in payload for k in ("reasoning_effort", "include_reasoning", "reasoning_format")):
                        # model rejected the reasoning knobs: resend once without them (no tokens were spent)
                        resp.read()
                        for k in ("reasoning_effort", "include_reasoning", "reasoning_format"):
                            payload.pop(k, None)
                        continue
                    if resp.status_code != 200:
                        resp.read()
                        out.error = f"HTTP {resp.status_code}: {resp.text[:160]}"
                        if resp.status_code == 429:
                            _cool_down(resp)
                        break
                    for line in resp.iter_lines():
                        if time.monotonic() > deadline:
                            out.partial = True
                            out.error = "deadline"
                            break
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        usage = chunk.get("usage") or (chunk.get("x_groq") or {}).get("usage") or usage
                        for choice in chunk.get("choices") or []:
                            delta = (choice.get("delta") or {}).get("content")
                            if delta:
                                parts.append(delta)
                                yield delta
                    break
    except httpx.TimeoutException:
        out.partial, out.error = bool(parts), "timeout"
    except Exception as exc:  # noqa: BLE001 - never break the caller
        out.error = f"{type(exc).__name__}: {exc}"
    finally:
        out.text = "".join(parts)
        out.ms = (time.monotonic() - started) * 1000
        prompt_chars = sum(len(m.get("content", "")) for m in messages)
        out.prompt_tokens = int(usage.get("prompt_tokens") or max(1, prompt_chars // 4))
        out.completion_tokens = int(usage.get("completion_tokens") or (estimate_tokens(out.text) if out.text else 0))
        _count(out)
        if out.error:
            log.warning("LLM %s: %s after %.0f ms (%d chars kept)", model, out.error, out.ms, len(out.text))


def complete(system: str, user: str, *, max_tokens: int, temperature: float = 0.2, timeout: float = 3.0,
             on_text: Callable[[str], None] | None = None) -> Completion:
    """One streamed call collected into a `Completion` (partial text is kept on timeout)."""
    result = Completion("")
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    for delta in stream(messages, max_tokens=max_tokens, temperature=temperature, timeout=timeout, result=result):
        if on_text:
            on_text(delta)
    return result


# ---------------------------------------------------------------------------
# JSON calls for user-triggered features (refine, study)
# ---------------------------------------------------------------------------
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
    attempts: int = 2,
    max_wait: float = 3.0,
) -> str:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        **reasoning_params(model),
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    started = time.monotonic()
    for attempt in range(attempts):
        resp = client().post(url, headers=_headers(key), json=payload, timeout=60)
        if resp.status_code == 200:
            data = resp.json()
            usage = data.get("usage") or {}
            _count(Completion("", model, int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0), (time.monotonic() - started) * 1000))
            return data["choices"][0]["message"]["content"]
        body = resp.text[:300]
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = _retry_after(resp) or 1.0
            if wait > max_wait or attempt == attempts - 1:  # user is waiting: fail fast
                raise LLMError(f"HTTP {resp.status_code} (rate limited/unavailable): {body}")
            time.sleep(wait)
            continue
        if resp.status_code == 400 and attempt == 0:
            low = body.lower()
            if json_mode and "json" in low:
                # Some models reject json mode or produce "json_validate_failed" -> retry without it.
                payload.pop("response_format", None)
                continue
            if "reasoning" in low:
                for k in ("reasoning_effort", "include_reasoning", "reasoning_format"):
                    payload.pop(k, None)
                continue
        raise LLMError(f"HTTP {resp.status_code}: {body}")
    raise LLMError("exhausted retries")


def _cool_down(resp: httpx.Response) -> None:
    global _cooldown_until
    wait = min(_retry_after(resp) or DEFAULT_COOLDOWN, 120.0)
    _cooldown_until = time.monotonic() + wait
    log.info("LLM rate limited: single-shot calls paused for %.0f s", wait)


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

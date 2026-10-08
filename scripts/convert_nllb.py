"""
One-time setup: download facebook/nllb-200-distilled-600M and convert it to a
CTranslate2 int8 model for fast CPU inference.

    pip install ctranslate2==4.6.0 sentencepiece==0.2.0 transformers torch   # conversion only
    python scripts/convert_nllb.py                                          # -> backend/data/models/nllb-200-distilled-600M-ct2-int8

The backend only needs `ctranslate2` + `sentencepiece` at runtime (no torch, no
transformers). Point NLLB_MODEL_PATH at another folder to keep the model elsewhere.
The model is pretrained: nothing is trained or fine-tuned here.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "backend" / "data" / "models" / "nllb-200-distilled-600M-ct2-int8"
MODEL = "facebook/nllb-200-distilled-600M"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--quantization", default="int8")
    parser.add_argument("--force", action="store_true", help="overwrite an existing output folder")
    args = parser.parse_args()

    try:
        from ctranslate2.converters import TransformersConverter
        from huggingface_hub import hf_hub_download
    except ImportError as exc:
        print(f"Missing dependency: {exc}. Install: pip install ctranslate2 sentencepiece transformers torch", file=sys.stderr)
        return 1

    if (args.out / "model.bin").exists() and not args.force:
        print(f"Already converted: {args.out}")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    _transformers5_shim()
    print(f"Converting {args.model} -> {args.out} ({args.quantization}); the first run downloads ~2.5 GB")
    TransformersConverter(args.model).convert(str(args.out), quantization=args.quantization, force=True)
    # the runtime tokenizer is plain sentencepiece: keep its model next to the weights
    spm = hf_hub_download(args.model, "sentencepiece.bpe.model")
    shutil.copy(spm, args.out / "sentencepiece.bpe.model")
    print("Done.")
    return 0


def _transformers5_shim() -> None:
    """ctranslate2 4.6 reads `tokenizer.additional_special_tokens`, renamed `extra_special_tokens` in transformers 5."""
    try:
        import transformers
        from transformers import NllbTokenizer
    except ImportError:
        return
    for cls in (NllbTokenizer, getattr(transformers, "NllbTokenizerFast", None)):
        if cls is not None and not hasattr(cls, "additional_special_tokens"):
            cls.additional_special_tokens = property(lambda self: list(getattr(self, "extra_special_tokens", None) or []))


if __name__ == "__main__":
    sys.exit(main())

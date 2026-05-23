"""Totem name OCR.

Reads the "The ..." title shown on the totem card in screenshots.
Designed to work on Linux and Windows, and to be packagable with PyInstaller
later (we keep imports lazy and avoid platform-specific paths).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PIL import Image

_TITLE_RE = re.compile(r"\bTHE\s+[A-Z][A-Z'\-]*(?:\s+[A-Z][A-Z'\-]*)*", re.IGNORECASE)

_reader = None


def _get_reader():
    """Lazy-init EasyOCR reader (heavy import, ~1GB model download on first run)."""
    global _reader
    if _reader is None:
        import easyocr  # imported lazily so --help etc. stays fast
        _reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _reader


@dataclass
class OcrResult:
    title: Optional[str]
    raw_lines: list[str]


def _crop_title_region(img: Image.Image) -> Image.Image:
    """Crop the top-center region where the totem card title sits.

    The card is roughly centered horizontally and in the top ~30% of the frame.
    We keep the crop generous so it works at different aspect ratios (16:9, 21:9).
    """
    w, h = img.size
    left = int(w * 0.35)
    right = int(w * 0.65)
    top = int(h * 0.05)
    bottom = int(h * 0.30)
    return img.crop((left, top, right, bottom))


def read_totem_title(image_path: str | Path) -> OcrResult:
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(path)

    img = Image.open(path).convert("RGB")
    crop = _crop_title_region(img)

    reader = _get_reader()
    # EasyOCR accepts numpy arrays; convert via PIL -> numpy
    import numpy as np
    results = reader.readtext(np.array(crop), detail=1, paragraph=False)

    lines = [text for (_box, text, _conf) in results]

    title = None
    for line in lines:
        m = _TITLE_RE.search(line)
        if m:
            title = m.group(0).upper()
            break

    # Fallback: join all lines and search (handles cases where "THE" and the
    # name land on different OCR boxes)
    if title is None:
        joined = " ".join(lines)
        m = _TITLE_RE.search(joined)
        if m:
            title = m.group(0).upper()

    return OcrResult(title=title, raw_lines=lines)

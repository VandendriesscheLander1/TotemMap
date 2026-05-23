"""Read the embedded `P:x,y,z` comment from Soulframe JPEG screenshots.

Mirrors the JS implementation in app.js (readJpegCommentFromHeader): scans the
JPEG header for the 0xFFFE COM marker and decodes the comment payload.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

_P_RE = re.compile(r"P:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)")


@dataclass
class Coords:
    x: float
    y: float
    z: float


def _read_jpeg_comment(data: bytes) -> str:
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        raise ValueError("not a JPEG")
    i = 2
    n = len(data)
    while i < n - 4:
        if data[i] != 0xFF:
            break
        marker = data[i + 1]
        if marker in (0xD8, 0xD9):
            i += 2
            continue
        seg_len = (data[i + 2] << 8) | data[i + 3]
        if marker == 0xFE:  # COM
            return data[i + 4: i + 2 + seg_len].decode("utf-8", errors="replace")
        if marker == 0xDA:  # SOS — image data starts, stop scanning headers
            break
        i += 2 + seg_len
    return ""


def read_game_coords(path: str | Path, header_bytes: int = 262_144) -> Optional[Coords]:
    """Return (x, y, z) game coords from the JPEG comment, or None if absent."""
    p = Path(path)
    with p.open("rb") as f:
        head = f.read(header_bytes)
    try:
        comment = _read_jpeg_comment(head)
    except ValueError:
        return None
    m = _P_RE.search(comment)
    if not m:
        return None
    return Coords(float(m.group(1)), float(m.group(2)), float(m.group(3)))

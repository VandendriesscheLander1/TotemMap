"""Fuzzy-match an OCR'd title (e.g. "THE MERCURIAL") against the totem catalog."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from rapidfuzz import fuzz, process


@dataclass
class Totem:
    id: str
    animal: str
    weapon_type: str
    display_name: str
    rarity: str


def load_totems(path: str | Path) -> list[Totem]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return [
        Totem(
            id=t["id"],
            animal=t["animal"],
            weapon_type=t.get("weaponType", ""),
            display_name=t["displayName"],
            rarity=t.get("rarity", "Common"),
        )
        for t in raw
    ]


@dataclass
class MatchResult:
    score: int
    matches: list[Totem]  # all totems sharing the best displayName match


def match_title(title: str, totems: list[Totem], threshold: int = 70) -> MatchResult | None:
    """Find totems whose displayName best matches the OCR'd title.

    Returns all totems sharing the top displayName so the caller can prompt the
    user when the same name exists for multiple animals.
    """
    if not title:
        return None
    q = title.casefold()
    by_key: dict[str, str] = {}
    for t in totems:
        by_key.setdefault(t.display_name.casefold(), t.display_name)
    best = process.extractOne(q, list(by_key.keys()), scorer=fuzz.WRatio, score_cutoff=threshold)
    if not best:
        return None
    key, score, _ = best
    name = by_key[key]
    matches = [t for t in totems if t.display_name == name]
    return MatchResult(score=int(score), matches=matches)

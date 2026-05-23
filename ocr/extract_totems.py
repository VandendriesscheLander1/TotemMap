"""Parse ../temp.lua into ocr/totems.json so the watcher doesn't depend on the
.lua file at runtime (makes packaging the exe self-contained).

Run after temp.lua changes:
    python extract_totems.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).parent
LUA_PATH = HERE.parent / "temp.lua"
OUT_PATH = HERE / "totems.json"

BLOCK_RE = re.compile(r'\["(\w+)\s+Totem"\]\s*=\s*\{\{([\s\S]*?)\}\}\s*,?')
SPLIT_RE = re.compile(r'\}\s*,\s*\{')


def _field(entry: str, key: str) -> str:
    m = re.search(rf'{key}\s*=\s*"([^"]*)"', entry)
    return m.group(1) if m else ""


def parse_catalog(lua_text: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for m in BLOCK_RE.finditer(lua_text):
        animal = "Deer" if m.group(1) == "Fawn" else m.group(1)
        body = m.group(2)
        arr = []
        for part in SPLIT_RE.split(body):
            tid = _field(part, "id")
            if not tid:
                continue
            arr.append({
                "id": tid,
                "animal": animal,
                "weaponType": _field(part, "weaponType"),
                "displayName": _field(part, "displayName"),
                "description": _field(part, "description"),
                "rarity": _field(part, "rarity") or "Common",
            })
        if arr:
            out[animal] = arr
    return out


def main() -> int:
    text = LUA_PATH.read_text(encoding="utf-8")
    catalog = parse_catalog(text)
    flat = [t for arr in catalog.values() for t in arr]
    OUT_PATH.write_text(json.dumps(flat, indent=2), encoding="utf-8")
    print(f"wrote {OUT_PATH} — {len(flat)} totems across {len(catalog)} animals")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

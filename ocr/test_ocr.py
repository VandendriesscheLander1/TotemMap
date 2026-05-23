"""Quick test runner: python test_ocr.py <image_path>"""
from __future__ import annotations

import sys
from pathlib import Path

from totem_ocr import read_totem_title


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: python test_ocr.py <image_path>")
        return 2

    image_path = Path(argv[1])
    result = read_totem_title(image_path)

    print(f"image: {image_path}")
    print(f"raw lines ({len(result.raw_lines)}):")
    for line in result.raw_lines:
        print(f"  - {line!r}")
    print()
    if result.title:
        print(f"detected title: {result.title}")
        return 0
    print("detected title: <none>")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

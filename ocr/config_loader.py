"""Load runtime configuration.

User-tunable settings live in `config.json` next to the exe (or script).
On first launch (or if the watch folder is missing/invalid) a small Tk dialog
asks the user to pick their screenshot folder, then writes config.json.

Supabase credentials and VERSION are baked into the binary — see constants.py.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_FUZZY_THRESHOLD = 70


@dataclass
class AppConfig:
    watch_folder: Path
    totems_json_path: Path
    fuzzy_threshold: int


def _frozen() -> bool:
    return getattr(sys, "frozen", False)


def _app_dir() -> Path:
    """Directory the user sees — where config.json is read/written."""
    if _frozen():
        return Path(sys.executable).parent
    return Path(__file__).parent


def _bundle_dir() -> Path:
    """Directory of bundled read-only data (totems.json)."""
    if _frozen():
        # PyInstaller onefile extracts data here; onedir uses the exe dir.
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).parent


def _prompt_for_folder(initial: str | None = None) -> Path | None:
    """Open a native folder picker. Returns None if the user cancels."""
    import tkinter as tk
    from tkinter import filedialog, messagebox

    root = tk.Tk()
    root.withdraw()
    try:
        messagebox.showinfo(
            "TotemMap setup",
            "Pick the folder where Soulframe saves your screenshots.\n\n"
            "(Usually something like C:\\Users\\<you>\\Pictures\\Soulframe)",
        )
        picked = filedialog.askdirectory(
            title="Select your Soulframe screenshot folder",
            initialdir=initial or str(Path.home()),
            mustexist=True,
        )
    finally:
        root.destroy()

    return Path(picked) if picked else None


def _write_config(path: Path, cfg: dict) -> None:
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def load() -> AppConfig:
    app_dir = _app_dir()
    cfg_path = app_dir / "config.json"

    cfg: dict = {}
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            cfg = {}

    watch_str = cfg.get("watch_folder", "")
    watch = Path(watch_str) if watch_str else None

    if watch is None or not watch.is_dir():
        picked = _prompt_for_folder(initial=watch_str or None)
        if picked is None:
            raise SystemExit("No screenshot folder selected — exiting.")
        watch = picked
        cfg["watch_folder"] = str(watch)
        cfg.setdefault("fuzzy_threshold", DEFAULT_FUZZY_THRESHOLD)
        _write_config(cfg_path, cfg)

    return AppConfig(
        watch_folder=watch,
        totems_json_path=(_bundle_dir() / "totems.json").resolve(),
        fuzzy_threshold=int(cfg.get("fuzzy_threshold", DEFAULT_FUZZY_THRESHOLD)),
    )

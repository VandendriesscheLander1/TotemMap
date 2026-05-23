"""Watch a folder for new Soulframe screenshots and auto-upload totem locations.

For each NEW jpeg (only files arriving after start):
  1. Read embedded `P:x,y,z` game coords (skip if absent).
  2. OCR the totem title in the top-center of the image.
  3. Fuzzy-match against totems.json.
  4. If the totem name maps to multiple animals, prompt in the terminal.
  5. Insert into Supabase (same shape as the web app).

Run:
    python watcher.py
"""
from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path
from queue import Empty, Queue
from threading import Event, Thread

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from config_loader import load as load_config
from constants import SUPABASE_ANON_KEY, SUPABASE_TABLE, SUPABASE_URL, VERSION
from coords import read_game_coords
from matcher import Totem, load_totems, match_title
from sb import Insert, SupabaseClient
from totem_ocr import read_totem_title

JPEG_EXTS = {".jpg", ".jpeg"}


def _log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _wait_file_stable(path: Path, tries: int = 20, interval: float = 0.25) -> bool:
    """The game writes the JPEG progressively — wait until size stops changing."""
    last = -1
    for _ in range(tries):
        try:
            cur = path.stat().st_size
        except FileNotFoundError:
            return False
        if cur > 0 and cur == last:
            return True
        last = cur
        time.sleep(interval)
    return last > 0


class NewFileHandler(FileSystemEventHandler):
    def __init__(self, q: "Queue[Path]"):
        self.q = q

    def on_created(self, event):
        if event.is_directory:
            return
        p = Path(event.src_path)
        if p.suffix.lower() in JPEG_EXTS:
            self.q.put(p)

    def on_moved(self, event):
        # Some apps write to a temp name then rename — treat the destination as new.
        if event.is_directory:
            return
        p = Path(event.dest_path)
        if p.suffix.lower() in JPEG_EXTS:
            self.q.put(p)


def _pick_animal(matches: list[Totem]) -> Totem | None:
    print()
    print(f"  Multiple animals share \"{matches[0].display_name}\":")
    for i, t in enumerate(matches, 1):
        print(f"    {i}) {t.animal:8} · {t.weapon_type:12} · {t.rarity}")
    print(f"    0) skip this screenshot")
    while True:
        try:
            choice = input("  pick > ").strip()
        except EOFError:
            return None
        if choice == "0":
            return None
        if choice.isdigit():
            n = int(choice)
            if 1 <= n <= len(matches):
                return matches[n - 1]
        print("  invalid, try again")


def _process(path: Path, totems: list[Totem], threshold: int, sb: SupabaseClient) -> None:
    if not _wait_file_stable(path):
        _log(f"skip (file never stabilized): {path.name}")
        return

    coords = read_game_coords(path)
    if coords is None:
        _log(f"skip (no P:x,y,z coords): {path.name}")
        return

    try:
        ocr = read_totem_title(path)
    except Exception as e:
        _log(f"OCR failed for {path.name}: {e}")
        return

    if not ocr.title:
        _log(f"skip (no title detected): {path.name} — raw: {ocr.raw_lines}")
        return

    result = match_title(ocr.title, totems, threshold=threshold)
    if not result:
        _log(f"no match for \"{ocr.title}\" (threshold {threshold}): {path.name}")
        return

    if len(result.matches) == 1:
        chosen = result.matches[0]
    else:
        chosen = _pick_animal(result.matches)
        if chosen is None:
            _log(f"skipped by user: {path.name}")
            return

    item = Insert(
        animal=chosen.animal,
        totem_id=chosen.id,
        display_name=chosen.display_name,
        weapon_type=chosen.weapon_type,
        rarity=chosen.rarity,
        game_x=coords.x,
        game_z=coords.z,
        file=path.name,
    )
    try:
        sb.insert_location(item)
    except Exception as e:
        _log(f"DB insert failed for {path.name}: {e}")
        return

    _log(
        f"+ {chosen.animal:8} {chosen.display_name!r:24} "
        f"({coords.x:.1f}, {coords.z:.1f}) [score {result.score}] {path.name}"
    )


def _worker(q: "Queue[Path]", stop: Event, totems: list[Totem], threshold: int, sb: SupabaseClient) -> None:
    while not stop.is_set():
        try:
            path = q.get(timeout=0.5)
        except Empty:
            continue
        try:
            _process(path, totems, threshold, sb)
        except Exception:
            _log(f"unexpected error processing {path}:\n{traceback.format_exc()}")
        finally:
            q.task_done()


def main() -> int:
    _log(f"TotemMap watcher {VERSION}")
    cfg = load_config()

    watch = cfg.watch_folder
    if not watch.exists():
        _log(f"watch folder does not exist: {watch}")
        return 1

    totems = load_totems(cfg.totems_json_path)
    _log(f"loaded {len(totems)} totems from {cfg.totems_json_path.name}")

    sb = SupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_TABLE)
    try:
        sb.sign_in_anonymous()
        _log("supabase: signed in anonymously")
    except Exception as e:
        _log(f"supabase auth failed (will retry inserts as apikey-only): {e}")

    q: Queue[Path] = Queue()
    stop = Event()

    handler = NewFileHandler(q)
    obs = Observer()
    obs.schedule(handler, str(watch), recursive=False)
    obs.start()
    _log(f"watching: {watch}  (only files created AFTER now will be processed)")

    worker = Thread(target=_worker, args=(q, stop, totems, cfg.fuzzy_threshold, sb), daemon=True)
    worker.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        _log("stopping…")
    finally:
        stop.set()
        obs.stop()
        obs.join()
        worker.join(timeout=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())

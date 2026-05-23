"""Tiny Supabase client over PostgREST.

Uses plain `requests` (no supabase-py) to keep the PyInstaller bundle small.
Performs an anonymous sign-in so inserts authenticate as the same role the web
app uses.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Optional

import requests

from constants import VERSION


@dataclass
class Insert:
    animal: str
    totem_id: str
    display_name: str
    weapon_type: str
    rarity: str
    game_x: float
    game_z: float
    file: str


class SupabaseClient:
    def __init__(self, url: str, anon_key: str, table: str):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.table = table
        self._access_token: Optional[str] = None

    def sign_in_anonymous(self) -> None:
        """Mirror sb.auth.signInAnonymously() from the web app."""
        r = requests.post(
            f"{self.url}/auth/v1/signup",
            headers={"apikey": self.anon_key, "Content-Type": "application/json"},
            json={"data": {}},
            timeout=15,
        )
        # Some Supabase projects expose anonymous sign-in via /auth/v1/token?grant_type=anonymous;
        # fall back to that if signup is disabled.
        if r.status_code >= 400:
            r = requests.post(
                f"{self.url}/auth/v1/token?grant_type=anonymous",
                headers={"apikey": self.anon_key, "Content-Type": "application/json"},
                json={},
                timeout=15,
            )
        r.raise_for_status()
        body = r.json()
        token = body.get("access_token") or body.get("session", {}).get("access_token")
        if not token:
            # No auth required (RLS open) — proceed with apikey only.
            return
        self._access_token = token

    def _headers(self) -> dict[str, str]:
        h = {
            "apikey": self.anon_key,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }
        h["Authorization"] = f"Bearer {self._access_token or self.anon_key}"
        return h

    def insert_location(self, item: Insert) -> None:
        row = {
            "id": str(uuid.uuid4()),
            "animal": item.animal,
            "totem_id": item.totem_id,
            "display_name": item.display_name,
            "weapon_type": item.weapon_type,
            "rarity": item.rarity,
            "game_x": item.game_x,
            "game_z": item.game_z,
            "file": item.file,
            "version": VERSION,
        }
        r = requests.post(
            f"{self.url}/rest/v1/{self.table}",
            headers=self._headers(),
            data=json.dumps(row),
            timeout=15,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"insert failed {r.status_code}: {r.text}")

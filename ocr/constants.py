"""Build-time constants baked into the exe.

VERSION is bumped per release so uploads can be cross-referenced with the web
app's expected schema. Supabase URL/anon key are public (RLS protects writes),
so it's safe to ship them in the binary.
"""
from __future__ import annotations

VERSION = "P14.5"

SUPABASE_URL = "https://qnkkbrjpdblhvfsdiqmi.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_6INcIFb66Ed-P95W9nnpbw_NfBYbmT0"
SUPABASE_TABLE = "locations"

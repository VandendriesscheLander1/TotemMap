# TotemMap

An interactive map tool for tracking Soulframe totem drop locations. Drop in-game screenshots with embedded coordinates, tag which totem dropped, and see all your finds plotted on the world map — shared live with others via Supabase.

## Features

- **Screenshot ingestion** — drop JPEG screenshots with embedded `P: x, y, z` coordinate comments; coordinates are extracted from the JPEG header without reading the full file
- **OCR auto-detection** — Tesseract.js scans the bottom strip of each screenshot and fuzzy-matches the totem name, offering a one-tap confirm so you skip most manual clicks
- **Interactive map** — pan (drag) and zoom (scroll wheel) the stitched world map; markers scale relative to zoom level
- **Totem picker modal** — two-step flow: pick the animal, then pick the specific totem grouped by rarity (Rare → Uncommon → Common)
- **Filters** — hide/show by animal, rarity, or weapon type; toggle map labels; filters persist in `localStorage`
- **Search** — live search across totem names and animal types
- **Cloud sync** — optional Supabase backend; inserts/deletes propagate to all open tabs in real time via Postgres change subscriptions
- **Offline fallback** — if Supabase is not configured, everything saves to browser `localStorage`

## Setup

### 1. Required files

| File | Description |
|---|---|
| `Images/Map/stitched_final.jpg` | The stitched world map image |
| `calibration.json` | Coordinate transform (`{ "transform": { "a", "b", "c", "d", "tx", "ty" } }`) that maps game X/Z to map pixel X/Y |
| `temp.lua` | Stripped totem catalog (see below) |

If `calibration.json` is missing, the status bar will prompt you to load it manually. If the map image is missing, a message will appear on load.

### 2. Totem catalog (`temp.lua`)

The app reads a Lua catalog file containing all totem definitions. The raw game data file likely has many extra fields; use the bundled `strip_lua.js` script to produce a lean version with only the fields the app needs:

```
node strip_lua.js newfile.lua temp.lua
```

This keeps only `id`, `weaponType`, `displayName`, `description`, and `rarity` per entry and writes the result to `temp.lua`. Run this whenever the upstream data file is updated.

### 3. Cloud storage (optional)

Edit `config.js` and fill in your Supabase project details:

```js
window.TOTEMMAP_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-public-key',
  TABLE: 'locations',
};
```

Leave both values as empty strings to stay in local-only mode.

The Supabase `locations` table needs at minimum these columns: `id`, `animal`, `totem_id`, `display_name`, `weapon_type`, `rarity`, `game_x`, `game_z`, `file`, `added_at`, `version`.

### 4. Run

Open `index.html` in a browser — no build step required. For local file access (CORS when fetching `calibration.json` and `temp.lua`) use a simple local server:

```
npx serve .
# or
python -m http.server
```

## Usage

1. Open the app in your browser
2. Drop one or more Soulframe screenshots onto the drop zone (or the map itself)
3. The picker modal opens for each screenshot — confirm the OCR suggestion or manually select the animal and totem
4. The pin appears on the map and the entry is added to the sidebar list
5. Click a list entry to fly the map to that pin
6. Use the filter chips to hide animals, rarities, or weapon types you're not interested in
 
**Keyboard shortcuts in the picker modal:**

| Key | Action |
|---|---|
| `Enter` | Confirm OCR suggestion |
| `Esc` | Skip current screenshot |
| `Shift` + `Esc` | Cancel remaining screenshots |

## Project structure

```
index.html          entry point
styles.css          all styles
app.js              main application logic
config.js           Supabase credentials (edit this)
strip_lua.js        CLI utility — strips Lua catalog to minimal fields
temp.lua            stripped totem catalog (generated, not committed)
calibration.json    coordinate transform (not committed)
Images/
  Animals/          animal icon PNGs (Beaver, Deer, Duck, Rabbit, Rat, Squirrel)
  Map/              stitched world map
```

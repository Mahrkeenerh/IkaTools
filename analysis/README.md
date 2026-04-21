# Ikariam snapshot analysis

Standalone interactive dashboard over a full-scan export — global, no filtering.

## Usage

1. Run a full scan in-game and click **Export** in the popup to download `ikariam-{world}-{date}.json`.
2. Prep a slim data file:
   ```bash
   python3 prep.py /path/to/ikariam-s55-cz-2026-04-21.json
   ```
   Writes `data.json` next to `snapshot.html` (~2-3 MB).
3. Serve the folder (`file://` won't work — `fetch()` is blocked):
   ```bash
   python3 -m http.server 8000
   ```
   Open http://localhost:8000/snapshot.html

## Charts

1. **Score CDFs** — army, building, research, trader, place across all players.
2. **Building-level violins** — distribution of levels for each building type across all cities that have it.
3. **Meta-progression heatmap** — median building level per townHall bucket. Blank cells have < 10 cities.
4. **Drill-down scatter** — pick a building → its level vs townHall for every city with it, jittered, median + p25/p75 band overlay.
5. **Wonder adoption** — islands per wonder type, colored by avg wonder level.
6. **Long tails** — alliance city counts (top 50) and cities-per-island histogram.

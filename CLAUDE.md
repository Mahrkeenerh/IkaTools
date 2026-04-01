# Ikariam Tools

Chrome MV3 extension for the Ikariam browser game. Features: premium UI cleanup, CAPTCHA auto-solver (YOLOv8n/ONNX), world map scanner with minimap overlay, island info panel, auto-finish buildings, auto-pirate missions, trade history charts, upgrade resource info, wine timer.

## Tech Stack

- Vanilla JavaScript (ES2021+, no TypeScript, no frameworks)
- Chrome Extension Manifest V3
- ONNX Runtime Web (CAPTCHA inference via offscreen document)
- esbuild (bundles offscreen script + WASM)

## Commands

```bash
npm install        # Install deps (esbuild, onnxruntime-web)
npm run build      # Bundle offscreen.js + copy WASM to dist/
npm run package    # Build + zip release (ikariam-tools-v{version}.zip)
```

When the user asks for a "build", run `npm run package` to produce the release zip — not just `npm run build`.

No dev server — load unpacked extension directly from this directory in `chrome://extensions`.

## Releasing

1. Bump `version` in `manifest.json`
2. Run `npm run package` — builds dist/ and creates `ikariam-tools-v{version}.zip`
3. Create a GitHub release at https://github.com/Mahrkeenerh/IkaTools/releases/new
4. Tag: `v{version}`, attach the zip file

## Directory Structure

- `manifest.json` — Extension manifest (permissions, content scripts, popup)
- `background.js` — Service worker, routes messages, manages offscreen document (with ping/recreate)
- `content/` — Content scripts injected into game pages + shared modules
  - `utils.js` — Shared utilities (`globalThis.IkUtils`): bridge injection, world name, tile parsing, alliance helpers
  - `bridge.js` — Page-context script (CSP bypass), 7 event handlers for game function calls
  - `content.js` — CAPTCHA detection and solving orchestration
  - `cleanup.js` — Premium UI removal (shop, ambrosia, premium trader, ads)
  - `scanner.js` — World map scanning via game's coordinate navigation
  - `minimap.js` — In-game overlay with viewport tracking, click-to-navigate, layer/scale/collapse controls, dim empty islands
  - `maprender.js` — Shared map rendering engine (8 layers including alliances, isometric projection)
  - `islandinfo.js` — Island view: passive data extraction, sortable player panel, alliance labels on cities
  - `autofinish.js` — Auto-completes buildings when timer < 4m 55s (free finish)
  - `autopirate.js` — Auto-launches pirate raids when idle/unfocused, pirate toggle in game header bar
  - `gamenotes.js` — In-game notes toolbar button with floating panel, syncs with popup notes via chrome.storage
  - `tradehistory.js` — Trade snapshot persistence and history loading (`globalThis.TradeHistory`); loaded in game and in report.html
  - `tradechart.js` — Canvas-based IQR/sparkline chart rendering (`globalThis.TradeChart`); uses `TradeHistory.percentile`
  - `advisor.js` — Advisor toolbar with 7 report modes, data collection, progress bar
  - `upgradeinfo.js` — Injects missing-resource amounts onto building upgrade panels
  - `winetimer.js` — Shows wine stock duration in the resource bar
- `pages/` — Extension UI pages
  - `popup.html` / `popup.js` — Extension popup (scan, gallery with layer thumbnails, settings)
  - `report.html` / `report.js` — Advisor report page: multi-city data summary, trading history charts
  - `offscreen.html` — Offscreen document for ONNX inference
  - `inference.js` — YOLOv8n pre/postprocessing for CAPTCHA
- `src/offscreen.js` — ONNX runtime entry point (bundled by esbuild to dist/)
- `model/model.onnx` — CAPTCHA solver model (12 MB binary)
- `icons/` — Extension icons and resource images
- `dist/` — Build output (WASM binaries, bundled JS) — gitignored, regenerate with `npm run build`

## Architecture

- **CSP bypass**: `bridge.js` injected as external `<script src="chrome-extension://...">`, listens for 7 CustomEvents (`ik-jump`, `ik-ajax-call`, `ik-close-popup`, `ik-convert-crew`, `ik-read-cities`, `ik-read-island-data`, `ik-read-game-data`)
- **Scanner**: Dispatches `ik-jump` events → bridge calls `jumpToCoord()`. Diamond-shaped scan pattern with auto-detected stride. Restores position after scan.
- **Minimap**: Cached base map (rebuilds only on layer/scale/data/dimEmpty change), viewport overlay at ~30fps polling anchor tile `getBoundingClientRect`
- **Island info**: Parses `updateBackgroundData` JSON from inline `<script>` tags (not bridge), stores per-island in `island_{id}`, enriches world map with alliance data
- **Auto-pirate**: Polls every 5s when idle, navigates to pirate city via `ik-ajax-call`, opens fortress BootyQuest tab, triggers capture. Popup heartbeat suppresses takeover for 10s. Togglable from game header bar via `chrome.storage.onChanged`
- **Advisor toolbar**: Dropdown in `#GF_toolbar` (right of pirate toggle) with 7 report modes. Unicode block progress bar (█░) shows inline during collection. Calls `collectData()` directly (same content script context)
- **Notes toolbar**: Button in `#GF_toolbar` (left of pirate toggle) opens floating panel with sidebar + editor. Syncs bidirectionally with popup notes via `chrome.storage.onChanged`. "Hide game notes" setting hides `#GF_toolbar li.notes`
- **CAPTCHA**: content.js detects → background.js routes → offscreen ONNX inference → fills input
- **Storage**: `chrome.storage.local` — raw island data per world (`map_${worldName}`), per-island details (`island_{worldName}_{id}`), alliance index (`allianceIndex`), trade history chunks (`tradeHistory_{world}_{avatarId}_{YYYY-MM}`), trade history index (`tradeHistoryIdx_{world}_{avatarId}`), settings/toggles (global, not world-scoped)
  - Key convention: feature toggles/settings use camelCase with feature prefix (e.g., `pirateEnabled`, `minimapScale`); per-world data uses underscore separator with world name (e.g., `map_{worldName}`, `island_{worldName}_{id}`); settings are global (not world-scoped)

## Code Style

- 2-space indentation, double quotes, semicolons
- IIFEs for content scripts (isolated scope)
- `globalThis.IkUtils` / `globalThis.MapRender` / `globalThis.inference` / `globalThis.TradeHistory` / `globalThis.TradeChart` for shared modules
- camelCase variables/functions, UPPER_SNAKE_CASE constants
- Arrow functions for callbacks

## Isometric Coordinate System

- Game coords `[x:y]` → pixel: `px = (x-y)*tw/2, py = (x+y)*th/2`
- Reverse: `col = px/(2*120) + py/(2*60), row = py/(2*60) - px/(2*120)`
- Tile pixel spacing: col step (+120, +60), row step (-120, +60)
- Viewport corners: anchor tile screen pos + tile grid offset → reverse iso → game coords

## Gotchas

- `dist/` is gitignored — run `npm run build` before loading extension
- `model/model.onnx` is a 12 MB binary, not regenerated by build
- Viewport trim defaults (R:8%, B:15%) compensate for game rendering extra buffer tiles
- CAPTCHA auto-submit caps at 5 attempts, then switches to manual mode
- Multiple MutationObservers on `document.body` — be cautious adding more
- `avatarScores` values are 100x the game's displayed scores — divide by 100
- `viewAble: 2` does NOT mean own city — use `avatarId` from page script to detect own cities
- Service worker can die; background.js pings offscreen doc to check if alive before routing

## Git Conventions

Conventional commits: `feat:`, `fix:`, `refactor:` etc., lowercase after colon.

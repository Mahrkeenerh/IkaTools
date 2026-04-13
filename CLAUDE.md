# Ikariam Tools

Chrome MV3 extension for the Ikariam browser game. Features: premium UI cleanup, CAPTCHA auto-solver (CRNN+CTC ONNX model), world map scanner with minimap overlay, full-world player/score/alliance scan, rich-data filter panel with custom JS predicates, cultural treaty scanner and dedicated popup tab, island info panel, auto-finish buildings, auto-pirate missions, trade history charts, upgrade resource info, wine timer.

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
  - `utils.js` — Shared utilities (`globalThis.IkUtils`): bridge injection, URL/title world name, tile parsing, island bg-data parsing
  - `customeval.js` — Promise-based wrapper around bridge.js eval handlers (`globalThis.CustomEval`)
  - `bridge.js` — Page-context script (CSP bypass), 9 event handlers — includes `ik-eval-cmd` for power-user JS predicate compilation since MV3 extension CSP bans `unsafe-eval` in the content-script isolated world
  - `content.js` — CAPTCHA detection and solving orchestration
  - `cleanup.js` — Premium UI removal (shop, ambrosia, premium trader, ads)
  - `scanner.js` — World map scanning via game's coordinate navigation (`globalThis.IkScanner`)
  - `culturaltreaty.js` — Orchestrates the 2-phase full scan (DOM map scan then background-worker handoff for island fetches + CT check)
  - `mapfilter.js` — Pure synchronous filter engine (`globalThis.MapFilter`). Evaluates chip filters, parameterized rule rows, and custom JS predicates. All evaluation state is passed via a `ctx` parameter — no global mutable state. Also hosts `IkFilter` (DevTools power-user API) and `IkData` (query-index helper).
  - `filterrunner.js` — Shared async evaluation helpers (`globalThis.FilterRunner`). Compiles and evaluates custom JS textarea code and preset chips via the bridge, with version guards to prevent stale overwrites. Returns result Maps — does not store state.
  - `filterpanel.js` — In-game filter panel UI with chip groups, rule rows, Custom JS textarea, status footer (rich data freshness + match count)
  - `maprender.js` — Shared map rendering engine (8 layers including alliances, isometric projection)
  - `minimap.js` — In-game overlay with viewport tracking, click-to-navigate, layer/scale/collapse controls, dim empty/filtered islands. Keeps local filter evaluation state (custom results, preset results) and passes a `ctx` to `MapFilter.islandMatches`.
  - `islandfilter.js` — Per-city dimming on the island view. Builds virtual-island objects per city slot and keeps its own local filter evaluation state, independent of minimap. View-guarded event listeners prevent cross-view state corruption.
  - `islandinfo.js` — Island view: passive data extraction, sortable player panel, alliance labels on cities, writes to `island_{world}_{id}` and `allianceIndex_{world}`
  - `mapfilter.js` and `filterrunner.js` are loaded before `minimap.js` / `filterpanel.js` / `islandfilter.js` so they can read `globalThis.MapFilter` and `globalThis.FilterRunner`.
  - `autofinish.js` — Auto-completes buildings when timer < 4m 55s (free finish)
  - `autopirate.js` — Auto-launches pirate raids when idle/unfocused, pirate toggle in game header bar. Pauses only during the DOM scan phase, not the background fetch phases.
  - `gamenotes.js` — In-game notes toolbar button with floating panel, syncs with popup notes via chrome.storage
  - `tradehistory.js` — Trade snapshot persistence and history loading (`globalThis.TradeHistory`); loaded in game and in report.html
  - `tradechart.js` — Canvas-based IQR/sparkline chart rendering (`globalThis.TradeChart`); uses `TradeHistory.percentile`
  - `advisor.js` — Advisor toolbar with 7 report modes, data collection, progress bar
  - `upgradeinfo.js` — Injects missing-resource amounts onto building upgrade panels
  - `winetimer.js` — Shows wine stock duration in the resource bar
- `pages/` — Extension UI pages
  - `popup.html` / `popup.js` — Extension popup with Maps / CT / Pirate / Notes / Settings tabs. Maps tab triggers scans + shows gallery; CT tab shows last scan results with live alliance filter.
  - `report.html` / `report.js` — Advisor report page: multi-city data summary, trading history charts
  - `offscreen.html` — Offscreen document for ONNX inference
  - `inference.js` — CRNN+CTC pre/postprocessing for CAPTCHA (replaces earlier YOLOv8 pipeline)
- `src/offscreen.js` — ONNX runtime entry point (bundled by esbuild to dist/)
- `model/model.onnx` — CAPTCHA solver model (6.4 MB CRNN+CTC binary)
- `icons/` — Extension icons and resource images
- `docs/` — User-facing guides
  - `custom-js-filtering.md` — Custom JS filtering guide: available fields, examples, tips
- `dist/` — Build output (WASM binaries, bundled JS) — gitignored, regenerate with `npm run build`

## Architecture

- **CSP bypass**: `bridge.js` injected as external `<script src="chrome-extension://...">`, listens for 9 CustomEvents (`ik-jump`, `ik-ajax-call`, `ik-close-popup`, `ik-convert-crew`, `ik-read-cities`, `ik-read-island-data`, `ik-read-game-data`, `ik-read-world-islands`, `ik-eval-cmd`). The `ik-eval-cmd` handler exists because MV3 bans `'unsafe-eval'` in the extension CSP (content-script isolated world), but the page context is governed by Ikariam's CSP which has no such restriction — so `new Function(...)` is allowed there.
- **Scanner**: Exposes `IkScanner.scan(progressCb)` for reuse by the CT orchestrator. Dispatches `ik-jump` events → bridge calls `jumpToCoord()`. Row-by-row scan pattern with auto-detected stride. Restores position after scan.
- **Full scan pipeline**: `culturaltreaty.js` runs Phase 1 (DOM map scan via IkScanner) in the content script, then hands off Phase 2 (per-island HTML fetches) and Phase 3 (CT availability pings) to `background.js` so they survive page navigation. Stage-then-swap commit: no data is wiped until the new data is fully fetched, so cancelled/crashed scans never leave an empty world.
- **Rich-data query index**: `bgCommitIslandData` in background.js writes a derived `queryIndex_{world}` blob with `islandsByCoord → {allyTags, ownerNamesText, maxArmy, ctAvailable, …}`. The filter panel and minimap read from this single key instead of doing `get(null)` prefix scans.
- **Filter system**: 3-layer architecture. (1) `mapfilter.js` is a pure synchronous matcher — `islandMatches(isl, config, ctx)` takes a `ctx` with devtools predicate, custom results, and preset results as parameters (no global mutable state). (2) `filterrunner.js` provides shared async helpers (`evaluateCustom`, `evaluatePresets`) with version guards to prevent stale overwrites. (3) Each consumer (`minimap.js`, `islandfilter.js`) keeps its own local result maps and builds a `ctx` to pass to `islandMatches`. View-guarded event listeners prevent cross-view state corruption. `minimap.js` enriches stored world islands with `_allyTags / _ownerNamesText / _maxArmy / _ctAvailable / _ctChecked` from the query index. `islandfilter.js` builds virtual-island objects per city slot.
- **Custom JS eval**: filter panel → `CustomEval.compile(code)` → posts `ik-eval-cmd` → bridge.js compiles via `new Function` in page context → success/error response. On data or code change, consumers call `FilterRunner.evaluateCustom(islands, keyOf)` which returns a `Map<key, bool>` stored locally. The hot per-island `islandMatches()` path stays synchronous via the pre-computed result map in `ctx`.
- **Minimap**: Cached base map (rebuilds only on layer/scale/data/dimEmpty/allyVersion change), viewport overlay at ~30fps polling anchor tile `getBoundingClientRect`. Dim path uses a coord-keyed lookup into enriched stored islands (was O(n²) before via per-tile `.find()`).
- **Island info**: Parses `updateBackgroundData` JSON from inline `<script>` tags via `IkUtils.parseBackgroundData` (shared with `islandfilter.js`), stores per-island in `island_{world}_{id}`, enriches world map with alliance data.
- **Auto-pirate**: Polls every 5s when idle, navigates to pirate city via `ik-ajax-call`, opens fortress BootyQuest tab, triggers capture. Popup heartbeat suppresses takeover for 10s. Togglable from game header bar via `chrome.storage.onChanged`. Only pauses during `scanInProgress` (the DOM-jumping map scan); background fetch phases don't touch the page so pirates run during them.
- **Advisor toolbar**: Dropdown in `#GF_toolbar` (right of pirate toggle) with 7 report modes. Unicode block progress bar (█░) shows inline during collection. Calls `collectData()` directly (same content script context).
- **Notes toolbar**: Button in `#GF_toolbar` (left of pirate toggle) opens floating panel with sidebar + editor. Syncs bidirectionally with popup notes via `chrome.storage.onChanged`. "Hide game notes" setting hides `#GF_toolbar li.notes`.
- **CAPTCHA**: content.js detects → background.js routes → offscreen ONNX inference → fills input. Model is CRNN+BiLSTM with CTC decoding (48×256 grayscale input → 64 timesteps × 29 classes → greedy collapse).
- **Storage**: `chrome.storage.local` — see Storage Keys section below.
  - Key convention: feature toggles/settings use camelCase with feature prefix (e.g. `pirateEnabled`, `minimapScale`) and are **global** (not world-scoped). Per-world data uses underscore separator with the **URL-based** world name (e.g. `s55-cz`) from `getUrlWorldName()`. The title-based `getWorldName()` is only used for display (e.g. `reportData.world`).

## Storage Keys

| Key | Scope | Writer | Purpose |
|---|---|---|---|
| `map_{world}` | URL world | scanner, CT orchestrator, background commit | Lightweight world map (one row per island) |
| `island_{world}_{id}` | URL world | background full-scan commit, islandinfo passive | Rich per-island record (cities, owners, scores) |
| `allianceIndex_{world}` | URL world | background full-scan commit, islandinfo | Coord → `{counts, members, total}` |
| `queryIndex_{world}` | URL world | background full-scan commit, bgApplyCtToQueryIndex | Denormalized filter-ready blob used by rich-data filters |
| `ctScan_{world}` | URL world | background CT phase | Last CT scan result set (players, ctPlayers, allyCounts, timestamp, allyFilter, ownExcluded) |
| `spyLog_{world}` | URL world | spylog | Additive archive of espionage reports (units + resources), keyed by report ID |
| `mapIndex` | global | CT orchestrator | Gallery ordering (newest first) |
| `mapFilters` | global | filter panel | Filter config (groups, ops, enabled) |
| `customJsPresets` | global | filter panel | Saved JS preset chips `[{id, name, code}]` |
| `mapCustomPredicateCode` | global | filter panel | Source of the Custom JS predicate |
| `mapCustomPredicateEnabled` | global | filter panel | Custom JS toggle (default true) |
| `filterPanelCollapsed` | global | filter panel | UI state |
| `minimapEnabled` / `minimapPosition` / `minimapScale` / `minimapLayer` / `hideZeroCities` / `vpTrimRight` / `vpTrimBottom` | global | minimap | Minimap UI state |
| `scanInProgress` / `scanProgress` / `scanResult` | global (transient) | scanner | DOM scan coordination with popup |
| `ctScanRunning` / `ctScanProgress` | global (transient) | background | Background scan coordination |
| `friendList_{world}` / `friendSlots_{world}` | URL world | islandinfo | Friend player ID→name map and slot snapshots |
| `pirateCityId_{world}` / `pirateCities_{world}` | URL world | autopirate | Pirate city selection and cached city list |
| `advisorReportData_{world}` | URL world | advisor | Last advisor report data |
| `tradeHistory_{world}_{avatarId}_{YYYY-MM}` | URL world | tradehistory | Monthly trade history chunks |
| `tradeHistoryIdx_{world}_{avatarId}` | URL world | tradehistory | Index of available months |
| `pirateEnabled` / `pirateConvertEnabled` / `pirateSleepStart` / `pirateSleepEnd` / `pirateState` / `pirateIdleTimeout` + advanced timing params | global | autopirate | Pirate toggles and config |
| `devModeEnabled` | global | settings | Developer mode toggle (off by default, shows Captcha tab) |
| `captchaCollectEnabled` | global | captcha tab | Captcha data collection toggle (off by default) |
| `captchaLog` | global | content.js | Array of `{dataUrl, answer, success, timestamp}` entries |
| `cleanupEnabled` / `autoFinishEnabled` / `hideGameNotes` | global | settings | Feature toggles |
| `notes` | global | gamenotes / popup | Notes content |

## Code Style

- 2-space indentation, double quotes, semicolons
- IIFEs for content scripts (isolated scope)
- Shared modules on `globalThis`: `IkUtils`, `MapRender`, `MapFilter`, `FilterRunner`, `IkScanner`, `CustomEval`, `IkFilter` (DevTools power-user alias), `IkData` (query-index read helper), `IkFilterPanel` (match count + coord hook), `inference`, `TradeHistory`, `TradeChart`
- camelCase variables/functions, UPPER_SNAKE_CASE constants
- Arrow functions for callbacks

## Isometric Coordinate System

- Game coords `[x:y]` → pixel: `px = (x-y)*tw/2, py = (x+y)*th/2`
- Reverse: `col = px/(2*120) + py/(2*60), row = py/(2*60) - px/(2*120)`
- Tile pixel spacing: col step (+120, +60), row step (-120, +60)
- Viewport corners: anchor tile screen pos + tile grid offset → reverse iso → game coords

## Gotchas

- `dist/` is gitignored — run `npm run build` before loading extension
- `model/model.onnx` is a 6.4 MB CRNN+CTC binary, not regenerated by build
- Viewport trim defaults (R:8%, B:15%) compensate for game rendering extra buffer tiles
- CAPTCHA auto-submit caps at 5 attempts, then switches to manual mode
- Multiple MutationObservers on `document.body` — be cautious adding more
- `avatarScores` values are 100x the game's displayed scores — divide by 100
- `viewAble: 2` does NOT mean own city — use `avatarId` from page script to detect own cities
- Service worker can die; background.js pings offscreen doc to check if alive before routing
- `console.log()` does nothing in the game's browser console — the game overrides `console` with no-op functions (line ~1369 in page HTML). Use `alert()` for quick checks, or save full responses to a file via Blob download for inspection

## Git Conventions

Conventional commits: `feat:`, `fix:`, `refactor:` etc., lowercase after colon.

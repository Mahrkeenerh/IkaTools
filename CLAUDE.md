# Ikariam Tools

Chrome MV3 extension for the Ikariam browser game. Features: premium UI cleanup, CAPTCHA auto-solver (CRNN+CTC ONNX model), world map scanner with minimap overlay, full-world player/score/alliance scan, rich-data filter panel with custom JS predicates, cultural treaty scanner and dedicated popup tab, island info panel, auto-finish buildings, auto-pirate missions, trade history charts, upgrade resource info, wine timer, spy-mission "try all" planner.

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
  - `bridge.js` — Page-context script (CSP bypass), 11 event handlers — includes `ik-eval-cmd` for power-user JS predicate compilation since MV3 extension CSP bans `unsafe-eval` in the content-script isolated world, plus `ik-read-spy-data` / `ik-set-spy-sliders` for the spy-mission planner (`ikariam.getTemplateData()` + slider writes are page-context only)
  - `content.js` — CAPTCHA detection and solving orchestration
  - `cleanup.js` — Premium UI removal (shop, ambrosia, premium trader, ads) via `cleanupEnabled`, plus independent pirate-fortress hiding on the city view via `hideFortressEnabled` (default on, reversible). Both toggles share one MutationObserver; the fortress toggle lives in the popup pirate tab, split out from "remove premium clutter".
  - `scanner.js` — World map scanning via game's coordinate navigation (`globalThis.IkScanner`)
  - `culturaltreaty.js` — Orchestrates the 2-phase full scan (DOM map scan then background-worker handoff for island fetches + CT check)
  - `mapfilter.js` — Pure synchronous filter engine (`globalThis.MapFilter`). Evaluates chip filters, parameterized rule rows, and custom JS predicates. All evaluation state is passed via a `ctx` parameter — no global mutable state. Also hosts `IkFilter` (DevTools power-user API) and `IkData` (query-index helper).
  - `filterrunner.js` — Shared async evaluation helpers (`globalThis.FilterRunner`). Compiles and evaluates custom JS textarea code and preset chips via the bridge, with version guards to prevent stale overwrites. Returns result Maps — does not store state.
  - `filterpanel.js` — In-game filter panel UI with chip groups, rule rows, Custom JS textarea, status footer (rich data freshness + match count)
  - `maprender.js` — Shared map rendering engine (8 layers including alliances, isometric projection)
  - `minimap.js` — In-game overlay with viewport tracking, click-to-navigate, layer/scale/collapse controls, dim empty/filtered islands. Keeps local filter evaluation state (custom results, preset results) and passes a `ctx` to `MapFilter.islandMatches`.
  - `islandfilter.js` — Per-city dimming on the island view. Builds virtual-island objects per city slot and keeps its own local filter evaluation state, independent of minimap. View-guarded event listeners prevent cross-view state corruption.
  - `islandinfo.js` — Island view: passive data extraction, sortable player panel (Build / Res / Army / Citz columns + Refresh button), alliance labels on cities, writes to `island_{world}_{id}`, `allianceIndex_{world}`, and `avatarTotals_{world}`. Citizens derived from the Ikariam scoring formula `Total = Citizens + Builders + Scientists + Generals` — Total comes from `js_selectedCityScore` either passively (user clicks a city) or via `?view=cityDetails&destinationCityId=X` (only when the Refresh button is pressed — no auto-fetch). One cityId per unique foreign ownerId is fetched (any of the player's cities yields their total). City-name coloring priority (highest first): own (blue) → CT/museum-treaty partner (gold) → friend (green) → trade partner (magenta). **KD = CT** (Czech *kulturní dohoda* = cultural/museum treaty); the user calls these "KD" and they outrank friends in coloring.
  - `mapfilter.js` and `filterrunner.js` are loaded before `minimap.js` / `filterpanel.js` / `islandfilter.js` so they can read `globalThis.MapFilter` and `globalThis.FilterRunner`.
  - `autofinish.js` — Auto-completes buildings when timer < 4m 55s (free finish)
  - `autopirate.js` — Auto-launches pirate raids when idle/unfocused, pirate toggle in game header bar. Pauses during DOM scan phase, not during background fetch phases. **Nav fix (`schedulePreRefresh`)**: refreshes the fortress booty box ~2s after the crew returns (mission duration + 2s) so the next capture button loads *during* the remaining human delay instead of adding nav latency after it — hides per-raid navigation cost inside the cooldown, with the normal poll-driven nav as fallback. **Timing profile** is migrated via `TUNE_VERSION`/`pirateTuneVersion` (re-rolls throughput params into faster ranges; keeps all humanization mechanics — distraction, fatigue, tempo, breaks, post-break re-engagement — just shifted faster).
  - `miraclescheduler.js` — Injects a "Schedule miracle in X" row into the temple view's wonder section (next to `#js_WonderActivateButton`). Persists `miracleSchedule_{world}_{cityId}`, asks background.js to create a `chrome.alarms` entry whose name equals the storage key; on alarm the SW fires a credentialed `GET ?action=CityScreen&function=activateWonder&cityId=&position=` and clears the entry. Survives tab close / SW restart because alarms persist.
  - `gamenotes.js` — In-game notes toolbar button with floating panel, syncs with popup notes via chrome.storage
  - `piracytargets.js` — On the highscore view (`view=highscore`) with the type dropdown (`#js_highscoreType`) set to `piracy`, injects a "🏴 Save loot targets" button above the table. Each place cell has a per-row tooltip `(COEF × theft protection) = resources on evaluation day`; **COEF is the loot coefficient** (booty multiplier when raiding that player) and is the target-quality indicator — banded, not 1:1 with rank (top 10 get distinct 2.75…1.0, ranks 11–20 share 0.875, 31–50 share 0.5). The `.score` column is just cumulative piracy points (secondary; user doesn't care). Clicking scrapes every row (avatarId, name, allyTag, rank, coef, score) and full-replaces `pirateTargets_{world}`. Display is handled by islandinfo/minimap/islandfilter/mapfilter, gated by the global `pirateTargetsEnabled` toggle.
  - `tradedetect.js` — Passive scrape of `militaryAdvisor` (live trade missions, detected via `mission_icon.trade` class) and `tradeAdvisor` "Novinky z měst" feed (rows containing `<br>` inside `ul.resources` — the language-agnostic price-per-unit signal). Resolves news-feed cityIds via cached `island_{world}_{id}` records first, with an AJAX fallback (`?view=island&cityId=X&ajax=1` → parse `updateBackgroundData` → seed cache). Unresolved cityIds stash in `tradePartnersPending_{world}` and retry whenever a new island record lands. Writes `tradePartners_{world}`. Each market trade row also produces a receipt (resource, amount, price-per-unit, direction) handed to `TradeReceipts.persistReceipts`. Direction is derived from the subject's two cityId links, which follow the goods-flow origin → destination ("…z {SELLER} dorazila do {BUYER} a přivezla zboží"): link 1 = seller's city (goods came from), link 2 = buyer's home (goods landed) — if our city is the seller it's `sell`, if our city is the buyer it's `buy`. Resource names are mapped via `LocalizationStrings = JSON.parse('…')` from the page's inline script (locale-agnostic).
  - `tradereceipts.js` — Storage helper for completed-trade receipts (`globalThis.TradeReceipts`). Monthly chunks `tradeReceipts_{world}_{YYYY-MM}` + index `tradeReceiptsIdx_{world}`. Dedup key `ts|dir|myCityId|otherCityId|resource|amount`. 180-day retention matching `tradehistory.js`.
  - `tradehistory.js` — Trade snapshot persistence and history loading (`globalThis.TradeHistory`); loaded in game and in report.html
  - `tradechart.js` — Canvas-based IQR/sparkline chart rendering (`globalThis.TradeChart`); uses `TradeHistory.percentile`
  - `advisor.js` — Advisor toolbar with 7 report modes, data collection, progress bar
  - `upgradeinfo.js` — Injects missing-resource amounts onto building upgrade panels
  - `winetimer.js` — Shows wine stock duration in the resource bar
  - `citymarks.js` — Per-city `{lootable, looted, empty}` marking store (`globalThis.CityMarks`). Owns `cityMarks_{world}` storage, the 3-button widget factory `CityMarks.createWidget(cityId)`, and the one-time migrations from legacy `spyLog[*].looted` flags and `mapFilters` chip types. Loaded second (right after utils.js) so every consumer sees the same API.
  - `ctignored.js` — Per-**player** "ignoring cultural-treaty offers" store (`globalThis.CtIgnored`), keyed by avatarId (distinct from the city-level CityMarks). Owns `ctIgnored_{world}` storage and a single 🚫 toggle-button factory `CtIgnored.createButton(avatarId, {name, compact})`. Self-injects an ignore button into each row of the museum's **pending-offers** table (`#tab_museum` "Žádost o dohodu o kulturním zboží"), keyed off the language-agnostic withdraw-offer link `a.cancelTreaty[href*=receiverId]`. Loaded right after citymarks.js. Consumed by islandinfo (button in the island-details sidebar, next to the mark widget — no city-label display) and minimap/islandfilter/mapfilter (`_ctIgnored` island flag + the "CT ignored" / "Not ignored" filter chips). The intended filter combo is "CT available" AND "Not ignored".
  - `battlereport.js` — Watches for the singular battle report overlay (`#militaryAdvisorReportView`); reads attacker+defender cityIds from the `.attacker`/`.defender` row links, skips own cityIds via `relatedCityData[*].relationship === "ownCity"` scraped from inline scripts, and injects a "Target:" row with the CityMarks widget after the defender row.
  - `spymissions.js` — Spy-mission "all combinations" planner. Watches the `spyMissions` view (`#missionForm`) and **auto-embeds** a chart inline at the bottom of `#mainview` (no button) — recomputes on view open and on `#missionSelect` change. Reads target stats + `missionData` + constants from page context via `ik-read-spy-data` (mirrors the game's `spyMissionScreenProbabilityMonitor`), then enumerates every valid `(agents, decoys)` with `agents+decoys ≤ pool` and computes the exact detection%/success%/decoyRisk%/cost for each. Plots the non-dominated **Pareto front** on a canvas (X = detection %, Y = success %), each point at its minimum useful decoy count (no waste), colored green→red by expected spies caught (`agents*detect + decoys*decoyRisk`, all /100). All distinct outcomes are clickable (not just the front) — clicking a point immediately writes that combo to the in-game sliders via `ik-set-spy-sliders` (user presses the native send button); footer shows succeed/caught/empty-handed split + cost + an off-front note. Calls `ik-refresh-scrollbar` after embedding so the popup can scroll to it. Stateless — no storage keys. Mission outcome is a 3-way split summing to 100: `caught=detection%`, `succeed=success%` (already `=(100-detect)*base/100`), `empty-handed=remainder`.
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

- **CSP bypass**: `bridge.js` injected as external `<script src="chrome-extension://...">`, listens for 11 CustomEvents (`ik-jump`, `ik-ajax-call`, `ik-close-popup`, `ik-convert-crew`, `ik-read-cities`, `ik-read-island-data`, `ik-read-game-data`, `ik-read-world-islands`, `ik-eval-cmd`, `ik-read-spy-data`, `ik-set-spy-sliders`). The `ik-eval-cmd` handler exists because MV3 bans `'unsafe-eval'` in the extension CSP (content-script isolated world), but the page context is governed by Ikariam's CSP which has no such restriction — so `new Function(...)` is allowed there.
- **Scanner**: Exposes `IkScanner.scan(progressCb)` for reuse by the CT orchestrator. Dispatches `ik-jump` events → bridge calls `jumpToCoord()`. Row-by-row scan pattern with auto-detected stride. Restores position after scan.
- **Full scan pipeline**: `culturaltreaty.js` runs Phase 1 (DOM map scan via IkScanner) in the content script, then hands off to `background.js` for the remaining phases so they survive page navigation. Modes: `map` (phase 1 only), `islands` (phase 1 + island fetches), `full` (+ CT ping), `fullCities` (+ city fetches per cityId). Background pipeline in `runBgScan`: islands → pause → cities → pause → CT, skipping phases not in the chosen mode. Stage-then-swap commit for islands: no data is wiped until fetched, so cancelled/crashed scans never leave an empty world. Cities phase writes per-city keys directly (no swap — each cityId has its own record).
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
| `cityData_{world}_{cityId}` | URL world | background cities phase | Per-city building layout from `?view=city&cityId=X`: id, name, ownerId/Name, islandId + coords, phase, isCapital, buildings[{pos, type, level, groundId, constructing?, completeAt?}], timestamp. Works on any cityId (foreign cities included — server doesn't gate the view) |
| `spyLog_{world}` | URL world | spylog | Additive archive of espionage reports (units + resources), keyed by report ID |
| `cityMarks_{world}` | URL world | citymarks | Per-city target marking keyed by cityId: `{ [cityId]: { state, ts } }` where state ∈ {`lootable`, `looted`, `empty`}. Set from spy log table, battle report (`#militaryAdvisorReportView`), and island sidebar info panel via `CityMarks.createWidget(cityId)`. One-time migrated from legacy `spyLog[*].looted` flags (guarded by `cityMarksMigrated_{world}`). Filter chips (markLootable/markLooted/markEmpty/markUnmarked) read it; minimap/islandfilter/islandinfo enrich islands with `_mark` + `_looted` (the latter only set when state==="looted", kept for legacy filter aliases) |
| `cityMarksMigrated_{world}` / `cityMarksFilterChipsMigrated` | URL world / global | citymarks | One-time migration flags — presence means migration already ran |
| `mapIndex` | global | CT orchestrator | Gallery ordering (newest first) |
| `mapFilters` | global | filter panel | Filter config (groups, ops, enabled) |
| `customJsPresets` | global | filter panel | Saved JS preset chips `[{id, name, code}]` |
| `mapCustomPredicateCode` | global | filter panel | Source of the Custom JS predicate |
| `mapCustomPredicateEnabled` | global | filter panel | Custom JS toggle (default true) |
| `filterPanelCollapsed` | global | filter panel | UI state |
| `minimapEnabled` / `minimapPosition` / `minimapScale` / `minimapLayer` / `hideZeroCities` / `vpTrimRight` / `vpTrimBottom` | global | minimap | Minimap UI state |
| `scanInProgress` / `scanProgress` / `scanResult` | global (transient) | scanner | DOM scan coordination with popup |
| `ctScanRunning` / `ctScanProgress` | global (transient) | background | Background scan coordination |
| `friendSlots_{world}` | URL world | islandinfo | Friend slot map: `{ slotId: {id, name} }`. Slots are sticky in-game (never re-numbered), so this is the single source of truth — removed friends just drop out. Legacy `friendList_{world}` (id→name) is migrated on first read and removed. |
| `tradePartners_{world}` | URL world | tradedetect | Trade partner index keyed by avatarId → `{name, lastTradeAt, tradeCount, cities, lastSource}`; consumed by islandinfo (magenta `#E040FB` highlight on city labels + panel rows), minimap/islandfilter (`_tradePartner` flag), and the "Trade partners" filter chip |
| `tradePartnersPending_{world}` | URL world | tradedetect | Pending cityIds from news-feed events whose owners haven't been resolved yet; retried when new `island_{world}_{id}` records land |
| `tradeReceipts_{world}_{YYYY-MM}` | URL world | tradereceipts | Monthly chunk of actual completed market trades scraped from the news feed: `{ ts, dir: "sell"\|"buy", myCityId, myCityName, otherCityId, otherCityName, otherAvatarId, otherAvatarName, resource, amount, pricePerUnit, currency }` |
| `tradeReceiptsIdx_{world}` | URL world | tradereceipts | Index of available receipt months `{chunks: [...], lastTs}` |
| `museumPartners_{world}` | URL world | museumpartners | Museum treaty partner list `[{id, name}]` |
| `pirateTargets_{world}` | URL world | piracytargets | Saved piracy-leaderboard loot targets keyed by avatarId → `{name, allyTag, rank, coef, score, ts}`. `coef` = loot coefficient = booty multiplier when raided (the target indicator); `rank`/`score` are secondary. Full-replaced on each capture. Consumed by islandinfo (orange `#FF7043` city-name highlight + `🏴×{coef}` badge, lowest color priority after own/CT/friend/trade), minimap/islandfilter (`_pirateTarget` flag), and the "Loot targets" filter chip. Gated by `pirateTargetsEnabled`. |
| `pirateTargetsEnabled` | global | settings | Toggle for loot-target highlighting (default on). When off, readers treat the target set as empty |
| `ctIgnored_{world}` | URL world | ctignored | Per-player "ignoring cultural-treaty offers" set keyed by avatarId → `{ name, ts }`. Set from the museum pending-offers table and the island-details sidebar via `CtIgnored.createButton(avatarId)`. Consumed by minimap/islandfilter (`_ctIgnored` flag — true if any owner on the island is ignored) and the "CT ignored" / "Not ignored" filter chips |
| `avatarTotals_{world}` | URL world | islandinfo | Per-avatar total score cache `{ [avatarId]: { total, ts } }`. Total is the player's overall score from `js_selectedCityScore` — passively scraped on natural clicks, plus explicit Refresh-button fetches via `?view=cityDetails&destinationCityId=X` (the same endpoint the game's own click-on-city handler hits). Per Ikariam's formula `Total = Citizens + Builders + Scientists + Generals`, this lets the island panel derive Citizens = Total − B − R − A. No auto-fetch on panel open — user-controlled to avoid surprise network traffic. |
| `pirateCityId_{world}` / `pirateCities_{world}` | URL world | autopirate | Pirate city selection and cached city list |
| `pirateDailyLog_{world}` | URL world | autopirate | Durable per-day activity history keyed by `YYYY-MM-DD` → `{raids, t1, t2, userRaids, ut1, ut2, breaks, breakMs, converts, workMs, fgMs, firstTs, lastTs}`. **Not reset daily** (unlike the session counters in `pirateState`) — it's the long-term aggregate for tuning timing params against real data. `raids/t1/t2` = bot-launched; `userRaids/ut1/ut2` = manual (user-clicked) missions. `workMs` = wall-clock the bot could raid (idle + active hours, incl. raid/delay/break pacing); `fgMs` = time blocked because the tab was focused / user active. Duty cycle = `workMs/(workMs+fgMs)`. Accrued per poll-tick (gaps >15s, e.g. PC asleep, are dropped); flushed via read-modify-add every 30s + on stop + on each manual raid. Field list lives in `DLOG_FIELDS`. Pruned to last 30 days. Popup pirate tab shows a 7-day readout (`#pirate-history`, manual raids shown as `+Nm`). |
| `pirateEvents_{world}_{YYYY-MM-DD}` / `pirateEventsIdx_{world}` | URL world | autopirate | Granular append-only event timeline (full per-day reconstruction). Each event `{t, e, ...}` where `e` ∈ `on`/`off` (bot enabled/disabled), `raid{tier,dur}` (bot-launched), `userRaid{tier}` (manual click — detected via a capture-phase click listener on `#pirateCaptureBox a.button.capture`; the bot launches via AJAX nav and never fires a real click, so clicks are unambiguously the user), `break{ms,forced}`, `convert`, `return` (user took over while bot active), `phase{p}` (derived-state transition: `off`/`sleep`/`raiding`/`waiting`/`foreground`/`ready`), `focus`/`blur` (window), `visible`/`hidden` (tab), `captcha`. Only recorded while `pirateEnabled` **except `userRaid`** (manual missions logged even when the bot is off, since they still earn points). Buffered in memory, flushed in batches (≥20 events or every 10s) into per-day chunk arrays; index `{days:[...]}` pruned to last 14 days. Export the daily + event logs as JSON via the popup pirate tab's "Export pirate log" button (`#pirate-export-log`). |
| `miracleSchedule_{world}_{cityId}` | URL world | miraclescheduler / background | Pending miracle activation: `{world, cityId, position, origin, wonderName, fireAt, scheduledAt}`. Alarm name === this key |
| `miracleScheduleLog_{world}` | URL world | background | Ring buffer (max 20) of recent miracle fires `{firedAt, cityId, position, wonderName, ok, error}` |
| `advisorReportData_{world}` | URL world | advisor | Last advisor report data |
| `tradeHistory_{world}_{avatarId}_{YYYY-MM}` | URL world | tradehistory | Monthly trade history chunks |
| `tradeHistoryIdx_{world}_{avatarId}` | URL world | tradehistory | Index of available months |
| `pirateEnabled` / `pirateConvertEnabled` / `pirateAggressive` / `pirateSleepStart` / `pirateSleepEnd` / `pirateState` / `pirateIdleTimeout` + advanced timing params | global | autopirate | Pirate toggles and config (`pirateAggressive` halves all human-like waits — for last-day comp pushes) |
| `pirateTuneVersion` | global | autopirate | Timing-profile migration marker. On load, if `< TUNE_VERSION` the throughput params (`baseMu`, `baseSigma`, `breakMin/Max`, `streakLo/Hi`, `distractChance`) are re-rolled into the current profile's ranges, overriding prior stored values (sleep + T2 params untouched). Bump `TUNE_VERSION` in autopirate.js to push a new profile to existing users. |
| `devModeEnabled` | global | settings | Developer mode toggle (off by default, shows Captcha tab) |
| `captchaCollectEnabled` | global | captcha tab | Captcha data collection toggle (off by default) |
| `captchaLog` | global | content.js | Array of `{dataUrl, answer, success, timestamp}` entries |
| `cleanupEnabled` / `autoFinishEnabled` / `hideGameNotes` | global | settings | Feature toggles |
| `hideFortressEnabled` | global | pirate tab | Hides the pirate fortress on the city view (default on). Independent of `cleanupEnabled` — both gate the shared `cleanup.js` MutationObserver; toggle lives in the popup pirate tab. Reversible (clears the inline `display:none`), unlike the premium-clutter removal. |
| `notes` | global | gamenotes / popup | Notes content |

## Code Style

- 2-space indentation, double quotes, semicolons
- IIFEs for content scripts (isolated scope)
- Shared modules on `globalThis`: `IkUtils`, `MapRender`, `MapFilter`, `FilterRunner`, `IkScanner`, `CustomEval`, `IkFilter` (DevTools power-user alias), `IkData` (query-index read helper), `IkFilterPanel` (match count + coord hook), `inference`, `TradeHistory`, `TradeChart`, `TradeReceipts`
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

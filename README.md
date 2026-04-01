<img src="icons/icon128.png" alt="" width="128" height="128">

# Ikariam Tools

Chrome extension for the Ikariam browser game. Adds quality-of-life features, automation, and data visualization.

## Features

- **Premium cleanup** — Removes shop, ambrosia fountain, premium trader, and ad clutter
- **CAPTCHA auto-solver** — YOLOv8n/ONNX model solves piracy CAPTCHAs automatically
- **World map scanner** — Scans the entire world map and renders layer overlays (population, ownership, alliances, tradegoods, wonders, military, piracy, helios)
- **Minimap overlay** — In-game minimap with viewport tracking and click-to-navigate
- **Island info panel** — Sortable player panel on island views with alliance labels and friend highlighting
- **Auto-finish buildings** — Instantly completes construction when under 4m 55s (free finish)
- **Auto-pirate missions** — Launches raids automatically with human-like timing patterns
- **Auto-convert crew** — Converts pirate points to crew strength between raids
- **Advisor reports** — Multi-city data summaries (economy, buildings, workers, army, storage, trading, spy)
- **Trade history charts** — Tracks and visualizes trading data over time with IQR/sparkline charts
- **Upgrade info** — Shows missing resource amounts on building upgrade panels
- **Wine timer** — Displays wine stock duration in the resource bar
- **In-game notes** — Notes panel accessible from the game toolbar

## Installation

1. Download the latest release zip from [Releases](../../releases)
2. Unzip to a permanent folder (don't delete it — Chrome loads from this folder)
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in the top right corner)
5. Click **Load unpacked** and select the unzipped folder
6. Navigate to any Ikariam game page — the extension activates automatically

To update, download the new zip, replace the folder contents, and click the reload button on `chrome://extensions`.

## Game Toolbar

The extension adds three buttons to the game's top toolbar:

**Notes** | **Pirate** | **Advisor: Basic Workers Storage Army Trading Spy Full** | `progress bar`

- **Notes** opens a floating panel for quick notes (syncs with the popup's Notes tab)
- **Pirate** toggles auto-pirate on/off (red = active)
- **Advisor** buttons trigger data collection for each report type; "Full" fetches everything (many requests)
- The progress bar appears during advisor data collection

## Auto-Pirate System

The auto-pirate feature simulates human-like raid timing to avoid detection. Each user gets **randomly generated parameters** on first install — no two users behave the same way.

### How It Works

The system models a human player who launches pirate raids while doing other things (watching videos, browsing, etc.). It simulates:

1. **Raid timing** — Delays between raids follow a log-normal distribution, producing the kind of irregular spacing a real player would have
2. **Streaks and breaks** — After a random number of raids, the system takes a break (like a player getting up, eating, etc.)
3. **Distraction periods** — Occasionally enters a "distracted" state with longer delays
4. **Tier selection** — Chooses between Tier 1 (fast, 2m30s) and Tier 2 (slow, 7m30s) raids with contextual probability
5. **Session fatigue** — Delays gradually increase over long sessions
6. **Sleep hours** — Completely stops during configured sleep window

### Parameters Explained

When you open the extension popup's Settings tab and expand the **Advanced** section under auto-pirate, you'll see your randomly assigned parameters. Here's what each one controls:

#### Timing Core

| Parameter | Range | What it does |
|-----------|-------|--------------|
| **Mu** | 2.7 - 3.3 | Center of the log-normal delay distribution. Higher = longer average delays between raids. At mu=2.9, the median delay is about 18 seconds; at mu=3.3, it's about 27 seconds. |
| **Sigma** | 0.8 - 1.2 | Spread of the delay distribution. Higher = more variance (some very short delays, some very long). At sigma=0.8 delays are fairly consistent; at sigma=1.2 they're more erratic. |

The actual delay for each raid is: `exp(mu + sigma * random_normal)` seconds, plus modifiers from fatigue, distraction, tempo, and post-break state.

#### Streak & Break System

| Parameter | Range | What it does |
|-----------|-------|--------------|
| **Streak Lo** | 8 - 12 | Minimum raids before a break becomes possible. Below this, the system never takes a break. |
| **Streak Hi** | 16 - 22 | Raids at which a break becomes near-certain. A sigmoid curve ramps break probability from 0% at Streak Lo to ~100% at Streak Hi. |
| **Break Min** | 3 - 6 min | Minimum break duration. Actual break length is log-normal distributed between Break Min and Break Max. |
| **Break Max** | 8 - 14 min | Maximum typical break duration (can occasionally exceed by up to 5 minutes). Longer streaks produce longer breaks. |

The break hazard follows a sigmoid: `1 / (1 + exp(-steepness * (raidCount - midpoint)))` where midpoint = (Lo + Hi) / 2.

#### Tier 2 Selection

Tier 2 raids take 7m30s instead of 2m30s. The system models a player who sometimes picks the longer option:

| Parameter | Range | What it does |
|-----------|-------|--------------|
| **T2 Base** | 0.06 - 0.14 | Base probability of choosing T2 early in a streak. |
| **T2 Ramp** | 0.40 - 0.70 | Maximum additional T2 probability as the streak approaches a break. Models "getting lazy before taking a break." Uses a sigmoid curve peaking around 60% of the way to Streak Hi. |
| **T2 Dist** | 0.30 - 0.50 | T2 probability during distraction states. Distracted players pick the lazy option more often. |
| **T2->brk** | 0.15 - 0.30 | Chance that choosing T2 forces an immediate break afterward. Models "player launched a long raid and walked away." |
| **T2x2** | 0.08 - 0.20 | Chance of allowing two T2 raids in a row. Normally T2 resets to this low chance after a T2 raid. |

#### Distraction

| Parameter | Range | What it does |
|-----------|-------|--------------|
| **Distract** | 0.08 - 0.15 | Per-raid chance of entering a "distracted" state. When distracted, delays increase (mu shifts up by 0.5-1.5) and T2 probability jumps to T2 Dist. Lasts 2-5 raids. |

#### Hidden Mechanics (not configurable)

- **AR(1) Tempo**: A latent momentum variable that makes delays slightly autocorrelated — fast raids tend to follow fast raids, slow follows slow
- **Session fatigue**: Mu increases by up to 0.5 over several hours (saturating exponential)
- **Post-break re-engagement**: 70% chance of 1-3 faster raids after a break (player is re-focused)
- **Sleep jitter**: Sleep start/end times vary by +/- 10 minutes daily
- **Soft cap**: No single delay exceeds 20-30 minutes (random per raid)

### Understanding Your Settings with AI

Your parameters are randomly generated and the math behind them is complex. Instead of trying to understand each number yourself, you can **ask an AI assistant** (ChatGPT, Claude, etc.) to explain your specific configuration.

Copy your settings from the popup and ask something like:

> "Here are my Ikariam auto-pirate settings: Mu=3.1, Sigma=0.9, Streak Lo=10, Streak Hi=18, Break Min=5, Break Max=12, Distract=0.11, T2 Base=0.08, T2 Ramp=0.55, T2 Dist=0.40, T2->brk=0.22, T2x2=0.12. Can you explain what kind of behavior this produces? How many raids per hour? How often will it take breaks?"

The AI can simulate the math and give you a plain-language summary. If you want to adjust something (e.g., "I want longer breaks" or "I want more T2 raids"), ask the AI what parameters to change.

## Build

```bash
npm install        # Install deps (esbuild, onnxruntime-web)
npm run build      # Bundle offscreen.js + copy WASM to dist/
```

The `dist/` folder is required for the CAPTCHA solver. The rest of the extension loads directly from source files.

## Tech Stack

- Vanilla JavaScript (ES2021+, no TypeScript, no frameworks)
- Chrome Extension Manifest V3
- ONNX Runtime Web (CAPTCHA inference via offscreen document)
- esbuild (bundles offscreen script + WASM)

## License

This project is for personal/educational use with the Ikariam browser game.

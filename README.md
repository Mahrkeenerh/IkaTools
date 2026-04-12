<img src="icons/icon128.png" alt="" width="128" height="128">

# Ikariam Tools

Chrome extension for the Ikariam browser game. Adds quality-of-life features, automation, and data visualization.

## Features

- **Cleaner UI** — Removes shop, ambrosia, and ad clutter
- **World scanner & minimap** — Scans the full world map, optional Full Scan also fetches per-island rich data (players, alliance tags, building/research/army/trader scores) and cultural treaty availability
- **Rich island filtering** — In-game filter panel with predicates for alliance tag, player name, army score, cultural treaty, plus the usual tradegood/wonder/flag filters. Dims non-matching islands on the world map and non-matching cities on the island view.
- **Custom JS queries** — Power-user textarea inside the filter panel where you can write arbitrary JS predicates against the scan data, e.g. `i._maxArmy > 50000 && i._allyTags.has("-DR-")` — see [Custom JS Filtering Guide](docs/custom-js-filtering.md)
- **Cultural treaty tab** — Dedicated popup tab listing all players with available treaties, with live alliance filtering and click-to-filter chips
- **JSON world export** — Download the full scanned world (map, islands, alliance index, CT results) as JSON for external analysis
- **Piracy automation** — Automated raids with CAPTCHA solving (CRNN+CTC model, ~97% accuracy) and human-like timing
- **City & data tools** — Advisor reports, trade tracking, auto-finish buildings, notes panel, wine timer, and more

## Installation

1. Download the latest release zip from [Releases](../../releases)
2. Unzip to a permanent folder (don't delete it — Chrome loads from this folder)
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in the top right corner)
5. Click **Load unpacked** and select the unzipped folder
6. Refresh any open Ikariam game pages (or open a new one) — the extension activates automatically

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

### Understanding Your Settings with AI

Your parameters are randomly generated and the math behind them is complex. Instead of trying to understand each number yourself, you can **ask an AI assistant** (ChatGPT, Claude, etc.) to explain your specific configuration.

Copy this entire **Auto-Pirate System** section (including the code) along with your actual settings from the popup, and paste it into the AI. Then ask something like:

> "Given my settings: Mu=3.1, Sigma=0.9, Streak Lo=10, Streak Hi=18, Break Min=5, Break Max=12, Distract=0.11, T2 Base=0.08, T2 Ramp=0.55, T2 Dist=0.40, T2->brk=0.22, T2x2=0.12 — can you explain what kind of behavior this produces? How many raids per hour? How often will it take breaks?"

The AI needs the code and your settings to give an accurate answer. It can simulate the math and give you a plain-language summary. If you want to adjust something (e.g., "I want longer breaks" or "I want more T2 raids"), ask the AI what parameters to change.

### How It Works

The system simulates a human player launching pirate raids while doing other things. It uses log-normal delays between raids, takes breaks after streaks, occasionally gets "distracted" (longer delays), picks between Tier 1 (2m30s) and Tier 2 (7m30s) raids with contextual probability, accumulates session fatigue, and stops during sleep hours.

Your parameters are visible in the popup's Settings tab under **Advanced**. The code below is the full timing implementation — the delay returned by `randomDelay()` is added on top of the mission duration.

```js
// --- Random number generators ---
function randn() {
  const u = 1 - Math.random();
  const v = 1 - Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function lognormal(mu, sigma) {
  return Math.exp(mu + sigma * randn());
}

// --- Break probability: sigmoid that rises with streak count ---
function getBreakHazard() {
  if (streakCount < cfg.streakLo) return 0;
  const midpoint = (cfg.streakLo + cfg.streakHi) / 2;
  const steepness = 6 / (cfg.streakHi - cfg.streakLo);
  return 1 / (1 + Math.exp(-steepness * (streakCount - midpoint)));
}

// --- Tier 2 selection probability: depends on streak, distraction, post-break ---
function getT2Probability() {
  if (lastMissionWasT2) return cfg.backToBackChance; // T2x2 param

  let chance = cfg.t2Base;

  // Post-break: lower T2 (player is re-engaged, picks fast option)
  if (postBreakRaids > 0) return Math.max(chance * 0.3, 0.02);

  // Distraction: flat elevated chance
  if (distractionRaids > 0) {
    chance = Math.max(chance, cfg.t2Distract);
  }

  // Sigmoid ramp: T2 increasingly likely as streak approaches break
  const progress = Math.min(streakCount / cfg.streakHi, 1.0);
  const sigmoid = cfg.t2Ramp / (1 + Math.exp(-8 * (progress - 0.6)));
  chance += sigmoid;

  return chance;
}

// --- Main delay calculation (called after each raid) ---
function randomDelay() {
  streakCount++;

  // --- Break decision: hazard-based OR forced by T2 ---
  const breakRoll = Math.random() < getBreakHazard();
  if (breakRoll || forceBreakNext) {
    forceBreakNext = false;

    // Longer streak = longer break
    const streakFactor = Math.min(streakCount / cfg.streakHi, 1.0);
    const dynBreakMin = cfg.breakMin + streakFactor * 2;
    const breakMu = Math.log((dynBreakMin + cfg.breakMax) / 2 * 60);
    const breakD = Math.min(lognormal(breakMu, 0.4), (cfg.breakMax + 5) * 60);
    const d = Math.max(breakD, (dynBreakMin - 2) * 60) * 1000;

    streakCount = 0;

    // Post-break re-engagement: 70% chance of 1-3 faster raids
    if (Math.random() < 0.70) {
      postBreakRaids = 1 + Math.floor(Math.random() * 3);
    }
    return d;
  }

  // --- Post-break state: slightly faster, less distracted ---
  if (postBreakRaids > 0) postBreakRaids--;

  // --- Distraction state ---
  if (distractionRaids <= 0) {
    distractionMu = 0;
    const distractRoll = postBreakRaids > 0
      ? cfg.distractChance * 0.3
      : cfg.distractChance;
    if (Math.random() < distractRoll) {
      distractionMu = 0.5 + Math.random() * 1.0; // mu shifts up by 0.5-1.5
      distractionRaids = 2 + Math.floor(Math.random() * 4); // lasts 2-5 raids
    }
  }
  if (distractionRaids > 0) distractionRaids--;

  // --- AR(1) tempo: momentum in delays (fast follows fast, slow follows slow) ---
  tempo = 0.6 * tempo + 0.15 * randn();

  // --- Session fatigue: mu increases up to 0.5 over hours ---
  const sessionHours = (Date.now() - sessionStartTime) / 3600000;
  const fatigueMu = 0.5 * (1 - Math.exp(-0.3 * sessionHours));

  // --- Post-break speed boost ---
  const postBreakMu = postBreakRaids > 0 ? -0.3 : 0;

  // --- Final delay ---
  const mu = cfg.baseMu + distractionMu + fatigueMu + postBreakMu + tempo;
  const sigma = cfg.baseSigma;
  const softCap = (20 + Math.random() * 10) * 60; // 20-30 min max
  const delaySec = Math.min(lognormal(mu, sigma), softCap);
  const d = Math.max(delaySec, 3 + Math.random() * 2) * 1000; // min 3-5s
  return d;
}
```

**Tier selection** happens before `randomDelay()` is called:

```js
const t2Prob = getT2Probability();
if (captureBtns.length > 1 && Math.random() < t2Prob) tier = 1;

lastMissionWasT2 = (tier === 1);
if (lastMissionWasT2 && Math.random() < cfg.forceBreakChance) { // T2->brk param
  forceBreakNext = true;
}
```

**Sleep jitter**: sleep start/end times shift by ±10 minutes, re-rolled daily.

## License

This project is for personal/educational use with the Ikariam browser game.

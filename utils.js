// Shared utilities for Ikariam Tools content scripts
// Loaded first via manifest — available as globalThis.IkUtils
globalThis.IkUtils = (() => {
  // Inject bridge.js into page context (once) — bypasses CSP via external script src
  function ensureBridge() {
    if (document.getElementById("ik-bridge")) return;
    const s = document.createElement("script");
    s.id = "ik-bridge";
    s.src = chrome.runtime.getURL("bridge.js");
    s.onerror = () => console.warn("[IkUtils] bridge.js failed to load");
    document.documentElement.appendChild(s);
  }

  // Extract world name from page title
  // Handles "Ikariam - 20m 54s - Svět Eurydike" (3+ parts) and "Ikariam - Svět Eurydike" (2 parts)
  function getWorldName() {
    const parts = document.title.split(" - ");
    if (parts.length >= 3) return parts.slice(2).join(" - ").trim();
    if (parts.length === 2) {
      const candidate = parts[1].trim();
      // Skip if it looks like a countdown timer (e.g. "20m 54s")
      if (!/^\d+[hms]/.test(candidate)) return candidate;
    }
    return null;
  }

  // Parse .islandTile elements from the live DOM into island objects
  function parseTilesFromDOM() {
    const islands = [];
    document.querySelectorAll(".islandTile").forEach((tile) => {
      const title = tile.getAttribute("title") || "";
      const m = title.match(/^(.+?)\s*\[(\d+):(\d+)\]$/);
      if (!m) return;

      const citiesEl = tile.querySelector(".cities");
      const wonderEl = tile.querySelector('[class*="wonder wonder"]');
      const tgEl = tile.querySelector('[class*="tradegood tradegood"]');
      const piracyEl = tile.querySelector('[id^="piracy_"]');
      const heliosEl = tile.querySelector('[id^="helios_"]');
      const ownerEl = tile.querySelector('[id^="owner_"]');

      islands.push({
        name: m[1],
        x: parseInt(m[2], 10),
        y: parseInt(m[3], 10),
        cities: citiesEl ? parseInt(citiesEl.textContent, 10) || 0 : 0,
        wonder: wonderEl
          ? parseInt(wonderEl.className.match(/wonder(\d+)/)?.[1], 10) || 0
          : 0,
        tradegood: tgEl
          ? parseInt(tgEl.className.match(/tradegood(\d+)/)?.[1], 10) || 0
          : 0,
        piracy: piracyEl ? piracyEl.className !== "" : false,
        helios: heliosEl ? heliosEl.className !== "" : false,
        owner: ownerEl ? ownerEl.className.replace("ownerState", "").trim() : "",
        military: false,
        war: false,
        barbarian: false,
      });
    });
    return islands;
  }

  // Build alliance color map from allianceIndex storage data
  function buildAllianceColorMap(allianceIndex) {
    const allyCounts = {};
    for (const key of Object.keys(allianceIndex)) {
      const entry = allianceIndex[key];
      for (const [tag, count] of Object.entries(entry.counts || {})) {
        if (tag === "(none)") continue;
        allyCounts[tag] = (allyCounts[tag] || 0) + count;
      }
    }
    const sorted = Object.entries(allyCounts).sort((a, b) => b[1] - a[1]);
    const palette = globalThis.MapRender?.ALLY_PALETTE || [];
    const colorMap = {};
    sorted.forEach(([tag], i) => {
      colorMap[tag] = palette[i % palette.length] || "#888";
    });
    return colorMap;
  }

  // Enrich island array with alliance color/count/tag from index
  function enrichIslandsWithAlliances(islands, allianceIndex, colorMap) {
    for (const isl of islands) {
      const key = `${isl.x}:${isl.y}`;
      const entry = allianceIndex[key];
      if (!entry || !entry.counts) {
        isl._allyColor = null;
        isl._allyCount = 0;
        continue;
      }
      let maxTag = null, maxCount = 0;
      for (const [tag, count] of Object.entries(entry.counts)) {
        if (tag === "(none)") continue;
        if (count > maxCount) { maxTag = tag; maxCount = count; }
      }
      isl._allyColor = maxTag ? (colorMap[maxTag] || "#888") : null;
      isl._allyCount = maxCount;
      isl._allyTag = maxTag;
    }
  }

  return { ensureBridge, getWorldName, parseTilesFromDOM, buildAllianceColorMap, enrichIslandsWithAlliances };
})();

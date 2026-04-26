// Shared utilities for Ikariam Tools content scripts
// Loaded first via manifest — available as globalThis.IkUtils
globalThis.IkUtils = (() => {
  // Inject bridge.js into page context (once) — bypasses CSP via external script src
  function ensureBridge() {
    if (document.getElementById("ik-bridge")) return;
    const s = document.createElement("script");
    s.id = "ik-bridge";
    s.src = chrome.runtime.getURL("content/bridge.js");
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

  // Parse a number from game DOM text (strips whitespace, commas, dots used as separators)
  function parseNum(text) {
    if (!text) return 0;
    const m = text.match(/[\d][\d\s,.]*/);
    return m ? parseInt(m[0].replace(/[\s,.]/g, ""), 10) || 0 : 0;
  }

  // Get city list from bridge — returns Promise<Array<{id, name, coords}>>
  function getCities() {
    return new Promise((resolve) => {
      ensureBridge();
      let resolved = false;
      const handler = (e) => {
        window.removeEventListener("ik-cities-data", handler);
        if (resolved) return;
        resolved = true;
        const data = e.detail || {};
        const cities = [];
        for (const key of Object.keys(data)) {
          if (key === "additionalInfo" || key === "selectedCity") continue;
          const c = data[key];
          if (c && c.id && c.name) {
            cities.push({ id: c.id, name: c.name, coords: c.coords || "", relationship: c.relationship || "" });
          }
        }
        resolve(cities);
      };
      window.addEventListener("ik-cities-data", handler);
      window.dispatchEvent(new CustomEvent("ik-read-cities"));
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener("ik-cities-data", handler);
          resolve([]);
        }
      }, 3000);
    });
  }

  // Reorder our custom toolbar items (data-ik-order) so they appear in correct order
  // and apply margins: first custom item gets 20px gap from game items, rest get 4px
  function reorderToolbarItems(toolbar) {
    const items = Array.from(toolbar.querySelectorAll("[data-ik-order]"));
    if (items.length === 0) return;
    items.sort((a, b) => parseInt(a.dataset.ikOrder) - parseInt(b.dataset.ikOrder));
    // Remove and re-append in order
    items.forEach((item) => item.remove());
    items.forEach((item, i) => {
      item.style.marginLeft = i === 0 ? "20px" : "4px";
      toolbar.appendChild(item);
    });
  }

  // URL-based world name (e.g. "s55-cz") — stable, works in content scripts and popup
  function getUrlWorldName() {
    const host = location.hostname;
    const idx = host.indexOf(".ikariam");
    return idx > 0 ? host.substring(0, idx) : null;
  }

  // Extract updateBackgroundData JSON from inline scripts on island/city pages.
  // Naive brace-matching: JSON.parse on the raw substring fails because trailing
  // script content follows the object.
  function parseBackgroundData() {
    let result = null;
    document.querySelectorAll("script").forEach((script) => {
      if (result) return;
      const text = script.textContent;
      const idx = text.indexOf('"updateBackgroundData"');
      if (idx === -1) return;
      const start = text.indexOf("{", idx);
      if (start === -1) return;
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            try { result = JSON.parse(text.substring(start, i + 1)); }
            catch (e) { /* swallow — caller handles null */ }
            return;
          }
        }
      }
    });
    return result;
  }

  // Build a lookup index from spyLog_{world} keyed by cityId, by
  // coord+player+city, and by island coord (max timestamp across all looted
  // cities). Skips entries without a `looted` timestamp or marked as `deleted`.
  async function getLootedIndex(worldName) {
    const w = worldName || getUrlWorldName() || "unknown";
    const key = "spyLog_" + w;
    const data = await chrome.storage.local.get(key);
    const log = data[key] || {};
    const byCityId = new Map();
    const byCoordPlayerCity = new Map();
    const byCoord = new Map();
    for (const id of Object.keys(log)) {
      const r = log[id];
      if (!r || !r.looted || r.deleted) continue;
      const ts = r.looted;
      if (r.targetCityId) {
        const cid = String(r.targetCityId);
        if ((byCityId.get(cid) || 0) < ts) byCityId.set(cid, ts);
      }
      if (r.targetCoords && r.targetPlayer && r.targetCity) {
        const k = r.targetCoords + "|" + r.targetPlayer.toLowerCase() + "|" + r.targetCity.toLowerCase();
        if ((byCoordPlayerCity.get(k) || 0) < ts) byCoordPlayerCity.set(k, ts);
      }
      if (r.targetCoords) {
        if ((byCoord.get(r.targetCoords) || 0) < ts) byCoord.set(r.targetCoords, ts);
      }
    }
    return { byCityId, byCoordPlayerCity, byCoord };
  }

  // Look up the looted timestamp for a single city given the index from
  // getLootedIndex. Prefers cityId match (stable across renames), falls back
  // to coord+player+city for legacy spy log entries that lack targetCityId.
  function lookupLooted(index, cityId, coords, playerName, cityName) {
    if (!index) return 0;
    if (cityId) {
      const ts = index.byCityId.get(String(cityId));
      if (ts) return ts;
    }
    if (coords && playerName && cityName) {
      const k = coords + "|" + String(playerName).toLowerCase() + "|" + String(cityName).toLowerCase();
      const ts = index.byCoordPlayerCity.get(k);
      if (ts) return ts;
    }
    return 0;
  }

  // Format a "looted X ago" duration string. Returns a short form ("5d", "3h", "20m").
  function formatLootedAge(ts) {
    if (!ts) return "";
    const ms = Date.now() - ts;
    if (ms < 0) return "just now";
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    return days + "d ago";
  }

  return { ensureBridge, getWorldName, getUrlWorldName, parseTilesFromDOM, parseNum, getCities, reorderToolbarItems, parseBackgroundData, getLootedIndex, lookupLooted, formatLootedAge };
})();

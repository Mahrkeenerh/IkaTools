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

  return { ensureBridge, getWorldName, getUrlWorldName, parseTilesFromDOM, parseNum, getCities, reorderToolbarItems };
})();

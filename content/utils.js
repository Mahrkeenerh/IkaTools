// Shared utilities for Ikariam Tools content scripts
// Loaded first via manifest — available as globalThis.IkUtils
globalThis.IkUtils = (() => {
  // Inject bridge.js into page context (once) — bypasses CSP via external script src.
  // Returns a Promise that resolves once the script's `onload` fires, so callers
  // that immediately dispatch CustomEvents can `await` to avoid losing the event
  // before bridge.js registers its listeners.
  let bridgeReadyPromise = null;
  function ensureBridge() {
    if (bridgeReadyPromise) return bridgeReadyPromise;
    bridgeReadyPromise = new Promise((resolve) => {
      const existing = document.getElementById("ik-bridge");
      if (existing) { resolve(); return; }
      const s = document.createElement("script");
      s.id = "ik-bridge";
      s.src = chrome.runtime.getURL("content/bridge.js");
      s.onload = () => resolve();
      s.onerror = () => {
        console.warn("[IkUtils] bridge.js failed to load");
        bridgeReadyPromise = null;
        resolve();
      };
      document.documentElement.appendChild(s);
    });
    return bridgeReadyPromise;
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

  // Game abbreviates large numbers ("1,26M"), so a plain digit-strip parse is
  // off by orders of magnitude. Handle the k/M/B suffixes explicitly.
  function parseAmount(text) {
    if (!text) return 0;
    const m = String(text).match(/(\d[\d\s.,]*)(?:\s*(mrd|mio|[kmb])\.?(?![\p{L}]))?/iu);
    if (!m) return 0;
    let num = m[1].replace(/[\s\u00a0]/g, "");
    const suf = (m[2] || "").toLowerCase();
    const mult = suf.startsWith("mrd") || suf === "b" ? 1e9
      : suf.startsWith("mio") || suf === "m" ? 1e6
      : suf === "k" ? 1e3 : 1;
    if (mult > 1) {
      // With a suffix the last separator is a decimal point, not a grouping mark
      const sep = Math.max(num.lastIndexOf(","), num.lastIndexOf("."));
      if (sep >= 0) num = num.slice(0, sep).replace(/[.,]/g, "") + "." + num.slice(sep + 1);
      return Math.round(parseFloat(num) * mult) || 0;
    }
    return parseInt(num.replace(/[.,]/g, ""), 10) || 0;
  }

  // Prefer the title attribute — the game puts the exact, unabbreviated amount there
  function readAmount(el) {
    if (!el) return 0;
    const title = el.getAttribute && el.getAttribute("title");
    if (title && /\d/.test(title)) return parseAmount(title);
    return parseAmount(el.textContent);
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

  // Scan inline scripts for the page's own-city ID list. Returns a Set of
  // cityId strings, or null if no `ownCity` records were found (which means
  // either the page hasn't finished injecting its inline data yet OR we're
  // on a context that doesn't carry relatedCityData). Callers that act on
  // ownership should treat null as "unknown" and bail.
  function getOwnCityIds() {
    const set = new Set();
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent;
      if (!text || text.indexOf("ownCity") === -1) continue;
      const re = /"city_(\d+)"\s*:\s*\{[^}]*"relationship"\s*:\s*"ownCity"/g;
      let m;
      while ((m = re.exec(text)) !== null) set.add(m[1]);
    }
    return set.size > 0 ? set : null;
  }

  return { ensureBridge, getWorldName, getUrlWorldName, parseTilesFromDOM, parseNum, parseAmount, readAmount, getCities, reorderToolbarItems, parseBackgroundData, getOwnCityIds };
})();

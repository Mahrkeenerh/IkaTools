// Filter evaluation module for island dimming
// Attaches to globalThis.MapFilter
globalThis.MapFilter = (() => {
  const FILTER_OPTIONS = [
    // Ownership
    { type: "owner", value: "own", label: "Own cities", color: "#FF4EC7", group: "Ownership" },
    { type: "owner", value: "ally", label: "Own + Allied", color: "#00FF88", group: "Ownership" },
    // Resources
    { type: "tradegood", value: 1, label: "Wine", color: "#8B2252", group: "Resources" },
    { type: "tradegood", value: 2, label: "Marble", color: "#E8E4D8", group: "Resources" },
    { type: "tradegood", value: 3, label: "Crystal", color: "#7FDBFF", group: "Resources" },
    { type: "tradegood", value: 4, label: "Sulfur", color: "#FFD700", group: "Resources" },
    // Wonders
    { type: "wonder", value: 1, label: "Hephaestus", color: "#FF6B35", group: "Wonders" },
    { type: "wonder", value: 2, label: "Hades", color: "#6B3FA0", group: "Wonders" },
    { type: "wonder", value: 3, label: "Demeter", color: "#8FBC5F", group: "Wonders" },
    { type: "wonder", value: 4, label: "Athena", color: "#D4AF37", group: "Wonders" },
    { type: "wonder", value: 5, label: "Hermes", color: "#87CEEB", group: "Wonders" },
    { type: "wonder", value: 6, label: "Ares", color: "#C41E3A", group: "Wonders" },
    { type: "wonder", value: 7, label: "Poseidon", color: "#1E90FF", group: "Wonders" },
    { type: "wonder", value: 8, label: "Colossus", color: "#B0B0B0", group: "Wonders" },
    // Flags
    { type: "flag", value: "empty", label: "Empty", color: "#556677", group: "Flags" },
    { type: "flag", value: "hasCities", label: "Has cities", color: "#88AACC", group: "Flags" },
    { type: "flag", value: "military", label: "Military", color: "#FF6B6B", group: "Flags" },
    { type: "flag", value: "war", label: "War", color: "#FF2020", group: "Flags" },
    { type: "flag", value: "piracy", label: "Piracy", color: "#FF4444", group: "Flags" },
    { type: "flag", value: "helios", label: "Helios", color: "#FFD700", group: "Flags" },
    // Occupied slots
    { type: "pop", value: 15, label: "Slots < 15", color: "#5ab87a", group: "Slots" },
    { type: "pop", value: 16, label: "Slots < 16", color: "#7acc94", group: "Slots" },
    // Rich-data predicates — require a recent full scan (queryIndex_{world}).
    // `parameterized` filters render as rule rows, not chips, in the panel.
    // `requiresRich` flags filters that should be hidden when no query index exists.
    { type: "ctAvailable", value: true, label: "CT available", color: "#00FFAA", group: "Cultural Treaty", requiresRich: true },
    { type: "hasInactive", value: true, label: "Has inactive", color: "#999966", group: "Players", requiresRich: true },
    { type: "allyTag", value: "", label: "Alliance tag", color: "#FFAA00", group: "Players", requiresRich: true, parameterized: true, paramKind: "allyTag", paramPlaceholder: "tag" },
    { type: "playerName", value: "", label: "Player name contains", color: "#FF77DD", group: "Players", requiresRich: true, parameterized: true, paramKind: "text", paramPlaceholder: "substring" },
    { type: "armyMin", value: null, label: "Player army ≥", color: "#FF6644", group: "Players", requiresRich: true, parameterized: true, paramKind: "number", paramPlaceholder: "e.g. 50000" },
  ];

  // Two ways to install a power-user predicate:
  // 1. `customPredicate` — a sync function installed via setCustomPredicate(fn).
  //    Used by the DevTools-console API (IkFilter.set) where code lives in the
  //    content-script isolated world and can be called per-island.
  // 2. `customResultKey` — a lookup function from the filter panel's textarea.
  //    The code there runs in the page context (via customeval.js) and the
  //    pre-computed results are stored in a Map keyed by a string. The function
  //    extracts the key from an island (e.g. "x:y" for world map, "id:pos" for
  //    island view). Both are ANDed with the rest of the filter config.
  let customPredicate = null;
  let customResultMap = null; // Map<string, boolean> of pre-computed matches
  let customResultKeyFn = null; // (isl) -> string used to look up in the map

  function matchFilter(isl, filter) {
    switch (filter.type) {
      case "tradegood": return isl.tradegood === filter.value;
      case "wonder": return isl.wonder === filter.value;
      case "owner":
        if (filter.value === "own") return isl.owner === "own";
        if (filter.value === "ally") return isl.owner === "own" || isl.owner === "ally";
        return false;
      case "pop": return isl.cities < filter.value;
      case "flag":
        if (filter.value === "empty") return isl.cities === 0;
        if (filter.value === "hasCities") return isl.cities > 0;
        return !!isl[filter.value];
      // Rich predicates — read precomputed underscore fields stamped by enrichment
      case "ctAvailable": return !!isl._ctAvailable;
      case "hasInactive": return isl._players && isl._players.some(p => p.state === "inactive");
      case "allyTag": {
        if (!filter.value || !isl._allyTags) return false;
        return isl._allyTags.has(String(filter.value));
      }
      case "playerName": {
        const q = String(filter.value || "").trim().toLowerCase();
        if (!q || !isl._ownerNamesText) return false;
        return isl._ownerNamesText.indexOf(q) !== -1;
      }
      case "armyMin": {
        // Empty/NaN threshold = inactive rule (match everything)
        const n = Number(filter.value);
        if (!Number.isFinite(n)) return true;
        return (isl._maxArmy || 0) >= n;
      }
      default: return false;
    }
  }

  function matchGroup(isl, group) {
    if (!group.filters || group.filters.length === 0) return true;
    if (group.op === "and") {
      return group.filters.every((f) => matchFilter(isl, f));
    }
    return group.filters.some((f) => matchFilter(isl, f));
  }

  function islandMatches(isl, config) {
    // DevTools power-user predicate — always active when set (independent of
    // the filter panel's enabled toggle).
    if (customPredicate) {
      try { if (!customPredicate(isl)) return false; }
      catch (e) { /* swallow — bad predicate shouldn't kill rendering */ }
    }
    // Filter panel disabled → skip both chip filters and Custom JS textarea.
    if (!config || !config.enabled) return true;
    // Pre-computed result map (from filter panel's Custom JS textarea)
    if (customResultMap && customResultKeyFn) {
      const key = customResultKeyFn(isl);
      if (!customResultMap.get(key)) return false;
    }
    if (!config.groups || config.groups.length === 0) return true;
    // Only consider groups that have filters
    const active = config.groups.filter((g) => g.enabled !== false && g.filters && g.filters.length > 0);
    if (active.length === 0) return true;
    if (config.globalOp === "and") {
      return active.every((g) => matchGroup(isl, g));
    }
    return active.some((g) => matchGroup(isl, g));
  }

  function setCustomPredicate(fn) {
    customPredicate = (typeof fn === "function") ? fn : null;
    // Dedicated event so the minimap can redraw without overwriting filterConfig.
    window.dispatchEvent(new CustomEvent("ik-custom-predicate-change"));
  }

  function getCustomPredicate() { return customPredicate; }

  // Install (or clear) a pre-computed result lookup for the filter-panel
  // Custom JS feature. map === null clears. keyFn extracts the lookup key
  // from an island object (so the same result map works across different
  // view shapes — world map uses "x:y", island view uses "id:pos").
  function setCustomResults(map, keyFn) {
    customResultMap = map || null;
    customResultKeyFn = map ? (keyFn || ((isl) => isl.x + ":" + isl.y)) : null;
    window.dispatchEvent(new CustomEvent("ik-custom-predicate-change"));
  }

  function hasCustomResults() { return customResultMap != null; }

  function getCustomResultCoords() {
    if (!customResultMap) return [];
    const coords = [];
    for (const [key, val] of customResultMap) {
      if (val) coords.push(key);
    }
    return coords;
  }

  return {
    islandMatches, matchGroup, matchFilter, FILTER_OPTIONS,
    setCustomPredicate, getCustomPredicate,
    setCustomResults, hasCustomResults, getCustomResultCoords,
  };
})();

// Power-user hook: expose a tiny API on globalThis so a programmer can write
// JS predicates from the DevTools console (context: "ikariam-tools" content
// script) and have the map highlight matching islands.
//
// Each enriched island has these fields available to the predicate:
//   x, y, name, cities, owner, tradegood, wonder        (lightweight scan)
//   _allyTags        Set<string>     (alliance tags on the island)
//   _ownerNamesText  string          ("\n"-joined lowercased owner names)
//   _maxArmy         number          (max army score across cities)
//   _players         Array<{id, name, ally, allyId, state, cities, maxLevel, place, building, research, army, trader}>
//   _ctAvailable     boolean
//   _ctChecked       boolean
//
// Examples:
//   IkFilter.set(i => i._allyTags && i._allyTags.has("-DR-"))
//   IkFilter.set(i => i._maxArmy > 50000 && !i._allyTags.has("-DR-"))
//   IkFilter.set(i => i._players.some(p => p.ally === "BO-M" && p.army >= 30000))
//   IkFilter.set(i => i._ownerNamesText.includes("bob"))
//   IkFilter.clear()
//
// IkData.get() returns the raw queryIndex_{world} blob for ad-hoc inspection.
globalThis.IkFilter = {
  set(fn) { globalThis.MapFilter.setCustomPredicate(fn); },
  clear() { globalThis.MapFilter.setCustomPredicate(null); },
  current() { return globalThis.MapFilter.getCustomPredicate(); },
};

globalThis.IkData = {
  async get(worldName) {
    const w = worldName || (globalThis.IkUtils && IkUtils.getUrlWorldName && IkUtils.getUrlWorldName()) || "unknown";
    const data = await chrome.storage.local.get("queryIndex_" + w);
    return data["queryIndex_" + w] || null;
  },
  async players(worldName) {
    const idx = await this.get(worldName);
    if (!idx) return [];
    // Flatten unique players from islandsByCoord
    const seen = new Map();
    for (const coord of Object.keys(idx.islandsByCoord)) {
      const isl = idx.islandsByCoord[coord];
      for (let i = 0; i < isl.ownerIds.length; i++) {
        const id = isl.ownerIds[i];
        if (seen.has(id)) {
          seen.get(id).islands.push({ x: isl.x, y: isl.y, name: isl.name });
          continue;
        }
        seen.set(id, {
          id,
          name: (isl._ownerNamesText || isl.ownerNamesText || "").split("\n")[i] || "",
          allyTags: isl.allyTags,
          islands: [{ x: isl.x, y: isl.y, name: isl.name }],
          maxArmyOnIsland: isl.maxArmy,
        });
      }
    }
    return [...seen.values()];
  },
};

// Pure synchronous filter evaluation module.
// Attaches to globalThis.MapFilter
//
// All evaluation state (custom results, preset results, devtools predicate)
// is passed in via a `ctx` parameter — this module stores nothing.
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
    { type: "armyMin", value: null, label: "Player army >=", color: "#FF6644", group: "Players", requiresRich: true, parameterized: true, paramKind: "number", paramPlaceholder: "e.g. 50000" },
    { type: "tradePartner", value: true, label: "Trade partners", color: "#E040FB", group: "Players" },
    // City marks — manual {lootable, looted, empty} per-city tags, independent of full scan
    { type: "markLootable", value: true, label: "Lootable", color: "#5ab87a", group: "Marks" },
    { type: "markLooted", value: true, label: "Looted", color: "#E04444", group: "Marks" },
    { type: "markEmpty", value: true, label: "Empty", color: "#9aa0a8", group: "Marks" },
    { type: "markUnmarked", value: true, label: "Unmarked", color: "#5a78a8", group: "Marks" },
  ];

  function matchFilter(isl, filter, ctx) {
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
        const n = Number(filter.value);
        if (!Number.isFinite(n)) return true;
        return (isl._maxArmy || 0) >= n;
      }
      case "tradePartner": return !!isl._tradePartner;
      case "markLootable": return isl._mark === "lootable";
      case "markLooted": return isl._mark === "looted";
      case "markEmpty": return isl._mark === "empty";
      case "markUnmarked": return !isl._mark;
      // Legacy aliases — pre-multi-state filter configs may still carry these.
      case "looted": return isl._mark === "looted";
      case "notLooted": return isl._mark !== "looted";
      case "customJs": {
        if (!ctx || !ctx.presetResults) return false;
        const presetMap = ctx.presetResults.get(filter.value);
        if (!presetMap) return false;
        const key = ctx.keyOf ? ctx.keyOf(isl) : (isl.x + ":" + isl.y);
        return !!presetMap.get(key);
      }
      default: return false;
    }
  }

  function matchGroup(isl, group, ctx) {
    if (!group.filters || group.filters.length === 0) return true;
    if (group.op === "and") {
      return group.filters.every((f) => matchFilter(isl, f, ctx));
    }
    return group.filters.some((f) => matchFilter(isl, f, ctx));
  }

  // Evaluate all predicate channels against one island.
  //
  // ctx = {
  //   devtoolsPredicate: fn|null,   — IkFilter.set() sync predicate
  //   keyOf: (isl) => string,       — key extractor for result map lookups
  //   customResults: Map|null,      — textarea custom JS pre-computed results
  //   presetResults: Map|null,      — Map<presetId, Map<key, bool>>
  // }
  function islandMatches(isl, config, ctx) {
    const c = ctx || {};
    // DevTools power-user predicate — always active when set (independent of
    // the filter panel's enabled toggle).
    if (c.devtoolsPredicate) {
      try { if (!c.devtoolsPredicate(isl)) return false; }
      catch (e) { /* swallow — bad predicate shouldn't kill rendering */ }
    }
    // Filter panel disabled -> skip both chip filters and Custom JS textarea.
    if (!config || !config.enabled) return true;
    // Pre-computed result map (from filter panel's Custom JS textarea)
    if (c.customResults && c.keyOf) {
      const key = c.keyOf(isl);
      if (!c.customResults.get(key)) return false;
    }
    if (!config.groups || config.groups.length === 0) return true;
    // Only consider groups that have filters
    const active = config.groups.filter((g) => g.enabled !== false && g.filters && g.filters.length > 0);
    if (active.length === 0) return true;
    if (config.globalOp === "and") {
      return active.every((g) => matchGroup(isl, g, c));
    }
    return active.some((g) => matchGroup(isl, g, c));
  }

  return { islandMatches, matchGroup, matchFilter, FILTER_OPTIONS };
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
//   _players         Array<{id, name, ally, allyId, state, cities, maxLevel, place, building, research, army, trader, cityIds, looted}>
//   _ctAvailable     boolean
//   _ctChecked       boolean
//   _looted          number          (timestamp of last "looted" mark, 0 otherwise — kept for legacy filter use)
//   _mark            string|null     ("lootable" | "looted" | "empty" | null)
//
// Examples:
//   IkFilter.set(i => i._allyTags && i._allyTags.has("-DR-"))
//   IkFilter.set(i => i._maxArmy > 50000 && !i._allyTags.has("-DR-"))
//   IkFilter.set(i => i._players.some(p => p.ally === "BO-M" && p.army >= 30000))
//   IkFilter.set(i => i._ownerNamesText.includes("bob"))
//   IkFilter.clear()
//
// IkData.get() returns the raw queryIndex_{world} blob for ad-hoc inspection.
globalThis.IkFilter = (() => {
  let predicate = null;

  return {
    set(fn) {
      predicate = (typeof fn === "function") ? fn : null;
      window.dispatchEvent(new CustomEvent("ik-custom-predicate-change"));
    },
    clear() {
      predicate = null;
      window.dispatchEvent(new CustomEvent("ik-custom-predicate-change"));
    },
    current() { return predicate; },
  };
})();

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

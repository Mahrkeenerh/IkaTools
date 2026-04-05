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
    // Population / free space
    { type: "pop", value: 15, label: "Pop < 15", color: "#5ab87a", group: "Population" },
    { type: "pop", value: 16, label: "Pop < 16", color: "#7acc94", group: "Population" },
  ];

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
    if (!config || !config.enabled) return true;
    if (!config.groups || config.groups.length === 0) return true;
    // Only consider groups that have filters
    const active = config.groups.filter((g) => g.filters && g.filters.length > 0);
    if (active.length === 0) return true;
    if (config.globalOp === "and") {
      return active.every((g) => matchGroup(isl, g));
    }
    return active.some((g) => matchGroup(isl, g));
  }

  return { islandMatches, matchGroup, matchFilter, FILTER_OPTIONS };
})();

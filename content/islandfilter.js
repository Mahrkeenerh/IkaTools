// Island view dimming — applies the same filter predicates used on the world
// map to individual city slots (cityLocationN divs) on the island view.
//
// Each cityLocationN is treated as a "virtual island" with island-level
// fields (coords, tradegood, wonder, cityCount) and per-city rich fields
// (_allyTags, _ownerNamesText, _maxArmy, _ctAvailable) so the existing
// MapFilter.islandMatches() works unchanged.
(() => {
  const TAG = "[IslandFilter]";

  let filterConfig = null;
  let ctPlayerIds = null; // Set of ownerIds with an available CT
  let ctCheckedIds = null; // Set of ownerIds actually checked in last CT scan
  let virtualCities = null; // array indexed by position; null entries = buildplace
  let tilesObserver = null;

  function isIslandView() {
    return document.body.id === "island";
  }

  async function loadCtData() {
    const worldName = IkUtils.getUrlWorldName() || "unknown";
    const data = await chrome.storage.local.get("ctScan_" + worldName);
    const ct = data["ctScan_" + worldName];
    if (ct) {
      ctPlayerIds = new Set((ct.ctPlayers || []).map((p) => String(p.id)));
      ctCheckedIds = new Set((ct.players || []).map((p) => String(p.id)));
    } else {
      ctPlayerIds = new Set();
      ctCheckedIds = new Set();
    }
  }

  // Read the ownership category from the game's own class list on the tile.
  function detectCityOwner(position) {
    const el = document.getElementById("cityLocation" + position);
    if (!el) return "";
    if (el.classList.contains("own")) return "own";
    if (el.classList.contains("ally")) return "ally";
    return "";
  }

  // Build one virtual-island object per city slot on the current island view.
  function buildVirtualCities() {
    const bg = IkUtils.parseBackgroundData();
    if (!bg || !bg.cities) return null;

    const parseScore = (v) => parseInt(String(v || "0").replace(/\s/g, ""), 10) || 0;
    const scores = bg.avatarScores || {};
    const x = parseInt(bg.islandXCoord || bg.xCoord || 0, 10);
    const y = parseInt(bg.islandYCoord || bg.yCoord || 0, 10);
    const tradegood = parseInt(bg.tradegood || 0, 10);
    const wonder = parseInt(bg.wonder || 0, 10);
    // Total populated (non-buildplace) cities on this island
    const cityCount = bg.cities.filter((c) => c && c.type !== "buildplace").length;

    const result = [];
    for (let i = 0; i < bg.cities.length; i++) {
      const c = bg.cities[i];
      if (!c || c.type === "buildplace") { result.push(null); continue; }
      const ownerId = String(c.ownerId || "");
      const sc = scores[ownerId] || {};
      const army = Math.round(parseScore(sc.army_score_main) / 100);
      const allyTag = c.ownerAllyTag || "";
      const isPiracy = !!(c.actions && c.actions.piracy_raid);

      result.push({
        // Island-level fields (shared across all cities on this island)
        x, y, cities: cityCount, tradegood, wonder,
        military: false, war: false, helios: false,
        // City-level fields
        owner: detectCityOwner(i),
        piracy: isPiracy,
        // Rich-data fields — stamped to match enrichIslandsWithRichData format
        _allyTags: new Set(allyTag ? [allyTag] : []),
        _ownerNamesText: (c.ownerName || "").toLowerCase(),
        _maxArmy: army,
        _ctAvailable: ctPlayerIds ? ctPlayerIds.has(ownerId) : false,
        _ctChecked: ctCheckedIds ? ctCheckedIds.has(ownerId) : false,
      });
    }
    return result;
  }

  function setTileOpacity(position, opacity) {
    const tile = document.getElementById("cityLocation" + position);
    const scroll = document.getElementById("cityLocation" + position + "Scroll");
    if (tile) tile.style.opacity = opacity;
    if (scroll) scroll.style.opacity = opacity;
  }

  function applyDimming() {
    if (!isIslandView()) return;

    const hasFilters = filterConfig && filterConfig.enabled &&
      filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
    const hasCustom = globalThis.MapFilter && MapFilter.getCustomPredicate && MapFilter.getCustomPredicate();

    if (!hasFilters && !hasCustom) {
      // Clear all opacity — quick path, no need to build virtual cities
      document.querySelectorAll('[id^="cityLocation"]').forEach((el) => {
        el.style.opacity = "";
      });
      return;
    }

    if (!virtualCities) virtualCities = buildVirtualCities();
    if (!virtualCities) return;

    for (let i = 0; i < virtualCities.length; i++) {
      const isl = virtualCities[i];
      if (!isl) {
        // Buildplace — never matches a rich filter; dim it whenever any filter is active
        setTileOpacity(i, "0.35");
        continue;
      }
      const match = MapFilter.islandMatches(isl, filterConfig);
      setTileOpacity(i, match ? "" : "0.35");
    }
  }

  function startTileObserver() {
    if (tilesObserver) return;
    const container = document.getElementById("cities");
    if (!container) return;
    let debounce = null;
    tilesObserver = new MutationObserver(() => {
      // City list rebuilds (e.g. state changes) — invalidate and reapply
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        virtualCities = null;
        applyDimming();
      }, 150);
    });
    tilesObserver.observe(container, { childList: true, subtree: true });
  }

  function stopTileObserver() {
    if (tilesObserver) { tilesObserver.disconnect(); tilesObserver = null; }
  }

  async function init() {
    const data = await chrome.storage.local.get("mapFilters");
    filterConfig = data.mapFilters || null;
    await loadCtData();
    virtualCities = null;
    applyDimming();
    startTileObserver();
  }

  // Filter panel updates
  window.addEventListener("ik-filter-change", (e) => {
    filterConfig = e.detail;
    applyDimming();
  });

  // Power-user JS predicate toggled
  window.addEventListener("ik-custom-predicate-change", () => applyDimming());

  // View transitions (island ↔ world map)
  const viewObs = new MutationObserver(() => {
    if (isIslandView()) {
      virtualCities = null;
      init();
    } else {
      stopTileObserver();
    }
  });
  viewObs.observe(document.body, { attributes: true, attributeFilter: ["id"] });

  // React to CT scan updates (invalidates _ctAvailable stamps)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const worldName = IkUtils.getUrlWorldName() || "unknown";
    if (changes["ctScan_" + worldName]) {
      loadCtData().then(() => {
        virtualCities = null;
        applyDimming();
      });
    }
    if (changes.mapFilters) {
      filterConfig = changes.mapFilters.newValue;
      virtualCities = null; // owner classes may have shifted between visits
      applyDimming();
    }
  });

  // Run once on load if we're already on the island view
  if (isIslandView()) init();
})();

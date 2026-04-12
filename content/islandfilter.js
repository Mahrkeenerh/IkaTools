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

  // Evaluate the filter-panel Custom JS predicate against the current
  // virtual cities. Stores results in MapFilter keyed by position string
  // so the sync matchFilter path can look them up without bridge traffic.
  async function refreshCustomResults() {
    if (!globalThis.CustomEval || !CustomEval.hasCode()) {
      if (globalThis.MapFilter) MapFilter.setCustomResults(null);
      return;
    }
    if (!virtualCities) virtualCities = buildVirtualCities();
    if (!virtualCities) return;
    // Skip nulls (buildplaces) — they never match a predicate
    const pairs = [];
    for (let i = 0; i < virtualCities.length; i++) {
      if (virtualCities[i]) pairs.push({ pos: i, isl: virtualCities[i] });
    }
    if (pairs.length === 0) return;
    const r = await CustomEval.evaluate(pairs.map((p) => p.isl));
    if (r.error) {
      MapFilter.setCustomResults(null);
      return;
    }
    const map = new Map();
    for (let i = 0; i < pairs.length; i++) {
      map.set(String(pairs[i].pos), !!r.matches[i]);
    }
    MapFilter.setCustomResults(map, (isl) => String(isl._position));
  }

  // Evaluate saved JS preset chips against the current island's virtual cities.
  let activePresets = []; // [{id, code}] from the last ik-preset-change event

  async function refreshPresetResults() {
    if (!globalThis.CustomEval || !globalThis.MapFilter) return;
    MapFilter.clearAllPresetResults();
    if (activePresets.length === 0) return;
    if (!virtualCities) virtualCities = buildVirtualCities();
    if (!virtualCities) return;
    const pairs = [];
    for (let i = 0; i < virtualCities.length; i++) {
      if (virtualCities[i]) pairs.push({ pos: i, isl: virtualCities[i] });
    }
    if (pairs.length === 0) return;
    const keyFn = (isl) => String(isl._position);
    for (const preset of activePresets) {
      const cr = await CustomEval.compilePreset(preset.id, preset.code);
      if (!cr.ok) continue;
      const er = await CustomEval.evaluatePreset(preset.id, pairs.map((p) => p.isl));
      if (er.error || !er.matches) continue;
      const map = new Map();
      for (let i = 0; i < pairs.length; i++) {
        map.set(String(pairs[i].pos), !!er.matches[i]);
      }
      MapFilter.setPresetResult(preset.id, map, keyFn);
    }
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
      const building = Math.round(parseScore(sc.building_score_main) / 100);
      const research = Math.round(parseScore(sc.research_score_main) / 100);
      const trader = Math.round(parseScore(sc.trader_score_secondary) / 100);
      const place = parseScore(sc.place);
      const allyTag = c.ownerAllyTag || "";
      const isPiracy = !!(c.actions && c.actions.piracy_raid);

      result.push({
        // Island-level fields (shared across all cities on this island)
        x, y, cities: cityCount, tradegood, wonder,
        military: false, war: false, helios: false,
        // City-level fields
        _position: i, // used as the lookup key for custom-predicate results
        owner: detectCityOwner(i),
        piracy: isPiracy,
        // Rich-data fields — stamped to match enrichIslandsWithRichData format
        _allyTags: new Set(allyTag ? [allyTag] : []),
        _ownerNamesText: (c.ownerName || "").toLowerCase(),
        _maxArmy: army,
        _players: [{
          id: ownerId,
          name: c.ownerName || "",
          ally: allyTag,
          allyId: String(c.ownerAllyId || "0"),
          state: c.state || "",
          cities: 1,
          maxLevel: parseInt(c.level || 0, 10),
          place, building, research, army, trader,
        }],
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

    const enabled = filterConfig && filterConfig.enabled;
    const hasFilters = enabled &&
      filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
    const hasDevTools = globalThis.MapFilter &&
      MapFilter.getCustomPredicate && MapFilter.getCustomPredicate();
    // Textarea custom JS respects the panel's enabled toggle
    const hasTextarea = enabled && globalThis.MapFilter &&
      MapFilter.hasCustomResults && MapFilter.hasCustomResults();

    const hasPresets = enabled && globalThis.MapFilter &&
      MapFilter.hasPresetResults && MapFilter.hasPresetResults();

    if (!hasFilters && !hasDevTools && !hasTextarea && !hasPresets) {
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

  // Wait for island DOM to be fully ready (background data scripts + #cities
  // container). The body.id changes to "island" before the game injects the
  // island content, so init() must not assume the DOM is populated yet.
  function waitForIslandDOM() {
    return new Promise((resolve) => {
      let attempts = 0;
      function check() {
        if (!isIslandView()) { resolve(false); return; }
        if (IkUtils.parseBackgroundData() && document.getElementById("cities")) {
          resolve(true);
          return;
        }
        if (++attempts > 40) { resolve(false); return; } // 2s max
        setTimeout(check, 50);
      }
      check();
    });
  }

  async function init() {
    const data = await chrome.storage.local.get([
      "mapFilters", "mapCustomPredicateCode", "mapCustomPredicateEnabled",
      "customJsPresets",
    ]);
    filterConfig = data.mapFilters || null;
    await loadCtData();
    virtualCities = null;

    const ready = await waitForIslandDOM();
    if (!ready) return;

    // The filter panel compiles saved custom JS asynchronously (fire-and-forget)
    // so it may not be ready when we reach this point. Compile it ourselves to
    // guarantee custom-JS dimming applies on first render.
    if (globalThis.CustomEval) {
      const savedCode = data.mapCustomPredicateCode || "";
      const customOn = data.mapCustomPredicateEnabled !== false;
      if (savedCode && customOn && !CustomEval.hasCode()) {
        await CustomEval.compile(savedCode);
      }
      // Same for preset chips — extract active presets from filter config
      if (filterConfig && filterConfig.enabled && filterConfig.groups) {
        const presets = data.customJsPresets || [];
        const active = [];
        for (const group of filterConfig.groups) {
          if (group.enabled === false) continue;
          for (const f of (group.filters || [])) {
            if (f.type === "customJs" && !active.some((p) => p.id === f.value)) {
              const preset = presets.find((p) => p.id === f.value);
              if (preset) active.push({ id: preset.id, code: preset.code });
            }
          }
        }
        if (active.length > 0) activePresets = active;
      }
    }

    // Re-evaluate any restored custom code and presets against this island's cities
    await refreshCustomResults();
    await refreshPresetResults();
    applyDimming();
    startTileObserver();
  }

  // Filter panel updates
  window.addEventListener("ik-filter-change", (e) => {
    filterConfig = e.detail;
    applyDimming();
  });

  // Preset chips changed — compile+evaluate active presets per city
  window.addEventListener("ik-preset-change", async (e) => {
    activePresets = (e.detail && e.detail.presets) || [];
    virtualCities = null;
    await refreshPresetResults();
    applyDimming();
  });

  // Custom JS predicate (re)applied from filter panel — re-evaluate per city
  window.addEventListener("ik-custom-code-apply", async (e) => {
    virtualCities = null;
    if (!e.detail?.disabled) await refreshCustomResults();
    applyDimming();
  });

  // Power-user JS predicate toggled via IkFilter (DevTools API) — redraw
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
      loadCtData().then(async () => {
        virtualCities = null;
        await refreshCustomResults();
        await refreshPresetResults();
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

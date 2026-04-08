// Mini-map overlay on the game page
// Shows saved world map with viewport indicator, click-to-navigate, live merge
(() => {
  const STORAGE_KEY_ENABLED = "minimapEnabled";
  const STORAGE_KEY_POSITION = "minimapPosition";
  const STORAGE_KEY_SCALE = "minimapScale";
  const BASE_W = 260;
  const BASE_H = 180;

  // Ikariam tile pixel spacing
  const TILE_PX_COL = 120;
  const TILE_PX_ROW = 60;

  let container = null;
  let mapCanvas = null;
  let mapCtx = null;
  let scanPanel = null;
  let canvasWrapper = null;
  let layerBarEl = null;
  let topBarEl = null;
  let currentMapData = null;
  let scanMode = null; // null | "scan" | "progress" | "map"
  let minimapScale = 1.25;
  let vpTrimRight = 0.08;
  let vpTrimBottom = 0.15;
  let currentLayer = "population";
  let dimEmpty = false;
  let lastRenderPxMin = 0;
  let lastRenderPyMin = 0;
  let lastRenderTw = 1;
  let lastRenderTh = 1;
  let lastRenderPad = 4;
  let cachedBaseMap = null; // offscreen canvas with islands only
  let cachedLayer = null;
  let cachedScale = null;
  let cachedIslandCount = 0;
  let cachedDimEmpty = null;
  let allyVersion = 0; // bumped whenever allianceIndex changes
  let cachedAllyVersion = -1;
  let filterConfig = null;
  let cachedFilterJSON = null;

  function getViewportCorners() {
    const worldview = document.getElementById("worldview");
    if (!worldview) return null;

    // Find an island tile to use as anchor — its screen position and game
    // coords come from the SAME element, so they're always in sync even
    // when the game reloads the tile grid.
    const anchor = document.querySelector(".islandTile[title]");
    if (!anchor) return null;

    const tm = anchor.getAttribute("title").match(/\[(\d+):(\d+)\]$/);
    const tidm = anchor.id.match(/^tile_(\d+)_(\d+)$/);
    if (!tm || !tidm) return null;

    const gameX = parseInt(tm[1], 10);
    const gameY = parseInt(tm[2], 10);
    const col = parseInt(tidm[1], 10);
    const row = parseInt(tidm[2], 10);

    // This tile's position in map1 pixel space (from the iso grid formula)
    const tilePxX = (col - row) * TILE_PX_COL;
    const tilePxY = (col + row) * TILE_PX_ROW;

    // This tile's position on screen
    const anchorRect = anchor.getBoundingClientRect();
    const anchorScreenX = anchorRect.left;
    const anchorScreenY = anchorRect.top;

    // Visible area: worldview clipped by browser window
    const wvRect = worldview.getBoundingClientRect();
    const clipLeft = Math.max(wvRect.left, 0);
    const clipTop = Math.max(wvRect.top, 0);
    const rawRight = Math.min(wvRect.right, window.innerWidth);
    const rawBottom = Math.min(wvRect.bottom, window.innerHeight);

    // The game renders extra tiles as scroll buffer beyond what's visible.
    const visW = rawRight - clipLeft;
    const visH = rawBottom - clipTop;
    const clipRight = rawRight - visW * vpTrimRight;
    const clipBottom = rawBottom - visH * vpTrimBottom;

    // Convert screen coords → map1 pixel space using the anchor tile
    // screen pos X = anchorScreenX corresponds to map1 pixel tilePxX
    function screenToMap1(sx, sy) {
      return {
        px: sx - anchorScreenX + tilePxX,
        py: sy - anchorScreenY + tilePxY,
      };
    }

    // base coords: game_x = baseX + col, game_y = baseY + row
    const baseX = gameX - col;
    const baseY = gameY - row;

    function map1ToGame(px, py) {
      const c = px / (2 * TILE_PX_COL) + py / (2 * TILE_PX_ROW);
      const r = py / (2 * TILE_PX_ROW) - px / (2 * TILE_PX_COL);
      return { x: baseX + c, y: baseY + r };
    }

    const tl = screenToMap1(clipLeft, clipTop);
    const tr = screenToMap1(clipRight, clipTop);
    const br = screenToMap1(clipRight, clipBottom);
    const bl = screenToMap1(clipLeft, clipBottom);

    return [
      map1ToGame(tl.px, tl.py),
      map1ToGame(tr.px, tr.py),
      map1ToGame(br.px, br.py),
      map1ToGame(bl.px, bl.py),
    ];
  }

  function readAndMergeTiles() {
    if (!currentMapData || !currentMapData.islands) return false;

    const newTiles = IkUtils.parseTilesFromDOM();
    if (newTiles.length === 0) return false;

    const worldName = IkUtils.getUrlWorldName();
    if (!worldName) return false;

    // Skip writes while scanner is running to avoid storage races
    chrome.storage.local.get(["scanInProgress", "map_" + worldName], (data) => {
      if (data.scanInProgress) return;

      // Atomic re-read: merge against the latest stored value, not our potentially
      // stale in-memory copy, so concurrent writes from other tabs don't get lost.
      const storedData = data["map_" + worldName];
      const baseIslands = (storedData && storedData.islands) ? storedData.islands : currentMapData.islands;

      const existing = new Map();
      for (const isl of baseIslands) {
        existing.set(`${isl.x}:${isl.y}`, isl);
      }
      let changed = false;

      for (const newIsland of newTiles) {
        const key = `${newIsland.x}:${newIsland.y}`;
        const old = existing.get(key);
        if (!old) {
          existing.set(key, newIsland);
          changed = true;
        } else if (old.cities !== newIsland.cities || old.owner !== newIsland.owner) {
          // Merge: new data wins for cities/owner, but keep existing richer scanner
          // fields (wonder, tradegood, military, war, barbarian, etc.) when the new
          // data doesn't carry them (undefined or falsy-zero for numeric fields).
          const merged = Object.assign({}, old);
          for (const [k, v] of Object.entries(newIsland)) {
            if (v !== undefined && v !== null && v !== "") {
              // For numeric scanner fields that default to 0, only overwrite when
              // the old entry has no value (undefined/null) — keeps scanner data.
              if ((k === "wonder" || k === "tradegood") && old[k]) continue;
              merged[k] = v;
            }
          }
          existing.set(key, merged);
          changed = true;
        }
      }

      if (changed) {
        currentMapData.islands = Array.from(existing.values());
        cachedBaseMap = null; // invalidate cache
        chrome.storage.local.set({
          ["map_" + worldName]: { ...currentMapData, scanDate: new Date().toISOString() },
        });
      }
    });

    // Return true optimistically so callers know tiles were processed
    return true;
  }

  function updateLayerBar() {
    if (!layerBarEl) return;
    layerBarEl.querySelectorAll("button").forEach((b) => {
      b.style.background = b.dataset.layer === currentLayer ? "#2a4a6a" : "transparent";
      b.style.color = b.dataset.layer === currentLayer ? "#e0e8f0" : "#6a7a8a";
    });
  }

  function createOverlay(position) {
    if (container) container.remove();

    container = document.createElement("div");
    container.id = "ik-minimap";
    Object.assign(container.style, {
      position: "fixed",
      bottom: "12px",
      [position === "left" ? "left" : "right"]: "12px",
      zIndex: "99999",
      background: "rgba(10, 22, 40, 0.92)",
      borderRadius: "8px",
      border: "1px solid rgba(60, 90, 130, 0.5)",
      padding: "4px",
      cursor: "crosshair",
      boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    });

    // Canvas wrapper (for overlaying controls on top)
    canvasWrapper = document.createElement("div");
    const wrapper = canvasWrapper;
    Object.assign(wrapper.style, { position: "relative" });

    mapCanvas = document.createElement("canvas");
    mapCanvas.style.borderRadius = "6px";
    mapCanvas.style.display = "block";
    mapCanvas.style.imageRendering = "pixelated";
    wrapper.appendChild(mapCanvas);
    mapCtx = mapCanvas.getContext("2d");

    mapCanvas.addEventListener("click", onMinimapClick);

    // Top overlay bar (scale + collapse) — sits on top of the canvas
    const topBar = document.createElement("div");
    Object.assign(topBar.style, {
      position: "absolute",
      top: "2px",
      left: "2px",
      right: "2px",
      display: "flex",
      gap: "2px",
      alignItems: "center",
      pointerEvents: "none",
    });

    const scales = [0.75, 1, 1.25, 1.5, 2];
    for (const s of scales) {
      const btn = document.createElement("button");
      btn.textContent = s + "x";
      btn.dataset.scale = s;
      Object.assign(btn.style, {
        padding: "3px 5px", border: "1px solid rgba(42,58,85,0.7)", borderRadius: "3px",
        background: s === minimapScale ? "rgba(42,74,106,0.8)" : "rgba(10,22,40,0.6)",
        color: s === minimapScale ? "#e0e8f0" : "#6a7a8a",
        cursor: "pointer", fontSize: "10px", fontFamily: "sans-serif", lineHeight: "12px",
        pointerEvents: "auto",
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        minimapScale = s;
        cachedBaseMap = null;
        chrome.storage.local.set({ minimapScale: s });
        topBar.querySelectorAll("[data-scale]").forEach((b) => {
          b.style.background = parseFloat(b.dataset.scale) === s ? "rgba(42,74,106,0.8)" : "rgba(10,22,40,0.6)";
          b.style.color = parseFloat(b.dataset.scale) === s ? "#e0e8f0" : "#6a7a8a";
        });
        drawMinimap();
      });
      topBar.appendChild(btn);
    }

    // Fullscreen button — opens large render in a new tab (same style as scale buttons)
    const fullBtn = document.createElement("button");
    fullBtn.textContent = "\u26F6";
    fullBtn.title = "Open full-size map in new tab";
    Object.assign(fullBtn.style, {
      padding: "3px 5px", border: "1px solid rgba(42,58,85,0.7)", borderRadius: "3px",
      background: "rgba(10,22,40,0.6)", color: "#6a7a8a",
      cursor: "pointer", fontSize: "8px", fontFamily: "sans-serif", lineHeight: "12px",
      pointerEvents: "auto",
    });
    fullBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFullMap();
    });
    topBar.appendChild(fullBtn);

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    topBar.appendChild(spacer);

    const collapseLabel = document.createElement("span");
    collapseLabel.textContent = "Map";
    Object.assign(collapseLabel.style, {
      color: "#8890a0", fontSize: "10px", fontFamily: "sans-serif",
      display: "none", pointerEvents: "none", marginRight: "4px",
    });
    topBar.appendChild(collapseLabel);

    const collapseBtn = document.createElement("button");
    collapseBtn.textContent = "\u25BC";
    Object.assign(collapseBtn.style, {
      padding: "3px 6px", border: "1px solid rgba(42,58,85,0.7)", borderRadius: "3px",
      background: "rgba(10,22,40,0.6)", color: "#667",
      cursor: "pointer", fontSize: "10px", fontFamily: "sans-serif", lineHeight: "12px",
      pointerEvents: "auto",
    });
    topBar.appendChild(collapseBtn);

    wrapper.appendChild(topBar);
    container.appendChild(wrapper);

    topBarEl = topBar;

    // Scan panel (shown when no map data or scan in progress)
    scanPanel = document.createElement("div");
    scanPanel.id = "ik-minimap-scan";
    Object.assign(scanPanel.style, {
      display: "none",
      padding: "12px 8px",
      textAlign: "center",
    });

    const scanBtn = document.createElement("button");
    scanBtn.id = "ik-scan-btn";
    scanBtn.textContent = "Scan World Map";
    Object.assign(scanBtn.style, {
      padding: "8px 16px",
      border: "1px solid rgba(60,90,130,0.6)",
      borderRadius: "4px",
      background: "rgba(42,74,106,0.8)",
      color: "#e0e8f0",
      cursor: "pointer",
      fontSize: "12px",
      fontFamily: "sans-serif",
    });
    scanBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!isWorldMapView()) return;
      if (!globalThis.IkScanner) return;
      if (globalThis.IkScanner.scanning) return;
      globalThis.IkScanner.startScan();
      showProgressUI({ phase: "probe", current: 0, total: 1, found: 0 });
    });
    scanPanel.appendChild(scanBtn);

    const progressWrap = document.createElement("div");
    progressWrap.id = "ik-scan-progress";
    Object.assign(progressWrap.style, { display: "none", marginTop: "8px" });

    const progressBarOuter = document.createElement("div");
    Object.assign(progressBarOuter.style, {
      width: "100%",
      height: "6px",
      background: "rgba(30,50,70,0.8)",
      borderRadius: "3px",
      overflow: "hidden",
    });
    const progressBarInner = document.createElement("div");
    progressBarInner.id = "ik-scan-bar";
    Object.assign(progressBarInner.style, {
      width: "0%",
      height: "100%",
      background: "#4a90d9",
      borderRadius: "3px",
      transition: "width 0.3s ease",
    });
    progressBarOuter.appendChild(progressBarInner);
    progressWrap.appendChild(progressBarOuter);

    const progressPhase = document.createElement("div");
    progressPhase.id = "ik-scan-phase";
    Object.assign(progressPhase.style, {
      color: "#8890a0",
      fontSize: "10px",
      fontFamily: "sans-serif",
      marginTop: "4px",
    });
    progressWrap.appendChild(progressPhase);

    const progressDetail = document.createElement("div");
    progressDetail.id = "ik-scan-detail";
    Object.assign(progressDetail.style, {
      color: "#667788",
      fontSize: "10px",
      fontFamily: "sans-serif",
      marginTop: "2px",
    });
    progressWrap.appendChild(progressDetail);
    scanPanel.appendChild(progressWrap);

    container.appendChild(scanPanel);

    // Layer selector bar (below canvas)
    const layerBar = document.createElement("div");
    layerBarEl = layerBar;
    Object.assign(layerBar.style, {
      display: "flex",
      gap: "2px",
      padding: "3px 0 0",
      flexWrap: "wrap",
    });

    const layerKeys = Object.keys(globalThis.MapRender?.LAYERS || {});
    for (const key of layerKeys) {
      const btn = document.createElement("button");
      btn.textContent = (globalThis.MapRender.LAYERS[key].name || key).slice(0, 3);
      btn.title = globalThis.MapRender.LAYERS[key].name || key;
      btn.dataset.layer = key;
      Object.assign(btn.style, {
        padding: "2px 5px",
        border: "1px solid #2a3a55",
        borderRadius: "3px",
        background: key === currentLayer ? "#2a4a6a" : "transparent",
        color: key === currentLayer ? "#e0e8f0" : "#6a7a8a",
        cursor: "pointer",
        fontSize: "10px",
        fontFamily: "sans-serif",
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        currentLayer = key;
        cachedBaseMap = null;
        chrome.storage.local.set({ minimapLayer: key });
        layerBar.querySelectorAll("button").forEach((b) => {
          b.style.background = b.dataset.layer === key ? "#2a4a6a" : "transparent";
          b.style.color = b.dataset.layer === key ? "#e0e8f0" : "#6a7a8a";
        });
        drawMinimap();
      });
      layerBar.appendChild(btn);
    }
    container.appendChild(layerBar);

    // Collapse logic — move buttons out of canvas overlay into container
    let collapsed = false;

    function applyCollapsed() {
      if (collapsed) {
        mapCanvas.style.display = "none";
        layerBar.style.display = "none";
        scanPanel.style.display = "none";
        topBar.style.position = "static";
        topBar.style.pointerEvents = "auto";
        topBar.querySelectorAll("[data-scale]").forEach((b) => { b.style.display = "none"; });
        collapseLabel.style.display = "";
      } else {
        // Restore appropriate UI based on current mode
        if (scanMode === "scan" || scanMode === "progress") {
          scanPanel.style.display = "";
          mapCanvas.style.display = "none";
          layerBar.style.display = "none";
          topBar.style.position = "static";
          topBar.style.pointerEvents = "auto";
          topBar.querySelectorAll("[data-scale]").forEach((b) => { b.style.display = "none"; });
        } else {
          mapCanvas.style.display = "block";
          layerBar.style.display = "flex";
          scanPanel.style.display = "none";
          topBar.style.position = "absolute";
          topBar.style.pointerEvents = "none";
          topBar.querySelectorAll("[data-scale]").forEach((b) => { b.style.display = ""; });
        }
        collapseLabel.style.display = "none";
      }
      collapseBtn.textContent = collapsed ? "\u25B2" : "\u25BC";
    }

    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      chrome.storage.local.set({ minimapCollapsed: collapsed });
      applyCollapsed();
    });

    // Restore persisted collapse state
    chrome.storage.local.get("minimapCollapsed", (data) => {
      if (data.minimapCollapsed) {
        collapsed = true;
        applyCollapsed();
      }
    });

    document.body.appendChild(container);
  }

  function onMinimapClick(e) {
    const rect = mapCanvas.getBoundingClientRect();
    const clickPx = e.clientX - rect.left;
    const clickPy = e.clientY - rect.top;

    const rawPx = clickPx - lastRenderPad + lastRenderPxMin;
    const rawPy = clickPy - lastRenderPad + lastRenderPyMin;
    const gx = Math.round(rawPx / lastRenderTw + rawPy / lastRenderTh);
    const gy = Math.round(rawPy / lastRenderTh - rawPx / lastRenderTw);

    window.dispatchEvent(new CustomEvent("ik-jump", { detail: { x: gx, y: gy } }));
    setTimeout(drawMinimap, 200);
  }

  let allianceIndex = null;
  let allianceColorMap = {};
  let queryIndex = null; // derived rich-data blob (queryIndex_{world})

  async function loadAllianceIndex() {
    const worldName = IkUtils.getUrlWorldName() || "unknown";
    const data = await chrome.storage.local.get([
      "allianceIndex_" + worldName,
      "queryIndex_" + worldName,
    ]);
    allianceIndex = data["allianceIndex_" + worldName] || {};
    queryIndex = data["queryIndex_" + worldName] || null;
    const islands = currentMapData && currentMapData.islands;
    allianceColorMap = MapRender.buildAllianceColorMap(allianceIndex, islands);
    allyVersion++;
    islandsByCoord = null; // invalidate dim-path lookup
  }

  // Stamp rich-data fields onto each island so the filter engine can read
  // them without storage round-trips. Underscore fields are conventional
  // "computed-by-enrichment" markers consumed by mapfilter.matchFilter.
  function enrichIslandsWithRichData(islands) {
    if (!queryIndex || !queryIndex.islandsByCoord) {
      // Clear stale enrichment so old data doesn't leak through
      for (const isl of islands) {
        isl._allyTags = null;
        isl._ownerNamesText = null;
        isl._maxArmy = 0;
        isl._ctAvailable = false;
        isl._ctChecked = false;
      }
      return;
    }
    const byCoord = queryIndex.islandsByCoord;
    for (const isl of islands) {
      const entry = byCoord[isl.x + ":" + isl.y];
      if (!entry) {
        isl._allyTags = null;
        isl._ownerNamesText = null;
        isl._maxArmy = 0;
        isl._ctAvailable = false;
        isl._ctChecked = false;
        continue;
      }
      isl._allyTags = new Set(entry.allyTags || []);
      isl._ownerNamesText = entry.ownerNamesText || "";
      isl._maxArmy = entry.maxArmy || 0;
      isl._ctAvailable = !!entry.ctAvailable;
      isl._ctChecked = !!entry.ctChecked;
    }
  }

  function rebuildBaseMap() {
    if (!currentMapData || !globalThis.MapRender) return;
    const islands = currentMapData.islands;
    if (!islands || islands.length === 0) return;
    MapRender.enrichIslandsWithAlliances(islands, allianceIndex || {}, allianceColorMap);
    enrichIslandsWithRichData(islands);
    pushMatchCount(islands);

    const tw = Math.max(1, Math.round(3 * minimapScale));
    const th = Math.max(1, Math.round(3 * minimapScale));
    const iSize = Math.max(1, Math.round(2 * minimapScale));
    const padding = Math.max(2, Math.round(6 * minimapScale));

    cachedBaseMap = document.createElement("canvas");
    const baseCtx = cachedBaseMap.getContext("2d");

    const renderInfo = globalThis.MapRender.render(baseCtx, islands, {
      tileW: tw, tileH: th, islandSize: iSize, pad: padding,
      drawLegend: false, layer: currentLayer, dimEmpty: dimEmpty,
      filterConfig: filterConfig,
    });

    lastRenderPxMin = renderInfo.pxMin;
    lastRenderPyMin = renderInfo.pyMin;
    lastRenderTw = tw;
    lastRenderTh = th;
    lastRenderPad = padding;
    cachedLayer = currentLayer;
    cachedScale = minimapScale;
    cachedIslandCount = islands.length;
    cachedDimEmpty = dimEmpty;
    cachedAllyVersion = allyVersion;
  }

  // Compute the active match count and push it to the filter panel for the
  // status footer. Cheap — same predicate logic the renderer uses.
  function pushMatchCount(islands) {
    if (!globalThis.MapFilter || !globalThis.IkFilterPanel) return;
    const hasFilters = filterConfig && filterConfig.enabled &&
      filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
    const hasCustom = MapFilter.getCustomPredicate && MapFilter.getCustomPredicate();
    if (!hasFilters && !hasCustom) {
      IkFilterPanel.setMatchCount(null);
      return;
    }
    let n = 0;
    for (const isl of islands) {
      if (MapFilter.islandMatches(isl, filterConfig)) n++;
    }
    IkFilterPanel.setMatchCount(n);
  }

  function openFullMap() {
    if (!currentMapData || !globalThis.MapRender) return;
    const islands = currentMapData.islands;
    if (!islands || islands.length === 0) return;
    MapRender.enrichIslandsWithAlliances(islands, allianceIndex || {}, allianceColorMap);
    enrichIslandsWithRichData(islands);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    MapRender.render(ctx, islands, {
      layer: currentLayer, dimEmpty: dimEmpty, filterConfig: filterConfig,
    });
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  }

  function drawMinimap() {
    if (!currentMapData || !mapCtx || !globalThis.MapRender) return;
    const islands = currentMapData.islands;
    if (!islands || islands.length === 0) return;

    // Rebuild base map only when layer, scale, data, or filters change
    const filterJSON = filterConfig ? JSON.stringify(filterConfig) : null;
    if (!cachedBaseMap || cachedLayer !== currentLayer ||
        cachedScale !== minimapScale || cachedIslandCount !== islands.length ||
        cachedDimEmpty !== dimEmpty || cachedFilterJSON !== filterJSON ||
        cachedAllyVersion !== allyVersion) {
      cachedFilterJSON = filterJSON;
      rebuildBaseMap();
    }
    if (!cachedBaseMap) return;

    // Copy cached base to display canvas
    mapCanvas.width = cachedBaseMap.width;
    mapCanvas.height = cachedBaseMap.height;
    mapCtx.drawImage(cachedBaseMap, 0, 0);

    // Draw viewport overlay (cheap — just 4 lines)
    const corners = getViewportCorners();
    if (corners && corners.length === 4) {
      const isoToPixel = globalThis.MapRender.isoToPixel;
      const pts = corners.map((c) => {
        const { px, py } = isoToPixel(c.x, c.y, lastRenderTw, lastRenderTh);
        return { x: px - lastRenderPxMin + lastRenderPad, y: py - lastRenderPyMin + lastRenderPad };
      });

      mapCtx.strokeStyle = "rgba(255,255,255,0.8)";
      mapCtx.lineWidth = 1.5;
      mapCtx.setLineDash([5, 3]);
      mapCtx.beginPath();
      mapCtx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) mapCtx.lineTo(pts[i].x, pts[i].y);
      mapCtx.closePath();
      mapCtx.stroke();
      mapCtx.setLineDash([]);
    }
  }

  function showScanUI() {
    scanMode = "scan";
    if (!container) return;
    scanPanel.style.display = "";
    const scanBtn = scanPanel.querySelector("#ik-scan-btn");
    const progressWrap = scanPanel.querySelector("#ik-scan-progress");
    if (scanBtn) scanBtn.style.display = "";
    if (progressWrap) progressWrap.style.display = "none";
    if (canvasWrapper) canvasWrapper.querySelector("canvas").style.display = "none";
    if (layerBarEl) layerBarEl.style.display = "none";
    if (topBarEl) {
      topBarEl.style.position = "static";
      topBarEl.style.pointerEvents = "auto";
      topBarEl.querySelectorAll("[data-scale]").forEach((b) => { b.style.display = "none"; });
    }
  }

  function showProgressUI(progress) {
    scanMode = "progress";
    if (!container) return;
    scanPanel.style.display = "";
    const scanBtn = scanPanel.querySelector("#ik-scan-btn");
    const progressWrap = scanPanel.querySelector("#ik-scan-progress");
    if (scanBtn) scanBtn.style.display = "none";
    if (progressWrap) progressWrap.style.display = "";
    if (canvasWrapper) canvasWrapper.querySelector("canvas").style.display = "none";
    if (layerBarEl) layerBarEl.style.display = "none";
    if (topBarEl) {
      topBarEl.style.position = "static";
      topBarEl.style.pointerEvents = "auto";
      topBarEl.querySelectorAll("[data-scale]").forEach((b) => { b.style.display = "none"; });
    }
    updateProgressBar(progress);
  }

  function updateProgressBar(progress) {
    if (!progress) return;
    const bar = scanPanel.querySelector("#ik-scan-bar");
    const phase = scanPanel.querySelector("#ik-scan-phase");
    const detail = scanPanel.querySelector("#ik-scan-detail");
    const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    if (bar) bar.style.width = pct + "%";
    const phaseLabels = { probe: "Probing...", cross: "Detecting bounds...", fill: "Scanning map..." };
    if (phase) phase.textContent = phaseLabels[progress.phase] || progress.phase || "";
    if (detail) detail.textContent = `${progress.current}/${progress.total} jumps \u2022 ${progress.found} islands`;
  }

  function showMapUI() {
    scanMode = "map";
    if (!container) return;
    scanPanel.style.display = "none";
    if (canvasWrapper) canvasWrapper.querySelector("canvas").style.display = "block";
    if (layerBarEl) layerBarEl.style.display = "flex";
    if (topBarEl) {
      topBarEl.style.position = "absolute";
      topBarEl.style.pointerEvents = "none";
      topBarEl.querySelectorAll("[data-scale]").forEach((b) => { b.style.display = ""; });
    }
  }

  async function loadAndShow() {
    if (!isWorldMapView()) return;

    const worldName = IkUtils.getUrlWorldName();
    if (!worldName) return;

    const key = "map_" + worldName;
    const data = await chrome.storage.local.get([key, STORAGE_KEY_ENABLED, STORAGE_KEY_POSITION, STORAGE_KEY_SCALE, "vpTrimRight", "vpTrimBottom", "minimapLayer", "hideZeroCities", "scanInProgress", "scanProgress", "mapFilters"]);

    if (!data[STORAGE_KEY_ENABLED]) return;

    minimapScale = data[STORAGE_KEY_SCALE] || 1.25;
    vpTrimRight = data.vpTrimRight ?? 0.08;
    vpTrimBottom = data.vpTrimBottom ?? 0.15;
    currentLayer = data.minimapLayer || "population";
    dimEmpty = !!data.hideZeroCities;
    filterConfig = data.mapFilters || null;
    const position = data[STORAGE_KEY_POSITION] || "right";

    if (!container || !document.body.contains(container)) {
      createOverlay(position);
    }
    container.style.display = "";

    if (data[key]) {
      // Has map data — show map
      currentMapData = data[key];
      await loadAllianceIndex();
      const hasFilters = filterConfig && filterConfig.enabled &&
        filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
      if (hasFilters || dimEmpty) startDimming();
      readAndMergeTiles();
      showMapUI();
      drawMinimap();
    } else if (data.scanInProgress) {
      // Scan running but no map data yet — show progress
      showProgressUI(data.scanProgress || { phase: "probe", current: 0, total: 1, found: 0 });
    } else {
      // No data, no scan — show scan button
      showScanUI();
    }
  }

  // Poll map1 screen position via getBoundingClientRect — always accurate
  let scrollIntervalId = null;
  let mergeIntervalId = null;

  function watchWorldmapScroll() {
    let lastX = null, lastY = null;
    let lastBase = null;

    scrollIntervalId = setInterval(() => {
      if (!container || !document.body.contains(container) || container.style.display === "none") return;
      if (!isWorldMapView()) return;

      const anchor = document.querySelector(".islandTile[title]");
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const x = Math.round(rect.left);
      const y = Math.round(rect.top);
      const tid = anchor.id;

      if (x !== lastX || y !== lastY || tid !== lastBase) {
        lastX = x;
        lastY = y;
        lastBase = tid;
        drawMinimap();
      }
    }, 33); // ~30fps

    // Merge tiles less frequently
    mergeIntervalId = setInterval(() => {
      if (!container || !document.body.contains(container) || container.style.display === "none") return;
      if (!isWorldMapView() || !currentMapData) return;
      readAndMergeTiles();
    }, 3000);
  }

  function isWorldMapView() {
    return document.body.id === "worldmap_iso";
  }

  function showOrHide() {
    if (isWorldMapView()) {
      loadAndShow();
    } else {
      if (container) container.style.display = "none";
      stopDimming();
    }
  }

  // --- Dim islands on world map (filter-aware or zero-city fallback) ---
  let dimmingObserver = null;
  let islandsByCoord = null; // coord "x:y" -> enriched stored island

  // Rebuild the coord lookup from currentMapData + apply rich/alliance
  // enrichment. Called whenever the underlying data or enrichment changes.
  function rebuildIslandsByCoord() {
    islandsByCoord = null;
    if (!currentMapData || !currentMapData.islands) return;
    const islands = currentMapData.islands;
    if (globalThis.MapRender) {
      MapRender.enrichIslandsWithAlliances(islands, allianceIndex || {}, allianceColorMap);
    }
    enrichIslandsWithRichData(islands);
    const map = {};
    for (const isl of islands) map[isl.x + ":" + isl.y] = isl;
    islandsByCoord = map;
  }

  function applyDimming() {
    const hasFilters = filterConfig && filterConfig.enabled &&
      filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
    const hasCustom = globalThis.MapFilter && MapFilter.getCustomPredicate && MapFilter.getCustomPredicate();

    if (!hasFilters && !hasCustom && !dimEmpty) return;

    // Ensure the coord lookup exists — it's built lazily because currentMapData
    // may arrive after the first dimming pass.
    if (!islandsByCoord) rebuildIslandsByCoord();

    document.querySelectorAll(".islandTile, .oceanTile").forEach((tile) => {
      const title = tile.getAttribute("title") || "";
      const m = title.match(/\[(\d+):(\d+)\]$/);
      if (!m) { tile.style.opacity = ""; return; }

      if ((hasFilters || hasCustom) && globalThis.MapFilter) {
        const coord = m[1] + ":" + m[2];
        // Prefer the enriched stored island — it has _allyTags, _maxArmy, etc.
        let isl = islandsByCoord && islandsByCoord[coord];
        if (!isl) {
          // Fallback: build a minimal object from the DOM for old-style filters
          // (e.g. tiles outside the stored map — shouldn't normally happen).
          const citiesEl = tile.querySelector(".cities");
          const wonderEl = tile.querySelector('[class*="wonder wonder"]');
          const tgEl = tile.querySelector('[class*="tradegood tradegood"]');
          const piracyEl = tile.querySelector('[id^="piracy_"]');
          const heliosEl = tile.querySelector('[id^="helios_"]');
          const ownerEl = tile.querySelector('[id^="owner_"]');
          isl = {
            x: parseInt(m[1], 10), y: parseInt(m[2], 10),
            cities: citiesEl ? parseInt(citiesEl.textContent, 10) || 0 : 0,
            wonder: wonderEl ? parseInt(wonderEl.className.match(/wonder(\d+)/)?.[1], 10) || 0 : 0,
            tradegood: tgEl ? parseInt(tgEl.className.match(/tradegood(\d+)/)?.[1], 10) || 0 : 0,
            piracy: piracyEl ? piracyEl.className !== "" : false,
            helios: heliosEl ? heliosEl.className !== "" : false,
            owner: ownerEl ? ownerEl.className.replace("ownerState", "").trim() : "",
            military: false, war: false,
          };
        }

        tile.style.opacity = MapFilter.islandMatches(isl, filterConfig) ? "" : "0.35";
      } else {
        // Fallback: dim empty islands
        const citiesEl = tile.querySelector(".cities");
        if (!citiesEl) { tile.style.opacity = ""; return; }
        tile.style.opacity = citiesEl.textContent.trim() === "0" ? "0.35" : "";
      }
    });
  }

  function startDimming() {
    applyDimming();
    if (!dimmingObserver) {
      let debounce = null;
      dimmingObserver = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(applyDimming, 150);
      });
      dimmingObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function stopDimming() {
    if (dimmingObserver) {
      dimmingObserver.disconnect();
      dimmingObserver = null;
    }
    document.querySelectorAll(".islandTile, .oceanTile").forEach((tile) => {
      tile.style.opacity = "";
    });
  }

  // Listen for filter changes from filter panel
  let layerBeforeFilter = null;
  window.addEventListener("ik-filter-change", (e) => {
    filterConfig = e.detail;
    cachedBaseMap = null;
    const hasFilters = filterConfig && filterConfig.enabled &&
      filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
    if (hasFilters || dimEmpty) startDimming();
    else stopDimming();
    // Auto-switch to/from filter layer
    if (hasFilters && currentLayer !== "filter") {
      layerBeforeFilter = currentLayer;
      currentLayer = "filter";
      updateLayerBar();
    } else if (!hasFilters && currentLayer === "filter") {
      currentLayer = layerBeforeFilter || "population";
      layerBeforeFilter = null;
      updateLayerBar();
    }
    drawMinimap();
  });

  // Power-user JS predicate changed via window.IkFilter.set/clear — redraw
  // and force the filter layer on if a predicate is now active.
  window.addEventListener("ik-custom-predicate-change", () => {
    cachedBaseMap = null;
    const hasCustom = MapFilter.getCustomPredicate && MapFilter.getCustomPredicate();
    if (hasCustom) {
      startDimming();
      if (currentLayer !== "filter") {
        layerBeforeFilter = currentLayer;
        currentLayer = "filter";
        updateLayerBar();
      }
    } else {
      const hasFilters = filterConfig && filterConfig.enabled &&
        filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
      if (!hasFilters && currentLayer === "filter") {
        currentLayer = layerBeforeFilter || "population";
        layerBeforeFilter = null;
        updateLayerBar();
      }
      if (!hasFilters && !dimEmpty) stopDimming();
    }
    drawMinimap();
  });

  // Track scan progress/completion via storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.scanProgress && changes.scanProgress.newValue) {
      if (scanMode === "progress" || scanMode === "scan") {
        showProgressUI(changes.scanProgress.newValue);
      }
    }

    if (changes.scanResult && changes.scanResult.newValue) {
      // Scan completed — save map data and switch to map view
      const result = changes.scanResult.newValue;
      const worldName = IkUtils.getUrlWorldName();
      if (worldName && result.worldName === worldName) {
        const mapKey = "map_" + worldName;
        const scanDate = new Date().toISOString();
        const mapData = { worldName, scanDate, islands: result.islands };

        // Save map data (popup normally does this, but we may not have popup)
        chrome.storage.local.get(mapKey, (existing) => {
          if (!existing[mapKey]) {
            // No popup saved it yet — save from minimap
            const indexKey = "mapIndex";
            chrome.storage.local.get(indexKey, (idxData) => {
              const index = idxData[indexKey] || [];
              const entry = { worldName, scanDate, key: mapKey };
              const pos = index.findIndex((e) => e.key === mapKey);
              if (pos >= 0) index[pos] = entry;
              else index.unshift(entry);
              chrome.storage.local.set({ [indexKey]: index, [mapKey]: mapData });
            });
          }

          currentMapData = existing[mapKey] || mapData;
          cachedBaseMap = null;
          loadAllianceIndex().then(() => {
            showMapUI();
            drawMinimap();
          });
        });

      }
    }

    // Reload alliance colors / rich data when CT scan, island visits, or full
    // scan commits update the underlying storage.
    const worldName = IkUtils.getUrlWorldName() || "unknown";
    const allyIdxKey = "allianceIndex_" + worldName;
    const mapKey = "map_" + worldName;
    const queryIdxKey = "queryIndex_" + worldName;
    if (changes[allyIdxKey] || changes[mapKey] || changes[queryIdxKey]) {
      chrome.storage.local.get([mapKey, allyIdxKey, queryIdxKey], (d) => {
        if (d[mapKey]) currentMapData = d[mapKey];
        allianceIndex = d[allyIdxKey] || {};
        queryIndex = d[queryIdxKey] || null;
        allianceColorMap = MapRender.buildAllianceColorMap(allianceIndex, currentMapData && currentMapData.islands);
        allyVersion++;
        cachedBaseMap = null;
        islandsByCoord = null; // invalidate dim-path lookup
        applyDimming();
        drawMinimap();
      });
    }

    if (changes.scanInProgress && !changes.scanInProgress.newValue) {
      // Scan ended (completed or cancelled)
      if (scanMode === "progress") {
        // If we have map data now, show it; otherwise show scan button
        if (currentMapData && currentMapData.islands && currentMapData.islands.length > 0) {
          showMapUI();
          drawMinimap();
        } else {
          showScanUI();
        }
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "minimap-toggle") {
      if (msg.enabled) showOrHide();
      else if (container) container.style.display = "none";
    }
    if (msg.type === "minimap-position") {
      chrome.storage.local.set({ [STORAGE_KEY_POSITION]: msg.position });
      if (container) {
        container.style.left = "";
        container.style.right = "";
        container.style[msg.position === "left" ? "left" : "right"] = "12px";
      }
    }
    if (msg.type === "minimap-scale") {
      minimapScale = msg.scale;
      chrome.storage.local.set({ [STORAGE_KEY_SCALE]: msg.scale });
      if (container && container.style.display !== "none") drawMinimap();
    }
    if (msg.type === "hide-zeros-toggle") {
      dimEmpty = msg.enabled;
      cachedBaseMap = null;
      const hasFilters = filterConfig && filterConfig.enabled &&
        filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
      if (hasFilters || dimEmpty) startDimming(); else stopDimming();
      if (container && container.style.display !== "none") drawMinimap();
    }
    if (msg.type === "vp-trim") {
      vpTrimRight = msg.right;
      vpTrimBottom = msg.bottom;
      chrome.storage.local.set({ vpTrimRight: msg.right, vpTrimBottom: msg.bottom });
      if (container && container.style.display !== "none") drawMinimap();
    }
    if (msg.type === "map-updated") {
      showOrHide();
    }
  });

  function watchViewChanges() {
    const obs = new MutationObserver(() => showOrHide());
    obs.observe(document.body, { attributes: true, attributeFilter: ["id"] });
  }

  IkUtils.ensureBridge();
  showOrHide();
  watchViewChanges();
  watchWorldmapScroll();

  // Init dim-empty independently of minimap overlay
  chrome.storage.local.get(["hideZeroCities", "mapFilters"], (data) => {
    dimEmpty = !!data.hideZeroCities;
    if (!filterConfig && data.mapFilters) filterConfig = data.mapFilters;
    const hasFilters = filterConfig && filterConfig.enabled &&
      filterConfig.groups && filterConfig.groups.some((g) => g.filters && g.filters.length > 0);
    if ((hasFilters || dimEmpty) && isWorldMapView()) startDimming();
  });
})();

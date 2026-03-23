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
  let currentMapData = null;
  let minimapScale = 1.5;
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

  function getWorldName() {
    const parts = document.title.split(" - ");
    if (parts.length >= 3) return parts.slice(2).join(" - ").trim();
    return null;
  }

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

    const existing = new Map();
    for (const isl of currentMapData.islands) {
      existing.set(`${isl.x}:${isl.y}`, isl);
    }
    let changed = false;

    document.querySelectorAll(".islandTile").forEach((tile) => {
      const title = tile.getAttribute("title") || "";
      const m = title.match(/^(.+?)\s*\[(\d+):(\d+)\]$/);
      if (!m) return;

      const x = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      const key = `${x}:${y}`;
      const citiesEl = tile.querySelector(".cities");
      const wonderEl = tile.querySelector('[class*="wonder wonder"]');
      const tgEl = tile.querySelector('[class*="tradegood tradegood"]');
      const piracyEl = tile.querySelector('[id^="piracy_"]');
      const heliosEl = tile.querySelector('[id^="helios_"]');
      const ownerEl = tile.querySelector('[id^="owner_"]');

      const newIsland = {
        name: m[1], x, y,
        cities: citiesEl ? parseInt(citiesEl.textContent, 10) || 0 : 0,
        wonder: wonderEl ? parseInt(wonderEl.className.match(/wonder(\d+)/)?.[1], 10) || 0 : 0,
        tradegood: tgEl ? parseInt(tgEl.className.match(/tradegood(\d+)/)?.[1], 10) || 0 : 0,
        piracy: piracyEl ? piracyEl.className.includes("piracy") : false,
        helios: heliosEl ? heliosEl.className.includes("helios") : false,
        owner: ownerEl ? ownerEl.className.replace("ownerState", "").trim() : "",
      };

      const old = existing.get(key);
      if (!old || old.cities !== newIsland.cities || old.owner !== newIsland.owner) {
        existing.set(key, newIsland);
        changed = true;
      }
    });

    if (changed) {
      currentMapData.islands = Array.from(existing.values());
      cachedBaseMap = null; // invalidate cache
      const worldName = getWorldName();
      if (worldName) {
        chrome.storage.local.set({
          ["map_" + worldName]: { ...currentMapData, scanDate: new Date().toISOString() },
        });
      }
    }
    return changed;
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

    mapCanvas = document.createElement("canvas");
    mapCanvas.style.borderRadius = "6px";
    mapCanvas.style.display = "block";
    mapCanvas.style.imageRendering = "pixelated";
    container.appendChild(mapCanvas);
    mapCtx = mapCanvas.getContext("2d");

    mapCanvas.addEventListener("click", onMinimapClick);

    // Layer selector bar
    const layerBar = document.createElement("div");
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
        chrome.storage.local.set({ minimapLayer: key });
        // Update button styles
        layerBar.querySelectorAll("button").forEach((b) => {
          b.style.background = b.dataset.layer === key ? "#2a4a6a" : "transparent";
          b.style.color = b.dataset.layer === key ? "#e0e8f0" : "#6a7a8a";
        });
        drawMinimap();
      });
      layerBar.appendChild(btn);
    }
    container.appendChild(layerBar);

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

  function rebuildBaseMap() {
    if (!currentMapData || !globalThis.MapRender) return;
    const islands = currentMapData.islands;
    if (!islands || islands.length === 0) return;

    const tw = Math.max(1, Math.round(3 * minimapScale));
    const th = Math.max(1, Math.round(3 * minimapScale));
    const iSize = Math.max(1, Math.round(2 * minimapScale));
    const padding = Math.max(2, Math.round(6 * minimapScale));

    cachedBaseMap = document.createElement("canvas");
    const baseCtx = cachedBaseMap.getContext("2d");

    const renderInfo = globalThis.MapRender.render(baseCtx, islands, {
      tileW: tw, tileH: th, islandSize: iSize, pad: padding,
      drawLegend: false, layer: currentLayer, dimEmpty: dimEmpty,
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
  }

  function drawMinimap() {
    if (!currentMapData || !mapCtx || !globalThis.MapRender) return;
    const islands = currentMapData.islands;
    if (!islands || islands.length === 0) return;

    // Rebuild base map only when layer, scale, or data changes
    if (!cachedBaseMap || cachedLayer !== currentLayer ||
        cachedScale !== minimapScale || cachedIslandCount !== islands.length ||
        cachedDimEmpty !== dimEmpty) {
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

  async function loadAndShow() {
    if (!isWorldMapView()) return;

    const worldName = getWorldName();
    if (!worldName) return;

    const key = "map_" + worldName;
    const data = await chrome.storage.local.get([key, STORAGE_KEY_ENABLED, STORAGE_KEY_POSITION, STORAGE_KEY_SCALE, "vpTrimRight", "vpTrimBottom", "minimapLayer", "hideZeroCities"]);

    if (!data[STORAGE_KEY_ENABLED]) return;
    if (!data[key]) return;

    currentMapData = data[key];
    minimapScale = data[STORAGE_KEY_SCALE] || 1.5;
    vpTrimRight = data.vpTrimRight ?? 0.08;
    vpTrimBottom = data.vpTrimBottom ?? 0.15;
    currentLayer = data.minimapLayer || "population";
    dimEmpty = !!data.hideZeroCities;
    const position = data[STORAGE_KEY_POSITION] || "right";

    if (!container || !document.body.contains(container)) {
      createOverlay(position);
    }
    container.style.display = "";

    readAndMergeTiles();
    drawMinimap();
  }

  // Poll map1 screen position via getBoundingClientRect — always accurate
  function watchWorldmapScroll() {
    let lastX = null, lastY = null;
    let lastBase = null;

    setInterval(() => {
      if (!container || container.style.display === "none") return;
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
    setInterval(() => {
      if (!container || container.style.display === "none") return;
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
    } else if (container) {
      container.style.display = "none";
    }
  }

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

  function ensureBridge() {
    if (document.getElementById("ik-bridge")) return;
    const s = document.createElement("script");
    s.id = "ik-bridge";
    s.src = chrome.runtime.getURL("bridge.js");
    document.documentElement.appendChild(s);
  }

  ensureBridge();
  showOrHide();
  watchViewChanges();
  watchWorldmapScroll();
})();

// World map scanner — uses the game's own coordinate navigator to jump around
// and reads tiles from the live DOM after each jump.
(() => {


  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Read tiles currently in the live DOM (grid size + parsed islands)
  function readCurrentTiles() {
    let maxCol = 0, maxRow = 0;
    document.querySelectorAll('[id^="tile_"]').forEach((el) => {
      const m = el.id.match(/^tile_(\d+)_(\d+)$/);
      if (!m) return;
      const col = parseInt(m[1], 10);
      const row = parseInt(m[2], 10);
      if (col > maxCol) maxCol = col;
      if (row > maxRow) maxRow = row;
    });
    return {
      islands: IkUtils.parseTilesFromDOM(),
      cols: maxCol + 1,
      rows: maxRow + 1,
    };
  }

  // Navigate by dispatching a custom event that bridge.js handles in page context
  function jumpTo(x, y) {
    IkUtils.ensureBridge();
    window.dispatchEvent(
      new CustomEvent("ik-jump", { detail: { x, y } })
    );
  }

  // Snapshot current island tile coords (for change detection after jump)
  function snapshotIslandCoords() {
    const coords = new Set();
    document.querySelectorAll(".islandTile").forEach((tile) => {
      const title = tile.getAttribute("title") || "";
      const m = title.match(/\[(\d+):(\d+)\]$/);
      if (m) coords.add(`${m[1]}:${m[2]}`);
    });
    return coords;
  }

  // Snapshot tile grid element IDs (includes ocean tiles — always present)
  function snapshotTileGrid() {
    const ids = new Set();
    document.querySelectorAll('[id^="tile_"]').forEach((el) => ids.add(el.id));
    return ids;
  }

  // Wait for tiles to actually update after a jump by detecting DOM changes.
  // The old proximity-only check could pass on stale tiles when the stride
  // was close to the proximity threshold, causing the scanner to read duplicate
  // data from the previous viewport and skip the target area entirely.
  function waitForTilesUpdate(beforeCoords, beforeGrid, targetX, targetY, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();

      function check() {
        let hasNewNearTarget = false;
        let totalNew = 0;
        const tiles = document.querySelectorAll(".islandTile");

        for (const tile of tiles) {
          const title = tile.getAttribute("title") || "";
          const m = title.match(/\[(\d+):(\d+)\]$/);
          if (!m) continue;
          const key = `${m[1]}:${m[2]}`;
          if (beforeCoords.has(key)) continue; // stale tile, skip
          totalNew++;
          const tx = parseInt(m[1], 10);
          const ty = parseInt(m[2], 10);
          if (Math.abs(tx - targetX) < 15 && Math.abs(ty - targetY) < 15) {
            hasNewNearTarget = true;
          }
        }

        // Accept if we see NEW tiles near the target
        if (hasNewNearTarget) { resolve(true); return; }

        // Accept if all old tiles are gone (jumped to empty ocean)
        if (beforeCoords.size > 0 && tiles.length === 0) { resolve(true); return; }

        // Accept if the tile set changed substantially (>50% new)
        if (tiles.length > 0 && totalNew > tiles.length / 2) { resolve(true); return; }

        // Accept if the tile grid itself changed (handles empty-to-empty transitions
        // where no .islandTile elements exist but the viewport has moved)
        if (beforeGrid) {
          let gridNew = 0;
          const currentGrid = document.querySelectorAll('[id^="tile_"]');
          for (const el of currentGrid) {
            if (!beforeGrid.has(el.id)) gridNew++;
          }
          if (currentGrid.length > 0 && gridNew > currentGrid.length / 2) {
            resolve(true); return;
          }
        }

        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 150);
      }
      // Give the AJAX a moment to start
      setTimeout(check, 300);
    });
  }

  // Request military/war/barbarian data from page context via bridge
  function requestGameData() {
    return new Promise((resolve) => {
      function handler(e) {
        window.removeEventListener("ik-game-data", handler);
        resolve(e.detail || {});
      }
      window.addEventListener("ik-game-data", handler);
      window.dispatchEvent(new CustomEvent("ik-read-game-data"));
      // Timeout if bridge doesn't respond
      setTimeout(() => {
        window.removeEventListener("ik-game-data", handler);
        resolve({});
      }, 5000);
    });
  }

  function parseCoordSet(raw) {
    const coords = new Set();
    if (!raw || !Array.isArray(raw)) return coords;
    for (let x = 0; x < raw.length; x++) {
      const row = raw[x];
      if (!Array.isArray(row)) continue;
      for (let y = 0; y < row.length; y++) {
        if (row[y]) coords.add(`${x}:${y}`);
      }
    }
    return coords;
  }

  // Apply game overlay data (military, war, barbarian, piracy) to scanned islands.
  // `gameData` must be captured BEFORE jumping starts because the game's AJAX
  // refetches overwrite piracy values in worldmap.islands with zeroes.
  function applyGameData(allIslands, gameData) {
    const militarySet = parseCoordSet(gameData.military);
    const warSet = parseCoordSet(gameData.war);
    const barbarianSet = parseCoordSet(gameData.barbarian);
    const piracySet = parseCoordSet(gameData.piracy);

    for (const [key, isl] of allIslands) {
      isl.military = militarySet.has(key);
      isl.war = warSet.has(key);
      isl.barbarian = barbarianSet.has(key);
      // Piracy from bridge (worldmap.islands) is authoritative — DOM piracy
      // is unreliable after jumps because AJAX refetches zero the values.
      if (piracySet.has(key)) isl.piracy = true;
    }
  }

  let scanning = false;
  let activePort = null;
  let cancelRequested = false;

  // Listen for cancel messages from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "cancel-scan") {
      cancelRequested = true;
    }
  });

  // Core scan logic — accepts a progress callback, returns { worldName, islands }
  // or null if cancelled. Uses module-level cancelRequested flag.
  async function doScan(progressCb) {
    if (scanning) return null;
    scanning = true;
    cancelRequested = false;
    chrome.storage.local.set({ scanInProgress: true });
    try {
      const worldName = IkUtils.getUrlWorldName() || "unknown";
      const allIslands = new Map();
      const scannedCenters = new Set();
      let requestsDone = 0;
      let totalEstimate = 0;

      function addIslands(parsed) {
        for (const isl of parsed) {
          const key = `${isl.x}:${isl.y}`;
          const existing = allIslands.get(key);
          if (!existing || isl.cities > existing.cities) {
            allIslands.set(key, isl);
          }
        }
      }

      function progress(phase) {
        const progressData = {
          type: "progress",
          phase,
          current: requestsDone,
          total: totalEstimate,
          found: allIslands.size,
        };
        progressCb(progressData);
      }

      async function jumpAndRead(cx, cy, phase) {
        if (cancelRequested) return null;
        const key = `${cx}:${cy}`;
        if (scannedCenters.has(key)) {
          requestsDone++;
          progress(phase);
          return null;
        }
        scannedCenters.add(key);

        try {
          const before = snapshotIslandCoords();
          const gridBefore = snapshotTileGrid();
          jumpTo(cx, cy);
          await waitForTilesUpdate(before, gridBefore, cx, cy);
          const result = readCurrentTiles();
          addIslands(result.islands);
          requestsDone++;
          progress(phase);
          return result;
        } catch (err) {
          progressCb({ type: "log", message: `Error at [${cx}:${cy}]: ${err.message}` });
          requestsDone++;
          progress(phase);
          return null;
        }
      }

      // --- Phase 1: Probe to detect viewport stride ---
      progressCb({ type: "started", worldName, phase: "probe" });
      totalEstimate = 1;

      // Navigate to the world map if not already there
      if (!document.getElementById("inputXCoord")) {
        progressCb({ type: "navigate-to-world" });
        return null;
      }

      // Save starting position to restore after scan
      const xInput = document.getElementById("inputXCoord");
      const yInput = document.getElementById("inputYCoord");
      const startX = parseInt(xInput.value, 10) || 50;
      const startY = parseInt(yInput.value, 10) || 50;

      // Capture game overlay data (military, war, barbarian, piracy) BEFORE
      // jumping — the game's AJAX refetches overwrite worldmap.islands piracy
      // values with zeroes, so this must happen while the initial page data is
      // still intact.
      const gameData = await requestGameData();

      // Read current position as initial probe
      const probe = readCurrentTiles();
      if (probe.islands.length > 0) {
        addIslands(probe.islands);
      }
      requestsDone++;

      // Use 75% of viewport as stride — the game renders buffer tiles beyond the
      // visible area, so the tile grid is wider than the actual data zone.
      const strideX = Math.max(1, Math.floor((probe.cols + 1) * 0.75));
      const strideY = Math.max(1, Math.floor((probe.rows + 1) * 0.75));

      progressCb({
        type: "stride-detected",
        cols: probe.cols,
        rows: probe.rows,
        strideX,
        strideY,
      });

      // --- Phase 2: Row-by-row fill from (0,0) to (100,100) ---
      // Scan each row left-to-right, stop after passing through the island
      // area. Stop scanning rows after 2 consecutive all-empty rows.
      const MAP_MAX = 100;
      const xSteps = Math.floor(MAP_MAX / strideX) + 1;
      const ySteps = Math.floor(MAP_MAX / strideY) + 1;
      totalEstimate = requestsDone + xSteps * ySteps;
      progress("fill");

      let emptyRows = 0;

      for (let y = 0; y <= MAP_MAX; y += strideY) {
        if (cancelRequested) return null;
        let rowHasIslands = false;
        let foundAny = false;

        for (let x = 0; x <= MAP_MAX; x += strideX) {
          if (cancelRequested) return null;
          const key = `${x}:${y}`;
          if (scannedCenters.has(key)) continue;
          const r = await jumpAndRead(x, y, "fill");
          if (r && r.islands.length > 0) {
            foundAny = true;
            rowHasIslands = true;
          } else if (foundAny) {
            break; // passed through island area on this row
          }
        }

        if (rowHasIslands) emptyRows = 0;
        else emptyRows++;
        if (emptyRows >= 2) break; // past the map
      }

      if (cancelRequested) return null;

      // Apply game overlay data captured before jumping started
      applyGameData(allIslands, gameData);

      // Jump back to starting position
      IkUtils.ensureBridge();
      window.dispatchEvent(
        new CustomEvent("ik-jump", { detail: { x: startX, y: startY } })
      );

      const islands = Array.from(allIslands.values());
      return { worldName, islands };
    } finally {
      scanning = false;
      chrome.storage.local.remove(["scanInProgress", "scanProgress"]);
    }
  }

  function safeSendPort(port, msg) {
    try { port.postMessage(msg); } catch (e) { activePort = null; }
  }

  async function scanWorldMap(port) {
    activePort = port;
    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
    });
    try {
      const result = await doScan((msg) => {
        if (activePort) safeSendPort(activePort, msg);
        if (msg.type === "progress") chrome.storage.local.set({ scanProgress: msg });
      });
      if (result) {
        await chrome.storage.local.set({ scanResult: result });
        if (activePort) safeSendPort(activePort, { type: "complete", ...result });
      }
    } catch (e) {
      if (activePort) safeSendPort(activePort, { type: "error", message: e.message });
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "map-scan") return;
    port.onMessage.addListener((msg) => {
      if (msg.action === "start-scan") {
        scanWorldMap(port);
      } else if (msg.action === "reconnect-scan" && scanning) {
        // Popup reopened while scan is running — attach port for live updates
        activePort = port;
        port.onDisconnect.addListener(() => {
          if (activePort === port) activePort = null;
        });
      }
    });
  });

  // Expose scanner for minimap and CT scanner to trigger scans without popup
  globalThis.IkScanner = {
    async scan(progressCb) {
      return doScan(progressCb || (() => {}));
    },
    startScan() {
      doScan(() => {}).then((result) => {
        if (result) chrome.storage.local.set({ scanResult: result });
      });
    },
    get scanning() { return scanning; },
    cancel() { cancelRequested = true; },
  };
})();

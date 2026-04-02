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

  // Wait for tiles to actually update after a jump by detecting DOM changes.
  // The old proximity-only check could pass on stale tiles when the stride
  // was close to the proximity threshold, causing the scanner to read duplicate
  // data from the previous viewport and skip the target area entirely.
  function waitForTilesUpdate(beforeCoords, targetX, targetY, timeoutMs = 5000) {
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

  // Parse game overlay arrays and tag matching islands.
  // Game uses 2D sparse arrays: array[x][y] = 1 means flagged.
  function enrichWithGameData(allIslands) {
    return requestGameData().then((data) => {
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

      const militarySet = parseCoordSet(data.military);
      const warSet = parseCoordSet(data.war);
      const barbarianSet = parseCoordSet(data.barbarian);

      for (const [key, isl] of allIslands) {
        isl.military = militarySet.has(key);
        isl.war = warSet.has(key);
        isl.barbarian = barbarianSet.has(key);
      }
    }).catch(() => {
      // If bridge data unavailable, islands keep defaults (false)
    });
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

  async function scanWorldMap(port) {
    if (scanning) return;
    scanning = true;
    cancelRequested = false;
    activePort = port;
    chrome.storage.local.set({ scanInProgress: true });
    try {
    const worldName = IkUtils.getWorldName() || "Unknown";
    const allIslands = new Map();
    const scannedCenters = new Set();
    let requestsDone = 0;
    let totalEstimate = 0;

    // When popup closes, just clear the port reference — don't abort
    port.onDisconnect.addListener(() => {
      activePort = null;
    });

    function addIslands(parsed) {
      for (const isl of parsed) {
        const key = `${isl.x}:${isl.y}`;
        const existing = allIslands.get(key);
        if (!existing || isl.cities > existing.cities) {
          allIslands.set(key, isl);
        }
      }
    }

    function safeSend(msg) {
      if (!activePort) return;
      try {
        activePort.postMessage(msg);
      } catch (e) {
        activePort = null;
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
      safeSend(progressData);
      // Persist progress so popup can pick it up if reopened
      chrome.storage.local.set({ scanProgress: progressData });
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
        jumpTo(cx, cy);
        await waitForTilesUpdate(before, cx, cy);
        const result = readCurrentTiles();
        addIslands(result.islands);
        requestsDone++;
        progress(phase);
        return result;
      } catch (err) {
        safeSend({ type: "log", message: `Error at [${cx}:${cy}]: ${err.message}` });
        requestsDone++;
        progress(phase);
        return null;
      }
    }

    // --- Phase 1: Probe to detect viewport stride ---
    safeSend({ type: "started", worldName, phase: "probe" });
    totalEstimate = 1;

    // Navigate to the world map if not already there
    if (!document.getElementById("inputXCoord")) {
      safeSend({ type: "navigate-to-world" });
      return;
    }

    // Save starting position to restore after scan
    const xInput = document.getElementById("inputXCoord");
    const yInput = document.getElementById("inputYCoord");
    const startX = parseInt(xInput.value, 10) || 50;
    const startY = parseInt(yInput.value, 10) || 50;

    // Read current position as initial probe
    const probe = readCurrentTiles();
    if (probe.islands.length > 0) {
      addIslands(probe.islands);
    }
    requestsDone++;

    // Use 75% of viewport as stride — the game renders buffer tiles beyond the
    // visible area, so the tile grid is wider than the actual data zone.
    // A fixed overlap of 3 was too thin and left gaps at buffer boundaries.
    const strideX = Math.max(1, Math.floor(probe.cols * 0.75));
    const strideY = Math.max(1, Math.floor(probe.rows * 0.75));

    safeSend({
      type: "stride-detected",
      cols: probe.cols,
      rows: probe.rows,
      strideX,
      strideY,
    });

    // --- Phase 2: Cross scan to find the 4 tips of the diamond ---
    // The world map is diamond-shaped. Scan outward from center in 4
    // cardinal directions, stop on first empty.
    let tipRight = 50, tipLeft = 50, tipDown = 50, tipUp = 50;

    totalEstimate = 42;
    progress("cross");

    const centerResult = await jumpAndRead(50, 50, "cross");
    if (cancelRequested) return;

    // Scan right (+X)
    for (let x = 50 + strideX; x <= 120; x += strideX) {
      if (cancelRequested) return;
      const r = await jumpAndRead(x, 50, "cross");
      if (!r || r.islands.length === 0) break;
      tipRight = x;
    }
    // Scan left (-X)
    for (let x = 50 - strideX; x >= -20; x -= strideX) {
      if (cancelRequested) return;
      const r = await jumpAndRead(x, 50, "cross");
      if (!r || r.islands.length === 0) break;
      tipLeft = x;
    }
    // Scan down (+Y)
    for (let y = 50 + strideY; y <= 120; y += strideY) {
      if (cancelRequested) return;
      const r = await jumpAndRead(50, y, "cross");
      if (!r || r.islands.length === 0) break;
      tipDown = y;
    }
    // Scan up (-Y)
    for (let y = 50 - strideY; y >= -20; y -= strideY) {
      if (cancelRequested) return;
      const r = await jumpAndRead(50, y, "cross");
      if (!r || r.islands.length === 0) break;
      tipUp = y;
    }

    if (cancelRequested) return;

    // Diamond center and radii (in grid coords)
    const cx = (tipLeft + tipRight) / 2;
    const cy = (tipUp + tipDown) / 2;
    const halfW = (tipRight - tipLeft) / 2 + strideX; // +1 stride margin
    const halfH = (tipDown - tipUp) / 2 + strideY;

    safeSend({
      type: "bounds-detected",
      mapMinX: Math.round(cx - halfW),
      mapMaxX: Math.round(cx + halfW),
      mapMinY: Math.round(cy - halfH),
      mapMaxY: Math.round(cy + halfH),
    });

    // --- Phase 3: Fill the diamond ---
    // A point (x,y) is inside the diamond if:
    //   |x - cx| / halfW + |y - cy| / halfH <= 1
    const fillCenters = [];
    const yMin = Math.round(cy - halfH);
    const yMax = Math.round(cy + halfH);
    const xMin = Math.round(cx - halfW);
    const xMax = Math.round(cx + halfW);
    for (let y = yMin; y <= yMax; y += strideY) {
      for (let x = xMin; x <= xMax; x += strideX) {
        const dx = Math.abs(x - cx) / halfW;
        const dy = Math.abs(y - cy) / halfH;
        if (dx + dy <= 1.05) { // small tolerance
          const key = `${x}:${y}`;
          if (!scannedCenters.has(key)) {
            fillCenters.push([x, y]);
          }
        }
      }
    }

    totalEstimate = requestsDone + fillCenters.length;
    progress("fill");

    for (const [fx, fy] of fillCenters) {
      if (cancelRequested) return;
      await jumpAndRead(fx, fy, "fill");
    }

    if (!cancelRequested) {
      // Request game-side overlay data (military, war, barbarian)
      await enrichWithGameData(allIslands);

      // Jump back to starting position
      IkUtils.ensureBridge();
      window.dispatchEvent(
        new CustomEvent("ik-jump", { detail: { x: startX, y: startY } })
      );

      const islands = Array.from(allIslands.values());

      // Save result to storage so popup can process it even if closed during scan
      await chrome.storage.local.set({
        scanResult: { worldName, islands },
      });

      safeSend({
        type: "complete",
        worldName,
        islands,
      });
    }
    } finally {
      scanning = false;
      activePort = null;
      chrome.storage.local.remove(["scanInProgress", "scanProgress"]);
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

  // Expose scanner for minimap to trigger scans without popup
  globalThis.IkScanner = {
    startScan() {
      const fakePort = {
        postMessage() {},
        onDisconnect: { addListener() {} },
      };
      scanWorldMap(fakePort);
    },
    get scanning() { return scanning; },
  };
})();

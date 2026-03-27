// World map scanner — uses the game's own coordinate navigator to jump around
// and reads tiles from the live DOM after each jump.
(() => {
  const DELAY_AFTER_JUMP = 1500; // ms to wait for AJAX + render
  const DELAY_BETWEEN = 300; // extra breathing room

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

  // Wait for tiles to actually update after a jump
  function waitForTilesUpdate(targetX, targetY, timeoutMs = 500) {
    return new Promise((resolve) => {
      const start = Date.now();

      function check() {
        // Check if any visible island tile contains coords near our target
        const tiles = document.querySelectorAll(".islandTile");
        for (const tile of tiles) {
          const title = tile.getAttribute("title") || "";
          const m = title.match(/\[(\d+):(\d+)\]$/);
          if (m) {
            const tx = parseInt(m[1], 10);
            const ty = parseInt(m[2], 10);
            // If we see tiles near our target, the jump landed
            if (Math.abs(tx - targetX) < 15 && Math.abs(ty - targetY) < 15) {
              resolve(true);
              return;
            }
          }
        }
        if (Date.now() - start > timeoutMs) {
          resolve(false); // timed out, read whatever is there
          return;
        }
        setTimeout(check, 200);
      }
      // Give the AJAX a moment to start
      setTimeout(check, 400);
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
      }, 2000);
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

  async function scanWorldMap(port) {
    const worldName = IkUtils.getWorldName() || "Unknown";
    const allIslands = new Map();
    const scannedCenters = new Set();
    let aborted = false;
    let requestsDone = 0;
    let totalEstimate = 0;

    port.onDisconnect.addListener(() => {
      aborted = true;
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
      try {
        port.postMessage(msg);
      } catch (e) {
        // Port disconnected (popup closed)
        aborted = true;
      }
    }

    function progress(phase) {
      safeSend({
        type: "progress",
        phase,
        current: requestsDone,
        total: totalEstimate,
        found: allIslands.size,
      });
    }

    async function jumpAndRead(cx, cy, phase) {
      if (aborted) return null;
      const key = `${cx}:${cy}`;
      if (scannedCenters.has(key)) return null;
      scannedCenters.add(key);

      try {
        jumpTo(cx, cy);
        await waitForTilesUpdate(cx, cy);
        await sleep(DELAY_BETWEEN);

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
    if (document.body.id !== "worldmap_iso") {
      safeSend({ type: "log", message: "Not on world map — navigating..." });
      IkUtils.ensureBridge();
      window.dispatchEvent(
        new CustomEvent("ik-ajax-call", { detail: { url: "?view=worldmap_iso" } })
      );
      // Wait for body ID to change to worldmap_iso
      const navOk = await new Promise((resolve) => {
        const start = Date.now();
        function check() {
          if (document.body.id === "worldmap_iso") return resolve(true);
          if (Date.now() - start > 8000) return resolve(false);
          setTimeout(check, 300);
        }
        setTimeout(check, 500);
      });
      if (!navOk) {
        safeSend({
          type: "error",
          message: "Could not navigate to the World Map view.",
        });
        return;
      }
      await sleep(500); // let tiles render
    }

    const xInput = document.getElementById("inputXCoord");
    const yInput = document.getElementById("inputYCoord");
    if (!xInput || !yInput) {
      safeSend({
        type: "error",
        message: "Coordinate inputs not found on world map.",
      });
      return;
    }

    // Save starting position to restore after scan
    const startX = parseInt(xInput.value, 10) || 50;
    const startY = parseInt(yInput.value, 10) || 50;

    // Read current position as initial probe
    const probe = readCurrentTiles();
    if (probe.islands.length > 0) {
      addIslands(probe.islands);
    }
    requestsDone++;

    const strideX = Math.max(1, probe.cols - 3);
    const strideY = Math.max(1, probe.rows - 3);

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

    totalEstimate = 30;
    progress("cross");

    const centerResult = await jumpAndRead(50, 50, "cross");
    if (aborted) return;

    // Scan right (+X)
    for (let x = 50 + strideX; x <= 120; x += strideX) {
      if (aborted) return;
      const r = await jumpAndRead(x, 50, "cross");
      if (!r || r.islands.length === 0) break;
      tipRight = x;
    }
    // Scan left (-X)
    for (let x = 50 - strideX; x >= -20; x -= strideX) {
      if (aborted) return;
      const r = await jumpAndRead(x, 50, "cross");
      if (!r || r.islands.length === 0) break;
      tipLeft = x;
    }
    // Scan down (+Y)
    for (let y = 50 + strideY; y <= 120; y += strideY) {
      if (aborted) return;
      const r = await jumpAndRead(50, y, "cross");
      if (!r || r.islands.length === 0) break;
      tipDown = y;
    }
    // Scan up (-Y)
    for (let y = 50 - strideY; y >= -20; y -= strideY) {
      if (aborted) return;
      const r = await jumpAndRead(50, y, "cross");
      if (!r || r.islands.length === 0) break;
      tipUp = y;
    }

    if (aborted) return;

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

    for (const [cx, cy] of fillCenters) {
      if (aborted) return;
      await jumpAndRead(cx, cy, "fill");
    }

    if (!aborted) {
      // Request game-side overlay data (military, war, barbarian)
      await enrichWithGameData(allIslands);

      // Jump back to starting position
      IkUtils.ensureBridge();
      window.dispatchEvent(
        new CustomEvent("ik-jump", { detail: { x: startX, y: startY } })
      );

      safeSend({
        type: "complete",
        worldName,
        islands: Array.from(allIslands.values()),
      });
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "map-scan") return;
    port.onMessage.addListener((msg) => {
      if (msg.action === "start-scan") {
        scanWorldMap(port);
      }
    });
  });
})();

// Cultural treaty scanner — orchestrates a 2-phase scan:
//   Phase 1: DOM-based world map scan (must run in this content script)
//   Phase 2+3: island fetches + CT check, handed off to background.js
//              so they survive page navigation.
(() => {
  const TAG = "[CT]";
  const worldName = IkUtils.getUrlWorldName() || "unknown";
  const STORAGE_KEY = "ctScan_" + worldName;
  const PROGRESS_KEY = "ctScanProgress";
  const RUNNING_KEY = "ctScanRunning";

  // Read island ID mapping from game memory via bridge — only available on
  // worldmap_iso view, so we grab it before handing off to the background.
  function readWorldIslands() {
    return new Promise((resolve) => {
      function handler(e) {
        window.removeEventListener("ik-world-islands", handler);
        resolve(e.detail);
      }
      window.addEventListener("ik-world-islands", handler);
      IkUtils.ensureBridge();
      window.dispatchEvent(new CustomEvent("ik-read-world-islands"));
      setTimeout(() => {
        window.removeEventListener("ik-world-islands", handler);
        resolve(null);
      }, 3000);
    });
  }

  let scanning = false;
  let cancelRequested = false;
  let activePort = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ct-cancel") {
      cancelRequested = true;
      IkScanner.cancel();
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "ct-scan") return;
    activePort = port;
    port.onDisconnect.addListener(() => { activePort = null; });

    port.onMessage.addListener(async (msg) => {
      if (msg.action === "start-ct-scan") {
        await runScan(msg.allyFilter || "", msg.mode || "full");
      }
    });
  });

  function safeSend(msg) {
    if (!activePort) return;
    try { activePort.postMessage(msg); } catch (e) { activePort = null; }
  }

  function saveProgress(data) {
    chrome.storage.local.set({ [PROGRESS_KEY]: data });
  }

  // Save world map data (popup may not be open during minimap-triggered scans)
  async function saveWorldMap(islands) {
    const mapKey = "map_" + worldName;
    const scanDate = new Date().toISOString();
    const mapData = { worldName, scanDate, islands };

    const indexData = await chrome.storage.local.get("mapIndex");
    const index = indexData.mapIndex || [];
    const entry = { worldName, scanDate, key: mapKey };
    const pos = index.findIndex((e) => e.key === mapKey);
    if (pos >= 0) index[pos] = entry;
    else index.unshift(entry);

    await chrome.storage.local.set({ mapIndex: index, [mapKey]: mapData });
  }

  // --- Phase 1: World map scan via shared scanner module ---
  async function doMapScan() {
    safeSend({ type: "phase", text: "Scanning world map..." });
    saveProgress({ phase: "map", current: 0, total: 0, eta: 0 });

    const scanResult = await IkScanner.scan((msg) => {
      if (cancelRequested) IkScanner.cancel();
      if (msg.type === "progress") {
        const prog = { phase: "map", current: msg.current, total: msg.total, eta: 0 };
        safeSend({ type: "progress", ...prog });
        saveProgress(prog);
      } else if (msg.type === "log") {
        safeSend(msg);
      }
    });

    if (!scanResult || cancelRequested) return null;

    await saveWorldMap(scanResult.islands);
    await chrome.storage.local.set({ scanResult });
    safeSend({ type: "log", message: `World scan: ${scanResult.islands.length} islands found` });
    return scanResult;
  }

  async function runScan(allyFilter, mode) {
    if (scanning || IkScanner.scanning) {
      safeSend({ type: "error", message: "Scan already running" });
      return;
    }
    if (document.body.id !== "worldmap_iso") {
      safeSend({ type: "error", message: "Navigate to world map first" });
      return;
    }

    scanning = true;
    cancelRequested = false;
    chrome.storage.local.set({ [RUNNING_KEY]: true });

    function finishLocal() {
      scanning = false;
      chrome.storage.local.set({ [RUNNING_KEY]: false });
      chrome.storage.local.remove(PROGRESS_KEY);
    }

    try {
      const mapR = await doMapScan();
      if (!mapR || cancelRequested) {
        safeSend({ type: "error", message: cancelRequested ? "Cancelled" : "Map scan failed" });
        finishLocal();
        return;
      }

      if (mode === "map") {
        safeSend({ type: "complete", players: [], ctPlayers: [], allyCounts: {}, totalIslands: mapR.islands.length, timestamp: Date.now(), mapOnly: true });
        finishLocal();
        return;
      }

      // Read island IDs and own avatar id from page memory while we still have DOM access
      const idMapping = await readWorldIslands();
      if (!idMapping) {
        safeSend({ type: "error", message: "Could not read island IDs from game" });
        finishLocal();
        return;
      }

      let ownAvatarId = null;
      document.querySelectorAll("script").forEach((script) => {
        const m2 = script.textContent.match(/avatarId:\s*'(\d+)'/);
        if (m2) ownAvatarId = m2[1];
      });

      // Hand off phases 2 (+ optionally 3) to the background service worker — survives page navigation
      const opts = {
        mode,
        originUrl: location.origin + location.pathname,
        worldName,
        idMapping,
        ownAvatarId,
        allyFilter,
      };
      const resp = await chrome.runtime.sendMessage({ type: "bg-start-scan", opts });
      if (!resp || !resp.ok) {
        safeSend({ type: "error", message: (resp && resp.error) || "Failed to start background scan" });
        finishLocal();
        return;
      }
      safeSend({ type: "log", message: "Map scan done — island fetches now running in background. You can navigate freely." });

      // Background owns RUNNING_KEY from this point on.
      scanning = false;
    } catch (e) {
      safeSend({ type: "error", message: e.message });
      finishLocal();
    }
  }
})();

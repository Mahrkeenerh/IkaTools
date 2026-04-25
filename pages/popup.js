// Popup logic: scan orchestration, map rendering (via MapRender), gallery, minimap toggle
(() => {
  // Keep content script informed that popup is open via heartbeat
  setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "popup-heartbeat" }).catch(() => {});
      }
    });
  }, 1000);
  const $ = (id) => document.getElementById(id);
  const mapsPanel = $("maps-panel");
  const notIkariam = $("not-ikariam");
  const phaseText = $("phase-text");
  const progressBar = $("progress-bar");
  const statusDetail = $("status-detail");
  const scanLog = $("scan-log");
  const galleryList = $("gallery-list");
  const canvas = $("map-canvas");
  const ctx = canvas.getContext("2d");
  const minimapToggle = $("minimap-toggle");
  const posLeft = $("pos-left");
  const posRight = $("pos-right");
  const cleanupToggle = $("cleanup-toggle");

  let ikariamTabId = null;
  let ikariamWorldName = null; // world name extracted from the active tab URL

  // Extract world name from Ikariam hostname (e.g. "s42-en.ikariam.gameforge.com" → "s42-en")
  function worldNameFromUrl(url) {
    try {
      const host = new URL(url).hostname; // e.g. "s42-en.ikariam.gameforge.com"
      const idx = host.indexOf(".ikariam");
      return idx > 0 ? host.substring(0, idx) : null;
    } catch (e) {
      return null;
    }
  }

  // --- Tab switching ---
  document.querySelectorAll(".tab-bar button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-bar button").forEach((b) =>
        b.classList.remove("active")
      );
      btn.classList.add("active");
      document.querySelectorAll(".panel").forEach((p) =>
        p.classList.remove("active")
      );
      const target = $(btn.dataset.tab + "-panel");
      if (target) target.classList.add("active");
    });
  });

  // --- Init ---
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab) {
      if (tab.url && tab.url.includes("ikariam.gameforge.com")) {
        ikariamTabId = tab.id;
        ikariamWorldName = worldNameFromUrl(tab.url);
      }
    }
    if (ikariamTabId) {
      mapsPanel.classList.add("active");
    } else {
      mapsPanel.classList.remove("active");
      notIkariam.classList.add("active");
    }
    loadGallery();
    loadMinimapState();
    loadCleanupState();
    loadPirateState();
    loadNotes();
    if (ikariamTabId) { checkScanState(); checkCtState(); refreshButtonStates(); }
  });

  // --- Log helper ---
  function log(msg) {
    const line = document.createElement("div");
    line.textContent = msg;
    scanLog.appendChild(line);
    scanLog.scrollTop = scanLog.scrollHeight;
  }

  // --- Cultural Treaty Scan ---
  const scanMapBtn = $("scan-map-btn");
  const islandScanBtn = $("island-scan-btn");
  const ctScanBtn = $("ct-scan-btn");
  const citiesScanBtn = $("cities-scan-btn");
  const ctCancelBtn = $("ct-cancel-btn");
  const ctAllyFilter = $("ct-ally-filter"); // narrows scan, pre-fetch
  const ctDisplayFilter = $("ct-display-filter"); // filters displayed list, post-scan
  const ctResults = $("ct-panel-results");
  const scanDistance = $("scan-distance");
  const scanDistanceSource = $("scan-distance-source");
  const allScanBtns = [scanMapBtn, islandScanBtn, ctScanBtn, citiesScanBtn];

  // Last CT result set kept in memory so the display filter can re-render without rescanning
  let lastCtResult = null;

  function attachCtPort(port) {
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "phase":
          phaseText.textContent = msg.text;
          break;
        case "progress": {
          const pct = msg.total > 0 ? Math.round((msg.current / msg.total) * 100) : 0;
          progressBar.style.width = pct + "%";
          let label;
          if (msg.phase === "map") label = "Scanning map";
          else if (msg.phase === "ct-check") label = "Checking CT";
          else if (msg.phase === "cities") label = "Fetching cities";
          else label = "Fetching islands";
          if (msg.paused) {
            phaseText.textContent = `Cooldown (${msg.pauseSec}s)...`;
            statusDetail.textContent = `${msg.current}/${msg.total} done`;
          } else {
            const eta = msg.eta > 0 ? ` \u2022 ~${msg.eta}s left` : "";
            phaseText.textContent = `${label} (${msg.current}/${msg.total})`;
            statusDetail.textContent = eta;
          }
          break;
        }
        case "log":
          log(msg.message);
          break;
        case "complete":
          phaseText.textContent = "Done!";
          progressBar.style.width = "100%";
          allScanBtns.forEach((b) => (b.disabled = false)); refreshButtonStates();
          ctCancelBtn.style.display = "none";
          if (msg.mapOnly) {
            log(`Map scan: ${msg.totalIslands} islands found`);
          } else if (msg.islandsOnly) {
            log(`Islands scan: ${msg.players.length} players across ${msg.totalIslands} islands`);
            showCtResults(msg.players, [], msg.allyCounts, msg.timestamp);
          } else {
            log(`${msg.players.length} players, ${msg.ctPlayers.length} with CT available across ${msg.totalIslands} islands`);
            showCtResults(msg.players, msg.ctPlayers, msg.allyCounts, msg.timestamp);
          }
          loadGallery();
          break;
        case "error":
          phaseText.textContent = "Error";
          statusDetail.textContent = msg.message;
          log("ERROR: " + msg.message);
          allScanBtns.forEach((b) => (b.disabled = false)); refreshButtonStates();
          ctCancelBtn.style.display = "none";
          break;
      }
    });
  }

  let bgStorageListener = null;
  let activeScanMode = null;
  function attachBgStorageListener() {
    if (bgStorageListener) chrome.storage.onChanged.removeListener(bgStorageListener);
    bgStorageListener = (changes) => {
      // Live progress updates during background phases
      if (changes.ctScanProgress?.newValue) {
        const p = changes.ctScanProgress.newValue;
        const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
        progressBar.style.width = pct + "%";
        if (p.paused) {
          phaseText.textContent = `Cooldown (${p.pauseSec}s)...`;
          statusDetail.textContent = p.total > 0 ? `${p.current}/${p.total} done` : "";
        } else {
          let plabel;
          if (p.phase === "map") plabel = "Scanning map";
          else if (p.phase === "ct-check") plabel = "Checking CT";
          else if (p.phase === "cities") plabel = "Fetching cities";
          else plabel = "Fetching islands";
          phaseText.textContent = `${plabel} (${p.current}/${p.total})`;
          const eta = p.eta > 0 ? ` \u2022 ~${p.eta}s left` : "";
          statusDetail.textContent = eta;
        }
      }
      // Background scan finished — pull final results from storage
      if (changes.ctScanRunning && changes.ctScanRunning.newValue === false) {
        chrome.storage.onChanged.removeListener(bgStorageListener);
        bgStorageListener = null;
        if (!ikariamWorldName) return;
        if (activeScanMode === "islands" || activeScanMode === "fullCities") {
          // No CT data to display — just report completion
          phaseText.textContent = "Done!";
          progressBar.style.width = "100%";
          statusDetail.textContent = "";
          log(activeScanMode === "fullCities" ? "Deep scan complete" : "Island scan complete");
          loadGallery();
          allScanBtns.forEach((b) => (b.disabled = false));
          ctCancelBtn.style.display = "none";
        } else {
          const storageKey = "ctScan_" + ikariamWorldName;
          chrome.storage.local.get(storageKey, (d) => {
            const r = d[storageKey];
            if (r) {
              phaseText.textContent = "Done!";
              progressBar.style.width = "100%";
              statusDetail.textContent = "";
              log(`${r.players.length} players, ${r.ctPlayers.length} with CT available`);
              showCtResults(r.players, r.ctPlayers, r.allyCounts, r.timestamp);
              loadGallery();
            }
            allScanBtns.forEach((b) => (b.disabled = false));
            ctCancelBtn.style.display = "none";
          });
        }
      }
    };
    chrome.storage.onChanged.addListener(bgStorageListener);
  }

  function startScan(mode, label) {
    if (!ikariamTabId) return;
    activeScanMode = mode;
    allScanBtns.forEach((b) => (b.disabled = true));
    ctCancelBtn.style.display = "";
    scanLog.innerHTML = "";
    phaseText.textContent = label;
    statusDetail.textContent = "";
    progressBar.style.width = "0%";

    const port = chrome.tabs.connect(ikariamTabId, { name: "ct-scan" });
    const distVal = parseInt(scanDistance.value, 10);
    port.postMessage({
      action: "start-ct-scan",
      mode,
      allyFilter: ctAllyFilter.value.trim(),
      distanceRadius: distVal > 0 ? distVal : 0,
      distanceSource: scanDistanceSource.value,
    });
    attachCtPort(port);
    if (mode === "islands" || mode === "full" || mode === "fullCities") attachBgStorageListener();
  }

  scanMapBtn.addEventListener("click", () => startScan("map", "Scanning map..."));
  islandScanBtn.addEventListener("click", () => startScan("islands", "Starting island scan..."));
  ctScanBtn.addEventListener("click", () => startScan("full", "Starting full scan..."));
  citiesScanBtn.addEventListener("click", () => startScan("fullCities", "Starting deep scan..."));

  // --- Export full world data as JSON ---
  const exportBtn = $("export-data-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      if (!ikariamWorldName) { log("No world detected"); return; }
      const w = ikariamWorldName;
      const all = await chrome.storage.local.get(null);
      const islandPrefix = "island_" + w + "_";
      const cityPrefix = "cityData_" + w + "_";
      const islands = [];
      const cities = [];
      for (const k of Object.keys(all)) {
        if (k.startsWith(islandPrefix)) islands.push(all[k]);
        else if (k.startsWith(cityPrefix)) cities.push(all[k]);
      }
      const payload = {
        formatVersion: 1,
        world: w,
        exportedAt: new Date().toISOString(),
        map: all["map_" + w] || null,
        allianceIndex: all["allianceIndex_" + w] || null,
        queryIndex: all["queryIndex_" + w] || null,
        ctScan: all["ctScan_" + w] || null,
        islands,
        cities,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ikariam-${w}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      log(`Exported ${islands.length} islands, ${cities.length} cities`);
    });
  }

  // Both buttons always enabled — full scan does everything from scratch
  async function refreshButtonStates() {}

  ctCancelBtn.addEventListener("click", () => {
    if (ikariamTabId) chrome.tabs.sendMessage(ikariamTabId, { type: "ct-cancel" }).catch(() => {});
    chrome.runtime.sendMessage({ type: "bg-cancel-scan" }).catch(() => {});
    ctCancelBtn.style.display = "none";
    allScanBtns.forEach((b) => (b.disabled = false)); refreshButtonStates();
    phaseText.textContent = "Cancelled";
  });

  // On popup open: check for running CT scan or load previous results
  function checkCtState() {
    if (!ikariamWorldName) return;
    const storageKey = "ctScan_" + ikariamWorldName;
    chrome.storage.local.get([storageKey, "ctScanRunning", "ctScanProgress"], (data) => {
      if (data.ctScanRunning && ikariamTabId) {
        // Reconnect to running scan
        allScanBtns.forEach((b) => (b.disabled = true));
        ctCancelBtn.style.display = "";
        if (data.ctScanProgress) {
          const p = data.ctScanProgress;
          const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
          progressBar.style.width = pct + "%";
          let label;
          if (p.phase === "map") label = "Scanning map";
          else if (p.phase === "ct-check") label = "Checking CT";
          else if (p.phase === "cities") label = "Fetching cities";
          else label = "Fetching islands";
          phaseText.textContent = `${label} (${p.current}/${p.total})`;
        } else {
          phaseText.textContent = "Scan running...";
        }
        const port = chrome.tabs.connect(ikariamTabId, { name: "ct-scan" });
        attachCtPort(port);
        // Watch storage for completion
        const listener = (changes) => {
          if (changes.ctScanRunning && !changes.ctScanRunning.newValue) {
            chrome.storage.onChanged.removeListener(listener);
            allScanBtns.forEach((b) => (b.disabled = false)); refreshButtonStates();
            ctCancelBtn.style.display = "none";
            // Load results from storage
            phaseText.textContent = "Done!";
            progressBar.style.width = "100%";
            statusDetail.textContent = "";
            chrome.storage.local.get(storageKey, (d) => {
              const r = d[storageKey];
              if (r) {
                showCtResults(r.players, r.ctPlayers, r.allyCounts, r.timestamp);
              }
            });
            loadGallery();
          } else if (changes.ctScanProgress?.newValue) {
            const p = changes.ctScanProgress.newValue;
            const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
            progressBar.style.width = pct + "%";
            if (p.paused) {
              phaseText.textContent = `Cooldown (${p.pauseSec}s)...`;
            } else {
              let label;
              if (p.phase === "map") label = "Scanning map";
              else if (p.phase === "ct-check") label = "Checking CT";
              else if (p.phase === "cities") label = "Fetching cities";
              else label = "Fetching islands";
              phaseText.textContent = `${label} (${p.current}/${p.total})`;
            }
          }
        };
        chrome.storage.onChanged.addListener(listener);
      } else if (data[storageKey]) {
        // Show previous results
        const r = data[storageKey];
        showCtResults(r.players, r.ctPlayers, r.allyCounts, r.timestamp);
      }
    });
  }

  function showCtResults(players, ctPlayers, allyCounts, timestamp) {
    lastCtResult = { players, ctPlayers, allyCounts, timestamp };
    renderCtResults();
  }

  // Render the CT panel with the in-memory lastCtResult, applying the
  // display-time alliance filter if the user has typed anything.
  function renderCtResults() {
    if (!ctResults) return;
    if (!lastCtResult) {
      ctResults.innerHTML = "No CT scan yet. Run a Full Scan on the Maps tab.";
      return;
    }
    const { players, ctPlayers, allyCounts, timestamp } = lastCtResult;
    const ctLabels = { offer: "Can offer", accept: "Pending (accept)" };
    const age = timestamp ? formatAge(timestamp) : "";

    // Display-time filter
    const q = (ctDisplayFilter && ctDisplayFilter.value || "").trim().toLowerCase();
    const match = (p) => !q || (p.allyTag || "").toLowerCase().includes(q);
    const visibleCt = ctPlayers.filter(match);
    const visibleChecked = players.filter(match);

    const suffix = q ? ` (filtered by "${q}")` : "";
    let html = `<div style="margin-bottom:8px;color:var(--text-heading);font-weight:600;">${visibleCt.length} players with CT available <span style="color:var(--text-dim);font-weight:400;">(${visibleChecked.length} checked${age ? " \u2022 " + age : ""}${suffix})</span></div>`;

    if (visibleCt.length > 0) {
      html += '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:12px;">';
      html += '<tr style="color:var(--text-dim);"><th style="text-align:left;padding:2px 4px;">Player</th><th style="text-align:left;padding:2px 4px;">Alliance</th><th style="text-align:left;padding:2px 4px;">Status</th><th style="text-align:left;padding:2px 4px;">Islands</th></tr>';
      for (const p of visibleCt.sort((a, b) => a.name.localeCompare(b.name))) {
        const islandList = p.islands.map((i) => `${i.name} [${i.x}:${i.y}]`).join(", ");
        const statusColor = p.ct === "accept" ? "var(--success)" : "var(--accent)";
        html += `<tr style="border-top:1px solid var(--border-subtle);"><td style="padding:2px 4px;color:var(--text);">${p.name}</td><td style="padding:2px 4px;color:var(--accent);">${p.allyTag || "-"}</td><td style="padding:2px 4px;color:${statusColor};">${ctLabels[p.ct] || p.ct}</td><td style="padding:2px 4px;color:var(--text-dim);" title="${islandList}">${p.islands.length}</td></tr>`;
      }
      html += "</table>";
    } else {
      html += '<div style="color:var(--text-dim);margin-bottom:8px;">No cultural treaty partners match the current filter.</div>';
    }

    // Alliance summary — always computed from visible set
    const visibleAllyCounts = {};
    for (const p of visibleChecked) {
      const tag = p.allyTag || "(none)";
      visibleAllyCounts[tag] = (visibleAllyCounts[tag] || 0) + 1;
    }
    const allyEntries = Object.entries(visibleAllyCounts).sort((a, b) => b[1] - a[1]);
    html += '<details style="margin-top:4px;"><summary style="cursor:pointer;color:var(--text-muted);font-size:11px;">All players by alliance (' + visibleChecked.length + ')</summary><div style="margin-top:4px;">';
    for (const [tag, count] of allyEntries) {
      html += `<span style="display:inline-block;margin:2px 6px 2px 0;padding:1px 6px;background:var(--bg-active);border-radius:3px;font-size:11px;cursor:pointer;" data-tag="${tag}">${tag} (${count})</span>`;
    }
    html += "</div></details>";
    ctResults.innerHTML = html;

    // Click an alliance chip to filter by it
    ctResults.querySelectorAll("[data-tag]").forEach((el) => {
      el.addEventListener("click", () => {
        if (!ctDisplayFilter) return;
        const tag = el.dataset.tag;
        ctDisplayFilter.value = tag === "(none)" ? "" : tag;
        renderCtResults();
      });
    });
  }

  // Wire the display-time filter input — re-renders the CT panel on every keystroke
  if (ctDisplayFilter) {
    ctDisplayFilter.addEventListener("input", renderCtResults);
  }

  function formatAge(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }

  // On popup open, check if a minimap-initiated scan completed while popup was closed
  function checkScanState() {
    chrome.storage.local.get("scanResult", (data) => {
      if (data.scanResult) {
        const { islands } = data.scanResult;
        chrome.storage.local.remove("scanResult");
        log(`Map scan completed in background: ${islands.length} islands`);
        loadGallery();
      }
    });
  }

  // --- Storage ---
  // Map writing is done directly by culturaltreaty.js (content script) during
  // the scan flow — popup is read-only for the gallery.
  const STORAGE_INDEX = "mapIndex";

  async function getIndex() {
    const data = await chrome.storage.local.get(STORAGE_INDEX);
    return data[STORAGE_INDEX] || [];
  }

  async function deleteMap(key) {
    const index = await getIndex();
    await chrome.storage.local.set({
      [STORAGE_INDEX]: index.filter((e) => e.key !== key),
    });
    await chrome.storage.local.remove(key);
    loadGallery();
  }

  // --- Gallery ---
  async function loadGallery() {
    const index = await getIndex();
    if (index.length === 0) {
      galleryList.innerHTML =
        '<div class="gallery-empty">No saved maps yet. Scan a world first!</div>';
      return;
    }

    const allianceScopedKey = ikariamWorldName ? "allianceIndex_" + ikariamWorldName : null;
    const extraData = await chrome.storage.local.get(
      ["hideZeroCities", allianceScopedKey].filter(Boolean)
    );
    const dimEmptyActive = !!extraData.hideZeroCities;
    const allianceIndex = (allianceScopedKey && extraData[allianceScopedKey]) || {};

    galleryList.innerHTML = "";
    for (const entry of index) {
      const data = await chrome.storage.local.get(entry.key);
      const map = data[entry.key];
      if (!map) continue;

      const allyColorMap = MapRender.buildAllianceColorMap(allianceIndex, map.islands);

      if (map.islands) {
        MapRender.enrichIslandsWithAlliances(map.islands, allianceIndex, allyColorMap);
      }

      const card = document.createElement("div");
      card.className = "gallery-card";

      const info = document.createElement("div");
      info.className = "gallery-info";

      const date = new Date(entry.scanDate);
      const dateStr =
        date.toLocaleDateString() +
        " " +
        date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const populated = map.islands
        ? map.islands.filter((i) => i.cities > 0).length
        : 0;

      info.innerHTML = `
        <h3>${entry.worldName}</h3>
        <div class="meta">${dateStr}</div>
        <div class="meta">${map.islands ? map.islands.length : 0} islands \u2022 ${populated} populated</div>
      `;

      // Layer thumbnail strip
      const thumbStrip = document.createElement("div");
      thumbStrip.className = "thumb-strip";

      const layerKeys = Object.keys(MapRender.LAYERS).filter((k) => k !== "filter");
      for (const layerKey of layerKeys) {
        const thumbCanvas = document.createElement("canvas");
        const thumbCtx = thumbCanvas.getContext("2d");
        if (map.islands && map.islands.length > 0) {
          MapRender.render(thumbCtx, map.islands, {
            tileW: 2, tileH: 2, islandSize: 2, pad: 2,
            drawLegend: false, layer: layerKey,
            dimEmpty: dimEmptyActive,
          });
        }
        const thumbWrap = document.createElement("div");
        thumbWrap.className = "layer-thumb-wrap";

        const thumb = document.createElement("img");
        thumb.src = thumbCanvas.toDataURL("image/png");
        thumb.className = "layer-thumb";
        thumb.addEventListener("click", (e) => {
          e.stopPropagation();
          openPreview(layerKey);
        });
        thumb.addEventListener("auxclick", (e) => {
          if (e.button === 1) { e.stopPropagation(); openPreview(layerKey, true); }
        });

        const label = document.createElement("div");
        label.className = "thumb-label";
        label.textContent = MapRender.LAYERS[layerKey].name;

        thumbWrap.appendChild(thumb);
        thumbWrap.appendChild(label);
        thumbStrip.appendChild(thumbWrap);
      }

      info.appendChild(thumbStrip);

      card.appendChild(info);

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-danger btn-sm delete-btn";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("Delete this saved map? This cannot be undone.")) return;
        deleteMap(entry.key);
      });
      card.appendChild(delBtn);

      galleryList.appendChild(card);

      function openPreview(layerKey, background) {
        const previewCanvas = document.createElement("canvas");
        const previewCtx = previewCanvas.getContext("2d");
        MapRender.render(previewCtx, map.islands || [], { layer: layerKey || "population", dimEmpty: dimEmptyActive });
        const blob = dataUrlToBlob(previewCanvas.toDataURL("image/png"));
        const url = URL.createObjectURL(blob);
        openTabNextToActive(url, !background);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }

      card.addEventListener("click", () => openPreview("population"));
    }
  }

  function openTabNextToActive(url, active) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const opts = { url, active };
      const cur = tabs && tabs[0];
      if (cur) {
        opts.index = cur.index + 1;
        opts.openerTabId = cur.id;
      }
      chrome.tabs.create(opts);
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [header, data] = dataUrl.split(",");
    const mime = header.match(/:(.*?);/)[1];
    const bytes = atob(data);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  // --- Minimap toggle ---
  async function loadMinimapState() {
    const data = await chrome.storage.local.get(["minimapEnabled", "minimapPosition"]);
    minimapToggle.checked = !!data.minimapEnabled;
    const pos = data.minimapPosition || "right";
    posLeft.classList.toggle("active", pos === "left");
    posRight.classList.toggle("active", pos === "right");
  }

  minimapToggle.addEventListener("change", () => {
    const enabled = minimapToggle.checked;
    chrome.storage.local.set({ minimapEnabled: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "minimap-toggle", enabled }).catch(() => {});
    }
  });

  [posLeft, posRight].forEach((btn) => {
    btn.addEventListener("click", () => {
      const pos = btn.dataset.pos;
      posLeft.classList.toggle("active", pos === "left");
      posRight.classList.toggle("active", pos === "right");
      chrome.storage.local.set({ minimapPosition: pos });
      if (ikariamTabId) {
        chrome.tabs.sendMessage(ikariamTabId, { type: "minimap-position", position: pos }).catch(() => {});
      }
    });
  });

  // --- Minimap scale ---
  async function loadScaleState() {
    const data = await chrome.storage.local.get("minimapScale");
    const scale = data.minimapScale || 1.25;
    document.querySelectorAll(".scale-btns button").forEach((b) => {
      b.classList.toggle("active", parseFloat(b.dataset.scale) === scale);
    });
  }
  loadScaleState();

  document.querySelectorAll(".scale-btns button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const scale = parseFloat(btn.dataset.scale);
      document.querySelectorAll(".scale-btns button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      chrome.storage.local.set({ minimapScale: scale });
      if (ikariamTabId) {
        chrome.tabs.sendMessage(ikariamTabId, { type: "minimap-scale", scale }).catch(() => {});
      }
    });
  });

  // --- Viewport trim ---
  const trimRight = $("trim-right");
  const trimBottom = $("trim-bottom");

  async function loadTrimState() {
    const data = await chrome.storage.local.get(["vpTrimRight", "vpTrimBottom"]);
    trimRight.value = Math.round((data.vpTrimRight ?? 0.08) * 100);
    trimBottom.value = Math.round((data.vpTrimBottom ?? 0.15) * 100);
  }
  loadTrimState();

  function sendTrim() {
    const r = (parseInt(trimRight.value, 10) || 0) / 100;
    const b = (parseInt(trimBottom.value, 10) || 0) / 100;
    chrome.storage.local.set({ vpTrimRight: r, vpTrimBottom: b });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "vp-trim", right: r, bottom: b }).catch(() => {});
    }
  }
  trimRight.addEventListener("change", sendTrim);
  trimBottom.addEventListener("change", sendTrim);

  // --- Hide zeros toggle ---
  const hideZerosToggle = $("hide-zeros-toggle");

  async function loadHideZerosState() {
    const data = await chrome.storage.local.get("hideZeroCities");
    hideZerosToggle.checked = !!data.hideZeroCities;
  }
  loadHideZerosState();

  hideZerosToggle.addEventListener("change", () => {
    const enabled = hideZerosToggle.checked;
    chrome.storage.local.set({ hideZeroCities: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "hide-zeros-toggle", enabled }).catch(() => {});
    }
  });

  // --- Cleanup toggle ---
  async function loadCleanupState() {
    const data = await chrome.storage.local.get("cleanupEnabled");
    cleanupToggle.checked = !!data.cleanupEnabled;
  }

  cleanupToggle.addEventListener("change", () => {
    const enabled = cleanupToggle.checked;
    chrome.storage.local.set({ cleanupEnabled: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "cleanup-toggle", enabled }).catch(() => {});
    }
  });

  // --- Auto pirate ---
  const pirateToggle = $("pirate-toggle");
  const convertToggle = $("convert-toggle");
  const aggressiveToggle = $("aggressive-toggle");
  const pirateCity = $("pirate-city");
  const pirateStart = $("pirate-start");
  const pirateEnd = $("pirate-end");
  const pirateStatsBar = $("pirate-stats-bar");

  function renderPirateStats(ps) {
    if (!ps || !ps.stats) {
      pirateStatsBar.textContent = "No session data yet.";
      return;
    }
    pirateStatsBar.textContent = ps.stats;
  }

  // Load initial stats and listen for changes
  chrome.storage.local.get("pirateStatus", (data) => renderPirateStats(data.pirateStatus));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pirateStatus) renderPirateStats(changes.pirateStatus.newValue);
  });

  // Advanced timing param IDs and their storage keys
  const PIRATE_ADV = [
    { id: "pirate-mu",         key: "pirateBaseMu",           parse: parseFloat },
    { id: "pirate-sigma",      key: "pirateBaseSigma",        parse: parseFloat },
    { id: "pirate-brk-min",    key: "pirateBreakMin",         parse: (v) => parseInt(v, 10) },
    { id: "pirate-brk-max",    key: "pirateBreakMax",          parse: (v) => parseInt(v, 10) },
    { id: "pirate-strk-lo",    key: "pirateStreakLo",          parse: (v) => parseInt(v, 10) },
    { id: "pirate-strk-hi",    key: "pirateStreakHi",          parse: (v) => parseInt(v, 10) },
    { id: "pirate-distract",   key: "pirateDistractChance",   parse: parseFloat },
    { id: "pirate-t2-base",    key: "pirateT2Base",            parse: parseFloat },
    { id: "pirate-t2-ramp",    key: "pirateT2Ramp",            parse: parseFloat },
    { id: "pirate-t2-distract",key: "pirateT2Distract",        parse: parseFloat },
    { id: "pirate-force-brk",  key: "pirateForceBreakChance", parse: parseFloat },
    { id: "pirate-bb",         key: "pirateBackToBack",        parse: parseFloat },
  ];
  // Map storage key names to cfg key names for pirate-config messages
  const STORAGE_TO_CFG = {
    pirateBaseMu: "baseMu", pirateBaseSigma: "baseSigma",
    pirateBreakMin: "breakMin", pirateBreakMax: "breakMax",
    pirateStreakLo: "streakLo", pirateStreakHi: "streakHi",
    pirateDistractChance: "distractChance",
    pirateT2Base: "t2Base", pirateT2Ramp: "t2Ramp",
    pirateT2Distract: "t2Distract",
    pirateForceBreakChance: "forceBreakChance",
    pirateBackToBack: "backToBackChance",
  };

  // World name as known by the content script (URL-based, e.g. "s55-cz")
  // This is the canonical name used for all pirate storage keys.
  let pirateWorldName = null;

  async function loadPirateState() {
    // First try to get the canonical world name and city list from content script
    let cities = [];
    if (ikariamTabId) {
      try {
        const resp = await chrome.tabs.sendMessage(ikariamTabId, { type: "get-cities" });
        if (resp) {
          cities = resp.cities || [];
          if (resp.worldName) pirateWorldName = resp.worldName;
        }
      } catch (e) {
        // Content script not available
      }
    }

    // Build the scoped key using the content script's world name (canonical)
    const pirateCityScopedKey = pirateWorldName ? "pirateCityId_" + pirateWorldName : null;
    const keys = [
      "pirateEnabled", "pirateConvertEnabled", "pirateAggressive", "pirateCityId",
      "pirateSleepStart", "pirateSleepEnd",
      ...PIRATE_ADV.map((a) => a.key),
    ];
    if (pirateCityScopedKey) keys.push(pirateCityScopedKey);

    const data = await chrome.storage.local.get(keys);
    pirateToggle.checked = !!data.pirateEnabled;
    convertToggle.checked = !!data.pirateConvertEnabled;
    aggressiveToggle.checked = !!data.pirateAggressive;
    pirateStart.value = data.pirateSleepStart ?? 1;
    pirateEnd.value = data.pirateSleepEnd ?? 7;

    // Use world-scoped key if available, fall back to legacy global key
    const savedCityId = (pirateCityScopedKey && data[pirateCityScopedKey]) ?? data.pirateCityId ?? null;

    // Load advanced params
    for (const a of PIRATE_ADV) {
      const el = $(a.id);
      if (el && data[a.key] != null) el.value = data[a.key];
    }

    // Populate city dropdown
    if (cities.length > 0) {
      pirateCity.innerHTML = '<option value="">-- select --</option>';
      for (const c of cities) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name + " " + c.coords;
        if (c.id === savedCityId) opt.selected = true;
        pirateCity.appendChild(opt);
      }
    }
  }

  pirateToggle.addEventListener("change", () => {
    const enabled = pirateToggle.checked;
    chrome.storage.local.set({ pirateEnabled: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "pirate-toggle", enabled }).catch(() => {});
    }
  });

  convertToggle.addEventListener("change", () => {
    const enabled = convertToggle.checked;
    chrome.storage.local.set({ pirateConvertEnabled: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "pirate-convert-toggle", enabled }).catch(() => {});
    }
  });

  aggressiveToggle.addEventListener("change", () => {
    const enabled = aggressiveToggle.checked;
    chrome.storage.local.set({ pirateAggressive: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "pirate-aggressive-toggle", enabled }).catch(() => {});
    }
  });

  pirateCity.addEventListener("change", () => {
    const cityId = parseInt(pirateCity.value, 10) || null;
    // Save directly to storage with canonical world-scoped key
    if (pirateWorldName) {
      chrome.storage.local.set({ ["pirateCityId_" + pirateWorldName]: cityId });
    }
    // Also notify content script so it picks up the change immediately
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "pirate-config", cityId }).catch(() => {});
    }
  });

  function sendPirateHours() {
    const s = pirateStart.value !== "" ? parseInt(pirateStart.value, 10) : null;
    const e = pirateEnd.value !== "" ? parseInt(pirateEnd.value, 10) : null;
    chrome.storage.local.set({ pirateSleepStart: s, pirateSleepEnd: e });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "pirate-config", sleepStart: s, sleepEnd: e }).catch(() => {});
    }
  }
  pirateStart.addEventListener("change", sendPirateHours);
  pirateEnd.addEventListener("change", sendPirateHours);

  // Advanced timing params — each input sends its value on change
  for (const a of PIRATE_ADV) {
    const el = $(a.id);
    if (!el) continue;
    el.addEventListener("change", () => {
      const val = a.parse(el.value);
      if (isNaN(val)) return;
      const cfgKey = STORAGE_TO_CFG[a.key];
      chrome.storage.local.set({ [a.key]: val });
      if (ikariamTabId && cfgKey) {
        chrome.tabs.sendMessage(ikariamTabId, { type: "pirate-config", [cfgKey]: val }).catch(() => {});
      }
    });
  }

  // Toggle advanced section visibility
  const advToggle = $("pirate-adv-toggle");
  const advPanel = $("pirate-adv-panel");
  const expectedDiv = $("pirate-expected");
  if (advToggle && advPanel) {
    advToggle.addEventListener("click", () => {
      const open = advPanel.style.display !== "none";
      advPanel.style.display = open ? "none" : "flex";
      expectedDiv.style.display = open ? "none" : "block";
      advToggle.textContent = (open ? "\u25b6" : "\u25bc") + " Advanced";
      if (!open) updateExpected();
    });
  }

  // --- Live expected-value computation ---
  function getAdvVal(id, fallback) {
    const el = $(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isNaN(v) ? fallback : v;
  }

  function updateExpected() {
    if (!expectedDiv || expectedDiv.style.display === "none") return;

    const mu = getAdvVal("pirate-mu", 2.9);
    const sigma = getAdvVal("pirate-sigma", 1.0);
    const brkMin = getAdvVal("pirate-brk-min", 4);
    const brkMax = getAdvVal("pirate-brk-max", 10);
    const strkLo = getAdvVal("pirate-strk-lo", 10);
    const strkHi = getAdvVal("pirate-strk-hi", 20);
    const distractChance = getAdvVal("pirate-distract", 0.10);
    const t2Base = getAdvVal("pirate-t2-base", 0.10);
    const t2Ramp = getAdvVal("pirate-t2-ramp", 0.60);
    const t2Distract = getAdvVal("pirate-t2-distract", 0.45);
    const forceBreakChance = getAdvVal("pirate-force-brk", 0.20);
    const bbChance = getAdvVal("pirate-bb", 0.15);

    // Lognormal stats — adjusted for avg session fatigue (+0.35 to mu over ~17h)
    const adjMu = mu + 0.35;
    const medianDelay = Math.exp(adjMu);
    const meanDelay = Math.exp(adjMu + sigma * sigma / 2);
    const p10Delay = Math.exp(adjMu + sigma * (-1.2816));
    const p90Delay = Math.exp(adjMu + sigma * 1.2816);

    // Break hazard: sigmoid between strkLo and strkHi
    function hazard(n) {
      if (n < strkLo) return 0;
      const mid = (strkLo + strkHi) / 2;
      const steep = 6 / (strkHi - strkLo);
      return 1 / (1 + Math.exp(-steep * (n - mid)));
    }

    // Expected streak length: sum of survival probabilities
    let expectedStreak = 0;
    let survival = 1;
    for (let n = 1; n <= 100; n++) {
      survival *= (1 - hazard(n));
      expectedStreak += survival;
      if (survival < 0.001) break;
    }

    // Average T2 probability across a typical streak (no distraction, no back-to-back)
    let t2Sum = 0;
    const streakSim = Math.round(expectedStreak);
    for (let n = 0; n < streakSim; n++) {
      const progress = Math.min(n / strkHi, 1.0);
      const sigmoid = t2Ramp / (1 + Math.exp(-8 * (progress - 0.6)));
      t2Sum += t2Base + sigmoid;
    }
    const avgT2 = streakSim > 0 ? t2Sum / streakSim : t2Base;

    // Rewards per tier
    const T1_PTS = 115, T2_PTS = 276;
    const T1_GOLD = 40, T2_GOLD = 96;
    const t1dur = 150; // seconds
    const t2dur = 450;

    // Average per-raid rewards
    const avgPts = T1_PTS * (1 - avgT2) + T2_PTS * avgT2;
    const avgGold = T1_GOLD * (1 - avgT2) + T2_GOLD * avgT2;

    // Average cycle time: mission + delay + nav/poll overhead (~5s per raid)
    const avgMission = t1dur * (1 - avgT2) + t2dur * avgT2;
    const avgCycle = avgMission + meanDelay + 5;

    // Break duration (mean of lognormal with mu=log(midpoint), sigma=0.4)
    const dynBrkMinMid = brkMin + 0.5 * 2; // approx mid-streak factor
    const brkMu = Math.log((dynBrkMinMid + brkMax) / 2 * 60);
    const meanBreak = Math.exp(brkMu + 0.4 * 0.4 / 2);

    // Raids per hour (accounting for breaks)
    const streakTime = expectedStreak * avgCycle;
    const cycleWithBreak = streakTime + meanBreak;
    const raidsPerHour = expectedStreak / cycleWithBreak * 3600;

    // Points & gold per hour
    const ptsPerHour = raidsPerHour * avgPts;
    const goldPerHour = raidsPerHour * avgGold;

    // Active hours per day (24 - sleep window)
    const sleepStart = getAdvVal("pirate-start", 1);
    const sleepEnd = getAdvVal("pirate-end", 7);
    let activeHours = 24 - ((sleepEnd - sleepStart + 24) % 24 || 24);
    if (sleepStart === sleepEnd) activeHours = 24; // no sleep = always active

    // Daily totals
    const dailyPts = ptsPerHour * activeHours;
    const dailyGold = goldPerHour * activeHours;
    const dailyRaids = raidsPerHour * activeHours;

    // Aggressive mode: delays + breaks halved, missions unchanged
    const avgCycleAgg = avgMission + meanDelay * 0.5 + 5;
    const meanBreakAgg = meanBreak * 0.5;
    const cycleWithBreakAgg = expectedStreak * avgCycleAgg + meanBreakAgg;
    const raidsPerHourAgg = expectedStreak / cycleWithBreakAgg * 3600;
    const dailyPtsAgg = raidsPerHourAgg * avgPts * activeHours;
    const dailyGoldAgg = raidsPerHourAgg * avgGold * activeHours;
    const dailyRaidsAgg = raidsPerHourAgg * activeHours;

    function fmtTime(sec) {
      if (sec < 60) return sec.toFixed(0) + "s";
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return m + "m " + (s < 10 ? "0" : "") + s + "s";
    }

    function fmtNum(n) {
      return n >= 1000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toString();
    }

    expectedDiv.innerHTML =
      `<b style="color:#e0e4ec">Expected yield</b><br>` +
      `Per hour: <b style="color:#5ca0f2">${fmtNum(ptsPerHour)} pts</b>, ` +
      `<b style="color:#f2c85c">${fmtNum(goldPerHour)} gold</b> ` +
      `<span style="color:#556">(${raidsPerHour.toFixed(1)} raids/h)</span><br>` +
      `Per day <span style="color:#556">(${activeHours}h active)</span>: ` +
      `<b style="color:#5ca0f2">${fmtNum(dailyPts)} pts</b>, ` +
      `<b style="color:#f2c85c">${fmtNum(dailyGold)} gold</b> ` +
      `<span style="color:#556">(~${Math.round(dailyRaids)} raids)</span><br>` +
      `Per day <span style="color:#ff6464">aggressive</span>: ` +
      `<b style="color:#5ca0f2">${fmtNum(dailyPtsAgg)} pts</b>, ` +
      `<b style="color:#f2c85c">${fmtNum(dailyGoldAgg)} gold</b> ` +
      `<span style="color:#556">(~${Math.round(dailyRaidsAgg)} raids)</span><br>` +
      `<span style="color:#556">───</span><br>` +
      `Delay: <b style="color:#c8cdd8">${fmtTime(medianDelay)}</b> median, ` +
      `<b style="color:#c8cdd8">${fmtTime(meanDelay)}</b> mean ` +
      `<span style="color:#556">(p10=${fmtTime(p10Delay)}, p90=${fmtTime(p90Delay)})</span><br>` +
      `Streak: <b style="color:#c8cdd8">${expectedStreak.toFixed(1)}</b> raids, ` +
      `break: <b style="color:#c8cdd8">${fmtTime(meanBreak)}</b>, ` +
      `T2: <b style="color:#c8cdd8">${(avgT2 * 100).toFixed(1)}%</b>`;
  }

  // Update expected values when any param changes
  for (const a of PIRATE_ADV) {
    const el = $(a.id);
    if (!el) continue;
    el.addEventListener("input", updateExpected);
  }
  pirateStart.addEventListener("input", updateExpected);
  pirateEnd.addEventListener("input", updateExpected);

  // --- Notes ---
  const NOTES_KEY = "ikNotes";
  const notesList = $("notes-list");
  const noteTitle = $("note-title");
  const noteEditor = $("note-editor");
  const noteAddBtn = $("note-add-btn");
  const noteDeleteBtn = $("note-delete-btn");
  const noteContentArea = $("note-content-area");
  const notesEmpty = $("notes-empty");
  let notes = [];
  let activeNoteId = null;
  let noteSaveTimer = null;

  async function loadNotes() {
    const data = await chrome.storage.local.get(NOTES_KEY);
    notes = data[NOTES_KEY] || [];
    renderNotesList();
    if (notes.length > 0) {
      selectNote(notes[0].id);
    } else {
      showNotesEmpty(true);
    }
  }

  function saveNotes() {
    chrome.storage.local.set({ [NOTES_KEY]: notes });
  }

  function renderNotesList() {
    notesList.innerHTML = "";
    for (const note of notes) {
      const item = document.createElement("div");
      item.className = "note-item" + (note.id === activeNoteId ? " active" : "");
      item.textContent = note.title || "Untitled";
      item.addEventListener("click", () => selectNote(note.id));
      notesList.appendChild(item);
    }
  }

  function selectNote(id) {
    activeNoteId = id;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    noteTitle.value = note.title;
    noteEditor.value = note.content;
    showNotesEmpty(false);
    renderNotesList();
  }

  function showNotesEmpty(empty) {
    noteContentArea.style.display = empty ? "none" : "flex";
    notesEmpty.style.display = empty ? "flex" : "none";
  }

  noteAddBtn.addEventListener("click", () => {
    const note = {
      id: Date.now(),
      title: "Untitled",
      content: "",
      updated: new Date().toISOString(),
    };
    notes.unshift(note);
    saveNotes();
    renderNotesList();
    selectNote(note.id);
    noteTitle.focus();
    noteTitle.select();
  });

  noteDeleteBtn.addEventListener("click", () => {
    if (!activeNoteId) return;
    if (!confirm("Delete this note? This cannot be undone.")) return;
    const idx = notes.findIndex((n) => n.id === activeNoteId);
    notes.splice(idx, 1);
    saveNotes();
    if (notes.length > 0) {
      const next = notes[Math.min(idx, notes.length - 1)];
      selectNote(next.id);
    } else {
      activeNoteId = null;
      showNotesEmpty(true);
    }
    renderNotesList();
  });

  function debouncedNoteSave() {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      const note = notes.find((n) => n.id === activeNoteId);
      if (note) {
        note.content = noteEditor.value;
        note.title = noteTitle.value;
        note.updated = new Date().toISOString();
        saveNotes();
        renderNotesList();
      }
    }, 500);
  }

  noteEditor.addEventListener("input", debouncedNoteSave);
  noteTitle.addEventListener("input", debouncedNoteSave);

  // --- Auto-finish toggle ---
  const autofinishToggle = $("autofinish-toggle");

  async function loadAutoFinishState() {
    const data = await chrome.storage.local.get("autoFinishEnabled");
    autofinishToggle.checked = !!data.autoFinishEnabled;
  }
  loadAutoFinishState();

  autofinishToggle.addEventListener("change", () => {
    const enabled = autofinishToggle.checked;
    chrome.storage.local.set({ autoFinishEnabled: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "autofinish-toggle", enabled }).catch(() => {});
    }
  });

  // --- Developer mode toggle ---
  const devmodeToggle = $("devmode-toggle");
  const captchaTabBtn = $("captcha-tab-btn");

  function applyDevMode(on) {
    captchaTabBtn.style.display = on ? "" : "none";
    if (citiesScanBtn) citiesScanBtn.style.display = on ? "" : "none";
    // If captcha tab is active but dev mode turned off, switch to settings
    if (!on && captchaTabBtn.classList.contains("active")) {
      captchaTabBtn.click(); // deselect
      document.querySelector('[data-tab="settings"]').click();
    }
  }

  async function loadDevModeState() {
    const data = await chrome.storage.local.get("devModeEnabled");
    const on = !!data.devModeEnabled;
    devmodeToggle.checked = on;
    applyDevMode(on);
  }
  loadDevModeState();

  devmodeToggle.addEventListener("change", () => {
    const on = devmodeToggle.checked;
    chrome.storage.local.set({ devModeEnabled: on });
    applyDevMode(on);
  });

  // --- Captcha data tab ---
  const captchaCollectToggle = $("captcha-collect-toggle");
  const captchaCount = $("captcha-count");
  const captchaSize = $("captcha-size");
  const captchaStats = $("captcha-stats");

  async function loadCaptchaCollectState() {
    const data = await chrome.storage.local.get("captchaCollectEnabled");
    captchaCollectToggle.checked = !!data.captchaCollectEnabled;
  }
  loadCaptchaCollectState();

  captchaCollectToggle.addEventListener("change", () => {
    chrome.storage.local.set({ captchaCollectEnabled: captchaCollectToggle.checked });
  });

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  async function refreshCaptchaPanel() {
    const data = await chrome.storage.local.get("captchaLog");
    const log = data.captchaLog || [];
    const jsonStr = JSON.stringify(log);
    const bytes = new Blob([jsonStr]).size;
    const total = log.length;
    const success = log.filter((e) => e.success).length;
    const fail = total - success;
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : "—";

    captchaCount.textContent = total + " captcha" + (total !== 1 ? "s" : "");
    captchaSize.textContent = "(" + formatBytes(bytes) + ")";

    if (total === 0) {
      captchaStats.textContent = "No data collected yet. Enable collection above and solve some captchas.";
    } else {
      const newest = new Date(log[log.length - 1].timestamp);
      const oldest = new Date(log[0].timestamp);
      const fmt = (d) => d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      captchaStats.innerHTML =
        `<b>Success:</b> ${success} &nbsp; <b>Failed:</b> ${fail} &nbsp; <b>Rate:</b> ${rate}%<br>` +
        `<b>First:</b> ${fmt(oldest)}<br>` +
        `<b>Latest:</b> ${fmt(newest)}`;
    }
  }

  // Refresh when captcha tab is opened
  document.querySelector('[data-tab="captcha"]').addEventListener("click", refreshCaptchaPanel);

  $("captcha-export-btn").addEventListener("click", async () => {
    const data = await chrome.storage.local.get("captchaLog");
    const log = data.captchaLog || [];
    if (log.length === 0) return;
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "captcha-log-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  });

  $("captcha-clear-btn").addEventListener("click", async () => {
    if (!confirm("Delete all collected captcha data?")) return;
    await chrome.storage.local.remove("captchaLog");
    refreshCaptchaPanel();
  });

  // --- Hide game notes toggle ---
  const hideGameNotesToggle = $("hide-game-notes-toggle");

  async function loadHideGameNotesState() {
    const data = await chrome.storage.local.get("hideGameNotes");
    hideGameNotesToggle.checked = !!data.hideGameNotes;
  }
  loadHideGameNotesState();

  hideGameNotesToggle.addEventListener("change", () => {
    chrome.storage.local.set({ hideGameNotes: hideGameNotesToggle.checked });
  });
})();

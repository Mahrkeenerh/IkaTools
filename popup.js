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
  const scanBtn = $("scan-btn");
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
      } else if (!tab.url) {
        ikariamTabId = tab.id;
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
  });

  // --- Log helper ---
  function log(msg) {
    const line = document.createElement("div");
    line.textContent = msg;
    scanLog.appendChild(line);
    scanLog.scrollTop = scanLog.scrollHeight;
  }

  // --- Advisor Report ---
  const advisorBtns = [
    $("advisor-basic-btn"),
    $("advisor-army-btn"),
    $("advisor-trade-btn"),
    $("advisor-full-btn"),
  ];
  const advisorStatus = $("advisor-status");
  const advisorProgress = $("advisor-progress");
  const advisorStatusText = $("advisor-status-text");

  function startAdvisor(mode) {
    if (!ikariamTabId) return;
    advisorBtns.forEach((b) => b.disabled = true);
    advisorStatus.style.display = "block";
    advisorProgress.style.width = "0%";
    advisorStatusText.textContent = "Starting...";

    chrome.tabs.sendMessage(ikariamTabId, { type: "generate-advisor-report", mode }, (resp) => {
      advisorBtns.forEach((b) => b.disabled = false);
      advisorStatus.style.display = "none";
      if (chrome.runtime.lastError) {
        console.error("Advisor report error:", chrome.runtime.lastError.message);
      } else if (resp?.error) {
        console.error("Advisor report error:", resp.error);
      }
    });
  }

  $("advisor-basic-btn").addEventListener("click", () => startAdvisor("basic"));
  $("advisor-army-btn").addEventListener("click", () => startAdvisor("army"));
  $("advisor-trade-btn").addEventListener("click", () => startAdvisor("trading"));
  $("advisor-full-btn").addEventListener("click", () => startAdvisor("full"));

  // Listen for progress updates from advisor.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "advisor-progress") {
      const pct = msg.total > 0 ? Math.round((msg.current / msg.total) * 100) : 0;
      advisorProgress.style.width = pct + "%";
      advisorStatusText.textContent = msg.phase;
    }
  });

  // --- Scan ---
  scanBtn.addEventListener("click", startScan);

  function startScan() {
    if (!ikariamTabId) return;
    scanBtn.disabled = true;
    scanLog.innerHTML = "";
    phaseText.textContent = "Connecting...";
    statusDetail.textContent = "";
    progressBar.style.width = "0%";

    const port = chrome.tabs.connect(ikariamTabId, { name: "map-scan" });
    port.postMessage({ action: "start-scan" });

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "started":
          phaseText.textContent = `Scanning: ${msg.worldName}`;
          log(`World: ${msg.worldName}`);
          break;

        case "stride-detected":
          log(`Viewport: ${msg.cols}x${msg.rows} tiles, stride: ${msg.strideX}x${msg.strideY}`);
          break;

        case "bounds-detected":
          log(`Bounds: X[${msg.mapMinX}..${msg.mapMaxX}] Y[${msg.mapMinY}..${msg.mapMaxY}]`);
          break;

        case "progress": {
          const pct =
            msg.total > 0 ? Math.round((msg.current / msg.total) * 100) : 0;
          progressBar.style.width = pct + "%";
          const label =
            msg.phase === "probe"
              ? "Detecting viewport"
              : msg.phase === "cross"
                ? "Scanning cross"
                : "Filling map";
          phaseText.textContent = label;
          statusDetail.textContent = `${msg.current}/${msg.total} jumps \u2022 ${msg.found} islands`;
          break;
        }

        case "log":
          log(msg.message);
          break;

        case "complete":
          phaseText.textContent = "Rendering...";
          log(`Done! ${msg.islands.length} islands total`);
          finishScan(msg.worldName, msg.islands);
          break;

        case "navigate-to-world":
          log("Navigating to world map...");
          phaseText.textContent = "Navigating...";
          port.disconnect();
          chrome.tabs.get(ikariamTabId, (tab) => {
            const base = new URL(tab.url);
            base.search = "?view=worldmap_iso";
            chrome.tabs.update(ikariamTabId, { url: base.href }, () => {
              // Wait for tab to finish loading, then re-trigger scan
              function onUpdated(tabId, info) {
                if (tabId === ikariamTabId && info.status === "complete") {
                  chrome.tabs.onUpdated.removeListener(onUpdated);
                  // Small delay for content scripts to initialize
                  setTimeout(() => startScan(), 500);
                }
              }
              chrome.tabs.onUpdated.addListener(onUpdated);
            });
          });
          return; // don't set up onDisconnect below

        case "error":
          phaseText.textContent = "Error";
          statusDetail.textContent = msg.message;
          log(`ERROR: ${msg.message}`);
          scanBtn.disabled = false;
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      scanBtn.disabled = false;
    });
  }

  async function finishScan(worldName, islands) {
    const png = renderMap(islands);
    await saveMap(worldName, islands, png);
    phaseText.textContent = "Done!";
    progressBar.style.width = "100%";
    scanBtn.disabled = false;
    loadGallery();

    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "map-updated" }).catch(() => {});
    }
  }

  function renderMap(islands, layer) {
    MapRender.render(ctx, islands, { layer: layer || "population" });
    return canvas.toDataURL("image/png");
  }

  // --- Storage ---
  const STORAGE_INDEX = "mapIndex";

  async function saveMap(worldName, islands, png) {
    const index = await getIndex();
    const key = "map_" + worldName;
    const entry = { worldName, scanDate: new Date().toISOString(), key };

    const existing = index.findIndex((e) => e.key === key);
    if (existing >= 0) index[existing] = entry;
    else index.unshift(entry);

    await chrome.storage.local.set({
      [STORAGE_INDEX]: index,
      [key]: { worldName, scanDate: entry.scanDate, islands, png },
    });
  }

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

    const extraData = await chrome.storage.local.get(["hideZeroCities", "allianceIndex"]);
    const dimEmptyActive = !!extraData.hideZeroCities;
    const allianceIndex = extraData.allianceIndex || {};
    const allyColorMap = IkUtils.buildAllianceColorMap(allianceIndex);

    galleryList.innerHTML = "";
    for (const entry of index) {
      const data = await chrome.storage.local.get(entry.key);
      const map = data[entry.key];
      if (!map) continue;

      if (map.islands) {
        IkUtils.enrichIslandsWithAlliances(map.islands, allianceIndex, allyColorMap);
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

      const layerKeys = Object.keys(MapRender.LAYERS);
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
        chrome.tabs.create({ url, active: !background });
      }

      card.addEventListener("click", () => openPreview("population"));
    }
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
    cleanupToggle.checked = data.cleanupEnabled !== false;
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
  const pirateCity = $("pirate-city");
  const pirateStart = $("pirate-start");
  const pirateEnd = $("pirate-end");

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

  async function loadPirateState() {
    const keys = [
      "pirateEnabled", "pirateConvertEnabled", "pirateCityId", "pirateSleepStart", "pirateSleepEnd",
      ...PIRATE_ADV.map((a) => a.key),
    ];
    const data = await chrome.storage.local.get(keys);
    pirateToggle.checked = !!data.pirateEnabled;
    convertToggle.checked = !!data.pirateConvertEnabled;
    pirateStart.value = data.pirateSleepStart ?? 1;
    pirateEnd.value = data.pirateSleepEnd ?? 7;

    // Load advanced params
    for (const a of PIRATE_ADV) {
      const el = $(a.id);
      if (el && data[a.key] != null) el.value = data[a.key];
    }

    // Load city list from content script
    if (ikariamTabId) {
      try {
        const resp = await chrome.tabs.sendMessage(ikariamTabId, { type: "get-cities" });
        if (resp && resp.cities) {
          pirateCity.innerHTML = '<option value="">-- select --</option>';
          for (const c of resp.cities) {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name + " " + c.coords;
            if (c.id === data.pirateCityId) opt.selected = true;
            pirateCity.appendChild(opt);
          }
        }
      } catch (e) {
        // Content script not available
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

  pirateCity.addEventListener("change", () => {
    const cityId = parseInt(pirateCity.value, 10) || null;
    chrome.storage.local.set({ pirateCityId: cityId });
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

    // Lognormal stats (base delay, no distraction/fatigue/tempo)
    const medianDelay = Math.exp(mu);
    const meanDelay = Math.exp(mu + sigma * sigma / 2);
    const p10Delay = Math.exp(mu + sigma * (-1.2816));
    const p90Delay = Math.exp(mu + sigma * 1.2816);

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

    // Average cycle time: mission + delay
    const avgMission = t1dur * (1 - avgT2) + t2dur * avgT2;
    const avgCycle = avgMission + meanDelay;

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
    autofinishToggle.checked = data.autoFinishEnabled !== false;
  }
  loadAutoFinishState();

  autofinishToggle.addEventListener("change", () => {
    const enabled = autofinishToggle.checked;
    chrome.storage.local.set({ autoFinishEnabled: enabled });
    if (ikariamTabId) {
      chrome.tabs.sendMessage(ikariamTabId, { type: "autofinish-toggle", enabled }).catch(() => {});
    }
  });
})();

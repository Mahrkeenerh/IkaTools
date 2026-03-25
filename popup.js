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
      "pirateEnabled", "pirateCityId", "pirateSleepStart", "pirateSleepEnd",
      ...PIRATE_ADV.map((a) => a.key),
    ];
    const data = await chrome.storage.local.get(keys);
    pirateToggle.checked = !!data.pirateEnabled;
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
  if (advToggle && advPanel) {
    advToggle.addEventListener("click", () => {
      const open = advPanel.style.display !== "none";
      advPanel.style.display = open ? "none" : "flex";
      advToggle.textContent = (open ? "\u25b6" : "\u25bc") + " Advanced";
    });
  }

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

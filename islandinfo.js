// Island info panel — passive data extraction, sortable player panel, alliance labels
(() => {
  const TAG = "[IslandInfo]";
  const STORAGE_PREFIX = "island_";

  // --- Extract updateBackgroundData from inline scripts ---
  function parseBackgroundData() {
    let result = null;
    document.querySelectorAll("script").forEach((script) => {
      if (result) return;
      const text = script.textContent;
      // The data is inside: ["updateBackgroundData",{...JSON...}]
      const idx = text.indexOf('"updateBackgroundData"');
      if (idx === -1) return;
      // Find the JSON object that follows
      const start = text.indexOf("{", idx);
      if (start === -1) return;
      // Walk to find matching closing brace
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            try {
              result = JSON.parse(text.substring(start, i + 1));
            } catch (e) {
              console.error(TAG, "Failed to parse background data:", e);
            }
            return;
          }
        }
      }
    });
    return result;
  }

  // --- Store island data passively ---
  async function extractAndStore() {
    if (document.body.id !== "island") return;

    const data = parseBackgroundData();
    if (!data) {
      console.log(TAG, "No updateBackgroundData found in scripts");
      return null;
    }

    const scores = data.avatarScores || {};

    // Find own avatar ID from page script
    let ownAvatarId = null;
    document.querySelectorAll("script").forEach((script) => {
      const m2 = script.textContent.match(/avatarId:\s*'(\d+)'/);
      if (m2) ownAvatarId = m2[1];
    });

    const islandId = data.islandId || data.id;
    const island = {
      id: islandId,
      name: data.islandName || data.name || "",
      x: parseInt(data.islandXCoord || data.xCoord || 0, 10),
      y: parseInt(data.islandYCoord || data.yCoord || 0, 10),
      tradegood: parseInt(data.tradegood || 0, 10),
      resourceLevel: parseInt(data.resourceLevel || 0, 10),
      tradegoodLevel: parseInt(data.tradegoodLevel || 0, 10),
      wonder: parseInt(data.wonder || 0, 10),
      wonderLevel: parseInt(data.wonderLevel || 0, 10),
      wonderName: data.wonderName || "",
      cities: [],
      timestamp: Date.now(),
    };

    // Parse city data — cities array has position implied by index
    const citiesRaw = data.cities || [];
    for (let i = 0; i < citiesRaw.length; i++) {
      const c = citiesRaw[i];
      if (!c || c.type === "buildplace") continue;
      const avatarId = String(c.ownerId || "");
      const scoreData = scores[avatarId] || {};

      // Score values have spaces as thousand separators (e.g. "650 946")
      const parseScore = (v) => parseInt(String(v || "0").replace(/\s/g, ""), 10) || 0;

      island.cities.push({
        id: parseInt(c.id || 0, 10),
        name: c.name || "",
        level: parseInt(c.level || 0, 10),
        position: i,
        ownerName: c.ownerName || "",
        ownerId: avatarId,
        allyId: String(c.ownerAllyId || "0"),
        allyTag: c.ownerAllyTag || "",
        state: c.state || "",
        isOwn: avatarId === ownAvatarId,
        scores: {
          place: parseScore(scoreData.place),
          building: Math.round(parseScore(scoreData.building_score_main) / 100),
          research: Math.round(parseScore(scoreData.research_score_main) / 100),
          army: Math.round(parseScore(scoreData.army_score_main) / 100),
          trader: Math.round(parseScore(scoreData.trader_score_secondary) / 100),
        },
      });
    }

    // Store
    const key = STORAGE_PREFIX + islandId;
    await chrome.storage.local.set({ [key]: island });
    console.log(TAG, `Stored island ${island.name} [${island.x}:${island.y}] — ${island.cities.length} cities`);

    // Update the alliance index for world map layer
    await updateAllianceIndex(island);

    // Enrich the world map data with alliance info from this island
    await enrichWorldMapData(island);

    return island;
  }

  // --- Alliance index: island coord → alliance counts ---
  async function updateAllianceIndex(island) {
    const data = await chrome.storage.local.get("allianceIndex");
    const index = data.allianceIndex || {};
    const key = `${island.x}:${island.y}`;

    // Count cities per alliance on this island
    const counts = {};
    for (const city of island.cities) {
      const tag = city.allyTag || "(none)";
      counts[tag] = (counts[tag] || 0) + 1;
    }
    index[key] = { counts, total: island.cities.length };

    await chrome.storage.local.set({ allianceIndex: index });
  }

  // Update the world map's island entry with alliance/city data from island view
  async function enrichWorldMapData(island) {
    // Find the world map storage key
    const indexData = await chrome.storage.local.get("mapIndex");
    const mapIndex = indexData.mapIndex || [];
    if (mapIndex.length === 0) return;

    // Use the first (most recent) map
    const mapEntry = mapIndex[0];
    const mapData = await chrome.storage.local.get(mapEntry.key);
    const worldMap = mapData[mapEntry.key];
    if (!worldMap || !worldMap.islands) return;

    // Find the matching world map island by coords
    const target = worldMap.islands.find(
      (i) => i.x === island.x && i.y === island.y
    );
    if (!target) return;

    // Compute dominant alliance for this island
    const allyCounts = {};
    for (const city of island.cities) {
      if (city.allyTag) {
        allyCounts[city.allyTag] = (allyCounts[city.allyTag] || 0) + 1;
      }
    }
    const sorted = Object.entries(allyCounts).sort((a, b) => b[1] - a[1]);

    // Store alliance summary on the world map island
    target.alliances = allyCounts;
    target.dominantAlly = sorted.length > 0 ? sorted[0][0] : "";
    target.cities = island.cities.length; // update city count too

    // Save back
    await chrome.storage.local.set({ [mapEntry.key]: worldMap });
    console.log(TAG, `Enriched world map [${island.x}:${island.y}] with alliance data`);
  }

  // --- Info panel overlay ---
  let panel = null;
  let currentSort = { key: "level", dir: -1 };
  let expanded = true;

  const TG_NAMES = ["", "Wine", "Marble", "Glass", "Sulfur"];
  const WONDER_NAMES = {
    1: "Hephaestus", 2: "Hades", 3: "Demeter", 4: "Athena",
    5: "Hermes", 6: "Ares", 7: "Poseidon", 8: "Colossus",
  };

  function createPanel(island) {
    if (panel) panel.remove();

    panel = document.createElement("div");
    panel.id = "ik-island-panel";
    Object.assign(panel.style, {
      position: "fixed",
      bottom: "12px",
      right: "80px",
      maxWidth: "380px",
      maxHeight: "calc(100vh - 80px)",
      overflowY: "auto",
      background: "rgba(10, 22, 40, 0.95)",
      borderRadius: "8px",
      border: "1px solid rgba(60, 90, 130, 0.5)",
      padding: "10px",
      zIndex: "99998",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "12px",
      color: "#c8cdd8",
      boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    });

    renderPanel(island);
    document.body.appendChild(panel);
  }

  function getAllianceSummary(island) {
    const counts = {};
    for (const city of island.cities) {
      const tag = city.allyTag || "(none)";
      counts[tag] = (counts[tag] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  function renderPanel(island) {
    if (!panel) return;
    const fmt = (n) => n >= 1000 ? Math.round(n / 1000) + "k" : n || "-";

    // --- Header (always visible) ---
    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <div>
          <b style="color:#e0e8f0;font-size:13px;">${island.name}</b>
          <span style="color:#556;"> [${island.x}:${island.y}]</span>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="ik-panel-btn" data-action="toggle" title="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '\u25BC' : '\u25B2'}</button>
        </div>
      </div>
      <div style="display:flex;gap:10px;color:#778;font-size:11px;margin-bottom:6px;">
        <span>Wood ${island.resourceLevel}</span>
        <span>${TG_NAMES[island.tradegood] || "?"} ${island.tradegoodLevel}</span>
        <span>${WONDER_NAMES[island.wonder] || "?"} ${island.wonderLevel}</span>
        <span style="margin-left:auto;">${island.cities.length} ${island.cities.length === 1 ? "city" : "cities"}</span>
      </div>
    `;

    // --- Alliance summary (always visible) ---
    {
      const alliances = getAllianceSummary(island);
      html += '<div style="border-top:1px solid #2a3040;padding-top:6px;">';
      for (const [tag, count] of alliances) {
        const pct = Math.round(count / island.cities.length * 100);
        const barW = pct;
        html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
          <span style="width:50px;color:#7ec8e3;font-size:11px;text-align:right;">${tag}</span>
          <div style="flex:1;height:6px;background:#1a2535;border-radius:3px;overflow:hidden;">
            <div style="width:${barW}%;height:100%;background:#3a7bd5;border-radius:3px;"></div>
          </div>
          <span style="color:#889;font-size:10px;width:30px;">${count}</span>
        </div>`;
      }
      html += '</div>';
    }

    // --- Expanded city list ---
    if (expanded) {
      const sorted = [...island.cities].sort((a, b) => {
        const k = currentSort.key;
        let va, vb;
        if (k === "name") { va = a.ownerName; vb = b.ownerName; }
        else if (k === "level") { va = a.level; vb = b.level; }
        else if (k === "alliance") { va = a.allyTag; vb = b.allyTag; }
        else { va = a.scores[k] || 0; vb = b.scores[k] || 0; }
        if (typeof va === "string") return currentSort.dir * va.localeCompare(vb);
        return currentSort.dir * (va - vb);
      });

      const cols = [
        { key: "name", label: "Player" },
        { key: "level", label: "Lv" },
        { key: "alliance", label: "Ally" },
        { key: "building", label: "Build" },
        { key: "research", label: "Res" },
        { key: "army", label: "Army" },
      ];

      html += `<table style="width:100%;border-collapse:collapse;font-size:11px;border-top:1px solid #2a3040;">
        <thead><tr style="color:#667;">`;
      for (const col of cols) {
        const arrow = currentSort.key === col.key ? (currentSort.dir > 0 ? "\u25B2" : "\u25BC") : "";
        html += `<th style="padding:3px 4px;text-align:left;cursor:pointer;white-space:nowrap;" data-sort="${col.key}">${col.label}<span style="display:inline-block;width:10px;text-align:center;font-size:8px;">${arrow}</span></th>`;
      }
      html += "</tr></thead><tbody>";

      for (const city of sorted) {
        const badge = city.state === "vacation" ? ' \ud83c\udf34' : city.state === "inactive" ? ' \ud83d\udca4' : '';
        const nameStyle = city.isOwn ? "color:#00FF88;font-weight:bold;" : city.state === "vacation" ? "color:#888;font-style:italic;" : city.state === "inactive" ? "color:#666;" : "color:#e0e8f0;";
        const rowBg = city.isOwn ? "background:rgba(0,255,136,0.06);" : "";
        html += `<tr class="ik-city-row" data-position="${city.position}" style="cursor:pointer;border-bottom:1px solid #1e2535;${rowBg}" title="Click to view ${city.name}">
          <td style="padding:3px 4px;${nameStyle}"><div>${city.ownerName}${badge}</div><div style="font-size:9px;color:#667;">${city.name}</div></td>
          <td style="padding:3px 4px;">${city.level}</td>
          <td style="padding:3px 4px;color:#7ec8e3;font-size:10px;">${city.allyTag || "-"}</td>
          <td style="padding:3px 4px;">${fmt(city.scores.building)}</td>
          <td style="padding:3px 4px;">${fmt(city.scores.research)}</td>
          <td style="padding:3px 4px;">${fmt(city.scores.army)}</td>
        </tr>`;
      }
      html += "</tbody></table>";
    }

    panel.innerHTML = html;

    panel.querySelectorAll(".ik-panel-btn").forEach((btn) => {
      Object.assign(btn.style, {
        padding: "2px 6px", border: "1px solid #2a3a55", borderRadius: "3px",
        background: "transparent", color: "#667", cursor: "pointer",
        fontSize: "10px", fontFamily: "sans-serif",
      });
    });

    // --- Event handlers ---
    panel.querySelector('[data-action="toggle"]').addEventListener("click", (e) => {
      e.stopPropagation();
      expanded = !expanded;
      renderPanel(island);
    });
    panel.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (currentSort.key === key) currentSort.dir *= -1;
        else { currentSort.key = key; currentSort.dir = -1; }
        renderPanel(island);
      });
    });

    panel.querySelectorAll(".ik-city-row").forEach((row) => {
      row.addEventListener("click", () => {
        const pos = row.dataset.position;
        const link = document.getElementById("js_cityLocation" + pos + "Link");
        if (link) link.click();
      });
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(42, 74, 106, 0.4)"; });
      row.addEventListener("mouseleave", () => { row.style.background = ""; });
    });
  }

  // --- Inject labels on island view (username + alliance under each city banner) ---
  function injectCityLabels(island) {
    for (const city of island.cities) {
      const scrollEl = document.getElementById("cityLocation" + city.position + "Scroll");
      if (!scrollEl) continue;
      if (scrollEl.querySelector(".ik-city-label")) continue;

      const label = document.createElement("div");
      label.className = "ik-city-label";

      const allyPart = city.allyTag ? `<span style="color:#7ec8e3;">[${city.allyTag}]</span> ` : "";
      const nameColor = city.isOwn ? "#00FF88" : "#dde";
      label.innerHTML = `${allyPart}<span style="color:${nameColor};">${city.ownerName}</span>`;

      Object.assign(label.style, {
        fontSize: "9px",
        background: "rgba(0,0,0,0.65)",
        padding: "1px 4px",
        borderRadius: "3px",
        whiteSpace: "nowrap",
        lineHeight: "12px",
        textAlign: "center",
        pointerEvents: "none",
        width: "max-content",
        margin: "2px auto 0",
      });

      scrollEl.appendChild(label);
    }
  }

  // --- Barbarian village: ships needed calculation ---
  const SHIP_CAPACITY = 500;
  const BARB_RESOURCE_IDS = [
    "js_islandBarbarianResourceresource",    // wood
    "js_islandBarbarianResourcetradegood1",  // wine
    "js_islandBarbarianResourcetradegood2",  // marble
    "js_islandBarbarianResourcetradegood3",  // crystal
    "js_islandBarbarianResourcetradegood4",  // sulfur
  ];

  function injectShipsNeeded() {
    const container = document.querySelector(".barbarianCityResources");
    if (!container) return;
    if (container.querySelector("#ik-ships-needed")) return;

    let totalGoods = 0;
    for (const id of BARB_RESOURCE_IDS) {
      const el = document.getElementById(id);
      if (el) totalGoods += parseInt(el.textContent.replace(/\s/g, ""), 10) || 0;
    }

    const ships = Math.ceil(totalGoods / SHIP_CAPACITY);
    const div = document.createElement("div");
    div.id = "ik-ships-needed";
    div.style.cssText = "padding:6px 4px; font-size:14px; background:transparent; margin-top:-18px;";
    div.innerHTML = `\u2693 Ships needed: ${ships} <span style="font-size:0.9em;opacity:0.7;">(${totalGoods.toLocaleString()} goods &divide; ${SHIP_CAPACITY})</span>`;
    // Insert after the info box, aligned to same horizontal position
    const infoBox = container.closest(".barbarianCityInfos");
    if (infoBox) {
      div.style.marginLeft = infoBox.offsetLeft + "px";
      infoBox.after(div);
    } else {
      container.after(div);
    }
    console.log(TAG, `Barbarian loot: ${totalGoods} goods, ${ships} ships needed`);
  }

  // --- Init ---
  async function init() {
    if (document.body.id !== "island") return;

    injectShipsNeeded();

    const island = await extractAndStore();
    if (island && island.cities.length > 0) {
      createPanel(island);
      injectCityLabels(island);
    }
  }

  // Run on island view
  init();

  // Watch for AJAX navigation to island view
  const obs = new MutationObserver(() => {
    if (document.body.id === "island") {
      // Re-init after a short delay for DOM to settle
      setTimeout(init, 500);
    } else if (panel) {
      panel.remove();
      panel = null;
    }
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ["id"] });

  // Watch for barbarian village content appearing (user clicks barbarian village)
  let barbTimer = null;
  const barbObs = new MutationObserver(() => {
    if (document.body.id !== "island") return;
    if (document.getElementById("ik-ships-needed")) return;
    if (barbTimer) return;
    barbTimer = setTimeout(() => {
      barbTimer = null;
      injectShipsNeeded();
    }, 300);
  });
  barbObs.observe(document.body, { childList: true, subtree: true });
})();

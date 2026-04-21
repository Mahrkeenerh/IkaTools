// Island info panel — passive data extraction, sortable player panel, alliance labels
(() => {
  const TAG = "[IslandInfo]";
  const OWN_COLOR = "#64B5F6"; // blue for own cities (matches game)
  const FRIEND_COLOR = "#00FF88"; // green for friends
  const PARTNER_COLOR = "#FFD700"; // gold for museum treaty partners
  let friendIds = new Set();
  let partnerIds = new Set();
  let initialized = false; // guard against duplicate init() calls
  let lastIslandId = null; // track current island to detect island-to-island navigation

  // World-scoped storage key helpers — all URL-based (stable across language settings)
  const worldName = IkUtils.getUrlWorldName() || "unknown";
  const STORAGE_PREFIX = "island_" + worldName + "_";
  const KEY_ALLIANCE_INDEX = "allianceIndex_" + worldName;
  const KEY_FRIEND_LIST = "friendList_" + worldName;
  const KEY_FRIEND_SLOTS = "friendSlots_" + worldName;
  const KEY_PARTNERS = "museumPartners_" + worldName;
  const FRIEND_CHECK_INTERVAL = 10_000; // 10s debounce for invalidation checks
  let friendCheckTimer = null;

  // Read visible friend slots (IDs are global: page1=1-6, page2=7-12, etc.)
  function readFriendSlots() {
    const container = document.querySelector("#js_viewFriends .friends");
    if (!container) return null;
    const snapshot = {}; // slotId -> playerId|null
    const names = {}; // playerId -> name
    for (const li of container.querySelectorAll("li[id^='js_friendlistSlot']")) {
      const slotId = li.id.replace("js_friendlistSlot", "");
      const a = li.classList.contains("expandable") && li.querySelector(".name a");
      if (a) {
        const m = a.href.match(/playerId=(\d+)/);
        if (m) {
          snapshot[slotId] = m[1];
          names[m[1]] = a.textContent.trim();
        }
      } else {
        snapshot[slotId] = null;
      }
    }
    return { snapshot, names };
  }

  // --- Scrape & cache friends from the sidebar list ---
  async function scrapeFriends() {
    const result = readFriendSlots();
    if (!result || Object.keys(result.names).length === 0) return;

    const data = await chrome.storage.local.get([KEY_FRIEND_LIST, KEY_FRIEND_SLOTS, "friendList"]);
    const stored = data[KEY_FRIEND_LIST] || data.friendList || {};
    const oldSlots = data[KEY_FRIEND_SLOTS] || {};
    const merged = { ...stored, ...result.names };
    // Merge visible slots into full snapshot (page 1 = slots 1-6, page 2 = 7-12, etc.)
    const allSlots = { ...oldSlots, ...result.snapshot };
    await chrome.storage.local.set({
      [KEY_FRIEND_LIST]: merged,
      [KEY_FRIEND_SLOTS]: allSlots,
    });
    friendIds = new Set(Object.keys(merged));
  }

  // Compare current visible slots against stored snapshot, remove unfriended players
  async function validateFriends() {
    const result = readFriendSlots();
    if (!result) return;

    const data = await chrome.storage.local.get([KEY_FRIEND_LIST, KEY_FRIEND_SLOTS, "friendList"]);
    const stored = data[KEY_FRIEND_LIST] || data.friendList || {};
    const oldSlots = data[KEY_FRIEND_SLOTS] || {};
    let changed = false;

    // Friends don't shift — if a slot was filled and is now empty, that friend was removed
    for (const [slot, curId] of Object.entries(result.snapshot)) {
      const oldId = oldSlots[slot];
      if (oldId && !curId) {
        delete stored[oldId];
        changed = true;
      }
    }

    // Add any newly visible friends
    for (const [id, name] of Object.entries(result.names)) {
      if (!stored[id]) {
        stored[id] = name;
        changed = true;
      }
    }

    const allSlots = { ...oldSlots, ...result.snapshot };
    if (changed) {
      await chrome.storage.local.set({
        [KEY_FRIEND_LIST]: stored,
        [KEY_FRIEND_SLOTS]: allSlots,
      });
      friendIds = new Set(Object.keys(stored));
    } else {
      await chrome.storage.local.set({ [KEY_FRIEND_SLOTS]: allSlots });
    }
  }

  // Debounced friend list validation — called when DOM changes
  function scheduleFriendCheck() {
    if (friendCheckTimer) return;
    friendCheckTimer = setTimeout(() => {
      friendCheckTimer = null;
      validateFriends();
    }, FRIEND_CHECK_INTERVAL);
  }

  async function loadFriends() {
    // Fall back to legacy global key if world-scoped key is empty
    const data = await chrome.storage.local.get([KEY_FRIEND_LIST, "friendList"]);
    friendIds = new Set(Object.keys(data[KEY_FRIEND_LIST] || data.friendList || {}));
  }

  async function loadPartners() {
    const data = await chrome.storage.local.get(KEY_PARTNERS);
    const list = data[KEY_PARTNERS] || [];
    partnerIds = new Set(list.map((p) => p.id));
  }

  // Extract updateBackgroundData from inline scripts — shared helper
  const parseBackgroundData = IkUtils.parseBackgroundData;

  // --- Store island data passively ---
  async function extractAndStore() {
    if (document.body.id !== "island") return;

    const data = parseBackgroundData();
    if (!data) return null;

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

    // Update the alliance index for world map layer
    await updateAllianceIndex(island);

    // Enrich the world map data with alliance info from this island
    await enrichWorldMapData(island);

    return island;
  }

  // --- Alliance index: island coord → { counts, members, total } ---
  // Schema must match background.js bgBuildIslandWrites — same key, same shape.
  async function updateAllianceIndex(island) {
    const data = await chrome.storage.local.get(KEY_ALLIANCE_INDEX);
    const index = data[KEY_ALLIANCE_INDEX] || {};
    const key = `${island.x}:${island.y}`;

    const counts = {};
    const members = {}; // tag -> array of unique ownerIds
    for (const city of island.cities) {
      const tag = city.allyTag || "(none)";
      counts[tag] = (counts[tag] || 0) + 1;
      const oid = String(city.ownerId || "");
      if (!oid) continue;
      if (!members[tag]) members[tag] = [];
      if (!members[tag].includes(oid)) members[tag].push(oid);
    }
    index[key] = { counts, members, total: island.cities.length };

    await chrome.storage.local.set({ [KEY_ALLIANCE_INDEX]: index });
  }

  // Update the world map's island entry with alliance/city data from island view
  async function enrichWorldMapData(island) {
    // Use the *current* world's map, not the most recent one in mapIndex —
    // a multi-world player can have several maps stored and mapIndex[0] could
    // point at a different world entirely.
    const mapKey = "map_" + worldName;
    const mapData = await chrome.storage.local.get(mapKey);
    const worldMap = mapData[mapKey];
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
    await chrome.storage.local.set({ [mapKey]: worldMap });
  }

  // --- Info panel overlay ---
  let panel = null;
  let currentSort = { key: "level", dir: -1 };
  let expanded = true;
  const KEY_PANEL_EXPANDED = "islandPanelExpanded";

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
    const fmt = (n) => {
      if (!n) return "-";
      if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "G";
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1e3) return Math.round(n / 1e3) + "k";
      return n;
    };

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
        const isFriend = !city.isOwn && friendIds.has(city.ownerId);
        const isPartner = !city.isOwn && partnerIds.has(city.ownerId);
        const nameStyle = city.isOwn ? `color:${OWN_COLOR};font-weight:bold;` : isFriend ? `color:${FRIEND_COLOR};font-weight:bold;` : isPartner ? `color:${PARTNER_COLOR};font-weight:bold;` : city.state === "vacation" ? "color:#888;font-style:italic;" : city.state === "inactive" ? "color:#666;" : "color:#e0e8f0;";
        const rowBg = "";
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
      chrome.storage.local.set({ [KEY_PANEL_EXPANDED]: expanded });
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

      const wrap = document.createElement("div");
      wrap.className = "ik-city-label";
      Object.assign(wrap.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "4px",
        margin: "2px auto 0",
        width: "max-content",
      });

      const label = document.createElement("div");

      const allyPart = city.allyTag ? `<span style="color:#7ec8e3;">[${city.allyTag}]</span> ` : "";
      const isFriend = !city.isOwn && friendIds.has(city.ownerId);
      const isPartner = !city.isOwn && partnerIds.has(city.ownerId);
      const nameColor = city.isOwn ? OWN_COLOR : isFriend ? FRIEND_COLOR : isPartner ? PARTNER_COLOR : "#dde";
      const nameBold = city.isOwn || isFriend || isPartner ? "font-weight:bold;" : "";
      label.innerHTML = `${allyPart}<span style="color:${nameColor};${nameBold}">${city.ownerName}</span>`;

      const labelBg = "rgba(0,0,0,0.85)";
      Object.assign(label.style, {
        fontSize: "9px",
        background: labelBg,
        padding: "1px 4px",
        borderRadius: "3px",
        whiteSpace: "nowrap",
        lineHeight: "12px",
        textAlign: "center",
        pointerEvents: "none",
      });

      const viewBtn = document.createElement("div");
      viewBtn.title = "View city";
      viewBtn.textContent = "\u{1F50D}";
      Object.assign(viewBtn.style, {
        fontSize: "18px",
        lineHeight: "18px",
        cursor: "pointer",
      });
      viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        window.location.href = "?view=city&cityId=" + city.id;
      });

      wrap.appendChild(label);
      wrap.appendChild(viewBtn);
      scrollEl.appendChild(wrap);
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
  }

  // --- Extract current island ID from URL query params ---
  function getCurrentIslandId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("islandId") || params.get("id") || null;
  }

  // --- Init ---
  async function init() {
    if (document.body.id !== "island") return;
    if (initialized) return;
    initialized = true;

    injectShipsNeeded();

    lastIslandId = getCurrentIslandId();

    const stored = await chrome.storage.local.get(KEY_PANEL_EXPANDED);
    if (stored[KEY_PANEL_EXPANDED] !== undefined) expanded = stored[KEY_PANEL_EXPANDED];

    const island = await extractAndStore();
    if (island && island.cities.length > 0) {
      createPanel(island);
      injectCityLabels(island);
    }
  }

  // Load cached friends + partners first, then scrape visible friends
  Promise.all([loadFriends(), loadPartners()]).then(() => {
    scrapeFriends();
    init();
  });

  // Watch for AJAX navigation to island view
  const obs = new MutationObserver(() => {
    if (document.body.id === "island") {
      // Detect island-to-island navigation: body.id stays "island" but the URL changes.
      // If the island ID in the URL has changed, reset the guard so init() re-runs.
      const currentId = getCurrentIslandId();
      if (initialized && currentId && currentId !== lastIslandId) {
        initialized = false;
        if (panel) {
          panel.remove();
          panel = null;
        }
      }
      // Re-init after a short delay for DOM to settle
      setTimeout(() => { scrapeFriends(); init(); }, 500);
    } else {
      initialized = false; // reset guard so init() runs again on next island visit
      if (panel) {
        panel.remove();
        panel = null;
      }
    }
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ["id"] });

  // Watch for friend list changes (unfriend, page scroll, new friend)
  const friendContainer = document.getElementById("js_viewFriends");
  if (friendContainer) {
    const friendObs = new MutationObserver(scheduleFriendCheck);
    friendObs.observe(friendContainer, { childList: true, subtree: true, attributes: true });
  }

  // Refresh panel when museum partners are saved/updated
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY_PARTNERS]) return;
    const list = changes[KEY_PARTNERS].newValue || [];
    partnerIds = new Set(list.map((p) => p.id));
    if (document.body.id === "island" && panel) {
      // Re-render panel + labels with updated partner highlights
      initialized = false;
      panel.remove();
      panel = null;
      init();
    }
  });

  // Watch for barbarian village content appearing (user clicks barbarian village).
  // Intentionally never disconnected — the body.id guard keeps it a no-op off island view.
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

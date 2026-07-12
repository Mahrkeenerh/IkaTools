// Island info panel — passive data extraction, sortable player panel, alliance labels
(() => {
  const TAG = "[IslandInfo]";
  const OWN_COLOR = "#64B5F6"; // blue for own cities (matches game)
  const FRIEND_COLOR = "#00FF88"; // green for friends
  const PARTNER_COLOR = "#FFD700"; // gold for museum treaty partners
  const TRADER_COLOR = "#E040FB"; // magenta for trade partners (don't attack!)
  const PIRATE_COLOR = "#FF7043"; // orange for saved piracy-leaderboard loot targets
  let friendIds = new Set();
  let partnerIds = new Set();
  let traderIds = new Set();
  let pirateCoefs = new Map(); // ownerId -> loot coefficient (booty multiplier); empty when toggle off
  let markIndex = null; // {byCityId: Map<cid, {state, ts}>} from CityMarks
  let initialized = false; // guard against duplicate init() calls
  let lastIslandId = null; // track current island to detect island-to-island navigation
  let currentIsland = null; // last extracted island, used by refreshLootedLabels

  // World-scoped storage key helpers — all URL-based (stable across language settings)
  const worldName = IkUtils.getUrlWorldName() || "unknown";
  const STORAGE_PREFIX = "island_" + worldName + "_";
  const KEY_ALLIANCE_INDEX = "allianceIndex_" + worldName;
  // friendSlots_{world}: slotId -> {id, name}. Slots are sticky (game never re-numbers),
  // so this single map is the source of truth — removed slots simply disappear.
  const KEY_FRIEND_SLOTS = "friendSlots_" + worldName;
  const KEY_FRIEND_LIST_LEGACY = "friendList_" + worldName; // deprecated, migrated on read
  const KEY_PARTNERS = "museumPartners_" + worldName;
  const KEY_TRADERS = "tradePartners_" + worldName;
  const KEY_PIRATES = "pirateTargets_" + worldName;
  // Per-avatar total score cache: { [avatarId]: { total, ts } }. Total comes from
  // the page-side `js_selectedCityScore` element when a player is selected on the
  // island view (passively scraped) or by fetching `?view=island&playerId=X`.
  const KEY_AVATAR_TOTALS = "avatarTotals_" + worldName;
  let avatarTotalsCache = {};
  const FRIEND_CHECK_INTERVAL = 10_000; // 10s debounce for invalidation checks
  let friendCheckTimer = null;
  let refreshingTotals = false;

  async function loadAvatarTotals() {
    const data = await chrome.storage.local.get(KEY_AVATAR_TOTALS);
    avatarTotalsCache = data[KEY_AVATAR_TOTALS] || {};
  }

  async function saveAvatarTotal(avatarId, total) {
    if (!avatarId || total == null) return;
    avatarTotalsCache[avatarId] = { total, ts: Date.now() };
    await chrome.storage.local.set({ [KEY_AVATAR_TOTALS]: avatarTotalsCache });
  }

  // The cityDetails endpoint renders the per-city sidebar (the same one
  // shown when the user clicks a city slot on the island), which carries
  // `js_selectedCityScore` = the city owner's overall score. We pick any
  // one foreign cityId per player on the island and parse from there.
  function extractPlayerTotal(text) {
    const m = text.match(/js_selectedCityScore[^>]*>\s*([\d\s.,]+?)\s*</);
    if (!m) return null;
    const n = parseInt(m[1].replace(/[\s.,]/g, ""), 10);
    return isNaN(n) || n < 0 ? null : n;
  }

  async function fetchTotalByCityId(cityId) {
    const base = location.origin + location.pathname;
    const url = base + "?view=cityDetails&destinationCityId=" + encodeURIComponent(cityId);
    try {
      const resp = await fetch(url, {
        credentials: "same-origin",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      const text = await resp.text();
      return extractPlayerTotal(text);
    } catch (e) {
      console.warn(TAG, "fetchTotalByCityId failed for", cityId, e);
      return null;
    }
  }

  // Read the currently-displayed selected-city score from the sidebar — fires
  // for free whenever the user naturally clicks a player on the island.
  function passiveScrapeSelectedTotal() {
    const scoreEl = document.getElementById("js_selectedCityScore");
    const ownerEl = document.getElementById("js_selectedCityOwnerName");
    if (!scoreEl || !ownerEl) return;
    const avatarMatch = (ownerEl.getAttribute("href") || "").match(/avatarId=(\d+)/);
    if (!avatarMatch) return;
    const avatarId = avatarMatch[1];
    const total = parseInt(scoreEl.textContent.replace(/[\s .,]/g, ""), 10);
    if (isNaN(total) || total < 0) return;
    if (avatarTotalsCache[avatarId]?.total === total) return; // unchanged
    saveAvatarTotal(avatarId, total);
    if (currentIsland && panel) renderPanel(currentIsland);
  }

  // Read visible friend slots from the sidebar.
  // Returns slotId -> {id, name} for filled slots, slotId -> null for visible-but-empty slots.
  // Only visible slots are present (the page shows ~6 at a time).
  function readVisibleSlots() {
    const container = document.querySelector("#js_viewFriends .friends");
    if (!container) return null;
    const slots = {};
    for (const li of container.querySelectorAll("li[id^='js_friendlistSlot']")) {
      const slotId = li.id.replace("js_friendlistSlot", "");
      const a = li.classList.contains("expandable") && li.querySelector(".name a");
      if (a) {
        const m = a.href.match(/playerId=(\d+)/);
        slots[slotId] = m ? { id: m[1], name: a.textContent.trim() } : null;
      } else {
        slots[slotId] = null;
      }
    }
    return slots;
  }

  // Load stored slot map, migrating from legacy {friendList, friendSlots-with-ids} shape if present.
  async function loadStoredSlots() {
    const data = await chrome.storage.local.get([KEY_FRIEND_SLOTS, KEY_FRIEND_LIST_LEGACY, "friendList"]);
    const raw = data[KEY_FRIEND_SLOTS] || {};
    const legacyNames = data[KEY_FRIEND_LIST_LEGACY] || data.friendList || {};
    let migrated = false;
    const slots = {};
    for (const [slot, val] of Object.entries(raw)) {
      if (val == null) continue;
      if (typeof val === "object" && val.id) {
        slots[slot] = { id: String(val.id), name: val.name || String(val.id) };
      } else {
        // Legacy: slot value was just the playerId
        const id = String(val);
        slots[slot] = { id, name: legacyNames[id] || id };
        migrated = true;
      }
    }
    if (migrated || data[KEY_FRIEND_LIST_LEGACY] != null) {
      await chrome.storage.local.set({ [KEY_FRIEND_SLOTS]: slots });
      await chrome.storage.local.remove(KEY_FRIEND_LIST_LEGACY);
    }
    return slots;
  }

  function deriveFriendIds(slots) {
    return new Set(Object.values(slots).map((s) => s.id));
  }

  // --- Scrape & cache visible friends ---
  async function scrapeFriends() {
    const visible = readVisibleSlots();
    if (!visible) return;
    const hasFilled = Object.values(visible).some((v) => v && v.id);
    if (!hasFilled) return;

    const slots = await loadStoredSlots();
    let changed = false;
    for (const [slot, val] of Object.entries(visible)) {
      if (!val) continue;
      const cur = slots[slot];
      if (!cur || cur.id !== val.id || cur.name !== val.name) {
        slots[slot] = val;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [KEY_FRIEND_SLOTS]: slots });
    friendIds = deriveFriendIds(slots);
  }

  // Compare visible slots against stored slots, drop slots that are now empty (unfriended).
  async function validateFriends() {
    const visible = readVisibleSlots();
    if (!visible) return;

    const slots = await loadStoredSlots();
    let changed = false;
    for (const [slot, val] of Object.entries(visible)) {
      if (val) {
        const cur = slots[slot];
        if (!cur || cur.id !== val.id || cur.name !== val.name) {
          slots[slot] = val;
          changed = true;
        }
      } else if (slots[slot]) {
        // Slot was filled, now visibly empty → that friend was removed (by us or them)
        delete slots[slot];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [KEY_FRIEND_SLOTS]: slots });
    friendIds = deriveFriendIds(slots);
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
    const slots = await loadStoredSlots();
    friendIds = deriveFriendIds(slots);
  }

  async function loadPartners() {
    const data = await chrome.storage.local.get(KEY_PARTNERS);
    const list = data[KEY_PARTNERS] || [];
    partnerIds = new Set(list.map((p) => p.id));
  }

  async function loadTraders() {
    const data = await chrome.storage.local.get(KEY_TRADERS);
    const map = data[KEY_TRADERS] || {};
    traderIds = new Set(Object.keys(map));
  }

  // Saved piracy-leaderboard loot targets -> ownerId:coef. The coefficient is
  // the booty multiplier when raiding that player (the indicator). Toggle-gated.
  async function loadPirates() {
    const data = await chrome.storage.local.get([KEY_PIRATES, "pirateTargetsEnabled"]);
    const on = data.pirateTargetsEnabled !== false; // default on
    pirateCoefs = new Map();
    if (on) {
      const map = data[KEY_PIRATES] || {};
      for (const id in map) pirateCoefs.set(id, map[id] && map[id].coef || 0);
    }
  }

  async function loadMarks() {
    if (globalThis.CityMarks) {
      await CityMarks.migrate(worldName);
      markIndex = await CityMarks.getIndex(worldName);
    } else {
      markIndex = { byCityId: new Map() };
    }
  }

  function getMark(cityId) {
    if (!markIndex || cityId == null) return null;
    return markIndex.byCityId.get(String(cityId)) || null;
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
          gold: parseScore(scoreData.trader_score_secondary),
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
  // Fetch totals for all unique foreign player avatars on this island.
  // Only invoked by the Refresh button — no automatic fetching to keep network
  // traffic explicit and user-controlled.
  async function refreshTotalsForIsland(island, force) {
    if (refreshingTotals) return;
    const TTL = 60 * 60 * 1000; // 1h
    const now = Date.now();
    // One representative cityId per player — cityDetails returns the owner's total,
    // so any of that player's cities will do.
    const cityByOwner = new Map();
    for (const c of island.cities) {
      if (!c.ownerId || c.isOwn) continue;
      if (!cityByOwner.has(c.ownerId)) cityByOwner.set(c.ownerId, c.id);
    }
    const toFetch = [...cityByOwner.entries()].filter(([avatarId]) => {
      if (force) return true;
      const c = avatarTotalsCache[avatarId];
      return !c || (now - c.ts) > TTL;
    });
    if (toFetch.length === 0) return;
    refreshingTotals = true;
    if (currentIsland && panel) renderPanel(currentIsland);
    try {
      const queue = toFetch.slice();
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length > 0) {
          const [avatarId, cityId] = queue.shift();
          const total = await fetchTotalByCityId(cityId);
          if (total != null) await saveAvatarTotal(avatarId, total);
        }
      });
      await Promise.all(workers);
    } finally {
      refreshingTotals = false;
      if (currentIsland && panel) renderPanel(currentIsland);
    }
  }

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
    // 1 decimal under 10 (e.g. 2.5k, 9.9k), no decimals from 10 up (25k, 999k, 1M+).
    const fmt = (n) => {
      if (!n) return "-";
      const fmtUnit = (v, suffix) => {
        if (v >= 10) return Math.round(v) + suffix;
        return v.toFixed(1).replace(/\.0$/, "") + suffix;
      };
      if (n >= 1e9) return fmtUnit(n / 1e9, "G");
      if (n >= 1e6) return fmtUnit(n / 1e6, "M");
      if (n >= 1e3) return fmtUnit(n / 1e3, "k");
      return String(n);
    };

    // Annotate cities with cached total + derived citizens (Total - B - R - A).
    for (const city of island.cities) {
      const cached = avatarTotalsCache[city.ownerId];
      if (cached && cached.total != null) {
        city.scores.total = cached.total;
        city.scores.citizens = Math.max(
          0,
          cached.total - city.scores.building - city.scores.research - city.scores.army
        );
      } else {
        city.scores.total = null;
        city.scores.citizens = null;
      }
    }

    // --- Header (always visible) ---
    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <div>
          <b style="color:#e0e8f0;font-size:13px;">${island.name}</b>
          <span style="color:#556;"> [${island.x}:${island.y}]</span>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="ik-panel-btn" data-action="refresh" title="Refresh player totals (fetches each unique player on this island)"${refreshingTotals ? ' disabled' : ''}>${refreshingTotals ? '\u23F3' : '\u21BB'}</button>
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

      const TINT_SCI = "rgba(80,140,220,0.10)";
      const TINT_ARMY = "rgba(220,80,80,0.10)";
      const TINT_GOLD = "rgba(220,180,60,0.12)";
      const cols = [
        { key: "name", label: "Player" },
        { key: "level", label: "Lv" },
        { key: "alliance", label: "Ally" },
        { key: "building", label: "Build" },
        { key: "research", label: "Sci", tint: TINT_SCI },
        { key: "army", label: "Army", tint: TINT_ARMY },
        { key: "gold", label: "Gold", tint: TINT_GOLD },
        { key: "citizens", label: "Citz" },
      ];

      html += `<table style="width:100%;border-collapse:collapse;font-size:11px;border-top:1px solid #2a3040;">
        <thead><tr style="color:#667;">`;
      for (const col of cols) {
        const arrow = currentSort.key === col.key ? (currentSort.dir > 0 ? "\u25B2" : "\u25BC") : "";
        const bg = col.tint ? `background:${col.tint};` : "";
        html += `<th style="padding:3px 4px;text-align:left;cursor:pointer;white-space:nowrap;${bg}" data-sort="${col.key}">${col.label}<span style="display:inline-block;width:10px;text-align:center;font-size:8px;">${arrow}</span></th>`;
      }
      html += "</tr></thead><tbody>";

      for (const city of sorted) {
        const badge = city.state === "vacation" ? ' \ud83c\udf34' : city.state === "inactive" ? ' \ud83d\udca4' : '';
        const isFriend = !city.isOwn && friendIds.has(city.ownerId);
        const isPartner = !city.isOwn && partnerIds.has(city.ownerId);
        const isTrader = !city.isOwn && !isFriend && !isPartner && traderIds.has(city.ownerId);
        // Loot badge shows for every saved target, even friends/partners/traders.
        const hasLoot = !city.isOwn && pirateCoefs.has(city.ownerId);
        // Pirate name-color only when no friendlier relationship claims it.
        const isPirate = hasLoot && !isFriend && !isPartner && !isTrader;
        const nameStyle = city.isOwn ? `color:${OWN_COLOR};font-weight:bold;` : isPartner ? `color:${PARTNER_COLOR};font-weight:bold;` : isFriend ? `color:${FRIEND_COLOR};font-weight:bold;` : isTrader ? `color:${TRADER_COLOR};font-weight:bold;` : isPirate ? `color:${PIRATE_COLOR};font-weight:bold;` : city.state === "vacation" ? "color:#888;font-style:italic;" : city.state === "inactive" ? "color:#666;" : "color:#e0e8f0;";
        const lootBadge = hasLoot ? ` <span style="color:${PIRATE_COLOR};font-size:9px;" title="Loot coefficient — booty multiplier when raided">🏴×${pirateCoefs.get(city.ownerId)}</span>` : "";
        const rowBg = "";
        html += `<tr class="ik-city-row" data-position="${city.position}" style="cursor:pointer;border-bottom:1px solid #1e2535;${rowBg}" title="Click to view ${city.name}">
          <td style="padding:3px 4px;${nameStyle}"><div>${city.ownerName}${badge}${lootBadge}</div><div style="font-size:9px;color:#667;">${city.name}</div></td>
          <td style="padding:3px 4px;">${city.level}</td>
          <td style="padding:3px 4px;color:#7ec8e3;font-size:10px;">${city.allyTag || "-"}</td>
          <td style="padding:3px 4px;">${fmt(city.scores.building)}</td>
          <td style="padding:3px 4px;background:${TINT_SCI};">${fmt(city.scores.research)}</td>
          <td style="padding:3px 4px;background:${TINT_ARMY};">${fmt(city.scores.army)}</td>
          <td style="padding:3px 4px;background:${TINT_GOLD};">${fmt(city.scores.gold)}</td>
          <td style="padding:3px 4px;">${city.scores.citizens != null ? fmt(city.scores.citizens) : '<span style="color:#556;">—</span>'}</td>
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
    panel.querySelector('[data-action="refresh"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (refreshingTotals) return;
      refreshTotalsForIsland(island, true);
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
    const islandCoords = island.x + ":" + island.y;
    for (const city of island.cities) {
      const scrollEl = document.getElementById("cityLocation" + city.position + "Scroll");
      if (!scrollEl) continue;
      if (scrollEl.querySelector(".ik-city-label")) continue;

      const wrap = document.createElement("div");
      wrap.className = "ik-city-label";
      Object.assign(wrap.style, {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "1px",
        margin: "2px auto 0",
        width: "max-content",
      });

      const row1 = document.createElement("div");
      Object.assign(row1.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "4px",
      });

      const label = document.createElement("div");

      const allyPart = city.allyTag ? `<span style="color:#7ec8e3;">[${city.allyTag}]</span> ` : "";
      const isFriend = !city.isOwn && friendIds.has(city.ownerId);
      const isPartner = !city.isOwn && partnerIds.has(city.ownerId);
      const isTrader = !city.isOwn && !isFriend && !isPartner && traderIds.has(city.ownerId);
      const hasLoot = !city.isOwn && pirateCoefs.has(city.ownerId);
      const isPirate = hasLoot && !isFriend && !isPartner && !isTrader;
      const nameColor = city.isOwn ? OWN_COLOR : isPartner ? PARTNER_COLOR : isFriend ? FRIEND_COLOR : isTrader ? TRADER_COLOR : isPirate ? PIRATE_COLOR : "#dde";
      const nameBold = city.isOwn || isFriend || isPartner || isTrader || isPirate ? "font-weight:bold;" : "";
      const lootBadge = hasLoot ? ` <span style="color:${PIRATE_COLOR};">🏴×${pirateCoefs.get(city.ownerId)}</span>` : "";
      label.innerHTML = `${allyPart}<span style="color:${nameColor};${nameBold}">${city.ownerName}</span>${lootBadge}`;

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

      row1.appendChild(label);
      wrap.appendChild(row1);

      // Second row — state badge (lootable / looted Xd ago / empty), only for
      // cities marked via CityMarks.
      const mark = getMark(city.id);
      if (mark && globalThis.CityMarks) {
        const style = CityMarks.getStyle(mark.state);
        if (style) {
          const markRow = document.createElement("div");
          markRow.className = "ik-mark-label";
          markRow.dataset.cityId = String(city.id);
          const text = mark.state === "looted"
            ? style.label + " " + CityMarks.formatAge(mark.ts)
            : style.label;
          markRow.textContent = style.icon + " " + text;
          markRow.title = style.label + (mark.ts ? " — " + new Date(mark.ts).toLocaleString() : "");
          Object.assign(markRow.style, {
            fontSize: "9px",
            color: style.color,
            background: "rgba(0,0,0,0.85)",
            padding: "1px 4px",
            borderRadius: "3px",
            whiteSpace: "nowrap",
            lineHeight: "12px",
            textAlign: "center",
            pointerEvents: "none",
            fontWeight: "bold",
          });
          wrap.appendChild(markRow);
        }
      }

      scrollEl.appendChild(wrap);
    }
  }

  // Re-inject city labels with up-to-date mark state. Called when CityMarks
  // changes (toggled from any surface: spy log, sidebar, battle report).
  async function refreshMarkLabels() {
    if (document.body.id !== "island" || !currentIsland) return;
    await loadMarks();
    // Strip existing labels and re-inject so mark state appears/disappears.
    document.querySelectorAll(".ik-city-label").forEach((el) => el.remove());
    injectCityLabels(currentIsland);
  }

  // --- Barbarian village: ships needed calculation ---
  // Cargo ship capacity is 500 + N*20 (Seafaring "Cargo bay" research), and is
  // a user-set, remembered parameter (global — capacity is per-account).
  const BARB_CAP_KEY = "barbShipCapacity";
  const BARB_CAP_BASE = 500;
  const BARB_CAP_STEP = 20;
  const BARB_CAP_MAX = 1500;
  let shipCapacity = BARB_CAP_BASE;
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
    // The div is inserted as a sibling of .barbarianCityInfos (outside the
    // container), so guard on the document, not the container subtree.
    if (document.getElementById("ik-ships-needed")) return;

    let totalGoods = 0;
    for (const id of BARB_RESOURCE_IDS) {
      const el = document.getElementById(id);
      if (el) totalGoods += parseInt(el.textContent.replace(/\s/g, ""), 10) || 0;
    }

    const ships = Math.ceil(totalGoods / shipCapacity);
    const div = document.createElement("div");
    div.id = "ik-ships-needed";
    div.style.cssText = "padding:6px 4px; font-size:14px; background:transparent; margin-top:-18px;";
    div.innerHTML = `\u2693 Ships needed: ${ships} <span style="font-size:0.9em;opacity:0.7;">(${totalGoods.toLocaleString()} goods &divide; ${shipCapacity})</span>`;
    // Insert after the info box, aligned to same horizontal position
    const infoBox = container.closest(".barbarianCityInfos");
    if (infoBox) {
      div.style.marginLeft = infoBox.offsetLeft + "px";
      infoBox.after(div);
    } else {
      container.after(div);
    }
  }

  // --- Barbarian village: always-present per-level ships lookup table ---
  // Goods = wood+wine+marble+crystal+sulphur (gold goes straight to the
  // treasury, not into cargo ships). Source: Ikariam wiki "Maximum resources
  // available to pillage", levels 1-19 (first row) and 20-39 (second row).
  // Shown as a wide strip so the current level's ship count is readable even
  // while the live resource counts (which drive injectShipsNeeded) are still
  // loading after a level switch.
  const BARB_GOODS_BY_LEVEL = [
    500, 575, 725, 950, 1250, 1625, 1995, 2500, 3100, 3880,
    4840, 5980, 7300, 8800, 10480, 12340, 14380, 16600, 19000,
  ];
  // Levels 20-39 (Fandom wiki "Barbarian Kings", goods = wood+wine+marble+
  // crystal+sulphur, gold excluded). Rendered as a second strip row.
  const BARB_GOODS_BY_LEVEL_20_39 = [
    21801, 25000, 28600, 32778, 37000, 41801, 47000, 52600, 58600, 65000,
    72300, 80203, 89600, 99600, 110500, 122300, 135000, 148600, 163100, 178500,
  ];

  function injectBarbLookup() {
    const speech = document.querySelector(".barbarianCityKingSpeech");
    if (!speech) return;

    let panel = document.getElementById("ik-barb-lookup");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "ik-barb-lookup";
      panel.style.cssText =
        "margin:6px 0 2px; padding:5px 6px; border:1px solid #cba85f; " +
        "border-radius:4px; background:rgba(255,248,225,0.55);";
      const title = document.createElement("div");
      title.style.cssText =
        "display:flex; align-items:center; gap:6px; flex-wrap:wrap; " +
        "font-size:11px; font-weight:bold; opacity:0.8; margin-bottom:4px;";
      const titleText = document.createElement("span");
      titleText.textContent = "⚓ Ships needed by barbarian level —";
      title.appendChild(titleText);
      // Cargo capacity selector (500 + N*20), remembered via storage.
      const capSel = document.createElement("select");
      capSel.style.cssText = "font-size:11px; padding:0 2px;";
      for (let cap = BARB_CAP_BASE; cap <= BARB_CAP_MAX; cap += BARB_CAP_STEP) {
        const opt = document.createElement("option");
        opt.value = cap;
        opt.textContent = cap + " cargo / ship";
        if (cap === shipCapacity) opt.selected = true;
        capSel.appendChild(opt);
      }
      capSel.addEventListener("change", () => {
        const v = parseInt(capSel.value, 10);
        if (isNaN(v)) return;
        shipCapacity = v;
        chrome.storage.local.set({ [BARB_CAP_KEY]: v });
        rebuildBarb();
      });
      title.appendChild(capSel);
      const buildRow = (goodsArr, startLevel) => {
        const grid = document.createElement("div");
        grid.style.cssText = "display:flex; flex-wrap:wrap; gap:2px; margin-bottom:2px;";
        goodsArr.forEach((goods, i) => {
          const lvl = startLevel + i;
          const ships = Math.ceil(goods / shipCapacity);
          const cell = document.createElement("div");
          cell.dataset.level = lvl;
          cell.title = `Level ${lvl}: ${goods.toLocaleString()} goods → ${ships} ships`;
          cell.style.cssText =
            "width:28px; text-align:center; padding:2px 0; border:1px solid #d9c79a; " +
            "border-radius:3px; background:#fffdf6; line-height:1.15;";
          cell.innerHTML =
            `<div style="font-size:10px; opacity:0.6;">${lvl}</div>` +
            `<div style="font-size:15px; font-weight:bold;">${ships}</div>`;
          grid.appendChild(cell);
        });
        return grid;
      };
      panel.appendChild(title);
      // Level 0 (0 goods → 0 ships) prefixes the first row so it spans 0-19,
      // aligning column-for-column with the 20-39 row below it.
      panel.appendChild(buildRow([0, ...BARB_GOODS_BY_LEVEL], 0));
      panel.appendChild(buildRow(BARB_GOODS_BY_LEVEL_20_39, 20));
      speech.after(panel);
    }

    // Highlight the current level (read fresh each call so it tracks level
    // changes). Levels above the table (40+) simply leave nothing highlighted.
    const lvlEl = document.getElementById("js_islandBarbarianLevel");
    const cur = lvlEl ? parseInt(lvlEl.textContent.replace(/\D/g, ""), 10) : NaN;
    panel.querySelectorAll("[data-level]").forEach((cell) => {
      const on = parseInt(cell.dataset.level, 10) === cur;
      cell.style.background = on ? "#ffe082" : "#fffdf6";
      cell.style.borderColor = on ? "#e6a817" : "#d9c79a";
      cell.style.boxShadow = on ? "0 0 0 1px #e6a817" : "none";
    });
  }

  // Remove the injected barbarian widgets and rebuild them with the current
  // ship capacity (called after the capacity selector changes or storage syncs).
  function rebuildBarb() {
    const sn = document.getElementById("ik-ships-needed");
    if (sn) sn.remove();
    const lp = document.getElementById("ik-barb-lookup");
    if (lp) lp.remove();
    injectShipsNeeded();
    injectBarbLookup();
  }

  // Load the remembered cargo capacity; rebuild if the barb view is already up.
  chrome.storage.local.get(BARB_CAP_KEY, (res) => {
    const v = parseInt(res[BARB_CAP_KEY], 10);
    if (!isNaN(v) && v >= BARB_CAP_BASE) shipCapacity = v;
    if (document.getElementById("ik-barb-lookup") || document.getElementById("ik-ships-needed")) {
      rebuildBarb();
    }
  });

  // --- Extract current island ID from URL query params ---
  function getCurrentIslandId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("islandId") || params.get("id") || null;
  }

  // --- Inject "Target:" row with mark widget into the selected-city sidebar ---
  // Sidebar layout (island view, after clicking a non-own city):
  //   #sidebar .sidebar_cityDetails table.cityinfo
  //     <tr> rows for name / title / player / ally / score / spies
  // We add a new <tr> after the active-spies row, bound to the cityId we can
  // read from the city's action links (espionage / transport).
  // Pull the cityId of the city currently shown in the sidebar. Foreign-city
  // sidebars have it on the espionage/transport action links; own-city
  // sidebars hide those links and only expose it via the selected map tile's
  // `saved-href` attribute.
  function readSelectedCityId() {
    const re = /destinationCityId=(\d+)/;
    const tryHref = (el) => {
      if (!el) return null;
      const h = el.getAttribute("href") || el.getAttribute("saved-href") || "";
      const m = h.match(re);
      return m ? m[1] : null;
    };
    return tryHref(document.querySelector("#js_selectedCityAction3Link"))
      || tryHref(document.querySelector("#js_selectedCityAction2Link"))
      || tryHref(document.querySelector('[id^="cityLocation"].selected[saved-href]'));
  }

  // Owner avatarId + name of the city currently shown in the sidebar — used for
  // the per-player "ignoring CT offers" toggle (CtIgnored is keyed by avatarId).
  function readSelectedOwner() {
    const el = document.getElementById("js_selectedCityOwnerName");
    if (!el) return null;
    const m = (el.getAttribute("href") || "").match(/avatarId=(\d+)/);
    if (!m) return null;
    return { id: m[1], name: el.textContent.trim() };
  }

  async function injectSidebarMark() {
    if (document.body.id !== "island") return;
    const table = document.querySelector("#sidebar .sidebar_cityDetails table.cityinfo");
    if (!table) return;
    if (table.querySelector(".ik-sidebar-mark-row")) return;

    const cityId = readSelectedCityId();
    if (!cityId) return;

    // Own cities can't be targets. Only show the widget if a stale mark
    // already exists (so the user can clear it); the widget will hide itself
    // again once the mark is removed.
    const own = IkUtils.getOwnCityIds();
    const isOwn = own && own.has(cityId);
    let existingMark = null;
    if (globalThis.CityMarks) {
      existingMark = await CityMarks.get(cityId);
    }
    if (isOwn && !existingMark) return;

    const tr = document.createElement("tr");
    tr.className = "ik-sidebar-mark-row alt";
    tr.dataset.cityId = cityId;
    if (isOwn) tr.dataset.ownCity = "1";
    const labelTd = document.createElement("td");
    labelTd.className = "nameValue";
    labelTd.innerHTML = isOwn
      ? '<span title="Own city — clear the stale mark">Clear mark:</span>'
      : "<span>Target:</span>";
    const widgetTd = document.createElement("td");
    widgetTd.colSpan = 3;
    if (globalThis.CityMarks) {
      const onChange = (newState) => {
        // Once the user clears a mark on their own city, hide the row so the
        // widget can't be re-used to set a new (invalid) mark.
        if (isOwn && newState == null) tr.remove();
      };
      widgetTd.appendChild(CityMarks.createWidget(cityId, { compact: true, onChange }));
    }
    // Per-player "ignoring CT offers" toggle — sits next to the city marks but
    // is keyed by the owner's avatarId, not the cityId. Foreign cities only.
    if (!isOwn && globalThis.CtIgnored) {
      const owner = readSelectedOwner();
      if (owner) {
        const sep = document.createElement("span");
        sep.style.cssText = "display:inline-block;width:8px;";
        widgetTd.appendChild(sep);
        widgetTd.appendChild(CtIgnored.createButton(owner.id, { name: owner.name, compact: true }));
      }
    }
    tr.appendChild(labelTd);
    tr.appendChild(widgetTd);

    // Insert after the active-spies row when present, else append.
    const spiesRow = table.querySelector("#js_selectedCityActiveSpies");
    if (spiesRow && spiesRow.parentNode) {
      spiesRow.parentNode.insertBefore(tr, spiesRow.nextSibling);
    } else {
      const tbody = table.querySelector("tbody") || table;
      tbody.appendChild(tr);
    }
  }

  // Re-inject the sidebar widget only when the selected city has actually
  // changed. The game's DOM churns a lot (walkers, animations) so a no-op
  // path is important.
  let lastSidebarCityId = null;
  function refreshSidebarMark() {
    if (document.body.id !== "island") { lastSidebarCityId = null; return; }
    const curId = readSelectedCityId();
    if (curId === lastSidebarCityId && document.querySelector(".ik-sidebar-mark-row")) return;
    lastSidebarCityId = curId;
    document.querySelectorAll(".ik-sidebar-mark-row").forEach((el) => el.remove());
    if (curId) injectSidebarMark();
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

    await loadMarks();
    await loadAvatarTotals();

    const island = await extractAndStore();
    currentIsland = island;
    if (island && island.cities.length > 0) {
      createPanel(island);
      injectCityLabels(island);
    }
    injectSidebarMark();
    // Grab the selected-city total if a player happens to be selected already.
    passiveScrapeSelectedTotal();
  }

  // Load cached friends + partners + traders + marks + avatar totals first
  Promise.all([loadFriends(), loadPartners(), loadTraders(), loadPirates(), loadMarks(), loadAvatarTotals()]).then(() => {
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
        currentIsland = null; // stale — refreshLootedLabels would re-inject old data
        if (panel) {
          panel.remove();
          panel = null;
        }
      }
      // Re-init after a short delay for DOM to settle
      setTimeout(() => { scrapeFriends(); init(); }, 500);
    } else {
      initialized = false; // reset guard so init() runs again on next island visit
      currentIsland = null;
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

  // Watch the sidebar for selected-city changes — the game rebuilds the
  // cityinfo table whenever the user clicks a different city slot.
  let sidebarDebounce = null;
  const sidebarObs = new MutationObserver(() => {
    if (document.body.id !== "island") return;
    if (sidebarDebounce) return;
    sidebarDebounce = setTimeout(() => {
      sidebarDebounce = null;
      refreshSidebarMark();
      passiveScrapeSelectedTotal();
    }, 80);
  });
  sidebarObs.observe(document.body, { childList: true, subtree: true });

  // Refresh panel when museum partners are saved/updated
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEY_PARTNERS]) {
      const list = changes[KEY_PARTNERS].newValue || [];
      partnerIds = new Set(list.map((p) => p.id));
      if (document.body.id === "island" && panel) {
        // Re-render panel + labels with updated partner highlights
        initialized = false;
        panel.remove();
        panel = null;
        init();
      }
    }
    if (changes[KEY_TRADERS]) {
      const map = changes[KEY_TRADERS].newValue || {};
      traderIds = new Set(Object.keys(map));
      if (document.body.id === "island" && panel) {
        initialized = false;
        panel.remove();
        panel = null;
        init();
      }
    }
    if (changes[KEY_PIRATES] || changes.pirateTargetsEnabled) {
      loadPirates().then(() => {
        if (document.body.id === "island" && panel) {
          initialized = false;
          panel.remove();
          panel = null;
          init();
        }
      });
    }
    if (changes["cityMarks_" + worldName]) {
      refreshMarkLabels();
    }
    if (changes[BARB_CAP_KEY]) {
      const v = parseInt(changes[BARB_CAP_KEY].newValue, 10);
      if (!isNaN(v) && v >= BARB_CAP_BASE && v !== shipCapacity) {
        shipCapacity = v;
        if (document.getElementById("ik-barb-lookup") || document.getElementById("ik-ships-needed")) {
          rebuildBarb();
        }
      }
    }
  });


  // Watch for barbarian village content appearing (user clicks barbarian village).
  // Intentionally never disconnected — the body.id guard keeps it a no-op off island view.
  let barbTimer = null;
  const barbObs = new MutationObserver(() => {
    if (document.body.id !== "island") return;
    if (barbTimer) return;
    barbTimer = setTimeout(() => {
      barbTimer = null;
      injectShipsNeeded();
      // Re-run every batch (no early-out): the lookup panel re-injects after a
      // village re-render and keeps the current-level highlight in sync.
      injectBarbLookup();
    }, 300);
  });
  barbObs.observe(document.body, { childList: true, subtree: true });
})();

// Trade partner detection — passively scrapes militaryAdvisor (live fleet
// movements) and tradeAdvisor "Novinky z měst" (news feed) to record players
// who trade with our cities, so we don't accidentally attack them.
//
// Storage: tradePartners_{world} — keyed by avatarId
//   { name, lastTradeAt, tradeCount, cities: { [cityId]: cityName }, lastSource }
//
// militaryAdvisor: rows with `<div class="mission_icon trade">` carry both
// player names + cityIds in source/target spans — fully resolved synchronously.
//
// tradeAdvisor: news feed rows carry only foreign cityIds. We resolve each
// cityId via the cached `island_{world}_*` records (built by islandinfo.js
// and the full-scan pipeline). Unresolved cityIds are remembered so a future
// island visit can backfill them; we don't fire extra requests on the user's
// behalf to keep this purely passive.
(() => {
  const TAG = "[TradeDetect]";
  const worldName = IkUtils.getUrlWorldName() || "unknown";
  const KEY_TRADERS = "tradePartners_" + worldName;
  const KEY_PENDING = "tradePartnersPending_" + worldName;

  const ISLAND_PREFIX = "island_" + worldName + "_";

  let ownCityIds = null;            // Set<string> — our cityIds, refreshed on demand
  let ownAvatarId = null;           // string — our avatarId
  let cityIdIndex = null;           // Map<cityId, {avatarId, avatarName, cityName, islandId}>
  let scanDebounce = null;
  // Per-row dedup. Each scanner builds a stable key from row identity
  // (date + foreign cityId for tradeAdvisor; eventId for militaryAdvisor)
  // so paginating or re-scanning never double-counts the same trade.
  const processedRows = new Set();
  const PROCESSED_ROWS_CAP = 5000;  // hard cap to bound memory across long sessions
  const inFlightFetches = new Map(); // cityId -> Promise (dedup concurrent fetches)
  const FETCH_GAP_MS = 1500;        // throttle gap between sequential resolves
  let lastFetchAt = 0;

  function rememberRow(key) {
    if (processedRows.size >= PROCESSED_ROWS_CAP) {
      // Drop the oldest insertion — Sets preserve insertion order.
      const it = processedRows.values().next();
      if (!it.done) processedRows.delete(it.value);
    }
    processedRows.add(key);
  }

  // Build a single cityIdIndex entry from an island record + city.
  function indexEntryFromCity(island, city) {
    return {
      avatarId: String(city.ownerId || ""),
      avatarName: city.ownerName || "",
      cityName: city.name || "",
      islandId: island.id,
    };
  }

  // ---------- helpers ----------

  function readOwnAvatarId() {
    if (ownAvatarId) return ownAvatarId;
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const m = s.textContent.match(/avatarId:\s*['"](\d+)['"]/);
      if (m) { ownAvatarId = m[1]; return ownAvatarId; }
    }
    return null;
  }

  async function readOwnCityIds() {
    if (ownCityIds) return ownCityIds;
    // Game dropdown is the most reliable source — populated even when bridge isn't ready.
    const ids = new Set();
    document.querySelectorAll("#dropDown_js_citySelectContainer li[selectvalue]").forEach((li) => {
      const v = li.getAttribute("selectvalue");
      if (v) ids.add(String(v));
    });
    if (ids.size > 0) { ownCityIds = ids; return ownCityIds; }
    // Fallback to bridge
    try {
      const cities = await IkUtils.getCities();
      for (const c of cities) ids.add(String(c.id));
    } catch (e) {}
    ownCityIds = ids;
    return ownCityIds;
  }

  // Build a cityId → owner index from cached island records (lazy, in-memory).
  // The set of stored islands grows as the user explores, so we rebuild on demand
  // rather than caching forever.
  async function buildCityIdIndex() {
    const all = await chrome.storage.local.get(null);
    const idx = new Map();
    for (const key of Object.keys(all)) {
      if (!key.startsWith(ISLAND_PREFIX)) continue;
      const island = all[key];
      if (!island || !Array.isArray(island.cities)) continue;
      for (const city of island.cities) {
        if (!city || !city.id) continue;
        idx.set(String(city.id), indexEntryFromCity(island, city));
      }
    }
    cityIdIndex = idx;
    return idx;
  }

  async function lookupCityId(cityId) {
    if (!cityIdIndex) await buildCityIdIndex();
    return cityIdIndex.get(String(cityId)) || null;
  }

  // Fetch `?view=island&cityId=X` via the game's AJAX endpoint, parse the
  // updateBackgroundData payload, store it as a regular island_{world}_{id}
  // record so islandinfo.js's enrichment also benefits. Returns the resolved
  // cityId entry (same shape as cityIdIndex values), or null on failure.
  async function fetchAndCacheIsland(cityId) {
    cityId = String(cityId);
    if (inFlightFetches.has(cityId)) return inFlightFetches.get(cityId);

    const wait = Math.max(0, FETCH_GAP_MS - (Date.now() - lastFetchAt));
    const p = (async () => {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastFetchAt = Date.now();
      try {
        const url = "/?view=island&cityId=" + encodeURIComponent(cityId) + "&ajax=1";
        const resp = await fetch(url, {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        const text = await resp.text();
        const island = parseIslandFromAjax(text);
        if (!island) return null;
        const key = ISLAND_PREFIX + island.id;
        await chrome.storage.local.set({ [key]: island });
        // onChanged listener will rebuild the index, but we also seed it now
        // so the immediate resolveTraders() call sees the new entries.
        if (cityIdIndex) {
          for (const c of island.cities) {
            if (!c || !c.id) continue;
            cityIdIndex.set(String(c.id), indexEntryFromCity(island, c));
          }
        }
        return cityIdIndex ? cityIdIndex.get(cityId) || null : null;
      } catch (err) {
        console.warn(TAG, "fetch failed for cityId", cityId, err);
        return null;
      } finally {
        inFlightFetches.delete(cityId);
      }
    })();
    inFlightFetches.set(cityId, p);
    return p;
  }

  // Parse the AJAX response body for `["updateBackgroundData", {…}]` and
  // shape it into an island record matching islandinfo.js's storage format.
  function parseIslandFromAjax(text) {
    const marker = '"updateBackgroundData"';
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    const objStart = text.indexOf("{", idx + marker.length);
    if (objStart === -1) return null;
    let depth = 0;
    let objEnd = -1;
    for (let i = objStart; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { objEnd = i + 1; break; }
      }
    }
    if (objEnd === -1) return null;

    let bg;
    try { bg = JSON.parse(text.substring(objStart, objEnd)); }
    catch (e) { return null; }

    const islandId = bg.islandId || bg.id;
    if (!islandId) return null;
    const parseScore = (v) => parseInt(String(v || "0").replace(/\s/g, ""), 10) || 0;
    const scores = bg.avatarScores || {};

    const island = {
      id: islandId,
      name: bg.islandName || bg.name || "",
      x: parseInt(bg.islandXCoord || bg.xCoord || 0, 10),
      y: parseInt(bg.islandYCoord || bg.yCoord || 0, 10),
      tradegood: parseInt(bg.tradegood || 0, 10),
      resourceLevel: parseInt(bg.resourceLevel || 0, 10),
      tradegoodLevel: parseInt(bg.tradegoodLevel || 0, 10),
      wonder: parseInt(bg.wonder || 0, 10),
      wonderLevel: parseInt(bg.wonderLevel || 0, 10),
      wonderName: bg.wonderName || "",
      cities: [],
      timestamp: Date.now(),
    };

    const citiesRaw = bg.cities || [];
    for (let i = 0; i < citiesRaw.length; i++) {
      const c = citiesRaw[i];
      if (!c || c.type === "buildplace") continue;
      const aid = String(c.ownerId || "");
      const sc = scores[aid] || {};
      island.cities.push({
        id: parseInt(c.id || 0, 10),
        name: c.name || "",
        level: parseInt(c.level || 0, 10),
        position: i,
        ownerName: c.ownerName || "",
        ownerId: aid,
        allyId: String(c.ownerAllyId || "0"),
        allyTag: c.ownerAllyTag || "",
        state: c.state || "",
        isOwn: aid === ownAvatarId,
        scores: {
          place: parseScore(sc.place),
          building: Math.round(parseScore(sc.building_score_main) / 100),
          research: Math.round(parseScore(sc.research_score_main) / 100),
          army: Math.round(parseScore(sc.army_score_main) / 100),
          trader: Math.round(parseScore(sc.trader_score_secondary) / 100),
        },
      });
    }
    return island;
  }

  // ---------- storage merge ----------

  async function recordTraders(events) {
    if (!events || events.length === 0) return;

    const data = await chrome.storage.local.get([KEY_TRADERS, KEY_PENDING]);
    const traders = data[KEY_TRADERS] || {};
    const pending = data[KEY_PENDING] || {};
    const now = Date.now();
    let changed = false;

    for (const ev of events) {
      if (ev.avatarId) {
        const aid = String(ev.avatarId);
        const cur = traders[aid] || { name: ev.avatarName || "", tradeCount: 0, cities: {}, lastTradeAt: 0, lastSource: "" };
        if (ev.avatarName) cur.name = ev.avatarName;
        if (ev.cityId) cur.cities[String(ev.cityId)] = ev.cityName || cur.cities[String(ev.cityId)] || "";
        if (now > (cur.lastTradeAt || 0)) cur.lastTradeAt = now;
        cur.tradeCount = (cur.tradeCount || 0) + 1;
        cur.lastSource = ev.source || cur.lastSource;
        traders[aid] = cur;
        changed = true;
        // Resolved — clear any pending entry for that cityId
        if (ev.cityId && pending[String(ev.cityId)]) {
          delete pending[String(ev.cityId)];
          changed = true;
        }
      } else if (ev.cityId) {
        // No avatarId yet — try cache one more time (the index might have been
        // built since the event was queued)
        const hit = await lookupCityId(ev.cityId);
        if (hit && hit.avatarId) {
          const aid = hit.avatarId;
          const cur = traders[aid] || { name: hit.avatarName || "", tradeCount: 0, cities: {}, lastTradeAt: 0, lastSource: "" };
          cur.name = hit.avatarName || cur.name;
          cur.cities[String(ev.cityId)] = hit.cityName || cur.cities[String(ev.cityId)] || "";
          if (now > (cur.lastTradeAt || 0)) cur.lastTradeAt = now;
          cur.tradeCount = (cur.tradeCount || 0) + 1;
          cur.lastSource = ev.source || cur.lastSource;
          traders[aid] = cur;
          changed = true;
        } else {
          // Stash for later resolution
          const p = pending[String(ev.cityId)] || { firstSeen: now, count: 0, source: ev.source || "" };
          p.lastSeen = now;
          p.count = (p.count || 0) + 1;
          if (ev.source) p.source = ev.source;
          pending[String(ev.cityId)] = p;
          changed = true;
        }
      }
    }

    if (changed) {
      const writes = { [KEY_TRADERS]: traders };
      if (Object.keys(pending).length > 0 || data[KEY_PENDING]) writes[KEY_PENDING] = pending;
      await chrome.storage.local.set(writes);
    }
  }

  // Try to resolve any pending cityIds against the (possibly newly-populated)
  // cityId index. Called after the index is updated — e.g. after islandinfo.js
  // stores a fresh island. Assumes cityIdIndex is already current; no rebuild here.
  async function resolvePending() {
    const data = await chrome.storage.local.get([KEY_PENDING, KEY_TRADERS]);
    const pending = data[KEY_PENDING] || {};
    if (Object.keys(pending).length === 0) return;
    const traders = data[KEY_TRADERS] || {};

    if (!cityIdIndex) await buildCityIdIndex();

    let changed = false;
    for (const cityId of Object.keys(pending)) {
      const hit = cityIdIndex.get(cityId);
      if (!hit || !hit.avatarId) continue;
      const aid = hit.avatarId;
      const p = pending[cityId];
      const cur = traders[aid] || { name: hit.avatarName || "", tradeCount: 0, cities: {}, lastTradeAt: 0, lastSource: "" };
      cur.name = hit.avatarName || cur.name;
      cur.cities[cityId] = hit.cityName || cur.cities[cityId] || "";
      if ((p.lastSeen || 0) > (cur.lastTradeAt || 0)) cur.lastTradeAt = p.lastSeen;
      cur.tradeCount = (cur.tradeCount || 0) + (p.count || 1);
      if (p.source) cur.lastSource = p.source;
      traders[aid] = cur;
      delete pending[cityId];
      changed = true;
    }
    if (changed) {
      await chrome.storage.local.set({ [KEY_TRADERS]: traders, [KEY_PENDING]: pending });
    }
  }

  // ---------- militaryAdvisor scraping ----------

  // Pull cityId from a `<a href="?...cityId=N">` element
  function cityIdFromLink(a) {
    if (!a) return null;
    const m = (a.getAttribute("href") || "").match(/cityId=(\d+)/);
    return m ? m[1] : null;
  }

  // td.source / td.target structure:
  //   <a class="short_text..." href="?...cityId=N">CityName</a>
  //   <span title="PlayerName">(PlayerName)</span>
  function extractParty(td) {
    if (!td) return null;
    const a = td.querySelector("a[href*='cityId=']");
    const span = td.querySelector("span[title]");
    if (!a) return null;
    const cityId = cityIdFromLink(a);
    if (!cityId) return null;
    const cityName = (a.getAttribute("title") || a.textContent || "").trim();
    const playerName = span ? (span.getAttribute("title") || "").trim() : "";
    return { cityId, cityName, playerName };
  }

  // Read the game's eventId for a fleet movement row — present as an id on
  // either the spy magnify icon (`fleetInfo<id>`) or the abort link href.
  function readEventId(row) {
    const tip = row.querySelector("[id^='fleetInfo']");
    if (tip) {
      const m = tip.id.match(/^fleetInfo(\d+)/);
      if (m) return m[1];
    }
    const abort = row.querySelector("a[href*='eventId=']");
    if (abort) {
      const m = (abort.getAttribute("href") || "").match(/eventId=(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  async function scanMilitaryAdvisor(table) {
    const ourIds = await readOwnCityIds();
    const events = [];
    for (const row of table.querySelectorAll("tr")) {
      const ico = row.querySelector("td .mission_icon.trade");
      if (!ico) continue; // not a trade mission

      const src = extractParty(row.querySelector("td.source"));
      const tgt = extractParty(row.querySelector("td.target"));
      if (!src && !tgt) continue;

      // Pick the foreign side. If both are foreign or both are ours, skip.
      const srcOurs = src && ourIds.has(String(src.cityId));
      const tgtOurs = tgt && ourIds.has(String(tgt.cityId));
      let foreign = null;
      if (src && !srcOurs && tgt && tgtOurs) foreign = src;
      else if (tgt && !tgtOurs && src && srcOurs) foreign = tgt;
      if (!foreign) continue;
      if (!foreign.playerName) continue; // no usable identity

      // Per-row dedup key. Prefer the game's eventId; fall back to
      // (cityId+playerName) which is stable for the lifetime of this row.
      const evId = readEventId(row);
      const rowKey = "mil:" + (evId || (foreign.cityId + "|" + foreign.playerName));
      if (processedRows.has(rowKey)) continue;
      rememberRow(rowKey);

      // Resolve avatarId via cached islands (player name alone isn't unique).
      // Fall back to AJAX fetch when missing — we want a stable avatarId key.
      let hit = await lookupCityId(foreign.cityId);
      if (!hit || !hit.avatarId) hit = await fetchAndCacheIsland(foreign.cityId);
      events.push({
        avatarId: hit ? hit.avatarId : null,
        avatarName: (hit && hit.avatarName) || foreign.playerName,
        cityId: foreign.cityId,
        cityName: (hit && hit.cityName) || foreign.cityName,
        source: "militaryAdvisor",
      });
    }
    if (events.length > 0) await recordTraders(events);
  }

  // ---------- tradeAdvisor (news feed) scraping ----------

  // A market-trade event has `<br>` inside `<ul class="resources">` — that
  // separates the per-resource price-per-unit pairs (resource + gold). Plain
  // transports + plunder lack the `<br>` and the gold icon.
  function isMarketTradeRow(subjectTd) {
    return !!subjectTd.querySelector("ul.resources br");
  }

  async function scanTradeAdvisor(table) {
    const ourIds = await readOwnCityIds();
    const events = [];
    for (const row of table.querySelectorAll("tr")) {
      const subj = row.querySelector("td.subject");
      if (!subj) continue;
      if (!isMarketTradeRow(subj)) continue;

      // Two cityId links: typically one ours + one foreign
      const links = subj.querySelectorAll("a[href*='cityId=']");
      if (links.length < 2) continue;
      let foreignCityId = null;
      let foreignCityName = "";
      for (const a of links) {
        const cid = cityIdFromLink(a);
        if (!cid) continue;
        if (ourIds.has(String(cid))) continue;
        foreignCityId = cid;
        foreignCityName = (a.getAttribute("title") || a.textContent || "").trim();
        break;
      }
      if (!foreignCityId) continue;

      // Per-row dedup using the row's date cell + foreign cityId — every
      // unique news-feed event has its own date stamp so this disambiguates
      // pagination, repeated trades from the same player, etc.
      const dateCell = row.querySelector("td.date");
      const dateText = dateCell ? dateCell.textContent.trim() : "";
      const rowKey = "trd:" + foreignCityId + "|" + dateText;
      if (processedRows.has(rowKey)) continue;
      rememberRow(rowKey);

      let hit = await lookupCityId(foreignCityId);
      if (!hit || !hit.avatarId) {
        // Fall back to fetching the island view — runs in the background and
        // updates storage when it lands. We still record an event with what
        // we have so it isn't lost if the fetch fails.
        hit = await fetchAndCacheIsland(foreignCityId);
      }
      events.push({
        avatarId: hit ? hit.avatarId : null,
        avatarName: hit ? hit.avatarName : "",
        cityId: foreignCityId,
        cityName: hit ? hit.cityName : foreignCityName,
        source: "tradeAdvisor",
      });
    }
    if (events.length > 0) await recordTraders(events);
  }

  // ---------- view detection / scheduling ----------

  function findMilitaryTable() {
    // Container for the fleet movements table. Game wraps the actual <table>
    // inside a div with this id; the table itself is the only table inside.
    const wrap = document.getElementById("js_MilitaryMovementsFleetMovementsTable");
    if (!wrap) return null;
    return wrap.querySelector("table") || null;
  }

  function findTradeAdvisorTable() {
    return document.getElementById("inboxCity");
  }

  function scheduleScan() {
    if (scanDebounce) return;
    scanDebounce = setTimeout(async () => {
      scanDebounce = null;
      try {
        const mil = findMilitaryTable();
        const trd = findTradeAdvisorTable();
        if (!mil && !trd) return;
        // Per-row dedup inside each scanner makes re-running cheap — a row
        // already in processedRows is skipped before any storage / fetch work.
        if (mil) await scanMilitaryAdvisor(mil);
        if (trd) await scanTradeAdvisor(trd);
      } catch (err) {
        console.warn(TAG, "scan failed:", err);
      }
    }, 400);
  }

  // ---------- init ----------

  readOwnAvatarId();
  // Fire one scan in case we landed directly on the view.
  scheduleScan();

  // Re-run when game swaps templates via AJAX. The observer is on body+subtree
  // (the advisor tables can land in different containers), so the callback
  // MUST stay cheap — bail synchronously if no relevant container is in view.
  // Calling scheduleScan() unconditionally on every mutation is what was
  // slowing the game down: it spawned timers nonstop while the user played.
  function hasRelevantTable() {
    return !!(document.getElementById("js_MilitaryMovementsFleetMovementsTable")
           || document.getElementById("inboxCity"));
  }
  const obs = new MutationObserver(() => {
    if (scanDebounce) return;            // already queued
    if (!hasRelevantTable()) return;     // advisor not open — nothing to do
    scheduleScan();
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // When an island record lands in storage, update the cached cityId index
  // incrementally (instead of invalidating + rebuilding via get(null) which
  // is expensive on long sessions with thousands of stored islands), then
  // retry pending cityId resolutions.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (!key.startsWith(ISLAND_PREFIX)) continue;
      const island = changes[key].newValue;
      if (!island || !Array.isArray(island.cities)) continue;
      if (cityIdIndex) {
        for (const city of island.cities) {
          if (!city || !city.id) continue;
          cityIdIndex.set(String(city.id), indexEntryFromCity(island, city));
        }
      }
      touched = true;
    }
    if (touched) resolvePending();
  });
})();

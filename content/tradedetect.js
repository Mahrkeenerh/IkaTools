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
  let ownCityNames = null;          // Map<cityId, name> for our cities
  let ownAvatarId = null;           // string — our avatarId
  let cityIdIndex = null;           // Map<cityId, {avatarId, avatarName, cityName, islandId}>
  let resourceMap = null;           // Map<localizedNameLower, canonicalKey> — built lazily
  let scanDebounce = null;
  // Per-row dedup. Each scanner builds a stable key from row identity
  // (date + foreign cityId for tradeAdvisor; eventId for militaryAdvisor)
  // so paginating or re-scanning never double-counts the same trade.
  const processedRows = new Set();
  const PROCESSED_ROWS_CAP = 5000;  // hard cap to bound memory across long sessions
  // Receipt-row dedup is independent: a single news row can contribute to BOTH
  // partner tracking and a receipt, but the dedup keys differ (receipt key
  // includes resource + amount, partner key doesn't).
  const processedReceipts = new Set();
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

  function rememberReceipt(key) {
    if (processedReceipts.size >= PROCESSED_ROWS_CAP) {
      const it = processedReceipts.values().next();
      if (!it.done) processedReceipts.delete(it.value);
    }
    processedReceipts.add(key);
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
    const names = new Map();
    document.querySelectorAll("#dropDown_js_citySelectContainer li[selectvalue]").forEach((li) => {
      const v = li.getAttribute("selectvalue");
      if (!v) return;
      ids.add(String(v));
      const a = li.querySelector("a[title]");
      if (a) names.set(String(v), (a.getAttribute("title") || a.textContent || "").trim());
    });
    if (ids.size > 0) { ownCityIds = ids; ownCityNames = names; return ownCityIds; }
    // Fallback to bridge
    try {
      const cities = await IkUtils.getCities();
      for (const c of cities) {
        ids.add(String(c.id));
        if (c.name) names.set(String(c.id), c.name);
      }
    } catch (e) {}
    ownCityIds = ids;
    ownCityNames = names;
    return ownCityIds;
  }

  // Build a localized resource name → canonical key map by reading the
  // game's `LocalizationStrings = JSON.parse('…')` declaration from an inline
  // <script>. Fully locale-agnostic: works wherever the game runs.
  function buildResourceMap() {
    if (resourceMap) return resourceMap;
    const RES_KEYS = ["wood", "wine", "marble", "crystal", "sulfur", "gold"];
    let inner = null;
    for (const s of document.querySelectorAll("script")) {
      const txt = s.textContent;
      if (!txt || txt.indexOf("LocalizationStrings") === -1) continue;
      // Match the JSON.parse argument; capture handles \\ and \' escapes.
      const m = txt.match(/LocalizationStrings\s*=\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/);
      if (m) { inner = m[1]; break; }
    }
    if (!inner) return null;
    let loc;
    try {
      // The captured text is a JS string literal body. JSON allows \uXXXX,
      // \", \\, but not \' — the game's source uses single quotes so any
      // escaped apostrophes need to be unescaped before JSON.parse.
      loc = JSON.parse(inner.replace(/\\'/g, "'"));
    } catch (e) {
      console.warn(TAG, "failed to parse LocalizationStrings:", e);
      return null;
    }
    const map = new Map();
    for (const key of RES_KEYS) {
      const localized = loc[key];
      if (typeof localized === "string" && localized.length > 0) {
        map.set(localized.trim().toLowerCase(), key);
      }
    }
    resourceMap = map.size > 0 ? map : null;
    return resourceMap;
  }

  function canonicalResource(localized) {
    if (!localized) return null;
    const map = buildResourceMap();
    if (!map) return null;
    return map.get(localized.trim().toLowerCase()) || null;
  }

  // Parse the game's date cell text. Czech / German / most European locales
  // render "DD.MM.YYYY HH:mm"; some use slashes. Returns epoch ms or null.
  function parseTimestamp(text) {
    if (!text) return null;
    const t = text.trim();
    let m = t.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})\s+(\d{1,2}):(\d{2})/);
    if (m) {
      let yr = parseInt(m[3], 10);
      if (yr < 100) yr += 2000;
      const d = new Date(yr, parseInt(m[2], 10) - 1, parseInt(m[1], 10),
                         parseInt(m[4], 10), parseInt(m[5], 10), 0, 0);
      const ms = d.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    const fallback = Date.parse(t);
    return Number.isFinite(fallback) ? fallback : null;
  }

  // "20 000" → 20000. Game uses non-breaking spaces and regular spaces as
  // thousand separators; comma is a decimal point in Czech but trade amounts
  // are always integers, so just strip everything non-digit.
  function parseAmount(text) {
    if (!text) return 0;
    const cleaned = String(text).replace(/[^\d]/g, "");
    if (!cleaned) return 0;
    const n = parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : 0;
  }

  function cityIdFromAnyHref(a) {
    if (!a) return null;
    const m = (a.getAttribute("href") || "").match(/cityId=(\d+)/);
    return m ? m[1] : null;
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

  // Pull resource + amount + price-per-unit + currency out of the subject's
  // `<ul class="resources">`. Layout (locale-independent):
  //   <li class="value">{amount} <img title="{localized resource}"></li>
  //   "cena za kus:&nbsp;"            ← localized "price per unit:" text node
  //   <li class="value">{price} <img title="{localized currency}"></li>
  //   <br>
  // Returns { resource, amount, pricePerUnit, currency } or null on shape miss.
  function extractTradeDetails(subjectTd) {
    const ul = subjectTd.querySelector("ul.resources");
    if (!ul) return null;
    const valueLis = ul.querySelectorAll("li.value");
    if (valueLis.length < 2) return null;

    const resLi = valueLis[0];
    const priceLi = valueLis[1];
    const resImg = resLi.querySelector("img");
    const priceImg = priceLi.querySelector("img");
    if (!resImg || !priceImg) return null;

    const resource = canonicalResource(resImg.getAttribute("title") || resImg.getAttribute("alt"));
    if (!resource || resource === "gold") return null; // gold isn't a tradable resource here
    const currency = canonicalResource(priceImg.getAttribute("title") || priceImg.getAttribute("alt")) || "gold";

    const amount = parseAmount(resLi.textContent);
    const pricePerUnit = parseAmount(priceLi.textContent);
    if (amount <= 0 || pricePerUnit <= 0) return null;

    return { resource, amount, pricePerUnit, currency };
  }

  async function scanTradeAdvisor(table) {
    const ourIds = await readOwnCityIds();
    const events = [];
    const receipts = [];
    for (const row of table.querySelectorAll("tr")) {
      const subj = row.querySelector("td.subject");
      if (!subj) continue;
      if (!isMarketTradeRow(subj)) continue;

      // Two cityId links: the first is the BUYER's home, the second is the
      // SELLER's city. One side will be ours; the other is the trade partner.
      const links = subj.querySelectorAll("a[href*='cityId=']");
      if (links.length < 2) continue;

      const linkInfo = [];
      for (const a of links) {
        const cid = cityIdFromAnyHref(a);
        if (!cid) continue;
        linkInfo.push({
          cityId: cid,
          cityName: (a.getAttribute("title") || a.textContent || "").trim(),
        });
      }
      if (linkInfo.length < 2) continue;

      const buyer = linkInfo[0];
      const seller = linkInfo[1];
      const buyerOurs = ourIds.has(String(buyer.cityId));
      const sellerOurs = ourIds.has(String(seller.cityId));

      // Skip intra-account trades — both sides ours, no foreign partner.
      if (buyerOurs && sellerOurs) continue;
      // Skip if we recognise neither side (shouldn't happen in our news feed).
      if (!buyerOurs && !sellerOurs) continue;

      const foreign = sellerOurs ? buyer : seller;
      const ours = sellerOurs ? seller : buyer;
      // sellerOurs → foreign fleet bought from us → we sold.
      // buyerOurs  → our fleet bought from foreign → we bought.
      const dir = sellerOurs ? "sell" : "buy";

      const dateCell = row.querySelector("td.date");
      const dateText = dateCell ? dateCell.textContent.trim() : "";

      // Partner-tracking dedup (matches existing key shape, foreign-side only).
      const rowKey = "trd:" + foreign.cityId + "|" + dateText;
      const newPartnerRow = !processedRows.has(rowKey);
      if (newPartnerRow) rememberRow(rowKey);

      let hit = await lookupCityId(foreign.cityId);
      if (!hit || !hit.avatarId) {
        // Fall back to fetching the island view — runs in the background and
        // updates storage when it lands. We still record an event with what
        // we have so it isn't lost if the fetch fails.
        hit = await fetchAndCacheIsland(foreign.cityId);
      }

      if (newPartnerRow) {
        events.push({
          avatarId: hit ? hit.avatarId : null,
          avatarName: hit ? hit.avatarName : "",
          cityId: foreign.cityId,
          cityName: hit ? hit.cityName : foreign.cityName,
          source: "tradeAdvisor",
        });
      }

      // Receipt extraction. Independent dedup so re-scans only skip rows whose
      // resource/amount we already stored — avoids losing receipts when the
      // partner-row dedup fired but the receipt write was lost (e.g. on
      // a missing localization map at first try).
      const detail = extractTradeDetails(subj);
      if (!detail) continue;
      const ts = parseTimestamp(dateText);
      if (!ts) continue;

      const myCityName = (ownCityNames && ownCityNames.get(String(ours.cityId))) || ours.cityName;
      const receipt = {
        ts,
        dir,
        myCityId: ours.cityId,
        myCityName,
        otherCityId: foreign.cityId,
        otherCityName: hit ? (hit.cityName || foreign.cityName) : foreign.cityName,
        otherAvatarId: hit ? hit.avatarId : null,
        otherAvatarName: hit ? hit.avatarName : "",
        resource: detail.resource,
        amount: detail.amount,
        pricePerUnit: detail.pricePerUnit,
        currency: detail.currency,
      };
      const rk = "rcpt:" + ts + "|" + dir + "|" + ours.cityId + "|" + foreign.cityId + "|" + detail.resource + "|" + detail.amount;
      if (processedReceipts.has(rk)) continue;
      rememberReceipt(rk);
      receipts.push(receipt);
    }
    if (events.length > 0) await recordTraders(events);
    if (receipts.length > 0 && globalThis.TradeReceipts) {
      try {
        await globalThis.TradeReceipts.persistReceipts(worldName, receipts);
      } catch (err) {
        console.warn(TAG, "receipt persist failed:", err);
      }
    }
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

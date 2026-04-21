// Service worker — routes messages between content script and offscreen document,
// and runs long-running CT scan fetch loops in background (survives page navigation).

// ============================================================================
// Background CT scan — fetch loops that persist across page navigations
// ============================================================================

const BG_THROTTLE = 15;
const BG_BATCH_SIZE = 100;
const BG_BATCH_PAUSE_MS = 60000;
const PROGRESS_KEY = "ctScanProgress";
const RUNNING_KEY = "ctScanRunning";

let activeBgScan = null; // mutable state object: { cancelled }

function alarmSleep(ms) {
  return new Promise((resolve) => {
    const name = "ct-sleep-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const handler = (a) => {
      if (a.name !== name) return;
      chrome.alarms.onAlarm.removeListener(handler);
      resolve();
    };
    chrome.alarms.onAlarm.addListener(handler);
    // Min 1 minute resolution in MV3 production; for shorter delays use setTimeout
    if (ms < 30000) {
      chrome.alarms.onAlarm.removeListener(handler);
      setTimeout(resolve, ms);
    } else {
      chrome.alarms.create(name, { delayInMinutes: ms / 60000 });
    }
  });
}

async function bgFetchPage(originUrl, params) {
  const url = originUrl + "?" + params;
  const resp = await fetch(url, { credentials: "include" });
  return resp.text();
}

async function bgFetchAjax(originUrl, params) {
  const url = originUrl + "?" + params + "&ajax=1";
  const resp = await fetch(url, {
    credentials: "include",
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  return resp.text();
}

function bgParseTreatyStatus(text) {
  if (text.includes('value=\\"77\\"') || text.includes('value="77"')) return "offer";
  if (text.includes('value=\\"79\\"') || text.includes('value="79"')) return "accept";
  return null;
}

function bgExtractBgData(html) {
  const marker = '"updateBackgroundData"';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf("{", idx);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.substring(start, i + 1)); }
        catch (e) { return null; }
      }
    }
  }
  return null;
}

// Parse a city-view HTML response into a compact building record.
// Foreign cities expose updateBackgroundData with a `position` array that
// describes every slot (built + empty) — we keep all of them so stats can
// tell "never built" vs "not reached that slot yet" vs "built at level N".
function bgParseCity(html) {
  const data = bgExtractBgData(html);
  if (!data || !Array.isArray(data.position)) return null;
  const buildings = data.position.map((p, i) => {
    const raw = (p && p.building) || "";
    const parts = raw ? raw.split(/\s+/) : [];
    const base = parts[0] || "";
    const constructing = parts.includes("constructionSite");
    // buildingGround = unbuilt slot (with optional modifier like "dockyard" or "sea")
    const isEmpty = !base || base === "buildingGround";
    const entry = {
      pos: i,
      type: isEmpty ? null : base,
      level: p ? (parseInt(p.level || 0, 10) || 0) : 0,
      groundId: p ? (typeof p.groundId === "number" ? p.groundId : parseInt(p.groundId || 0, 10) || 0) : 0,
    };
    if (constructing) {
      entry.constructing = true;
      const done = parseInt(p.completed || 0, 10) || 0;
      if (done) entry.completeAt = done;
    }
    return entry;
  });
  return {
    id: parseInt(data.id || 0, 10),
    name: data.name || "",
    ownerId: String(data.ownerId || ""),
    ownerName: data.ownerName || "",
    islandId: String(data.islandId || ""),
    islandX: parseInt(data.islandXCoord || 0, 10),
    islandY: parseInt(data.islandYCoord || 0, 10),
    phase: typeof data.phase === "number" ? data.phase : (parseInt(data.phase || 0, 10) || 0),
    isCapital: !!data.isCapital,
    buildings,
    timestamp: Date.now(),
  };
}

function bgParseIslandPlayers(html, collectedIslands) {
  const data = bgExtractBgData(html);
  if (!data || !data.cities) return [];
  collectedIslands.push(data);
  const players = new Map();
  for (const city of data.cities) {
    if (!city || city.type === "buildplace") continue;
    const id = String(city.ownerId || "");
    if (!id || players.has(id)) continue;
    players.set(id, {
      id,
      name: city.ownerName || "",
      allyTag: city.ownerAllyTag || "",
      allyId: String(city.ownerAllyId || "0"),
    });
  }
  return [...players.values()];
}

// Build (but don't write) all the storage entries from a fresh batch of island
// data. Caller is responsible for the atomic swap (write new + remove stale).
// Returns { writes, freshIslandKeys, allyIndex }.
function bgBuildIslandWrites(collectedIslands, opts) {
  const parseScore = (v) => parseInt(String(v || "0").replace(/\s/g, ""), 10) || 0;
  const { worldName } = opts;

  const writes = {};
  const freshIslandKeys = new Set();
  // Build a fresh alliance index from scratch — no merging with existing
  // entries, so removed/relocated cities don't leave ghost data.
  const allyIndex = {};

  for (const data of collectedIslands) {
    const islandId = data.islandId || data.id;
    if (!islandId) continue;

    const scores = data.avatarScores || {};
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

    const citiesRaw = data.cities || [];
    for (let i = 0; i < citiesRaw.length; i++) {
      const c = citiesRaw[i];
      if (!c || c.type === "buildplace") continue;
      const avatarId = String(c.ownerId || "");
      const scoreData = scores[avatarId] || {};
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
        isOwn: false,
        scores: {
          place: parseScore(scoreData.place),
          building: Math.round(parseScore(scoreData.building_score_main) / 100),
          research: Math.round(parseScore(scoreData.research_score_main) / 100),
          army: Math.round(parseScore(scoreData.army_score_main) / 100),
          trader: Math.round(parseScore(scoreData.trader_score_secondary) / 100),
        },
      });
    }

    const islandKey = "island_" + worldName + "_" + islandId;
    writes[islandKey] = island;
    freshIslandKeys.add(islandKey);

    const coordKey = `${island.x}:${island.y}`;
    const counts = {};
    const members = {};
    for (const city of island.cities) {
      const tag = city.allyTag || "(none)";
      counts[tag] = (counts[tag] || 0) + 1;
      const oid = String(city.ownerId || "");
      if (!oid) continue;
      if (!members[tag]) members[tag] = [];
      if (!members[tag].includes(oid)) members[tag].push(oid);
    }
    allyIndex[coordKey] = { counts, members, total: island.cities.length };
  }

  writes["allianceIndex_" + worldName] = allyIndex;
  return { writes, freshIslandKeys, allyIndex };
}

// Build a single derived "query index" blob: filter-ready, denormalized,
// purpose-built for the in-game filter panel and the power-user JS hook.
// Reads from the writes object (already built per-island), so no extra storage round-trips.
function bgBuildQueryIndex(writes, opts) {
  const { worldName, fullScanAt } = opts;
  const islandPrefix = "island_" + worldName + "_";
  const allyKey = "allianceIndex_" + worldName;
  const allyIndex = writes[allyKey] || {};

  const islandsByCoord = {};
  const allyCityCounts = {}; // tag -> total cities across world (for sorting)

  for (const k of Object.keys(writes)) {
    if (!k.startsWith(islandPrefix)) continue;
    const isl = writes[k];
    if (!isl || !isl.cities) continue;

    const allyTags = new Set();
    const ownerIds = new Set();
    const ownerNames = [];
    let maxArmy = 0;
    let maxArmyPlayerId = null;
    let maxArmyPlayerName = null;

    // Per-player summary: deduplicated by ownerId, max scores across their cities on this island
    const playerMap = new Map(); // ownerId -> aggregated player record

    for (const c of isl.cities) {
      const tag = c.allyTag || "";
      if (tag) {
        allyTags.add(tag);
        allyCityCounts[tag] = (allyCityCounts[tag] || 0) + 1;
      }
      const oid = String(c.ownerId || "");
      if (oid && !ownerIds.has(oid)) {
        ownerIds.add(oid);
        if (c.ownerName) ownerNames.push(String(c.ownerName).toLowerCase());
      }
      const scores = c.scores || {};
      const army = scores.army || 0;
      if (army > maxArmy) {
        maxArmy = army;
        maxArmyPlayerId = oid || null;
        maxArmyPlayerName = c.ownerName || null;
      }
      if (oid) {
        const prev = playerMap.get(oid);
        if (prev) {
          prev.cities++;
          prev.maxLevel = Math.max(prev.maxLevel, c.level || 0);
          prev.place = Math.max(prev.place, scores.place || 0);
          prev.building = Math.max(prev.building, scores.building || 0);
          prev.research = Math.max(prev.research, scores.research || 0);
          prev.army = Math.max(prev.army, army);
          prev.trader = Math.max(prev.trader, scores.trader || 0);
        } else {
          playerMap.set(oid, {
            id: oid,
            name: c.ownerName || "",
            ally: tag,
            allyId: c.allyId || "0",
            state: c.state || "",
            cities: 1,
            maxLevel: c.level || 0,
            place: scores.place || 0,
            building: scores.building || 0,
            research: scores.research || 0,
            army,
            trader: scores.trader || 0,
          });
        }
      }
    }

    islandsByCoord[isl.x + ":" + isl.y] = {
      islandId: isl.id,
      name: isl.name,
      x: isl.x,
      y: isl.y,
      allyTags: [...allyTags],
      ownerIds: [...ownerIds],
      ownerNamesText: ownerNames.join("\n"),
      cityCount: isl.cities.length,
      players: [...playerMap.values()],
      maxArmy,
      maxArmyPlayerId,
      maxArmyPlayerName,
      timestamp: isl.timestamp || 0,
    };
  }

  // Sort alliance tags by descending total city count, alphabetical tiebreak.
  // Most prominent alliances appear first in the filter dropdown.
  const allyTags = Object.keys(allyCityCounts).sort((a, b) => {
    const d = allyCityCounts[b] - allyCityCounts[a];
    return d !== 0 ? d : a.localeCompare(b);
  });

  return {
    version: 1,
    worldName,
    fullScanAt,
    islandsByCoord,
    allyTags,
    allyCityCounts,
    allianceIndex: allyIndex,
  };
}

// Stamp CT availability onto an existing query index. Called separately
// because CT may run independently of the island fetch phase.
function bgApplyCtToQueryIndex(queryIndex, ctResult, opts) {
  if (!queryIndex || !ctResult) return queryIndex;
  const checkedIds = new Set((ctResult.players || []).map((p) => String(p.id)));
  const availableIds = new Set((ctResult.ctPlayers || []).map((p) => String(p.id)));
  for (const coord of Object.keys(queryIndex.islandsByCoord)) {
    const isl = queryIndex.islandsByCoord[coord];
    let checked = false;
    let available = false;
    for (const oid of isl.ownerIds) {
      if (checkedIds.has(oid)) checked = true;
      if (availableIds.has(oid)) { available = true; break; }
    }
    isl.ctChecked = checked;
    isl.ctAvailable = available;
  }
  queryIndex.ct = {
    timestamp: ctResult.timestamp || Date.now(),
    allyFilter: opts.allyFilter || "",
    ownExcluded: !!opts.ownAvatarId,
    checkedCount: checkedIds.size,
    availableCount: availableIds.size,
  };
  return queryIndex;
}

// Atomically replace the per-island and alliance-index data for a world.
// Reads stored map last and enriches it with the fresh alliance data, then
// performs a single set + a single remove of newly-stale island keys.
async function bgCommitIslandData(collectedIslands, opts) {
  if (collectedIslands.length === 0) return;
  const { worldName } = opts;
  const isPartial = opts.distanceRadius > 0 && opts.sourceCoords && opts.sourceCoords.length > 0;
  const { writes, freshIslandKeys, allyIndex } = bgBuildIslandWrites(collectedIslands, opts);

  // Enrich the world map with the same alliance data
  const mapKey = "map_" + worldName;
  const mapData = await chrome.storage.local.get(mapKey);
  const worldMap = mapData[mapKey];
  if (worldMap && worldMap.islands) {
    for (const data of collectedIslands) {
      const x = parseInt(data.islandXCoord || data.xCoord || 0, 10);
      const y = parseInt(data.islandYCoord || data.yCoord || 0, 10);
      const target = worldMap.islands.find((i) => i.x === x && i.y === y);
      if (!target) continue;
      const allyCounts = {};
      for (const c of (data.cities || [])) {
        if (c && c.ownerAllyTag) allyCounts[c.ownerAllyTag] = (allyCounts[c.ownerAllyTag] || 0) + 1;
      }
      const sorted = Object.entries(allyCounts).sort((a, b) => b[1] - a[1]);
      target.alliances = allyCounts;
      target.dominantAlly = sorted.length > 0 ? sorted[0][0] : "";
      target.cities = (data.cities || []).filter((c) => c && c.type !== "buildplace").length;
    }
    writes[mapKey] = worldMap;
  }

  // For partial scans, merge the alliance index with existing data instead of replacing
  if (isPartial) {
    const prevAlly = await chrome.storage.local.get("allianceIndex_" + worldName);
    const prevAllyIndex = prevAlly["allianceIndex_" + worldName];
    if (prevAllyIndex) {
      const merged = Object.assign({}, prevAllyIndex, allyIndex);
      writes["allianceIndex_" + worldName] = merged;
    }
  }

  // Build the derived query index from the same writes — purpose-built blob
  // that the filter UI and power-user JS hook read from. Single key, no
  // get(null) at read time.
  const prev = await chrome.storage.local.get("queryIndex_" + worldName);
  const prevIdx = prev["queryIndex_" + worldName];

  let queryIndex;
  if (isPartial && prevIdx) {
    // Partial scan: build index from only the new writes, then merge into existing
    const partialIndex = bgBuildQueryIndex(writes, { worldName, fullScanAt: Date.now() });
    queryIndex = { ...prevIdx, fullScanAt: Date.now() };
    // Overwrite only the coords we just fetched, keep everything else
    for (const coord of Object.keys(partialIndex.islandsByCoord)) {
      queryIndex.islandsByCoord[coord] = partialIndex.islandsByCoord[coord];
    }
    // Merge ally tags and counts
    for (const tag of Object.keys(partialIndex.allyCityCounts || {})) {
      queryIndex.allyCityCounts[tag] = (queryIndex.allyCityCounts[tag] || 0) +
        partialIndex.allyCityCounts[tag] - (prevIdx.allyCityCounts[tag] || 0);
      if (queryIndex.allyCityCounts[tag] <= 0) delete queryIndex.allyCityCounts[tag];
    }
    const allTags = Object.keys(queryIndex.allyCityCounts || {}).sort((a, b) => {
      const d = queryIndex.allyCityCounts[b] - queryIndex.allyCityCounts[a];
      return d !== 0 ? d : a.localeCompare(b);
    });
    queryIndex.allyTags = allTags;
    queryIndex.allianceIndex = writes["allianceIndex_" + worldName] || queryIndex.allianceIndex;
  } else {
    queryIndex = bgBuildQueryIndex(writes, { worldName, fullScanAt: Date.now() });
  }

  // Carry over previously-applied CT data so it isn't lost when only the
  // island phase is rerun.
  if (prevIdx && prevIdx.ct) {
    queryIndex.ct = prevIdx.ct;
    for (const coord of Object.keys(queryIndex.islandsByCoord)) {
      const old = prevIdx.islandsByCoord && prevIdx.islandsByCoord[coord];
      if (!old) continue;
      // Only carry over CT flags if the same owner set is checked — otherwise
      // the old flags are stale relative to the new owner list.
      const sameOwners = old.ownerIds && old.ownerIds.length === queryIndex.islandsByCoord[coord].ownerIds.length &&
        old.ownerIds.every((id) => queryIndex.islandsByCoord[coord].ownerIds.includes(id));
      if (sameOwners) {
        queryIndex.islandsByCoord[coord].ctChecked = old.ctChecked;
        queryIndex.islandsByCoord[coord].ctAvailable = old.ctAvailable;
      }
    }
  }
  writes["queryIndex_" + worldName] = queryIndex;

  if (isPartial) {
    // Partial scan: only write new/updated data, never remove existing islands
    await chrome.storage.local.set(writes);
  } else {
    // Full scan: atomic swap — find and remove stale island keys
    const islandPrefix = "island_" + worldName + "_";
    const allKeys = await chrome.storage.local.get(null);
    const stale = Object.keys(allKeys).filter(
      (k) => k.startsWith(islandPrefix) && !freshIslandKeys.has(k)
    );

    // Write fresh data first; only then drop stale keys. If we crash between
    // these two steps, we have extra ghost keys (recoverable) instead of an
    // empty map (catastrophic).
    await chrome.storage.local.set(writes);
    if (stale.length > 0) await chrome.storage.local.remove(stale);
  }
}

// Throttled runner with batch pauses; reports progress to storage.
// retryOpts: { retries, backoffMs, shouldRetry(result, err) -> bool, onExhausted(item, attempts) }
// shouldRetry receives (result, err) — err is non-null on a thrown exception, result is the fn
// return value on success. Returning true triggers a retry (up to retryOpts.retries extra attempts).
function bgRunThrottled(items, fn, phase, state, retryOpts) {
  const MAX_RETRIES = retryOpts ? (retryOpts.retries || 2) : 0;
  const BACKOFF = retryOpts ? (retryOpts.backoffMs || [500, 1500]) : [];
  const shouldRetry = retryOpts ? (retryOpts.shouldRetry || (() => false)) : () => false;
  const onExhausted = retryOpts ? (retryOpts.onExhausted || null) : null;

  return new Promise((resolve) => {
    let done = 0;
    let started = 0;
    let failed = 0;
    let pausing = false;
    let batchStarted = 0;
    const total = items.length;
    const startTime = Date.now();
    if (total === 0) { resolve({ failed: 0 }); return; }

    function reportProgress(extra) {
      const elapsed = Date.now() - startTime;
      const eta = done > 0 ? Math.round(elapsed / done * (total - done) / 1000) : 0;
      const prog = { phase, current: done, total, eta, failed, ...extra };
      chrome.storage.local.set({ [PROGRESS_KEY]: prog });
    }

    async function doPause() {
      pausing = true;
      batchStarted = 0;
      const startedAt = Date.now();
      const tickInterval = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((BG_BATCH_PAUSE_MS - (Date.now() - startedAt)) / 1000));
        reportProgress({ paused: true, pauseSec: remaining });
        if (remaining === 0 || state.cancelled) clearInterval(tickInterval);
      }, 1000);
      reportProgress({ paused: true, pauseSec: Math.round(BG_BATCH_PAUSE_MS / 1000) });
      await alarmSleep(BG_BATCH_PAUSE_MS);
      clearInterval(tickInterval);
      pausing = false;
      next();
    }

    async function runWithRetry(item) {
      let attempts = 0;
      while (true) {
        let result, err;
        try {
          result = await fn(item);
          err = null;
        } catch (e) {
          result = null;
          err = e;
        }
        const isBad = shouldRetry(result, err);
        if (!isBad) return; // success — no counting needed
        if (state.cancelled || attempts >= MAX_RETRIES) {
          // Retries exhausted (or scan cancelled) — only count as failed when not cancelled,
          // since a cancellation mid-flight is expected and not a data quality issue.
          if (!state.cancelled) {
            failed++;
            if (onExhausted) onExhausted(item, attempts + 1);
          }
          return;
        }
        attempts++;
        const delay = Array.isArray(BACKOFF) ? (BACKOFF[attempts - 1] ?? BACKOFF[BACKOFF.length - 1] ?? 500) : BACKOFF;
        await alarmSleep(delay);
      }
    }

    function next() {
      if (pausing) return;
      if (state.cancelled) { resolve({ failed }); return; }
      if (batchStarted >= BG_BATCH_SIZE) {
        if (started === done) {
          if (done < total) doPause();
        }
        return;
      }
      while (started < total && (started - done) < BG_THROTTLE && batchStarted < BG_BATCH_SIZE) {
        if (state.cancelled) break;
        const idx = started++;
        batchStarted++;
        runWithRetry(items[idx]).finally(() => {
          done++;
          reportProgress();
          if (done === total) resolve({ failed });
          else next();
        });
      }
      if (state.cancelled && started === done) resolve({ failed });
    }
    next();
  });
}

async function bgPhasePause(state) {
  const startedAt = Date.now();
  function tick() {
    const remaining = Math.max(0, Math.ceil((BG_BATCH_PAUSE_MS - (Date.now() - startedAt)) / 1000));
    chrome.storage.local.set({ [PROGRESS_KEY]: { phase: "cooldown", current: 0, total: 0, paused: true, pauseSec: remaining } });
  }
  tick();
  const interval = setInterval(tick, 1000);
  await alarmSleep(BG_BATCH_PAUSE_MS);
  clearInterval(interval);
  return !state.cancelled;
}

// Build a Set of island coord keys ("x:y") within Chebyshev distance of source coords.
// For small radii uses spatial enumeration; for large radii scans all islands.
function bgBuildDistanceSet(sourceCoords, radius, allIslands) {
  const result = new Set();
  if (radius <= 30) {
    // Spatial enumeration: for each source, add all coords in the square.
    // Coords are added to a Set so overlapping radii cause no extra work.
    const islandCoords = new Set();
    for (const isl of allIslands) islandCoords.add(isl.x + ":" + isl.y);
    for (const src of sourceCoords) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const key = (src.x + dx) + ":" + (src.y + dy);
          if (islandCoords.has(key)) result.add(key);
        }
      }
    }
  } else {
    // Linear scan: check each island against all sources
    for (const isl of allIslands) {
      for (const src of sourceCoords) {
        if (Math.abs(isl.x - src.x) <= radius && Math.abs(isl.y - src.y) <= radius) {
          result.add(isl.x + ":" + isl.y);
          break;
        }
      }
    }
  }
  return result;
}

async function bgDoIslandFetch(opts, state) {
  const { originUrl, worldName, idMapping } = opts;
  const mapKey = "map_" + worldName;
  const data = await chrome.storage.local.get(mapKey);
  const mapData = data[mapKey];
  if (!mapData || !mapData.islands || mapData.islands.length === 0) return null;

  // No upfront wipe — accumulate fresh data, swap atomically at the end so
  // a cancelled or crashed scan never leaves the user with an empty world.
  const populatedIslands = mapData.islands.filter((i) => i.cities > 0);

  // Apply distance filter if source coords are provided
  let distanceSet = null;
  if (opts.distanceRadius > 0 && opts.sourceCoords && opts.sourceCoords.length > 0) {
    distanceSet = bgBuildDistanceSet(opts.sourceCoords, opts.distanceRadius, mapData.islands);
  }

  const toFetch = [];
  for (const isl of populatedIslands) {
    const key = isl.x + ":" + isl.y;
    if (distanceSet && !distanceSet.has(key)) continue;
    const islandId = idMapping[key];
    if (islandId) toFetch.push({ ...isl, islandId });
  }

  const collectedIslands = [];
  const allPlayers = new Map();
  // Retry when the fetch threw OR when bgExtractBgData got nothing usable —
  // populatedIslands is already filtered to cities > 0, so a null bgData means
  // the response was a network error, a redirect (logged-out), or a parse failure.
  // Duplicate pushes on retry are harmless: bgBuildIslandWrites overwrites by islandId.
  const islandRetryOpts = {
    retries: 2,
    backoffMs: [500, 1500],
    shouldRetry: (result, err) => err !== null || result === false,
    onExhausted: (isl, attempts) => {
      console.warn("[bg-scan] gave up on island after " + attempts + " attempts:", isl.x + ":" + isl.y, "id=" + isl.islandId);
    },
  };
  const { failed: islandsFailed } = await bgRunThrottled(toFetch, async (isl) => {
    const html = await bgFetchPage(originUrl, `view=island&islandId=${isl.islandId}`);
    const before = collectedIslands.length;
    const players = bgParseIslandPlayers(html, collectedIslands);
    const gotData = collectedIslands.length > before;
    for (const p of players) {
      if (!allPlayers.has(p.id)) {
        allPlayers.set(p.id, { ...p, islands: [{ x: isl.x, y: isl.y, name: isl.name }] });
      } else {
        allPlayers.get(p.id).islands.push({ x: isl.x, y: isl.y, name: isl.name });
      }
    }
    // false signals a parse miss (bgExtractBgData returned nothing); true means we got data
    return gotData;
  }, "islands", state, islandRetryOpts);

  if (state.cancelled) return null;
  await bgCommitIslandData(collectedIslands, opts);
  return { players: [...allPlayers.values()], totalIslands: toFetch.length, failed: islandsFailed };
}

async function bgDoCityFetch(opts, state) {
  const { originUrl, worldName } = opts;

  const all = await chrome.storage.local.get(null);
  const islandPrefix = "island_" + worldName + "_";

  let distanceSet = null;
  if (opts.distanceRadius > 0 && opts.sourceCoords && opts.sourceCoords.length > 0) {
    const mapKey = "map_" + worldName;
    const mapData = all[mapKey];
    if (mapData && mapData.islands) {
      distanceSet = bgBuildDistanceSet(opts.sourceCoords, opts.distanceRadius, mapData.islands);
    }
  }

  const cityList = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(islandPrefix)) continue;
    const island = all[key];
    if (!island || !island.cities) continue;
    if (distanceSet && !distanceSet.has(island.x + ":" + island.y)) continue;
    for (const c of island.cities) {
      if (c && c.id) cityList.push({ id: c.id });
    }
  }
  if (cityList.length === 0) return null;

  const writes = {};
  // Retry cities whose fetch threw or whose parse returned null (malformed/logged-out response).
  const cityRetryOpts = {
    retries: 2,
    backoffMs: [500, 1500],
    shouldRetry: (result, err) => err !== null || result === null,
    onExhausted: (c, attempts) => {
      console.warn("[bg-scan] gave up on city after " + attempts + " attempts:", "cityId=" + c.id);
    },
  };
  const { failed: citiesFailed } = await bgRunThrottled(cityList, async (c) => {
    const html = await bgFetchPage(originUrl, "view=city&cityId=" + c.id);
    const parsed = bgParseCity(html);
    if (parsed) writes["cityData_" + worldName + "_" + c.id] = parsed;
    return parsed;
  }, "cities", state, cityRetryOpts);

  if (state.cancelled) return null;
  if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
  return { totalCities: cityList.length, fetched: Object.keys(writes).length, failed: citiesFailed };
}

async function bgLoadPlayersFromStoredIslands(worldName) {
  const all = await chrome.storage.local.get(null);
  const prefix = "island_" + worldName + "_";
  const players = new Map();
  for (const key of Object.keys(all)) {
    if (!key.startsWith(prefix)) continue;
    const island = all[key];
    if (!island || !island.cities) continue;
    for (const city of island.cities) {
      const id = String(city.ownerId || "");
      if (!id) continue;
      if (!players.has(id)) {
        players.set(id, {
          id,
          name: city.ownerName || "",
          allyTag: city.allyTag || "",
          allyId: city.allyId || "0",
          islands: [{ x: island.x, y: island.y, name: island.name }],
        });
      } else {
        const p = players.get(id);
        if (!p.islands.some((i) => i.x === island.x && i.y === island.y)) {
          p.islands.push({ x: island.x, y: island.y, name: island.name });
        }
      }
    }
  }
  return [...players.values()];
}

async function bgDoCtCheck(opts, state) {
  const { originUrl, worldName, allyFilter, ownAvatarId } = opts;
  let players = await bgLoadPlayersFromStoredIslands(worldName);
  if (players.length === 0) return null;

  if (allyFilter) {
    const filter = allyFilter.toLowerCase();
    players = players.filter((p) => p.allyTag.toLowerCase().includes(filter));
  }
  if (ownAvatarId) players = players.filter((p) => p.id !== ownAvatarId);

  // Distance filter: only check players who have at least one island in range
  if (opts.distanceRadius > 0 && opts.sourceCoords && opts.sourceCoords.length > 0) {
    const mapKey = "map_" + worldName;
    const mapRaw = await chrome.storage.local.get(mapKey);
    const mapData = mapRaw[mapKey];
    if (mapData && mapData.islands) {
      const distanceSet = bgBuildDistanceSet(opts.sourceCoords, opts.distanceRadius, mapData.islands);
      players = players.filter((p) =>
        p.islands.some((i) => distanceSet.has(i.x + ":" + i.y))
      );
    }
  }

  await bgRunThrottled(players, async (p) => {
    const text = await bgFetchAjax(originUrl, `view=sendIKMessage&receiverId=${p.id}&isMission=1&closeView=1`);
    p.ct = bgParseTreatyStatus(text);
  }, "ct-check", state);

  if (state.cancelled) return null;

  const allyCounts = {};
  for (const p of players) {
    const tag = p.allyTag || "(none)";
    allyCounts[tag] = (allyCounts[tag] || 0) + 1;
  }
  const ctPlayers = players.filter((p) => p.ct);
  const result = {
    players,
    ctPlayers,
    allyCounts,
    totalIslands: 0,
    timestamp: Date.now(),
    allyFilter: allyFilter || "",
    ownExcluded: !!ownAvatarId,
  };

  // Stamp CT availability onto the query index so the filter panel can use it
  const qiKey = "queryIndex_" + worldName;
  const qiData = await chrome.storage.local.get(qiKey);
  const queryIndex = qiData[qiKey];
  if (queryIndex) {
    bgApplyCtToQueryIndex(queryIndex, result, { allyFilter, ownAvatarId });
    await chrome.storage.local.set({ [qiKey]: queryIndex, ["ctScan_" + worldName]: result });
  } else {
    await chrome.storage.local.set({ ["ctScan_" + worldName]: result });
  }
  return result;
}

async function runBgScan(opts) {
  const state = { cancelled: false };
  activeBgScan = state;
  await chrome.storage.local.set({ [RUNNING_KEY]: true });

  try {
    const doIslands = opts.mode === "islands" || opts.mode === "full" || opts.mode === "fullCities";
    const doCities = opts.mode === "cities" || opts.mode === "fullCities";
    const doCt = opts.mode === "ct" || opts.mode === "full";

    if (doIslands) {
      const r = await bgDoIslandFetch(opts, state);
      if (!r || state.cancelled) return;
      if (doCities || doCt) {
        const ok = await bgPhasePause(state);
        if (!ok) return;
      }
    }

    if (doCities) {
      const r = await bgDoCityFetch(opts, state);
      if (!r || state.cancelled) return;
      if (doCt) {
        const ok = await bgPhasePause(state);
        if (!ok) return;
      }
    }

    if (doCt) {
      const r = await bgDoCtCheck(opts, state);
      if (!r || state.cancelled) return;
    }
  } catch (e) {
    console.error("[bg-scan] error:", e);
  } finally {
    if (activeBgScan === state) activeBgScan = null;
    await chrome.storage.local.set({ [RUNNING_KEY]: false });
    await chrome.storage.local.remove(PROGRESS_KEY);
  }
}

// ============================================================================
// Original message routing
// ============================================================================

let offscreenReady = false;
let readyResolve = null;
let readyPromise = new Promise((resolve) => { readyResolve = resolve; });

function waitForReady() {
  if (offscreenReady) return Promise.resolve();
  return readyPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "bg-start-scan") {
    if (activeBgScan) {
      sendResponse({ ok: false, error: "Scan already running" });
      return;
    }
    runBgScan(msg.opts).catch((e) => console.error("[bg-scan] uncaught:", e));
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "bg-cancel-scan") {
    if (activeBgScan) activeBgScan.cancelled = true;
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "offscreen-ready") {
    if (!sender.url || !sender.url.endsWith("pages/offscreen.html")) return;
    offscreenReady = true;
    if (readyResolve) readyResolve();
    return;
  }

  if (msg.type === "open-advisor-report") {
    const reportUrl = chrome.runtime.getURL("pages/report.html");
    const url = msg.worldName
      ? reportUrl + "?world=" + encodeURIComponent(msg.worldName)
      : reportUrl;
    const opts = { url };
    if (sender.tab) {
      opts.index = sender.tab.index + 1;
      opts.openerTabId = sender.tab.id;
    }
    chrome.tabs.create(opts);
    return;
  }

  if (msg.type === "open-tab-next") {
    const opts = { url: msg.url };
    if (typeof msg.active === "boolean") opts.active = msg.active;
    if (sender.tab) {
      opts.index = sender.tab.index + 1;
      opts.openerTabId = sender.tab.id;
    }
    chrome.tabs.create(opts);
    return;
  }

  if (msg.type === "solve-captcha") {
    ensureOffscreen()
      .then(() => waitForReady())
      .then(() =>
        chrome.runtime.sendMessage({
          type: "offscreen-solve",
          dataUrl: msg.dataUrl,
        })
      )
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) {
    // Doc exists but service worker restarted — ping to check if alive
    if (!offscreenReady) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: "offscreen-ping" });
        if (resp?.pong) {
          offscreenReady = true;
          return;
        }
      } catch (e) {
        // Offscreen doc is dead, recreate
      }
      // Couldn't reach it, tear down and recreate
      await chrome.offscreen.closeDocument();
    } else {
      return;
    }
  }
  offscreenReady = false;
  readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  await chrome.offscreen.createDocument({
    url: "pages/offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run ONNX model inference via WASM",
  });
}

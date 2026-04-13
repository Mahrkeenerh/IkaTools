(() => {
  const P = "[TradeHistory]";
  const RETENTION_DAYS = 180;
  const RES_MAP = { wood: 0, wine: 1, marble: 2, crystal: 3, sulfur: 4 };
  const RES_NAMES = ["wood", "wine", "marble", "crystal", "sulfur"];

  function chunkKey(world, avatarId, date) {
    const d = date || new Date();
    const month = d.toISOString().slice(0, 7); // YYYY-MM
    return `tradeHistory_${world}_${avatarId}_${month}`;
  }

  function indexKey(world, avatarId) {
    return `tradeHistoryIdx_${world}_${avatarId}`;
  }

  function monthFromKey(key) {
    return key.slice(key.lastIndexOf("_") + 1);
  }

  // Promise wrapper for chrome.storage.local
  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  // Deduplicate offers — same offer visible from multiple scanning cities
  function deduplicateOffers(allOffers, playerName) {
    const map = new Map();
    const pn = (playerName || "").toLowerCase();

    for (const o of allOffers) {
      // Map game types to market sides
      const side = o.type === "sell" ? "ask" : "bid";
      const r = RES_MAP[o.resource] ?? -1;
      if (r === -1) continue;

      const key = `${side}|${r}|${o.price}|${o.quantity}|${o.playerName}|${o.cityName}`;
      if (map.has(key)) continue;

      const isSelf = pn && o.playerName && o.playerName.toLowerCase() === pn;
      map.set(key, {
        s: side,
        r,
        p: o.price,
        q: o.quantity,
        pl: o.playerName || "",
        c: o.cityName || "",
        self: isSelf ? 1 : 0,
      });
    }

    return [...map.values()];
  }

  // Compute percentile from sorted array
  function percentile(sorted, pct) {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const idx = (pct / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // Compute stats per resource per side
  function computeStats(offers) {
    const stats = {};

    for (let r = 0; r < 5; r++) {
      const askOffers = offers.filter((o) => o.r === r && o.s === "ask");
      const bidOffers = offers.filter((o) => o.r === r && o.s === "bid");

      const askStats = computeSideStats(askOffers, "ask");
      const bidStats = computeSideStats(bidOffers, "bid");

      if (askStats || bidStats) {
        stats[r] = {};
        if (askStats) stats[r].ask = askStats;
        if (bidStats) stats[r].bid = bidStats;
      }
    }

    return stats;
  }

  function computeSideStats(offers, side) {
    if (offers.length === 0) return null;

    const prices = offers.map((o) => o.p).sort((a, b) => a - b);
    const totalQty = offers.reduce((sum, o) => sum + o.q, 0);

    // Unique players
    const playerSet = new Set(offers.map((o) => o.pl).filter(Boolean));
    const uniquePlayers = playerSet.size;

    // Top player share
    let topPlayerShare = 0;
    if (uniquePlayers > 0) {
      const playerQty = {};
      for (const o of offers) {
        const key = o.pl || "__anon__";
        playerQty[key] = (playerQty[key] || 0) + o.q;
      }
      const maxQty = Math.max(...Object.values(playerQty));
      topPlayerShare = totalQty > 0 ? Math.round((maxQty / totalQty) * 100) / 100 : 0;
    }

    return {
      best: side === "ask" ? prices[0] : prices[prices.length - 1],
      median: percentile(prices, 50),
      p25: percentile(prices, 25),
      p75: percentile(prices, 75),
      min: prices[0],
      max: prices[prices.length - 1],
      totalQty,
      uniquePlayers,
      topPlayerShare,
    };
  }

  // Deduplicate army offers — same offer visible from multiple scanning cities
  function deduplicateArmyOffers(allOffers, playerName) {
    const map = new Map();
    const pn = (playerName || "").toLowerCase();

    for (const o of allOffers) {
      const key = `${o.unitId}|${o.price}|${o.quantity}|${o.playerName}|${o.cityName}|${o.currency}`;
      if (map.has(key)) continue;

      const isSelf = pn && o.playerName && o.playerName.toLowerCase() === pn;
      map.set(key, {
        s: "bid",
        u: o.unitId || "",
        un: o.unitName || "",
        p: o.price,
        q: o.quantity,
        pl: o.playerName || "",
        c: o.cityName || "",
        cur: o.currency || "gold",
        self: isSelf ? 1 : 0,
      });
    }

    return [...map.values()];
  }

  // Persist a trading snapshot
  async function persistSnapshot(reportData) {
    const world = reportData.urlWorld;
    const avatarId = reportData.avatarId;
    if (!world || !avatarId) {
      console.warn(P, "Missing world or avatarId, skipping history persist");
      return;
    }

    // Flatten all offers across cities
    const allOffers = [];
    let marketCityCount = 0;
    for (const city of reportData.cities) {
      if (!city.trading || city.trading.length === 0) continue;
      marketCityCount++;
      for (const offer of city.trading) {
        allOffers.push(offer);
      }
    }

    const playerName = reportData.global?.playerName || "";
    const dedupedOffers = deduplicateOffers(allOffers, playerName);
    const stats = computeStats(dedupedOffers);

    // Flatten army offers across cities
    const allArmyOffers = [];
    for (const city of reportData.cities) {
      if (!city.armyTrading || city.armyTrading.length === 0) continue;
      for (const offer of city.armyTrading) {
        allArmyOffers.push(offer);
      }
    }
    const dedupedArmyOffers = deduplicateArmyOffers(allArmyOffers, playerName);

    const snapshot = {
      ts: Date.now(),
      complete: true,
      cityCount: reportData.cities.length,
      marketCityCount,
      offers: dedupedOffers,
      stats,
    };
    if (dedupedArmyOffers.length > 0) {
      snapshot.armyOffers = dedupedArmyOffers;
    }

    // Append to current month chunk
    const key = chunkKey(world, avatarId);
    const idxKey = indexKey(world, avatarId);
    const currentMonth = new Date().toISOString().slice(0, 7);

    const stored = await storageGet([key, idxKey]);
    const chunk = stored[key] || { snapshots: [] };
    chunk.snapshots.push(snapshot);

    const idx = stored[idxKey] || { chunks: [], lastTs: 0 };
    if (!idx.chunks.includes(currentMonth)) {
      idx.chunks.push(currentMonth);
      idx.chunks.sort();
    }
    idx.lastTs = snapshot.ts;

    await storageSet({ [key]: chunk, [idxKey]: idx });

    // Prune old chunks
    await pruneOldChunks(world, avatarId, idx);
  }

  async function pruneOldChunks(world, avatarId, idx) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffMonth = cutoff.toISOString().slice(0, 7);

    const toRemove = idx.chunks.filter((m) => m < cutoffMonth);
    if (toRemove.length === 0) return;

    const keysToRemove = toRemove.map((m) => `tradeHistory_${world}_${avatarId}_${m}`);
    await storageRemove(keysToRemove);

    idx.chunks = idx.chunks.filter((m) => m >= cutoffMonth);
    await storageSet({ [indexKey(world, avatarId)]: idx });
  }

  // Load history snapshots for a given timeframe (in days)
  async function loadHistory(world, avatarId, days) {
    if (!world || !avatarId) return [];

    const idxKey = indexKey(world, avatarId);
    const stored = await storageGet([idxKey]);
    const idx = stored[idxKey];
    if (!idx || !idx.chunks || idx.chunks.length === 0) return [];

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    // Determine which monthly chunks could contain data in range
    const cutoffDate = new Date(cutoff);
    const cutoffMonth = cutoffDate.toISOString().slice(0, 7);
    const relevantChunks = idx.chunks.filter((m) => m >= cutoffMonth);

    if (relevantChunks.length === 0) return [];

    const chunkKeys = relevantChunks.map((m) => `tradeHistory_${world}_${avatarId}_${m}`);
    const chunkData = await storageGet(chunkKeys);

    const snapshots = [];
    for (const key of chunkKeys) {
      const chunk = chunkData[key];
      if (!chunk || !chunk.snapshots) continue;
      for (const snap of chunk.snapshots) {
        if (snap.ts >= cutoff) {
          snapshots.push(snap);
        }
      }
    }

    snapshots.sort((a, b) => a.ts - b.ts);
    return snapshots;
  }

  globalThis.TradeHistory = {
    persistSnapshot,
    loadHistory,
    computeStats,
    percentile,
    RES_MAP,
    RES_NAMES,
    RETENTION_DAYS,
  };
})();

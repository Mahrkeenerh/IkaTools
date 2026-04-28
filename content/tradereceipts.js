// Storage helper for actual completed market trades — receipts captured from
// the tradeAdvisor "Novinky z měst" feed. Mirrors the chunked layout used by
// tradehistory.js (offer-board snapshots) but the records here are real
// per-trade events, not aggregate offer stats.
//
// Receipt shape:
//   {
//     ts: epoch ms (parsed from the row's date cell),
//     dir: "sell" | "buy",
//     myCityId, myCityName,           // our side of the trade
//     otherCityId, otherCityName,     // foreign city
//     otherAvatarId, otherAvatarName, // resolved if we know it (else null)
//     resource: "wood"|"wine"|"marble"|"crystal"|"sulfur",
//     amount,                          // units traded
//     pricePerUnit,                    // price per unit
//     currency: "gold" (typical)
//   }
//
// Stable dedup key: ts|dir|myCityId|otherCityId|resource|amount — this is unique
// per actual trade event and survives re-scans / pagination.
(() => {
  const RETENTION_DAYS = 180;

  function monthKey(ts) {
    return new Date(ts).toISOString().slice(0, 7);
  }

  function chunkKey(world, month) {
    return `tradeReceipts_${world}_${month}`;
  }

  function indexKey(world) {
    return `tradeReceiptsIdx_${world}`;
  }

  function receiptKey(r) {
    return `${r.ts}|${r.dir}|${r.myCityId}|${r.otherCityId}|${r.resource}|${r.amount}`;
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }
  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  async function pruneOldChunks(world, idx) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffMonth = cutoff.toISOString().slice(0, 7);
    const drop = idx.chunks.filter((m) => m < cutoffMonth);
    if (drop.length === 0) return;
    await storageRemove(drop.map((m) => chunkKey(world, m)));
    idx.chunks = idx.chunks.filter((m) => m >= cutoffMonth);
    await storageSet({ [indexKey(world)]: idx });
  }

  // Append receipts, deduplicated by stable key. Receipts may span multiple
  // months — they're grouped per month so we only touch the chunks we need.
  async function persistReceipts(world, receipts) {
    if (!world || !receipts || receipts.length === 0) return 0;

    const byMonth = new Map();
    for (const r of receipts) {
      if (!r || !r.ts || !r.resource) continue;
      const m = monthKey(r.ts);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(r);
    }
    if (byMonth.size === 0) return 0;

    const idxK = indexKey(world);
    const months = [...byMonth.keys()];
    const keysToRead = [idxK, ...months.map((m) => chunkKey(world, m))];
    const stored = await storageGet(keysToRead);
    const idx = stored[idxK] || { chunks: [], lastTs: 0 };

    const writes = {};
    let totalAdded = 0;

    for (const m of months) {
      const k = chunkKey(world, m);
      const chunk = stored[k] || { receipts: [] };
      const seen = new Set(chunk.receipts.map(receiptKey));
      let added = 0;
      for (const r of byMonth.get(m)) {
        const key = receiptKey(r);
        if (seen.has(key)) continue;
        seen.add(key);
        chunk.receipts.push(r);
        added++;
        if (r.ts > (idx.lastTs || 0)) idx.lastTs = r.ts;
      }
      if (added > 0) {
        chunk.receipts.sort((a, b) => a.ts - b.ts);
        writes[k] = chunk;
        totalAdded += added;
      }
      if (!idx.chunks.includes(m)) idx.chunks.push(m);
    }

    if (totalAdded > 0) {
      idx.chunks.sort();
      writes[idxK] = idx;
      await storageSet(writes);
      await pruneOldChunks(world, idx);
    }
    return totalAdded;
  }

  async function loadReceipts(world, days) {
    if (!world) return [];
    const idxK = indexKey(world);
    const stored = await storageGet([idxK]);
    const idx = stored[idxK];
    if (!idx || !idx.chunks || idx.chunks.length === 0) return [];

    const cutoffTs = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffMonth = new Date(cutoffTs).toISOString().slice(0, 7);
    const months = idx.chunks.filter((m) => m >= cutoffMonth);
    if (months.length === 0) return [];

    const keys = months.map((m) => chunkKey(world, m));
    const data = await storageGet(keys);
    const out = [];
    for (const k of keys) {
      const c = data[k];
      if (!c || !c.receipts) continue;
      for (const r of c.receipts) if (r.ts >= cutoffTs) out.push(r);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  globalThis.TradeReceipts = {
    persistReceipts,
    loadReceipts,
    RETENTION_DAYS,
  };
})();

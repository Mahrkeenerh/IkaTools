// Report page — reads advisor data from chrome.storage.local and renders tables
(() => {
  const $ = (id) => document.getElementById(id);

  const TRADEGOOD_NAMES = { 1: "Wine", 2: "Marble", 3: "Crystal", 4: "Sulfur" };

  // Key building IDs for the buildings grid
  const OVERVIEW_BUILDING_IDS = [0, 4, 6, 3, 7, 8, 16, 11, 28, 30, 12, 9, 34, 24, 18, 23, 21, 13];

  // Tab switching
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".report-panel").forEach((p) => p.classList.remove("active"));
      const target = $(btn.dataset.tab);
      if (target) target.classList.add("active");
    });
  });

  chrome.storage.local.get("advisorReportData", (data) => {
    const report = data.advisorReportData;
    if (!report || !report.cities || report.cities.length === 0) {
      document.querySelector(".content").innerHTML =
        "<div class=\"no-data\"><strong>No report data</strong>Generate a report from the extension popup first.</div>";
      return;
    }

    const ts = new Date(report.timestamp);
    $("report-timestamp").textContent =
      ts.toLocaleDateString() + " " + ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    // Determine which tabs to show based on report mode
    const MODE_TABS = {
      basic: ["panel-overview", "panel-economy"],
      army: ["panel-overview", "panel-army"],
      trading: ["panel-overview", "panel-trading"],
      full: null, // show all
    };
    const visibleTabs = MODE_TABS[report.mode] || null;

    if (visibleTabs) {
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        if (!visibleTabs.includes(btn.dataset.tab)) btn.style.display = "none";
      });
      // Default to the second tab (the mode-specific one)
      const defaultTab = visibleTabs[1] || visibleTabs[0];
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".report-panel").forEach((p) => p.classList.remove("active"));
      const btn = document.querySelector(`[data-tab="${defaultTab}"]`);
      if (btn) btn.classList.add("active");
      $(defaultTab).classList.add("active");
    }

    // Always render summary + overview
    renderSummary(report);
    renderOverview(report);

    // Render mode-specific tabs
    if (!visibleTabs || visibleTabs.includes("panel-economy")) renderEconomy(report);
    if (!visibleTabs || visibleTabs.includes("panel-builder")) renderBuilder(report);
    if (!visibleTabs || visibleTabs.includes("panel-buildings")) renderBuildingsOverview(report);
    if (!visibleTabs || visibleTabs.includes("panel-workers")) renderWorkers(report);
    if (!visibleTabs || visibleTabs.includes("panel-army")) renderArmy(report);
    if (!visibleTabs || visibleTabs.includes("panel-storage")) renderStorage(report);
    if (!visibleTabs || visibleTabs.includes("panel-trading")) renderTrading(report);
  });

  // --- Helpers ---

  function fmt(n) {
    if (n == null) return "—";
    const num = typeof n === "string" ? parseFloat(n) : n;
    if (isNaN(num)) return "—";
    return Math.round(num).toLocaleString();
  }

  function fmtSignedFloat(n) {
    if (n == null) return "—";
    const num = typeof n === "string" ? parseFloat(n) : n;
    if (isNaN(num)) return "—";
    const cls = num > 0 ? "val-pos" : num < 0 ? "val-neg" : "val-zero";
    const sign = num > 0 ? "+" : "";
    return `<span class="${cls}">${sign}${num.toFixed(2)}</span>`;
  }

  function fmtSigned(n) {
    if (n == null) return "—";
    const num = typeof n === "string" ? parseFloat(n) : n;
    if (isNaN(num)) return "—";
    const r = Math.round(num);
    const cls = r > 0 ? "val-pos" : r < 0 ? "val-neg" : "val-zero";
    const sign = r > 0 ? "+" : "";
    return `<span class="${cls}">${sign}${r.toLocaleString()}</span>`;
  }

  function fmtTime(endTimestamp) {
    if (!endTimestamp) return null;
    const now = Math.floor(Date.now() / 1000);
    const diff = endTimestamp - now;
    if (diff <= 0) return { text: "Done", cls: "time-done" };
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    let text, cls;
    if (h >= 24) {
      text = Math.floor(h / 24) + "d " + (h % 24) + "h";
      cls = "time-long";
    } else if (h > 0) {
      text = h + "h " + m + "m";
      cls = "time-long";
    } else if (m > 0) {
      text = m + "m " + s + "s";
      cls = diff < 300 ? "time-short" : "time-medium";
    } else {
      text = s + "s";
      cls = "time-short";
    }
    return { text, cls };
  }

  function lvl(level, hi, mid) {
    if (level == null) return '<span class="lvl-no">—</span>';
    const n = parseInt(level, 10);
    let cls = "lvl";
    if (!isNaN(n)) {
      if (n >= (hi || 15)) cls += " lvl-hi";
      else if (n >= (mid || 8)) cls += " lvl-md";
      else cls += " lvl-lo";
    }
    return `<span class="${cls}">${level}</span>`;
  }

  function findBuilding(city, buildingId) {
    return city.buildings.find((b) => b.buildingId === buildingId) || null;
  }

  function getBuildingName(report, buildingId) {
    for (const city of report.cities) {
      const b = findBuilding(city, buildingId);
      if (b && b.name) return b.name;
    }
    return "#" + buildingId;
  }

  function cityNameHtml(city) {
    const cap = city.isCapital ? '<span class="capital-badge">Cap</span>' : "";
    return `<td class="city-name">${city.name}${cap}</td>`;
  }

  // Economy resource cell: stock right-aligned, rate left-aligned in sub-column
  function resCell(stock, perHour) {
    const stockStr = fmt(stock);
    const rateStr = perHour != null ? `${fmtSigned(perHour)}/h` : "";
    return `<td class="right">${stockStr}</td><td class="sub-rate">${rateStr}</td>`;
  }

  // Wine cell with production, consumption, and net
  function wineCell(stock, production, consumption) {
    const stockStr = fmt(stock);
    const net = (production || 0) + (consumption || 0); // consumption is negative
    let rateStr;
    if (production && consumption) {
      rateStr = `<span class="val-pos">+${production}</span> <span class="val-neg">${consumption}</span> = ${fmtSigned(net)}/h`;
    } else if (consumption) {
      rateStr = `${fmtSigned(consumption)}/h`;
    } else if (production) {
      rateStr = `${fmtSigned(production)}/h`;
    } else {
      rateStr = "";
    }
    return `<td class="right">${stockStr}</td><td class="sub-rate">${rateStr}</td>`;
  }

  // --- Summary cards ---
  function renderSummary(report) {
    const container = $("summary-cards");
    const cities = report.cities;
    const g = report.global;

    const netGold = g.income + g.upkeep + g.scientistsUpkeep;

    let totalPop = 0, totalCitizens = 0, totalWinePerHour = 0, totalWoodPerHour = 0;
    for (const c of cities) {
      totalPop += c.population || 0;
      totalCitizens += c.citizens || 0;
      totalWinePerHour += c.winePerHour || 0;
      totalWoodPerHour += c.woodPerHour || 0;
    }

    const constructing = cities.filter((c) => c.construction).length;

    const cards = [
      { label: "Gold", value: fmt(g.gold), sub: fmtSigned(Math.round(netGold)) + "/h net" },
      { label: "Income / h", value: fmtSigned(Math.round(g.income)), sub: "total across all cities" },
      { label: "Army Upkeep / h", value: fmtSigned(Math.round(g.upkeep)), sub: "military + buildings" },
      { label: "Scientists / h", value: fmtSigned(Math.round(g.scientistsUpkeep)), sub: "research cost" },
      { label: "Net Gold / h", value: fmtSigned(Math.round(netGold)), sub: "income + upkeep + sci" },
      { label: "Population", value: fmt(totalPop), sub: fmt(totalCitizens) + " citizens" },
      { label: "Wood / h", value: fmtSigned(totalWoodPerHour), sub: "total production" },
      { label: "Wine / h", value: fmtSigned(Math.round(totalWinePerHour)), sub: "total consumption" },
      { label: "Cities", value: cities.length, sub: constructing + " building" },
    ];

    for (const card of cards) {
      const el = document.createElement("div");
      el.className = "summary-card";
      el.innerHTML = `
        <div class="label">${card.label}</div>
        <div class="value">${card.value}</div>
        <div class="sub">${card.sub}</div>
      `;
      container.appendChild(el);
    }
  }

  const TRADEGOOD_COLORS = { 1: "res-wine", 2: "res-marble", 3: "res-crystal", 4: "res-sulfur" };

  // --- Overview tab ---
  function renderOverview(report) {
    const tbody = $("overview-body");

    for (const city of report.cities) {
      const pop = Math.round(city.population || 0);
      const tg = city.producedTradegood;
      const tgName = TRADEGOOD_NAMES[tg] || "—";
      const tgCls = TRADEGOOD_COLORS[tg] || "";
      const status = city.construction
        ? `<span class="building-active">${city.construction.buildingName}</span>`
        : '<span class="building-idle">Idle</span>';
      const r = city.resources || {};

      const tr = document.createElement("tr");
      tr.innerHTML = `
        ${cityNameHtml(city)}
        <td class="island-name">${city.islandName || "—"}</td>
        <td class="coords">${city.coords || "—"}</td>
        <td class="right">${fmt(pop)}</td>
        <td class="${tgCls}">${tgName}</td>
        <td class="right res-wood">${fmt(r.wood)}</td>
        <td class="right res-wine">${fmt(r.wine)}</td>
        <td class="right res-marble">${fmt(r.marble)}</td>
        <td class="right res-crystal">${fmt(r.crystal)}</td>
        <td class="right res-sulfur">${fmt(r.sulfur)}</td>
        <td>${status}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // --- Economy tab — merged stock+rate columns ---
  function renderEconomy(report) {
    const tbody = $("economy-body");
    const tfoot = $("economy-foot");

    let tWood = 0, tWoodPerH = 0, tWine = 0, tWinePerH = 0;
    let tMarble = 0, tMarblePerH = 0, tCrystal = 0, tCrystalPerH = 0;
    let tSulfur = 0, tSulfurPerH = 0;

    for (const city of report.cities) {
      const r = city.resources || {};
      const woodPerH = city.woodPerHour || 0;
      const winePerH = city.winePerHour || 0;
      const tg = city.producedTradegood;
      const tgPerH = city.tradegoodPerHour || 0;

      // Assign tradegood production to the right column
      let marblePerH = 0, crystalPerH = 0, sulfurPerH = 0;
      if (tg === 2) marblePerH = tgPerH;
      else if (tg === 3) crystalPerH = tgPerH;
      else if (tg === 4) sulfurPerH = tgPerH;
      let wineProduction = 0;
      if (tg === 1) wineProduction = tgPerH;

      tWood += r.wood || 0;
      tWoodPerH += woodPerH;
      tWine += r.wine || 0;
      tWinePerH += winePerH + wineProduction;
      tMarble += r.marble || 0;
      tMarblePerH += marblePerH;
      tCrystal += r.crystal || 0;
      tCrystalPerH += crystalPerH;
      tSulfur += r.sulfur || 0;
      tSulfurPerH += sulfurPerH;

      const netWinePerH = winePerH + wineProduction;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        ${cityNameHtml(city)}
        ${resCell(r.wood, woodPerH)}
        ${wineCell(r.wine, wineProduction || null, winePerH || null)}
        ${resCell(r.marble, marblePerH || null)}
        ${resCell(r.crystal, crystalPerH || null)}
        ${resCell(r.sulfur, sulfurPerH || null)}
      `;
      tbody.appendChild(tr);
    }

    // Track total wine production vs consumption separately
    let tWineProd = 0, tWineCons = 0;
    for (const c of report.cities) {
      if (c.producedTradegood === 1) tWineProd += c.tradegoodPerHour || 0;
      tWineCons += c.winePerHour || 0;
    }

    const footTr = document.createElement("tr");
    footTr.innerHTML = `
      <td>Total</td>
      ${resCell(tWood, tWoodPerH)}
      ${wineCell(tWine, tWineProd || null, tWineCons || null)}
      ${resCell(tMarble, tMarblePerH)}
      ${resCell(tCrystal, tCrystalPerH)}
      ${resCell(tSulfur, tSulfurPerH)}
    `;
    tfoot.appendChild(footTr);
  }

  // --- Builder tab ---
  function renderBuilder(report) {
    const tbody = $("builder-body");
    const activeCities = report.cities.filter((c) => c.construction);

    if (activeCities.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" class="building-idle" style="text-align:center;padding:20px;">No active construction</td>`;
      tbody.appendChild(tr);
      return;
    }

    for (const city of activeCities) {
      const c = city.construction;
      const t = fmtTime(c.endTime);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        ${cityNameHtml(city)}
        <td class="coords">${city.coords}</td>
        <td><span class="building-active">${c.buildingName}</span></td>
        <td>${lvl(c.level)}</td>
        <td>${t ? `<span class="${t.cls}">${t.text}</span>` : "—"}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // --- Buildings overview ---
  function renderBuildingsOverview(report) {
    const container = $("buildings-overview");

    for (const city of report.cities) {
      const cap = city.isCapital ? ' <span class="capital-badge">Cap</span>' : "";
      const header = document.createElement("div");
      header.className = "city-header";
      header.innerHTML = `${city.name}${cap} <span class="coords">${city.coords}</span> <span class="island-name">${city.islandName}</span>`;
      container.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "building-grid";

      // Group buildings by buildingId, combining duplicates
      const shown = new Set();
      const allBids = [...OVERVIEW_BUILDING_IDS];
      // Add any building IDs not in the key list
      for (const b of city.buildings) {
        if (!allBids.includes(b.buildingId)) allBids.push(b.buildingId);
      }

      for (const bid of allBids) {
        const matches = city.buildings.filter((b) => b.buildingId === bid);
        if (matches.length === 0) continue;

        matches.forEach((m) => shown.add(m.position));
        const name = matches[0].name;
        const chip = document.createElement("div");
        chip.className = "building-chip";

        if (matches.length === 1) {
          const b = matches[0];
          const maxTag = b.isMaxLevel ? ' <span style="color:#6fce8c;font-size:9px">MAX</span>' : "";
          chip.innerHTML = `<span class="chip-name">${name}</span><span class="chip-level">Lv ${b.level}${maxTag}</span>`;
        } else {
          // Group by level: "3x Lv5, 2x Lv6"
          const byLevel = {};
          for (const b of matches) {
            byLevel[b.level] = (byLevel[b.level] || 0) + 1;
          }
          const parts = Object.entries(byLevel)
            .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
            .map(([lv, count]) => count + "x Lv" + lv);
          chip.innerHTML = `<span class="chip-name">${name}</span><span class="chip-level">${parts.join(", ")}</span>`;
        }
        grid.appendChild(chip);
      }

      container.appendChild(grid);
    }
  }

  // --- Workers tab ---
  function renderWorkers(report) {
    const tbody = $("workers-body");
    const tfoot = $("workers-foot");

    let tWood = 0, tLux = 0, tSci = 0, tPri = 0;

    for (const city of report.cities) {
      const w = city.workers;
      if (!w) continue;

      tWood += w.wood.assigned;
      tLux += w.luxury.assigned;
      tSci += w.scientists.assigned;
      tPri += w.priests.assigned;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        ${cityNameHtml(city)}
        <td class="right">${w.wood.assigned} / ${w.wood.max}</td>
        <td class="right">${w.luxury.assigned} / ${w.luxury.max}</td>
        <td class="right">${w.scientists.assigned} / ${w.scientists.max}</td>
        <td class="right">${w.priests.assigned} / ${w.priests.max}</td>
        <td class="right">${fmt(city.citizens)}</td>
        <td class="right">${city.occupiedSpace != null ? city.occupiedSpace : "—"} / ${city.maxInhabitants != null ? city.maxInhabitants : "—"}</td>
        <td class="right">${city.growthPerHour != null ? fmtSignedFloat(city.growthPerHour) : "—"}</td>
        <td class="right">${city.happiness != null ? fmt(city.happiness) : "—"}</td>
        <td class="right">${city.cityNetGold != null ? fmtSigned(city.cityNetGold) : "—"}</td>
      `;
      tbody.appendChild(tr);
    }

    const footTr = document.createElement("tr");
    footTr.innerHTML = `
      <td>Total</td>
      <td class="right">${tWood}</td>
      <td class="right">${tLux}</td>
      <td class="right">${tSci}</td>
      <td class="right">${tPri}</td>
      <td class="right" colspan="5"></td>
    `;
    tfoot.appendChild(footTr);
  }

  // --- Army tab ---
  function renderArmy(report) {
    const GROUP_ORDER = ["Infantry", "Siege & Support", "Warships", "Naval Support"];
    const container = $("army-container");

    // Collect all units grouped
    const groupUnits = {}; // group -> [unitName, ...]
    const seen = {};; // group -> Set
    for (const city of report.cities) {
      if (!city.military?.units) continue;
      for (const u of city.military.units) {
        const g = u.group || "Infantry";
        if (!groupUnits[g]) { groupUnits[g] = []; seen[g] = new Set(); }
        if (!seen[g].has(u.name)) {
          seen[g].add(u.name);
          groupUnits[g].push(u.name);
        }
      }
    }

    const activeGroups = GROUP_ORDER.filter((g) => groupUnits[g]?.length > 0);
    if (activeGroups.length === 0) {
      container.innerHTML = '<div class="no-data"><strong>No military data</strong>No units or ships found.</div>';
      return;
    }

    for (const group of activeGroups) {
      const names = groupUnits[group];

      // Group subtitle
      const subtitle = document.createElement("div");
      subtitle.className = "panel-title";
      subtitle.style.fontSize = "13px";
      subtitle.style.marginTop = "16px";
      subtitle.textContent = group;
      container.appendChild(subtitle);

      // Table
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      table.className = "report-table";

      // Header
      const thead = document.createElement("thead");
      const headTr = document.createElement("tr");
      headTr.innerHTML = "<th>City</th>" +
        names.map((n) => `<th class="right">${n}</th>`).join("") +
        '<th class="right">Total</th>';
      thead.appendChild(headTr);
      table.appendChild(thead);

      // Body
      const tbody = document.createElement("tbody");
      const totals = new Array(names.length).fill(0);
      let grandTotal = 0;

      for (const city of report.cities) {
        const unitMap = {};
        let cityTotal = 0;
        if (city.military?.units) {
          for (const u of city.military.units) {
            if ((u.group || "Infantry") === group) {
              unitMap[u.name] = (unitMap[u.name] || 0) + u.count;
              cityTotal += u.count;
            }
          }
        }
        grandTotal += cityTotal;

        const tr = document.createElement("tr");
        let cells = cityNameHtml(city);
        names.forEach((name, i) => {
          const count = unitMap[name] || 0;
          totals[i] += count;
          cells += `<td class="right">${count ? count.toLocaleString() : '<span class="val-zero">—</span>'}</td>`;
        });
        cells += `<td class="right">${cityTotal ? cityTotal.toLocaleString() : '<span class="val-zero">—</span>'}</td>`;
        tr.innerHTML = cells;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      // Footer totals
      const tfoot = document.createElement("tfoot");
      const footTr = document.createElement("tr");
      footTr.innerHTML = "<td>Total</td>" +
        totals.map((t) => `<td class="right">${t ? t.toLocaleString() : "—"}</td>`).join("") +
        `<td class="right">${grandTotal ? grandTotal.toLocaleString() : "—"}</td>`;
      tfoot.appendChild(footTr);
      table.appendChild(tfoot);

      wrap.appendChild(table);
      container.appendChild(wrap);
    }
  }

  // --- Storage tab ---
  function renderStorage(report) {
    const tbody = $("storage-body");

    // Show total stock, lootable amount (red if >0, gray 0 if safe)
    function storageCell(total, lootable) {
      const lootVal = lootable || 0;
      const lootCls = lootVal > 0 ? "val-neg" : "val-zero";
      return `<td class="right">${fmt(total)} <span class="${lootCls}">(${fmt(lootVal)})</span></td>`;
    }

    for (const city of report.cities) {
      const s = city.storage;
      const r = city.resources || {};
      if (!s) continue;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        ${cityNameHtml(city)}
        <td class="right"><span class="val-pos">${fmt(s.safeCapacity)}</span> / ${fmt(s.storageCapacity)}</td>
        ${storageCell(r.wood, s.lootable.wood)}
        ${storageCell(r.wine, s.lootable.wine)}
        ${storageCell(r.marble, s.lootable.marble)}
        ${storageCell(r.crystal, s.lootable.crystal)}
        ${storageCell(r.sulfur, s.lootable.sulfur)}
      `;
      tbody.appendChild(tr);
    }
  }
  // --- Trading tab ---
  function renderTrading(report) {
    const container = $("trading-container");
    const RESOURCES = ["wood", "wine", "marble", "crystal", "sulfur"];
    const RES_LABELS = { wood: "Wood", wine: "Wine", marble: "Marble", crystal: "Crystal", sulfur: "Sulfur" };
    const RES_CLASSES = { wood: "res-wood", wine: "res-wine", marble: "res-marble", crystal: "res-crystal", sulfur: "res-sulfur" };
    const playerName = (report.global.playerName || "").toLowerCase();
    const myCityNames = new Set(report.cities.map((c) => c.name.toLowerCase()));

    // Collect all offers across cities, tagged with source city
    const allOffers = [];
    for (const city of report.cities) {
      if (!city.trading || city.trading.length === 0) continue;
      for (const offer of city.trading) {
        allOffers.push({ ...offer, fromCity: city.name });
      }
    }

    if (allOffers.length === 0) {
      container.innerHTML = '<div class="no-data"><strong>No trading data</strong>No market offers found. Cities may not have a marketplace.</div>';
      return;
    }

    // Deduplicate: same offer seen from multiple of my cities → merge fromCities
    function dedup(offers) {
      const map = new Map();
      for (const o of offers) {
        const key = o.cityName + "|" + o.playerName + "|" + o.quantity + "|" + o.price + "|" + o.resource;
        if (map.has(key)) {
          const existing = map.get(key);
          if (!existing.fromCities.includes(o.fromCity)) existing.fromCities.push(o.fromCity);
        } else {
          map.set(key, { ...o, fromCities: [o.fromCity] });
        }
      }
      return [...map.values()];
    }

    // Detect self: match on player name OR city name belonging to us
    function isSelf(o) {
      if (playerName && o.playerName && o.playerName.toLowerCase() === playerName) return true;
      if (o.cityName && myCityNames.has(o.cityName.toLowerCase())) return true;
      return false;
    }
    const selfOffers = dedup(allOffers.filter(isSelf));
    const otherOffers = dedup(allOffers.filter((o) => !isSelf(o)));

    // Build a consolidated table for a given type (buy/sell)
    function buildTable(type, label, badge, sortFn) {
      const offers = otherOffers.filter((o) => o.type === type);
      if (offers.length === 0) return;

      const header = document.createElement("div");
      header.className = "trade-section-header";
      header.style.marginTop = "20px";
      header.innerHTML = `<span class="trade-type-badge ${badge}">${label}</span>`;
      container.appendChild(header);

      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      table.className = "report-table";

      const thead = document.createElement("thead");
      const goodsMinTh = type === "buy" ? '<th class="right">Goods/min</th>' : "";
      thead.innerHTML = `<tr>
        <th>Resource</th>
        <th>City (Player)</th>
        <th class="right">Quantity</th>
        <th class="right">Price/unit</th>
        <th class="right">Total Gold</th>
        <th class="right">Distance</th>
        ${goodsMinTh}
        <th>My City</th>
      </tr>`;
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      const cls = type === "buy" ? "val-neg" : "val-pos";
      const colSpan = type === "buy" ? 8 : 7;

      for (const res of RESOURCES) {
        const resOffers = offers.filter((o) => o.resource === res).sort(sortFn);
        if (resOffers.length === 0) continue;

        // Resource sub-header row
        const subTr = document.createElement("tr");
        subTr.innerHTML = `<td colspan="${colSpan}" class="${RES_CLASSES[res]}" style="font-weight:600;padding:8px 12px;background:#1a2030;border-bottom:1px solid #2a3040;">${RES_LABELS[res]}</td>`;
        tbody.appendChild(subTr);

        let resQty = 0, resGold = 0;
        for (const o of resOffers) {
          resQty += o.quantity;
          resGold += o.quantity * o.price;
          const tr = document.createElement("tr");
          const goodsMinTd = type === "buy" ? `<td class="right">${o.goodsPerMin || "—"}</td>` : "";
          tr.innerHTML = `
            <td class="${RES_CLASSES[o.resource]}">${RES_LABELS[o.resource]}</td>
            <td>${o.cityName}${o.playerName ? ' <span style="color:#667">(' + o.playerName + ')</span>' : ""}</td>
            <td class="right">${fmt(o.quantity)}</td>
            <td class="right">${fmt(o.price)}</td>
            <td class="right">${fmt(o.quantity * o.price)}</td>
            <td class="right">${o.distance}</td>
            ${goodsMinTd}
            <td>${o.fromCities.join(", ")}</td>
          `;
          tbody.appendChild(tr);
        }

        // Per-resource subtotal
        const footColSpan = type === "buy" ? 3 : 2;
        const subTotal = document.createElement("tr");
        subTotal.innerHTML = `
          <td colspan="2" style="font-weight:600;color:#8890a0;border-top:1px solid #2a3040;">${RES_LABELS[res]} total</td>
          <td class="right" style="font-weight:600;border-top:1px solid #2a3040;">${fmt(resQty)}</td>
          <td style="border-top:1px solid #2a3040;"></td>
          <td class="right" style="font-weight:600;border-top:1px solid #2a3040;"><span class="${cls}">${fmt(resGold)}</span></td>
          <td colspan="${footColSpan}" style="border-top:1px solid #2a3040;"></td>
        `;
        tbody.appendChild(subTotal);
      }
      table.appendChild(tbody);

      wrap.appendChild(table);
      container.appendChild(wrap);
    }

    // Buy table: cheapest first
    buildTable("buy", "Buy from", "trade-type-buy", (a, b) => a.price - b.price);
    // Sell table: highest price first
    buildTable("sell", "Sell to", "trade-type-sell", (a, b) => b.price - a.price);

    // My Offers section (self-trades visible in own markets)
    if (selfOffers.length > 0) {
      const header = document.createElement("div");
      header.className = "trade-section-header";
      header.style.marginTop = "20px";
      header.innerHTML = '<span class="trade-type-badge" style="background:rgba(160,136,80,0.15);color:#a08850;border:1px solid rgba(160,136,80,0.3);">My Offers</span>';
      container.appendChild(header);

      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      table.className = "report-table";

      const thead = document.createElement("thead");
      thead.innerHTML = `<tr>
        <th>Type</th>
        <th>Resource</th>
        <th>City</th>
        <th class="right">Quantity</th>
        <th class="right">Price/unit</th>
        <th class="right">Total Gold</th>
        <th>Seen from</th>
      </tr>`;
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const o of selfOffers) {
        const typeBadge = o.type === "buy"
          ? '<span class="trade-type-badge trade-type-buy">Buy</span>'
          : '<span class="trade-type-badge trade-type-sell">Sell</span>';
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${typeBadge}</td>
          <td class="${RES_CLASSES[o.resource]}">${RES_LABELS[o.resource]}</td>
          <td>${o.cityName}</td>
          <td class="right">${fmt(o.quantity)}</td>
          <td class="right">${fmt(o.price)}</td>
          <td class="right">${fmt(o.quantity * o.price)}</td>
          <td>${o.fromCities.join(", ")}</td>
        `;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      wrap.appendChild(table);
      container.appendChild(wrap);
    }
  }
})();

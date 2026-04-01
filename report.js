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

  // Determine storage key — world-scoped if URL param is present, else legacy global
  const reportWorldParam = new URLSearchParams(location.search).get("world");
  const reportStorageKey = reportWorldParam
    ? "advisorReportData_" + reportWorldParam
    : "advisorReportData";

  chrome.storage.local.get([reportStorageKey, "advisorReportData"], (data) => {
    const report = data[reportStorageKey] || data.advisorReportData;
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
      basic: ["panel-overview", "panel-economy", "panel-builder", "panel-buildings"],
      workers: ["panel-overview", "panel-economy", "panel-workers"],
      storage: ["panel-overview", "panel-economy", "panel-storage"],
      army: ["panel-overview", "panel-economy", "panel-army"],
      trading: ["panel-overview", "panel-economy", "panel-trading"],
      spy: ["panel-overview", "panel-economy", "panel-spy"],
      full: null, // show all
    };
    const visibleTabs = MODE_TABS[report.mode] || null;

    if (visibleTabs) {
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        if (!visibleTabs.includes(btn.dataset.tab)) btn.style.display = "none";
      });
      // Default to the second tab (the mode-specific one)
      const defaultTab = report.mode === "basic" ? visibleTabs[0] : visibleTabs[visibleTabs.length - 1];
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
    if (!visibleTabs || visibleTabs.includes("panel-spy")) renderSpy(report);
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

  function fmtDuration(seconds) {
    if (!seconds || seconds <= 0) return "0h";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return d + "d " + h + "h";
    return h + "h";
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

    let totalPop = 0, totalCitizens = 0, totalWineCons = 0, totalWineProd = 0, totalWoodPerHour = 0;
    for (const c of cities) {
      totalPop += c.population || 0;
      totalCitizens += c.citizens || 0;
      totalWineCons += c.winePerHour || 0;
      totalWoodPerHour += c.woodPerHour || 0;
      if (c.producedTradegood === 1) totalWineProd += c.tradegoodPerHour || 0;
    }
    const totalWineNet = totalWineProd + totalWineCons; // consumption is negative

    const constructing = cities.filter((c) => c.construction).length;

    const cards = [
      { label: "Gold", value: fmt(g.gold), sub: fmtSigned(Math.round(netGold)) + "/h net" +
        (netGold < 0 ? " — lasts ~" + fmtDuration(Math.round(g.gold / -netGold * 3600)) : "") },
      { label: "Income / h", value: fmtSigned(Math.round(g.income)), sub: "total across all cities" },
      { label: "Army Upkeep / h", value: fmtSigned(Math.round(g.upkeep)), sub: "military + buildings" },
      { label: "Scientists / h", value: fmtSigned(Math.round(g.scientistsUpkeep)), sub: "research cost" },
      { label: "Net Gold / h", value: fmtSigned(Math.round(netGold)), sub: "income + upkeep + sci" },
      { label: "Population", value: fmt(totalPop), sub: fmt(totalCitizens) + " citizens" },
      { label: "Wood / h", value: fmtSigned(totalWoodPerHour), sub: "total production" },
      { label: "Wine / h", value: fmtSigned(Math.round(totalWineNet)), sub: `<span class="val-pos">+${Math.round(totalWineProd)}</span> <span class="val-neg">${Math.round(totalWineCons)}</span>` },
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

    let tWood = 0, tWine = 0, tMarble = 0, tCrystal = 0, tSulfur = 0;

    for (const city of report.cities) {
      const pop = Math.round(city.population || 0);
      const tg = city.producedTradegood;
      const tgName = TRADEGOOD_NAMES[tg] || "—";
      const tgCls = TRADEGOOD_COLORS[tg] || "";
      const status = city.construction
        ? `<span class="building-active">${city.construction.buildingName}</span>`
        : '<span class="building-idle">Idle</span>';
      const r = city.resources || {};

      tWood += r.wood || 0;
      tWine += r.wine || 0;
      tMarble += r.marble || 0;
      tCrystal += r.crystal || 0;
      tSulfur += r.sulfur || 0;

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

    const tfoot = $("overview-foot");
    const footTr = document.createElement("tr");
    footTr.innerHTML = `
      <td>Total</td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td class="right res-wood">${fmt(tWood)}</td>
      <td class="right res-wine">${fmt(tWine)}</td>
      <td class="right res-marble">${fmt(tMarble)}</td>
      <td class="right res-crystal">${fmt(tCrystal)}</td>
      <td class="right res-sulfur">${fmt(tSulfur)}</td>
      <td></td>
    `;
    tfoot.appendChild(footTr);
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
    let tWoodProd = 0, tLuxProd = 0;

    function workerCell(assigned, max, om) {
      if (om && om.overwork > 0) {
        const total = om.normalWorkers + om.overwork;
        return `<td class="right" style="color:#e8a735;">${total} (${om.normalWorkers}+${om.overwork}) / ${max}</td>`;
      }
      return `<td class="right">${assigned} / ${max}</td>`;
    }

    function prodCell(data) {
      if (!data || data.prodPerHour == null) return '<td class="right">—</td>';
      return `<td class="right">${fmt(data.prodPerHour)}</td>`;
    }

    for (const city of report.cities) {
      const w = city.workers;
      if (!w) continue;

      tWood += w.wood.assigned;
      tLux += w.luxury.assigned;
      tSci += w.scientists.assigned;
      tPri += w.priests.assigned;

      const om = city.overmine || {};
      if (om.wood?.prodPerHour) tWoodProd += om.wood.prodPerHour;
      if (om.luxury?.prodPerHour) tLuxProd += om.luxury.prodPerHour;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        ${cityNameHtml(city)}
        ${workerCell(w.wood.assigned, w.wood.max, om.wood)}
        ${prodCell(om.wood)}
        ${workerCell(w.luxury.assigned, w.luxury.max, om.luxury)}
        ${prodCell(om.luxury)}
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
      <td class="right">${fmt(tWoodProd)}</td>
      <td class="right">${tLux}</td>
      <td class="right">${fmt(tLuxProd)}</td>
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

    // Active movements with units — shown first
    renderMilitaryMovements(report, container);

    // Collect all units grouped
    const groupUnits = {}; // group -> [unitName, ...]
    const seen = {}; // group -> Set
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
      if (container.children.length === 0) {
        container.innerHTML = '<div class="no-data"><strong>No military data</strong>No units or ships found.</div>';
      }
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

  function renderMilitaryMovements(report, container) {
    if (!report.militaryMovements || report.militaryMovements.length === 0) return;
    // Only show movements that have ground units
    const movements = report.militaryMovements.filter(
      (m) => m.units.some((u) => u.type === "unit")
    );
    if (movements.length === 0) return;

    const MISSION_LABELS = {
      transport: "Transport", deployarmy: "Deploy Army", deployfleet: "Deploy Fleet",
      trade: "Trade", transport_barbarians: "Barbarian Transport", defend: "Defend",
      defend_port: "Defend Port", plunder: "Plunder", occupy: "Occupy",
      blockade: "Blockade", barbarianFleet: "Barbarian Fleet", piracyRaid: "Piracy Raid",
    };

    const title = document.createElement("div");
    title.className = "panel-title";
    title.style.marginTop = "24px";
    title.textContent = "Active Movements (" + movements.length + ")";
    container.appendChild(title);

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "report-table";

    const thead = document.createElement("thead");
    const headTr = document.createElement("tr");
    headTr.innerHTML = "<th>Mission</th><th>Direction</th><th>From</th><th>To</th><th>ETA</th><th>Units</th><th class=\"right\">Cargo</th>";
    thead.appendChild(headTr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    // Tally units in transit per origin city for summary
    const inTransitByCityId = {};

    for (const m of movements) {
      const tr = document.createElement("tr");
      const label = MISSION_LABELS[m.missionType] || m.missionType;
      const dir = m.isReturning ? "← Returning" : "→ Outbound";
      const dirClass = m.isReturning ? "val-pos" : "val-neg";

      // Format units
      const unitParts = m.units
        .filter((u) => u.type === "unit")
        .map((u) => u.count + " " + u.name);
      const shipParts = m.units
        .filter((u) => u.type === "ship")
        .map((u) => u.count + " " + u.name);
      const unitStr = [...shipParts, ...unitParts].join(", ") || "—";

      // Format cargo
      const cargoParts = m.resources.map((r) => fmt(r.amount) + " " + r.type);
      const cargoStr = cargoParts.join(", ") || "—";

      tr.innerHTML = `
        <td>${label}</td>
        <td><span class="${dirClass}">${dir}</span></td>
        <td>${m.origin.city}${m.origin.player ? " (" + m.origin.player + ")" : ""}</td>
        <td>${m.target.city}${m.target.player ? " (" + m.target.player + ")" : ""}</td>
        <td>${m.countdown || m.arrivalTime || "—"}</td>
        <td>${unitStr}</td>
        <td class="right">${cargoStr}</td>`;
      tbody.appendChild(tr);

      // Track units in transit — attribute to origin city if returning, target if outbound
      const cityId = m.isReturning ? m.origin.cityId : null;
      if (cityId) {
        if (!inTransitByCityId[cityId]) inTransitByCityId[cityId] = [];
        for (const u of m.units.filter((u) => u.type === "unit")) {
          inTransitByCityId[cityId].push(u);
        }
      }
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    // Show in-transit summary if any units are moving
    const transitUnits = movements.flatMap((m) => m.units.filter((u) => u.type === "unit"));
    if (transitUnits.length > 0) {
      const summary = document.createElement("div");
      summary.style.cssText = "margin-top: 8px; font-size: 12px; color: #888;";
      const totals = {};
      for (const u of transitUnits) {
        totals[u.name] = (totals[u.name] || 0) + u.count;
      }
      const parts = Object.entries(totals).map(([name, count]) => count.toLocaleString() + " " + name);
      summary.textContent = "Total units in transit: " + parts.join(", ");
      container.appendChild(summary);
    }
  }

  // --- Storage tab ---
  function renderStorage(report) {
    const tbody = $("storage-body");

    // Green (+remaining) when safe, red (lootable) when overflowing
    function storageCell(total, safe, lootable) {
      const lootVal = lootable || 0;
      if (lootVal > 0) {
        return `<td class="right">${fmt(total)} <span class="val-neg">(${fmt(lootVal)})</span></td>`;
      }
      const remaining = Math.max(0, (safe || 0) - (total || 0));
      return `<td class="right">${fmt(total)} <span class="val-pos">(+${fmt(remaining)})</span></td>`;
    }

    let tWood = 0, tWine = 0, tMarble = 0, tCrystal = 0, tSulfur = 0;

    for (const city of report.cities) {
      const s = city.storage;
      const r = city.resources || {};
      if (!s) continue;

      tWood += r.wood || 0;
      tWine += r.wine || 0;
      tMarble += r.marble || 0;
      tCrystal += r.crystal || 0;
      tSulfur += r.sulfur || 0;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        ${cityNameHtml(city)}
        <td class="right"><span class="val-pos">${fmt(s.safeCapacity)}</span> / ${fmt(s.storageCapacity)}</td>
        ${storageCell(r.wood, s.safe.wood, s.lootable.wood)}
        ${storageCell(r.wine, s.safe.wine, s.lootable.wine)}
        ${storageCell(r.marble, s.safe.marble, s.lootable.marble)}
        ${storageCell(r.crystal, s.safe.crystal, s.lootable.crystal)}
        ${storageCell(r.sulfur, s.safe.sulfur, s.lootable.sulfur)}
      `;
      tbody.appendChild(tr);
    }

    const tfoot = $("storage-foot");
    const footTr = document.createElement("tr");
    footTr.innerHTML = `
      <td>Total</td>
      <td></td>
      <td class="right">${fmt(tWood)}</td>
      <td class="right">${fmt(tWine)}</td>
      <td class="right">${fmt(tMarble)}</td>
      <td class="right">${fmt(tCrystal)}</td>
      <td class="right">${fmt(tSulfur)}</td>
    `;
    tfoot.appendChild(footTr);
  }
  // --- Trading tab ---
  function renderConvoys(report, container, RES_LABELS, RES_CLASSES) {
    const movements = report.militaryMovements;
    if (!movements || movements.length === 0) return;

    // Filter to movements carrying resources
    const convoys = movements.filter((m) => m.resources && m.resources.length > 0);
    if (convoys.length === 0) return;

    const MISSION_LABELS = {
      transport: "Transport", deployarmy: "Deploy Army", deployfleet: "Deploy Fleet",
      trade: "Trade", transport_barbarians: "Barbarian Transport", plunder: "Plunder",
      defend: "Defend", defend_port: "Defend Port", occupy: "Occupy",
      blockade: "Blockade", barbarianFleet: "Barbarian Fleet", piracyRaid: "Piracy Raid",
    };

    const header = document.createElement("div");
    header.className = "trade-section-header";
    header.innerHTML = '<span class="trade-type-badge" style="background:rgba(80,160,200,0.15);color:#50a0c8;border:1px solid rgba(80,160,200,0.3);">Active Convoys (' + convoys.length + ')</span>';
    container.appendChild(header);

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "report-table";

    const thead = document.createElement("thead");
    thead.innerHTML = `<tr>
      <th>Mission</th>
      <th>From</th>
      <th>To</th>
      <th>ETA</th>
      <th class="right">Wood</th>
      <th class="right">Wine</th>
      <th class="right">Marble</th>
      <th class="right">Crystal</th>
      <th class="right">Sulfur</th>
      <th class="right">Gold</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const totals = { wood: 0, wine: 0, marble: 0, crystal: 0, sulfur: 0, gold: 0 };
    // Map game resource names to our labels
    const RES_MAP = { wood: "wood", wine: "wine", marble: "marble", glass: "crystal", crystal: "crystal", sulfur: "sulfur", gold: "gold" };

    for (const m of convoys) {
      const tr = document.createElement("tr");
      const label = MISSION_LABELS[m.missionType] || m.missionType;
      const dir = m.isReturning ? " ←" : " →";
      const dirClass = m.isReturning ? "val-pos" : "";

      // Build resource map for this convoy
      const res = {};
      for (const r of m.resources) {
        const key = RES_MAP[r.type] || r.type;
        res[key] = (res[key] || 0) + r.amount;
        const totKey = RES_MAP[r.type] || r.type;
        if (totals[totKey] !== undefined) totals[totKey] += r.amount;
      }

      function resCell(key) {
        const val = res[key] || 0;
        const cls = RES_CLASSES[key] || "";
        return val ? `<td class="right ${cls}">${fmt(val)}</td>` : '<td class="right"><span class="val-zero">—</span></td>';
      }

      tr.innerHTML = `
        <td><span class="${dirClass}">${label}${dir}</span></td>
        <td>${m.origin.city}${m.origin.player ? ' <span style="color:#667">(' + m.origin.player + ')</span>' : ""}</td>
        <td>${m.target.city}${m.target.player ? ' <span style="color:#667">(' + m.target.player + ')</span>' : ""}</td>
        <td>${m.countdown || m.arrivalTime || "—"}</td>
        ${resCell("wood")}
        ${resCell("wine")}
        ${resCell("marble")}
        ${resCell("crystal")}
        ${resCell("sulfur")}
        ${resCell("gold")}
      `;
      tbody.appendChild(tr);
    }

    // Totals footer
    const tfoot = document.createElement("tfoot");
    const footTr = document.createElement("tr");
    function totalCell(key, totKey) {
      const val = totals[totKey || key] || 0;
      return val ? `<td class="right">${fmt(val)}</td>` : '<td class="right">—</td>';
    }
    footTr.innerHTML = `
      <td colspan="4">Total in transit</td>
      ${totalCell("wood", "wood")}
      ${totalCell("wine", "wine")}
      ${totalCell("marble", "marble")}
      ${totalCell("crystal", "crystal")}
      ${totalCell("sulfur", "sulfur")}
      ${totalCell("gold", "gold")}
    `;
    tfoot.appendChild(footTr);

    table.appendChild(tbody);
    table.appendChild(tfoot);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  function renderTrading(report) {
    const container = $("trading-container");
    const RESOURCES = ["wood", "wine", "marble", "crystal", "sulfur"];
    const RES_LABELS = { wood: "Wood", wine: "Wine", marble: "Marble", crystal: "Crystal", sulfur: "Sulfur" };
    const RES_CLASSES = { wood: "res-wood", wine: "res-wine", marble: "res-marble", crystal: "res-crystal", sulfur: "res-sulfur" };
    const RES_IDX = { wood: 0, wine: 1, marble: 2, crystal: 3, sulfur: 4 };
    const playerName = (report.global.playerName || "").toLowerCase();

    // Load history then render everything
    renderTradingAsync(report, container, RESOURCES, RES_LABELS, RES_CLASSES, RES_IDX, playerName);
  }

  async function renderTradingAsync(report, container, RESOURCES, RES_LABELS, RES_CLASSES, RES_IDX, playerName) {
    // Load history (30 days covers both 7d and 30d views)
    let historySnapshots = [];
    if (typeof TradeHistory !== "undefined" && report.world && report.avatarId) {
      try {
        historySnapshots = await TradeHistory.loadHistory(report.world, report.avatarId, 30);
      } catch (e) {
        console.error("[Report] Failed to load trade history:", e);
      }
    }

    const hasHistory = historySnapshots.length > 0 && typeof TradeChart !== "undefined";

    // Compute history stats for badges (all 30 days)
    let historyStats = null;
    if (hasHistory) {
      historyStats = {};
      for (const res of RESOURCES) {
        historyStats[res] = {};
        for (const side of ["ask", "bid"]) {
          const seriesData = TradeChart.extractSeriesData(historySnapshots, RES_IDX[res], side, false, { minQty: 1000 });
          if (seriesData.length > 0) {
            const allMedians = seriesData.map((s) => s.median).sort((a, b) => a - b);
            const allPlayers = new Set();
            seriesData.forEach((s) => s.offers.forEach((o) => { if (o.pl) allPlayers.add(o.pl); }));
            // Historical best: for "bid" (buy-from) = lowest min seen, for "ask" (sell-to) = highest max seen
            const histBest = side === "bid"
              ? Math.min(...seriesData.map((s) => s.min))
              : Math.max(...seriesData.map((s) => s.max));
            historyStats[res][side] = {
              medians: allMedians,
              overallMedian: TradeHistory.percentile(allMedians, 50),
              players: allPlayers,
              histBest,
            };
          }
        }
      }
    }

    // Convoys go above the two-column layout
    renderConvoys(report, container, RES_LABELS, RES_CLASSES);

    // Collect and dedup current offers
    const allOffers = [];
    for (const city of report.cities) {
      if (!city.trading || city.trading.length === 0) continue;
      for (const offer of city.trading) {
        allOffers.push({ ...offer, fromCity: city.name });
      }
    }

    if (allOffers.length === 0 && !hasHistory) {
      container.innerHTML += '<div class="no-data"><strong>No trading data</strong>No market offers found. Cities may not have a marketplace.</div>';
      return;
    }

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

    function isSelf(o) {
      return playerName && o.playerName && o.playerName.toLowerCase() === playerName;
    }
    const selfOffers = dedup(allOffers.filter(isSelf));
    const otherOffers = dedup(allOffers.filter((o) => !isSelf(o)));

    // Controls bar (shared state for all resource charts)
    let timeframeDays = 7;
    let timeframeRaw = false;
    let showScatter = false;
    let includeOwn = false;
    const refreshFns = []; // each resource block registers its refresh

    if (hasHistory) {
      const controls = document.createElement("div");
      controls.className = "history-controls";

      const tfWrap = document.createElement("div");
      tfWrap.className = "timeframe-btns";
      const timeframes = [
        { days: 1, label: "24h", raw: true },
        { days: 7, label: "7d", raw: false },
        { days: 30, label: "30d", raw: false },
      ];
      for (const tf of timeframes) {
        const btn = document.createElement("button");
        btn.className = "tf-btn" + (tf.days === timeframeDays && tf.raw === timeframeRaw ? " active" : "");
        btn.textContent = tf.label;
        btn.addEventListener("click", () => {
          timeframeDays = tf.days;
          timeframeRaw = tf.raw;
          tfWrap.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          refreshFns.forEach((fn) => fn());
        });
        tfWrap.appendChild(btn);
      }
      controls.appendChild(tfWrap);

      const scatterLabel = document.createElement("label");
      scatterLabel.className = "history-toggle";
      const scatterCb = document.createElement("input");
      scatterCb.type = "checkbox";
      scatterCb.addEventListener("change", () => { showScatter = scatterCb.checked; refreshFns.forEach((fn) => fn()); });
      scatterLabel.appendChild(scatterCb);
      scatterLabel.appendChild(document.createTextNode("Show offers"));
      controls.appendChild(scatterLabel);

      const ownLabel = document.createElement("label");
      ownLabel.className = "history-toggle";
      const ownCb = document.createElement("input");
      ownCb.type = "checkbox";
      ownCb.addEventListener("change", () => { includeOwn = ownCb.checked; refreshFns.forEach((fn) => fn()); });
      ownLabel.appendChild(ownCb);
      ownLabel.appendChild(document.createTextNode("Include own offers"));
      controls.appendChild(ownLabel);

      container.appendChild(controls);
    }

    // Per-resource rows: 4 columns each (ask chart | bid chart | sell-to table | buy-from table)
    for (const res of RESOURCES) {
      const resIdx = RES_IDX[res];
      // type "sell"(333) → "Sell to" table → highest price first (you want to sell high)
      // type "buy"(444) → "Buy from" table → cheapest price first (you want to buy cheap)
      const sellOffers = otherOffers.filter((o) => o.type === "sell" && o.resource === res).sort((a, b) => b.price - a.price);
      const buyOffers = otherOffers.filter((o) => o.type === "buy" && o.resource === res).sort((a, b) => a.price - b.price);

      if (sellOffers.length === 0 && buyOffers.length === 0 && !hasHistory) continue;

      const row = document.createElement("div");
      row.className = "res-row";

      const header = document.createElement("div");
      header.className = "res-row-header " + RES_CLASSES[res];
      header.textContent = RES_LABELS[res];
      row.appendChild(header);

      const sides = document.createElement("div");
      sides.className = "res-row-sides";

      // Left side: Buy from
      const buySide = document.createElement("div");
      buySide.className = "res-side";
      const buyTitle = document.createElement("div");
      buyTitle.className = "res-side-title";
      buyTitle.innerHTML = '<span class="trade-type-badge trade-type-buy">Buy from</span> — prices you can buy at';
      buySide.appendChild(buyTitle);

      const buyCols = document.createElement("div");
      buyCols.className = "res-side-cols";

      const buyChartCol = document.createElement("div");
      if (hasHistory) {
        const wrap = document.createElement("div");
        wrap.className = "chart-wrap";
        const canvas = document.createElement("canvas");
        canvas.style.display = "block";
        const tooltip = document.createElement("div");
        tooltip.className = "chart-tooltip";
        wrap.appendChild(canvas);
        wrap.appendChild(tooltip);
        buyChartCol.appendChild(wrap);

        const summaryDiv = document.createElement("div");
        summaryDiv.className = "history-summary";
        summaryDiv.style.marginTop = "8px";
        buyChartCol.appendChild(summaryDiv);

        const refreshBuy = () => {
          const cutoff = Date.now() - timeframeDays * 24 * 60 * 60 * 1000;
          const filtered = historySnapshots.filter((s) => s.ts >= cutoff);
          const opts = { showScatter, includeOwn, minQty: 1000, raw: timeframeRaw };
          const hits = TradeChart.drawIQRChart(canvas, filtered, resIdx, "bid", opts);
          TradeChart.setupHover(canvas, hits, tooltip);
          renderHistorySummaryOneSide(summaryDiv, filtered, resIdx, "bid");
        };
        refreshFns.push(refreshBuy);
      }
      buyCols.appendChild(buyChartCol);

      const buyTableCol = document.createElement("div");
      buildOfferTable(buyTableCol, "buy", null, "trade-type-buy", buyOffers, res, historyStats);
      buyCols.appendChild(buyTableCol);

      buySide.appendChild(buyCols);
      sides.appendChild(buySide);

      // Right side: Sell to
      const sellSide = document.createElement("div");
      sellSide.className = "res-side";
      const sellTitle = document.createElement("div");
      sellTitle.className = "res-side-title";
      sellTitle.innerHTML = '<span class="trade-type-badge trade-type-sell">Sell to</span> — prices you can sell at';
      sellSide.appendChild(sellTitle);

      const sellCols = document.createElement("div");
      sellCols.className = "res-side-cols";

      const sellChartCol = document.createElement("div");
      if (hasHistory) {
        const wrap = document.createElement("div");
        wrap.className = "chart-wrap";
        const canvas = document.createElement("canvas");
        canvas.style.display = "block";
        const tooltip = document.createElement("div");
        tooltip.className = "chart-tooltip";
        wrap.appendChild(canvas);
        wrap.appendChild(tooltip);
        sellChartCol.appendChild(wrap);

        const summaryDiv = document.createElement("div");
        summaryDiv.className = "history-summary";
        summaryDiv.style.marginTop = "8px";
        sellChartCol.appendChild(summaryDiv);

        const refreshSell = () => {
          const cutoff = Date.now() - timeframeDays * 24 * 60 * 60 * 1000;
          const filtered = historySnapshots.filter((s) => s.ts >= cutoff);
          const opts = { showScatter, includeOwn, minQty: 1000, raw: timeframeRaw };
          const hits = TradeChart.drawIQRChart(canvas, filtered, resIdx, "ask", opts);
          TradeChart.setupHover(canvas, hits, tooltip);
          renderHistorySummaryOneSide(summaryDiv, filtered, resIdx, "ask");
        };
        refreshFns.push(refreshSell);
      }
      sellCols.appendChild(sellChartCol);

      const sellTableCol = document.createElement("div");
      buildOfferTable(sellTableCol, "sell", null, "trade-type-sell", sellOffers, res, historyStats);
      sellCols.appendChild(sellTableCol);

      sellSide.appendChild(sellCols);
      sides.appendChild(sellSide);

      row.appendChild(sides);
      container.appendChild(row);
    }

    // Disclaimer
    if (hasHistory) {
      const disclaimer = document.createElement("div");
      disclaimer.className = "chart-disclaimer";
      disclaimer.textContent = "History reflects listed market offers seen during scans, not completed transactions. Offers under 1,000 qty excluded from charts.";
      container.appendChild(disclaimer);
    }

    // My offers section
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

    // Deferred initial chart render — DOM must have layout first
    if (refreshFns.length > 0) {
      requestAnimationFrame(() => refreshFns.forEach((fn) => fn()));
    }
  }

  // Build an offer table into a container element
  function buildOfferTable(parent, type, label, badge, resOffers, res, historyStats) {
    const side = type === "sell" ? "ask" : "bid";
    const hStats = historyStats?.[res]?.[side];
    const histMedian = hStats?.overallMedian;

    if (resOffers.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#445;font-size:11px;padding:8px 0;";
      empty.textContent = "No offers";
      parent.appendChild(empty);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "report-table";

    const thead = document.createElement("thead");
    const goodsMinTh = type === "buy" ? '<th class="right">G/min</th>' : "";
    thead.innerHTML = `<tr>
      <th>Player</th>
      <th class="right">Qty</th>
      <th class="right">Price</th>
      <th class="right">Total</th>
      <th class="right">Dist</th>
      ${goodsMinTh}
      <th>My City</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    const histBest = hStats?.histBest;

    let resQty = 0, resGold = 0;
    for (const o of resOffers) {
      resQty += o.quantity;
      resGold += o.quantity * o.price;
      const tr = document.createElement("tr");

      // Highlight if matching or beating historical best (ignore tiny offers)
      if (histBest != null && o.quantity >= 1000) {
        const isBest = side === "bid" ? o.price <= histBest : o.price >= histBest;
        if (isBest) tr.style.cssText = "background:rgba(111,206,140,0.08);";
      }

      const goodsMinTd = type === "buy" ? `<td class="right">${o.goodsPerMin || "—"}</td>` : "";

      let badges = "";
      if (histMedian != null && histMedian > 0) {
        const ratio = o.price / histMedian;
        if (side === "ask") {
          // "Sell to" table — you're selling, high price = good
          if (ratio > 1.15) badges += '<span class="offer-badge badge-cheap">GOOD</span>';
          else if (ratio < 0.85) badges += '<span class="offer-badge badge-expensive">LOW</span>';
        } else {
          // "Buy from" table — you're buying, low price = good
          if (ratio < 0.85) badges += '<span class="offer-badge badge-cheap">CHEAP</span>';
          else if (ratio > 1.15) badges += '<span class="offer-badge badge-expensive">EXPENSIVE</span>';
        }
      }
      if (hStats && o.playerName && !hStats.players.has(o.playerName)) {
        badges += '<span class="offer-badge badge-new">NEW</span>';
      }

      tr.innerHTML = `
        <td>${o.cityName}${o.playerName ? ' <span style="color:#667">(' + o.playerName + ')</span>' : ""}${badges}</td>
        <td class="right">${fmt(o.quantity)}</td>
        <td class="right">${fmt(o.price)}</td>
        <td class="right">${fmt(o.quantity * o.price)}</td>
        <td class="right">${o.distance}</td>
        ${goodsMinTd}
        <td>${o.fromCities.join(", ")}</td>
      `;
      tbody.appendChild(tr);
    }

    // Subtotal
    const cls = type === "buy" ? "val-neg" : "val-pos";
    const footColSpan = type === "buy" ? 3 : 2;
    const subTotal = document.createElement("tr");
    subTotal.innerHTML = `
      <td style="font-weight:600;color:#8890a0;border-top:1px solid #2a3040;">Total</td>
      <td class="right" style="font-weight:600;border-top:1px solid #2a3040;">${fmt(resQty)}</td>
      <td style="border-top:1px solid #2a3040;"></td>
      <td class="right" style="font-weight:600;border-top:1px solid #2a3040;"><span class="${cls}">${fmt(resGold)}</span></td>
      <td colspan="${footColSpan}" style="border-top:1px solid #2a3040;"></td>
    `;
    tbody.appendChild(subTotal);
    table.appendChild(tbody);

    wrap.appendChild(table);
    parent.appendChild(wrap);
  }

  // --- History summary cards for a single resource ---

  function renderHistorySummaryOneSide(container, snapshots, resIdx, side) {
    container.innerHTML = "";
    if (snapshots.length === 0) return;

    // Filter to offers >= 1k qty for the card
    const latest = snapshots[snapshots.length - 1];
    const latestOffers = latest.offers.filter((o) => o.r === resIdx && o.s === side && o.q >= 1000);
    if (latestOffers.length === 0) return;

    const latestPrices = latestOffers.map((o) => o.p).sort((a, b) => a - b);

    // Collect medians from series (already filtered by minQty via extractSeriesData upstream)
    const seriesData = typeof TradeChart !== "undefined"
      ? TradeChart.extractSeriesData(snapshots, resIdx, side, false, { minQty: 1000 })
      : [];
    const medians = seriesData.map((s) => s.median).sort((a, b) => a - b);

    function medianVal(sorted) {
      if (sorted.length === 0) return null;
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    const hm = medianVal(medians);
    // "bid" side is our Buy-from chart → best for user = cheapest
    // "ask" side is our Sell-to chart → best for user = highest
    const bestForUser = side === "bid" ? latestPrices[0] : latestPrices[latestPrices.length - 1];
    let count = 0;
    for (const v of medians) { if (v <= bestForUser) count++; }
    const pct = Math.round((count / medians.length) * 100);

    const label = "Best";
    let sub = "";
    if (hm != null) sub = `Med: ${hm}`;
    if (side === "bid") sub += ` · &lt; ${100 - pct}%`;
    else sub += ` · &gt; ${pct}%`;

    container.innerHTML =
      `<div class="hs-card"><div class="hs-label">${label}</div><div class="hs-value">${bestForUser}</div><div class="hs-sub">${sub}</div></div>`;
  }

  // --- Spy ---

  function renderSpy(report) {
    const container = $("spy-container");
    if (!container) return;

    const hasSpy = report.cities.some((c) => c.spy);
    if (!hasSpy) {
      container.innerHTML = '<div class="no-data"><strong>No spy data</strong>No cities have a safehouse, or spy data was not collected.</div>';
      return;
    }

    // Overview table
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "report-table";

    const thead = document.createElement("thead");
    thead.innerHTML = `<tr>
      <th>City</th>
      <th class="right">Safehouse Lv</th>
      <th class="right">Capacity</th>
      <th class="right">Waiting</th>
      <th class="right">Defense</th>
      <th class="right">In Use</th>
      <th class="right">Missions</th>
      <th>Enemy Spies</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    let totCap = 0, totTrained = 0, totWait = 0, totDef = 0, totUse = 0, totMissions = 0, totEnemy = 0;

    function capHtml(trained, max) {
      if (max === 0) return '<span class="val-zero">0 / 0</span>';
      const cls = trained >= max ? "val-pos" : "val-neg";
      return `<span class="${cls}">${trained} / ${max}</span>`;
    }

    for (const c of report.cities) {
      const tr = document.createElement("tr");
      const nameHtml = `<span class="city-name">${c.name}</span>${c.isCapital ? '<span class="capital-badge">Capital</span>' : ""}`;

      if (c.spy) {
        const s = c.spy;
        const trained = s.waiting + s.defense + s.inUse;
        totCap += s.canTrain;
        totTrained += trained;
        totWait += s.waiting;
        totDef += s.defense;
        totUse += s.inUse;
        totMissions += s.missions.length;

        const enemyHtml = c.spiesInside
          ? `<span class="spy-badge spy-badge-alert">! ${c.spiesInside}</span>`
          : '<span class="val-zero">—</span>';
        if (c.spiesInside) totEnemy++;

        tr.innerHTML = `
          <td>${nameHtml}</td>
          <td class="right"><span class="lvl">${s.safehouseLevel}</span></td>
          <td class="right">${capHtml(trained, s.canTrain)}</td>
          <td class="right">${s.waiting || '<span class="val-zero">0</span>'}</td>
          <td class="right">${s.defense || '<span class="val-zero">0</span>'}</td>
          <td class="right">${s.inUse || '<span class="val-zero">0</span>'}</td>
          <td class="right">${s.missions.length || '<span class="val-zero">0</span>'}</td>
          <td>${enemyHtml}</td>
        `;
      } else {
        const enemyHtml = c.spiesInside
          ? `<span class="spy-badge spy-badge-alert">! ${c.spiesInside}</span>`
          : '<span class="val-zero">—</span>';
        if (c.spiesInside) totEnemy++;

        tr.innerHTML = `
          <td>${nameHtml}</td>
          <td colspan="6" style="color:#556;text-align:center;">No safehouse</td>
          <td>${enemyHtml}</td>
        `;
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const tfoot = document.createElement("tfoot");
    tfoot.innerHTML = `<tr>
      <td>Total</td>
      <td></td>
      <td class="right">${capHtml(totTrained, totCap)}</td>
      <td class="right">${totWait}</td>
      <td class="right">${totDef}</td>
      <td class="right">${totUse}</td>
      <td class="right">${totMissions}</td>
      <td>${totEnemy ? '<span class="spy-badge spy-badge-alert">' + totEnemy + " cities</span>" : "—"}</td>
    </tr>`;
    table.appendChild(tfoot);

    wrap.appendChild(table);
    container.appendChild(wrap);

    // Missions detail table
    const allMissions = [];
    for (const c of report.cities) {
      if (!c.spy) continue;
      for (const m of c.spy.missions) {
        allMissions.push({ sourceCity: c.name, ...m });
      }
    }

    if (allMissions.length > 0) {
      const header = document.createElement("div");
      header.className = "trade-section-header";
      header.style.marginTop = "20px";
      header.innerHTML = '<span class="spy-badge spy-badge-active">Active Missions</span>';
      container.appendChild(header);

      const mWrap = document.createElement("div");
      mWrap.className = "table-wrap";
      const mTable = document.createElement("table");
      mTable.className = "report-table";

      const mThead = document.createElement("thead");
      mThead.innerHTML = `<tr>
        <th>Source City</th>
        <th>Target Player</th>
        <th>Target City</th>
        <th>Coords</th>
        <th class="right">Spies</th>
        <th>Status</th>
      </tr>`;
      mTable.appendChild(mThead);

      const mTbody = document.createElement("tbody");
      for (const m of allMissions) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="city-name">${m.sourceCity}</td>
          <td>${m.targetPlayer || "—"}</td>
          <td>${m.targetCity || "—"}</td>
          <td class="coords">${m.targetCoords || "—"}</td>
          <td class="right">${m.spiesDeployed || "—"}</td>
          <td>${m.status || "—"}</td>
        `;
        mTbody.appendChild(tr);
      }
      mTable.appendChild(mTbody);

      mWrap.appendChild(mTable);
      container.appendChild(mWrap);
    }
  }
})();

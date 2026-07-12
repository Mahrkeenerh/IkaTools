// Advisor data collector — fetches city data in parallel
(() => {
  const P = "[Advisor]";

  // Max scientists by academy level (index = level, 0-32). Source: Ikariam game data.
  // Wiki-sourced, known to contain errors — the report highlights rows where
  // assigned > max so values can be corrected manually as they're observed in-game.
  const MAX_SCIENTISTS_BY_LEVEL = [0, 8, 11, 16, 22, 28, 35, 43, 51, 60, 69, 78, 89, 99, 110, 122, 134, 146, 158, 171, 185, 198, 212, 227, 241, 256, 271, 287, 302, 318, 335, 351, 368];
  // Max priests by temple level (index = level). Known values from Ikariam game data up to 28;
  // levels 25 and 27 linearly interpolated from neighbours (756, 848). Above 28, falls back to fetched max.
  const MAX_PRIESTS_BY_LEVEL = [0, 12, 22, 37, 54, 73, 94, 117, 141, 168, 195, 224, 255, 287, 320, 355, 390, 427, 464, 503, 543, 583, 625, 668, 711, 756, 801, 848, 895];

  function maxByBuildingLevel(buildings, internalName, table) {
    if (!Array.isArray(buildings)) return null;
    const b = buildings.find((x) => x.building === internalName);
    if (!b) return null;
    const lvl = b.level || 0;
    return lvl >= 0 && lvl < table.length ? table[lvl] : null;
  }

  // Extract a JSON object/value following a marker string, using brace-matching
  function extractJson(html, marker) {
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const start = idx + marker.length;

    // Find the opening brace or bracket
    let i = start;
    while (i < html.length && html[i] !== "{" && html[i] !== "[") i++;
    if (i >= html.length) return null;

    const open = html[i];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    const objStart = i;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (ch === "\\" ) { i++; continue; } // skip escaped char
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.substring(objStart, i + 1));
          } catch (e) {
            console.error(P, "JSON parse failed for", marker, e);
            return null;
          }
        }
      }
    }
    return null;
  }

  // Extract a simple numeric/string value: "key: value," or "key: value\n"
  function extractValue(html, key) {
    const re = new RegExp(key + "\\s*:\\s*([^,\\n]+)");
    const m = html.match(re);
    if (!m) return null;
    const v = m[1].trim().replace(/['"]/g, "");
    const n = parseFloat(v);
    return isNaN(n) ? v : n;
  }

  // Extract all useful data from a full city HTML page
  function extractCityData(html) {
    const bgData = extractJson(html, '"updateBackgroundData",');
    if (!bgData) {
      console.warn(P, "No updateBackgroundData found");
      return null;
    }

    // headerData is the primary economy source — embedded as a raw JS object literal
    const headerData = extractJson(html, "headerData:");
    if (!headerData) {
      console.warn(P, "No headerData found");
    }

    return { bgData, headerData };
  }

  // Parse building data from updateBackgroundData
  function parseBuildingData(bgData) {
    if (!bgData) return null;
    const result = {
      name: bgData.name,
      id: bgData.id,
      isCapital: bgData.isCapital || false,
      islandName: bgData.islandName || "",
      buildings: [],
      construction: null,
      spiesInside: bgData.spiesInside,
    };

    if (Array.isArray(bgData.position)) {
      for (let i = 0; i < bgData.position.length; i++) {
        const pos = bgData.position[i];
        if (!pos || pos.buildingId == null) continue;
        result.buildings.push({
          position: i,
          buildingId: pos.buildingId,
          name: pos.name,
          level: pos.level,
          building: pos.building,
          isBusy: pos.isBusy,
          canUpgrade: pos.canUpgrade,
          isMaxLevel: pos.isMaxLevel,
        });
      }

      // Active construction: check constructionSite class AND endUpgradeTime in the future
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < bgData.position.length; i++) {
        const pos = bgData.position[i];
        if (pos && pos.building && pos.building.includes("constructionSite")) {
          const endTime = parseInt(pos.completed, 10) || bgData.endUpgradeTime;
          if (endTime && endTime > now) {
            result.construction = {
              position: i,
              buildingName: pos.name || "Unknown",
              level: pos.level + 1,
              endTime,
              startTime: bgData.startUpgradeTime,
            };
          }
          break;
        }
      }
    }

    // Fallback construction detection via underConstruction index
    // Only mark as active when endUpgradeTime is strictly in the future
    if (!result.construction && bgData.underConstruction != null && bgData.endUpgradeTime) {
      const now = Math.floor(Date.now() / 1000);
      if (bgData.endUpgradeTime > now) {
        const pos = bgData.position?.[bgData.underConstruction];
        result.construction = {
          position: bgData.underConstruction,
          buildingName: pos?.name || "Unknown",
          level: (pos?.level ?? 0) + 1,
          endTime: bgData.endUpgradeTime,
          startTime: bgData.startUpgradeTime,
        };
      }
    }

    return result;
  }

  // Generic page fetcher — returns HTML text
  async function fetchPage(params) {
    const base = location.origin + location.pathname;
    const url = base + "?" + params;
    const resp = await fetch(url, {
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    return resp.text();
  }

  // POST form fetcher — for views that require form submission (e.g. branchOffice search)
  // Adds ajax=1 so the server returns Responder JSON instead of a full page.
  async function fetchPagePost(formData) {
    const base = location.origin + location.pathname;
    const params = new URLSearchParams(formData);
    params.set("ajax", "1");
    const resp = await fetch(base, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: params,
    });
    return resp.text();
  }

  // --- DOM parsing helpers for sub-views ---

  function getInputVal(doc, id) {
    const el = doc.getElementById(id);
    return el ? parseInt(el.getAttribute("value"), 10) || 0 : 0;
  }

  function getInputMax(doc, id) {
    const el = doc.getElementById(id);
    return el ? parseInt(el.getAttribute("data-max") || el.getAttribute("max"), 10) || 0 : 0;
  }

  function getTextInt(doc, id) {
    const el = doc.getElementById(id);
    if (!el) return null;
    return parseInt(el.textContent.replace(/\s/g, "").replace(",", "."), 10) || 0;
  }

  function getTextFloat(doc, id) {
    const el = doc.getElementById(id);
    if (!el) return null;
    return parseFloat(el.textContent.replace(/\s/g, "").replace(",", ".")) || 0;
  }

  // Simple extraction: find the ID string, then search nearby for attribute values.
  // Works regardless of quote escaping (" or \" or \\\" etc.)

  function extractInput(html, inputId) {
    const idx = html.indexOf(inputId);
    if (idx === -1) return { assigned: 0, max: 0 };
    // Grab 600 chars around the id to find value= and data-max= attributes
    const chunk = html.substring(idx, idx + 600);
    const valMatch = chunk.match(/value=\\*"(\d+)/);
    const maxMatch = chunk.match(/data-max=\\*"(\d+)/) || chunk.match(/\bmax=\\*"(\d+)/);
    return {
      assigned: valMatch ? parseInt(valMatch[1], 10) : 0,
      max: maxMatch ? parseInt(maxMatch[1], 10) : 0,
    };
  }

  // Extract text content after an element's opening tag by ID.
  // Finds id="elId" (with any quote escaping), then grabs text between > and <
  function extractElText(html, elId) {
    const idx = html.indexOf(elId);
    if (idx === -1) return null;
    // From the id position, find the first > then grab text until <
    const after = html.substring(idx, idx + 300);
    const m = after.match(/>([^<\\]*(?:\\.[^<\\]*)*)</);
    if (!m) return null;
    const text = m[1].replace(/\\n/g, "").replace(/\\t/g, "").replace(/\s+/g, " ").trim();
    return text || null;
  }

  function parseElInt(html, elId) {
    const text = extractElText(html, elId);
    if (!text) return null;
    return parseInt(text.replace(/\s/g, "").replace(/,/g, ""), 10) || 0;
  }

  function parseElFloat(html, elId) {
    const text = extractElText(html, elId);
    if (!text) return null;
    return parseFloat(text.replace(/\s/g, "").replace(/,/g, ".")) || 0;
  }

  // Parse "X + Y" overwork format from worker count display.
  // Returns { normal, overwork } or null if not found.
  function parseWorkerCount(html, elId) {
    const text = extractElText(html, elId);
    if (!text) return null;
    // Format: "264 + 132" (overworked) or "240" (normal)
    const m = text.match(/(\d+)\s*\+\s*(\d+)/);
    if (m) return { normal: parseInt(m[1], 10), overwork: parseInt(m[2], 10) };
    const n = parseInt(text.replace(/\s/g, ""), 10);
    return isNaN(n) ? null : { normal: n, overwork: 0 };
  }

  // Parse town hall page for worker/population data (regex-based, works with escaped HTML)
  function parseTownHall(html) {
    const wood = extractInput(html, "inputWood");
    const luxury = extractInput(html, "inputLuxury");
    const scientists = extractInput(html, "inputScientists");
    const priests = extractInput(html, "inputPriests");

    // Overwork: parse "X + Y" display from population graph
    const woodCount = parseWorkerCount(html, "js_TownHallPopulationGraphResourceWorkerCount");
    const luxuryCount = parseWorkerCount(html, "js_TownHallPopulationGraphSpecialWorkerCount");

    // Production per hour from town hall display
    const woodProdPerHour = parseElInt(html, "js_TownHallPopulationGraphWoodProduction");
    const luxuryProdPerHour = parseElInt(html, "js_TownHallPopulationGraphTradeGoodProduction");

    return {
      woodWorkers: wood.assigned,
      woodWorkersMax: wood.max,
      luxuryWorkers: luxury.assigned,
      luxuryWorkersMax: luxury.max,
      scientists: scientists.assigned,
      scientistsMax: scientists.max,
      priests: priests.assigned,
      priestsMax: priests.max,
      occupiedSpace: parseElInt(html, "js_TownHallOccupiedSpace"),
      maxInhabitants: parseElInt(html, "js_TownHallMaxInhabitants"),
      growthPerHour: parseElFloat(html, "js_TownHallPopulationGrowthValue"),
      happiness: parseElInt(html, "js_TownHallHappinessLargeValue"),
      netGold: parseElInt(html, "js_TownHallIncomeGoldValue"),
      woodOverwork: woodCount ? woodCount.overwork : 0,
      woodNormalWorkers: woodCount ? woodCount.normal : null,
      luxuryOverwork: luxuryCount ? luxuryCount.overwork : 0,
      luxuryNormalWorkers: luxuryCount ? luxuryCount.normal : null,
      woodProdPerHour,
      luxuryProdPerHour,
    };
  }

  // Parse safehouse page for spy capacity and active missions using DOMParser.
  function parseSafehouse(html) {
    const viewHtml = extractChangeViewHtml(html);
    let doc;
    if (viewHtml) {
      doc = new DOMParser().parseFromString(viewHtml, "text/html");
    } else {
      doc = new DOMParser().parseFromString(html, "text/html");
    }

    const result = {
      canTrain: 0,
      waiting: 0,
      defense: 0,
      inUse: 0,
      missions: [],
    };

    // Parse stats from .spy_stats_content
    const statsContent = doc.querySelector(".spy_stats_content");
    if (statsContent) {
      const boldEl = statsContent.querySelector("b");
      if (boldEl) {
        const m = boldEl.textContent.match(/(\d+)/);
        if (m) result.canTrain = parseInt(m[1], 10);
      }
      const items = statsContent.querySelectorAll("ul.disc-list li");
      if (items.length >= 1) {
        const m = items[0].textContent.match(/(\d+)/);
        if (m) result.waiting = parseInt(m[1], 10);
      }
      if (items.length >= 2) {
        const m = items[1].textContent.match(/(\d+)/);
        if (m) result.defense = parseInt(m[1], 10);
      }
      if (items.length >= 3) {
        const m = items[2].textContent.match(/(\d+)/);
        if (m) result.inUse = parseInt(m[1], 10);
      }
    }

    // Parse missions from .spyinfo blocks
    const spyInfos = doc.querySelectorAll(".spyinfo");
    for (const info of spyInfos) {
      const mission = {};

      const userLink = info.querySelector("li.user a");
      if (userLink) {
        mission.targetPlayer = userLink.textContent.trim();
        const href = userLink.getAttribute("href") || "";
        const avatarMatch = href.match(/avatarId=(\d+)/);
        if (avatarMatch) mission.targetAvatarId = parseInt(avatarMatch[1], 10);
      }

      const cityLi = info.querySelector("li.city");
      if (cityLi) {
        // The li.city's `title` attribute is the target's building type (e.g. "Rezidence"),
        // not the city name — only the inner <a>'s title (when present) is the city name.
        const cityLink = cityLi.querySelector("a");
        const text = cityLink ? cityLink.textContent.trim() : cityLi.textContent.trim();
        const coordMatch = text.match(/[\[(](\d+:\d+)[\])]/);
        mission.targetCoords = coordMatch ? coordMatch[1] : "";
        const linkTitle = cityLink ? (cityLink.getAttribute("title") || "") : "";
        mission.targetCity = linkTitle || text.replace(/\s*[\[(]\d+:\d+[\])]\s*/, "").trim();
        if (cityLink) {
          const href = cityLink.getAttribute("href") || "";
          const cityIdMatch = href.match(/cityId=(\d+)/);
          if (cityIdMatch) mission.targetCityId = parseInt(cityIdMatch[1], 10);
        }
      }

      // Spies deployed: li without .user, .city, .status classes
      const lis = info.querySelectorAll("ul > li");
      for (const li of lis) {
        if (!li.classList.contains("user") && !li.classList.contains("city")
            && !li.classList.contains("status")) {
          const m = li.textContent.match(/(\d+)/);
          if (m) mission.spiesDeployed = parseInt(m[1], 10);
        }
      }

      const statusEls = info.querySelectorAll("li.status");
      if (statusEls.length > 0) mission.status = statusEls[0].textContent.trim();

      // ETA: second .status li may contain a getCountdown script with enddate
      for (const sEl of statusEls) {
        const script = sEl.querySelector("script");
        if (script) {
          const endMatch = script.textContent.match(/enddate:\s*(\d+)/);
          const curMatch = script.textContent.match(/currentdate:\s*(\d+)/);
          if (endMatch && curMatch) {
            const remaining = parseInt(endMatch[1], 10) - parseInt(curMatch[1], 10);
            if (remaining > 0) {
              mission.etaSeconds = remaining;
              mission.endTimestamp = Math.floor(Date.now() / 1000) + remaining;
            }
          }
          break;
        }
      }

      result.missions.push(mission);
    }

    return result;
  }

  // Parse spy reports from safehouse Reports tab (tabReports) into an array.
  // Each report has header metadata + detail content (units or resources).
  const SPY_RES_MAP = { icon_wood: "wood", icon_wine: "wine", icon_marble: "marble", icon_glass: "crystal", icon_sulfur: "sulfur" };
  // Resources are always listed in this fixed order in the resourcesTable —
  // used as a fallback when the icon URL is content-hashed (CDN) rather than
  // the legacy icon_* path.
  const SPY_RES_ORDER = ["wood", "wine", "marble", "crystal", "sulfur"];
  // Extract the next unseen paginator offset from a spy reports page.
  // The paginator only shows adjacent page links, so we walk iteratively.
  function getNextSpyOffset(doc, seen) {
    for (const a of doc.querySelectorAll(".paginator a.paginator_link")) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/[?&]offset=(\d+)/);
      if (m) {
        const offset = parseInt(m[1], 10);
        if (!seen.has(offset)) return offset;
      }
    }
    return null;
  }

  function parseSpyReports(html) {
    const viewHtml = extractChangeViewHtml(html);
    const doc = new DOMParser().parseFromString(viewHtml || html, "text/html");
    // Successful reports use class="espionageReports", failed ones use class="entry" —
    // match by id prefix instead so we capture both.
    const headerRows = doc.querySelectorAll('tr[id^="message"]');
    const reports = [];
    for (const row of headerRows) {
      const id = parseInt(row.id.replace("message", ""), 10);
      if (!Number.isFinite(id)) continue;

      const targetPlayer = row.querySelector(".targetOwner")?.textContent.trim() || "";
      const cityCell = row.querySelector(".targetCity");
      let targetCity = "", targetCoords = "", targetCityId = null;
      if (cityCell) {
        const link = cityCell.querySelector("a");
        const raw = (link || cityCell).textContent.replace(/\s+/g, " ").trim();
        const cm = raw.match(/[\[(](\d+)\s*:\s*(\d+)[\])]/);
        if (cm) {
          targetCoords = `${cm[1]}:${cm[2]}`;
          targetCity = raw.replace(/[\[(]\d+\s*:\s*\d+[\])]/, "").trim();
        } else {
          targetCity = raw;
        }
        if (link) {
          const cidm = (link.getAttribute("href") || "").match(/selectCity=(\d+)/);
          if (cidm) targetCityId = parseInt(cidm[1], 10);
        }
      }

      const subject = row.querySelector(".subject")?.textContent.trim() || "";
      const resultImg = row.querySelector(".resultImage img");
      const resultText = resultImg?.getAttribute("title") || resultImg?.alt || "";
      const am = (row.querySelector(".lostAgents")?.textContent.trim() || "").match(/(\d+)\s*\/\s*(\d+)/);
      const dm = (row.querySelector(".lostDecoys")?.textContent.trim() || "").match(/(\d+)\s*\/\s*(\d+)/);
      const dateText = row.querySelector(".date")?.textContent.trim() || "";

      // Failed reports have a .noReport div in the detail row regardless of language.
      const detailRow = doc.querySelector(`#tbl_mail${id}`);
      const success = !detailRow?.querySelector(".noReport");

      const report = {
        id, targetPlayer, targetCity, targetCoords, date: dateText,
        subject, result: resultText, success,
        agentsLost: am ? parseInt(am[1], 10) : 0,
        agentsDeployed: am ? parseInt(am[2], 10) : 0,
        decoysLost: dm ? parseInt(dm[1], 10) : 0,
        decoysDeployed: dm ? parseInt(dm[2], 10) : 0,
      };
      if (targetCityId) report.targetCityId = targetCityId;

      // Parse detail content (always in DOM, hidden when collapsed)
      const reportText = detailRow?.querySelector(".reportText");
      if (reportText) {
        // Resources
        const resTable = reportText.querySelector("table.resourcesTable");
        if (resTable) {
          report.type = "resources";
          report.resources = {};
          let dataRowIdx = 0;
          for (const tr of resTable.querySelectorAll("tr")) {
            const img = tr.querySelector("td.unitname img");
            const countCell = tr.querySelector("td.count");
            if (!img || !countCell) continue;
            const count = parseInt(countCell.textContent.replace(/[\s,.\u00a0]/g, ""), 10) || 0;
            // Try legacy icon_* path first, then fall back to row position.
            const src = img.getAttribute("src") || "";
            let key = null;
            for (const [frag, k] of Object.entries(SPY_RES_MAP)) {
              if (src.includes(frag)) { key = k; break; }
            }
            if (!key && dataRowIdx < SPY_RES_ORDER.length) key = SPY_RES_ORDER[dataRowIdx];
            if (key) report.resources[key] = count;
            dataRowIdx++;
          }
        }
        // Units / ships
        const unitTables = reportText.querySelectorAll("table.reportTable:not(.resourcesTable)");
        if (unitTables.length > 0) {
          report.type = "units";
          report.units = {};
          report.ships = {};
          for (const tbl of unitTables) {
            const isShip = !!tbl.querySelector("th.shipyard");
            const target = isShip ? report.ships : report.units;
            const headers = [...tbl.querySelectorAll("tr:first-child th")].slice(1); // skip building icon
            const dataRow = tbl.querySelector("tr:nth-child(2)");
            if (!dataRow) continue;
            const countCells = [...dataRow.querySelectorAll("td")].filter(td => !td.classList.contains("category"));
            if (countCells.length === 1 && countCells[0].hasAttribute("colspan")) {
              for (const th of headers) {
                const key = th.getAttribute("title") || "";
                if (key) target[key] = 0;
              }
            } else {
              for (let i = 0; i < headers.length && i < countCells.length; i++) {
                const key = headers[i].getAttribute("title") || "";
                if (key) target[key] = parseInt(countCells[i].textContent.replace(/[\s,.\u00a0]/g, ""), 10) || 0;
              }
            }
          }
        }
      }

      reports.push(report);
    }
    return reports;
  }

  // Parse warehouse page for safe/lootable resource data (regex-based)
  function parseWarehouse(html) {
    const result = {
      safeWood: parseElInt(html, "js_secure_wood"),
      safeWine: parseElInt(html, "js_secure_wine"),
      safeMarble: parseElInt(html, "js_secure_marble"),
      safeCrystal: parseElInt(html, "js_secure_glass"),
      safeSulfur: parseElInt(html, "js_secure_sulfur"),
      lootableWood: parseElInt(html, "js_plunderable_wood"),
      lootableWine: parseElInt(html, "js_plunderable_wine"),
      lootableMarble: parseElInt(html, "js_plunderable_marble"),
      lootableCrystal: parseElInt(html, "js_plunderable_glass"),
      lootableSulfur: parseElInt(html, "js_plunderable_sulfur"),
      totalSafeCapacity: parseElInt(html, "js_total_safe_capacity"),
      totalStorageCapacity: parseElInt(html, "js_total_storage_capacity"),
    };
    return result;
  }

  // Extract the changeView HTML from the Responder script.
  // Format: ["changeView",["viewName","<entity-encoded & escaped HTML>"]]
  // The HTML uses HTML entities (&lt; &gt; &amp;) AND JSON escaping (\" \/ \n).
  function extractChangeViewHtml(html) {
    const marker = '"changeView"';
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    // The value is an array: ["viewName", "htmlString"]
    // Use brace-matching to extract the array
    const arr = extractJson(html, marker);
    if (!Array.isArray(arr) || arr.length < 2) return null;
    // arr[1] is the HTML string — already unescaped by JSON.parse
    // But it still has HTML entities (&lt; &gt; &amp; &quot;)
    const encoded = arr[1];
    if (typeof encoded !== "string") return null;
    // Decode HTML entities
    const decoded = encoded
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    return decoded;
  }

  // Extract changeView HTML from an ajax=1 Responder response.
  // The response may be:
  //   1. A JSON object: {"actionRequest":"...","dataForJSCallback":[["changeView",["viewName","html"]],...]}
  //   2. A raw JSON array: [["changeView",["viewName","html"]],...]
  //   3. A full HTML page with Responder embedded in a <script> tag
  // In all cases, the dialog HTML is entity-encoded inside the changeView entry.
  function decodeHtmlEntities(encoded) {
    return encoded
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  }

  // Extract all changeView entries from a Responder response.
  // Returns array of { viewName, html } sorted: main views first, sidebar views last.
  function extractAllChangeViews(text) {
    const results = [];

    // Try full JSON parse first
    try {
      let entries;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        entries = parsed;
      } else if (parsed && Array.isArray(parsed.dataForJSCallback)) {
        entries = parsed.dataForJSCallback;
      }
      if (entries) {
        for (const entry of entries) {
          if (Array.isArray(entry) && entry[0] === "changeView" && Array.isArray(entry[1])) {
            const viewName = entry[1][0] || "";
            const encoded = entry[1][1];
            if (typeof encoded !== "string") continue;
            results.push({ viewName, html: decodeHtmlEntities(encoded) });
          }
        }
        return results;
      }
    } catch (e) { /* not valid JSON — fall through to text search */ }

    // Fallback: text-based extraction (finds first changeView only)
    const marker = '"changeView"';
    const idx = text.indexOf(marker);
    if (idx === -1) return results;
    const arr = extractJson(text, marker);
    if (!Array.isArray(arr) || arr.length < 2) return results;
    const encoded = arr[1];
    if (typeof encoded === "string") {
      results.push({ viewName: arr[0] || "", html: decodeHtmlEntities(encoded) });
    }
    return results;
  }

  function extractChangeViewFromAjax(text) {
    const views = extractAllChangeViews(text);
    if (views.length === 0) return null;
    // Prefer non-sidebar changeView (main content)
    const main = views.find((v) => !v.viewName.startsWith("sidebar"));
    return (main || views[0]).html;
  }

  // Parse branchOffice page for trade offers using DOMParser.
  // Input can be an ajax=1 JSON response or a full HTML page.
  // Large numeric cells render as abbreviated text ("4,12M") with the raw value
  // in a sibling `.tooltip` div ("4 121 600"). Prefer the tooltip when present.
  function parseNumericCell(td) {
    if (!td) return 0;
    const tooltip = td.querySelector(".tooltip");
    const raw = tooltip ? tooltip.textContent : (td.childNodes[0]?.textContent || td.textContent || "");
    return parseInt(raw.replace(/\s/g, ""), 10) || 0;
  }

  // Buy table cols:  City | Goods/min | Qty | Resource | Price | Distance | Trade  (7)
  // Sell table cols: City | Qty | Resource | Price | Distance | Trade              (6)
  // Returns array of { cityName, playerName, goodsPerMin, quantity, price, distance }
  function parseTrading(text) {
    const offers = [];

    // Try extracting from ajax response first, then from full-page Responder
    const viewHtml = extractChangeViewFromAjax(text) || extractChangeViewHtml(text);
    let doc;
    if (viewHtml) {
      doc = new DOMParser().parseFromString(viewHtml, "text/html");
    } else {
      doc = new DOMParser().parseFromString(text, "text/html");
    }

    // Extract city name (first text node) and player name (after <br>) from a td
    function parseCityPlayer(td) {
      // First text node before <br> is the city name
      let city = "", player = "";
      let pastBr = false;
      for (const node of td.childNodes) {
        if (node.nodeName === "BR") { pastBr = true; continue; }
        if (node.nodeType === 3) { // text node
          const t = node.textContent.trim();
          if (!pastBr) { if (t) city = t; }
          else { if (t) player = t.replace(/[()]/g, "").trim(); }
        }
      }
      return { cityName: city, playerName: player };
    }

    // Find offer tables — skip the search form table (has class "search")
    const tables = doc.querySelectorAll("table.table01");
    for (const table of tables) {
      if (table.classList.contains("search")) continue;

      // Detect buy vs sell layout from header count
      const thCount = table.querySelectorAll("tr th").length;
      const isBuyLayout = thCount >= 7;

      const rows = table.querySelectorAll("tr");
      for (const row of rows) {
        if (row.querySelector("th")) continue;
        if (row.querySelector(".paginator")) continue;
        if (row.querySelector("[colspan]")) continue;
        const tds = row.querySelectorAll("td");

        let cityName, playerName, goodsPerMin = 0, quantity, price, distance;

        if (isBuyLayout && tds.length >= 7) {
          // Buy: City | Goods/min | Qty | Resource | Price | Distance | Trade
          ({ cityName, playerName } = parseCityPlayer(tds[0]));
          goodsPerMin = parseInt(tds[1]?.textContent.trim(), 10) || 0;
          quantity = parseNumericCell(tds[2]);
          price = parseNumericCell(tds[4]);
          distance = parseInt(tds[5]?.textContent.trim(), 10) || 0;
        } else if (tds.length >= 6) {
          // Sell: City | Qty | Resource | Price | Distance | Trade
          ({ cityName, playerName } = parseCityPlayer(tds[0]));
          quantity = parseNumericCell(tds[1]);
          price = parseNumericCell(tds[3]);
          distance = parseInt(tds[4]?.textContent.trim(), 10) || 0;
        } else {
          continue;
        }

        if (quantity > 0) {
          offers.push({ cityName, playerName, goodsPerMin, quantity, price, distance });
        }
      }
    }
    return offers;
  }

  // Parse branchOfficeSoldier page for army trade offers using DOMParser.
  // Table cols: City | Goods/min | Qty | Unit | Price | Distance | Trade  (7)
  // Returns array of { cityName, playerName, goodsPerMin, quantity, unitId, unitName, price, currency, distance }
  function parseArmyTrading(text) {
    const offers = [];
    const viewHtml = extractChangeViewFromAjax(text) || extractChangeViewHtml(text);
    const doc = new DOMParser().parseFromString(viewHtml || text, "text/html");

    function parseCityPlayer(td) {
      let city = "", player = "";
      let pastBr = false;
      for (const node of td.childNodes) {
        if (node.nodeName === "BR") { pastBr = true; continue; }
        if (node.nodeType === 3) {
          const t = node.textContent.trim();
          if (!pastBr) { if (t) city = t; }
          else { if (t) player = t.replace(/[()]/g, "").trim(); }
        }
      }
      return { cityName: city, playerName: player };
    }

    const tables = doc.querySelectorAll("table.table01");
    for (const table of tables) {
      if (table.classList.contains("search")) continue;
      for (const row of table.querySelectorAll("tr")) {
        if (row.querySelector("th") || row.querySelector(".paginator") || row.querySelector("[colspan]")) continue;
        const tds = row.querySelectorAll("td");
        if (tds.length < 7) continue;

        const { cityName, playerName } = parseCityPlayer(tds[0]);
        const goodsPerMin = parseInt(tds[1]?.textContent.trim(), 10) || 0;
        const quantity = parseNumericCell(tds[2]);

        // Unit: extract from div class "unitDropDownSlot army_small normal sXXX"
        const unitDiv = tds[3]?.querySelector(".unitDropDownSlot");
        let unitId = "";
        let unitName = unitDiv?.title || unitDiv?.getAttribute("title") || "";
        if (unitDiv) {
          for (const cls of unitDiv.classList) {
            if (/^s\d+$/.test(cls)) { unitId = cls; break; }
          }
        }

        // Price + currency icon class
        const price = parseNumericCell(tds[4]);
        const currIcon = tds[4]?.querySelector("img");
        let currency = "gold";
        if (currIcon) {
          const cls = currIcon.className || "";
          if (cls.includes("icon_wood") || cls.includes("icon_resource")) currency = "wood";
          else if (cls.includes("icon_wine") || cls.includes("tradegood1")) currency = "wine";
          else if (cls.includes("icon_marble") || cls.includes("tradegood2")) currency = "marble";
          else if (cls.includes("icon_crystal") || cls.includes("tradegood3")) currency = "crystal";
          else if (cls.includes("icon_sulfur") || cls.includes("tradegood4")) currency = "sulfur";
          else if (cls.includes("icon_gold")) currency = "gold";
        }

        const distance = parseInt(tds[5]?.textContent.trim(), 10) || 0;

        if (quantity > 0) {
          offers.push({ cityName, playerName, goodsPerMin, quantity, unitId, unitName, price, currency, distance });
        }
      }
    }
    return offers;
  }

  // Parse branchOfficeOwnOffers page for the player's own standing offers.
  // Returns array of { resource, type ("buy"|"sell"), qty, price }
  function parseOwnOffers(text) {
    const viewHtml = extractChangeViewFromAjax(text) || extractChangeViewHtml(text);
    const doc = new DOMParser().parseFromString(viewHtml || text, "text/html");

    const RES_IDS = ["resource", "tradegood1", "tradegood2", "tradegood3", "tradegood4"];
    const RES_NAMES = ["wood", "wine", "marble", "crystal", "sulfur"];
    const offers = [];
    for (let i = 0; i < RES_IDS.length; i++) {
      const id = RES_IDS[i];
      const typeId = id === "resource" ? "resourceTradeType" : id + "TradeType";
      const priceId = id === "resource" ? "resourcePrice" : id + "Price";
      const typeEl = doc.getElementById(typeId);
      const qtyEl = doc.getElementById(id);
      const priceEl = doc.getElementById(priceId);
      const type = typeEl?.value === "333" ? "buy" : "sell";
      const qty = parseInt(qtyEl?.value || "0", 10) || 0;
      const price = parseInt(priceEl?.value || "0", 10) || 0;
      offers.push({ resource: RES_NAMES[i], type, qty, price });
    }
    return offers;
  }

  // Unit group classification by ID
  const UNIT_GROUPS = {
    s303: "Infantry", s315: "Infantry", s302: "Infantry", s319: "Infantry", s308: "Infantry",
    s301: "Infantry", s313: "Infantry", s304: "Infantry",
    s307: "Siege & Support", s306: "Siege & Support", s305: "Siege & Support",
    s312: "Siege & Support", s309: "Siege & Support",
    s310: "Siege & Support", s311: "Siege & Support",
    s211: "Warships", s210: "Warships", s216: "Warships", s213: "Warships",
    s214: "Warships", s215: "Warships", s217: "Warships", s212: "Warships",
    s218: "Naval Support", s219: "Naval Support", s220: "Naval Support",
  };

  // CSS class name → unit ID (for relatedCities .armybutton / .fleetbutton parsing)
  const UNIT_CLASS_TO_ID = {
    phalanx: "s303", spearman: "s315", swordsman: "s302", slinger: "s301",
    archer: "s313", marksman: "s304", spartan: "s319", ram: "s307", catapult: "s306",
    cook: "s310", medic: "s311", steamgiant: "s308", mortar: "s305",
    gyrocopter: "s312", bombardier: "s309",
    ship_flamethrower: "s211", ship_ram: "s210", ship_ballista: "s213",
    ship_catapult: "s214", ship_rocketship: "s217", ship_steamboat: "s216",
    ship_mortar: "s215", ship_submarine: "s212", ship_paddlespeedship: "s218",
    ship_ballooncarrier: "s219", ship_tender: "s220",
  };

  // Parse cityMilitary page for unit counts using DOMParser.
  // Dialog HTML is inside the Responder's changeView entry (JSON-escaped).
  // Extract it, unescape via JSON.parse, then parse clean HTML with DOMParser.
  function parseMilitary(html) {
    const units = [];

    // Try direct HTML first, then extract from Responder
    let doc = new DOMParser().parseFromString(html, "text/html");
    let tables = doc.querySelectorAll("table.militaryList");
    if (tables.length === 0) {
      const viewHtml = extractChangeViewHtml(html);
      if (!viewHtml) {
        console.warn(P, "No militaryList tables and no changeView found");
        return { units };
      }
      doc = new DOMParser().parseFromString(viewHtml, "text/html");
      tables = doc.querySelectorAll("table.militaryList");
    }

    for (const table of tables) {
      // Headers: <div class="army s303"> or <div class="fleet s211"> with tooltip child
      const headerCells = table.querySelectorAll("tr.title_img_row th");
      const tableHeaders = [];
      for (const th of headerCells) {
        const div = th.querySelector("div[class*='army s'], div[class*='fleet s']");
        if (!div) continue;
        const cls = div.className;
        const isShip = cls.includes("fleet");
        const idMatch = cls.match(/s(\d+)/);
        if (!idMatch) continue;
        const tooltip = div.querySelector(".tooltip");
        const name = tooltip ? tooltip.textContent.trim() : "s" + idMatch[1];
        const id = "s" + idMatch[1];
        const group = UNIT_GROUPS[id] || (isShip ? "Warships" : "Infantry");
        tableHeaders.push({ type: isShip ? "ship" : "unit", id, name, group });
      }
      if (tableHeaders.length === 0) continue;

      // Count row: <tr class="count"> — first td is player name, rest are counts
      const countRow = table.querySelector("tr.count");
      if (!countRow) continue;
      const tds = countRow.querySelectorAll("td");
      // Skip first td (player name link)
      for (let i = 1; i < tds.length && i - 1 < tableHeaders.length; i++) {
        const text = tds[i].textContent.trim();
        const cleaned = text.replace(/[\s,.\u00a0]/g, "");
        const count = text === "-" || text === "" ? 0 : parseInt(cleaned, 10) || 0;
        units.push({ ...tableHeaders[i - 1], count });
      }
    }

    return { units };
  }

  // Parse relatedCities page for deployed unit counts.
  // Only extracts "own units" section (first table with rowAction column).
  function parseRelatedCitiesMilitary(html) {
    const units = [];

    // Try all changeView entries (main content may have tables, sidebar may not)
    const views = extractAllChangeViews(html);
    let tables = null;
    for (const view of views) {
      const doc = new DOMParser().parseFromString(view.html, "text/html");
      const t = doc.querySelectorAll("table.table01");
      if (t.length > 0) { tables = t; break; }
    }
    // Fallback: try parsing the raw HTML directly
    if (!tables || tables.length === 0) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      tables = doc.querySelectorAll("table.table01");
    }
    if (!tables || tables.length === 0) return { units };

    // First table with rowAction column = our deployed units
    for (const table of tables) {
      if (!table.querySelector("th.rowAction")) continue;
      const buttons = table.querySelectorAll(".armybutton, .fleetbutton");
      for (const btn of buttons) {
        const name = btn.getAttribute("title") || "";
        const count = parseInt(btn.textContent.replace(/[\s,.\u00a0]/g, ""), 10) || 0;
        if (count === 0) continue;

        // Find unit ID from CSS class
        const classes = btn.className.split(/\s+/);
        let id = null;
        let type = "unit";
        for (const cls of classes) {
          if (cls === "armybutton" || cls === "fleetbutton") {
            if (cls === "fleetbutton") type = "ship";
            continue;
          }
          if (UNIT_CLASS_TO_ID[cls]) {
            id = UNIT_CLASS_TO_ID[cls];
            if (cls.startsWith("ship_")) type = "ship";
            break;
          }
        }

        const group = id ? (UNIT_GROUPS[id] || (type === "ship" ? "Warships" : "Infantry")) : "Infantry";
        units.push({ type, id, name, group, count });
      }
      break; // Only first table (own units)
    }

    return { units };
  }

  function parseTrainingQueue(html) {
    let doc = new DOMParser().parseFromString(html, "text/html");
    let list = doc.getElementById("unitConstructionList");
    if (!list) {
      const viewHtml = extractChangeViewFromAjax(html) || extractChangeViewHtml(html);
      if (!viewHtml) return [];
      doc = new DOMParser().parseFromString(viewHtml, "text/html");
      list = doc.getElementById("unitConstructionList");
    }
    if (!list) return [];

    const queue = [];
    const blocks = list.querySelectorAll(".unitConstructionBlock");

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const active = i === 0 && !!block.querySelector(".running");

      let enddate = null;
      const script = block.querySelector("script");
      if (script) {
        const m = script.textContent.match(/enddate:\s*'(\d+)'/);
        if (m) enddate = parseInt(m[1], 10);
      }
      // Active entry: estimate enddate from countdown text (e.g. "2m 36s", "1h 30m", "1D 5h")
      if (!enddate && active) {
        const cdEl = block.querySelector("#unitBuildCountDown");
        if (cdEl) {
          const txt = cdEl.textContent.trim();
          const dM = txt.match(/(\d+)\s*[dD]/);
          const hM = txt.match(/(\d+)\s*h/);
          const mM = txt.match(/(\d+)\s*m/);
          const sM = txt.match(/(\d+)\s*s/);
          const secs =
            (dM ? parseInt(dM[1], 10) * 86400 : 0) +
            (hM ? parseInt(hM[1], 10) * 3600 : 0) +
            (mM ? parseInt(mM[1], 10) * 60 : 0) +
            (sM ? parseInt(sM[1], 10) : 0);
          if (secs > 0) enddate = Math.floor(Date.now() / 1000) + secs;
        }
      }

      const wrappers = block.querySelectorAll(".army_wrapper");
      for (const wrapper of wrappers) {
        const name = wrapper.getAttribute("title") || "";
        const armyDiv = wrapper.querySelector("div[class*=' s']");
        let id = null;
        let type = "unit";
        if (armyDiv) {
          const idMatch = armyDiv.className.match(/s(\d+)/);
          if (idMatch) id = "s" + idMatch[1];
          if (armyDiv.className.includes("fleet")) type = "ship";
        }
        const countEl = wrapper.querySelector(".unitcounttextlabel");
        const count = countEl ? parseInt(countEl.textContent.replace(/[\s,.\u00a0]/g, ""), 10) || 0 : 0;
        if (count > 0) {
          queue.push({ position: i + 1, active, id, name, count, type, enddate });
        }
      }
    }

    return queue;
  }

  // Navigate to military advisor via bridge, wait for DOM to populate, parse movements.
  // The fleet movements table is rendered client-side by game JS, so we can't fetch() it.
  function fetchMilitaryMovementsFromDOM() {
    return new Promise((resolve) => {
      IkUtils.ensureBridge();

      // Navigate to the military advisor view
      window.dispatchEvent(new CustomEvent("ik-ajax-call", {
        detail: { url: "?view=militaryAdvisor&activeTab=tab_militaryAdvisor" },
      }));

      let resolved = false;
      function tryParse() {
        const tableDiv = document.getElementById("js_MilitaryMovementsFleetMovementsTable");
        if (!tableDiv) return false;
        const table = tableDiv.querySelector("table");
        if (!table) return false;
        // Table exists and has rows — parse from live DOM
        if (resolved) return true;
        resolved = true;
        const movements = parseMilitaryMovementsFromDoc(table);
        // Close the advisor panel
        window.dispatchEvent(new CustomEvent("ik-close-popup"));
        resolve(movements);
        return true;
      }

      // Check immediately, then observe for DOM changes
      if (tryParse()) return;
      const obs = new MutationObserver(() => {
        if (tryParse()) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
      // Timeout after 15s (generous for slow servers)
      setTimeout(() => {
        obs.disconnect();
        if (!resolved) {
          resolved = true;
          console.warn(P, "Military movements DOM timeout — table not found");
          window.dispatchEvent(new CustomEvent("ik-close-popup"));
          resolve([]);
        }
      }, 15000);
    });
  }

  // Parse military movements from a live DOM table element (not from HTML string).
  function parseMilitaryMovementsFromDoc(table) {
    const movements = [];
    const rows = table.querySelectorAll("tbody tr");
    for (const row of rows) {
      if (row.querySelector("th")) continue;
      // Game tags each row with "own" for the user's own movements, "ally" for allied
      // movements involving the user, and neither for third-party traffic visible via
      // trades. The advisor should only account for the user's own fleets — otherwise
      // ally deployments and foreign trade ships inflate transit counts.
      if (!row.classList.contains("own")) continue;
      const tds = row.querySelectorAll("td");
      if (tds.length < 8) continue;

      // Mission type from icon class
      const missionIcon = tds[0].querySelector(".mission_icon");
      const missionType = missionIcon
        ? [...missionIcon.classList].find((c) => c !== "mission_icon") || "unknown"
        : "unknown";

      // Arrival time
      const timeSpans = tds[1].querySelectorAll("span");
      let arrivalTime = "";
      let countdown = "";
      for (const sp of timeSpans) {
        const title = sp.getAttribute("title");
        if (title && /\d{2}:\d{2}:\d{2}/.test(sp.textContent.trim())) {
          arrivalTime = sp.textContent.trim();
        }
        if (title && /\d+[mhs]/.test(sp.textContent.trim())) {
          countdown = sp.textContent.trim();
        }
      }
      if (!countdown && timeSpans.length > 0) countdown = timeSpans[0].textContent.trim();

      // Units & resources from expandable detail panel
      const units = [];
      const resources = [];
      const detailDiv = row.querySelector(".infoTip");
      if (detailDiv) {
        for (const icon of detailDiv.querySelectorAll(".unit_detail_icon")) {
          const title = icon.getAttribute("title") || "0";
          const count = parseInt(title.replace(/\s/g, ""), 10) || 0;
          const cls = icon.className;
          if (cls.includes("resource_icon")) {
            const resMatch = cls.match(/resource_icon\s+(\w+)/);
            resources.push({ type: resMatch ? resMatch[1] : "unknown", amount: count });
          } else if (cls.includes("ship_")) {
            const shipMatch = cls.match(/ship_(\w+)/);
            const shipName = shipMatch ? shipMatch[1] : "ship";
            const id = shipMatch ? UNIT_CLASS_TO_ID["ship_" + shipMatch[1]] || null : null;
            units.push({ type: "ship", id, name: shipName, count });
          } else {
            const unitMatch = cls.match(/icon40 bold center (\w+)/);
            const unitName = unitMatch ? unitMatch[1] : "unknown";
            const id = UNIT_CLASS_TO_ID[unitName] || null;
            units.push({ type: "unit", id, name: unitName, count });
          }
        }
      }

      // Origin city
      const sourceCell = row.querySelector("td.source") || tds[5];
      const sourceLink = sourceCell?.querySelector("a");
      const sourcePlayer = sourceCell?.querySelector("span");
      const origin = {
        city: sourceLink?.getAttribute("title") || sourceLink?.textContent.trim() || "",
        player: sourcePlayer?.getAttribute("title") || sourcePlayer?.textContent.replace(/[()]/g, "").trim() || "",
        cityId: null,
      };
      const originHref = sourceLink?.getAttribute("href") || "";
      const originCityMatch = originHref.match(/cityId=(\d+)/);
      if (originCityMatch) origin.cityId = parseInt(originCityMatch[1], 10);

      // Direction arrow
      const arrowCell = row.querySelector("td.mission");
      const arrowTitle = arrowCell?.getAttribute("title") || "";
      const isReturning = arrowCell?.className.includes("arrow_left") || false;

      // Target
      const targetCell = row.querySelector("td.target") || tds[7];
      const targetLink = targetCell?.querySelector("a");
      const targetPlayer = targetCell?.querySelector("span");
      const target = {
        city: targetLink?.getAttribute("title") || targetLink?.textContent.trim() || "",
        player: targetPlayer?.getAttribute("title") || targetPlayer?.textContent.replace(/[()]/g, "").trim() || "",
      };

      // Compute absolute end timestamp from countdown text for live display
      let endTimestamp = null;
      if (countdown) {
        const dM = countdown.match(/(\d+)\s*[dD]/);
        const hM = countdown.match(/(\d+)\s*h/);
        const mM = countdown.match(/(\d+)\s*m/);
        const sM = countdown.match(/(\d+)\s*s/);
        const secs =
          (dM ? parseInt(dM[1], 10) * 86400 : 0) +
          (hM ? parseInt(hM[1], 10) * 3600 : 0) +
          (mM ? parseInt(mM[1], 10) * 60 : 0) +
          (sM ? parseInt(sM[1], 10) : 0);
        if (secs > 0) endTimestamp = Math.floor(Date.now() / 1000) + secs;
      }

      movements.push({
        missionType,
        missionLabel: arrowTitle,
        isReturning,
        countdown,
        arrivalTime,
        endTimestamp,
        units,
        resources,
        origin,
        target,
      });
    }

    return movements;
  }

  // Get city list from bridge (delegates to IkUtils.getCities)
  const getCities = () => IkUtils.getCities();

  // Active port for sending progress updates to popup (set when advisor runs)
  let progressPort = null;

  // Send progress update to popup port + toolbar bar
  function sendProgress(current, total, phase) {
    if (progressPort) {
      try {
        progressPort.postMessage({ type: "advisor-progress", current, total, phase });
      } catch (e) { /* port may be disconnected */ }
    }
    updateToolbarProgress(current, total);
  }

  // Main collection function — mode: "basic" | "workers" | "storage" | "army" | "trading" | "full"
  async function collectData(mode) {
    const cities = await getCities();
    if (cities.length === 0) {
      throw new Error("No cities found — make sure you are on the Ikariam game page");
    }
    // Extract world name and avatarId for history persistence
    const world = IkUtils.getWorldName() || "";
    const urlWorld = IkUtils.getUrlWorldName() || "";
    let avatarId = "";
    document.querySelectorAll("script").forEach((script) => {
      const m = script.textContent.match(/avatarId:\s*'(\d+)'/);
      if (m) avatarId = m[1];
    });

    const wantDetails = mode === "full";
    const wantWorkers = mode === "workers" || mode === "full";
    const wantStorage = mode === "storage" || mode === "full";
    const wantArmy = mode === "army" || mode === "full";
    const wantTrading = mode === "trading" || mode === "full";
    const wantSpy = mode === "spy" || mode === "full";
    const wantMovements = mode === "basic" || wantStorage || wantArmy || wantTrading;
    const needsPhase2 = mode !== "basic" && mode !== "storage";
    const phases = 1 + (needsPhase2 ? 1 : 0) + (wantStorage && !needsPhase2 ? 1 : 0) + (wantTrading ? 1 : 0);
    const total = cities.length * phases;
    let completed = 0;

    // Stub result for friendly (deployed) cities — never inspected. None of their
    // city-view data is used (report.js filters them out of every aggregation);
    // their stationed army is fetched separately in Phase 2.5. The stub keeps them
    // in `results` so the deployed list still shows their name and Phase 2.5 can
    // attach their military.
    const deployedStub = (city) => ({
      city, buildingData: null, headerData: null, ownerName: "",
      townHall: null, warehouse: null, military: { units: [] },
      boPos: null, safehouse: null, safehouseLevel: null, shPos: null, trainingQueue: [],
    });

    // Phase 1: fetch all city views in parallel.
    // Skip friendly (deployed) cities: their view=city data is discarded, and
    // army/full mode re-fetches view=city for them in Phase 2.5 anyway. Skipping
    // here saves one request per deployed city in every mode and avoids the
    // redundant double-fetch in army/full.
    const cityHtmls = await Promise.all(
      cities.map(async (city) => {
        let html = null;
        if (city.relationship !== "deployedCities") {
          html = await fetchPage("view=city&cityId=" + city.id);
        }
        completed++;
        sendProgress(completed, total, "Fetching cities...");
        return html;
      })
    );

    // Phase 2: parse city data, fetch extra views based on mode
    let results;
    if (mode === "basic") {
      // Basic: just parse city data, no extra fetches
      results = cities.map((city, i) => {
        if (cityHtmls[i] == null) return deployedStub(city);
        const cityData = extractCityData(cityHtmls[i]);
        if (!cityData) return null;
        const buildingData = parseBuildingData(cityData.bgData);
        return { city, buildingData, headerData: cityData.headerData, ownerName: cityData.bgData?.ownerName || "", townHall: null, warehouse: null, military: { units: [] }, boPos: null, safehouse: null, safehouseLevel: null };
      });
    } else if (mode === "storage") {
      // Storage: basic + warehouse fetch
      results = await Promise.all(
        cities.map(async (city, i) => {
          try {
            if (cityHtmls[i] == null) {
              completed++;
              sendProgress(completed, total, "Fetching warehouses...");
              return deployedStub(city);
            }
            const cityData = extractCityData(cityHtmls[i]);
            if (!cityData) return null;
            const buildingData = parseBuildingData(cityData.bgData);

            let whPos = null;
            let boPos = null;
            const positions = cityData.bgData?.position;
            if (Array.isArray(positions)) {
              for (let j = 0; j < positions.length; j++) {
                const b = positions[j]?.building;
                if (!b) continue;
                if (whPos === null && b.includes("warehouse")) whPos = j;
                if (boPos === null && b.includes("branchOffice")) boPos = j;
              }
            }

            const whHtml = whPos !== null
              ? await fetchPage("view=warehouse&cityId=" + city.id + "&position=" + whPos)
              : null;

            completed++;
            sendProgress(completed, total, "Fetching warehouses...");

            return {
              city,
              buildingData,
              headerData: cityData.headerData,
              ownerName: cityData.bgData?.ownerName || "",
              townHall: null,
              warehouse: whHtml ? parseWarehouse(whHtml) : null,
              military: { units: [] },
              boPos,
              safehouse: null,
              safehouseLevel: null,
            };
          } catch (e) {
            console.error(P, "Error fetching warehouse for", city.name, e);
            completed++;
            sendProgress(completed, total, "Fetching warehouses...");
            return null;
          }
        })
      );
    } else {
      const phaseLabel = wantArmy && !wantDetails ? "Fetching military..." : "Fetching details...";
      results = await Promise.all(
        cities.map(async (city, i) => {
          try {
            if (cityHtmls[i] == null) {
              completed++;
              sendProgress(completed, total, phaseLabel);
              return deployedStub(city);
            }
            const cityData = extractCityData(cityHtmls[i]);
            if (!cityData) return null;

            const buildingData = parseBuildingData(cityData.bgData);

            // Find warehouse, branchOffice, and safehouse positions from bgData.position
            let whPos = null;
            let boPos = null;
            let shPos = null;
            let bkPos = null;
            let syPos = null;
            const positions = cityData.bgData?.position;
            if (Array.isArray(positions)) {
              for (let j = 0; j < positions.length; j++) {
                const b = positions[j]?.building;
                if (!b) continue;
                if (whPos === null && b.includes("warehouse")) whPos = j;
                if (boPos === null && b.includes("branchOffice")) boPos = j;
                if (shPos === null && b.includes("safehouse")) shPos = j;
                if (bkPos === null && b.includes("barracks")) bkPos = j;
                if (syPos === null && b.includes("shipyard")) syPos = j;
              }
            }

            // Skip most fetches for deployed (non-own) cities
            const isDeployed = city.relationship === "deployedCities";
            // Occupied enemy cities aren't ours: our stationed troops there are
            // exposed via relatedCities (withdraw buttons), same as deployed
            // allied cities — cityMilitary/barracks/shipyard would return the
            // enemy owner's data, not our units. Defer to Phase 2.5.
            const isOccupied = city.relationship === "occupiedCities";
            const armyViaRelated = isDeployed || isOccupied;

            // Fetch extra views based on mode
            // Deployed/occupied city military is deferred — relatedCities uses
            // server session context, so parallel fetches would all get the
            // same city's data.
            const fetches = [
              // Town hall population/workers only makes sense for own cities;
              // occupied enemy cities would return the enemy owner's data.
              !armyViaRelated && (wantDetails || wantWorkers)
                ? fetchPage("view=townHall&cityId=" + city.id)
                : Promise.resolve(null),
              !isDeployed && (wantDetails || wantStorage) && whPos !== null
                ? fetchPage("view=warehouse&cityId=" + city.id + "&position=" + whPos)
                : Promise.resolve(null),
              wantArmy && !armyViaRelated
                ? fetchPage("view=cityMilitary&activeTab=tabUnits&cityId=" + city.id)
                : Promise.resolve(null),
              !isDeployed && wantSpy && shPos !== null
                ? fetchPage("view=safehouse&cityId=" + city.id + "&position=" + shPos)
                : Promise.resolve(null),
              !armyViaRelated && wantArmy && bkPos !== null
                ? fetchPage("view=barracks&cityId=" + city.id + "&position=" + bkPos)
                : Promise.resolve(null),
              !armyViaRelated && wantArmy && syPos !== null
                ? fetchPage("view=shipyard&cityId=" + city.id + "&position=" + syPos)
                : Promise.resolve(null),
            ];

            const [thHtml, whHtml, milHtml, shHtml, bkHtml, syHtml] = await Promise.all(fetches);

            completed++;
            sendProgress(completed, total, phaseLabel);

            return {
              city,
              buildingData,
              headerData: cityData.headerData,
              ownerName: cityData.bgData?.ownerName || "",
              townHall: thHtml ? parseTownHall(thHtml) : null,
              warehouse: whHtml ? parseWarehouse(whHtml) : null,
              military: milHtml ? parseMilitary(milHtml) : { units: [] },
              boPos,
              safehouse: shHtml ? parseSafehouse(shHtml) : null,
              safehouseLevel: shPos !== null ? (positions[shPos]?.level || 0) : null,
              shPos,
              trainingQueue: [
                ...(bkHtml ? parseTrainingQueue(bkHtml) : []),
                ...(syHtml ? parseTrainingQueue(syHtml) : []),
              ],
            };
          } catch (e) {
            console.error(P, "Error fetching", city.name, e);
            completed++;
            sendProgress(completed, total, phaseLabel);
            return null;
          }
        })
      );
    }

    // Phase 2.5: fetch deployed + occupied city military data sequentially.
    // The relatedCities endpoint uses the server session context, so each
    // city needs a view=city fetch first to switch context. Occupied enemy
    // cities expose our stationed troops the same way deployed allied cities
    // do (relatedCities "own units" table with withdraw buttons).
    if (wantArmy) {
      const deployed = results.filter(
        (r) => r && (r.city.relationship === "deployedCities" || r.city.relationship === "occupiedCities")
      );
      for (const r of deployed) {
        try {
          sendProgress(completed, total, "Fetching deployed military...");
          await fetchPage("view=city&cityId=" + r.city.id);
          const milHtml = await fetchPage("view=relatedCities&activeTab=tabUnits&cityId=" + r.city.id);
          r.military = milHtml ? parseRelatedCitiesMilitary(milHtml) : { units: [] };
        } catch (e) {
          console.error(P, "Error fetching deployed military for", r.city.name, e);
        }
      }
    }

    // Phase 3: fetch trading data for cities with markets
    if (wantTrading) {
      const RES_KEYS = ["resource", "1", "2", "3", "4"];
      const RES_NAMES = { resource: "wood", "1": "wine", "2": "marble", "3": "crystal", "4": "sulfur" };
      const TYPES = [["444", "buy"], ["333", "sell"]];

      await Promise.all(
        results.map(async (r) => {
          if (!r || r.boPos == null) {
            completed++;
            sendProgress(completed, total, "Fetching trading...");
            return;
          }
          const tradingOffers = [];
          const fetches = [];
          for (const [typeVal, typeStr] of TYPES) {
            for (const resKey of RES_KEYS) {
              fetches.push(
                fetchPagePost({
                  view: "branchOffice",
                  activeTab: "bargain",
                  cityId: r.city.id,
                  position: r.boPos,
                  type: typeVal,
                  searchResource: resKey,
                  range: 99,
                })
                  .then((html) => {
                    const offers = parseTrading(html);
                    for (const o of offers) {
                      tradingOffers.push({ ...o, resource: RES_NAMES[resKey], type: typeStr });
                    }
                  })
                  .catch(() => {})
              );
            }
          }
          // Also fetch own offers for this city's market
          fetches.push(
            fetchPage("view=branchOfficeOwnOffers&cityId=" + r.city.id + "&position=" + r.boPos)
              .then((html) => { r.ownOffers = parseOwnOffers(html); })
              .catch(() => {})
          );
          await Promise.all(fetches);
          r.trading = tradingOffers;
          completed++;
          sendProgress(completed, total, "Fetching trading...");
        })
      );

      // Fetch army (soldier) offers — land (222) + sea (111) from each city's market
      await Promise.all(
        results.map(async (r) => {
          if (!r || r.boPos == null) return;
          const armyOffers = [];
          const armyFetches = [];
          for (const type of [222, 111]) {
            armyFetches.push(
              fetchPagePost({
                view: "branchOfficeSoldier",
                activeTab: "tradePartners",
                cityId: r.city.id,
                position: r.boPos,
                type,
                searchResource: "all",
                range: 99,
                currency: "all",
              })
                .then((html) => {
                  const offers = parseArmyTrading(html);
                  for (const o of offers) armyOffers.push(o);
                })
                .catch(() => {})
            );
          }
          await Promise.all(armyFetches);
          r.armyTrading = armyOffers;
        })
      );
    }

    // Fetch military movements (global, not per-city) — one request to militaryAdvisor
    let militaryMovements = [];
    if (wantMovements) {
      sendProgress(completed, total, "Fetching movements...");
      try {
        militaryMovements = await fetchMilitaryMovementsFromDOM();
      } catch (e) {
        console.error(P, "Error fetching military movements:", e);
      }
    }

    // Fetch spy reports once (global, not per-city) from first city with a safehouse.
    // Walks all pagination pages iteratively (paginator only shows adjacent links).
    let spyReports = [];
    if (wantSpy) {
      const firstSh = results.find(r => r?.safehouse && r.shPos !== null);
      if (firstSh) {
        try {
          const baseParams = "view=safehouse&cityId=" + firstSh.city.id + "&position=" + firstSh.shPos + "&activeTab=tabReports";
          const seenOffsets = new Set([0]);
          let currentParams = baseParams;
          while (currentParams) {
            const html = await fetchPage(currentParams);
            if (!html) break;
            spyReports = spyReports.concat(parseSpyReports(html));
            const viewHtml = extractChangeViewHtml(html);
            const doc = new DOMParser().parseFromString(viewHtml || html, "text/html");
            const nextOffset = getNextSpyOffset(doc, seenOffsets);
            if (nextOffset != null) {
              seenOffsets.add(nextOffset);
              currentParams = baseParams + "&offset=" + nextOffset;
            } else {
              currentParams = null;
            }
          }
        } catch (e) {
          console.error(P, "Error fetching spy reports:", e);
        }
      }
    }

    // Global economy values — same from every city, extract once
    const firstHd = results.find((r) => r?.headerData)?.headerData || {};
    const global = {
      gold: parseFloat(firstHd.gold) || 0,
      income: firstHd.income || 0,
      upkeep: firstHd.upkeep || 0,
      scientistsUpkeep: firstHd.scientistsUpkeep || 0,
      playerName: results.find((r) => r?.ownerName)?.ownerName || "",
    };

    const reportData = {
      timestamp: new Date().toISOString(),
      mode,
      world,
      urlWorld,
      avatarId,
      global,
      militaryMovements,
      spyReports,
      cities: results.map((r) => {
        if (!r) return null;
        const b = r.buildingData || {};
        const hd = r.headerData || {};
        const cr = hd.currentResources || {};
        const mr = hd.maxResources || {};
        const th = r.townHall || {};
        const wh = r.warehouse;
        const mil = r.military || { units: [] };

        // Build storage object if warehouse data available
        let storage = null;
        if (wh) {
          storage = {
            safe: {
              wood: wh.safeWood ?? 0,
              wine: wh.safeWine ?? 0,
              marble: wh.safeMarble ?? 0,
              crystal: wh.safeCrystal ?? 0,
              sulfur: wh.safeSulfur ?? 0,
            },
            lootable: {
              wood: wh.lootableWood ?? 0,
              wine: wh.lootableWine ?? 0,
              marble: wh.lootableMarble ?? 0,
              crystal: wh.lootableCrystal ?? 0,
              sulfur: wh.lootableSulfur ?? 0,
            },
            safeCapacity: wh.totalSafeCapacity ?? 0,
            storageCapacity: wh.totalStorageCapacity ?? 0,
          };
        }

        return {
          id: r.city.id,
          name: r.city.name,
          coords: r.city.coords,
          relationship: r.city.relationship || "ownCity",
          isCapital: b.isCapital || false,
          islandName: b.islandName || "",
          buildings: b.buildings || [],
          construction: b.construction || null,
          spiesInside: b.spiesInside || null,
          resources: {
            wood: cr.resource ?? 0,
            wine: cr["1"] ?? 0,
            marble: cr["2"] ?? 0,
            crystal: cr["3"] ?? 0,
            sulfur: cr["4"] ?? 0,
          },
          maxResources: {
            wood: mr.resource ?? mr["0"] ?? 0,
            wine: mr["1"] ?? 0,
            marble: mr["2"] ?? 0,
            crystal: mr["3"] ?? 0,
            sulfur: mr["4"] ?? 0,
          },
          // Per-city rates (per-second → per-hour)
          woodPerHour: Math.round((hd.resourceProduction || 0) * 3600),
          tradegoodPerHour: Math.round((hd.tradegoodProduction || 0) * 3600),
          producedTradegood: hd.producedTradegood || null,
          winePerHour: -(hd.wineSpendings || 0),
          citizens: cr.citizens ?? 0,
          population: cr.population ?? 0,
          transporters: {
            free: hd.freeTransporters ?? 0,
            max: hd.maxTransporters ?? 0,
          },
          actionPoints: hd.maxActionPoints ?? 0,
          // Town hall data. Scientist/priest max from the town hall input is bounded by
          // available citizens, so it under-reports when population is capped. Use
          // academy/temple level as the true ceiling when known.
          workers: th.woodWorkers != null ? {
            wood: { assigned: th.woodWorkers ?? 0, max: th.woodWorkersMax ?? 0 },
            luxury: { assigned: th.luxuryWorkers ?? 0, max: th.luxuryWorkersMax ?? 0 },
            scientists: { assigned: th.scientists ?? 0, max: maxByBuildingLevel(b.buildings, "academy", MAX_SCIENTISTS_BY_LEVEL) ?? th.scientistsMax ?? 0 },
            priests: { assigned: th.priests ?? 0, max: maxByBuildingLevel(b.buildings, "temple", MAX_PRIESTS_BY_LEVEL) ?? th.priestsMax ?? 0 },
          } : null,
          happiness: th.happiness ?? null,
          growthPerHour: th.growthPerHour ?? null,
          maxInhabitants: th.maxInhabitants ?? null,
          occupiedSpace: th.occupiedSpace ?? null,
          cityNetGold: th.netGold ?? null,
          // Overwork data from town hall population graph
          overmine: th.woodOverwork != null ? {
            wood: {
              normalWorkers: th.woodNormalWorkers ?? 0,
              overwork: th.woodOverwork ?? 0,
              prodPerHour: th.woodProdPerHour ?? null,
            },
            luxury: {
              normalWorkers: th.luxuryNormalWorkers ?? 0,
              overwork: th.luxuryOverwork ?? 0,
              prodPerHour: th.luxuryProdPerHour ?? null,
            },
          } : null,
          // Warehouse / storage
          storage,
          // Military
          military: mil,
          trainingQueue: r.trainingQueue || [],
          // Trading
          trading: r.trading || [],
          armyTrading: r.armyTrading || [],
          ownOffers: r.ownOffers || [],
          // Spy
          spy: r.safehouse ? {
            ...r.safehouse,
            safehouseLevel: r.safehouseLevel,
          } : null,
        };
      }).filter(Boolean),
    };

    return reportData;
  }

  // --- Spy log persistence ---
  async function persistSpyLog(data) {
    const world = data.urlWorld;
    if (!world) return;
    const allReports = data.spyReports || [];
    if (allReports.length === 0) return;
    const storageKey = `spyLog_${world}`;
    const existing = await new Promise(r => chrome.storage.local.get(storageKey, r));
    const log = existing[storageKey] || {};
    let added = 0;
    let updated = 0;
    for (const r of allReports) {
      if (!log[r.id]) {
        log[r.id] = r;
        added++;
        continue;
      }
      const existing = log[r.id];
      let changed = false;
      // Backfill success flag into legacy entries that pre-date the field.
      if (r.success !== undefined && existing.success === undefined) {
        existing.success = r.success;
        changed = true;
      }
      // Backfill detail fields when the prior parse missed them (e.g. older
      // parser couldn't recognise content-hashed resource icons). Only fill
      // when missing — never overwrite, in case the user already curated.
      if (r.type && !existing.type) { existing.type = r.type; changed = true; }
      if (r.resources && Object.keys(r.resources).length > 0 &&
          (!existing.resources || Object.keys(existing.resources).length === 0)) {
        existing.resources = r.resources;
        if (!existing.type) existing.type = "resources";
        changed = true;
      }
      if (r.units && Object.keys(r.units).length > 0 &&
          (!existing.units || Object.keys(existing.units).length === 0)) {
        existing.units = r.units;
        if (!existing.type) existing.type = "units";
        changed = true;
      }
      if (r.ships && Object.keys(r.ships).length > 0 &&
          (!existing.ships || Object.keys(existing.ships).length === 0)) {
        existing.ships = r.ships;
        if (!existing.type) existing.type = "units";
        changed = true;
      }
      if (changed) updated++;
    }
    if (added > 0 || updated > 0) {
      await new Promise(r => chrome.storage.local.set({ [storageKey]: log }, r));
    }
    console.log(P, `Spy log: ${added} new / ${updated} backfilled / ${allReports.length} total reports (${Object.keys(log).length} archived)`);
  }

  // --- Shared advisor run logic ---
  let advisorRunning = false;

  async function runAdvisor(mode, onProgress, onDone, onError) {
    if (advisorRunning) return;
    advisorRunning = true;
    try {
      const data = await collectData(mode);
      const worldKey = "advisorReportData_" + (data.urlWorld || "unknown");
      await new Promise((resolve) => {
        chrome.storage.local.set({ [worldKey]: data, advisorReportData: data }, resolve);
      });
      // Persist spy reports additively
      if (data.mode === "spy" || data.mode === "full") {
        try {
          await persistSpyLog(data);
        } catch (e) {
          console.error(P, "Failed to persist spy log:", e);
        }
      }
      if ((data.mode === "trading" || data.mode === "full") && typeof TradeHistory !== "undefined") {
        try {
          await TradeHistory.persistSnapshot(data);
        } catch (e) {
          console.error(P, "Failed to persist trade history:", e);
        }
      }
      if (onDone) onDone();
      chrome.runtime.sendMessage({ type: "open-advisor-report", worldName: data.urlWorld || "" });
    } catch (err) {
      console.error(P, err);
      if (onError) onError(err);
    } finally {
      advisorRunning = false;
    }
  }

  // Port-based advisor connection — popup connects via chrome.tabs.connect({ name: "advisor" })
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "advisor") return;
    progressPort = port;

    port.onDisconnect.addListener(() => {
      progressPort = null;
    });

    port.onMessage.addListener((msg) => {
      if (msg.action !== "start-advisor") return;
      runAdvisor(msg.mode || "full",
        null,
        () => { try { port.postMessage({ type: "advisor-done" }); } catch (e) {} },
        (err) => { try { port.postMessage({ type: "advisor-error", message: err.message }); } catch (e) {} }
      );
    });
  });

  // --- In-game toolbar: Advisor buttons with progress bar ---
  const ADVISOR_MODES = [
    { mode: "basic", label: "Basic" },
    { mode: "workers", label: "Workers" },
    { mode: "storage", label: "Storage" },
    { mode: "army", label: "Army" },
    { mode: "trading", label: "Trading" },
    { mode: "spy", label: "Spy" },
    { mode: "full", label: "Full" },
  ];
  const BAR_WIDTH = 10; // characters for progress bar

  function injectAdvisorToolbar() {
    const toolbar = document.querySelector("#GF_toolbar ul");
    if (!toolbar || document.getElementById("ik-advisor-buttons")) return;

    // Container li for all advisor buttons
    const li = document.createElement("li");
    li.id = "ik-advisor-buttons";
    li.style.cssText = "margin-left:4px;";

    // Separator label
    const sep = document.createElement("a");
    sep.textContent = "\uD83D\uDCCA";
    sep.title = "Advisor reports";
    sep.style.cssText = "cursor:default;user-select:none;margin:0 2px 0 0;color:#572E11;";
    li.appendChild(sep);

    // Individual mode buttons
    ADVISOR_MODES.forEach(({ mode, label }) => {
      const btn = document.createElement("a");
      btn.textContent = label;
      btn.className = "ik-advisor-btn";
      btn.dataset.mode = mode;
      btn.style.cssText = "cursor:pointer;user-select:none;font-size:11px;margin:0 6px;color:#572E11;";
      if (mode === "full") {
        btn.style.color = "#e06060";
        btn.title = "Many requests \u2014 fetches everything";
      }
      btn.addEventListener("mouseenter", () => { if (!advisorRunning) btn.style.color = mode === "full" ? "#ff4444" : "#7D5937"; });
      btn.addEventListener("mouseleave", () => { if (!advisorRunning) btn.style.color = mode === "full" ? "#e06060" : "#572E11"; });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startAdvisorFromToolbar(mode);
      });
      li.appendChild(btn);
    });

    // Reserved progress bar space (always takes up space, text invisible when idle)
    const progressEl = document.createElement("span");
    progressEl.id = "ik-advisor-progress";
    progressEl.style.cssText = "display:inline-block;width:16ch;margin:0 2px;font-family:monospace;font-size:11px;line-height:24px;color:#7D5937;letter-spacing:-1px;visibility:hidden;vertical-align:top;white-space:nowrap;";
    progressEl.textContent = "\u2591".repeat(BAR_WIDTH) + " 0%";
    li.appendChild(progressEl);

    li.dataset.ikOrder = "3";
    toolbar.appendChild(li);
    IkUtils.reorderToolbarItems(toolbar);
  }

  function updateToolbarProgress(current, total) {
    const el = document.getElementById("ik-advisor-progress");
    if (!el) return;
    const pct = total > 0 ? current / total : 0;
    const filled = Math.round(pct * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    el.textContent = "\u2588".repeat(filled) + "\u2591".repeat(empty) + " " + Math.round(pct * 100) + "%";
    el.style.visibility = "visible";
  }

  function hideToolbarProgress() {
    const el = document.getElementById("ik-advisor-progress");
    if (el) {
      el.textContent = "\u2591".repeat(BAR_WIDTH) + " 0%";
      el.style.visibility = "hidden";
    }
  }

  function setAdvisorButtonsDisabled(disabled) {
    document.querySelectorAll(".ik-advisor-btn").forEach((btn) => {
      btn.style.opacity = disabled ? "0.3" : "";
      btn.style.pointerEvents = disabled ? "none" : "";
    });
  }

  function startAdvisorFromToolbar(mode) {
    if (advisorRunning) return;
    updateToolbarProgress(0, 1);
    setAdvisorButtonsDisabled(true);

    runAdvisor(mode,
      null,
      () => {
        hideToolbarProgress();
        setAdvisorButtonsDisabled(false);
      },
      (err) => {
        hideToolbarProgress();
        setAdvisorButtonsDisabled(false);
        console.error(P, "Advisor error:", err);
      }
    );
  }

  injectAdvisorToolbar();
})();

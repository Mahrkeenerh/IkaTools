// Shows a summary table of own trade offers across all cities on the "Own Offers" tab
(() => {
  const P = "[TradingOffers]";
  const TABLE_ID = "ik-trading-offers-summary";

  const RES_NAMES = ["Wood", "Wine", "Marble", "Crystal", "Sulfur"];
  const RES_IDS = ["resource", "tradegood1", "tradegood2", "tradegood3", "tradegood4"];

  // --- Helpers ---

  async function fetchPage(params) {
    const base = location.origin + location.pathname;
    const resp = await fetch(base + "?" + params, {
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    return resp.text();
  }

  // Brace-matching JSON extractor (same as advisor.js)
  function extractJson(html, marker) {
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    let i = idx + marker.length;
    while (i < html.length && html[i] !== "{" && html[i] !== "[") i++;
    if (i >= html.length) return null;
    const open = html[i];
    const close = open === "{" ? "}" : "]";
    let depth = 0, inString = false;
    const objStart = i;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (ch === "\\") { i++; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.substring(objStart, i + 1)); }
          catch { return null; }
        }
      }
    }
    return null;
  }

  function decodeHtmlEntities(str) {
    return str
      .replace(/\\u003C/gi, "<").replace(/\\u003E/gi, ">")
      .replace(/\\u0026/gi, "&").replace(/\\u0027/gi, "'")
      .replace(/\\u0022/gi, '"').replace(/\\"/g, '"')
      .replace(/\\\//g, "/").replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t").replace(/\\r/g, "");
  }

  function extractChangeViewHtml(text) {
    try {
      const data = JSON.parse(text);
      const entries = Array.isArray(data) ? data : data?.[0];
      if (entries) {
        for (const entry of entries) {
          if (Array.isArray(entry) && entry[0] === "changeView" && Array.isArray(entry[1])) {
            const viewName = entry[1][0] || "";
            if (!viewName.startsWith("sidebar")) {
              return decodeHtmlEntities(entry[1][1]);
            }
          }
        }
      }
    } catch {}
    return null;
  }

  // Parse own offers from a branchOfficeOwnOffers HTML fragment
  function parseOwnOffers(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const offers = [];

    for (let i = 0; i < RES_IDS.length; i++) {
      const id = RES_IDS[i];
      const typeSelect = doc.getElementById(id === "resource" ? "resourceTradeType" : id + "TradeType");
      const qtyInput = doc.getElementById(id);
      const priceInput = doc.getElementById(id === "resource" ? "resourcePrice" : id + "Price");

      const type = typeSelect?.value === "333" ? "buy" : "sell";
      const qty = parseInt(qtyInput?.value || "0", 10) || 0;
      const price = parseInt(priceInput?.value || "0", 10) || 0;

      offers.push({ resource: RES_NAMES[i], type, qty, price });
    }
    return offers;
  }

  // Parse own offers from the current DOM (no fetch needed for active city)
  function parseCurrentOffers() {
    const offers = [];
    for (let i = 0; i < RES_IDS.length; i++) {
      const id = RES_IDS[i];
      const typeSelect = document.getElementById(id === "resource" ? "resourceTradeType" : id + "TradeType");
      const qtyInput = document.getElementById(id);
      const priceInput = document.getElementById(id === "resource" ? "resourcePrice" : id + "Price");

      const type = typeSelect?.value === "333" ? "buy" : "sell";
      const qty = parseInt(qtyInput?.value || "0", 10) || 0;
      const price = parseInt(priceInput?.value || "0", 10) || 0;

      offers.push({ resource: RES_NAMES[i], type, qty, price });
    }
    return offers;
  }

  // Get city list and current city from the DOM dropdown
  function getCitiesFromDropdown() {
    const container = document.getElementById("dropDown_js_citySelectContainer");
    if (!container) return { cities: [], currentCityId: null };

    const cities = [];
    const items = container.querySelectorAll("li[selectvalue]");
    for (const li of items) {
      const id = li.getAttribute("selectvalue");
      const name = li.querySelector("a")?.title || li.querySelector("a")?.textContent?.trim() || "";
      const isOwn = li.classList.contains("ownCity");
      if (id && isOwn) cities.push({ id, name });
    }

    // Current city from hidden form input
    const cityIdInput = document.querySelector('input[name="cityId"]');
    const currentCityId = cityIdInput?.value || null;

    return { cities, currentCityId };
  }

  // Find branchOffice position from city page bgData
  function findBranchOfficePos(html) {
    const bgData = extractJson(html, '"updateBackgroundData",');
    if (!bgData?.position) return null;
    for (let j = 0; j < bgData.position.length; j++) {
      const b = bgData.position[j]?.building;
      if (b && b.includes("branchOffice")) return j;
    }
    return null;
  }

  // --- Table rendering ---

  function buildSummaryTable(allCityOffers) {
    // allCityOffers: [{ cityName, offers: [{resource, type, qty, price}] }]
    // Separate into sell and buy offers with qty > 0
    const sells = [];
    const buys = [];
    for (const city of allCityOffers) {
      for (const o of city.offers) {
        if (o.qty <= 0) continue;
        const entry = { city: city.cityName, ...o };
        if (o.type === "sell") sells.push(entry);
        else buys.push(entry);
      }
    }

    const container = document.createElement("div");
    container.id = TABLE_ID;
    container.style.cssText = "margin:8px 10px 12px;";

    if (sells.length === 0 && buys.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:#888;font-size:12px;">No active offers across cities.</p>';
      return container;
    }

    function makeTable(title, rows) {
      if (rows.length === 0) return "";
      let html = `<h4 style="margin:6px 0 4px;font-size:12px;color:#542c0f;">${title}</h4>`;
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px;">';
      html += '<tr style="background:#e8d4a2;color:#542c0f;">' +
        '<th style="padding:3px 6px;text-align:left;border:1px solid #c0a06a;">City</th>' +
        '<th style="padding:3px 6px;text-align:left;border:1px solid #c0a06a;">Resource</th>' +
        '<th style="padding:3px 6px;text-align:right;border:1px solid #c0a06a;">Qty</th>' +
        '<th style="padding:3px 6px;text-align:right;border:1px solid #c0a06a;">Price</th>' +
        '</tr>';
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const bg = i % 2 === 0 ? "#f7ecd0" : "#f0e2b8";
        html += `<tr style="background:${bg};">` +
          `<td style="padding:3px 6px;border:1px solid #c0a06a;">${r.city}</td>` +
          `<td style="padding:3px 6px;border:1px solid #c0a06a;">${r.resource}</td>` +
          `<td style="padding:3px 6px;text-align:right;border:1px solid #c0a06a;">${r.qty.toLocaleString()}</td>` +
          `<td style="padding:3px 6px;text-align:right;border:1px solid #c0a06a;">${r.price}</td>` +
          '</tr>';
      }
      html += '</table>';
      return html;
    }

    container.innerHTML = makeTable("Selling", sells) + makeTable("Buying", buys);
    return container;
  }

  // --- Loading indicator ---

  function showLoading(anchor) {
    const el = document.createElement("div");
    el.id = TABLE_ID;
    el.style.cssText = "margin:8px 10px;text-align:center;font-size:12px;color:#888;";
    el.textContent = "Loading offers from all cities...";
    anchor.parentNode.insertBefore(el, anchor);
    return el;
  }

  // --- Main logic ---

  async function injectSummary() {
    // Find the content box with the own offers form
    const form = document.querySelector('form[name="formkontor"]');
    if (!form) return;

    // Already injected?
    if (document.getElementById(TABLE_ID)) return;

    const contentBox = form.querySelector(".contentBox01h");
    if (!contentBox) return;

    const loadingEl = showLoading(contentBox);

    try {
      const { cities, currentCityId } = getCitiesFromDropdown();
      if (cities.length === 0) {
        loadingEl.textContent = "No cities found.";
        return;
      }

      const posInput = document.querySelector('input[name="position"]');
      const currentPos = posInput?.value;

      // Fetch all other cities' pages to find branchOffice positions
      const otherCities = cities.filter((c) => c.id !== currentCityId);
      const cityPages = await Promise.all(
        otherCities.map((c) => fetchPage("view=city&cityId=" + c.id).catch(() => null))
      );

      // For each city with a branchOffice, fetch own offers
      const offerFetches = [];
      for (let i = 0; i < otherCities.length; i++) {
        const city = otherCities[i];
        if (!cityPages[i]) { offerFetches.push(null); continue; }
        const boPos = findBranchOfficePos(cityPages[i]);
        if (boPos === null) { offerFetches.push(null); continue; }
        offerFetches.push(
          fetchPage("view=branchOfficeOwnOffers&cityId=" + city.id + "&position=" + boPos)
            .catch(() => null)
        );
      }
      const offerPages = await Promise.all(offerFetches);

      // Build results
      const allCityOffers = [];

      // Current city — read from DOM
      const currentCity = cities.find((c) => c.id === currentCityId);
      if (currentCity) {
        allCityOffers.push({
          cityName: currentCity.name,
          offers: parseCurrentOffers(),
        });
      }

      // Other cities — parse from fetched pages
      for (let i = 0; i < otherCities.length; i++) {
        if (!offerPages[i]) continue;
        const viewHtml = extractChangeViewHtml(offerPages[i]) || offerPages[i];
        const offers = parseOwnOffers(viewHtml);
        allCityOffers.push({ cityName: otherCities[i].name, offers });
      }

      // Replace loading indicator with the table
      const table = buildSummaryTable(allCityOffers);
      loadingEl.replaceWith(table);
    } catch (e) {
      console.error(P, "Error building summary:", e);
      loadingEl.textContent = "Failed to load offers.";
    }
  }

  // --- View detection ---

  function isOwnOffersView() {
    const tab = document.getElementById("js_tab_branchOfficeOwnOffers");
    return tab && tab.classList.contains("selected");
  }

  function tryInject() {
    if (isOwnOffersView()) injectSummary();
  }

  tryInject();

  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tryInject();
    }, 300);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();

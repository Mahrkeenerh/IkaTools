(() => {
  const SIDE_COLORS = {
    ask: {
      line: "#e06060",
      band: "rgba(224, 96, 96, 0.2)",
      whisker: "rgba(224, 96, 96, 0.08)",
      dot: "rgba(224, 96, 96, 0.6)",
    },
    bid: {
      line: "#5ca0f2",
      band: "rgba(92, 160, 242, 0.2)",
      whisker: "rgba(92, 160, 242, 0.08)",
      dot: "rgba(92, 160, 242, 0.6)",
    },
  };

  const GRID_COLOR = "#2a3040";
  const AXIS_COLOR = "#667";
  const TEXT_COLOR = "#8890a0";
  const BG_COLOR = "#141824";

  const PAD = { top: 20, right: 16, bottom: 40, left: 54 };

  // Set up canvas for high-DPI rendering
  // Does not set inline style.width — CSS width:100% handles sizing
  function setupCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    return ctx;
  }

  // Format date for axis labels
  function fmtDate(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function fmtDateTime(ts) {
    const d = new Date(ts);
    const mon = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hr = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${mon}/${day} ${hr}:${min}`;
  }

  // Nice tick values for price axis
  function niceScale(min, max) {
    if (min === max) { min = min - 1; max = max + 1; }
    const range = max - min;
    const rough = range / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const residual = rough / mag;
    let step;
    if (residual <= 1.5) step = 1 * mag;
    else if (residual <= 3) step = 2 * mag;
    else if (residual <= 7) step = 5 * mag;
    else step = 10 * mag;

    // Ensure integer steps (prices are whole numbers)
    if (step < 1) step = 1;

    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step * 0.5; v += step) {
      ticks.push(Math.round(v));
    }
    return { min: niceMin, max: niceMax, ticks };
  }

  // Extract series data from snapshots for a resource+side
  // When options.raw is true, each snapshot is its own data point (no day aggregation)
  function extractSeriesData(snapshots, resource, side, includeOwn, options) {
    const minQty = options?.minQty || 0;
    const raw = options?.raw || false;

    if (raw) {
      // Raw mode: each snapshot becomes its own data point
      const series = [];
      for (const snap of snapshots) {
        let offers = snap.offers.filter((o) => o.r === resource && o.s === side);
        if (!includeOwn) {
          offers = offers.filter((o) => !o.self);
        }
        if (minQty > 0) {
          offers = offers.filter((o) => o.q >= minQty);
        }
        if (offers.length === 0) continue;

        const prices = offers.map((o) => o.p).sort((a, b) => a - b);
        const totalQty = offers.reduce((sum, o) => sum + o.q, 0);
        const playerSet = new Set(offers.map((o) => o.pl).filter(Boolean));

        series.push({
          ts: snap.ts,
          min: prices[0],
          max: prices[prices.length - 1],
          p25: TradeHistory.percentile(prices, 25),
          median: TradeHistory.percentile(prices, 50),
          p75: TradeHistory.percentile(prices, 75),
          totalQty,
          uniquePlayers: playerSet.size,
          offers,
        });
      }
      series.sort((a, b) => a.ts - b.ts);
      return series;
    }

    // Group snapshots by day, merge all offers within the same day
    const dayMap = new Map(); // "YYYY-MM-DD" → merged offers[]
    for (const snap of snapshots) {
      let offers = snap.offers.filter((o) => o.r === resource && o.s === side);
      if (!includeOwn) {
        offers = offers.filter((o) => !o.self);
      }
      if (minQty > 0) {
        offers = offers.filter((o) => o.q >= minQty);
      }
      if (offers.length === 0) continue;

      const d = new Date(snap.ts);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!dayMap.has(dayKey)) {
        dayMap.set(dayKey, { ts: snap.ts, offers: [] });
      }
      const day = dayMap.get(dayKey);
      day.ts = Math.max(day.ts, snap.ts); // use latest timestamp of the day

      // Deduplicate within the day: same player+price+qty = same offer
      for (const o of offers) {
        const key = `${o.pl}|${o.p}|${o.q}|${o.c}`;
        if (!day.seen) day.seen = new Set();
        if (!day.seen.has(key)) {
          day.seen.add(key);
          day.offers.push(o);
        }
      }
    }

    // Build series from daily aggregates
    const series = [];
    for (const [, day] of [...dayMap.entries()].sort((a, b) => a[1].ts - b[1].ts)) {
      const prices = day.offers.map((o) => o.p).sort((a, b) => a - b);
      const totalQty = day.offers.reduce((sum, o) => sum + o.q, 0);
      const playerSet = new Set(day.offers.map((o) => o.pl).filter(Boolean));

      series.push({
        ts: day.ts,
        min: prices[0],
        max: prices[prices.length - 1],
        p25: TradeHistory.percentile(prices, 25),
        median: TradeHistory.percentile(prices, 50),
        p75: TradeHistory.percentile(prices, 75),
        totalQty,
        uniquePlayers: playerSet.size,
        offers: day.offers,
      });
    }
    return series;
  }

  /**
   * Draw IQR band chart
   * Returns hit-test data for hover
   */
  function drawIQRChart(canvas, snapshots, resource, side, options) {
    const includeOwn = options?.includeOwn ?? true;
    const showScatter = options?.showScatter ?? false;
    const width = options?.width || canvas.parentElement?.clientWidth || canvas.closest(".chart-wrap")?.clientWidth || 300;
    const height = options?.height || 200;

    const ctx = setupCanvas(canvas, width, height);
    const colors = SIDE_COLORS[side];
    const extractFn = options?.extractFn || extractSeriesData;
    const series = extractFn(snapshots, resource, side, includeOwn, options);

    // Clear
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    if (series.length === 0) {
      ctx.fillStyle = "#445";
      ctx.font = "12px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data for this resource/side", width / 2, height / 2);
      return [];
    }

    // Compute axis ranges
    const allMin = Math.min(...series.map((s) => s.min));
    const allMax = Math.max(...series.map((s) => s.max));
    const scale = niceScale(allMin, allMax);

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;

    function xPos(i) {
      if (series.length === 1) return PAD.left + plotW / 2;
      return PAD.left + (i / (series.length - 1)) * plotW;
    }

    function yPos(val) {
      return PAD.top + plotH - ((val - scale.min) / (scale.max - scale.min)) * plotH;
    }

    // Grid lines
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    for (const tick of scale.ticks) {
      const y = yPos(tick);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(width - PAD.right, y);
      ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = AXIS_COLOR;
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tick of scale.ticks) {
      ctx.fillText(tick, PAD.left - 6, yPos(tick));
    }

    // X-axis labels (time for raw mode, date otherwise)
    const raw = options?.raw || false;
    const xFmt = raw ? fmtTime : fmtDate;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const maxLabels = Math.min(series.length, Math.floor(plotW / 50));
    const labelStep = Math.max(1, Math.ceil(series.length / maxLabels));
    for (let i = 0; i < series.length; i += labelStep) {
      ctx.fillText(xFmt(series[i].ts), xPos(i), height - PAD.bottom + 6);
    }
    // Always label last point
    if (series.length > 1 && (series.length - 1) % labelStep !== 0) {
      ctx.fillText(xFmt(series[series.length - 1].ts), xPos(series.length - 1), height - PAD.bottom + 6);
    }

    // Draw min-max whisker band
    if (series.length > 1) {
      ctx.fillStyle = colors.whisker;
      ctx.beginPath();
      ctx.moveTo(xPos(0), yPos(series[0].max));
      for (let i = 1; i < series.length; i++) ctx.lineTo(xPos(i), yPos(series[i].max));
      for (let i = series.length - 1; i >= 0; i--) ctx.lineTo(xPos(i), yPos(series[i].min));
      ctx.closePath();
      ctx.fill();
    }

    // Draw IQR band
    if (series.length > 1) {
      ctx.fillStyle = colors.band;
      ctx.beginPath();
      ctx.moveTo(xPos(0), yPos(series[0].p75));
      for (let i = 1; i < series.length; i++) ctx.lineTo(xPos(i), yPos(series[i].p75));
      for (let i = series.length - 1; i >= 0; i--) ctx.lineTo(xPos(i), yPos(series[i].p25));
      ctx.closePath();
      ctx.fill();
    }

    // Draw median line
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = xPos(i);
      const y = yPos(series[i].median);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw median dots
    for (let i = 0; i < series.length; i++) {
      ctx.fillStyle = colors.line;
      ctx.beginPath();
      ctx.arc(xPos(i), yPos(series[i].median), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Single-point: draw vertical whisker lines
    if (series.length === 1) {
      const s = series[0];
      const x = xPos(0);
      // Whisker
      ctx.strokeStyle = colors.whisker;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(x, yPos(s.min));
      ctx.lineTo(x, yPos(s.max));
      ctx.stroke();
      // IQR
      ctx.strokeStyle = colors.band;
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(x, yPos(s.p25));
      ctx.lineTo(x, yPos(s.p75));
      ctx.stroke();
    }

    // Scatter dots
    const hitData = [];
    if (showScatter) {
      for (let i = 0; i < series.length; i++) {
        const x = xPos(i);
        for (const offer of series[i].offers) {
          const y = yPos(offer.p);
          const r = Math.max(2, Math.min(8, Math.log(offer.q + 1) / Math.log(10) * 1.5));
          ctx.fillStyle = colors.dot;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          hitData.push({ x, y, r, ts: series[i].ts, offer, seriesIdx: i });
        }
      }
    }

    // Build hit-test data for median points too
    for (let i = 0; i < series.length; i++) {
      hitData.push({
        x: xPos(i),
        y: yPos(series[i].median),
        r: 6,
        ts: series[i].ts,
        summary: series[i],
        seriesIdx: i,
      });
    }

    return hitData;
  }

  /**
   * Draw a tiny sparkline
   */
  function drawSparkline(canvas, snapshots, resource, side) {
    const width = 100;
    const height = 28;
    const ctx = setupCanvas(canvas, width, height);
    const colors = SIDE_COLORS[side];

    const series = extractSeriesData(snapshots, resource, side, true);

    ctx.fillStyle = "transparent";
    ctx.clearRect(0, 0, width, height);

    if (series.length < 2) {
      // Single dot or nothing
      if (series.length === 1) {
        ctx.fillStyle = colors.line;
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    const medians = series.map((s) => s.median);
    const min = Math.min(...medians);
    const max = Math.max(...medians);
    const range = max - min || 1;
    const pad = 4;

    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < medians.length; i++) {
      const x = pad + (i / (medians.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (medians[i] - min) / range) * (height - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /**
   * Set up hover tooltip for a chart
   */
  function setupHover(canvas, hitData, tooltipEl) {
    const RES_NAMES = ["Wood", "Wine", "Marble", "Crystal", "Sulfur"];

    // Abort any previous listeners on this canvas before adding new ones
    if (canvas._hoverAbort) canvas._hoverAbort.abort();
    const ac = new AbortController();
    canvas._hoverAbort = ac;

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const mx = (e.clientX - rect.left);
      const my = (e.clientY - rect.top);

      let closest = null;
      let closestDist = Infinity;
      for (const h of hitData) {
        const dx = mx - h.x;
        const dy = my - h.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist && dist < 30) {
          closestDist = dist;
          closest = h;
        }
      }

      if (closest) {
        let html = "";
        if (closest.summary) {
          const s = closest.summary;
          html = `<div style="font-weight:600;margin-bottom:4px">${fmtDateTime(closest.ts)}</div>`;
          html += `<div>Median: <b>${s.median}</b></div>`;
          html += `<div>Range: ${s.min} — ${s.max}</div>`;
          html += `<div>IQR: ${s.p25} — ${s.p75}</div>`;
          html += `<div>Volume: ${s.totalQty.toLocaleString()}</div>`;
          html += `<div>Players: ${s.uniquePlayers}</div>`;
        } else if (closest.offer) {
          const o = closest.offer;
          html = `<div style="font-weight:600;margin-bottom:4px">${fmtDateTime(closest.ts)}</div>`;
          html += `<div>${o.pl || "Unknown"} — ${o.c}</div>`;
          html += `<div>Price: <b>${o.p}</b></div>`;
          html += `<div>Qty: ${o.q.toLocaleString()}</div>`;
        }

        tooltipEl.innerHTML = html;
        tooltipEl.style.display = "block";

        // Position tooltip
        const tw = tooltipEl.offsetWidth;
        const th = tooltipEl.offsetHeight;
        let tx = e.clientX - canvas.parentElement.getBoundingClientRect().left + 12;
        let ty = e.clientY - canvas.parentElement.getBoundingClientRect().top - th / 2;
        if (tx + tw > canvas.parentElement.clientWidth - 8) tx = tx - tw - 24;
        if (ty < 4) ty = 4;
        tooltipEl.style.left = tx + "px";
        tooltipEl.style.top = ty + "px";
      } else {
        tooltipEl.style.display = "none";
      }
    }, { signal: ac.signal });

    canvas.addEventListener("mouseleave", () => {
      tooltipEl.style.display = "none";
    }, { signal: ac.signal });
  }

  /**
   * Compute concentration metrics for a set of offers
   */
  function computeConcentration(offers) {
    if (offers.length === 0) return { uniquePlayers: 0, effectivePlayers: 0, topShare: 0 };

    const totalQty = offers.reduce((sum, o) => sum + o.q, 0);
    if (totalQty === 0) return { uniquePlayers: 0, effectivePlayers: 0, topShare: 0 };

    const playerQty = {};
    for (const o of offers) {
      const key = o.pl || "__anon__";
      playerQty[key] = (playerQty[key] || 0) + o.q;
    }

    const uniquePlayers = Object.keys(playerQty).length;
    const shares = Object.values(playerQty).map((q) => q / totalQty);
    const hhi = shares.reduce((sum, s) => sum + s * s, 0);
    const effectivePlayers = hhi > 0 ? Math.round((1 / hhi) * 10) / 10 : 0;
    const topShare = Math.round(Math.max(...shares) * 100);

    return { uniquePlayers, effectivePlayers, topShare };
  }

  // Extract series data for army unit offers from snapshot.armyOffers
  // unitId is e.g. "s302". Only "bid" side exists for army.
  // Signature matches extractSeriesData: (snapshots, resource, side, includeOwn, options)
  // but `side` is ignored (always "bid").
  function extractArmySeriesData(snapshots, unitId, _side, includeOwn, options) {
    const minQty = options?.minQty || 0;
    const raw = options?.raw || false;

    function filterOffers(snap) {
      let offers = (snap.armyOffers || []).filter((o) => o.u === unitId);
      if (!includeOwn) offers = offers.filter((o) => !o.self);
      if (minQty > 0) offers = offers.filter((o) => o.q >= minQty);
      return offers;
    }

    if (raw) {
      const series = [];
      for (const snap of snapshots) {
        const offers = filterOffers(snap);
        if (offers.length === 0) continue;
        const prices = offers.map((o) => o.p).sort((a, b) => a - b);
        const totalQty = offers.reduce((sum, o) => sum + o.q, 0);
        const playerSet = new Set(offers.map((o) => o.pl).filter(Boolean));
        series.push({
          ts: snap.ts,
          min: prices[0],
          max: prices[prices.length - 1],
          p25: TradeHistory.percentile(prices, 25),
          median: TradeHistory.percentile(prices, 50),
          p75: TradeHistory.percentile(prices, 75),
          totalQty,
          uniquePlayers: playerSet.size,
          offers,
        });
      }
      series.sort((a, b) => a.ts - b.ts);
      return series;
    }

    // Group by day
    const dayMap = new Map();
    for (const snap of snapshots) {
      const offers = filterOffers(snap);
      if (offers.length === 0) continue;
      const d = new Date(snap.ts);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, { ts: snap.ts, offers: [] });
      const day = dayMap.get(dayKey);
      day.ts = Math.max(day.ts, snap.ts);
      for (const o of offers) {
        const key = `${o.pl}|${o.p}|${o.q}|${o.c}`;
        if (!day.offers.some((e) => `${e.pl}|${e.p}|${e.q}|${e.c}` === key)) {
          day.offers.push(o);
        }
      }
    }

    const series = [];
    for (const [, day] of dayMap) {
      const prices = day.offers.map((o) => o.p).sort((a, b) => a - b);
      const totalQty = day.offers.reduce((sum, o) => sum + o.q, 0);
      const playerSet = new Set(day.offers.map((o) => o.pl).filter(Boolean));
      series.push({
        ts: day.ts,
        min: prices[0],
        max: prices[prices.length - 1],
        p25: TradeHistory.percentile(prices, 25),
        median: TradeHistory.percentile(prices, 50),
        p75: TradeHistory.percentile(prices, 75),
        totalQty,
        uniquePlayers: playerSet.size,
        offers: day.offers,
      });
    }
    series.sort((a, b) => a.ts - b.ts);
    return series;
  }

  globalThis.TradeChart = {
    drawIQRChart,
    drawSparkline,
    setupHover,
    computeConcentration,
    extractSeriesData,
    extractArmySeriesData,
  };
})();

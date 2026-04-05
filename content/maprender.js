// Shared map rendering — used by popup.js and minimap.js
// Attaches to globalThis.MapRender
globalThis.MapRender = (() => {
  // --- Layer color functions ---
  // Each takes an island object and returns a fill color string.

  // Population: YlOrRd ColorBrewer
  const HEAT_STOPS = [
    [1, 255, 255, 178], [3, 254, 217, 118], [5, 254, 178, 76],
    [7, 253, 141, 60], [9, 252, 78, 42], [11, 227, 26, 28],
    [13, 189, 0, 38], [15, 153, 0, 38], [17, 103, 0, 31],
  ];
  function lerpStops(n, stops, max) {
    const c = Math.min(n, max);
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (c >= stops[i][0] && c <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const t = hi[0] === lo[0] ? 0 : (c - lo[0]) / (hi[0] - lo[0]);
    const r = Math.round(lo[1] + t * (hi[1] - lo[1]));
    const g = Math.round(lo[2] + t * (hi[2] - lo[2]));
    const b = Math.round(lo[3] + t * (hi[3] - lo[3]));
    return `rgb(${r},${g},${b})`;
  }

  const ISLAND_GREEN = "#5ab87a";
  const OCEAN_BG = "#1e5a8a";
  const DIM = "#2a4a60"; // for "not applicable" islands in a layer

  // Wonders — thematic Greek god colors
  const WONDER_COLORS = {
    0: DIM,
    1: "#FF6B35", // Hephaestus' Forge — fire orange
    2: "#6B3FA0", // Hades' Sacred Grove — deep purple
    3: "#8FBC5F", // Demeter's Gardens — olive green
    4: "#D4AF37", // Athena's Pantheon — gold
    5: "#87CEEB", // Hermes' Temple — sky blue
    6: "#C41E3A", // Ares' Fortress — crimson
    7: "#1E90FF", // Poseidon's Temple — ocean blue
    8: "#B0B0B0", // Colossus — silver/grey
  };

  // Tradegoods — resource colors
  const TRADEGOOD_COLORS = {
    0: DIM,
    1: "#8B2252", // Wine — burgundy
    2: "#E8E4D8", // Marble — off-white
    3: "#7FDBFF", // Crystal Glass — cyan
    4: "#FFD700", // Sulfur — bright yellow
  };

  // Ownership colors
  const OWNER_COLORS = {
    own: "#FF4EC7",       // hot pink
    ally: "#00FF88",      // green
    occupied: "#FF9800",  // orange
    war: "#F44336",       // red
    "": DIM,              // no owner info
  };

  // Layer definitions
  const LAYERS = {
    population: {
      name: "Population",
      color: (isl) => isl.cities > 0 ? lerpStops(isl.cities, HEAT_STOPS, 17) : ISLAND_GREEN,
      sort: (a, b) => a.cities - b.cities,
    },
    ownership: {
      name: "Ownership",
      bg: null,
      color: (isl) => {
        if (!isl.owner) return DIM;
        for (const key of ["own", "ally", "war", "occupied"]) {
          if (isl.owner.includes(key)) return OWNER_COLORS[key];
        }
        return isl.cities > 0 ? OWNER_COLORS.occupied : DIM;
      },
      sort: (a, b) => {
        const rank = (o) => o.includes("own") ? 3 : o.includes("ally") ? 2 : o.includes("war") ? 4 : o ? 1 : 0;
        return rank(a.owner || "") - rank(b.owner || "");
      },
    },
    military: {
      name: "Military",
      color: (isl) => isl.military ? "#FF6B6B" : DIM,
      sort: (a, b) => (a.military ? 1 : 0) - (b.military ? 1 : 0),
    },
    war: {
      name: "War zones",
      color: (isl) => isl.war ? "#FF2020" : DIM,
      sort: (a, b) => (a.war ? 1 : 0) - (b.war ? 1 : 0),
    },
    piracy: {
      name: "Piracy",
      color: (isl) => isl.piracy ? "#FF4444" : DIM,
      sort: (a, b) => (a.piracy ? 1 : 0) - (b.piracy ? 1 : 0),
    },
    helios: {
      name: "Helios",
      color: (isl) => isl.helios ? "#FFD700" : DIM,
      sort: (a, b) => (a.helios ? 1 : 0) - (b.helios ? 1 : 0),
    },
    tradegoods: {
      name: "Tradegoods",
      color: (isl) => TRADEGOOD_COLORS[isl.tradegood] || DIM,
      sort: (a, b) => a.tradegood - b.tradegood,
    },
    wonders: {
      name: "Wonders",
      color: (isl) => WONDER_COLORS[isl.wonder] || DIM,
      sort: (a, b) => a.wonder - b.wonder,
    },
    alliances: {
      name: "Alliances",
      color: (isl) => {
        if (isl._allyColor) return isl._allyColor;
        if (isl.dominantAlly) return ALLY_PALETTE[Math.abs(hashStr(isl.dominantAlly)) % ALLY_PALETTE.length];
        return DIM;
      },
      sort: (a, b) => (a._allyCount || 0) - (b._allyCount || 0),
    },
    filter: {
      name: "Filter",
      color: (isl) => isl._filterMatch ? "#5ae87a" : DIM,
      sort: (a, b) => (a._filterMatch ? 1 : 0) - (b._filterMatch ? 1 : 0),
    },
  };

  // Generate distinct colors for alliances
  const ALLY_PALETTE = [
    "#FF6B6B", "#4ECDC4", "#FFD93D", "#6BCB77", "#C084FC",
    "#F472B6", "#60A5FA", "#FB923C", "#34D399", "#A78BFA",
    "#F87171", "#22D3EE", "#FACC15", "#86EFAC", "#E879F9",
  ];

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }

  function isoToPixel(gx, gy, tw, th) {
    return {
      px: (gx - gy) * (tw / 2),
      py: (gx + gy) * (th / 2),
    };
  }

  /**
   * Render the island map onto a canvas.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} islands
   * @param {Object} opts
   *   tileW, tileH, islandSize, pad, drawLegend,
   *   viewportCorners: [{x,y}x4],
   *   layer: string key from LAYERS (default "population")
   */
  function render(ctx, islands, opts = {}) {
    const tw = opts.tileW || 12;
    const th = opts.tileH || 12;
    const size = opts.islandSize || 9;
    const pad = opts.pad || 10;
    const drawLegend = opts.drawLegend !== false;
    const layerKey = opts.layer || "population";
    const layer = LAYERS[layerKey] || LAYERS.population;
    const dimEmpty = !!opts.dimEmpty;

    if (islands.length === 0) {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      return { width: 0, height: 0, pxMin: 0, pyMin: 0, tileW: tw, tileH: th };
    }

    // Pixel bounds
    let pxMin = Infinity, pxMax = -Infinity, pyMin = Infinity, pyMax = -Infinity;
    for (const isl of islands) {
      const { px, py } = isoToPixel(isl.x, isl.y, tw, th);
      if (px < pxMin) pxMin = px;
      if (px > pxMax) pxMax = px;
      if (py < pyMin) pyMin = py;
      if (py > pyMax) pyMax = py;
    }

    const legendH = drawLegend ? 50 : 0;
    const w = Math.ceil(pxMax - pxMin + size + pad * 2);
    const h = Math.ceil(pyMax - pyMin + size + pad * 2 + legendH);
    const canvas = ctx.canvas;
    canvas.width = w;
    canvas.height = h;

    // Ocean background (layers can override with a flat bg color)
    if (layer.bg) {
      ctx.fillStyle = layer.bg;
      ctx.fillRect(0, 0, w, h);
    } else {
      const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.7);
      bgGrad.addColorStop(0, "#2670a8");
      bgGrad.addColorStop(1, OCEAN_BG);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);
    }

    // Wave ripples — skip only for tiny thumbnails
    if (tw >= 10) {
      ctx.filter = `blur(${Math.max(0.5, tw * 0.15)}px)`;
      const waveSpacing = Math.max(8, tw * 1.5);
      const dashLen = Math.max(30, tw * 4);
      const gapLen = Math.max(15, tw * 3);
      ctx.lineWidth = 0.5;
      const alphaScale = 0.18;
      for (let y = waveSpacing; y < h; y += waveSpacing) {
        const phase = y * 0.13;
        const rowOffset = ((y * 7) % (dashLen + gapLen));
        for (let x = -rowOffset; x < w; x += dashLen + gapLen) {
          const alpha = alphaScale + Math.sin(x * 0.01 + y * 0.05) * (alphaScale * 0.5);
          if (alpha < 0.03) continue;
          const isLight = Math.sin(x * 0.007 + y * 0.03) > 0;
          ctx.strokeStyle = isLight
            ? `rgba(255,255,255,${(alpha * 0.7).toFixed(3)})`
            : `rgba(0,0,0,${alpha.toFixed(3)})`;
          ctx.beginPath();
          for (let dx = 0; dx < dashLen; dx += 2) {
            const px = x + dx;
            if (px < 0 || px > w) continue;
            const wy = y + Math.sin(px * 0.02 + phase) * (tw * 0.25);
            if (dx === 0) ctx.moveTo(px, wy);
            else ctx.lineTo(px, wy);
          }
          ctx.stroke();
        }
      }
      ctx.filter = "none";
    }

    // Stamp _filterMatch for the filter layer
    if (layerKey === "filter" && opts.filterConfig && globalThis.MapFilter) {
      for (const isl of islands) {
        isl._filterMatch = MapFilter.islandMatches(isl, opts.filterConfig);
      }
    }

    // Sort: dim islands first, highlighted on top
    const sorted = [...islands].sort(layer.sort);
    const half = size / 2;
    const allyColorsSeen = {}; // track alliance colors for legend

    for (const isl of sorted) {
      const { px, py } = isoToPixel(isl.x, isl.y, tw, th);
      const cx = px - pxMin + pad;
      const cy = py - pyMin + pad;

      let dimmed = false;
      if (opts.filterConfig && globalThis.MapFilter) {
        dimmed = !MapFilter.islandMatches(isl, opts.filterConfig);
      } else if (dimEmpty) {
        dimmed = isl.cities === 0;
      }
      ctx.globalAlpha = dimmed ? 0.3 : 1;
      const fillColor = layer.color(isl);
      ctx.fillStyle = fillColor;
      if (layerKey === "alliances" && isl._allyColor && isl._allyTag) {
        allyColorsSeen[isl._allyTag] = isl._allyColor;
      } else if (layerKey === "alliances" && isl.dominantAlly && fillColor !== DIM) {
        allyColorsSeen[isl.dominantAlly] = fillColor;
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx + half, cy);
      ctx.lineTo(cx, cy + half);
      ctx.lineTo(cx - half, cy);
      ctx.closePath();
      ctx.fill();

      if (tw >= 5) {
        ctx.strokeStyle = "rgba(0,0,0,0.15)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Viewport indicator
    if (opts.viewportCorners && opts.viewportCorners.length === 4) {
      const pts = opts.viewportCorners.map((c) => {
        const { px: cpx, py: cpy } = isoToPixel(c.x, c.y, tw, th);
        return { x: cpx - pxMin + pad, y: cpy - pyMin + pad };
      });

      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Legend
    if (drawLegend) {
      const ly = h - 35;
      const lx = pad;
      const fontSize = Math.max(12, Math.round(tw * 1.2));

      if (layerKey === "population") {
        const lw = Math.min(300, w - pad * 2);
        const lh = Math.max(14, Math.round(tw * 1.2));
        const grad = ctx.createLinearGradient(lx, 0, lx + lw, 0);
        grad.addColorStop(0, ISLAND_GREEN);
        grad.addColorStop(0.06, "rgb(255,255,178)");
        grad.addColorStop(0.2, "rgb(254,217,118)");
        grad.addColorStop(0.4, "rgb(253,141,60)");
        grad.addColorStop(0.6, "rgb(227,26,28)");
        grad.addColorStop(0.8, "rgb(153,0,38)");
        grad.addColorStop(1.0, "rgb(103,0,31)");
        ctx.beginPath();
        ctx.roundRect(lx, ly, lw, lh, 3);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.fillStyle = "#c0c8d8";
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("0", lx, ly - 5);
        ctx.fillText("5", lx + lw * 0.3, ly - 5);
        ctx.fillText("10", lx + lw * 0.6, ly - 5);
        ctx.fillText("17", lx + lw, ly - 5);
      } else if (layerKey === "wonders") {
        const names = ["", "Hephaestus", "Hades", "Demeter", "Athena", "Hermes", "Ares", "Poseidon", "Colossus"];
        let ox = lx;
        const boxSize = Math.max(10, Math.round(tw * 1.1));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        for (let i = 1; i <= 8; i++) {
          ctx.fillStyle = WONDER_COLORS[i];
          ctx.fillRect(ox, ly, boxSize, boxSize);
          ctx.fillStyle = "#c0c8d8";
          ctx.fillText(names[i], ox + boxSize + 4, ly + boxSize - 1);
          ox += ctx.measureText(names[i]).width + boxSize + 14;
        }
      } else if (layerKey === "tradegoods") {
        const names = ["", "Wine", "Marble", "Glass", "Sulfur"];
        let ox = lx;
        const boxSize = Math.max(12, Math.round(tw * 1.2));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        for (let i = 1; i <= 4; i++) {
          ctx.fillStyle = TRADEGOOD_COLORS[i];
          ctx.fillRect(ox, ly, boxSize, boxSize);
          ctx.fillStyle = "#c0c8d8";
          ctx.fillText(names[i], ox + boxSize + 4, ly + boxSize - 1);
          ox += ctx.measureText(names[i]).width + boxSize + 14;
        }
      } else if (layerKey === "ownership") {
        const items = [["Own", OWNER_COLORS.own], ["Ally", OWNER_COLORS.ally], ["Occupied", OWNER_COLORS.occupied], ["War", OWNER_COLORS.war]];
        let ox = lx;
        const boxSize = Math.max(12, Math.round(tw * 1.2));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        for (const [name, col] of items) {
          ctx.fillStyle = col;
          ctx.fillRect(ox, ly, boxSize, boxSize);
          ctx.fillStyle = "#c0c8d8";
          ctx.fillText(name, ox + boxSize + 4, ly + boxSize - 1);
          ox += ctx.measureText(name).width + boxSize + 14;
        }
      } else if (layerKey === "military") {
        const boxSize = Math.max(12, Math.round(tw * 1.2));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        ctx.fillStyle = "#FF6B6B";
        ctx.fillRect(lx, ly, boxSize, boxSize);
        ctx.fillStyle = "#c0c8d8";
        ctx.fillText("Military presence", lx + boxSize + 4, ly + boxSize - 1);
      } else if (layerKey === "war") {
        const boxSize = Math.max(12, Math.round(tw * 1.2));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        ctx.fillStyle = "#FF2020";
        ctx.fillRect(lx, ly, boxSize, boxSize);
        ctx.fillStyle = "#c0c8d8";
        ctx.fillText("War zone", lx + boxSize + 4, ly + boxSize - 1);
      } else if (layerKey === "filter") {
        const matched = islands.filter((i) => i._filterMatch).length;
        const boxSize = Math.max(12, Math.round(tw * 1.2));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        ctx.fillStyle = "#5ae87a";
        ctx.fillRect(lx, ly, boxSize, boxSize);
        ctx.fillStyle = "#c0c8d8";
        ctx.fillText(`Matched (${matched})`, lx + boxSize + 4, ly + boxSize - 1);
      } else if (layerKey === "alliances") {
        // Sort alliances by frequency (count islands with each color)
        const allyCounts = {};
        for (const isl of islands) {
          const tag = isl._allyTag || isl.dominantAlly;
          if (tag && allyColorsSeen[tag]) {
            allyCounts[tag] = (allyCounts[tag] || 0) + 1;
          }
        }
        const sortedAllies = Object.entries(allyCounts).sort((a, b) => b[1] - a[1]);
        let ox = lx;
        const boxSize = Math.max(10, Math.round(tw * 1.1));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        const maxLegendItems = Math.min(sortedAllies.length, 12);
        for (let i = 0; i < maxLegendItems; i++) {
          const [tag, count] = sortedAllies[i];
          const col = allyColorsSeen[tag];
          if (!col) continue;
          ctx.fillStyle = col;
          ctx.fillRect(ox, ly, boxSize, boxSize);
          ctx.fillStyle = "#c0c8d8";
          const label = `${tag} (${count})`;
          ctx.fillText(label, ox + boxSize + 4, ly + boxSize - 1);
          ox += ctx.measureText(label).width + boxSize + 14;
          if (ox > w - pad) break; // don't overflow
        }
        if (sortedAllies.length === 0) {
          ctx.fillStyle = "#556";
          ctx.font = `${fontSize}px sans-serif`;
          ctx.textAlign = "left";
          ctx.fillText("Visit islands to discover alliances", lx, ly + 12);
        }
      }
    }

    return { width: w, height: h, pxMin, pyMin, tileW: tw, tileH: th };
  }

  // Build alliance color map from allianceIndex storage data
  function buildAllianceColorMap(allianceIndex) {
    const allyCounts = {};
    for (const key of Object.keys(allianceIndex)) {
      const entry = allianceIndex[key];
      for (const [tag, count] of Object.entries(entry.counts || {})) {
        if (tag === "(none)") continue;
        allyCounts[tag] = (allyCounts[tag] || 0) + count;
      }
    }
    const sorted = Object.entries(allyCounts).sort((a, b) => b[1] - a[1]);
    const colorMap = {};
    sorted.forEach(([tag], i) => {
      colorMap[tag] = ALLY_PALETTE[i % ALLY_PALETTE.length] || "#888";
    });
    return colorMap;
  }

  // Enrich island array with alliance color/count/tag from index
  function enrichIslandsWithAlliances(islands, allianceIndex, colorMap) {
    for (const isl of islands) {
      const key = `${isl.x}:${isl.y}`;
      const entry = allianceIndex[key];
      if (!entry || !entry.counts) {
        isl._allyColor = null;
        isl._allyCount = 0;
        continue;
      }
      let maxTag = null, maxCount = 0;
      for (const [tag, count] of Object.entries(entry.counts)) {
        if (tag === "(none)") continue;
        if (count > maxCount) { maxTag = tag; maxCount = count; }
      }
      isl._allyColor = maxTag ? (colorMap[maxTag] || "#888") : null;
      isl._allyCount = maxCount;
      isl._allyTag = maxTag;
    }
  }

  return { render, LAYERS, isoToPixel, ALLY_PALETTE, buildAllianceColorMap, enrichIslandsWithAlliances };
})();

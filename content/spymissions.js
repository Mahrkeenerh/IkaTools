// Spy-mission "Try all" planner.
// Injects a button into the spyMissions view that enumerates every valid
// (agents, decoys) combination, computes the exact in-game success/detection
// numbers for each, and plots the non-dominated choices as a Pareto front
// (detection % x  vs  success % y), colored green->red by expected spies
// caught. Clicking a point fills the in-game sliders with that combo (the user
// then presses the game's own send button).
//
// All math mirrors the game's own spyMissionScreenProbabilityMonitor so the
// numbers match what the sliders show. Inputs come from the page context via
// the bridge (ik-read-spy-data); slider writes go back via ik-set-spy-sliders.
(() => {
  "use strict";

  // --- bridge round-trips -------------------------------------------------

  function readSpyData() {
    return new Promise(async (resolve) => {
      await IkUtils.ensureBridge();
      let done = false;
      const onData = (e) => {
        if (done) return;
        done = true;
        window.removeEventListener("ik-spy-data", onData);
        resolve(e.detail || { ok: false });
      };
      window.addEventListener("ik-spy-data", onData);
      window.dispatchEvent(new CustomEvent("ik-read-spy-data"));
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("ik-spy-data", onData);
        resolve({ ok: false, error: "timeout" });
      }, 3000);
    });
  }

  function applyCombo(cityId, agents, decoys) {
    IkUtils.ensureBridge().then(() => {
      window.dispatchEvent(new CustomEvent("ik-set-spy-sliders", {
        detail: { cityId, agents, decoys },
      }));
    });
  }

  // --- the formula (exact mirror of the game's monitor) -------------------

  // Returns null when the mission has no executable risk/success profile.
  function computeCombo(data, mid, agents, decoys) {
    const m = data.missionData && data.missionData[mid];
    if (!m || m.riskPerSpy == null || m.successChance == null) return null;
    const c = data.consts;
    const basicRisk = data.targetFreeSpies * 5 - data.targetCityLevel * 2;
    let missionRisk = basicRisk + m.riskBefore + data.remainingRisk;
    let minimumRisk = Math.max(c.minChance, agents * m.riskPerSpy);
    if (data.isTargetInactive) {
      missionRisk /= c.inact;
      minimumRisk /= c.inact;
    } else if (data.targetSafehouseLevel == 0) {
      missionRisk /= c.noSafe;
      minimumRisk /= c.noSafe;
    }
    const gov = data.targetGovFactor || 0;
    const agentRiskRaw = Math.min(c.maxChance, gov + Math.max(minimumRisk, missionRisk - decoys * c.decoyRed));
    const detect = Math.max(c.minChance, Math.round(agentRiskRaw * 10) / 10);
    const base = Math.min(Math.round((1 - Math.pow(1 - m.successChance / 100, agents)) * 100), c.maxSucc);
    const success = agents === 0 ? 0 : Math.round(Math.min(c.maxChance, Math.max(c.minChance, ((100 - agentRiskRaw) * base) / 100)));
    const decoyRisk = Math.max(c.minChance, Math.min(c.maxChance, gov + Math.max(decoys * c.minDecoy, missionRisk / 4 - 50 + decoys * c.basicDecoy)));
    // Three outcomes that sum to 100: caught / succeed / fail-but-escape.
    const empty = Math.max(0, 100 - detect - success);
    // Expected spies caught (executed fraction is an unknown constant -> caught, not lost).
    const expCaught = (agents * detect + decoys * decoyRisk) / 100;
    // Costs.
    const costGold = agents * (m.gold || 0);
    const decoyMap = m[c.decoyKey] || {};
    let decoyRes = "", decoyPer = 0;
    if (c.wine in decoyMap) { decoyRes = "wine"; decoyPer = decoyMap[c.wine]; }
    else if (c.sulfur in decoyMap) { decoyRes = "sulfur"; decoyPer = decoyMap[c.sulfur]; }
    else if (c.gold in decoyMap) { decoyRes = "gold"; decoyPer = decoyMap[c.gold]; }
    return {
      agents, decoys, detect, success, empty, decoyRisk, expCaught,
      costGold, decoyRes, decoyCost: decoys * decoyPer,
    };
  }

  function buildLandscape(data, mid) {
    const pool = data.pool || 0;
    const all = [];
    for (let a = 1; a <= pool; a++) {
      for (let d = 0; d <= pool - a; d++) {
        const r = computeCombo(data, mid, a, d);
        if (r) all.push(r);
      }
    }
    return all;
  }

  // Knee of the front: point with max perpendicular distance from the line
  // joining the endpoints. Used only as a sensible default selection.
  function kneeIndex(front) {
    if (front.length <= 2) return front.length - 1;
    const x0 = front[0].detect, y0 = front[0].success;
    const x1 = front[front.length - 1].detect, y1 = front[front.length - 1].success;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    let best = 0, bestD = -1;
    for (let i = 1; i < front.length - 1; i++) {
      const d = Math.abs(dy * (front[i].detect - x0) - dx * (front[i].success - y0)) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // --- rendering ----------------------------------------------------------

  const PLOT = { left: 46, right: 16, top: 14, bottom: 34 };

  // Round a max detection % up to a tidy axis ceiling (min 10, cap 100).
  function niceCeil(v) {
    if (!(v > 0)) return 10;
    const step = v <= 18 ? 5 : 10;
    return Math.max(10, Math.min(100, Math.ceil(v / step) * step));
  }

  // green (few caught) -> red (many caught)
  function caughtColor(expCaught, minC, maxC) {
    const t = maxC > minC ? (expCaught - minC) / (maxC - minC) : 0;
    const hue = 120 * (1 - Math.max(0, Math.min(1, t)));
    return `hsl(${hue}, 72%, 46%)`;
  }

  function drawChart(canvas, points, selIdx, xMax) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const px = (v) => PLOT.left + (v / xMax) * (W - PLOT.left - PLOT.right);
    const py = (v) => H - PLOT.bottom - (v / 100) * (H - PLOT.top - PLOT.bottom);
    const xStep = xMax <= 20 ? 5 : xMax <= 60 ? 10 : 20;

    // grid + axes
    ctx.strokeStyle = "#2a3040";
    ctx.fillStyle = "#8890a0";
    ctx.font = "10px sans-serif";
    ctx.lineWidth = 1;
    for (let t = 0; t <= 100; t += 20) {  // horizontal grid + success (Y) labels
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(px(0), py(t)); ctx.lineTo(px(xMax), py(t)); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = "right"; ctx.fillText(t + "", PLOT.left - 6, py(t) + 3);
    }
    for (let t = 0; t <= xMax; t += xStep) {  // vertical grid + detection (X) labels
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(px(t), py(0)); ctx.lineTo(px(t), py(100)); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = "center"; ctx.fillText(t + "", px(t), py(0) + 14);
    }
    ctx.fillStyle = "#aab2c4";
    ctx.textAlign = "center";
    ctx.fillText("detection %  (← safer)", (px(0) + px(xMax)) / 2, H - 4);
    ctx.save();
    ctx.translate(12, (py(0) + py(100)) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("success %", 0, 0);
    ctx.restore();

    // expected-caught color range across all shown dots
    const curve = points.slice().sort((a, b) => a.detect - b.detect);
    let minC = Infinity, maxC = -Infinity;
    for (const p of curve) { if (p.expCaught < minC) minC = p.expCaught; if (p.expCaught > maxC) maxC = p.expCaught; }

    // connecting curve
    if (curve.length > 1) {
      ctx.strokeStyle = "#3a4656";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      curve.forEach((p, i) => { const x = px(p.detect), y = py(p.success); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }

    // dots — one per detection %, colored green->red by expected spies caught
    for (const p of curve) {
      const x = px(p.detect), y = py(p.success);
      ctx.fillStyle = caughtColor(p.expCaught, minC, maxC);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke();
    }

    // selected point (any point, on-front or not) — crosshair + emphasized dot
    const sel = selIdx != null ? points[selIdx] : null;
    if (sel) {
      const sx = px(sel.detect), sy = py(sel.success);
      ctx.strokeStyle = "#566";
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px(0), sy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, py(0)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = caughtColor(sel.expCaught, minC, maxC);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 7); ctx.fill(); ctx.stroke();
    }
  }

  // --- panel UI -----------------------------------------------------------

  let panel = null;
  let state = null; // { data, mid, points (sorted by detection %), selIdx }

  function fmtCost(p) {
    const parts = [];
    if (p.costGold) parts.push(p.costGold + " gold");
    if (p.decoyCost) parts.push(p.decoyCost + " " + p.decoyRes);
    return parts.length ? parts.join(" + ") : "free";
  }

  function renderFooter(applied) {
    const foot = panel.querySelector("#ik-spy-foot");
    const p = state.points[state.selIdx];
    if (!p) { foot.innerHTML = '<span style="color:#7a8290">Click a point to set the sliders.</span>'; return; }
    const status = applied
      ? '<span style="color:#7fd17f">✓ sliders set — press the game\'s send button</span>'
      : '<span style="color:#7a8290">click a point to set the sliders</span>';
    foot.innerHTML =
      '<div style="line-height:1.5">' +
        '<b style="color:#e0e4ec">' + p.agents + " agents + " + p.decoys + " decoys</b><br>" +
        '<span style="color:#7fd17f">succeed ' + p.success + "%</span> · " +
        '<span style="color:#e08a8a">caught ' + p.detect + "%</span> · " +
        '<span style="color:#c0c4cc">empty-handed ' + p.empty + "%</span><br>" +
        '<span style="color:#aab2c4">~' + p.expCaught.toFixed(2) + " spies caught/run · " + fmtCost(p) + "</span>" +
        "<br>" + status +
      "</div>";
  }

  function recompute() {
    const all = buildLandscape(state.data, state.mid);
    // One dot per detection %: keep only the highest-success combo at each risk
    // level (ties broken by the cheaper combo). Anything else at the same
    // detection is strictly worse, so it's hidden.
    const cell = new Map();
    for (const p of all) {
      const cur = cell.get(p.detect);
      if (!cur || p.success > cur.success ||
        (p.success === cur.success && (p.agents + p.decoys) < (cur.agents + cur.decoys))) {
        cell.set(p.detect, p);
      }
    }
    const points = [...cell.values()].sort((a, b) => a.detect - b.detect);
    state.points = points;
    const canvas = panel.querySelector("#ik-spy-canvas");
    if (!points.length) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      panel.querySelector("#ik-spy-foot").textContent = "No valid combinations for this mission.";
      return;
    }
    // Auto-scale the detection axis to the data so we don't show empty space.
    const maxDetect = points.reduce((m, p) => Math.max(m, p.detect), 0);
    state.xMax = niceCeil(maxDetect);
    // Default selection: the knee of the curve (points already sorted by detection).
    state.selIdx = kneeIndex(points);
    drawChart(canvas, points, state.selIdx, state.xMax);
    renderFooter();
  }

  function onCanvasClick(e) {
    if (!state || !state.points || !state.points.length) return;
    const canvas = panel.querySelector("#ik-spy-canvas");
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    const xMax = state.xMax || 100;
    const px = (v) => PLOT.left + (v / xMax) * (canvas.width - PLOT.left - PLOT.right);
    const py = (v) => canvas.height - PLOT.bottom - (v / 100) * (canvas.height - PLOT.top - PLOT.bottom);
    let best = -1, bestD = 16 * 16; // generous radius so dots are easy to hit
    state.points.forEach((p, i) => {
      const dx = px(p.detect) - mx, dy = py(p.success) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) {
      state.selIdx = best;
      const p = state.points[best];
      applyCombo(state.data.cityId, p.agents, p.decoys);
      drawChart(canvas, state.points, state.selIdx, xMax);
      renderFooter(true);
    }
  }

  // Embedded inline at the bottom of the spy view (#mainview), not a floating
  // panel — so it lives and dies with the view and scrolls with the popup.
  function buildPanel() {
    // Anchor to elements that are part of the spy form itself, so we never
    // depend on a container id that might differ across skins/views.
    const anchor = document.getElementById("missionSummary")
      || document.getElementById("missionForm")
      || document.getElementById("mainview");
    if (!anchor) return null;
    const el = document.createElement("div");
    el.id = "ik-spy-embed";
    el.style.cssText = "margin:12px auto 4px;max-width:520px;background:#141824;border:1px solid #2a3040;" +
      "border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#c8cdd8;clear:both";
    el.innerHTML =
      '<div style="padding:7px 12px;border-bottom:1px solid #2a3040;background:#1a1f2e;border-radius:8px 8px 0 0">' +
        '<span style="font-weight:600;color:#e0e4ec;font-size:13px">Spy planner — all combinations</span>' +
      "</div>" +
      '<div style="padding:10px 12px">' +
        '<canvas id="ik-spy-canvas" width="496" height="300" style="width:496px;height:300px;max-width:100%;cursor:pointer;display:block"></canvas>' +
        '<div style="font-size:10px;color:#7a8290;margin-top:4px">one dot per detection % (best success at that risk) · <span style="color:#3ec23e">green</span> = few spies caught → <span style="color:#d23e3e">red</span> = many</div>' +
        '<div id="ik-spy-foot" style="margin-top:8px;font-size:12px;min-height:60px">Computing…</div>' +
      "</div>";
    if (anchor.id === "missionForm") anchor.appendChild(el);
    else anchor.insertAdjacentElement("afterend", el);
    el.querySelector("#ik-spy-canvas").addEventListener("click", onCanvasClick);
    return el;
  }

  async function loadAndCompute() {
    const data = await readSpyData();
    if (!panel || !panel.isConnected) return; // view changed while reading
    if (!data || !data.ok || !data.pool) {
      panel.querySelector("#ik-spy-foot").textContent =
        "Couldn't read mission data — try switching the mission.";
      return;
    }
    state = { data, mid: getCurrentMid() || data.selectedMission, points: [], selIdx: null };
    recompute();
    // The new content grew the popup height — let the game's scrollbar catch up.
    IkUtils.ensureBridge().then(() => window.dispatchEvent(new CustomEvent("ik-refresh-scrollbar")));
  }

  // --- injection ----------------------------------------------------------

  // Read the selected mission id exactly like the game does, from the live
  // <select>. We can't rely on a "change" event: Ikariam's custom dropdown
  // calls spyMissionChanged() directly, so the native <select> never fires one.
  function getCurrentMid() {
    const sel = document.getElementById("missionSelect");
    if (!sel) return null;
    const opt = sel.options && sel.options[sel.selectedIndex];
    return opt ? opt.value : sel.value;
  }

  // Watch the mission form for the in-place updates spyMissionChanged() makes
  // (description text, mission image class) and re-plot whenever the selected
  // mission actually changes.
  function watchMission() {
    // Observe the whole spy view, not just #missionForm: spyMissionChanged()
    // updates the mission image / description, and those nodes' exact nesting
    // isn't guaranteed. The callback is cheap and only re-plots on a real change.
    const root = document.getElementById("mainview") || document.getElementById("missionForm");
    if (!root || root.dataset.ikSpyMidWatch) return;
    root.dataset.ikSpyMidWatch = "1";
    const mo = new MutationObserver(() => {
      if (!panel || !panel.isConnected || !state) return;
      const mid = getCurrentMid();
      if (mid != null && mid !== state.mid) { state.mid = mid; recompute(); }
    });
    mo.observe(root, { attributes: true, childList: true, subtree: true, characterData: true });
  }

  function ensureEmbed() {
    if (!document.getElementById("missionForm") || !document.getElementById("missionSummary")) return;
    if (panel && panel.isConnected) return; // already embedded in this view
    panel = buildPanel();
    if (!panel) return;
    state = null;
    watchMission();
    loadAndCompute();
  }

  // The spy form arrives via AJAX into the popup; watch for it and auto-embed.
  const obs = new MutationObserver(() => {
    if (document.getElementById("missionForm") && document.getElementById("missionSummary")) {
      ensureEmbed();
    } else if (panel && !document.getElementById("missionForm")) {
      panel = null; state = null; // view replaced; the node went with #mainview
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  ensureEmbed();
})();

// Auto-launch pirate missions when user is idle
(() => {
  // Only run on game pages (s1-en.ikariam...), not forum/lobby
  if (!/^s\d+/.test(location.hostname)) return;
  const P = "[AP]";
  const NAVIGATE_COOLDOWN = 15000;
  const MISSION_DURATIONS = [150, 450]; // tier 1 = 2m30s, tier 2 = 7m30s

  let enabled = false;
  let convertEnabled = false;
  let aggressive = false;
  let pirateCityId = null;
  let idleTimeout = 5000;

  // Aggressive mode halves all human-like waits (pauses, breaks, idle, polling,
  // convert + navigate delays). Mission durations are real game cooldowns and
  // are NOT scaled. Used to simulate higher engagement on the last day of a comp.
  function tm() { return aggressive ? 0.5 : 1.0; }

  // --- Session counters (for logging) ---
  let sessionRaids = 0;
  let sessionT1 = 0;
  let sessionT2 = 0;
  let sessionBreakCount = 0;
  let sessionBreakMs = 0;
  let sessionConverts = 0;

  // --- Tunable timing parameters (randomized per-user, stored in chrome.storage) ---
  let cfg = {
    sleepStart: 1,       // hour when bot stops
    sleepEnd: 7,          // hour when bot can resume
    // High-throughput profile (TUNE_VERSION 2): same humanization mechanics
    // (distraction, fatigue, tempo, breaks, post-break re-engagement) but the
    // distribution is shifted faster — shorter/tighter delays, longer streaks,
    // shorter breaks. Tuned from real log data toward ~30-35k pts/day.
    baseMu: 2.5,          // log-normal center (higher = slower)
    baseSigma: 0.6,       // log-normal spread (lower = fewer long-delay outliers)
    breakMin: 2,           // streak break min duration (minutes)
    breakMax: 5,           // streak break max duration (minutes)
    streakLo: 18,          // min raids before break hazard starts
    streakHi: 28,          // raids where break becomes near-certain
    distractChance: 0.06,  // chance to enter distracted state per raid
    // T2 kept close to the original pattern (ramp toward break + distraction
    // elevation), just trimmed slightly — T1 is a bit denser post-nav-fix, but
    // the small points cost (~2%) is worth the natural-looking variety.
    t2Base: 0.08,          // base T2 chance (early in streak)
    t2Ramp: 0.50,          // T2 sigmoid max addition (peaks near break)
    t2Distract: 0.38,      // T2 chance during distraction state
    forceBreakChance: 0.20, // chance T2 triggers immediate break
    backToBackChance: 0.15, // chance to allow consecutive T2
  };
  let sleepJitter = (Math.random() - 0.5) * 20; // +/- 10 min daily variance
  let sleepJitterDate = new Date().toDateString(); // track date for daily re-roll

  let lastActivity = Date.now();
  let inControl = false;
  let nextActionTime = 0;
  let lastNavigateTime = 0;
  let checkTimer = null;
  let lastPopupHeartbeat = 0;

  // --- Humanized timing state ---
  let streakCount = 0;
  let distractionMu = 0;
  let distractionRaids = 0;
  let sessionStartTime = Date.now();
  let lastMissionWasT2 = false;
  let forceBreakNext = false;
  let postBreakRaids = 0; // raids remaining in post-break re-engagement
  let tempo = 0; // AR(1) latent speed variable (adds momentum to delays)
  let raidsSinceLastConvert = 0; // resets on break and after convert
  let raidInProgress = false;

  function fmt(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m" + (s % 60) + "s";
  }

  // --- Stats reporting for popup ---
  let lastReportedStats = "";
  function reportStats() {
    const stats = sessionStats();
    if (stats === lastReportedStats) return;
    lastReportedStats = stats;
    chrome.storage.local.set({ pirateStatus: { stats, ts: Date.now() } });
  }

  function ts() {
    const d = new Date();
    return d.getHours().toString().padStart(2, "0") + ":" +
      d.getMinutes().toString().padStart(2, "0") + ":" +
      d.getSeconds().toString().padStart(2, "0");
  }

  function sessionStats() {
    const elapsed = (Date.now() - sessionStartTime) / 3600000;
    const rate = elapsed > 0.01 ? (sessionRaids / elapsed).toFixed(1) : "0";
    return sessionRaids + " raids (" + sessionT1 + "×T1 " + sessionT2 + "×T2), " +
      rate + "/h, " + sessionBreakCount + " breaks (" + fmt(sessionBreakMs) + "), " +
      sessionConverts + " converts";
  }

  function saveState() {
    chrome.storage.local.set({
      pirateState: {
        sessionStartTime, sessionRaids, sessionT1, sessionT2,
        sessionBreakCount, sessionBreakMs, sessionConverts,
        streakCount, raidsSinceLastConvert, nextActionTime,
        forceBreakNext, lastMissionWasT2, tempo,
        distractionRaids, distractionMu, postBreakRaids,
        lastSaveTime: Date.now(),
      }
    });
  }

  function restoreState(s) {
    if (!s || !s.sessionStartTime || !s.lastSaveTime) return;

    const now = Date.now();
    const isNewDay = new Date(now).toDateString() !== new Date(s.sessionStartTime).toDateString();
    const gap = now - s.lastSaveTime;
    const isLongGap = gap > 45 * 60 * 1000; // 45min = longer than any break

    // New calendar day — full reset (user expects fresh daily stats)
    if (isNewDay) return;

    // Restore daily session counters
    sessionStartTime = s.sessionStartTime;
    sessionRaids = s.sessionRaids || 0;
    sessionT1 = s.sessionT1 || 0;
    sessionT2 = s.sessionT2 || 0;
    sessionBreakCount = s.sessionBreakCount || 0;
    sessionBreakMs = s.sessionBreakMs || 0;
    sessionConverts = s.sessionConverts || 0;

    if (isLongGap) {
      // Long gap — a natural break happened offline, reset tactical state
      streakCount = 0;
      raidsSinceLastConvert = 0;
      nextActionTime = 0;
    } else {
      // Quick reload — preserve everything
      streakCount = s.streakCount || 0;
      raidsSinceLastConvert = s.raidsSinceLastConvert || 0;
      nextActionTime = s.nextActionTime || 0;
      forceBreakNext = !!s.forceBreakNext;
      lastMissionWasT2 = !!s.lastMissionWasT2;
      tempo = s.tempo || 0;
      distractionRaids = s.distractionRaids || 0;
      distractionMu = s.distractionMu || 0;
      postBreakRaids = s.postBreakRaids || 0;
    }
  }

  // --- Daily activity log (real-data capture for tuning) ---
  // Durable per-day record of raid counts + a work/foreground duty-cycle, so
  // expected-vs-actual can be compared and timing params tuned from real data.
  // Unlike the session counters this is NOT reset daily — it's the history.
  // Survives reloads/SW restarts via read-modify-add merge; pruned to the last
  // DAILY_LOG_KEEP days.
  const DAILY_LOG_KEEP = 30;
  const DLOG_FIELDS = ["raids", "t1", "t2", "userRaids", "ut1", "ut2", "breaks", "breakMs", "converts", "workMs", "fgMs"];
  function emptyDLog() {
    const o = {};
    for (const f of DLOG_FIELDS) o[f] = 0;
    return o;
  }
  let dLog = emptyDLog();
  let lastTickTs = 0;
  let lastLogFlush = 0;

  function logKey() { return "pirateDailyLog_" + IkUtils.getUrlWorldName(); }

  function dayKey() {
    const d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function logEmpty() {
    return DLOG_FIELDS.every((f) => !dLog[f]);
  }

  function flushLog() {
    if (logEmpty()) return;
    const d = dLog;
    dLog = emptyDLog();
    lastLogFlush = Date.now();
    const key = logKey();
    const day = dayKey();
    chrome.storage.local.get(key, (res) => {
      const log = res[key] || {};
      const r = log[day] || Object.assign(emptyDLog(), { firstTs: Date.now() });
      for (const f of DLOG_FIELDS) r[f] = (r[f] || 0) + d[f];
      r.lastTs = Date.now();
      log[day] = r;
      const days = Object.keys(log).sort();
      while (days.length > DAILY_LOG_KEEP) delete log[days.shift()];
      chrome.storage.local.set({ [key]: log });
    });
  }

  // Attribute wall-clock between polls to work (bot could raid) vs foreground
  // (blocked by active/focused user). Large gaps = PC asleep/tab suspended → dropped.
  function accrueTickTime() {
    const now = Date.now();
    const prev = lastTickTs;
    lastTickTs = now;
    if (!prev) { trackPhase(); return; }
    const delta = now - prev;
    if (delta > 0 && delta <= 15000) {                // gap (PC asleep/suspended) → don't attribute
      if (enabled && pirateCityId && isInActiveHours()) {
        if (raidInProgress || Date.now() < nextActionTime) dLog.workMs += delta; // raid/delay/break = productive pacing
        else if (!isIdle()) dLog.fgMs += delta;       // blocked by foreground user
        else dLog.workMs += delta;                    // idle & ready to raid
      }
    }
    trackPhase();
    if (now - lastLogFlush > 30000) flushLog();
    if (evBuf.length && now - lastEvFlush > 10000) flushEvents();
  }

  // --- Granular event stream (full reconstruction of the day) ---
  // Append-only timeline so every state change can be replayed: bot on/off,
  // each raid/break/convert, phase transitions (sleep/foreground/ready/...),
  // and raw focus/visibility changes. Chunked per day with a 14-day index,
  // buffered in memory and flushed in batches. unlimitedStorage is enabled.
  const EVENT_LOG_KEEP_DAYS = 14;
  let evBuf = [];
  let lastEvFlush = 0;
  let prevPhase = null;
  let captchaSeen = false;

  function evDayOf(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  function evKey(day) { return "pirateEvents_" + IkUtils.getUrlWorldName() + "_" + day; }
  function evIdxKey() { return "pirateEventsIdx_" + IkUtils.getUrlWorldName(); }

  function logEvent(e, extra) {
    // Track only while the bot runs — except "off" (logged at stop) and
    // "userRaid" (manual missions are relevant even when the bot is disabled).
    if (!enabled && e !== "off" && e !== "userRaid") return;
    const ev = { t: Date.now(), e };
    if (extra) Object.assign(ev, extra);
    evBuf.push(ev);
    if (evBuf.length >= 20 || Date.now() - lastEvFlush > 10000) flushEvents();
  }

  function flushEvents() {
    if (!evBuf.length) return;
    const batch = evBuf;
    evBuf = [];
    lastEvFlush = Date.now();
    const byDay = {};
    for (const ev of batch) (byDay[evDayOf(ev.t)] = byDay[evDayOf(ev.t)] || []).push(ev);
    const days = Object.keys(byDay);
    const idxKey = evIdxKey();
    chrome.storage.local.get(days.map(evKey).concat(idxKey), (res) => {
      const idx = res[idxKey] || { days: [] };
      const toSet = {};
      for (const day of days) {
        const arr = res[evKey(day)] || [];
        arr.push(...byDay[day]);
        toSet[evKey(day)] = arr;
        if (!idx.days.includes(day)) idx.days.push(day);
      }
      idx.days.sort();
      const removeKeys = [];
      while (idx.days.length > EVENT_LOG_KEEP_DAYS) removeKeys.push(evKey(idx.days.shift()));
      toSet[idxKey] = idx;
      chrome.storage.local.set(toSet, () => {
        if (removeKeys.length) chrome.storage.local.remove(removeKeys);
      });
    });
  }

  function currentPhase() {
    if (!enabled || !pirateCityId) return "off";
    if (!isInActiveHours()) return "sleep";
    if (raidInProgress) return "raiding";
    if (Date.now() < nextActionTime) return "waiting";
    if (!isIdle()) return "foreground";   // user present / tab focused → bot blocked
    return "ready";                       // idle & able to raid
  }

  // Manual (user-clicked) pirate mission. The bot launches via AJAX nav and
  // never fires a real click on a capture button, so any genuine click here is
  // the user. Tracked even when the bot is off (still earns points for the day).
  function logUserRaid(tier) {
    dLog.userRaids++;
    if (tier === 0) dLog.ut1++; else dLog.ut2++;
    logEvent("userRaid", { tier });
    flushLog();
  }

  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest("#pirateCaptureBox a.button.capture");
    if (!btn) return;
    const btns = Array.from(document.querySelectorAll("#pirateCaptureBox a.button.capture"));
    const idx = btns.indexOf(btn);
    logUserRaid(idx < 0 ? 0 : idx);
  }, true);

  // Emit a "phase" event only when the derived phase changes (no per-tick spam).
  function trackPhase() {
    const p = currentPhase();
    if (p === prevPhase) return;
    prevPhase = p;
    logEvent("phase", { p });
  }

  // --- Idle detection ---
  function onActivity() {
    if (!document.hasFocus() || document.hidden) return;
    lastActivity = Date.now();
    if (inControl) {
      logEvent("return");   // user came back and took over while bot was active
      handBack();
    }
  }

  ["mousemove", "keydown", "click", "scroll", "mousedown"].forEach((e) =>
    document.addEventListener(e, onActivity, { passive: true, capture: true })
  );
  document.addEventListener("visibilitychange", () => {
    logEvent(document.hidden ? "hidden" : "visible");
    if (!document.hidden) onActivity();
  });
  window.addEventListener("focus", () => {
    logEvent("focus");
    onActivity();
  });
  window.addEventListener("blur", () => {
    logEvent("blur");
  });

  function handBack() {
    inControl = false;
    // Preserve nextActionTime so remaining delay survives user interruptions
    lastNavigateTime = 0;
    convertTimers.forEach((id) => clearTimeout(id));
    convertTimers = [];
    if (preRefreshTimer) { clearTimeout(preRefreshTimer); preRefreshTimer = null; }
  }

  // --- Pre-refresh nav fix ---
  // Reload the fortress booty box the moment the mission returns (crew back), so
  // the next capture button is ready *during* the remaining human delay instead of
  // adding navigation latency after it. Hides per-raid nav cost inside the cooldown.
  // Guarded so it only runs when the bot is idle and in control; otherwise the
  // normal poll-driven navigation at nextActionTime still handles it (fallback).
  let preRefreshTimer = null;
  function schedulePreRefresh(ms) {
    if (preRefreshTimer) clearTimeout(preRefreshTimer);
    preRefreshTimer = setTimeout(() => {
      preRefreshTimer = null;
      if (!enabled || !inControl || !pirateCityId || raidInProgress || !isIdle()) return;
      // Already have a fresh capture button, or the mission is somehow still running
      if (document.querySelector("#pirateCaptureBox a.button.capture")) return;
      if (document.querySelector("#pirateCaptureBox .red_box")) return;
      const onPirateCity = document.body.id === "city" && location.search.includes("cityId=" + pirateCityId);
      if (onPirateCity || document.querySelector("#pirateFortress_c")) {
        navigate("?view=pirateFortress&activeTab=tabBootyQuest&cityId=" + pirateCityId + "&position=17");
      }
    }, ms);
  }

  function isIdle() {
    if (Date.now() - lastPopupHeartbeat < 10000) return false;
    // document.hasFocus() is true when any element in the page has focus,
    // including iframes (e.g. the in-game shop) — so clicking an iframe
    // won't falsely trigger idle detection like the old windowFocused flag did.
    return (document.hidden || !document.hasFocus()) && Date.now() - lastActivity > idleTimeout * tm();
  }

  function isInActiveHours() {
    if (cfg.sleepStart === null || cfg.sleepEnd === null) return true;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const sleepStartMins = cfg.sleepStart * 60 + sleepJitter;
    const sleepEndMins = cfg.sleepEnd * 60 + sleepJitter;
    // Sleep window: if inside it, NOT active
    if (sleepStartMins < sleepEndMins) {
      return !(mins >= sleepStartMins && mins < sleepEndMins);
    }
    return !(mins >= sleepStartMins || mins < sleepEndMins);
  }

  // --- Random number generators ---
  function randn() {
    const u = 1 - Math.random();
    const v = 1 - Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function lognormal(mu, sigma) {
    return Math.exp(mu + sigma * randn());
  }

  // --- Hazard-based break probability (sigmoid, rises with streak) ---
  function getBreakHazard() {
    if (streakCount < cfg.streakLo) return 0;
    const midpoint = (cfg.streakLo + cfg.streakHi) / 2;
    const steepness = 6 / (cfg.streakHi - cfg.streakLo);
    return 1 / (1 + Math.exp(-steepness * (streakCount - midpoint)));
  }

  // --- Contextual tier selection (sigmoid ramp + state) ---
  function getT2Probability() {
    if (lastMissionWasT2) return cfg.backToBackChance;

    let chance = cfg.t2Base;

    // Post-break: lower T2 (player is re-engaged, picks fast option)
    if (postBreakRaids > 0) return Math.max(chance * 0.3, 0.02);

    // Distraction: flat elevated chance (player picks lazy option)
    if (distractionRaids > 0) {
      chance = Math.max(chance, cfg.t2Distract);
    }

    // Sigmoid ramp: T2 increasingly likely as streak approaches break
    const progress = Math.min(streakCount / cfg.streakHi, 1.0);
    const sigmoid = cfg.t2Ramp / (1 + Math.exp(-8 * (progress - 0.6)));
    chance += sigmoid;

    return chance;
  }

  function randomDelay() {
    streakCount++;

    // --- Break decision: hazard-based OR T2-forced ---
    const breakRoll = Math.random() < getBreakHazard();
    if (breakRoll || forceBreakNext) {
      const wasForced = forceBreakNext;
      forceBreakNext = false;

      // Correlated break duration: longer streak = longer break
      const streakFactor = Math.min(streakCount / cfg.streakHi, 1.0);
      const dynBreakMin = cfg.breakMin + streakFactor * 2;
      const breakMu = Math.log((dynBreakMin + cfg.breakMax) / 2 * 60);
      const breakD = Math.min(lognormal(breakMu, 0.4), (cfg.breakMax + 5) * 60);
      const d = Math.max(breakD, (dynBreakMin - 2) * 60) * 1000 * tm();

      sessionBreakCount++;
      sessionBreakMs += d;
      dLog.breaks++;
      dLog.breakMs += d;
      logEvent("break", { ms: Math.round(d), forced: wasForced });
      // deadline is approximate — actual nextActionTime includes mission duration,
      // but break is the dominant component and gets refined on next poll
      reportStats();
      streakCount = 0;
      raidsSinceLastConvert = 0;

      // Post-break re-engagement: probability-based, 1-3 faster raids
      if (Math.random() < 0.70) {
        postBreakRaids = 1 + Math.floor(Math.random() * 3);
      }
      return d;
    }

    // --- Post-break state: slightly faster, less distracted ---
    if (postBreakRaids > 0) postBreakRaids--;

    // --- Distraction state ---
    if (distractionRaids <= 0) {
      distractionMu = 0;
      const distractRoll = postBreakRaids > 0 ? cfg.distractChance * 0.3 : cfg.distractChance;
      if (Math.random() < distractRoll) {
        distractionMu = 0.5 + Math.random() * 1.0;
        distractionRaids = 2 + Math.floor(Math.random() * 4);
      }
    }
    if (distractionRaids > 0) distractionRaids--;

    // --- AR(1) tempo: creates natural momentum in delays ---
    tempo = 0.6 * tempo + 0.15 * randn();

    // --- Session fatigue: saturating exponential ---
    const sessionHours = (Date.now() - sessionStartTime) / 3600000;
    const fatigueMu = 0.5 * (1 - Math.exp(-0.3 * sessionHours));

    // --- Post-break speed boost ---
    const postBreakMu = postBreakRaids > 0 ? -0.3 : 0;

    const mu = cfg.baseMu + distractionMu + fatigueMu + postBreakMu + tempo;
    const sigma = cfg.baseSigma;
    const softCap = (20 + Math.random() * 10) * 60;
    const delaySec = Math.min(lognormal(mu, sigma), softCap);
    const d = Math.max(delaySec, 3 + Math.random() * 2) * 1000 * tm();
    return d;
  }

  function navigate(url) {
    IkUtils.ensureBridge();
    window.dispatchEvent(new CustomEvent("ik-ajax-call", { detail: { url } }));
  }

  // --- Auto-convert: pirate points → crew strength ---
  let convertTimers = [];
  function scheduleConvert(fn, ms) {
    const id = setTimeout(() => {
      convertTimers = convertTimers.filter((t) => t !== id);
      fn();
    }, ms);
    convertTimers.push(id);
  }

  function getConvertChance() {
    // High after break (90%), decays exponentially over raids
    return 0.9 * Math.exp(-0.4 * raidsSinceLastConvert);
  }

  function tryConvert() {
    if (!convertEnabled) return;
    if (!inControl || !isIdle() || !pirateCityId) return;
    const chance = getConvertChance();
    if (Math.random() >= chance) return;

    // Schedule convert with 2-6s delay (player switches tab after launching raid)
    const delay = (2 + Math.random() * 4) * 1000 * tm();
    scheduleConvert(() => {
      if (!inControl || !isIdle() || !convertEnabled) return;
      navigate("?view=pirateFortress&activeTab=tabCrew&cityId=" + pirateCityId + "&position=17");
      waitForConvertForm();
    }, delay);
  }

  function waitForConvertForm() {
    // Check immediately
    if (checkConvertDom()) return;
    // Watch for AJAX content to load
    const obs = new MutationObserver(() => {
      if (checkConvertDom()) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }

  function checkConvertDom() {
    if (document.getElementById("ongoingConversion")) return true;
    const form = document.getElementById("CPToCrewForm");
    if (form) {
      submitConvert();
      return true;
    }
    return false;
  }

  function submitConvert() {
    // Wait 1-3s, click slider max (via bridge), then wait and click submit
    const fillDelay = (1 + Math.random() * 2) * 1000 * tm();
    scheduleConvert(() => {
      if (!inControl || !isIdle()) return;
      if (!document.getElementById("CPToCrewForm")) return;
      // Click slider max via bridge (page context handles slider JS)
      IkUtils.ensureBridge();
      window.dispatchEvent(new CustomEvent("ik-convert-crew"));

      // Wait 0.5-1.5s for game JS to update slider + enable submit button
      const submitDelay = (500 + Math.random() * 1000) * tm();
      scheduleConvert(() => {
        if (!inControl || !isIdle()) return;
        // Check we have at least 500 capture points before converting
        const cpEl = document.querySelector(".pirateHeader .capturePoints .value");
        const cpVal = cpEl ? parseInt(cpEl.textContent.replace(/\s/g, ""), 10) : 0;
        if (isNaN(cpVal) || cpVal < 500) return;
        const submitBtn = document.getElementById("CPToCrewSubmit");
        if (!submitBtn || submitBtn.classList.contains("button_disabled")) return;
        submitBtn.click();
        raidsSinceLastConvert = 0;
        sessionConverts++;
        dLog.converts++;
        logEvent("convert");
        saveState();
      }, submitDelay);
    }, fillDelay);
  }

  // --- Main loop ---
  function tryPirate() {
    try {
      accrueTickTime();
      if (raidInProgress) { reportStats(); return; }
      if (scanActive) { reportStats(); return; }
      if (!enabled || !pirateCityId) {
        if (enabled && !pirateCityId) reportStats();
        return;
      }

      if (!isIdle()) { reportStats(); return; }

      if (!isInActiveHours()) { reportStats(); return; }

      if (Date.now() < nextActionTime) { reportStats(); return; }

      if (!inControl) {
        const idleDuration = Date.now() - lastActivity;
        inControl = true;

        // Long interruption: decay transient states
        if (idleDuration > 30 * 60 * 1000) {
          distractionRaids = 0;
          distractionMu = 0;
          forceBreakNext = false;
          postBreakRaids = 0;
          tempo = 0;
        }
      }

      // Daily sleep jitter re-roll
      const today = new Date().toDateString();
      if (today !== sleepJitterDate) {
        sleepJitter = (Math.random() - 0.5) * 20;
        sleepJitterDate = today;
      }

      if (document.querySelector("#cinema_c")) return;

      if (document.querySelector("img.captchaImage")) {
        if (!captchaSeen) { captchaSeen = true; logEvent("captcha"); }
        return;
      }
      captchaSeen = false;

      // Close any open building/view panel (port, shipyard, etc.) that blocks fortress navigation
      const openView = document.querySelector(".templateView:not(#pirateFortress_c) .close");
      if (openView && !document.querySelector("#pirateCaptureBox")) {
        openView.click();
        return;
      }

      // Mission still running — crew is out, just wait
      if (document.querySelector("#pirateCaptureBox .red_box")) return;

      const captureBtns = document.querySelectorAll("#pirateCaptureBox a.button.capture");
      if (captureBtns.length > 0) {
        // Contextual tier selection: T2 chance scales with streak + distraction
        let tier = 0;
        const t2Prob = getT2Probability(); // cache to avoid double-call
        if (captureBtns.length > 1 && Math.random() < t2Prob) tier = 1;

        // Track T2 state for break correlation
        lastMissionWasT2 = (tier === 1);
        if (lastMissionWasT2 && Math.random() < cfg.forceBreakChance) {
          forceBreakNext = true;
        }

        const captureBtn = captureBtns[tier];
        const href = captureBtn.getAttribute("href");
        const duration = MISSION_DURATIONS[tier] || MISSION_DURATIONS[0];
        raidInProgress = true;
        reportStats();
        navigate(href);
        const delay = randomDelay();
        const total = duration * 1000 + delay;
        nextActionTime = Date.now() + total;
        lastNavigateTime = 0;
        sessionRaids++;
        if (tier === 0) sessionT1++; else sessionT2++;
        dLog.raids++;
        if (tier === 0) dLog.t1++; else dLog.t2++;
        logEvent("raid", { tier, dur: duration });
        raidsSinceLastConvert++;
        saveState();
        // Safety net: clear raidInProgress after 30s in case normal flow fails
        setTimeout(() => { raidInProgress = false; }, 45000);
        // Delay convert start so raid AJAX can complete before we navigate away
        scheduleConvert(() => {
          raidInProgress = false;
          tryConvert();
        }, (3000 + Math.random() * 1000) * tm());
        // Nav fix: refresh the fortress ~2s after the crew returns so the next
        // capture button loads during the remaining delay, not after it.
        schedulePreRefresh(duration * 1000 + 2000);
        return;
      }

      reportStats();
      if (Date.now() - lastNavigateTime > NAVIGATE_COOLDOWN * tm()) {
        lastNavigateTime = Date.now();
        const bodyId = document.body.id;
        const onPirateCity = bodyId === "city" && location.search.includes("cityId=" + pirateCityId);

        if (bodyId === "city" && onPirateCity) {
          // Right city, open fortress
          navigate("?view=pirateFortress&activeTab=tabBootyQuest&cityId=" + pirateCityId + "&position=17");
          // Watch for capture button to appear after AJAX
          const obs = new MutationObserver(() => {
            if (document.querySelector("#pirateCaptureBox .button.capture")) {
              obs.disconnect();
              tryPirate();
            }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => obs.disconnect(), 10000);
        } else {
          // Wrong city or not on city view — navigate directly via AJAX
          navigate("?view=city&cityId=" + pirateCityId);
        }
      }
    } catch (e) {
      console.error(P, ts(), "Error:", e);
    }
  }

  function scheduleNext() {
    if (checkTimer) clearTimeout(checkTimer);
    const jitter = (3500 + Math.random() * 3000) * tm(); // 3.5-6.5s (1.75-3.25s aggressive)
    checkTimer = setTimeout(() => {
      tryPirate();
      if (enabled) scheduleNext();
    }, jitter);
  }

  function start() {
    if (checkTimer) return; // guard: don't reset state if already running
    scheduleNext();
    reportStats();
    lastTickTs = 0; prevPhase = null;
    logEvent("on");
    console.log(P, ts(), "Started — city=" + pirateCityId + ", sleep=" + cfg.sleepStart + ":00-" + cfg.sleepEnd + ":00, mu=" + cfg.baseMu + ", σ=" + cfg.baseSigma);
  }

  function resetSession() {
    sessionStartTime = Date.now();
    streakCount = 0;
    distractionRaids = 0;
    distractionMu = 0;
    lastMissionWasT2 = false;
    forceBreakNext = false;
    postBreakRaids = 0;
    tempo = 0;
    raidsSinceLastConvert = 0;
    sessionRaids = 0;
    sessionT1 = 0;
    sessionT2 = 0;
    sessionBreakCount = 0;
    sessionBreakMs = 0;
    sessionConverts = 0;
    chrome.storage.local.remove("pirateState");
  }

  function stop() {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    convertTimers.forEach((id) => clearTimeout(id));
    convertTimers = [];
    handBack();
    reportStats();
    flushLog();
    logEvent("off");
    flushEvents();
    console.log(P, ts(), "Stopped |", sessionStats());
  }

  // --- Pirate toggle in game header bar ---
  function injectPirateToggle() {
    const toolbar = document.querySelector("#GF_toolbar ul");
    if (!toolbar || document.getElementById("ik-pirate-toggle")) return;

    const li = document.createElement("li");
    li.id = "ik-pirate-toggle";
    li.style.cursor = "pointer";

    const link = document.createElement("a");
    link.textContent = "\u2620 Pirate";
    link.title = "Toggle auto-pirate";
    Object.assign(link.style, {
      cursor: "pointer",
      userSelect: "none",
    });

    let active = enabled;
    function updateStyle() {
      link.style.color = active ? "#ff4444" : "";
      link.style.opacity = active ? "1" : "0.4";
      link.style.webkitTextStroke = active ? "0.2px" : "";
      link.textContent = "\u2620 Pirate";
    }
    updateStyle();

    link.addEventListener("click", (e) => {
      e.preventDefault();
      active = !active;
      chrome.storage.local.set({ pirateEnabled: active });
      updateStyle();
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.pirateEnabled) {
        active = !!changes.pirateEnabled.newValue;
        updateStyle();
      }
    });

    li.appendChild(link);
    li.dataset.ikOrder = "2";
    toolbar.appendChild(li);
    IkUtils.reorderToolbarItems(toolbar);
  }

  // --- Randomized defaults for new users ---
  const CFG_KEYS = {
    sleepStart:       { storage: "pirateSleepStart",       min: 0,    max: 3,    round: true },
    sleepEnd:         { storage: "pirateSleepEnd",         min: 5,    max: 9,    round: true },
    baseMu:           { storage: "pirateBaseMu",           min: 2.5,  max: 2.8,  round: false },
    baseSigma:        { storage: "pirateBaseSigma",        min: 0.5,  max: 0.75, round: false },
    breakMin:         { storage: "pirateBreakMin",         min: 2,    max: 4,    round: true },
    breakMax:         { storage: "pirateBreakMax",          min: 4,    max: 7,    round: true },
    streakLo:         { storage: "pirateStreakLo",          min: 14,   max: 22,   round: true },
    streakHi:         { storage: "pirateStreakHi",          min: 26,   max: 30,   round: true },
    distractChance:   { storage: "pirateDistractChance",   min: 0.04, max: 0.09, round: false },
    t2Base:           { storage: "pirateT2Base",            min: 0.06, max: 0.10, round: false },
    t2Ramp:           { storage: "pirateT2Ramp",            min: 0.40, max: 0.58, round: false },
    t2Distract:       { storage: "pirateT2Distract",        min: 0.30, max: 0.45, round: false },
    forceBreakChance: { storage: "pirateForceBreakChance", min: 0.15, max: 0.30, round: false },
    backToBackChance: { storage: "pirateBackToBack",        min: 0.08, max: 0.20, round: false },
  };

  function randomInRange(min, max, round) {
    const v = min + Math.random() * (max - min);
    return round ? Math.round(v) : Math.round(v * 100) / 100;
  }

  // --- Storage ---
  const worldName = IkUtils.getUrlWorldName() || "unknown";
  const KEY_PIRATE_CITY = "pirateCityId_" + worldName;
  let scanActive = false;

  // Bump to force a one-time re-roll of the throughput-related timing params into
  // the current profile's ranges (sleep + T2 params are left untouched).
  const TUNE_VERSION = 4;
  const TUNE_KEYS = ["baseMu", "baseSigma", "breakMin", "breakMax", "streakLo", "streakHi",
    "distractChance", "t2Base", "t2Ramp", "t2Distract"];

  const allStorageKeys = ["pirateEnabled", "pirateConvertEnabled", "pirateAggressive",
    KEY_PIRATE_CITY, "pirateCityId",
    "pirateIdleTimeout", "pirateState", "scanInProgress", "pirateTuneVersion",
    ...Object.values(CFG_KEYS).map((k) => k.storage)];

  chrome.storage.local.get(allStorageKeys, (data) => {
    enabled = !!data.pirateEnabled;
    convertEnabled = !!data.pirateConvertEnabled;
    aggressive = !!data.pirateAggressive;
    // Fall back to legacy global key if world-scoped key is absent
    pirateCityId = data[KEY_PIRATE_CITY] ?? data.pirateCityId ?? null;
    if (data.pirateIdleTimeout) idleTimeout = data.pirateIdleTimeout;

    // One-time migration: re-roll throughput params into the new profile's ranges,
    // overriding the user's previous stored values (they can re-tune in the panel).
    const migrate = (data.pirateTuneVersion || 0) < TUNE_VERSION;

    // Initialize missing timing params with random values (preserves existing)
    const toSave = {};
    for (const [key, def] of Object.entries(CFG_KEYS)) {
      if (migrate && TUNE_KEYS.includes(key)) {
        cfg[key] = randomInRange(def.min, def.max, def.round);
        toSave[def.storage] = cfg[key];
      } else if (data[def.storage] != null) {
        cfg[key] = data[def.storage];
      } else {
        cfg[key] = randomInRange(def.min, def.max, def.round);
        toSave[def.storage] = cfg[key];
      }
    }
    if (migrate) toSave.pirateTuneVersion = TUNE_VERSION;
    if (Object.keys(toSave).length > 0) chrome.storage.local.set(toSave);

    // Only the DOM map-jumping phase blocks pirates — background fetches don't
    // need exclusive control of the page.
    scanActive = !!data.scanInProgress;
    restoreState(data.pirateState);
    if (enabled && pirateCityId) start();
    injectPirateToggle();

    // Complete a pending manual fortress open requested before the city-switch reload
    chrome.storage.local.get("pendingPirateFortress", (d) => {
      const pending = d.pendingPirateFortress;
      if (!pending) return;
      chrome.storage.local.remove("pendingPirateFortress");
      // Ignore stale intents (>15s old) so abandoned tabs don't surprise the user later
      if (Date.now() - (pending.ts || 0) > 15000) return;
      if (location.search.includes("cityId=" + pending.cityId)) {
        // Small delay so the page's own AJAX handler is ready
        setTimeout(() => navigate("?view=pirateFortress&activeTab=tabBootyQuest&cityId=" + pending.cityId + "&position=17"), 400);
      }
    });
  });

  // --- Messages from popup ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "popup-heartbeat") {
      lastPopupHeartbeat = Date.now();
    }
    if (msg.type === "pirate-toggle") {
      // Only write to storage — storage.onChanged is the single source of truth for start/stop
      chrome.storage.local.set({ pirateEnabled: msg.enabled });
    }
    if (msg.type === "pirate-convert-toggle") {
      convertEnabled = msg.enabled;
    }
    if (msg.type === "pirate-aggressive-toggle") {
      aggressive = msg.enabled;
    }
    if (msg.type === "pirate-open-fortress") {
      const cityId = msg.cityId || pirateCityId;
      if (!cityId) return;
      if (location.search.includes("cityId=" + cityId)) {
        navigate("?view=pirateFortress&activeTab=tabBootyQuest&cityId=" + cityId + "&position=17");
      } else {
        // City switch triggers a full page reload — persist intent so the
        // fresh content script can complete the fortress open after init.
        chrome.storage.local.set({ pendingPirateFortress: { cityId, ts: Date.now() } }, () => {
          navigate("?view=city&cityId=" + cityId);
        });
      }
    }
    if (msg.type === "pirate-config") {
      if (msg.cityId !== undefined) pirateCityId = msg.cityId;
      const save = {};
      if (msg.cityId !== undefined) save[KEY_PIRATE_CITY] = msg.cityId;
      // Update any cfg params included in the message
      for (const [key, def] of Object.entries(CFG_KEYS)) {
        if (msg[key] !== undefined) {
          cfg[key] = msg[key];
          save[def.storage] = msg[key];
        }
      }
      if (msg.sleepStart !== undefined || msg.sleepEnd !== undefined) {
        sleepJitter = (Math.random() - 0.5) * 20;
      }
      chrome.storage.local.set(save);
    }
  });

  // --- Watch storage changes (for minimap pirate toggle + scan pausing) ---
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pirateEnabled) {
      enabled = !!changes.pirateEnabled.newValue;
      if (enabled && pirateCityId) start(); else stop();
    }
    if (changes.pirateConvertEnabled) {
      convertEnabled = !!changes.pirateConvertEnabled.newValue;
    }
    if (changes.pirateAggressive) {
      aggressive = !!changes.pirateAggressive.newValue;
    }
    if (changes.scanInProgress) {
      scanActive = !!changes.scanInProgress.newValue;
    }
  });

  // --- City list request from popup ---
  const KEY_PIRATE_CITIES = "pirateCities_" + worldName;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "get-cities") {
      IkUtils.getCities().then((cities) => {
        // Persist per-world so popup can show them without an active game tab
        if (cities.length > 0) chrome.storage.local.set({ [KEY_PIRATE_CITIES]: cities });
        sendResponse({ cities, worldName });
      });
      return true;
    }
  });
})();

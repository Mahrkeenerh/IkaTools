// Auto-launch pirate missions when user is idle
(() => {
  // Only run on game pages (s1-en.ikariam...), not forum/lobby
  if (!/^s\d+/.test(location.hostname)) return;
  const P = "[AP]";
  const NAVIGATE_COOLDOWN = 15000;
  const MISSION_DURATIONS = [150, 450]; // tier 1 = 2m30s, tier 2 = 7m30s

  let enabled = false;
  let convertEnabled = false;
  let pirateCityId = null;
  let idleTimeout = 5000;

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
    baseMu: 2.9,          // log-normal center (higher = slower)
    baseSigma: 1.0,       // log-normal spread
    breakMin: 4,           // streak break min duration (minutes)
    breakMax: 10,          // streak break max duration (minutes)
    streakLo: 10,          // min raids before break hazard starts
    streakHi: 20,          // raids where break becomes near-certain
    distractChance: 0.10,  // chance to enter distracted state per raid
    t2Base: 0.10,          // base T2 chance (early in streak)
    t2Ramp: 0.60,          // T2 sigmoid max addition (peaks near break)
    t2Distract: 0.45,      // T2 chance during distraction state
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
  let windowFocused = document.hasFocus();
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

  // --- Idle detection ---
  function onActivity() {
    if (!windowFocused || document.hidden) return;
    lastActivity = Date.now();
    if (inControl) {
      handBack();
    }
  }

  ["mousemove", "keydown", "click", "scroll", "mousedown"].forEach((e) =>
    document.addEventListener(e, onActivity, { passive: true, capture: true })
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onActivity();
  });
  window.addEventListener("blur", () => { windowFocused = false; });
  window.addEventListener("focus", () => {
    windowFocused = true;
    onActivity();
  });

  function handBack() {
    inControl = false;
    // Preserve nextActionTime so remaining delay survives user interruptions
    lastNavigateTime = 0;
    convertTimers.forEach((id) => clearTimeout(id));
    convertTimers = [];
  }

  function isIdle() {
    if (Date.now() - lastPopupHeartbeat < 10000) return false;
    return (document.hidden || !windowFocused) && Date.now() - lastActivity > idleTimeout;
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
      const d = Math.max(breakD, (dynBreakMin - 2) * 60) * 1000;

      sessionBreakCount++;
      sessionBreakMs += d;
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
    const d = Math.max(delaySec, 3 + Math.random() * 2) * 1000;
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
    const delay = (2 + Math.random() * 4) * 1000;
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
    const fillDelay = (1 + Math.random() * 2) * 1000;
    scheduleConvert(() => {
      if (!inControl || !isIdle()) return;
      if (!document.getElementById("CPToCrewForm")) return;
      // Click slider max via bridge (page context handles slider JS)
      IkUtils.ensureBridge();
      window.dispatchEvent(new CustomEvent("ik-convert-crew"));

      // Wait 0.5-1.5s for game JS to update slider + enable submit button
      const submitDelay = (500 + Math.random() * 1000);
      scheduleConvert(() => {
        if (!inControl || !isIdle()) return;
        const submitBtn = document.getElementById("CPToCrewSubmit");
        if (!submitBtn || submitBtn.classList.contains("button_disabled")) return;
        submitBtn.click();
        raidsSinceLastConvert = 0;
        sessionConverts++;
        saveState();
      }, submitDelay);
    }, fillDelay);
  }

  // --- Main loop ---
  function tryPirate() {
    try {
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
        return;
      }

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
        raidsSinceLastConvert++;
        saveState();
        // Safety net: clear raidInProgress after 30s in case normal flow fails
        setTimeout(() => { raidInProgress = false; }, 45000);
        // Delay convert start so raid AJAX can complete before we navigate away
        scheduleConvert(() => {
          raidInProgress = false;
          tryConvert();
        }, 3000 + Math.random() * 1000);
        return;
      }

      reportStats();
      if (Date.now() - lastNavigateTime > NAVIGATE_COOLDOWN) {
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
    const jitter = 3500 + Math.random() * 3000; // 3.5-6.5s
    checkTimer = setTimeout(() => {
      tryPirate();
      if (enabled) scheduleNext();
    }, jitter);
  }

  function start() {
    if (checkTimer) return; // guard: don't reset state if already running
    scheduleNext();
    reportStats();
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
    baseMu:           { storage: "pirateBaseMu",           min: 2.7,  max: 3.3,  round: false },
    baseSigma:        { storage: "pirateBaseSigma",        min: 0.8,  max: 1.2,  round: false },
    breakMin:         { storage: "pirateBreakMin",         min: 3,    max: 6,    round: true },
    breakMax:         { storage: "pirateBreakMax",          min: 8,    max: 14,   round: true },
    streakLo:         { storage: "pirateStreakLo",          min: 8,    max: 12,   round: true },
    streakHi:         { storage: "pirateStreakHi",          min: 16,   max: 22,   round: true },
    distractChance:   { storage: "pirateDistractChance",   min: 0.08, max: 0.15, round: false },
    t2Base:           { storage: "pirateT2Base",            min: 0.06, max: 0.14, round: false },
    t2Ramp:           { storage: "pirateT2Ramp",            min: 0.40, max: 0.70, round: false },
    t2Distract:       { storage: "pirateT2Distract",        min: 0.30, max: 0.50, round: false },
    forceBreakChance: { storage: "pirateForceBreakChance", min: 0.15, max: 0.30, round: false },
    backToBackChance: { storage: "pirateBackToBack",        min: 0.08, max: 0.20, round: false },
  };

  function randomInRange(min, max, round) {
    const v = min + Math.random() * (max - min);
    return round ? Math.round(v) : Math.round(v * 100) / 100;
  }

  // --- Storage ---
  const worldName = IkUtils.getWorldName() || "unknown";
  const KEY_PIRATE_CITY = "pirateCityId_" + worldName;
  let scanActive = false;

  const allStorageKeys = ["pirateEnabled", "pirateConvertEnabled", KEY_PIRATE_CITY, "pirateCityId",
    "pirateIdleTimeout", "pirateState", "scanInProgress",
    ...Object.values(CFG_KEYS).map((k) => k.storage)];

  chrome.storage.local.get(allStorageKeys, (data) => {
    enabled = !!data.pirateEnabled;
    convertEnabled = !!data.pirateConvertEnabled;
    // Fall back to legacy global key if world-scoped key is absent
    pirateCityId = data[KEY_PIRATE_CITY] ?? data.pirateCityId ?? null;
    if (data.pirateIdleTimeout) idleTimeout = data.pirateIdleTimeout;

    // Initialize missing timing params with random values (preserves existing)
    const toSave = {};
    for (const [key, def] of Object.entries(CFG_KEYS)) {
      if (data[def.storage] != null) {
        cfg[key] = data[def.storage];
      } else {
        cfg[key] = randomInRange(def.min, def.max, def.round);
        toSave[def.storage] = cfg[key];
      }
    }
    if (Object.keys(toSave).length > 0) chrome.storage.local.set(toSave);

    // Only the DOM map-jumping phase blocks pirates — background fetches don't
    // need exclusive control of the page.
    scanActive = !!data.scanInProgress;
    restoreState(data.pirateState);
    if (enabled && pirateCityId) start();
    injectPirateToggle();
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

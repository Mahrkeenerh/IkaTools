// Auto-launch pirate missions when user is idle
(() => {
  const P = "[AutoPirate]";
  const NAVIGATE_COOLDOWN = 10000;
  const MISSION_DURATIONS = [150, 450]; // tier 1 = 2m30s, tier 2 = 7m30s

  let enabled = false;
  let convertEnabled = false;
  let pirateCityId = null;
  let idleTimeout = 5000;

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

  function fmt(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m " + (s % 60) + "s";
  }

  // --- Idle detection ---
  function onActivity() {
    if (!windowFocused || document.hidden) return;
    lastActivity = Date.now();
    if (inControl) {
      console.log(P, "User active, handing back");
      handBack();
    }
  }

  ["mousemove", "keydown", "click", "scroll", "mousedown"].forEach((e) =>
    document.addEventListener(e, onActivity, { passive: true, capture: true })
  );
  document.addEventListener("visibilitychange", () => {
    console.log(P, "Visibility:", document.hidden ? "hidden" : "visible");
    if (!document.hidden) onActivity();
  });
  window.addEventListener("blur", () => {
    windowFocused = false;
    console.log(P, "Window blur");
  });
  window.addEventListener("focus", () => {
    windowFocused = true;
    console.log(P, "Window focus");
    onActivity();
  });

  function handBack() {
    inControl = false;
    // Preserve nextActionTime so remaining delay survives user interruptions
    lastNavigateTime = 0;
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

      console.log(P, "Break after", streakCount, "raids (" + (wasForced ? "T2-forced" : "hazard") + "):", fmt(d));
      streakCount = 0;
      raidsSinceLastConvert = 0;

      // Post-break re-engagement: probability-based, 1-3 faster raids
      if (Math.random() < 0.70) {
        postBreakRaids = 1 + Math.floor(Math.random() * 3);
        console.log(P, "Post-break re-engagement for", postBreakRaids, "raids");
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
        console.log(P, "Distracted: mu+" + distractionMu.toFixed(1) + " for", distractionRaids, "raids");
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
    console.log(P, "Delay:", fmt(d), "(mu=" + mu.toFixed(1) + ", tempo=" + tempo.toFixed(2) + ", streak=" + streakCount + ", haz=" + getBreakHazard().toFixed(2) + ")");
    return d;
  }

  function navigate(url) {
    IkUtils.ensureBridge();
    window.dispatchEvent(new CustomEvent("ik-ajax-call", { detail: { url } }));
  }

  // --- Auto-convert: pirate points → crew strength ---
  function getConvertChance() {
    // High after break (90%), decays exponentially over raids
    return 0.9 * Math.exp(-0.4 * raidsSinceLastConvert);
  }

  function tryConvert() {
    if (!convertEnabled) return;
    if (!inControl || !isIdle() || !pirateCityId) {
      console.log(P, "Convert: skipped (inControl=" + inControl + ", idle=" + isIdle() + ", city=" + pirateCityId + ")");
      return;
    }
    const chance = getConvertChance();
    const roll = Math.random();
    console.log(P, "Convert roll: " + roll.toFixed(3) + " vs " + chance.toFixed(3) + " (raidsSince=" + raidsSinceLastConvert + ")");
    if (roll >= chance) {
      console.log(P, "Convert: skipped (roll failed)");
      return;
    }

    // Schedule convert with 2-6s delay (player switches tab after launching raid)
    const delay = (2 + Math.random() * 4) * 1000;
    console.log(P, "Will convert in", fmt(delay));
    setTimeout(() => {
      if (!inControl || !isIdle() || !convertEnabled) return;
      console.log(P, "Navigating to Crew tab for convert");
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
    setTimeout(() => obs.disconnect(), 8000);
  }

  function checkConvertDom() {
    if (document.getElementById("ongoingConversion")) {
      console.log(P, "Convert: ongoing conversion detected, skipping");
      return true;
    }
    const form = document.getElementById("CPToCrewForm");
    if (form) {
      console.log(P, "Convert: form found, will submit after delay");
      submitConvert();
      return true;
    }
    console.log(P, "Convert: DOM not ready yet, waiting...");
    return false;
  }

  function submitConvert() {
    // Wait 1-3s, click slider max (via bridge), then wait and click submit
    const fillDelay = (1 + Math.random() * 2) * 1000;
    console.log(P, "Convert: clicking max in", fmt(fillDelay));
    setTimeout(() => {
      if (!inControl || !isIdle()) {
        console.log(P, "Convert: aborted (lost control or not idle)");
        return;
      }
      if (!document.getElementById("CPToCrewForm")) {
        console.log(P, "Convert: aborted (form disappeared)");
        return;
      }
      // Click slider max via bridge (page context handles slider JS)
      IkUtils.ensureBridge();
      window.dispatchEvent(new CustomEvent("ik-convert-crew"));
      console.log(P, "Convert: slider max clicked, waiting for submit to enable");

      // Wait 0.5-1.5s for game JS to update slider + enable submit button
      const submitDelay = (500 + Math.random() * 1000);
      setTimeout(() => {
        if (!inControl || !isIdle()) {
          console.log(P, "Convert: aborted before submit");
          return;
        }
        const submitBtn = document.getElementById("CPToCrewSubmit");
        if (!submitBtn) {
          console.log(P, "Convert: submit button not found");
          return;
        }
        if (submitBtn.classList.contains("button_disabled")) {
          console.log(P, "Convert: submit still disabled, aborting");
          return;
        }
        submitBtn.click();
        raidsSinceLastConvert = 0;
        console.log(P, "Convert: SUBMITTED via button click");
      }, submitDelay);
    }, fillDelay);
  }

  // --- Main loop ---
  function tryPirate() {
    try {
      if (!enabled || !pirateCityId) return;

      if (!isIdle()) {
        const idleIn = idleTimeout - (Date.now() - lastActivity);
        console.log(P, "Not idle — hidden=" + document.hidden + ", focused=" + windowFocused + ", idleIn=" + fmt(Math.max(0, idleIn)));
        return;
      }

      if (!isInActiveHours()) {
        console.log(P, "Outside active hours");
        return;
      }

      if (Date.now() < nextActionTime) return;

      if (!inControl) {
        const idleDuration = Date.now() - lastActivity;
        console.log(P, "Taking control — idle", fmt(idleDuration));
        inControl = true;

        // Long interruption: decay transient states
        if (idleDuration > 30 * 60 * 1000) {
          distractionRaids = 0;
          distractionMu = 0;
          forceBreakNext = false;
          postBreakRaids = 0;
          tempo = 0;
          console.log(P, "Long interruption — cleared transient states");
        }
      }

      // Daily sleep jitter re-roll
      const today = new Date().toDateString();
      if (today !== sleepJitterDate) {
        sleepJitter = (Math.random() - 0.5) * 20;
        sleepJitterDate = today;
      }

      if (document.querySelector("#cinema_c")) {
        console.log(P, "Theater open, skipping");
        return;
      }

      if (document.querySelector("img.captchaImage")) {
        console.log(P, "Captcha present, waiting for solver");
        return;
      }


      // Mission still running — crew is out, just wait
      if (document.querySelector("#pirateCaptureBox .red_box")) {
        console.log(P, "Mission still running, waiting");
        return;
      }

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
        console.log(P, "Launching tier", tier + 1, "capture (t2p=" + t2Prob.toFixed(2) + ", brk=" + getBreakHazard().toFixed(2) + ")");
        navigate(href);
        const delay = randomDelay();
        const total = duration * 1000 + delay;
        nextActionTime = Date.now() + total;
        lastNavigateTime = 0;
        console.log(P, "Tier " + (tier + 1) + " next in", fmt(total), "(mission", fmt(duration * 1000), "+ delay", fmt(delay) + ")" + (forceBreakNext ? " [break queued]" : ""));
        raidsSinceLastConvert++;
        tryConvert();
        return;
      }

      if (Date.now() - lastNavigateTime > NAVIGATE_COOLDOWN) {
        lastNavigateTime = Date.now();
        const bodyId = document.body.id;
        const onPirateCity = bodyId === "city" && location.search.includes("cityId=" + pirateCityId);
        console.log(P, "State: body#" + bodyId + ", onPirateCity=" + onPirateCity);

        if (bodyId === "city" && onPirateCity) {
          // Right city, open fortress
          console.log(P, "Opening fortress (BootyQuest tab)");
          navigate("?view=pirateFortress&activeTab=tabBootyQuest&cityId=" + pirateCityId + "&position=17");
          // Watch for capture button to appear after AJAX
          const obs = new MutationObserver(() => {
            if (document.querySelector("#pirateCaptureBox .button.capture")) {
              obs.disconnect();
              tryPirate();
            }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => obs.disconnect(), 5000);
        } else if (bodyId === "city") {
          // Wrong city — switch via game's city change form
          console.log(P, "Switching to pirate city", pirateCityId);
          IkUtils.ensureBridge();
          window.dispatchEvent(new CustomEvent("ik-switch-city", { detail: { cityId: pirateCityId } }));
        } else {
          // Not on city view (island, world map, etc.) — navigate directly
          console.log(P, "Not on city view (body#" + bodyId + "), navigating to pirate city");
          navigate("?view=city&cityId=" + pirateCityId);
        }
      } else {
        console.log(P, "No capture btn, nav cooldown", fmt(NAVIGATE_COOLDOWN - (Date.now() - lastNavigateTime)));
      }
    } catch (e) {
      console.error(P, "Error:", e);
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
    if (!sessionStartTime || sessionStartTime === 0) sessionStartTime = Date.now();
    scheduleNext();
    console.log(P, "Started — city=" + pirateCityId + ", sleep=" + cfg.sleepStart + "-" + cfg.sleepEnd);
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
  }

  function stop() {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    handBack();
    console.log(P, "Stopped");
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

    li.appendChild(link);
    li.style.marginLeft = "20px";
    toolbar.appendChild(li);
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
  const allStorageKeys = ["pirateEnabled", "pirateConvertEnabled", "pirateCityId", "pirateIdleTimeout",
    ...Object.values(CFG_KEYS).map((k) => k.storage)];

  chrome.storage.local.get(allStorageKeys, (data) => {
    enabled = !!data.pirateEnabled;
    convertEnabled = !!data.pirateConvertEnabled;
    pirateCityId = data.pirateCityId || null;
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
    if (Object.keys(toSave).length > 0) {
      chrome.storage.local.set(toSave);
      console.log(P, "Initialized random timing params:", toSave);
    }

    resetSession();
    console.log(P, "Config loaded — enabled=" + enabled + ", city=" + pirateCityId + ", cfg=", JSON.stringify(cfg));
    if (enabled && pirateCityId) start();
    injectPirateToggle();
  });

  // --- Messages from popup ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "popup-heartbeat") {
      lastPopupHeartbeat = Date.now();
      console.log(P, "Popup heartbeat");
    }
    if (msg.type === "pirate-toggle") {
      enabled = msg.enabled;
      console.log(P, "Toggle:", enabled);
      if (enabled && pirateCityId) start(); else stop();
    }
    if (msg.type === "pirate-convert-toggle") {
      convertEnabled = msg.enabled;
      console.log(P, "Convert toggle:", convertEnabled);
    }
    if (msg.type === "pirate-config") {
      if (msg.cityId !== undefined) pirateCityId = msg.cityId;
      const save = {};
      if (msg.cityId !== undefined) save.pirateCityId = msg.cityId;
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
      console.log(P, "Config updated — city=" + pirateCityId + ", cfg=", JSON.stringify(cfg));
    }
  });

  // --- Watch storage changes (for minimap pirate toggle) ---
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pirateEnabled) {
      enabled = !!changes.pirateEnabled.newValue;
      console.log(P, "Storage toggle:", enabled);
      if (enabled && pirateCityId) start(); else stop();
    }
    if (changes.pirateConvertEnabled) {
      convertEnabled = !!changes.pirateConvertEnabled.newValue;
      console.log(P, "Convert storage toggle:", convertEnabled);
    }
  });

  // --- City list request from popup ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "get-cities") {
      const cities = [];
      const handler = (e) => {
        window.removeEventListener("ik-cities-data", handler);
        const data = e.detail || {};
        for (const key of Object.keys(data)) {
          if (key === "additionalInfo" || key === "selectedCity") continue;
          const c = data[key];
          if (c && c.id && c.name) {
            cities.push({ id: c.id, name: c.name, coords: c.coords || "" });
          }
        }
        sendResponse({ cities });
      };
      window.addEventListener("ik-cities-data", handler);
      window.dispatchEvent(new CustomEvent("ik-read-cities"));
      setTimeout(() => {
        window.removeEventListener("ik-cities-data", handler);
        if (cities.length === 0) sendResponse({ cities: [] });
      }, 2000);
      return true;
    }
  });
})();

// Auto-launch pirate missions when user is idle
(() => {
  const P = "[AutoPirate]";
  const NAVIGATE_COOLDOWN = 10000;
  const MISSION_DURATIONS = [150, 450]; // tier 1 = 2m30s, tier 2 = 7m30s

  let enabled = false;
  let pirateCityId = null;
  let idleTimeout = 5000;

  // --- Tunable timing parameters (randomized per-user, stored in chrome.storage) ---
  let cfg = {
    sleepStart: 1,      // hour when bot stops
    sleepEnd: 7,         // hour when bot can resume
    baseMu: 3.3,         // log-normal center (higher = slower)
    baseSigma: 1.0,      // log-normal spread
    breakMin: 5,          // streak break min duration (minutes)
    breakMax: 12,         // streak break max duration (minutes)
    streakLo: 8,          // min raids before streak break
    streakHi: 15,         // max raids before streak break
    distractChance: 0.12, // chance to enter distracted state per raid
    t2Chance: 0.05,       // chance to pick tier 2 mission
  };
  let sleepJitter = (Math.random() - 0.5) * 20; // +/- 10 min daily variance

  let lastActivity = Date.now();
  let inControl = false;
  let nextActionTime = 0;
  let lastNavigateTime = 0;
  let checkTimer = null;
  let windowFocused = document.hasFocus();
  let lastPopupHeartbeat = 0;

  // --- Humanized timing state ---
  let streakCount = 0;
  let streakBreakAt = 8 + Math.floor(Math.random() * 8);
  let distractionMu = 0; // added to base mu during "distracted" state
  let distractionRaids = 0; // how many raids left in distracted state
  let sessionStartTime = Date.now();

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

  // --- Humanized delay (log-normal + distraction state + streak breaking) ---
  function lognormal(mu, sigma) {
    const u = 1 - Math.random();
    const v = 1 - Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.exp(mu + sigma * z);
  }

  function randomDelay() {
    // Streak breaking: force a long break after consecutive raids
    streakCount++;
    if (streakCount >= streakBreakAt) {
      streakCount = 0;
      streakBreakAt = cfg.streakLo + Math.floor(Math.random() * (cfg.streakHi - cfg.streakLo + 1));
      // Log-normal break duration (not uniform) for natural feel
      const breakMu = Math.log((cfg.breakMin + cfg.breakMax) / 2 * 60);
      const breakD = Math.min(lognormal(breakMu, 0.4), cfg.breakMax * 60);
      const d = Math.max(breakD, cfg.breakMin * 60) * 1000;
      console.log(P, "Streak break after", streakBreakAt, "raids:", fmt(d));
      return d;
    }

    // Distraction state: occasionally enter "slow mode" for a few raids
    if (distractionRaids <= 0) {
      distractionMu = 0;
      if (Math.random() < cfg.distractChance) {
        distractionMu = 0.5 + Math.random() * 1.0;
        distractionRaids = 2 + Math.floor(Math.random() * 4);
        console.log(P, "Entering distracted state: mu+" + distractionMu.toFixed(1) + " for", distractionRaids, "raids");
      }
    }
    if (distractionRaids > 0) distractionRaids--;

    // Session fatigue: +0.1 mu per hour of session
    const sessionHours = (Date.now() - sessionStartTime) / 3600000;
    const fatigueMu = Math.min(sessionHours * 0.1, 0.5);

    const mu = cfg.baseMu + distractionMu + fatigueMu;
    const sigma = cfg.baseSigma;
    // Soft cap: fuzzy max between 20-30 min instead of hard 25 min cliff
    const softCap = (20 + Math.random() * 10) * 60;
    const delaySec = Math.min(lognormal(mu, sigma), softCap);
    const d = Math.max(delaySec, 3 + Math.random() * 2) * 1000; // soft floor 3-5s
    console.log(P, "Delay:", fmt(d), "(mu=" + mu.toFixed(1) + ", streak=" + streakCount + "/" + streakBreakAt + ")");
    return d;
  }

  function navigate(url) {
    IkUtils.ensureBridge();
    window.dispatchEvent(new CustomEvent("ik-ajax-call", { detail: { url } }));
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

      if (Date.now() < nextActionTime) {
        console.log(P, "Waiting", fmt(nextActionTime - Date.now()));
        return;
      }

      if (!inControl) {
        console.log(P, "Taking control — idle", fmt(Date.now() - lastActivity));
        inControl = true;
      }

      if (document.querySelector("img.captchaImage")) {
        console.log(P, "Captcha present, waiting for solver");
        return;
      }

      const captureBtns = document.querySelectorAll("#pirateCaptureBox a.button.capture");
      if (captureBtns.length > 0) {
        // Pick tier 2 occasionally if available, otherwise tier 1
        let tier = 0;
        if (captureBtns.length > 1 && Math.random() < cfg.t2Chance) tier = 1;
        const captureBtn = captureBtns[tier];
        const href = captureBtn.getAttribute("href");
        const duration = MISSION_DURATIONS[tier] || MISSION_DURATIONS[0];
        console.log(P, "Launching tier", tier + 1, "capture via AJAX:", href);
        navigate(href);
        const delay = randomDelay();
        const total = duration * 1000 + delay;
        nextActionTime = Date.now() + total;
        lastNavigateTime = 0;
        console.log(P, "Mission launched (tier " + (tier + 1) + "), next in", fmt(total), "(mission", fmt(duration * 1000), "+ delay", fmt(delay) + ")");
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
        } else {
          // Wrong city or wrong view — navigate to pirate city
          console.log(P, "Navigating to pirate city", pirateCityId);
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
    sessionStartTime = Date.now();
    streakCount = 0;
    distractionRaids = 0;
    distractionMu = 0;
    scheduleNext();
    console.log(P, "Started — city=" + pirateCityId + ", sleep=" + cfg.sleepStart + "-" + cfg.sleepEnd);
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
    sleepStart:     { storage: "pirateSleepStart",     min: 0,    max: 3,    round: true },
    sleepEnd:       { storage: "pirateSleepEnd",       min: 5,    max: 9,    round: true },
    baseMu:         { storage: "pirateBaseMu",         min: 3.1,  max: 3.5,  round: false },
    baseSigma:      { storage: "pirateBaseSigma",      min: 0.8,  max: 1.2,  round: false },
    breakMin:       { storage: "pirateBreakMin",       min: 4,    max: 7,    round: true },
    breakMax:       { storage: "pirateBreakMax",        min: 10,   max: 16,   round: true },
    streakLo:       { storage: "pirateStreakLo",        min: 6,    max: 10,   round: true },
    streakHi:       { storage: "pirateStreakHi",        min: 12,   max: 18,   round: true },
    distractChance: { storage: "pirateDistractChance", min: 0.08, max: 0.15, round: false },
    t2Chance:       { storage: "pirateT2Chance",        min: 0.03, max: 0.08, round: false },
  };

  function randomInRange(min, max, round) {
    const v = min + Math.random() * (max - min);
    return round ? Math.round(v) : Math.round(v * 100) / 100;
  }

  // --- Storage ---
  const allStorageKeys = ["pirateEnabled", "pirateCityId", "pirateIdleTimeout",
    ...Object.values(CFG_KEYS).map((k) => k.storage)];

  chrome.storage.local.get(allStorageKeys, (data) => {
    enabled = !!data.pirateEnabled;
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

    streakBreakAt = cfg.streakLo + Math.floor(Math.random() * (cfg.streakHi - cfg.streakLo + 1));
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

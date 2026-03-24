// Auto-launch pirate missions when user is idle
(() => {
  const P = "[AutoPirate]";
  let idleTimeout = 5000; // ms before taking control (configurable via storage)
  const CHECK_INTERVAL = 5000;
  const NAVIGATE_COOLDOWN = 10000;
  const MISSION_DURATION = 150; // tier 1 = 2m 30s

  let enabled = false;
  let pirateCityId = null;
  let activeStart = null;
  let activeEnd = null;
  let activeJitter = (Math.random() - 0.5) * 20;

  let lastActivity = Date.now();
  let inControl = false;
  let nextActionTime = 0;
  let lastNavigateTime = 0;
  let checkTimer = null;
  let windowFocused = document.hasFocus();
  let lastPopupHeartbeat = 0;

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
    nextActionTime = 0;
    lastNavigateTime = 0;
  }

  function isIdle() {
    if (Date.now() - lastPopupHeartbeat < 10000) return false;
    return (document.hidden || !windowFocused) && Date.now() - lastActivity > idleTimeout;
  }

  function isInActiveHours() {
    if (activeStart === null || activeEnd === null) return true;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const startMins = activeStart * 60 + activeJitter;
    const endMins = activeEnd * 60 + activeJitter;
    if (startMins < endMins) return mins >= startMins && mins < endMins;
    return mins >= startMins || mins < endMins;
  }

  function randomDelay() {
    if (Math.random() < 0.05) {
      const d = (9 * 60 + Math.random() * 2 * 60) * 1000;
      console.log(P, "Long wait rolled:", fmt(d));
      return d;
    }
    return (5 + Math.random() * 115) * 1000;
  }

  function navigate(url) {
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

      const captureBtn = document.querySelector("#pirateCaptureBox a.button.capture");
      if (captureBtn) {
        const href = captureBtn.getAttribute("href");
        console.log(P, "Launching capture via AJAX:", href);
        // Use ajaxHandlerCall via bridge instead of clicking (plain <a> has no onclick)
        navigate(href);
        const delay = randomDelay();
        const total = MISSION_DURATION * 1000 + delay;
        nextActionTime = Date.now() + total;
        lastNavigateTime = 0;
        console.log(P, "Mission launched, next in", fmt(total), "(mission", fmt(MISSION_DURATION * 1000), "+ delay", fmt(delay) + ")");
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

  function start() {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(tryPirate, CHECK_INTERVAL);
    console.log(P, "Started — city=" + pirateCityId + ", hours=" + activeStart + "-" + activeEnd);
  }

  function stop() {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    handBack();
    console.log(P, "Stopped");
  }

  // --- Storage ---
  chrome.storage.local.get(
    ["pirateEnabled", "pirateCityId", "pirateActiveStart", "pirateActiveEnd", "pirateIdleTimeout"],
    (data) => {
      enabled = !!data.pirateEnabled;
      pirateCityId = data.pirateCityId || null;
      activeStart = data.pirateActiveStart ?? null;
      activeEnd = data.pirateActiveEnd ?? null;
      if (data.pirateIdleTimeout) idleTimeout = data.pirateIdleTimeout;
      console.log(P, "Config loaded — enabled=" + enabled + ", city=" + pirateCityId + ", hours=" + activeStart + "-" + activeEnd + ", idle=" + fmt(idleTimeout));
      if (enabled && pirateCityId) start();
    }
  );

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
      if (msg.activeStart !== undefined) activeStart = msg.activeStart;
      if (msg.activeEnd !== undefined) activeEnd = msg.activeEnd;
      chrome.storage.local.set({
        pirateCityId: pirateCityId,
        pirateActiveStart: activeStart,
        pirateActiveEnd: activeEnd,
      });
      activeJitter = (Math.random() - 0.5) * 20;
      console.log(P, "Config updated — city=" + pirateCityId + ", hours=" + activeStart + "-" + activeEnd);
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

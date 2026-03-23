// Auto-launch pirate missions when user is idle
(() => {
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

  // --- Idle detection ---
  function onActivity() {
    if (!windowFocused || document.hidden) return;
    lastActivity = Date.now();
    if (inControl) handBack();
  }

  ["mousemove", "keydown", "click", "scroll", "mousedown"].forEach((e) =>
    document.addEventListener(e, onActivity, { passive: true, capture: true })
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onActivity();
  });
  window.addEventListener("blur", () => { windowFocused = false; });
  window.addEventListener("focus", () => { windowFocused = true; onActivity(); });

  function handBack() {
    inControl = false;
    nextActionTime = 0;
    lastNavigateTime = 0;
  }

  function isIdle() {
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
    if (Math.random() < 0.05) return (9 * 60 + Math.random() * 2 * 60) * 1000;
    return (5 + Math.random() * 115) * 1000;
  }

  function navigate(url) {
    window.dispatchEvent(new CustomEvent("ik-ajax-call", { detail: { url } }));
  }

  // --- Main loop ---
  function tryPirate() {
    try {
      if (!enabled || !pirateCityId) return;
      if (!isIdle()) return;
      if (!isInActiveHours()) return;
      if (Date.now() < nextActionTime) return;

      inControl = true;

      if (document.querySelector("img.captchaImage")) return;

      const captureBtn = document.querySelector("#pirateCaptureBox .button.capture");
      if (captureBtn) {
        captureBtn.click();
        const delay = randomDelay();
        nextActionTime = Date.now() + MISSION_DURATION * 1000 + delay;
        lastNavigateTime = 0;
        return;
      }

      if (Date.now() - lastNavigateTime > NAVIGATE_COOLDOWN) {
        lastNavigateTime = Date.now();
        navigate("?view=pirateFortress&cityId=" + pirateCityId + "&position=17");
      }
    } catch (e) {
      // Never let an error kill the interval
    }
  }

  function start() {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(tryPirate, CHECK_INTERVAL);
  }

  function stop() {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    handBack();
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
      if (enabled && pirateCityId) start();
    }
  );

  // --- Messages from popup ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "pirate-toggle") {
      enabled = msg.enabled;
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

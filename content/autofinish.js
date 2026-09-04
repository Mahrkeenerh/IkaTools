// Auto-finish buildings when remaining time is under 5 min (free speedup)
(() => {
  const THRESHOLD = 300;
  const CHECK_INTERVAL = 1000;
  const FAST_INTERVAL = 100;
  const BUTTON_COOLDOWN = 500;
  const CONFIRM_COOLDOWN = 500;
  const FAST_POLL_DURATION = 5000;
  // After a successful free finish the DOM still shows the old countdown until
  // the game re-renders — refractory period so we don't act on stale state.
  const POST_FINISH_COOLDOWN = 500;

  let enabled = true;
  let checkTimer = null;
  let fastTimer = null;
  let fastStopTimer = null;
  let lastButtonClick = 0;
  let lastConfirmClick = 0;
  let lastFinish = 0;

  function stopFastPoll() {
    if (fastTimer) {
      clearInterval(fastTimer);
      fastTimer = null;
    }
    if (fastStopTimer) {
      clearTimeout(fastStopTimer);
      fastStopTimer = null;
    }
  }

  function parseTime(text) {
    let total = 0;
    const d = text.match(/(\d+)\s*d/i);
    const h = text.match(/(\d+)\s*h/i);
    const m = text.match(/(\d+)\s*m/i);
    const s = text.match(/(\d+)\s*s/i);
    if (d) total += parseInt(d[1], 10) * 86400;
    if (h) total += parseInt(h[1], 10) * 3600;
    if (m) total += parseInt(m[1], 10) * 60;
    if (s) total += parseInt(s[1], 10);
    return total;
  }

  function startFastPoll() {
    stopFastPoll();
    fastTimer = setInterval(tryAutoFinish, FAST_INTERVAL);
    fastStopTimer = setTimeout(() => {
      if (fastTimer) {
        clearInterval(fastTimer);
        fastTimer = null;
      }
      fastStopTimer = null;
    }, FAST_POLL_DURATION);
  }

  function tryAutoFinish() {
    try {
      if (!enabled) return;

      // If confirmation popup is open, click immediately
      const confirmBtn = document.getElementById("js_buildingSpeedupActivateBtn");
      if (confirmBtn) {
        if (Date.now() - lastConfirmClick < CONFIRM_COOLDOWN) return;
        const costEl = confirmBtn.querySelector(".ambrosiaIcon");
        if (costEl && costEl.textContent.trim() === "0") {
          lastConfirmClick = Date.now();
          lastButtonClick = 0;
          confirmBtn.click();
          lastFinish = Date.now();
          stopFastPoll();
        } else {
          window.dispatchEvent(new CustomEvent("ik-close-popup"));
          lastConfirmClick = Date.now();
        }
        return;
      }

      // Cooldown for speedup button
      if (Date.now() - lastButtonClick < BUTTON_COOLDOWN) return;
      // Let the DOM settle after a finish before evaluating the next build
      if (Date.now() - lastFinish < POST_FINISH_COOLDOWN) return;

      // Try premium builder queue first
      const countdown = document.getElementById("buildCountDown");
      if (countdown) {
        const timeText = countdown.textContent.trim();
        if (!timeText) return;
        const seconds = parseTime(timeText);
        if (seconds <= 0 || seconds >= THRESHOLD) return;
        const speedupBtn = document.getElementById("buildingSpeedupConstructionList");
        if (!speedupBtn) return;
        lastButtonClick = Date.now();
        lastConfirmClick = 0;
        speedupBtn.click();
        startFastPoll();
        return;
      }

      // Non-premium: find active construction countdown on city view
      for (let i = 0; i <= 24; i++) {
        const countdownEl = document.getElementById(`js_CityPosition${i}Countdown`);
        if (!countdownEl || !countdownEl.classList.contains("timetofinish")) continue;
        const textEl = document.getElementById(`js_CityPosition${i}CountdownText`);
        if (!textEl) continue;
        const timeText = textEl.textContent.trim();
        if (!timeText) continue;
        const seconds = parseTime(timeText);
        if (seconds <= 0 || seconds >= THRESHOLD) continue;
        const speedupBtn = document.getElementById(`js_CityPosition${i}SpeedupButton`);
        if (!speedupBtn || speedupBtn.classList.contains("invisible")) continue;
        lastButtonClick = Date.now();
        lastConfirmClick = 0;
        speedupBtn.click();
        startFastPoll();
        return;
      }
    } catch (e) {
      console.error("[IkAutoFinish]", e);
    }
  }

  function start() {
    // Always ensure interval is running (self-healing)
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(tryAutoFinish, CHECK_INTERVAL);
  }

  function stop() {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    stopFastPoll();
  }

  IkUtils.ensureBridge();

  chrome.storage.local.get("autoFinishEnabled", (data) => {
    enabled = !!data.autoFinishEnabled;
    if (enabled) start();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "autofinish-toggle") {
      enabled = msg.enabled;
      if (enabled) start();
      else stop();
    }
  });
})();

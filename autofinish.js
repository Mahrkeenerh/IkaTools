// Auto-finish buildings when remaining time is under 4m 55s (free speedup)
(() => {
  const THRESHOLD_SECONDS = 295; // 4m 55s
  const CHECK_INTERVAL = 1000;
  const FAST_INTERVAL = 100;
  const BUTTON_COOLDOWN = 500;
  const CONFIRM_COOLDOWN = 500;
  const FAST_POLL_DURATION = 3000;

  let enabled = true;
  let checkTimer = null;
  let fastTimer = null;
  let lastButtonClick = 0;
  let lastConfirmClick = 0;

  function parseTime(text) {
    let total = 0;
    const h = text.match(/(\d+)\s*h/);
    const m = text.match(/(\d+)\s*m/);
    const s = text.match(/(\d+)\s*s/);
    if (h) total += parseInt(h[1], 10) * 3600;
    if (m) total += parseInt(m[1], 10) * 60;
    if (s) total += parseInt(s[1], 10);
    return total;
  }

  function startFastPoll() {
    if (fastTimer) return;
    fastTimer = setInterval(tryAutoFinish, FAST_INTERVAL);
    setTimeout(() => {
      if (fastTimer) {
        clearInterval(fastTimer);
        fastTimer = null;
      }
    }, FAST_POLL_DURATION);
  }

  function tryAutoFinish() {
    if (!enabled) return;

    // If confirmation popup is open, click immediately
    const confirmBtn = document.getElementById("js_buildingSpeedupActivateBtn");
    if (confirmBtn) {
      if (Date.now() - lastConfirmClick < CONFIRM_COOLDOWN) return;
      const costEl = confirmBtn.querySelector(".ambrosiaIcon");
      if (costEl && costEl.textContent.trim() === "0") {
        lastConfirmClick = Date.now();
        lastButtonClick = 0; // allow button click immediately after confirm
        confirmBtn.click();
        startFastPoll(); // may need another round (speedup → finish)
      } else {
        // Not free — close popup via bridge
        window.dispatchEvent(new CustomEvent("ik-close-popup"));
        lastConfirmClick = Date.now();
      }
      return;
    }

    // Cooldown for speedup button
    if (Date.now() - lastButtonClick < BUTTON_COOLDOWN) return;

    // Look for countdown timer
    const countdown = document.getElementById("buildCountDown");
    if (!countdown) return;

    const timeText = countdown.textContent.trim();
    if (!timeText) return;

    const seconds = parseTime(timeText);
    if (seconds <= 0 || seconds > THRESHOLD_SECONDS) return;

    const speedupBtn = document.getElementById("buildingSpeedupConstructionList");
    if (!speedupBtn) return;

    lastButtonClick = Date.now();
    lastConfirmClick = 0; // allow confirm click immediately after button
    speedupBtn.click();
    startFastPoll(); // watch for confirmation popup
  }

  function start() {
    if (checkTimer) return;
    checkTimer = setInterval(tryAutoFinish, CHECK_INTERVAL);
  }

  function stop() {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    if (fastTimer) {
      clearInterval(fastTimer);
      fastTimer = null;
    }
  }

  chrome.storage.local.get("autoFinishEnabled", (data) => {
    enabled = data.autoFinishEnabled !== false;
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

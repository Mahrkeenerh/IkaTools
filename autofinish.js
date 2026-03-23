// Auto-finish buildings when remaining time is under 4m 55s (free speedup)
(() => {
  const THRESHOLD_SECONDS = 295; // 4m 55s
  const CHECK_INTERVAL = 1000;
  const COOLDOWN_MS = 5000;

  let enabled = true;
  let checkTimer = null;
  let lastClickTime = 0;

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

  function tryAutoFinish() {
    if (!enabled) return;
    if (Date.now() - lastClickTime < COOLDOWN_MS) return;

    // If confirmation popup is open, handle it
    const confirmBtn = document.getElementById("js_buildingSpeedupActivateBtn");
    if (confirmBtn) {
      const costEl = confirmBtn.querySelector(".ambrosiaIcon");
      if (costEl && costEl.textContent.trim() === "0") {
        lastClickTime = Date.now();
        confirmBtn.click();
      }
      return;
    }

    // Look for countdown timer
    const countdown = document.getElementById("buildCountDown");
    if (!countdown) return;

    const timeText = countdown.textContent.trim();
    if (!timeText) return;

    const seconds = parseTime(timeText);
    if (seconds <= 0 || seconds > THRESHOLD_SECONDS) return;

    const speedupBtn = document.getElementById("buildingSpeedupConstructionList");
    if (!speedupBtn) return;
    if (!speedupBtn.classList.contains("free")) return;

    lastClickTime = Date.now();
    speedupBtn.click();
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

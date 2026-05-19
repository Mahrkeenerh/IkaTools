// TEMP: watch a hard-coded set of islands for open city slots (cities < 16).
// Delete this file + its manifest entry when no longer needed.
// NOTE: intentionally ignores pirateSleepStart/pirateSleepEnd — the watch must
// fire at any hour, including night, so the user is alerted the moment a slot opens.
(() => {
  const TARGETS = [
    [49, 52],
    [50, 50],
  ];
  const THRESHOLD = 16;
  const MIN_DELAY_MS = 60_000;
  const MAX_DELAY_MS = 5 * 60_000;

  const targetKeys = new Set(TARGETS.map(([x, y]) => `${x}:${y}`));

  // --- Player-active detection (mirrors content/autopirate.js) ---
  const IDLE_TIMEOUT_MS = 5000;
  let lastActivity = Date.now();
  let lastPopupHeartbeat = 0;

  function onActivity() {
    if (!document.hasFocus() || document.hidden) return;
    lastActivity = Date.now();
  }
  ["mousemove", "keydown", "click", "scroll", "mousedown"].forEach((e) =>
    document.addEventListener(e, onActivity, { passive: true, capture: true })
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onActivity();
  });
  window.addEventListener("focus", () => onActivity());

  function isPlayerIdle() {
    if (Date.now() - lastPopupHeartbeat < 10000) return false;
    return (document.hidden || !document.hasFocus()) &&
      Date.now() - lastActivity > IDLE_TIMEOUT_MS;
  }

  function readTargetCities() {
    const out = {};
    document.querySelectorAll(".islandTile").forEach((tile) => {
      const title = tile.getAttribute("title") || "";
      const m = title.match(/\[(\d+):(\d+)\]$/);
      if (!m) return;
      const key = `${m[1]}:${m[2]}`;
      if (!targetKeys.has(key)) return;
      const citiesEl = tile.querySelector(".cities");
      out[key] = citiesEl ? parseInt(citiesEl.textContent, 10) || 0 : 0;
    });
    return out;
  }

  let audioCtx = null;
  let beepIntervalId = null;
  function playBeep() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    } catch (e) {
      console.warn("[IkWatch] beep failed:", e);
    }
  }
  function startBeeping() {
    if (beepIntervalId) return;
    playBeep();
    beepIntervalId = setInterval(playBeep, 400);
  }
  function stopBeeping() {
    if (beepIntervalId) {
      clearInterval(beepIntervalId);
      beepIntervalId = null;
    }
  }

  let bannerEl = null;
  let originalTitle = null;
  let titleFlashTimer = null;

  function dismissAlert() {
    stopBeeping();
    if (bannerEl) {
      bannerEl.remove();
      bannerEl = null;
    }
    if (titleFlashTimer) {
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
    }
    if (originalTitle != null) {
      document.title = originalTitle;
      originalTitle = null;
    }
  }

  function showBanner(message) {
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.id = "ik-island-watch-banner";
      bannerEl.style.cssText = [
        "position:fixed",
        "top:0",
        "left:0",
        "right:0",
        "z-index:2147483647",
        "background:#c0392b",
        "color:#fff",
        "padding:14px 22px",
        "font:bold 16px/1.3 sans-serif",
        "text-align:center",
        "box-shadow:0 4px 12px rgba(0,0,0,0.6)",
        "cursor:pointer",
        "letter-spacing:0.5px",
      ].join(";");
      bannerEl.title = "Click to dismiss";
      bannerEl.addEventListener("click", dismissAlert);
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = message + "  (click to dismiss)";
  }

  function flashTitle(message) {
    if (titleFlashTimer) return;
    if (originalTitle == null) originalTitle = document.title;
    let toggle = false;
    titleFlashTimer = setInterval(() => {
      document.title = toggle ? originalTitle : message;
      toggle = !toggle;
    }, 1000);
  }

  function notify(message) {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("Ikariam: open slot!", { body: message, requireInteraction: true });
      }
    } catch (e) {}
  }

  function alertOpen(lowList) {
    const msg = "Open city slot — " + lowList.map((r) => `[${r.key}]=${r.cities}/16`).join("  ");
    console.warn("[IkWatch]", msg);
    startBeeping();
    showBanner(msg);
    flashTitle("⚠ OPEN SLOT — " + lowList.map((r) => r.key).join(" "));
    notify(msg);
  }

  function poll() {
    const allTiles = document.querySelectorAll(".islandTile");
    const view = (location.search || "").match(/view=([a-z_]+)/i);
    const viewName = view ? view[1] : "unknown";
    const idle = isPlayerIdle();
    const found = readTargetCities();

    const targetSummary = TARGETS.map(([x, y]) => {
      const key = `${x}:${y}`;
      const c = found[key];
      return c == null ? `[${key}]=?` : `[${key}]=${c}`;
    }).join(" ");

    console.info(
      `[IkWatch] poll @ ${new Date().toLocaleTimeString()} | view=${viewName} | tiles=${allTiles.length} | idle=${idle} | ${targetSummary}`
    );

    const low = [];
    for (const key of targetKeys) {
      const cities = found[key];
      if (cities != null && cities < THRESHOLD) low.push({ key, cities });
    }
    if (low.length) alertOpen(low);
  }

  function triggerRefresh() {
    try {
      if (typeof IkUtils !== "undefined" && IkUtils.ensureBridge) IkUtils.ensureBridge();
      window.dispatchEvent(new CustomEvent("ik-ajax-call", {
        detail: { url: "?view=worldmap_iso" }
      }));
    } catch (e) {
      console.error("[IkWatch] refresh dispatch failed:", e);
    }
  }

  function nextDelay() {
    return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  }

  function scheduleNextRefresh() {
    const delay = nextDelay();
    console.info(`[IkWatch] next refresh in ${(delay / 1000).toFixed(0)}s`);
    setTimeout(() => {
      if (!isPlayerIdle()) {
        console.info("[IkWatch] player active, deferring refresh");
        scheduleNextRefresh();
        return;
      }
      console.info("[IkWatch] triggering worldmap refresh");
      triggerRefresh();
      // Page is reloading — the freshly injected content script will continue the cycle.
    }, delay);
  }

  // Ask for browser notification permission once (silent if blocked).
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch (e) {}

  // Popup-heartbeat tracking (suppress idle) + dev-mode "Test alert" trigger.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "popup-heartbeat") {
        lastPopupHeartbeat = Date.now();
      } else if (msg.type === "island-watch-test") {
        alertOpen([{ key: "test:test", cities: 0 }]);
      }
    });
  } catch (e) {}

  // Wait 1s so the game finishes rendering tiles, then read DOM and schedule the next refresh.
  // The new content script invocation that runs after each refresh will do the same.
  setTimeout(() => {
    try { poll(); } catch (e) { console.error("[IkWatch] initial poll failed:", e); }
    scheduleNextRefresh();
  }, 1000);
  console.info("[IkWatch] active — watching " + TARGETS.map(([x, y]) => `[${x}:${y}]`).join(" ") + " for cities<" + THRESHOLD);
})();

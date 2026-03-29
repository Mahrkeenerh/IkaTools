// Wine timer — shows how long current city's wine lasts in the resource bar
(() => {
  const TAG = "[IkTools:WineTimer]";

  const parseNum = (text) => IkUtils.parseNum(text);

  function getWineData() {
    const stock = parseNum(document.getElementById("js_GlobalMenu_wine")?.textContent);
    const consumption = parseNum(document.getElementById("js_GlobalMenu_WineConsumption")?.textContent);
    const production = parseNum(document.getElementById("js_GlobalMenu_production_wine")?.textContent);
    return { stock, consumption, production };
  }

  function formatDuration(hours) {
    if (hours <= 0) return "0h";
    return hours.toFixed(1) + "h";
  }

  function createTimerEl() {
    const el = document.createElement("span");
    el.id = "ik-wine-timer";
    el.style.cssText = "display:block; font-size:0.9em; font-weight:bold; opacity:0.85; line-height:1; margin-top:1px; white-space:nowrap;";
    return el;
  }

  function scheduleNext() {
    setTimeout(update, 60_000);
  }

  function update() {
    const { stock, consumption, production } = getWineData();
    const net = consumption - production; // net consumption per hour
    let timerEl = document.getElementById("ik-wine-timer");

    if (!timerEl) {
      const wineSpan = document.getElementById("js_GlobalMenu_wine");
      if (!wineSpan) return; // element gone — stop scheduling
      timerEl = createTimerEl();
      wineSpan.parentElement.appendChild(timerEl);
      console.log(TAG, "Timer injected");
    }
    scheduleNext();

    if (consumption === 0 && production === 0) {
      timerEl.textContent = "–";
      timerEl.style.color = "#888";
      return;
    }

    if (net <= 0) {
      // Wine is not draining — show net gain
      const surplus = production - consumption;
      timerEl.textContent = "+" + surplus + "/h";
      timerEl.style.color = "#2a2";
      return;
    }

    const hours = stock / net;
    timerEl.textContent = "~" + formatDuration(hours);
    timerEl.style.color = hours > 24 ? "#2a2" : "#f44";
  }

  // Wait for the resource bar to exist
  const wineEl = document.getElementById("resources_wine");
  if (!wineEl) {
    console.log(TAG, "No wine resource bar found, skipping");
    return;
  }

  update();

  // Also update when city switches (resource bar values change)
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    if (!debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        update();
      }, 2000);
    }
  });
  observer.observe(wineEl, { childList: true, subtree: true, characterData: true });
  console.log(TAG, "Initialized");
})();

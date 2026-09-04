// Wine timer — shows how long current city's wine lasts in the resource bar
(() => {
  // readAmount handles the game's abbreviated numbers ("1,03M") and prefers the
  // exact value from the title attribute when present.
  const readAmount = (el) => IkUtils.readAmount(el);

  function getWineData() {
    const stock = readAmount(document.getElementById("js_GlobalMenu_wine"));
    const consumption = readAmount(document.getElementById("js_GlobalMenu_WineConsumption"));
    const production = readAmount(document.getElementById("js_GlobalMenu_production_wine"));
    return { stock, consumption, production };
  }

  function formatDuration(hours) {
    if (hours <= 0) return "0h";
    if (hours > 24) return (hours / 24).toFixed(1) + "d";
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
  if (!wineEl) return;

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
})();

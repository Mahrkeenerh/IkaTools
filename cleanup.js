// Premium UI cleanup — toggled via chrome.storage "cleanupEnabled" (default: on)
(() => {
  let enabled = true;
  let observer = null;

  function cleanup() {
    if (!enabled) return;

    const shop = document.getElementById("cityFlyingShopContainer");
    if (shop) shop.remove();

    const trader = document.querySelector('li[onclick*="premiumTrader"]');
    if (trader) trader.remove();

    document.querySelectorAll(".footerleft, .footerright").forEach(el => el.remove());

    const mapControls = document.getElementById("mapControls");
    if (mapControls) mapControls.innerHTML = "";

    if (document.body.id === "city") {
      const footer = document.getElementById("footer");
      if (footer) footer.remove();
    }

    const fountain = document.getElementById("cityAmbrosiaFountain");
    if (fountain) fountain.remove();

    const ambrosia = document.querySelector("li.ambrosiaNoSpin");
    if (ambrosia) ambrosia.remove();

    document.querySelectorAll(".cityLocation.buildplace.premium").forEach(el => el.remove());

    document.querySelectorAll(".btnIngameCountdown").forEach(el => {
      if (el.textContent.includes("bohů")) el.remove();
    });
  }

  function start() {
    cleanup();
    if (!observer) {
      observer = new MutationObserver(cleanup);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // --- Hide zero city counts on world map ---
  let hideZeros = false;
  let zerosObserver = null;

  function cleanZeros() {
    if (!hideZeros) return;
    document.querySelectorAll(".islandTile, .oceanTile").forEach((tile) => {
      const title = tile.getAttribute("title") || "";
      // Only dim real islands (have [x:y] coords), not barbarian ships etc.
      if (!title.match(/\[\d+:\d+\]$/)) { tile.style.opacity = ""; return; }
      const citiesEl = tile.querySelector(".cities");
      if (!citiesEl) { tile.style.opacity = ""; return; }
      if (citiesEl.textContent.trim() === "0") {
        tile.style.opacity = "0.35";
      } else {
        tile.style.opacity = "";
      }
    });
  }

  function startZeros() {
    cleanZeros();
    if (!zerosObserver) {
      zerosObserver = new MutationObserver(cleanZeros);
      zerosObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function stopZeros() {
    if (zerosObserver) {
      zerosObserver.disconnect();
      zerosObserver = null;
    }
    // Restore all
    document.querySelectorAll(".islandTile, .oceanTile").forEach((tile) => {
      tile.style.opacity = "";
    });
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

    let active = false;
    function updateStyle() {
      link.style.color = active ? "#ff4444" : "";
      link.style.opacity = active ? "1" : "0.4";
      link.style.webkitTextStroke = active ? "0.2px" : "";
      link.textContent = "\u2620 Pirate";
    }

    chrome.storage.local.get("pirateEnabled", (d) => {
      active = !!d.pirateEnabled;
      updateStyle();
    });

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

  // Load initial state
  chrome.storage.local.get(["cleanupEnabled", "hideZeroCities"], (data) => {
    enabled = data.cleanupEnabled !== false;
    hideZeros = !!data.hideZeroCities;
    if (enabled) start();
    if (hideZeros) startZeros();
    injectPirateToggle();
  });

  // Listen for toggle from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "cleanup-toggle") {
      enabled = msg.enabled;
      if (enabled) start();
      else stop();
    }
    if (msg.type === "hide-zeros-toggle") {
      hideZeros = msg.enabled;
      if (hideZeros) startZeros();
      else stopZeros();
    }
  });
})();

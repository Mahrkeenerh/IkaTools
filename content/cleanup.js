// Premium UI cleanup — toggled via chrome.storage "cleanupEnabled" (default: on)
(() => {
  let enabled = true;
  let observer = null;
  function cleanup() {
    if (!enabled) return;
    // Disconnect observer during cleanup to prevent feedback loop
    // (removing elements triggers mutations which triggers cleanup again)
    if (observer) observer.disconnect();

    const shop = document.getElementById("cityFlyingShopContainer");
    if (shop) shop.remove();

    // Shop tooltip that lingers after the container is removed
    document.querySelectorAll(".info_tip").forEach(el => {
      if (el.querySelector(".infoTip")?.textContent.trim() === "Obchod") el.remove();
    });

    const resourceShop = document.querySelector('li.resourceShop[onclick*="premiumResourceShop"]');
    if (resourceShop) resourceShop.remove();

    document.querySelectorAll(".footerleft, .footerright").forEach(el => el.remove());

    const mapControls = document.getElementById("mapControls");
    if (mapControls) mapControls.innerHTML = "";

    if (document.body.id === "city") {
      const footer = document.getElementById("footer");
      if (footer) footer.remove();
    }

    const fountain = document.getElementById("cityAmbrosiaFountain");
    if (fountain) fountain.remove();

    document.querySelectorAll("li.ambrosia, li.ambrosiaNoSpin").forEach(el => el.remove());

    // Pirate fortress slot (always position 17 — built fortress or empty sea-based ground).
    // Hide instead of remove — the game's per-state DOM update handler walks position
    // and pirateFortress* elements on every refresh, including after auto-finish; if any
    // are missing the handler throws and aborts mid-update, leaving building visuals
    // (e.g. the just-finished port's level) stale until manual reload.
    const fortressSlot = document.querySelector("#position17.pirateFortress, #position17.buildingGround.sea");
    if (fortressSlot) {
      fortressSlot.style.display = "none";
      const s17Scroll = document.getElementById("js_CityPosition17Scroll");
      if (s17Scroll) s17Scroll.style.display = "none";
      const s17Countdown = document.getElementById("js_CityPosition17Countdown");
      if (s17Countdown) s17Countdown.style.display = "none";
    }

    const fortressBg = document.getElementById("pirateFortressBackground");
    if (fortressBg) fortressBg.style.display = "none";
    const fortressShip = document.getElementById("pirateFortressShip");
    if (fortressShip) fortressShip.style.display = "none";

    // Hide instead of remove — game timers keep referencing hidden fields inside these
    // "bohů" = Czech for "gods" (ambrosia/premium timer label) — NOTE: language-dependent,
    // also matches English "gods" and the happyHour class as a fallback
    document.querySelectorAll(".btnIngameCountdown").forEach(el => {
      if (el.textContent.includes("bohů") || el.textContent.includes("gods") || el.classList.contains("happyHour")) el.style.display = "none";
    });

    // Reconnect observer after cleanup
    if (observer) observer.observe(document.body, { childList: true, subtree: true });
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

  // Load initial state
  chrome.storage.local.get("cleanupEnabled", (data) => {
    enabled = !!data.cleanupEnabled;
    if (enabled) start();
  });

  // Listen for toggle from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "cleanup-toggle") {
      enabled = msg.enabled;
      if (enabled) start();
      else stop();
    }
  });
})();

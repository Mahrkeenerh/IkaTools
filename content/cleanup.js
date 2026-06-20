// Premium UI cleanup + pirate-fortress hiding.
// Two independent toggles share one MutationObserver:
//   - "cleanupEnabled"      (default on)  → removes premium clutter (shop, ambrosia, ads)
//   - "hideFortressEnabled" (default on)  → hides the pirate fortress on the city view
(() => {
  let cleanupOn = true;
  let hideFortressOn = true;
  let observer = null;

  function clearPremiumClutter() {
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

    // Hide instead of remove — game timers keep referencing hidden fields inside these
    // "bohů" = Czech for "gods" (ambrosia/premium timer label) — NOTE: language-dependent,
    // also matches English "gods" and the happyHour class as a fallback
    document.querySelectorAll(".btnIngameCountdown").forEach(el => {
      if (el.textContent.includes("bohů") || el.textContent.includes("gods") || el.classList.contains("happyHour")) el.style.display = "none";
    });
  }

  function hideFortress() {
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
  }

  // Reverse hideFortress() — clears the inline display:none we set (it persists otherwise)
  function showFortress() {
    [
      document.querySelector("#position17.pirateFortress, #position17.buildingGround.sea"),
      document.getElementById("js_CityPosition17Scroll"),
      document.getElementById("js_CityPosition17Countdown"),
      document.getElementById("pirateFortressBackground"),
      document.getElementById("pirateFortressShip"),
    ].forEach((el) => { if (el) el.style.display = ""; });
  }

  function cleanup() {
    if (!cleanupOn && !hideFortressOn) return;
    // Disconnect observer during cleanup to prevent feedback loop
    // (removing elements triggers mutations which triggers cleanup again)
    if (observer) observer.disconnect();

    if (cleanupOn) clearPremiumClutter();
    if (hideFortressOn) hideFortress();

    // Reconnect observer after cleanup
    if (observer) observer.observe(document.body, { childList: true, subtree: true });
  }

  function sync() {
    if (!hideFortressOn) showFortress();
    if (cleanupOn || hideFortressOn) {
      cleanup();
      if (!observer) {
        observer = new MutationObserver(cleanup);
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } else if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // Load initial state (fortress hiding defaults on to preserve prior behavior)
  chrome.storage.local.get(["cleanupEnabled", "hideFortressEnabled"], (data) => {
    cleanupOn = !!data.cleanupEnabled;
    hideFortressOn = data.hideFortressEnabled ?? true;
    sync();
  });

  // Listen for toggles from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "cleanup-toggle") {
      cleanupOn = msg.enabled;
      sync();
    }
    if (msg.type === "hide-fortress-toggle") {
      hideFortressOn = msg.enabled;
      sync();
    }
  });
})();

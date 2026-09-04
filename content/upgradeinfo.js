// Show missing resource amounts on building upgrade panels
(() => {
  const RESOURCE_IDS = {
    wood: "js_GlobalMenu_wood",
    wine: "js_GlobalMenu_wine",
    marble: "js_GlobalMenu_marble",
    crystal: "js_GlobalMenu_crystal",
    sulfur: "js_GlobalMenu_sulfur",
  };

  // Workshop uses "glass" for crystal, "gold" for gold — map to their total elements
  const WORKSHOP_RESOURCE_IDS = {
    gold: "js_GlobalMenu_gold_Total",
    glass: "js_GlobalMenu_crystal",
  };

  const readAmount = (el) => IkUtils.readAmount(el);

  function formatNum(n) {
    return n.toLocaleString("en").replace(/,/g, " ");
  }

  function getCurrentResource(type) {
    return readAmount(document.getElementById(RESOURCE_IDS[type]));
  }

  function getCurrentWorkshopResource(type) {
    return readAmount(document.getElementById(WORKSHOP_RESOURCE_IDS[type]));
  }

  function appendBuildingMissing(li, missing) {
    li.style.height = "auto";
    li.style.paddingBottom = "0";
    li.style.marginBottom = "0";
    const span = document.createElement("span");
    span.className = "ik-missing";
    span.style.cssText = "display:block; font-size:0.85em; opacity:0.8; line-height:1.2;";
    span.textContent = `(-${formatNum(missing)})`;
    li.appendChild(span);
  }

  function appendWorkshopMissing(li, missing) {
    li.style.position = "relative";
    const span = document.createElement("span");
    span.className = "ik-missing";
    span.style.cssText = "position:absolute; left:36px; top:100%; font-weight:bold; color:#aa0303; line-height:1.2;";
    span.textContent = `(-${formatNum(missing)})`;
    li.appendChild(span);
    // Dim the card if you can't afford the upgrade
    const box = li.closest(".highlightbox");
    if (box && !box.dataset.ikDimmed) {
      box.dataset.ikDimmed = "1";
      box.style.opacity = "0.6";
    }
    // Expand both highlightbox cards in the row to keep them aligned
    const row = li.closest(".units");
    if (row && !row.dataset.ikExpanded) {
      row.dataset.ikExpanded = "1";
      for (const b of row.querySelectorAll(".highlightbox")) {
        b.style.paddingBottom = (parseFloat(getComputedStyle(b).paddingBottom) + 16) + "px";
      }
    }
  }

  function refreshGameScrollbar() {
    // The game uses a custom scrollbar (ikariam.Scrollbar) that doesn't
    // auto-update when content height changes. Poke adjustSize() via bridge.
    window.dispatchEvent(new CustomEvent("ik-refresh-scrollbar"));
  }

  function injectMissing() {
    let workshopChanged = false;
    const lists = document.querySelectorAll("ul.resources");
    for (const ul of lists) {
      for (const li of ul.children) {
        if (li.querySelector(".ik-missing")) continue;

        // Building upgrades: red+bold items with resource class
        if (li.classList.contains("red") && li.classList.contains("bold")) {
          const type = Object.keys(RESOURCE_IDS).find((t) => li.classList.contains(t));
          if (!type) continue;
          const cost = readAmount(li);
          const current = getCurrentResource(type);
          const missing = cost - current;
          if (missing <= 0) continue;
          appendBuildingMissing(li, missing);
          continue;
        }

        // Workshop upgrades: gold/glass items inside highlightbox cards
        if (!li.closest(".highlightbox")) continue;
        const wsType = Object.keys(WORKSHOP_RESOURCE_IDS).find((t) => li.classList.contains(t));
        if (!wsType) continue;
        const cost = readAmount(li);
        const current = getCurrentWorkshopResource(wsType);
        const missing = cost - current;
        if (missing <= 0) continue;
        appendWorkshopMissing(li, missing);
        workshopChanged = true;
      }
    }
    if (workshopChanged) refreshGameScrollbar();
  }

  // Initial run
  injectMissing();

  // Debounced MutationObserver, same pattern as barbarian ship calc
  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      injectMissing();
    }, 300);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();

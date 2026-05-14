// Injects a "Target:" widget into the singular battle report
// (#militaryAdvisorReportView), bound to the non-own city's cityId.
//
// The report itself is loaded as a templateView overlay on top of body.id="city"
// so we watch for the container appearing/disappearing in the DOM rather than
// keying off body.id.
(() => {
  const TAG = "[BattleReport]";

  // Pull cityId from a `?view=island&cityId=NN` href.
  function cityIdFromHref(a) {
    if (!a) return null;
    const m = a.getAttribute("href") && a.getAttribute("href").match(/[?&]cityId=(\d+)/);
    return m ? m[1] : null;
  }

  // Singular report layout:
  //   #militaryAdvisorReportView
  //     #troopsReport
  //       .contentBox01h
  //         .header (title)
  //         .content
  //           .attacker > span > a (attacker home city link)
  //           .defender > span > a (defender city link)
  //           ...
  function inject(container) {
    if (!container || container.querySelector(".ik-battle-mark-row")) return;

    // Bail until the page's relatedCityData is parsed — without it we can't
    // tell which side is us and might wrongly mark our own city on a
    // defensive report. The MutationObserver will retry.
    const own = IkUtils.getOwnCityIds();
    if (!own) return;

    const attackerLink = container.querySelector(".attacker a[href*='cityId=']");
    const defenderLink = container.querySelector(".defender a[href*='cityId=']");
    const atkId = cityIdFromHref(attackerLink);
    const defId = cityIdFromHref(defenderLink);
    if (!atkId && !defId) return;

    // Pick whichever side is NOT one of our cities. If both sides are own
    // (impossible in practice) or neither matches (e.g. barbarian raid where
    // we have no relatedCityData entry), bail rather than guess.
    let targetId = null;
    let targetName = "";
    if (defId && !own.has(defId)) { targetId = defId; targetName = defenderLink.textContent.trim(); }
    else if (atkId && !own.has(atkId)) { targetId = atkId; targetName = attackerLink.textContent.trim(); }
    if (!targetId) return;

    const row = document.createElement("div");
    row.className = "ik-battle-mark-row";
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      margin: "6px 0 2px",
      padding: "4px 8px",
      background: "rgba(0,0,0,0.18)",
      borderRadius: "3px",
      fontSize: "12px",
    });

    const label = document.createElement("span");
    label.textContent = "Target (" + targetName + "):";
    label.style.opacity = "0.85";
    row.appendChild(label);

    if (globalThis.CityMarks) {
      row.appendChild(CityMarks.createWidget(targetId, { compact: true }));
    }

    // Place it just after the defender row so it sits with the combatant info.
    const defRow = container.querySelector(".defender");
    if (defRow && defRow.parentNode) {
      defRow.parentNode.insertBefore(row, defRow.nextSibling);
    } else {
      const content = container.querySelector(".content") || container;
      content.appendChild(row);
    }
  }

  function tryInjectAll() {
    const single = document.getElementById("militaryAdvisorReportView");
    if (single) inject(single);
  }

  // The report is loaded asynchronously after navigation — watch broadly.
  let debounce = null;
  const obs = new MutationObserver(() => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      tryInjectAll();
    }, 100);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Initial pass — covers a direct page load of the report URL.
  tryInjectAll();
})();

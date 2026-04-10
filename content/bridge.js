// Runs in PAGE context (not content script isolated world).
// Injected as an external <script src> to bypass CSP.
// Listens for custom events from the content script and calls game functions.

// Read city list from game data for the popup city selector
window.addEventListener("ik-read-cities", () => {
  let result = {};
  try {
    if (typeof ikariam !== "undefined" && ikariam.model) {
      result = ikariam.model.relatedCityData || {};
    }
  } catch (e) {}
  window.dispatchEvent(new CustomEvent("ik-cities-data", { detail: result }));
});

// Read island background data (available on island view)
window.addEventListener("ik-read-island-data", () => {
  let result = null;
  try {
    // The game stores island data in ikariam.controller or as a global from updateBackgroundData
    // Try multiple sources
    if (typeof dataSetForView !== "undefined" && dataSetForView) {
      result = dataSetForView;
    }
  } catch (e) {}
  // Also try to grab avatarScores from the page's script context
  let scores = null;
  try {
    if (typeof avatarScores !== "undefined") scores = avatarScores;
  } catch (e) {}
  window.dispatchEvent(new CustomEvent("ik-island-data", {
    detail: { viewData: result, avatarScores: scores }
  }));
});

// Read game-side JS variables and send them back to the content script.
// These arrays contain island coordinates for military, war, and barbarian overlays.
window.addEventListener("ik-read-game-data", () => {
  const result = {};
  try {
    if (typeof militaryIslandsJS !== "undefined") result.military = militaryIslandsJS;
  } catch (e) { /* not available */ }
  try {
    if (typeof warIslandsJS !== "undefined") result.war = warIslandsJS;
  } catch (e) { /* not available */ }
  try {
    if (typeof barbarianIslandsJS !== "undefined") result.barbarian = barbarianIslandsJS;
  } catch (e) { /* not available */ }
  window.dispatchEvent(new CustomEvent("ik-game-data", { detail: result }));
});

// Convert pirate points to crew: click slider max, then confirm via response event
window.addEventListener("ik-convert-crew", () => {
  try {
    const maxBtn = document.getElementById("CPToCrewSliderMax");
    if (maxBtn) maxBtn.click();
  } catch (err) {
    console.error("[IkBridge] convertCrew failed:", err);
  }
});

// --- Custom predicate eval runner (power-user JS filter) ---
// The content script's isolated world is subject to the extension CSP, which
// MV3 does not allow to include 'unsafe-eval'. Bridge runs in the page
// context (Ikariam's page has no eval restriction), so new Function() works
// here. Content script posts code/islands; we compile once, evaluate per
// request, and respond via CustomEvent.
(function () {
  let fn = null;

  function reconstructIsland(s) {
    // Reconstruct Set<string> from the serialized array so user code can do
    // i._allyTags.has("-DR-") naturally.
    const out = Object.assign({}, s);
    out._allyTags = new Set(s._allyTags || []);
    return out;
  }

  window.addEventListener("ik-eval-cmd", (e) => {
    const req = e.detail || {};
    const resp = { reqId: req.reqId };
    try {
      if (req.cmd === "compile") {
        const src = /\breturn\b/.test(req.code) ? req.code : "return (" + req.code + ");";
        fn = new Function("i", src);
        // Sanity probe on an empty island — catches most parse/runtime errors early
        fn({ x: 0, y: 0, cities: 0, _allyTags: new Set(), _ownerNamesText: "", _maxArmy: 0, _players: [], _ctAvailable: false, _ctChecked: false });
        resp.ok = true;
      } else if (req.cmd === "clear") {
        fn = null;
        resp.ok = true;
      } else if (req.cmd === "eval") {
        if (!fn) { resp.error = "No predicate compiled"; }
        else {
          const islands = req.islands || [];
          const matches = new Array(islands.length);
          for (let i = 0; i < islands.length; i++) {
            try {
              matches[i] = !!fn(reconstructIsland(islands[i]));
            } catch (err) {
              matches[i] = false;
            }
          }
          resp.matches = matches;
          resp.ok = true;
        }
      } else {
        resp.error = "Unknown cmd: " + req.cmd;
      }
    } catch (err) {
      resp.error = (err && err.message) || String(err);
    }
    window.dispatchEvent(new CustomEvent("ik-eval-response", { detail: resp }));
  });
})();

// Read world map island ID mapping (available on worldmap_iso view)
window.addEventListener("ik-read-world-islands", () => {
  let result = null;
  try {
    const screen = ikariam.getScreen();
    if (screen && screen.islands) {
      // islands[x][y] = [islandId, ...] — flatten to {x:y: islandId}
      const mapping = {};
      const isl = screen.islands;
      for (let x = 0; x < isl.length; x++) {
        if (!isl[x]) continue;
        for (let y = 0; y < isl[x].length; y++) {
          if (!isl[x][y]) continue;
          mapping[x + ":" + y] = isl[x][y][0];
        }
      }
      result = mapping;
    }
  } catch (e) {}
  window.dispatchEvent(new CustomEvent("ik-world-islands", { detail: result }));
});

// Guard: handlers below require ajaxHandlerCall — skip on non-game pages (forum, lobby, etc.)
if (typeof ajaxHandlerCall === "function") {

window.addEventListener("ik-jump", (e) => {
  const x = e.detail.x;
  const y = e.detail.y;
  const xInput = document.getElementById("inputXCoord");
  const yInput = document.getElementById("inputYCoord");
  if (xInput) xInput.value = x;
  if (yInput) yInput.value = y;
  try {
    ikariam.getMapNavigation().jumpToCoord();
  } catch (err) {
    console.error("[IkBridge] jumpToCoord failed:", err);
  }
});

// Close popup via game API
window.addEventListener("ik-close-popup", () => {
  try { ikariam.closePopup(); } catch (e) {}
});

// General-purpose AJAX navigation (calls game's ajaxHandlerCall)
window.addEventListener("ik-ajax-call", (e) => {
  try { ajaxHandlerCall(e.detail.url); } catch (err) {
    console.error("[IkBridge] ajaxHandlerCall failed:", err);
  }
});

} // end ajaxHandlerCall guard

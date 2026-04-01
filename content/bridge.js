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

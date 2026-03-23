// Runs in PAGE context (not content script isolated world).
// Injected as an external <script src> to bypass CSP.
// Listens for custom events from the content script and calls game functions.
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

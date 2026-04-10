// Content-script wrapper for the page-context eval runner in bridge.js.
// Exposes an async API for compiling and evaluating user-written JS
// predicates against island data, bypassing the MV3 content-script CSP
// by routing through the page's JS context.
//
// Public API (globalThis.CustomEval):
//   compile(code) -> Promise<{ok, error?}>
//   evaluate(islands) -> Promise<{matches?, error?}>
//   clear() -> void
//   hasCode() -> boolean
//   getCode() -> string|null
//
// Islands are serialized for the CustomEvent round-trip: Set<string> fields
// are converted to arrays, then reconstructed inside bridge.js.
(() => {
  let currentCode = null;
  let pendingRequests = new Map(); // reqId -> {resolve, reject, timeout}
  let reqIdCounter = 0;

  function nextReqId() {
    reqIdCounter = (reqIdCounter + 1) | 0;
    return "r" + reqIdCounter;
  }

  window.addEventListener("ik-eval-response", (e) => {
    const detail = e.detail || {};
    const pending = pendingRequests.get(detail.reqId);
    if (!pending) return;
    pendingRequests.delete(detail.reqId);
    clearTimeout(pending.timeout);
    pending.resolve(detail);
  });

  function sendRequest(cmd, payload, timeoutMs) {
    return new Promise((resolve) => {
      IkUtils.ensureBridge();
      const reqId = nextReqId();
      const timeout = setTimeout(() => {
        pendingRequests.delete(reqId);
        resolve({ error: "Eval bridge timeout" });
      }, timeoutMs || 3000);
      pendingRequests.set(reqId, { resolve, timeout });
      window.dispatchEvent(new CustomEvent("ik-eval-cmd", {
        detail: Object.assign({ cmd, reqId }, payload || {}),
      }));
    });
  }

  // Minimal serializer — extracts the fields a user predicate might read.
  // Converts Set<string> fields (_allyTags) to arrays for structured clone.
  function serializeIsland(i) {
    return {
      x: i.x, y: i.y, name: i.name,
      cities: i.cities, tradegood: i.tradegood, wonder: i.wonder,
      owner: i.owner || "",
      piracy: !!i.piracy, helios: !!i.helios, military: !!i.military, war: !!i.war,
      _allyTags: i._allyTags ? [...i._allyTags] : [],
      _ownerNamesText: i._ownerNamesText || "",
      _maxArmy: i._maxArmy || 0,
      _players: i._players || [],
      _ctAvailable: !!i._ctAvailable,
      _ctChecked: !!i._ctChecked,
    };
  }

  async function compile(code) {
    if (!code || !code.trim()) {
      currentCode = null;
      await sendRequest("clear");
      return { ok: true };
    }
    const r = await sendRequest("compile", { code });
    if (r.ok) currentCode = code;
    return r;
  }

  async function evaluate(islands) {
    if (!currentCode || !islands || islands.length === 0) {
      return { matches: [] };
    }
    const serialized = islands.map(serializeIsland);
    return sendRequest("eval", { islands: serialized }, 10000);
  }

  function clear() {
    currentCode = null;
    sendRequest("clear");
  }

  function hasCode() { return currentCode != null; }
  function getCode() { return currentCode; }

  globalThis.CustomEval = { compile, evaluate, clear, hasCode, getCode };
})();

// Shared async evaluation helpers for custom JS predicates and presets.
// Consumers (minimap, islandfilter) call these and store results locally —
// this module does not hold any persistent state.
//
// Depends on: globalThis.CustomEval
globalThis.FilterRunner = (() => {
  let customVersion = 0;
  let presetVersion = 0;

  // Evaluate the currently compiled custom JS predicate against an array of
  // items. Returns a Map<key, bool> keyed by keyOf(item), or null if no code
  // is compiled or evaluation was superseded by a newer call.
  async function evaluateCustom(items, keyOf) {
    if (!globalThis.CustomEval || !CustomEval.hasCode()) return null;
    if (!items || items.length === 0) return null;
    const v = ++customVersion;
    const r = await CustomEval.evaluate(items);
    if (v !== customVersion) return null; // stale
    if (r.error) return null;
    const map = new Map();
    for (let i = 0; i < items.length; i++) {
      map.set(keyOf(items[i]), !!r.matches[i]);
    }
    return map;
  }

  // Evaluate a list of preset chips against an array of items.
  // presets = [{id, code}]
  // Returns Map<presetId, Map<key, bool>>, or empty map if superseded.
  async function evaluatePresets(presets, items, keyOf) {
    if (!globalThis.CustomEval) return new Map();
    if (!presets || presets.length === 0) return new Map();
    if (!items || items.length === 0) return new Map();
    const v = ++presetVersion;
    const results = new Map();
    for (const preset of presets) {
      if (v !== presetVersion) return new Map(); // stale
      const cr = await CustomEval.compilePreset(preset.id, preset.code);
      if (!cr.ok) continue;
      if (v !== presetVersion) return new Map(); // stale
      const er = await CustomEval.evaluatePreset(preset.id, items);
      if (er.error || !er.matches) continue;
      const map = new Map();
      for (let i = 0; i < items.length; i++) {
        map.set(keyOf(items[i]), !!er.matches[i]);
      }
      results.set(preset.id, map);
    }
    if (v !== presetVersion) return new Map(); // stale
    return results;
  }

  // Bump version counters to invalidate any in-flight evaluations.
  function invalidateCustom() { customVersion++; }
  function invalidatePresets() { presetVersion++; }
  function invalidateAll() { customVersion++; presetVersion++; }

  return { evaluateCustom, evaluatePresets, invalidateCustom, invalidatePresets, invalidateAll };
})();

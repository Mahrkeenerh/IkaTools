// Per-city target state — tracks {lootable, looted, empty} markings keyed
// by cityId. Replaces the older spyLog[*].looted flag with a city-centric
// store so the same marking is visible from the spy log, battle reports,
// and the island sidebar.
//
// Storage: cityMarks_{world}  →  { [cityId]: { state, ts } }
// One-time migration from spyLog_{world}[*].looted is gated by
// cityMarksMigrated_{world}.
globalThis.CityMarks = (() => {
  const STATES = ["lootable", "looted", "empty"];

  const STYLE = {
    lootable: { icon: "\u{1F3AF}", color: "#5ab87a", label: "Lootable" },
    looted:   { icon: "\u{1F4B0}", color: "#ff5555", label: "Looted" },
    empty:    { icon: "\u{1FAA6}", color: "#9aa0a8", label: "Empty" },
  };

  function getWorld(worldName) {
    if (worldName) return worldName;
    if (globalThis.IkUtils && IkUtils.getUrlWorldName) {
      return IkUtils.getUrlWorldName() || "unknown";
    }
    return "unknown";
  }

  function keyOf(world) { return "cityMarks_" + world; }
  function migrationFlagKey(world) { return "cityMarksMigrated_" + world; }

  // Migrate legacy spyLog[*].looted into cityMarks. Idempotent — guarded by a
  // per-world flag so this only ever runs once.
  async function migrate(worldName) {
    const w = getWorld(worldName);
    const flagKey = migrationFlagKey(w);
    const flag = await chrome.storage.local.get(flagKey);
    if (flag[flagKey]) return;

    const spyKey = "spyLog_" + w;
    const cmKey = keyOf(w);
    const data = await chrome.storage.local.get([spyKey, cmKey]);
    const spy = data[spyKey] || {};
    const marks = data[cmKey] || {};

    let changed = false;
    for (const id of Object.keys(spy)) {
      const r = spy[id];
      if (!r || !r.looted || r.deleted) continue;
      const cid = r.targetCityId;
      if (!cid) continue;
      const cidStr = String(cid);
      const existing = marks[cidStr];
      // Max-ts wins; "looted" beats no entry.
      if (!existing || (existing.state === "looted" && existing.ts < r.looted)) {
        marks[cidStr] = { state: "looted", ts: r.looted };
        changed = true;
      } else if (existing && existing.state !== "looted" && r.looted > existing.ts) {
        // Keep the newer marking regardless of state — user-intent wins
        // either way, this just skips overwriting a more-recent manual choice.
      }
    }
    const writes = { [flagKey]: Date.now() };
    if (changed) writes[cmKey] = marks;
    await chrome.storage.local.set(writes);
  }

  // One-time rewrite of saved filter chips: the legacy "looted" / "notLooted"
  // chip types were replaced by the four mark-state chips. Existing user
  // configs keep working via mapfilter.js aliases, but we also normalize the
  // labels so the panel doesn't render fallback `looted:true` strings.
  async function migrateFilterChips() {
    const flagKey = "cityMarksFilterChipsMigrated";
    const flag = await chrome.storage.local.get(flagKey);
    if (flag[flagKey]) return;
    const data = await chrome.storage.local.get("mapFilters");
    const cfg = data.mapFilters;
    if (!cfg || !cfg.groups) {
      await chrome.storage.local.set({ [flagKey]: Date.now() });
      return;
    }
    let changed = false;
    for (const group of cfg.groups) {
      if (!group.filters) continue;
      for (const f of group.filters) {
        if (f.type === "looted") { f.type = "markLooted"; changed = true; }
        else if (f.type === "notLooted") { f.type = "markUnmarked"; changed = true; }
      }
    }
    const writes = { [flagKey]: Date.now() };
    if (changed) writes.mapFilters = cfg;
    await chrome.storage.local.set(writes);
  }

  async function load(worldName) {
    const w = getWorld(worldName);
    const k = keyOf(w);
    const data = await chrome.storage.local.get(k);
    return data[k] || {};
  }

  async function get(cityId, worldName) {
    if (cityId == null) return null;
    const marks = await load(worldName);
    return marks[String(cityId)] || null;
  }

  async function set(cityId, state, worldName) {
    if (cityId == null) return;
    if (!STATES.includes(state)) return;
    const w = getWorld(worldName);
    const k = keyOf(w);
    const data = await chrome.storage.local.get(k);
    const marks = data[k] || {};
    marks[String(cityId)] = { state, ts: Date.now() };
    await chrome.storage.local.set({ [k]: marks });
  }

  async function clear(cityId, worldName) {
    if (cityId == null) return;
    const w = getWorld(worldName);
    const k = keyOf(w);
    const data = await chrome.storage.local.get(k);
    const marks = data[k] || {};
    if (!(String(cityId) in marks)) return;
    delete marks[String(cityId)];
    await chrome.storage.local.set({ [k]: marks });
  }

  // Build a lookup analogous to getLootedIndex — flat Map<cityId, {state, ts}>.
  // Consumers that previously needed only the looted timestamp can derive it
  // via `entry.state === "looted" ? entry.ts : 0`.
  async function getIndex(worldName) {
    const marks = await load(worldName);
    const byCityId = new Map();
    for (const cid of Object.keys(marks)) {
      const m = marks[cid];
      if (!m || !m.state) continue;
      byCityId.set(String(cid), { state: m.state, ts: m.ts || 0 });
    }
    return { byCityId };
  }

  function getStyle(state) {
    return STYLE[state] || null;
  }

  // Format an age string like "2h ago" for the looted timestamp. Returns ""
  // for non-looted or missing timestamps.
  function formatAge(ts) {
    if (!ts) return "";
    const ms = Date.now() - ts;
    if (ms < 0) return "just now";
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.floor(hrs / 24) + "d ago";
  }

  // Inject a one-time stylesheet that styles widget buttons. The widget is
  // used in three contexts (game page, extension report page, battle report)
  // so styles must work without any host CSS.
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    if (typeof document === "undefined") return;
    if (document.getElementById("ik-citymark-styles")) { stylesInjected = true; return; }
    const css = `
      .ik-mark-widget { display:inline-flex; gap:2px; vertical-align:middle; }
      .ik-mark-widget button {
        all: unset;
        cursor: pointer;
        width: 22px; height: 20px;
        line-height: 20px;
        text-align: center;
        font-size: 13px;
        border-radius: 3px;
        background: rgba(255,255,255,0.06);
        border: 1px solid transparent;
        color: #ccc;
        box-sizing: border-box;
        user-select: none;
      }
      .ik-mark-widget button:hover {
        background: rgba(255,255,255,0.14);
      }
      .ik-mark-widget button[data-state="lootable"].active {
        background: rgba(90,184,122,0.30); border-color:#5ab87a; color:#fff;
      }
      .ik-mark-widget button[data-state="looted"].active {
        background: rgba(255,85,85,0.30); border-color:#ff5555; color:#fff;
      }
      .ik-mark-widget button[data-state="empty"].active {
        background: rgba(154,160,168,0.30); border-color:#9aa0a8; color:#fff;
      }
      .ik-mark-widget.compact button { width:18px; height:16px; line-height:16px; font-size:11px; }
    `;
    const style = document.createElement("style");
    style.id = "ik-citymark-styles";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    stylesInjected = true;
  }

  // Build a small 3-button widget bound to a cityId. Click an inactive button
  // to set; click the active one to unset. Re-renders itself live when the
  // backing storage changes elsewhere.
  //
  // opts: { compact?: bool, worldName?: string, onChange?: (state|null) => void }
  function createWidget(cityId, opts) {
    injectStyles();
    const cid = String(cityId);
    const world = getWorld(opts && opts.worldName);
    const wrap = document.createElement("span");
    wrap.className = "ik-mark-widget" + (opts && opts.compact ? " compact" : "");
    wrap.dataset.cityId = cid;

    for (const state of STATES) {
      const style = STYLE[state];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.state = state;
      btn.textContent = style.icon;
      btn.title = style.label;
      wrap.appendChild(btn);
    }

    async function render() {
      const entry = await get(cid, world);
      const active = entry ? entry.state : null;
      for (const btn of wrap.querySelectorAll("button")) {
        btn.classList.toggle("active", btn.dataset.state === active);
      }
    }
    render();

    wrap.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn || !wrap.contains(btn)) return;
      e.stopPropagation();
      e.preventDefault();
      const state = btn.dataset.state;
      const wasActive = btn.classList.contains("active");
      if (wasActive) await clear(cid, world);
      else await set(cid, state, world);
      if (opts && typeof opts.onChange === "function") {
        opts.onChange(wasActive ? null : state);
      }
    });

    // Listen for external mark changes so all widgets stay in sync.
    const storageKey = keyOf(world);
    const listener = (changes, area) => {
      if (area !== "local") return;
      if (!changes[storageKey]) return;
      if (!wrap.isConnected) {
        chrome.storage.onChanged.removeListener(listener);
        return;
      }
      render();
    };
    chrome.storage.onChanged.addListener(listener);

    return wrap;
  }

  return {
    STATES,
    load, get, set, clear,
    getIndex, migrate, migrateFilterChips,
    getStyle, formatAge,
    createWidget,
  };
})();

// Per-player "ignoring cultural-treaty offers" state — tracks avatarIds the
// user has offered a CT to but who never accept, so the filter panel can hide
// them and the user can offer to someone else instead.
//
// This is a PLAYER-level marking (keyed by avatarId), distinct from CityMarks
// which is city-level. The 🚫 toggle lives in two places:
//   - the museum's pending-offers table ("Žádost o dohodu o kulturním zboží"),
//     one button per row, so the user can mark people who never respond
//   - the island details sidebar, next to the CityMarks widget
//
// Storage: ctIgnored_{world}  →  { [avatarId]: { name, ts } }
globalThis.CtIgnored = (() => {
  const ICON = "\u{1F6AB}"; // 🚫
  const COLOR = "#d08a3a";

  function getWorld(worldName) {
    if (worldName) return worldName;
    if (globalThis.IkUtils && IkUtils.getUrlWorldName) {
      return IkUtils.getUrlWorldName() || "unknown";
    }
    return "unknown";
  }

  function keyOf(world) { return "ctIgnored_" + world; }

  async function load(worldName) {
    const k = keyOf(getWorld(worldName));
    const data = await chrome.storage.local.get(k);
    return data[k] || {};
  }

  async function isIgnored(avatarId, worldName) {
    if (avatarId == null) return false;
    const map = await load(worldName);
    return !!map[String(avatarId)];
  }

  async function set(avatarId, name, worldName) {
    if (avatarId == null) return;
    const w = getWorld(worldName);
    const k = keyOf(w);
    const data = await chrome.storage.local.get(k);
    const map = data[k] || {};
    map[String(avatarId)] = { name: name || "", ts: Date.now() };
    await chrome.storage.local.set({ [k]: map });
  }

  async function clear(avatarId, worldName) {
    if (avatarId == null) return;
    const w = getWorld(worldName);
    const k = keyOf(w);
    const data = await chrome.storage.local.get(k);
    const map = data[k] || {};
    if (!(String(avatarId) in map)) return;
    delete map[String(avatarId)];
    await chrome.storage.local.set({ [k]: map });
  }

  // Toggle and return the resulting state (true = now ignored).
  async function toggle(avatarId, name, worldName) {
    const on = await isIgnored(avatarId, worldName);
    if (on) await clear(avatarId, worldName);
    else await set(avatarId, name, worldName);
    return !on;
  }

  // Flat Set<avatarId> for the filter-enrichment fast path.
  async function getIds(worldName) {
    const map = await load(worldName);
    return new Set(Object.keys(map));
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    if (typeof document === "undefined") return;
    if (document.getElementById("ik-ctignore-styles")) { stylesInjected = true; return; }
    const css = `
      .ik-ctignore-btn {
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
        vertical-align: middle;
      }
      .ik-ctignore-btn:hover { background: rgba(255,255,255,0.14); }
      .ik-ctignore-btn.active {
        background: rgba(208,138,58,0.30); border-color:${COLOR}; color:#fff;
      }
      .ik-ctignore-btn.compact { width:18px; height:16px; line-height:16px; font-size:11px; }
    `;
    const style = document.createElement("style");
    style.id = "ik-ctignore-styles";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    stylesInjected = true;
  }

  // Build a single toggle button bound to an avatarId. Re-renders live when the
  // backing storage changes elsewhere.
  // opts: { name?: string, compact?: bool, worldName?: string, onChange?: (bool)=>void }
  function createButton(avatarId, opts) {
    injectStyles();
    const id = String(avatarId);
    const world = getWorld(opts && opts.worldName);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ik-ctignore-btn" + (opts && opts.compact ? " compact" : "");
    btn.textContent = ICON;
    btn.title = "Ignoring CT offers — don't offer again";
    btn.dataset.avatarId = id;

    async function render() {
      const on = await isIgnored(id, world);
      btn.classList.toggle("active", on);
    }
    render();

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const now = await toggle(id, opts && opts.name, world);
      if (opts && typeof opts.onChange === "function") opts.onChange(now);
    });

    const storageKey = keyOf(world);
    const listener = (changes, area) => {
      if (area !== "local") return;
      if (!changes[storageKey]) return;
      if (!btn.isConnected) {
        chrome.storage.onChanged.removeListener(listener);
        return;
      }
      render();
    };
    chrome.storage.onChanged.addListener(listener);

    return btn;
  }

  // --- Museum pending-offers table injection ---
  // The offers table ("Žádost o dohodu o kulturním zboží") lives in #tab_museum.
  // Each row's withdraw-offer link (a.cancelTreaty?...receiverId=N) is the
  // language-agnostic signal identifying the offered-to player.
  function injectMuseumButtons() {
    if (typeof document === "undefined") return;
    const cancels = document.querySelectorAll('a.cancelTreaty[href*="receiverId="]');
    for (const a of cancels) {
      const m = a.href.match(/receiverId=(\d+)/);
      if (!m) continue;
      const avatarId = m[1];
      const cell = a.closest("td.actions") || a.parentElement;
      if (!cell || cell.querySelector(".ik-ctignore-btn")) continue;
      const row = a.closest("tr");
      const nameEl = row && row.querySelector("td.player");
      const name = nameEl ? nameEl.textContent.trim() : "";
      cell.appendChild(createButton(avatarId, { name }));
    }
  }

  if (typeof document !== "undefined" && document.body) {
    let debounce = null;
    const obs = new MutationObserver(() => {
      if (!document.querySelector('a.cancelTreaty[href*="receiverId="]')) return;
      clearTimeout(debounce);
      debounce = setTimeout(injectMuseumButtons, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    injectMuseumButtons();
  }

  return {
    load, isIgnored, set, clear, toggle, getIds,
    createButton, injectStyles,
  };
})();

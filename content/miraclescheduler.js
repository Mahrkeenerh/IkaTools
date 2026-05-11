// Miracle scheduler — injects a "schedule activation in X" row into the temple
// view's wonder section. Persists per-city schedules and asks the service
// worker to fire the activation via a credentialed fetch when the alarm trips.
(() => {
  const WONDER_BTN_ID = "js_WonderActivateButton";
  const UPGRADE_BTN_ID = "js_buildingUpgradeButton";
  const WONDER_SECTION_SEL = ".content.wonder";
  // The inner span only exists while the wonder is on cooldown — it holds the
  // live remaining duration. The outer `js_WonderTextCooldownText` always
  // exists and on ready/armed pages contains the static cooldown-DURATION
  // property of the wonder (not a live countdown), so it must not be parsed.
  const COOLDOWN_LIVE_ID = "js_WonderTextCooldown";
  const WONDER_HEAD_ID = "js_WonderTextHead";
  const CONTAINER_CLASS = "ik-miracle-scheduler";

  function parseDuration(text) {
    if (!text) return 0;
    let total = 0;
    const d = text.match(/(\d+)\s*[Dd]\b/);
    const h = text.match(/(\d+)\s*h\b/);
    const m = text.match(/(\d+)\s*m\b/);
    const s = text.match(/(\d+)\s*s\b/);
    if (d) total += parseInt(d[1], 10) * 86400;
    if (h) total += parseInt(h[1], 10) * 3600;
    if (m) total += parseInt(m[1], 10) * 60;
    if (s) total += parseInt(s[1], 10);
    return total;
  }

  function parseActivateUrl(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      const cityId = parseInt(u.searchParams.get("cityId") || "0", 10);
      const position = parseInt(u.searchParams.get("position") || "0", 10);
      if (!cityId || !position) return null;
      return { cityId, position, origin: u.origin };
    } catch (e) {
      return null;
    }
  }

  // Live remaining cooldown in seconds, or 0 when the wonder is available.
  // Only reads `#js_WonderTextCooldown` (the inner span) because the outer
  // text contains the static cooldown-duration property on ready pages.
  function readCooldownRemaining() {
    const el = document.getElementById(COOLDOWN_LIVE_ID);
    if (!el) return 0;
    return parseDuration(el.textContent);
  }

  // Resolve cityId + position + origin from the activate button when it has a
  // working `function=activateWonder` href, otherwise fall back to the
  // building upgrade button (always present in the temple sidebar and uses
  // the same cityId/position). Returns null if neither yields the params.
  function resolveContext() {
    const activate = document.getElementById(WONDER_BTN_ID);
    if (activate) {
      const href = activate.getAttribute("href") || "";
      if (href.includes("function=activateWonder")) {
        const ctx = parseActivateUrl(href);
        if (ctx) return ctx;
      }
    }
    const upgrade = document.getElementById(UPGRADE_BTN_ID);
    if (upgrade) {
      const ctx = parseActivateUrl(upgrade.getAttribute("href") || "");
      if (ctx) return ctx;
    }
    return null;
  }

  function formatCountdown(ms) {
    if (ms < 0) ms = 0;
    const total = Math.round(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function formatClock(ts) {
    const dt = new Date(ts);
    const now = new Date();
    const sameDay = dt.toDateString() === now.toDateString();
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const isTomorrow = dt.toDateString() === tomorrow.toDateString();
    const hhmm = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    if (sameDay) return `today ${hhmm}`;
    if (isTomorrow) return `tomorrow ${hhmm}`;
    return dt.toLocaleString([], { dateStyle: "short", timeStyle: "medium", hour12: false });
  }

  function storageKey(world, cityId) {
    return `miracleSchedule_${world}_${cityId}`;
  }

  function buildUi(ctx, state) {
    const root = document.createElement("div");
    root.className = CONTAINER_CLASS;
    root.style.cssText = "margin-top:8px;font-size:11px;line-height:1.5;";

    function renderIdle() {
      root.innerHTML = "";
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:6px;";

      const label = document.createElement("span");
      label.textContent = "Schedule in:";
      label.style.cssText = "font-weight:bold;";

      const hours = document.createElement("input");
      hours.type = "number"; hours.min = "0"; hours.max = "168"; hours.step = "1";
      hours.value = "1";
      hours.className = "textfield";
      hours.style.cssText = "width:50px;padding:2px 4px;text-align:right;";

      const hLabel = document.createElement("span"); hLabel.textContent = "h";

      const mins = document.createElement("input");
      mins.type = "number"; mins.min = "0"; mins.max = "59"; mins.step = "1";
      mins.value = "0";
      mins.className = "textfield";
      mins.style.cssText = "width:46px;padding:2px 4px;text-align:right;";

      const mLabel = document.createElement("span"); mLabel.textContent = "m";

      const scheduleBtn = document.createElement("a");
      scheduleBtn.className = "button";
      scheduleBtn.textContent = "Schedule";
      scheduleBtn.style.cssText = "cursor:pointer;";
      scheduleBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        const h = Math.max(0, parseInt(hours.value, 10) || 0);
        const m = Math.max(0, parseInt(mins.value, 10) || 0);
        const totalSec = h * 3600 + m * 60;
        if (totalSec < 60) {
          renderError("Schedule must be at least 1 minute.");
          return;
        }
        schedule(totalSec * 1000);
      });

      row.append(label, hours, hLabel, mins, mLabel, scheduleBtn);

      // Quick "after cooldown" preset only when the wonder is actually on
      // cooldown — the live remaining span only exists in that state.
      const cooldownSec = readCooldownRemaining();
      if (cooldownSec > 0) {
        const cdBtn = document.createElement("a");
        cdBtn.className = "button";
        cdBtn.textContent = `After cooldown (+5s)`;
        cdBtn.title = `Schedule for ~${formatCountdown(cooldownSec * 1000)} from now`;
        cdBtn.style.cssText = "cursor:pointer;";
        cdBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          schedule((cooldownSec + 5) * 1000);
        });
        row.appendChild(cdBtn);
      }

      const msg = document.createElement("div");
      msg.className = "ik-miracle-msg";
      msg.style.cssText = "margin-top:4px;color:#a55;min-height:14px;";

      root.append(row, msg);
    }

    function renderError(text) {
      const msg = root.querySelector(".ik-miracle-msg");
      if (msg) msg.textContent = text;
    }

    function renderArmed(rec) {
      root.innerHTML = "";
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:8px;";

      const label = document.createElement("span");
      label.style.cssText = "font-weight:bold;color:#3a8;";
      label.textContent = "Armed:";

      const when = document.createElement("span");
      when.className = "ik-miracle-when";
      when.textContent = `${formatClock(rec.fireAt)} (in ${formatCountdown(rec.fireAt - Date.now())})`;

      const cancelBtn = document.createElement("a");
      cancelBtn.className = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = "cursor:pointer;";
      cancelBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        cancel();
      });

      row.append(label, when, cancelBtn);
      root.append(row);

      // Show cooldown warning only when the wonder is currently on cooldown
      // (live remaining span is present) and the schedule fires before it ends.
      const cooldownSec = readCooldownRemaining();
      if (cooldownSec > 0) {
        const cooldownEnd = Date.now() + cooldownSec * 1000;
        if (rec.fireAt < cooldownEnd) {
          const warn = document.createElement("div");
          warn.style.cssText = "margin-top:4px;color:#c70;";
          warn.textContent = `⚠ Fires ${formatCountdown(cooldownEnd - rec.fireAt)} before cooldown ends — server will reject.`;
          root.append(warn);
        }
      }
    }

    function schedule(deltaMs) {
      const wonderEl = document.getElementById(WONDER_HEAD_ID);
      const wonderName = wonderEl ? wonderEl.textContent.trim() : "";
      const fireAt = Date.now() + deltaMs;
      const rec = {
        world: ctx.world,
        cityId: ctx.cityId,
        position: ctx.position,
        origin: ctx.origin,
        wonderName,
        fireAt,
        scheduledAt: Date.now(),
      };
      chrome.runtime.sendMessage({ type: "miracle-schedule", record: rec }, (resp) => {
        if (chrome.runtime.lastError) {
          renderError("Failed: " + chrome.runtime.lastError.message);
          return;
        }
        if (!resp || !resp.ok) {
          renderError("Failed to schedule.");
          return;
        }
        state.rec = rec;
        renderArmed(rec);
      });
    }

    function cancel() {
      chrome.runtime.sendMessage({ type: "miracle-cancel", world: ctx.world, cityId: ctx.cityId }, () => {
        state.rec = null;
        renderIdle();
      });
    }

    if (state.rec) renderArmed(state.rec);
    else renderIdle();
    return { root, renderArmed, renderIdle };
  }

  // Module-scoped handles so that a temple re-render (new button node) can
  // tear down the previous UI's timer + storage listener instead of leaking
  // them. There is at most one temple view open at a time.
  let activeInterval = null;
  let activeStorageListener = null;

  function teardownActive() {
    if (activeInterval) { clearInterval(activeInterval); activeInterval = null; }
    if (activeStorageListener) {
      try { chrome.storage.onChanged.removeListener(activeStorageListener); } catch (e) {}
      activeStorageListener = null;
    }
  }

  async function injectInto(wonderSection) {
    if (!wonderSection || wonderSection.dataset.ikMiracleAttached === "1") return;
    const ctxBase = resolveContext();
    if (!ctxBase) return;
    const world = IkUtils.getUrlWorldName();
    if (!world) return;
    const ctx = { ...ctxBase, world };

    teardownActive();
    wonderSection.dataset.ikMiracleAttached = "1";

    const key = storageKey(world, ctx.cityId);
    const stored = await chrome.storage.local.get(key);
    let rec = stored[key] || null;
    // Drop stale records whose fireAt has already passed (alarm may have fired
    // and we never re-rendered, or the schedule was for a previous session).
    if (rec && rec.fireAt < Date.now() - 60000) {
      rec = null;
      await chrome.storage.local.remove(key);
    }
    const state = { rec };
    const ui = buildUi(ctx, state);

    // Append at the end of the wonder section so the row sits below the
    // existing buttons (which may be display:none when on cooldown).
    wonderSection.appendChild(ui.root);

    // Live countdown when armed
    activeInterval = setInterval(() => {
      if (!state.rec) return;
      const whenEl = ui.root.querySelector(".ik-miracle-when");
      if (!whenEl) return;
      const left = state.rec.fireAt - Date.now();
      if (left <= 0) {
        // Alarm should have fired by now — check storage; if the entry was
        // cleared by the background, flip back to idle.
        chrome.storage.local.get(key, (data) => {
          if (!data[key]) {
            state.rec = null;
            ui.renderIdle();
          }
        });
        whenEl.textContent = `${formatClock(state.rec.fireAt)} (firing…)`;
      } else {
        whenEl.textContent = `${formatClock(state.rec.fireAt)} (in ${formatCountdown(left)})`;
      }
    }, 1000);

    // Listen for external storage changes (e.g. background cleared the entry
    // after firing) so the UI stays in sync without a reload.
    activeStorageListener = (changes, area) => {
      if (area !== "local" || !changes[key]) return;
      const newRec = changes[key].newValue || null;
      state.rec = newRec;
      if (newRec) ui.renderArmed(newRec);
      else ui.renderIdle();
    };
    chrome.storage.onChanged.addListener(activeStorageListener);
  }

  function scanAndInject() {
    // Anchor on the wonder section itself — the activate button may be
    // display:none on cooldown, but the section is always present in the
    // temple view (and absent everywhere else).
    const section = document.querySelector(WONDER_SECTION_SEL);
    if (!section) return;
    // Make sure we're really in the temple's wonder block (the head id is
    // unique to the wonder section).
    if (!section.querySelector("#" + WONDER_HEAD_ID)) return;
    injectInto(section);
  }

  // Initial pass + watch for templateView re-renders (game swaps the temple
  // view contents in-place when the user closes/reopens the building).
  scanAndInject();
  let pending = false;
  const obs = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scanAndInject();
    }, 200);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
